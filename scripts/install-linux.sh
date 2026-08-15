#!/usr/bin/env bash
# Clones/updates this fork, builds the Linux AppImage locally, and installs
# a desktop entry so Hydra shows up in the system's application launcher.
#
# Usage (from a CachyOS/Arch machine with node, yarn, rust/cargo and
# python3 already installed):
#
#   curl -fsSL https://raw.githubusercontent.com/t0mbi/hydra/main/scripts/install-linux.sh | bash
#
# Re-running this script later pulls the latest commits and rebuilds, so
# it doubles as the update command.

set -euo pipefail

REPO_URL="https://github.com/t0mbi/hydra.git"
INSTALL_DIR="${HYDRA_SRC_DIR:-$HOME/.local/src/hydra}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

for cmd in git node yarn python3 cargo; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found on PATH -- install it first."
done

log "Fetching source"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

log "Installing Python build dependencies"
pip install --user -r requirements.txt

log "Installing JS dependencies"
yarn install --frozen-lockfile

log "Building Linux AppImage (this takes a few minutes)"
yarn build:linux

APPIMAGE=$(find dist -maxdepth 1 -name "*.AppImage" -print -quit)
[ -n "$APPIMAGE" ] || die "Build finished but no .AppImage was produced -- check the output above."

log "Installing to $BIN_DIR"
mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"
install -m 755 "$APPIMAGE" "$BIN_DIR/hydra.AppImage"

if [ -f build/icon.png ]; then
  install -m 644 build/icon.png "$ICON_DIR/hydra.png"
fi

cat > "$APPS_DIR/hydra.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Hydra
Comment=Hydra Launcher
Exec=$BIN_DIR/hydra.AppImage %U
Icon=hydra
Terminal=false
Categories=Game;
MimeType=x-scheme-handler/hydralauncher;
EOF

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

log "Done -- Hydra is in your application launcher, or run: $BIN_DIR/hydra.AppImage"
