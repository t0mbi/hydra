# Quick Add to Steam

A small standalone desktop utility: drop a game shortcut on it and it adds
the game to Steam with the best available artwork. Lives in this repo for
convenience, but it is **fully independent of Hydra** — it doesn't import
Hydra's code, doesn't need Hydra installed or running, and doesn't touch
Hydra's own data. The only network calls it makes are to Hydra's public,
unauthenticated catalogue-search endpoint (just used to normalize the
game's title against Steam's own naming — the same thing typing into
Steam's own search would do) and to SteamGridDB using your own key.

## Setup

```bash
pip install -r requirements.txt
```

On Windows, also install `pylnk3` if you want `.lnk` shortcut support
(optional — everything else works without it).

## Running it

```bash
python quick_add_steam_shortcut.py
```

A small always-on-top window opens. Drop a `.desktop` shortcut (Linux),
`.lnk` shortcut (Windows), or a raw game executable onto it. It will:

1. Parse the shortcut to get a title + real executable path.
2. Look up the closest Steam title match by name.
3. Fetch the best-scored icon/hero/logo/grid art from SteamGridDB (needs a
   key — paste one into the field at the bottom of the window; it's saved
   to `~/.config/quick-add-steam-shortcut/config.json` for next time).
4. Write the shortcut into Steam's `shortcuts.vdf` and copy the artwork into
   Steam's grid folder.
5. Show what it did, then close itself after a few seconds.

Restart Steam (or wait for it to notice) to see the new entry.

## Desktop launcher

`quick-add-steam-shortcut.desktop` in this folder is a template — edit the
`Exec=` line to point at your actual Python + script path, then drop it on
your desktop and mark it executable/trusted. Opening it launches the drop
window; drag your shortcut onto that window (dragging a file directly onto
the desktop icon itself isn't reliably supported across Linux desktop
environments, so this two-step — open, then drop — is the flow that
actually works everywhere).

## Status

Verified: `.desktop` parsing (including `env`/wrapper-style `Exec=` lines),
Steam `shortcuts.vdf` binary read/write — round-tripped and cross-checked
byte-for-byte against Hydra's own `steam-shortcut-editor`-based writer, so
this tool and Hydra's "Add to Steam" feature can both safely read/append to
the same file. **Not yet verified**: the actual Tkinter GUI and drag-and-drop
behavior, since this was built and tested headlessly on Windows — try it for
real on Linux before relying on it.
