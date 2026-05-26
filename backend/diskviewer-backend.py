#!/usr/bin/env python3
"""Cockpit Disk Viewer 后端服务

功能：
- 定期监控磁盘电源状态
- 追踪休眠时长，写入 /etc/cockpit/diskviewer/data.json
- 启动时从 /etc/cockpit/diskviewer/setting.json 读取 hdparm 设置并应用
"""

import json
import os
import subprocess
import sys
import time
import signal
import logging
from pathlib import Path
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── 配置 ──────────────────────────────────────────────────────
CONFIG_DIR = Path("/etc/cockpit/diskviewer")
SETTINGS_FILE = CONFIG_DIR / "setting.json"
DATA_FILE = CONFIG_DIR / "data.json"
CHECK_INTERVAL = 30  # 秒
HISTORY_KEEP_WEEKS = 7  # 保留最近7周记录

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("diskviewer")

running = True


def handle_signal(signum, frame):
    global running
    log.info("收到信号 %s，正在退出...", signum)
    running = False


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


# ── 文件读写 ──────────────────────────────────────────────────
def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append_state_history(data: dict, device: str, from_state: str, to_state: str,
                         start_ms: int, end_ms: int):
    """记录一条状态转换历史，如果连续状态相同则合并"""
    history = data.get("stateHistory", [])
    
    # 检查最后一条记录是否可以合并（同一磁盘、同一状态）
    if history:
        last = history[-1]
        if (last.get("device") == device and 
            last.get("toState") == to_state):
            # 合并：更新结束时间和持续时间
            last["endTime"] = end_ms
            last["duration"] = end_ms - last.get("startTime", start_ms)
            data["stateHistory"] = history
            
            # 清理超过7周的旧记录
            cutoff = int((time.time() - HISTORY_KEEP_WEEKS * 7 * 86400) * 1000)
            history = [r for r in history if r.get("endTime", 0) >= cutoff]
            data["stateHistory"] = history
            return data
    
    # 新增记录
    record = {
        "device": device,
        "fromState": from_state,
        "toState": to_state,
        "startTime": start_ms,
        "endTime": end_ms,
        "duration": end_ms - start_ms,
    }
    history.append(record)

    # 清理超过7周的旧记录
    cutoff = int((time.time() - HISTORY_KEEP_WEEKS * 7 * 86400) * 1000)
    history = [r for r in history if r.get("endTime", 0) >= cutoff]

    data["stateHistory"] = history
    return data


# ── 磁盘状态检测 ──────────────────────────────────────────────
def get_disks() -> list[str]:
    """返回所有磁盘设备名列表，如 ['/dev/sda', '/dev/nvme0n1']"""
    try:
        out = subprocess.check_output(
            ["lsblk", "-Jd", "-o", "NAME,TYPE"],
            text=True, stderr=subprocess.DEVNULL,
        )
        devs = json.loads(out)
        return [
            f"/dev/{d['name']}"
            for d in devs.get("blockdevices", [])
            if d.get("type") == "disk" and not d["name"].startswith("zd")
        ]
    except Exception:
        return []


def get_disk_state(device: str) -> str:
    """返回 'active' | 'standby' | 'sleep' | 'unknown'"""
    dev = os.path.basename(device)

    # NVMe: 读 sysfs
    if dev.startswith("nvme"):
        power_file = Path(f"/sys/block/{dev}/device/power_state")
        if power_file.exists():
            raw = power_file.read_text().strip()
            if raw.startswith("0") or raw == "active":
                return "active"
            elif raw.startswith(("1", "2")):
                return "standby"
            elif raw.startswith(("3", "4", "5")):
                return "sleep"
        return "active"

    # SATA/SAS: hdparm
    try:
        out = subprocess.check_output(
            ["hdparm", "-C", device],
            text=True, stderr=subprocess.DEVNULL, timeout=10,
        )
        if "active/idle" in out:
            return "active"
        elif "standby" in out:
            return "standby"
        elif "sleeping" in out:
            return "sleep"
    except Exception:
        pass

    return "unknown"


