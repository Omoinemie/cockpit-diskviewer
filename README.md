# Cockpit Disk Viewer

**[中文文档](README.zh-CN.md)**

A disk management plugin for Cockpit, providing comprehensive disk monitoring and management features.

## Features

- **Dashboard** - Overview of all disks with status, temperature, runtime, and health
- **Disk Info** - Detailed disk information (model, serial, capacity, partitions, etc.)
- **SMART Health** - SMART attributes monitoring with health status
- **Hibernation Control** - Manage disk standby/hibernation with APM and write cache settings
- **IO Monitor** - Real-time disk I/O statistics with charts
- **Self Test** - SMART self-test management (short/long/conveyance)

## Requirements

- Cockpit >= 200
- Python 3
- smartmontools
- hdparm

## Installation

### From DEB Package

```bash
sudo dpkg -i cockpit-diskviewer_1.1.41_all.deb
sudo systemctl restart cockpit
```

### From Source

```bash
tar -xzf cockpit-diskviewer-v1.1.41.tar.gz
cd cockpit-diskviewer
sudo cp -r . /usr/share/cockpit/diskviewer
sudo cp backend/diskviewer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now diskviewer
sudo systemctl restart cockpit
```

## Uninstallation

```bash
sudo dpkg --purge cockpit-diskviewer
# Or for source installation:
sudo rm -rf /usr/share/cockpit/diskviewer
sudo systemctl disable --now diskviewer
sudo rm /etc/systemd/system/diskviewer.service
sudo systemctl daemon-reload
```

## Configuration

Configuration files are stored in `/etc/cockpit/diskviewer/`:
- `setting.json` - User preferences (theme, language, refresh interval)
- `data.json` - Runtime data (standby timestamps, disk cache)

## Data Sources

| Feature | Data Source |
|---------|-------------|
| Disk List | `/sys/block/`, `lsblk` |
| Disk Info | `smartctl -a`, `hdparm -I` |
| SMART Health | `smartctl -H`, `smartctl -A` |
| Hibernation State | `hdparm -C` |
| APM Settings | `hdparm -B` |
| Write Cache | `hdparm -W` |
| IO Statistics | `/proc/diskstats` |
| Self Test | `smartctl -t`, `smartctl -l selftest` |

## License

MIT License

## Version

Current version: 1.1.41
