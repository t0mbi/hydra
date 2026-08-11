#!/usr/bin/env python3
"""Quick Add to Steam.

Drop a game shortcut (.desktop, .lnk, or a raw executable) onto this window
and it adds the game to Steam with the best available artwork.

Fully standalone: does not require Hydra to be installed or running. Only
network calls are a public, unauthenticated Hydra catalogue search (used
purely to normalize the game's title against Steam's own naming, exactly
like typing into Steam's own "add a non-Steam game" search would) and
SteamGridDB's API using your own personal key.

Dependencies (pip): requests, vdf, tkinterdnd2
Optional (pip, Windows-only, for .lnk support): pylnk3
"""

from __future__ import annotations

import json
import os
import re
import threading
import urllib.parse
import zlib
from pathlib import Path
from typing import Any

import requests
import vdf
import tkinter as tk
from tkinterdnd2 import DND_FILES, TkinterDnD

HYDRA_CATALOGUE_SEARCH_URL = (
    "https://hydra-api-us-east-1.losbroxas.org/catalogue/search/suggestions"
)
STEAMGRIDDB_BASE_URL = "https://www.steamgriddb.com/api/v2"

CONFIG_DIR = Path.home() / ".config" / "quick-add-steam-shortcut"
CONFIG_FILE = CONFIG_DIR / "config.json"

AUTO_CLOSE_DELAY_MS = 4500

ARTWORK_KIND_ENDPOINTS = {
    "icon": "icons",
    "hero": "heroes",
    "logo": "logos",
    "grid": "grids",
}

ARTWORK_KIND_PARAMS = {
    "icon": {"nsfw": "false", "mimes": "image/png,image/vnd.microsoft.icon"},
    "hero": {"nsfw": "false", "mimes": "image/png,image/jpeg,image/webp"},
    "logo": {"nsfw": "false", "mimes": "image/png,image/webp"},
    "grid": {
        "nsfw": "false",
        "dimensions": "600x900,342x482,660x930",
        "mimes": "image/png,image/jpeg,image/webp",
    },
}

DESKTOP_FIELD_CODES = re.compile(r"%[fFuUdDnNickvm]")
EXEC_WRAPPERS = {"env", "sh", "bash"}


# --- config -----------------------------------------------------------------


def load_config() -> dict[str, Any]:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_config(config: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, indent=2))


# --- steam location / shortcuts.vdf -----------------------------------------