# ── hdparm 设置应用 ───────────────────────────────────────────
def apply_hdparm_settings():
    """从 setting.json 读取并应用 hdparm 设置"""
    settings = read_json(SETTINGS_FILE)
    timer = settings.get("hibTimer")
    apm = settings.get("hibApm")
    disks = settings.get("hibDisks", [])

    if not disks:
        return

    for device in disks:
        dev = os.path.basename(device)
        if dev.startswith("nvme"):
            continue
        if not os.path.exists(device):
            continue

        if timer is not None:
            try:
                subprocess.run(
                    ["hdparm", "-S", str(timer), device],
                    check=True, capture_output=True, text=True, timeout=10,
                )
                log.info("hdparm -S %s %s: OK", timer, device)
            except subprocess.CalledProcessError as e:
                log.warning("hdparm -S %s %s: %s", timer, device, e.stderr.strip())
            except subprocess.TimeoutExpired:
                log.warning("hdparm -S %s %s: timeout", timer, device)

        if apm is not None:
            try:
                subprocess.run(
                    ["hdparm", "-B", str(apm), device],
                    check=True, capture_output=True, text=True, timeout=10,
                )
                log.info("hdparm -B %s %s: OK", apm, device)
            except subprocess.CalledProcessError as e:
                log.warning("hdparm -B %s %s: %s", apm, device, e.stderr.strip())
            except subprocess.TimeoutExpired:
                log.warning("hdparm -B %s %s: timeout", apm, device)


# ── 并行查询磁盘状态 ──────────────────────────────────────────
def query_all_disks(disks: list[str]) -> dict[str, str]:
    """并行查询所有磁盘电源状态，返回 {device: state}"""
    results = {}
    if not disks:
        return results
    with ThreadPoolExecutor(max_workers=min(len(disks), 8)) as executor:
        futures = {executor.submit(get_disk_state, d): d for d in disks}
        for future in as_completed(futures):
            device = futures[future]
            try:
                results[device] = future.result()
            except Exception:
                results[device] = "unknown"
    return results


# ── 主监控循环 ────────────────────────────────────────────────
def monitor_loop():
    log.info("磁盘状态监控已启动 (间隔 %ds, 并行查询)", CHECK_INTERVAL)

    # 启动时记录所有磁盘的初始状态
    data = read_json(DATA_FILE)
    prev_states = data.get("_prevStates", {})
    active_since = data.get("activeSince", {})
    # 记录每个状态的实际开始时间 {device: start_ms}
    state_start_time = data.get("_stateStartTime", {})
    now_ms = int(time.time() * 1000)

    disks = get_disks()
    states = query_all_disks(disks)
    for device, state in states.items():
        if device not in prev_states:
            prev_states[device] = state
        if device not in state_start_time:
            state_start_time[device] = now_ms
        if state == "active" and device not in active_since:
            active_since[device] = now_ms

    data["_prevStates"] = prev_states
    data["activeSince"] = active_since
    data["_stateStartTime"] = state_start_time
    write_json(DATA_FILE, data)

    while running:
        time.sleep(CHECK_INTERVAL)
        if not running:
            break

        data = read_json(DATA_FILE)
        standby_since = data.get("standbySince", {})
        prev_states = data.get("_prevStates", {})
        active_since = data.get("activeSince", {})
        state_start_time = data.get("_stateStartTime", {})
        changed = False
        now_ms = int(time.time() * 1000)

        disks = get_disks()
        states = query_all_disks(disks)

        for device, state in states.items():
            old_state = prev_states.get(device, "unknown")
            old_start = state_start_time.get(device, now_ms)

            if state != old_state:
                # 状态变更：上一状态的结束时间 = 当前时间，新状态开始时间 = 当前时间
                # startTime 使用状态实际开始的时间，endTime 使用状态变更的时间
                data = append_state_history(
                    data, device, old_state, state,
                    old_start, now_ms
                )
                log.info("%s 状态转换: %s → %s (持续 %s)", 
                         device, old_state, state, 
                         timedelta(milliseconds=now_ms - old_start))
                # 更新新状态的开始时间
                state_start_time[device] = now_ms
                changed = True

            if state in ("standby", "sleep"):
                if device not in standby_since:
                    standby_since[device] = now_ms
                    changed = True
                if device in active_since:
                    del active_since[device]
                    changed = True
            else:
                if device in standby_since:
                    del standby_since[device]
                    changed = True
                if state == "active" and device not in active_since:
                    active_since[device] = now_ms
                    changed = True

            prev_states[device] = state

        if changed or data.get("_prevStates") != prev_states:
            data["standbySince"] = standby_since
            data["activeSince"] = active_since
            data["_prevStates"] = prev_states
            data["_stateStartTime"] = state_start_time
            write_json(DATA_FILE, data)


# ── 入口 ──────────────────────────────────────────────────────
def main():
    log.info("diskviewer 后端启动")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    # 启动时应用 hdparm 设置
    apply_hdparm_settings()

    # 进入监控循环
    monitor_loop()

    log.info("diskviewer 后端已停止")


if __name__ == "__main__":
    main()
