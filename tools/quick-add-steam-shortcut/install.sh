#!/usr/bin/env bash
# Installs "Quick Add to Steam" — a standalone drag-and-drop tool that adds
# non-Steam game shortcuts to Steam with matched artwork from SteamGridDB.
#
# Usage (recommended — gives the script a real terminal, not a pipe, so
# sudo password prompts behave correctly):
#   bash <(curl -fsSL https://raw.githubusercontent.com/t0mbi/hydra/main/tools/quick-add-steam-shortcut/install.sh)
#
# Also works as a plain pipe (this script has no interactive prompts of its
# own, so it's safe either way):
#   curl -fsSL https://raw.githubusercontent.com/t0mbi/hydra/main/tools/quick-add-steam-shortcut/install.sh | bash
#
# Override install location: STEAM_ADD_INSTALL_DIR=/some/path bash <(curl ...)
set -euo pipefail

REPO_TARBALL_URL="https://github.com/t0mbi/hydra/archive/refs/heads/main.tar.gz"
INSTALL_DIR="${STEAM_ADD_INSTALL_DIR:-$HOME/Applications/steam_add}"
APP_NAME="Quick Add to Steam"

echo "==> Installing $APP_NAME to $INSTALL_DIR"

install_tk() {
  if python3 -c "import tkinter" >/dev/null 2>&1; then
    return
  fi
  echo "==> Installing Tk (tkinter) system package..."
  if command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm tk
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y python3-tk
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3-tkinter
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y python3-tk
  else
    echo "!! Could not detect a package manager. Please install Tk for Python"
    echo "   manually (the package is usually called 'tk' or 'python3-tk'),"
    echo "   then re-run this installer."
    exit 1
  fi
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "!! python3 is required but wasn't found. Please install it and re-run."
  exit 1
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  echo "!! curl and tar are required but weren't found. Please install them and re-run."
  exit 1
fi

install_tk
if ! python3 -c "import tkinter" >/dev/null 2>&1; then
  echo "!! tkinter still isn't importable after the install attempt. Aborting."
  exit 1
fi

echo "==> Downloading app source..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL "$REPO_TARBALL_URL" -o "$TMP_DIR/hydra.tar.gz"
tar -xzf "$TMP_DIR/hydra.tar.gz" -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -maxdepth 3 -type d -name quick-add-steam-shortcut | head -n1)"
if [ -z "$SRC_DIR" ]; then
  echo "!! Could not find the app source in the downloaded archive."
  exit 1
fi

mkdir -p "$INSTALL_DIR"
# Wipe a prior install's app files (but never touch .venv or user data —
# .venv gets rebuilt below, and there is no user data stored in this dir).
find "$INSTALL_DIR" -maxdepth 1 -type f -delete
cp -r "$SRC_DIR"/. "$INSTALL_DIR"/
rm -f "$INSTALL_DIR/install.sh"

echo "==> Setting up Python virtual environment..."
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/.venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q

PYTHON_BIN="$INSTALL_DIR/.venv/bin/python"
APP_SCRIPT="$INSTALL_DIR/quick_add_steam_shortcut.py"
chmod +x "$INSTALL_DIR/uninstall.sh" 2>/dev/null || true

echo "==> Installing application launcher..."
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/quick-add-steam-shortcut.desktop" << EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Opens a drop window - drag a game shortcut onto it to add it to Steam with artwork
Icon=steam
Terminal=false
Categories=Game;
Exec=$PYTHON_BIN $APP_SCRIPT
EOF
chmod +x "$HOME/.local/share/applications/quick-add-steam-shortcut.desktop"

if command -v kbuildsycoca6 >/dev/null 2>&1 || command -v kbuildsycoca5 >/dev/null 2>&1; then
  echo "==> Hooking into KDE's 'Add to Steam' right-click menu..."
  mkdir -p "$HOME/.local/share/kio/servicemenus"
  cat > "$HOME/.local/share/kio/servicemenus/steam.desktop" << EOF
[Desktop Entry]
Type=Service
X-KDE-ServiceTypes=KonqPopupMenu/Plugin
MimeType=application/x-desktop;application/x-executable;application/vnd.appimage;application/x-shellscript;application/x-ms-dos-executable;
Actions=addToSteam

[Desktop Action addToSteam]
Exec=$PYTHON_BIN $APP_SCRIPT %f
Icon=steam
Name=Add to Steam
EOF
  chmod +x "$HOME/.local/share/kio/servicemenus/steam.desktop"
  command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true
else
  echo "==> Not a KDE session — skipping right-click 'Add to Steam' menu integration."
  echo "   (Drag-and-drop and the app launcher still work fine.)"
fi

echo ""
echo "$APP_NAME installed to $INSTALL_DIR."
echo "Launch it from your app menu, or run:"
echo "  $PYTHON_BIN $APP_SCRIPT"
echo ""
echo "To uninstall later, open the app's Settings (gear icon) and click"
echo "'Uninstall Quick Add to Steam', or run:"
echo "  bash $INSTALL_DIR/uninstall.sh"