def get_steam_location() -> Path:
    if os.name == "nt":
        import winreg

        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
            value, _ = winreg.QueryValueEx(key, "SteamPath")
            return Path(value)
        except OSError:
            pass
        return Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Steam"

    candidates = [
        Path.home() / ".steam" / "steam",
        Path.home() / ".local" / "share" / "Steam",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def get_steam_user_ids(steam_location: Path) -> list[int]:
    userdata = steam_location / "userdata"
    if not userdata.exists():
        return []
    return sorted(
        int(entry.name)
        for entry in userdata.iterdir()
        if entry.is_dir() and entry.name.isdigit()
    )


def generate_steam_shortcut_appid(exe_path: str, game_name: str) -> int:
    data = (exe_path + game_name).encode("utf-8")
    crc_value = zlib.crc32(data) & 0xFFFFFFFF
    return (crc_value | 0x80000000) & 0xFFFFFFFF


def _to_signed_int32(value: int) -> int:
    return value - 0x1_0000_0000 if value >= 0x8000_0000 else value


def _to_unsigned_int32(value: int) -> int:
    return value + 0x1_0000_0000 if value < 0 else value


def read_steam_shortcuts(shortcuts_path: Path) -> list[dict[str, Any]]:
    if not shortcuts_path.exists():
        return []

    with shortcuts_path.open("rb") as handle:
        parsed = vdf.binary_load(handle)

    shortcuts = parsed.get("shortcuts", {})
    ordered = [shortcuts[key] for key in sorted(shortcuts.keys(), key=int)]

    for shortcut in ordered:
        if "appid" in shortcut:
            shortcut["appid"] = _to_unsigned_int32(shortcut["appid"])

    return ordered


def write_steam_shortcuts(
    shortcuts_path: Path, shortcuts: list[dict[str, Any]]
) -> None:
    shortcuts_path.parent.mkdir(parents=True, exist_ok=True)

    # appid intentionally has its high bit set (see generate_steam_shortcut_appid),
    # putting it outside the signed int32 range the vdf package's binary
    # writer expects. The two's-complement bit pattern is identical either
    # way, so converting to a signed value here produces the exact same
    # on-disk bytes Steam itself writes/expects.
    keyed = {
        str(index): {
            **shortcut,
            "appid": _to_signed_int32(shortcut["appid"]),
        }
        for index, shortcut in enumerate(shortcuts)
    }

    with shortcuts_path.open("wb") as handle:
        # Field names/casing below match the real Steam binary shortcuts.vdf
        # format (verified against the steam-shortcut-editor npm package,
        # which writes object keys verbatim with no remapping).
        vdf.binary_dump({"shortcuts": keyed}, handle)


def compose_steam_shortcut(
    title: str,
    executable_path: str,
    icon_path: str | None,
    launch_options: str | None,
) -> dict[str, Any]:
    return {
        "appid": generate_steam_shortcut_appid(executable_path, title),
        "appname": title,
        "Exe": f'"{executable_path}"',
        "StartDir": f'"{os.path.dirname(executable_path)}"',
        "icon": icon_path or "",
        "ShortcutPath": "",
        "LaunchOptions": launch_options or "",
        "IsHidden": False,
        "AllowDesktopConfig": True,
        "AllowOverlay": True,
        "OpenVR": False,
        "Devkit": False,
        "DevkitGameID": "",
        "DevkitOverrideAppID": False,
        "LastPlayTime": 0,
        "FlatpakAppID": "",
    }


# --- shortcut parsing ---------------------------------------------------


def derive_title_from_path(file_path: str) -> str:
    base = Path(file_path).stem
    base = re.sub(r"[-_.]+", " ", base)
    base = re.sub(r"\s{2,}", " ", base).strip()
    return " ".join(word[:1].upper() + word[1:] for word in base.split(" ") if word)


def parse_desktop_entry(file_path: str) -> dict[str, Any] | None:
    content = Path(file_path).read_text(encoding="utf-8", errors="replace")
    name: str | None = None
    exec_line: str | None = None
    in_section = False

    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_section = stripped == "[Desktop Entry]"
            continue
        if not in_section:
            continue
        if name is None and stripped.startswith("Name="):
            name = stripped[len("Name=") :].strip()
        if exec_line is None and stripped.startswith("Exec="):
            exec_line = stripped[len("Exec=") :].strip()

    if not exec_line:
        return None

    cleaned = DESKTOP_FIELD_CODES.sub("", exec_line).strip()
    tokens = [
        token.strip("'\"")
        for token in re.findall(r"\"[^\"]*\"|'[^']*'|\S+", cleaned)
    ]
    if not tokens:
        return None

    if Path(tokens[0]).name in EXEC_WRAPPERS:
        # .desktop Exec lines are POSIX shell commands regardless of host OS,
        # so check for a POSIX-absolute path explicitly rather than
        # os.path.isabs (which is platform-dependent and can disagree on
        # what counts as absolute).
        exec_index = next(
            (i for i, t in enumerate(tokens) if i > 0 and t.startswith("/")), 0
        )
    else:
        exec_index = 0

    executable_path = tokens[exec_index]
    launch_options = " ".join(tokens[exec_index + 1 :]) or None

    return {
        "title": name or derive_title_from_path(file_path),
        "executable_path": executable_path,
        "launch_options": launch_options,
    }


def parse_dropped_shortcut(file_path: str) -> dict[str, Any] | None:
    if not os.path.exists(file_path):
        return None

    if file_path.lower().endswith(".desktop"):
        try:
            return parse_desktop_entry(file_path)
        except Exception:
            return None

    if file_path.lower().endswith(".lnk"):
        try:
            import pylnk3  # optional, Windows shortcut parsing

            shortcut = pylnk3.parse(file_path)
            target = shortcut.path
            if not target:
                return None
            return {
                "title": derive_title_from_path(file_path),
                "executable_path": target,
                "launch_options": (shortcut.arguments or None),
            }
        except Exception:
            return None

    return {
        "title": derive_title_from_path(file_path),
        "executable_path": file_path,
        "launch_options": None,
    }


# --- Steam name matching + artwork -------------------------------------


def find_best_steam_match(name: str) -> dict[str, Any] | None:
    try:
        response = requests.get(
            HYDRA_CATALOGUE_SEARCH_URL,
            params={"query": name, "limit": 1, "shop": "steam"},
            timeout=8,
        )
        response.raise_for_status()
        results = response.json()
        return results[0] if results else None
    except Exception:
        return None


def resolve_steamgriddb_game_id(
    api_key: str, title: str, steam_appid: str | None
) -> int | None:
    headers = {"Authorization": f"Bearer {api_key}"}

    if steam_appid:
        response = requests.get(
            f"{STEAMGRIDDB_BASE_URL}/games/steam/{steam_appid}",
            headers=headers,
            timeout=8,
        )
        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                return data["data"]["id"]

    response = requests.get(
        f"{STEAMGRIDDB_BASE_URL}/search/autocomplete/{urllib.parse.quote(title)}",
        headers=headers,
        timeout=8,
    )
    response.raise_for_status()
    data = response.json()
    candidates = data.get("data") or []
    if not candidates:
        return None

    exact = next(
        (c for c in candidates if c["name"].lower() == title.lower()), None
    )
    return (exact or candidates[0])["id"]


def fetch_best_asset_url(api_key: str, game_id: int, kind: str) -> str | None:
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(
        f"{STEAMGRIDDB_BASE_URL}/{ARTWORK_KIND_ENDPOINTS[kind]}/game/{game_id}",
        headers=headers,
        params=ARTWORK_KIND_PARAMS[kind],
        timeout=8,
    )
    response.raise_for_status()
    data = response.json()
    items = data.get("data") or []
    if not items:
        return None
    best = max(items, key=lambda item: item.get("score", 0))
    return best["url"]


def download_asset(url: str, dest_path: Path) -> Path | None:
    try:
        response = requests.get(url, timeout=15)
        response.raise_for_status()
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(response.content)
        return dest_path
    except Exception:
        return None


# --- core flow -----------------------------------------------------------


class QuickAddError(Exception):
    pass


def quick_add_steam_shortcut(
    file_path: str, api_key: str | None
) -> dict[str, Any]:
    parsed = parse_dropped_shortcut(file_path)
    if not parsed:
        raise QuickAddError("Couldn't read that shortcut.")

    match = find_best_steam_match(parsed["title"])
    display_title = match["title"] if match else parsed["title"]

    icon_path = hero_path = logo_path = cover_path = None
    artwork_status = "no-api-key"

    if api_key:
        game_id = resolve_steamgriddb_game_id(
            api_key, display_title, match["objectId"] if match else None
        )

        if game_id is not None:
            assets_dir = (
                CONFIG_DIR / "assets" / re.sub(r"[^a-z0-9]+", "-", display_title.lower())
            )

            for kind, attr in (
                ("icon", "icon_path"),
                ("hero", "hero_path"),
                ("logo", "logo_path"),
                ("grid", "cover_path"),
            ):
                try:
                    url = fetch_best_asset_url(api_key, game_id, kind)
                except Exception:
                    url = None

                if not url:
                    continue

                extension = ".ico" if kind == "icon" else Path(
                    urllib.parse.urlparse(url).path
                ).suffix or ".png"
                downloaded = download_asset(url, assets_dir / f"{kind}{extension}")

                if attr == "icon_path":
                    icon_path = downloaded
                elif attr == "hero_path":
                    hero_path = downloaded
                elif attr == "logo_path":
                    logo_path = downloaded
                elif attr == "cover_path":
                    cover_path = downloaded

        artwork_status = (
            "added" if any([icon_path, hero_path, logo_path, cover_path]) else "not-found"
        )

    steam_location = get_steam_location()
    steam_user_ids = get_steam_user_ids(steam_location)
    if not steam_user_ids:
        raise QuickAddError("No Steam user found on this machine.")

    new_shortcut = compose_steam_shortcut(
        display_title,
        parsed["executable_path"],
        str(icon_path) if icon_path else None,
        parsed.get("launch_options"),
    )

    for steam_user_id in steam_user_ids:
        shortcuts_path = (
            steam_location / "userdata" / str(steam_user_id) / "config" / "shortcuts.vdf"
        )
        shortcuts = read_steam_shortcuts(shortcuts_path)

        if any(s.get("appname") == display_title for s in shortcuts):
            continue

        grid_path = (
            steam_location / "userdata" / str(steam_user_id) / "config" / "grid"
        )
        grid_path.mkdir(parents=True, exist_ok=True)

        appid = new_shortcut["appid"]
        for source, filename in (
            (hero_path, f"{appid}_hero.jpg"),
            (logo_path, f"{appid}_logo.png"),
            (cover_path, f"{appid}p.jpg"),
        ):
            if source:
                (grid_path / filename).write_bytes(source.read_bytes())

        shortcuts.append(new_shortcut)
        write_steam_shortcuts(shortcuts_path, shortcuts)

    return {
        "title": display_title,
        "matched_steam_title": match["title"] if match else None,
        "artwork_status": artwork_status,
    }


# --- GUI -------------------------------------------------------------------


ARTWORK_MESSAGES = {
    "added": "Best available Steam artwork added",
    "no-api-key": "No artwork — paste a SteamGridDB key below",
    "not-found": "No matching artwork found on SteamGridDB",
}

BG_COLOR = "#16213e"
BG_COLOR_DRAG = "#1f2b52"
FG_COLOR = "#f2f2f2"
MUTED_COLOR = "#9aa0b4"
SUCCESS_COLOR = "#3fb950"
ERROR_COLOR = "#f85149"


class QuickAddWindow:
    def __init__(self, root: TkinterDnD.Tk) -> None:
        self.root = root
        self.config = load_config()
        self.status = "idle"

        root.title("Quick Add to Steam")
        root.geometry("420x300")
        root.resizable(False, False)
        root.configure(bg=BG_COLOR)
        root.attributes("-topmost", True)

        self.container = tk.Frame(root, bg=BG_COLOR)
        self.container.pack(fill="both", expand=True, padx=16, pady=16)

        self.content = tk.Frame(self.container, bg=BG_COLOR)
        self.content.pack(fill="both", expand=True)

        self.key_row = tk.Frame(self.container, bg=BG_COLOR)
        self.key_row.pack(fill="x", side="bottom", pady=(8, 0))

        tk.Label(
            self.key_row,
            text="SteamGridDB key:",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=("Sans", 9),
        ).pack(side="left")

        self.key_var = tk.StringVar(value=self.config.get("steamgriddb_api_key", ""))
        key_entry = tk.Entry(
            self.key_row,
            textvariable=self.key_var,
            show="•",
            bg="#0d0d0d",
            fg=FG_COLOR,
            insertbackground=FG_COLOR,
            relief="flat",
        )
        key_entry.pack(side="left", fill="x", expand=True, padx=(6, 0))
        key_entry.bind("<FocusOut>", self._save_key)
        key_entry.bind("<Return>", self._save_key)

        self.render_idle()

        root.drop_target_register(DND_FILES)
        root.dnd_bind("<<DropEnter>>", self._on_drag_enter)
        root.dnd_bind("<<DropLeave>>", self._on_drag_leave)
        root.dnd_bind("<<Drop>>", self._on_drop)

    def _save_key(self, _event=None) -> None:
        self.config["steamgriddb_api_key"] = self.key_var.get().strip()
        save_config(self.config)

    def _clear_content(self) -> None:
        for widget in self.content.winfo_children():
            widget.destroy()

    def _label(self, text: str, color: str, size: int, bold: bool = False) -> tk.Label:
        weight = "bold" if bold else "normal"
        label = tk.Label(
            self.content,
            text=text,
            bg=BG_COLOR,
            fg=color,
            font=("Sans", size, weight),
            wraplength=360,
            justify="center",
        )
        label.pack(pady=4)
        return label

    def render_idle(self) -> None:
        self.status = "idle"
        self._clear_content()
        self.content.pack_propagate(False)
        self._label("Drop a game shortcut here", FG_COLOR, 14, bold=True)
        self._label(
            "Adds it to Steam with the best available artwork", MUTED_COLOR, 10
        )

    def render_processing(self) -> None:
        self.status = "processing"
        self.key_row.pack_forget()
        self._clear_content()
        self._label("Adding to Steam…", FG_COLOR, 14, bold=True)

    def render_success(self, result: dict[str, Any]) -> None:
        self.status = "success"
        self._clear_content()
        self._label(f'Added "{result["title"]}" to Steam', SUCCESS_COLOR, 14, bold=True)

        if result["matched_steam_title"] and result["matched_steam_title"] != result["title"]:
            self._label(
                f"Matched to Steam title: {result['matched_steam_title']}",
                MUTED_COLOR,
                10,
            )

        self._label(ARTWORK_MESSAGES[result["artwork_status"]], MUTED_COLOR, 10)
        self._label("Restart Steam to see it", MUTED_COLOR, 9)
        self.root.after(AUTO_CLOSE_DELAY_MS, self.root.destroy)

    def render_error(self, message: str) -> None:
        self.status = "error"
        self._clear_content()
        self._label("Couldn't add that", ERROR_COLOR, 14, bold=True)
        self._label(message, MUTED_COLOR, 10)
        self.root.after(AUTO_CLOSE_DELAY_MS, self.root.destroy)

    def _on_drag_enter(self, _event=None) -> None:
        if self.status == "idle":
            self.root.configure(bg=BG_COLOR_DRAG)
            self.container.configure(bg=BG_COLOR_DRAG)
            self.content.configure(bg=BG_COLOR_DRAG)

    def _on_drag_leave(self, _event=None) -> None:
        self.root.configure(bg=BG_COLOR)
        self.container.configure(bg=BG_COLOR)
        self.content.configure(bg=BG_COLOR)

    def _on_drop(self, event) -> None:
        self._on_drag_leave()
        if self.status != "idle":
            return

        paths = self.root.tk.splitlist(event.data)
        if not paths:
            return

        self.handle_file(paths[0])

    def handle_file(self, file_path: str) -> None:
        self.render_processing()
        api_key = self.config.get("steamgriddb_api_key") or None

        def worker() -> None:
            try:
                result = quick_add_steam_shortcut(file_path, api_key)
                self.root.after(0, lambda: self.render_success(result))
            except QuickAddError as error:
                self.root.after(0, lambda: self.render_error(str(error)))
            except Exception:
                self.root.after(
                    0,
                    lambda: self.render_error(
                        "Something went wrong adding this to Steam."
                    ),
                )

        threading.Thread(target=worker, daemon=True).start()


def main() -> None:
    root = TkinterDnD.Tk()
    QuickAddWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
