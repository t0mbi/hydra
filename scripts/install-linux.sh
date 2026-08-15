#!/usr/bin/env bash
# Bootstraps build tooling on a fresh Arch/CachyOS machine, then clones/
# updates this fork, builds the Linux AppImage locally, and installs a
# desktop entry so Hydra shows up in the system's application launcher.
#
# Usage:
#
#   curl -fsSL https://raw.githubusercontent.com/t0mbi/hydra/main/scripts/install-linux.sh | bash
#
# Re-running this script later pulls the latest commits and rebuilds, so
# it doubles as the update command. Prerequisite installs are skipped once
# already present, so re-runs don't touch pacman at all.

set -euo pipefail

# Non-interactive: corepack (used to provision yarn) must not stop to ask
# for confirmation when fetching the pinned yarn version, since stdin here
# is the curl pipe, not a terminal.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

REPO_URL="https://github.com/t0mbi/hydra.git"
INSTALL_DIR="${HYDRA_SRC_DIR:-$HOME/.local/src/hydra}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

log "Checking build tooling"
missing_pkgs=()
command -v git >/dev/null 2>&1 || missing_pkgs+=(git)
command -v node >/dev/null 2>&1 || missing_pkgs+=(nodejs)
command -v python3 >/dev/null 2>&1 || missing_pkgs+=(python)
{ command -v pip >/dev/null 2>&1 || command -v pip3 >/dev/null 2>&1; } || missing_pkgs+=(python-pip)
command -v cargo >/dev/null 2>&1 || missing_pkgs+=(rust)
command -v gcc >/dev/null 2>&1 || missing_pkgs+=(base-devel)
pacman -Qq fuse2 >/dev/null 2>&1 || missing_pkgs+=(fuse2)
# The Arch package builds Python bindings against the system interpreter,
# so it's used in place of PyPI's libtorrent -- that one has no prebuilt
# wheel for every Python version and falls back to compiling from source
# against boost/libtorrent-rasterbar, which this avoids entirely.
pacman -Qq libtorrent-rasterbar >/dev/null 2>&1 || missing_pkgs+=(libtorrent-rasterbar)

if [ "${#missing_pkgs[@]}" -gt 0 ]; then
  command -v pacman >/dev/null 2>&1 ||
    die "Missing: ${missing_pkgs[*]} -- no pacman found to install them, install these manually first."
  log "Installing missing packages via pacman: ${missing_pkgs[*]}"
  sudo pacman -S --needed --noconfirm "${missing_pkgs[@]}"
fi

if ! command -v yarn >/dev/null 2>&1; then
  log "Enabling corepack (yarn ships via this repo's pinned packageManager version)"
  sudo corepack enable
fi

log "Fetching source"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

PIP_CMD=$(command -v pip || command -v pip3) || die "pip not found even after installing python-pip."

log "Installing Python build dependencies"
if pacman -Qq libtorrent-rasterbar >/dev/null 2>&1; then
  # libtorrent is already satisfied by the system package -- pip installing
  # it too would ignore that and try to build PyPI's sdist from source.
  pip_requirements=$(mktemp)
  grep -v '^libtorrent$' requirements.txt > "$pip_requirements"
  "$PIP_CMD" install --user --break-system-packages -r "$pip_requirements"
  rm -f "$pip_requirements"
else
  "$PIP_CMD" install --user --break-system-packages -r requirements.txt
fi

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
