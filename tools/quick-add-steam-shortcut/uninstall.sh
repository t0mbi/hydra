#!/usr/bin/env bash
# Uninstalls Quick Add to Steam: removes the app launcher, the right-click
# "Add to Steam" context menu override (restoring the system default), and
# this install directory itself. Safe to run while the app is open — on
# Linux, deleting files/directories a running process is using doesn't
# affect that process; it just stops existing on disk once the process
# using it exits.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Uninstalling Quick Add to Steam from $INSTALL_DIR..."

rm -f "$HOME/.local/share/applications/quick-add-steam-shortcut.desktop"

SERVICE_MENU="$HOME/.local/share/kio/servicemenus/steam.desktop"
if [ -f "$SERVICE_MENU" ] && grep -q "quick_add_steam_shortcut.py" "$SERVICE_MENU" 2>/dev/null; then
  rm -f "$SERVICE_MENU"
  command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
  command -v kbuildsycoca5 >/dev/null 2>&1 && kbuildsycoca5 >/dev/null 2>&1 || true
fi

if [ "${1:-}" = "--purge-config" ]; then
  rm -rf "$HOME/.config/quick-add-steam-shortcut"
fi

rm -rf "$INSTALL_DIR"
echo "Done."
