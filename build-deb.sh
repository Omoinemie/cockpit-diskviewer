#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# ── Read version ──────────────────────────────────────────────
VERSION="$(cat version | tr -d '[:space:]')"
if [ -z "$VERSION" ]; then
    echo "Error: version file is empty" >&2
    exit 1
fi

PACKAGE="cockpit-diskviewer"
ARCH="all"
DEB_NAME="${PACKAGE}_${VERSION}_${ARCH}.deb"
OUTPUT="${WORKSPACE}/${DEB_NAME}"

echo "Building ${PACKAGE} v${VERSION}"

# ── Staging ───────────────────────────────────────────────────
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

DEST="${STAGING}/usr/share/cockpit/diskviewer"
mkdir -p "$DEST"
mkdir -p "$DEST/backend"
mkdir -p "${STAGING}/DEBIAN"
mkdir -p "${STAGING}/etc/cockpit/diskviewer"
mkdir -p "${STAGING}/lib/systemd/system"

# Copy plugin files, inject version into HTML
cp manifest.json "$DEST/"
# Update plugin_version in manifest.json
if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$DEST/manifest.json', 'r') as f:
    m = json.load(f)
m['plugin_version'] = '$VERSION'
with open('$DEST/manifest.json', 'w') as f:
    json.dump(m, f, indent=4)
"
fi
cp -r static "$DEST/"
sed "s/v[0-9]\+\.[0-9]\+\.[0-9]\+/v${VERSION}/g" index.html > "$DEST/index.html"

# Copy backend
cp backend/diskviewer-backend.py "$DEST/backend/"
chmod 755 "$DEST/backend/diskviewer-backend.py"

# Copy systemd unit
cp backend/diskviewer.service "${STAGING}/lib/systemd/system/"

# ── Generate DEBIAN/control ──────────────────────────────────
INSTALLED_SIZE="$(du -sk "$STAGING" | cut -f1)"

cat > "${STAGING}/DEBIAN/control" <<EOF
Package: ${PACKAGE}
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Disk Viewer Contributors
Installed-Size: ${INSTALLED_SIZE}
Depends: cockpit (>= 270), smartmontools (>= 7.0), nvme-cli (>= 1.0), python3 (>= 3.7), hdparm
Section: admin
Priority: optional
Homepage: https://github.com/diskviewer/cockpit-diskviewer
Description: Cockpit plugin for disk management and SMART monitoring
 A web-based disk viewer plugin for Cockpit. Provides real-time disk
 health monitoring, SMART attribute inspection, power management,
 I/O statistics, and disk self-test capabilities.
 Includes a Python backend for continuous disk state monitoring
 and automatic hdparm settings restoration on boot.
EOF

# ── postinst ──────────────────────────────────────────────────
cat > "${STAGING}/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -euo pipefail
case "$1" in
    configure)
        systemctl daemon-reload
        if [ -z "${2:-}" ]; then
            # 首次安装
            systemctl enable diskviewer.service
            systemctl start --no-block diskviewer.service 2>/dev/null || true
        else
            # 升级/重装
            systemctl restart diskviewer.service 2>/dev/null || true
        fi
        ;;
esac
POSTINST
chmod 755 "${STAGING}/DEBIAN/postinst"

# ── prerm ─────────────────────────────────────────────────────
cat > "${STAGING}/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -euo pipefail
case "$1" in
    remove)
        systemctl stop diskviewer.service 2>/dev/null || true
        systemctl disable diskviewer.service 2>/dev/null || true
        systemctl daemon-reload
        ;;
    upgrade)
        # 升级时只停止，不 disable（新包会 restart）
        systemctl stop diskviewer.service 2>/dev/null || true
        ;;
esac
PRERM
chmod 755 "${STAGING}/DEBIAN/prerm"

# ── postrm ─────────────────────────────────────────────────────
cat > "${STAGING}/DEBIAN/postrm" <<'POSTRM'
#!/bin/bash
set -euo pipefail
case "$1" in
    purge)
        # 仅在 purge 时清理配置目录
        rm -rf /etc/cockpit/diskviewer 2>/dev/null || true
        ;;
esac
POSTRM
chmod 755 "${STAGING}/DEBIAN/postrm"

# ── Build ─────────────────────────────────────────────────────
dpkg-deb --root-owner-group --build "$STAGING" "$OUTPUT"

echo ""
echo "Built: ${DEB_NAME}"
echo "Size:  $(du -h "$OUTPUT" | cut -f1)"

# ── Bump patch version ───────────────────────────────────────
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo "$NEW_VERSION" > version
# Update plugin_version in source manifest.json
if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('manifest.json', 'r') as f:
    m = json.load(f)
m['plugin_version'] = '$NEW_VERSION'
with open('manifest.json', 'w') as f:
    json.dump(m, f, indent=4)
"
fi
echo "Next version: ${NEW_VERSION}"
echo ""
echo "Install: sudo dpkg -i ${OUTPUT}"
