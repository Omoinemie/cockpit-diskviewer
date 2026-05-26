# Cockpit Disk Viewer

**[English](README.md)**

Cockpit 磁盘管理插件，提供全面的磁盘监控和管理功能。

## 功能特性

- **仪表盘** - 所有磁盘概览，显示状态、温度、运行时间、健康状态
- **硬盘信息** - 详细磁盘信息（型号、序列号、容量、分区等）
- **SMART 健康** - SMART 属性监控，显示健康状态
- **休眠控制** - 管理磁盘休眠/唤醒，支持 APM 和写缓存设置
- **IO 监控** - 实时磁盘 IO 统计，带图表显示
- **自检测试** - SMART 自检测试管理（短测试/长测试/传输测试）

## 系统要求

- Cockpit >= 200
- Python 3
- smartmontools
- hdparm

## 安装

### 从 DEB 包安装

```bash
sudo dpkg -i cockpit-diskviewer_1.1.41_all.deb
sudo systemctl restart cockpit
```

### 从源码安装

```bash
tar -xzf cockpit-diskviewer-v1.1.41.tar.gz
cd cockpit-diskviewer
sudo cp -r . /usr/share/cockpit/diskviewer
sudo cp backend/diskviewer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now diskviewer
sudo systemctl restart cockpit
```

## 卸载

```bash
sudo dpkg --purge cockpit-diskviewer
# 源码安装的卸载方式：
sudo rm -rf /usr/share/cockpit/diskviewer
sudo systemctl disable --now diskviewer
sudo rm /etc/systemd/system/diskviewer.service
sudo systemctl daemon-reload
```

## 配置

配置文件存储在 `/etc/cockpit/diskviewer/` 目录：
- `setting.json` - 用户偏好设置（主题、语言、刷新间隔）
- `data.json` - 运行时数据（休眠时间戳、磁盘缓存）

## 数据来源

| 功能 | 数据来源 |
|------|----------|
| 磁盘列表 | `/sys/block/`、`lsblk` |
| 硬盘信息 | `smartctl -a`、`hdparm -I` |
| SMART 健康 | `smartctl -H`、`smartctl -A` |
| 休眠状态 | `hdparm -C` |
| APM 设置 | `hdparm -B` |
| 写缓存 | `hdparm -W` |
| IO 统计 | `/proc/diskstats` |
| 自检测试 | `smartctl -t`、`smartctl -l selftest` |

## 许可证

MIT License

## 版本

当前版本：1.1.41
