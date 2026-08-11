# Quick Add to Steam

A standalone desktop utility: drop a game shortcut on it and it adds the
game to Steam with matched artwork from SteamGridDB. Lives in this repo for
convenience, but it is **fully independent of Hydra** — it doesn't import
Hydra's code, doesn't need Hydra installed or running, and doesn't touch
Hydra's own data. The only network calls it makes are to Hydra's public,
unauthenticated catalogue-search endpoint (used to normalize the game's
title against Steam's own naming — the same thing typing into Steam's own
search would do) and to SteamGridDB using your own key.

## Install (Linux, one command)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/t0mbi/hydra/main/tools/quick-add-steam-shortcut/install.sh)
```

This installs Tk (via your distro's package manager — you may be prompted
for your `sudo` password), downloads the app to `~/Applications/steam_add`,
sets up its own Python virtual environment with all dependencies, adds an
app-launcher entry, and — on KDE — hooks into the right-click **"Add to
Steam"** context menu so it replaces the system default for `.desktop`,
`.exe`, AppImage, and shell script files.

Override the install location with `STEAM_ADD_INSTALL_DIR=/some/path`
before the command above.

### Uninstalling

Open the app, click the ⚙ settings icon, then **"Uninstall Quick Add to
Steam"** — it removes the app, its launcher entry, and the right-click menu
hook (restoring the system default), with an option to also wipe your saved
SteamGridDB key. Or run `bash ~/Applications/steam_add/uninstall.sh`
directly (add `--purge-config` to also remove saved settings).

## Manual setup

```bash
pip install -r requirements.txt
python quick_add_steam_shortcut.py
```

On Windows, also install `pylnk3` if you want `.lnk` shortcut support
(optional — everything else works without it).

## Using it

A small always-on-top window opens. Drop a `.desktop` shortcut (Linux),
`.lnk` shortcut (Windows), or a raw game executable onto it (or click
**Browse…** to pick one). It will:

1. Parse the shortcut to get a title + real executable path.
2. Search Steam for matching titles and let you confirm/change the match.
3. Optionally force a specific Steam Play compatibility tool (Proton), read
   from Steam's own installed compat-tool manifests plus Valve's known
   official builds.
4. If a SteamGridDB key is set (⚙ Settings), fetch icon/hero/logo/cover
   artwork candidates and let you browse/pick each one from a thumbnail
   grid.
5. Write the shortcut into Steam's `shortcuts.vdf`, copy the chosen artwork
   into Steam's grid folder, and apply the compatibility tool override if
   requested.

Restart Steam (or wait for it to notice) to see the new entry.

## Status

Verified: `.desktop` parsing (including `env`/wrapper-style `Exec=` lines),
Steam `shortcuts.vdf` binary read/write — round-tripped and cross-checked
byte-for-byte against Hydra's own `steam-shortcut-editor`-based writer, so
this tool and Hydra's "Add to Steam" feature can both safely read/append to
the same file. Verified end-to-end on CachyOS/KDE, including drag-and-drop,
the right-click context menu integration, and installer/uninstaller.
**Not yet verified**: Windows (`.lnk`) support, and other Linux desktop
environments besides KDE (the right-click menu integration is KDE-specific;
everything else — drag-and-drop, the app launcher, Browse… — is
desktop-environment-agnostic).
