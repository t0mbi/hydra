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

import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import zlib
from pathlib import Path
from typing import Any

import requests
import vdf
import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageTk
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


# Steam's per-game compatibility dropdown also lists Valve's official Proton
# builds even when they haven't been downloaded yet (offering to fetch them
# on selection) — that list comes from Steam's own client-side app registry,
# which isn't readable from local files. These internal tool names are
# Valve's stable, long-documented identifiers for each official build, used
# here only to fill in entries discover_compat_tools() can't see locally.
KNOWN_OFFICIAL_PROTON_TOOLS = [
    ("Proton Hotfix", "proton_hotfix"),
    ("Proton Experimental", "proton_experimental"),
    ("Proton 9.0-4", "proton_9"),
    ("Proton 8.0-5", "proton_8"),
    ("Proton 7.0-6", "proton_7"),
    ("Proton 6.3-8", "proton_63"),
    ("Proton 5.13-6", "proton_513"),
    ("Proton 5.0-10", "proton_5"),
    ("Proton 4.11-13", "proton_411"),
]


def discover_compat_tools(steam_location: Path) -> list[tuple[str, str]]:
    """(display_name, internal_name) pairs matching what Steam's own per-game
    "Force the use of a specific Steam Play compatibility tool" dropdown
    would offer: locally installed tools (read from Steam's own
    compatibilitytool.vdf manifests — includes Steam Linux Runtime
    containers and community builds like GE-Proton/UMU-Proton, exactly as
    Steam lists them) plus Valve's known official Proton builds, which Steam
    lists even before they've been downloaded."""
    found: dict[str, str] = {}

    search_roots = [
        steam_location / "steamapps" / "common",
        steam_location / "compatibilitytools.d",
    ]

    for root_dir in search_roots:
        if not root_dir.exists():
            continue
        for entry in root_dir.iterdir():
            manifest = entry / "compatibilitytool.vdf"
            if not manifest.exists():
                continue
            try:
                with manifest.open("r", encoding="utf-8", errors="replace") as handle:
                    data = vdf.load(handle)
                compat_tools = (
                    data.get("compatibilitytools", {}).get("compat_tools", {})
                )
                for internal_name, info in compat_tools.items():
                    found[internal_name] = info.get("display_name", internal_name)
            except Exception:
                continue

    for display_name, internal_name in KNOWN_OFFICIAL_PROTON_TOOLS:
        found.setdefault(internal_name, display_name)

    return sorted(found.items(), key=lambda item: item[1].lower())


def set_compat_tool_override(steam_location: Path, appid: int, tool_name: str) -> None:
    config_path = steam_location / "config" / "config.vdf"

    if config_path.exists():
        with config_path.open("r", encoding="utf-8", errors="replace") as handle:
            data = vdf.load(handle)
    else:
        data = {}

    steam_section = (
        data.setdefault("InstallConfigStore", {})
        .setdefault("Software", {})
        .setdefault("Valve", {})
        .setdefault("Steam", {})
    )
    mapping = steam_section.setdefault("CompatToolMapping", {})
    mapping[str(appid)] = {"name": tool_name, "config": "", "priority": "250"}

    config_path.parent.mkdir(parents=True, exist_ok=True)
    with config_path.open("w", encoding="utf-8") as handle:
        vdf.dump(data, handle, pretty=True)


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


def search_steam_matches(name: str, limit: int = 6) -> list[dict[str, Any]]:
    try:
        response = requests.get(
            HYDRA_CATALOGUE_SEARCH_URL,
            params={"query": name, "limit": limit, "shop": "steam"},
            timeout=8,
        )
        response.raise_for_status()
        return response.json() or []
    except Exception:
        return []


def test_steamgriddb_api_key(api_key: str) -> bool:
    response = requests.get(
        f"{STEAMGRIDDB_BASE_URL}/search/autocomplete/portal",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=8,
    )
    if response.status_code == 401:
        return False
    response.raise_for_status()
    return bool(response.json().get("success"))


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


def fetch_asset_candidates(
    api_key: str, game_id: int, kind: str, limit: int = 8
) -> list[dict[str, Any]]:
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
    items.sort(key=lambda item: item.get("score", 0), reverse=True)
    return [
        {"url": item["url"], "thumb": item.get("thumb") or item["url"], "score": item.get("score", 0)}
        for item in items[:limit]
    ]


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


def download_chosen_assets(
    display_title: str, chosen: dict[str, dict[str, Any] | None]
) -> dict[str, Path | None]:
    assets_dir = (
        CONFIG_DIR / "assets" / re.sub(r"[^a-z0-9]+", "-", display_title.lower())
    )
    downloaded: dict[str, Path | None] = {}

    for kind in ("icon", "hero", "logo", "grid"):
        candidate = chosen.get(kind)
        if not candidate or not candidate.get("url"):
            downloaded[kind] = None
            continue

        url = candidate["url"]
        extension = ".ico" if kind == "icon" else Path(
            urllib.parse.urlparse(url).path
        ).suffix or ".png"
        downloaded[kind] = download_asset(url, assets_dir / f"{kind}{extension}")

    return downloaded


def finalize_add_to_steam(
    title: str,
    executable_path: str,
    launch_options: str | None,
    icon_path: Path | None,
    hero_path: Path | None,
    logo_path: Path | None,
    cover_path: Path | None,
) -> None:
    steam_location = get_steam_location()
    steam_user_ids = get_steam_user_ids(steam_location)
    if not steam_user_ids:
        raise QuickAddError("No Steam user found on this machine.")

    new_shortcut = compose_steam_shortcut(
        title,
        executable_path,
        str(icon_path) if icon_path else None,
        launch_options,
    )

    for steam_user_id in steam_user_ids:
        shortcuts_path = (
            steam_location / "userdata" / str(steam_user_id) / "config" / "shortcuts.vdf"
        )
        shortcuts = read_steam_shortcuts(shortcuts_path)

        if any(s.get("appname") == title for s in shortcuts):
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


# --- GUI -------------------------------------------------------------------


ARTWORK_KIND_LABELS = {
    "icon": "Icon",
    "hero": "Hero",
    "logo": "Logo",
    "grid": "Cover",
}

ARTWORK_KINDS = ("icon", "hero", "logo", "grid")
THUMB_SIZE = (340, 190)
GRID_TILE_SIZE = (86, 48)
GRID_TILE_COLUMNS = 4

# Used only if no compat tools could be discovered on disk (see
# discover_compat_tools) — e.g. Steam has never downloaded any Proton build.
FALLBACK_COMPAT_OPTIONS = [
    ("Proton Experimental", "proton_experimental"),
    ("Proton 9.0", "proton_9"),
    ("Proton 8.0", "proton_8"),
    ("Proton 7.0", "proton_7"),
    ("Proton Hotfix", "proton_hotfix"),
]

BG_COLOR = "#12141c"
BG_COLOR_DRAG = "#1a1d2c"
PANEL_COLOR = "#1b1e2b"
BORDER_COLOR = "#2a2e42"
FG_COLOR = "#e9eaf2"
MUTED_COLOR = "#888ea6"
ACCENT_COLOR = "#6d7bf7"
ACCENT_HOVER = "#8493ff"
SUCCESS_COLOR = "#34d399"
ERROR_COLOR = "#f87171"

_FONT_FAMILY_CACHE: str | None = None
_FONT_PREFERENCES = ("Inter", "Segoe UI", "Ubuntu", "Cantarell", "Noto Sans", "Sans")
_MONO_FONT_PREFERENCES = ("JetBrains Mono", "Cascadia Code", "Consolas", "Monospace")


def _pick_font(preferences: tuple[str, ...]) -> str:
    import tkinter.font as tkfont

    available = set(tkfont.families())
    for name in preferences:
        if name in available:
            return name
    return preferences[-1]


def font_family() -> str:
    global _FONT_FAMILY_CACHE
    if _FONT_FAMILY_CACHE is None:
        _FONT_FAMILY_CACHE = _pick_font(_FONT_PREFERENCES)
    return _FONT_FAMILY_CACHE


def mono_font_family() -> str:
    return _pick_font(_MONO_FONT_PREFERENCES)


def ui_font(size: int, bold: bool = False) -> tuple[str, int, str]:
    return (font_family(), size, "bold" if bold else "normal")


def _fetch_thumbnail(
    url: str, size: tuple[int, int] = THUMB_SIZE
) -> ImageTk.PhotoImage | None:
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        image = Image.open(io.BytesIO(response.content))
        image.thumbnail(size)
        return ImageTk.PhotoImage(image)
    except Exception:
        return None


def _rounded_rect_points(x1: float, y1: float, x2: float, y2: float, r: float) -> list[float]:
    r = min(r, (x2 - x1) / 2, (y2 - y1) / 2)
    return [
        x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r,
        x2, y2 - r, x2, y2, x2 - r, y2, x1 + r, y2,
        x1, y2, x1, y2 - r, x1, y1 + r, x1, y1,
    ]


class Button(tk.Canvas):
    """A flat, rounded, hover-aware button drawn on a canvas — tk.Button
    can't do rounded corners or smooth hover color transitions."""

    def __init__(
        self,
        parent: tk.Widget,
        text: str,
        command,
        bg: str = ACCENT_COLOR,
        hover_bg: str = ACCENT_HOVER,
        fg: str = "#0c0e16",
        width: int = 150,
        height: int = 34,
        radius: int = 8,
        font_size: int = 10,
        bold: bool = True,
    ) -> None:
        parent_bg = parent["bg"] if "bg" in parent.keys() else BG_COLOR
        super().__init__(
            parent, width=width, height=height, bg=parent_bg, highlightthickness=0
        )
        self.command = command
        self.bg_color = bg
        self.hover_color = hover_bg
        self.disabled = False

        self.rect = self.create_polygon(
            _rounded_rect_points(1, 1, width - 1, height - 1, radius),
            smooth=True,
            fill=bg,
            outline="",
        )
        self.text_id = self.create_text(
            width / 2, height / 2, text=text, fill=fg, font=ui_font(font_size, bold)
        )

        self.bind("<Enter>", self._on_enter)
        self.bind("<Leave>", self._on_leave)
        self.bind("<Button-1>", self._on_click)

    def _on_enter(self, _event=None) -> None:
        if not self.disabled:
            self.itemconfig(self.rect, fill=self.hover_color)
            self.configure(cursor="hand2")

    def _on_leave(self, _event=None) -> None:
        if not self.disabled:
            self.itemconfig(self.rect, fill=self.bg_color)

    def _on_click(self, _event=None) -> None:
        if not self.disabled and self.command:
            self.command()

    def set_text(self, text: str) -> None:
        self.itemconfig(self.text_id, text=text)

    def set_enabled(self, enabled: bool) -> None:
        self.disabled = not enabled
        self.itemconfig(self.rect, fill=self.bg_color if enabled else BORDER_COLOR)
        self.configure(cursor="hand2" if enabled else "arrow")


class SettingsModal(tk.Toplevel):
    def __init__(self, parent: "QuickAddWindow") -> None:
        super().__init__(parent.root)
        self.parent = parent
        self.title("Settings")
        self.configure(bg=BG_COLOR)
        self.resizable(False, False)
        self.transient(parent.root)
        self.attributes("-topmost", True)

        frame = tk.Frame(self, bg=BG_COLOR)
        frame.pack(fill="both", expand=True, padx=16, pady=16)

        tk.Label(
            frame,
            text="SteamGridDB API key",
            bg=BG_COLOR,
            fg=FG_COLOR,
            font=ui_font(10, bold=True),
        ).pack(anchor="w")

        key_row = tk.Frame(frame, bg=BG_COLOR)
        key_row.pack(fill="x", pady=(6, 0))

        self.key_var = tk.StringVar(
            value=parent.config.get("steamgriddb_api_key", "")
        )
        key_entry = tk.Entry(
            key_row,
            textvariable=self.key_var,
            show="•",
            bg=PANEL_COLOR,
            fg=FG_COLOR,
            insertbackground=FG_COLOR,
            relief="flat",
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
            highlightcolor=ACCENT_COLOR,
            font=ui_font(10),
        )
        key_entry.pack(side="left", fill="x", expand=True, ipady=4)
        key_entry.bind("<Return>", lambda _e: self._save())

        self.test_button = Button(
            key_row, text="Test", command=self._test, width=70, height=30, font_size=9
        )
        self.test_button.pack(side="left", padx=(8, 0))

        self.status_label = tk.Label(
            frame, text="", bg=BG_COLOR, fg=MUTED_COLOR, font=ui_font(9)
        )
        self.status_label.pack(anchor="w", pady=(8, 0))

        Button(
            frame,
            text="Save & Close",
            command=self._save_and_close,
            width=120,
            height=32,
        ).pack(anchor="e", pady=(14, 0))

        tk.Frame(frame, bg=BORDER_COLOR, height=1).pack(fill="x", pady=(18, 12))

        uninstall_link = tk.Label(
            frame,
            text="Uninstall Quick Add to Steam",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=ui_font(9),
            cursor="hand2",
        )
        uninstall_link.pack(anchor="w")
        uninstall_link.bind("<Button-1>", lambda _e: self._uninstall())
        uninstall_link.bind("<Enter>", lambda _e: uninstall_link.configure(fg=ERROR_COLOR))
        uninstall_link.bind("<Leave>", lambda _e: uninstall_link.configure(fg=MUTED_COLOR))

        self.protocol("WM_DELETE_WINDOW", self._save_and_close)

    def _save(self) -> None:
        self.parent.config["steamgriddb_api_key"] = self.key_var.get().strip()
        save_config(self.parent.config)

    def _save_and_close(self) -> None:
        self._save()
        self.destroy()

    def _uninstall(self) -> None:
        if not messagebox.askyesno(
            "Uninstall Quick Add to Steam",
            "This removes the app, its app-launcher entry, and the "
            '"Add to Steam" right-click integration (restoring the '
            "system default). This can't be undone. Continue?",
            parent=self,
        ):
            return

        purge_config = messagebox.askyesno(
            "Remove saved settings too?",
            "Also delete your saved SteamGridDB key and preferences?",
            parent=self,
        )

        uninstall_script = Path(__file__).resolve().parent / "uninstall.sh"
        args = ["bash", str(uninstall_script)]
        if purge_config:
            args.append("--purge-config")

        subprocess.Popen(
            args, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        self.parent.root.destroy()
        sys.exit(0)

    def _test(self) -> None:
        api_key = self.key_var.get().strip()
        if not api_key:
            self.status_label.configure(text="Enter a key first", fg=ERROR_COLOR)
            return

        self._save()
        self.test_button.set_enabled(False)
        self.status_label.configure(text="Testing…", fg=MUTED_COLOR)

        def worker() -> None:
            try:
                valid = test_steamgriddb_api_key(api_key)
            except Exception:
                valid = False
            self.after(0, lambda: self._on_tested(valid))

        threading.Thread(target=worker, daemon=True).start()

    def _on_tested(self, valid: bool) -> None:
        self.test_button.set_enabled(True)
        if valid:
            self.status_label.configure(text="Key is valid", fg=SUCCESS_COLOR)
        else:
            self.status_label.configure(text="Key is invalid", fg=ERROR_COLOR)


class QuickAddWindow:
    def __init__(self, root: TkinterDnD.Tk) -> None:
        self.root = root
        self.config = load_config()
        self.status = "idle"

        self.parsed: dict[str, Any] | None = None
        self.matches: list[dict[str, Any]] = []
        self.display_title: str = ""
        self.matched_steam_title: str | None = None
        self.matched_steam_appid: str | None = None
        self.artwork_candidates: dict[str, list[dict[str, Any]]] = {}
        self.artwork_index: dict[str, int] = {}
        self.thumbnail_cache: dict[tuple[str, int], ImageTk.PhotoImage | None] = {}
        self.grid_thumbnail_cache: dict[tuple[str, int], ImageTk.PhotoImage | None] = {}
        self.active_artwork_kind: str = ARTWORK_KINDS[0]
        self.artwork_tab_buttons: dict[str, tk.Button] = {}
        self.artwork_thumb_label: tk.Label | None = None
        self.artwork_score_label: tk.Label | None = None

        self.compat_tool_options = discover_compat_tools(get_steam_location())
        self.compat_tools_discovered = bool(self.compat_tool_options)
        if not self.compat_tool_options:
            self.compat_tool_options = FALLBACK_COMPAT_OPTIONS
        self.compat_label_to_id = {
            label: tool_id for label, tool_id in self.compat_tool_options
        }

        self.force_compat_tool: bool = self.config.get("force_compat_tool", False)
        self.compat_tool_id: str = self.config.get(
            "compat_tool", self.compat_tool_options[0][1]
        )

        root.title("Quick Add to Steam")
        root.geometry("520x780")
        root.resizable(False, False)
        root.configure(bg=BG_COLOR)
        root.attributes("-topmost", True)

        top_bar = tk.Frame(root, bg=BG_COLOR)
        top_bar.pack(fill="x", padx=20, pady=(16, 0))

        tk.Label(
            top_bar,
            text="QUICK ADD TO STEAM",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=ui_font(9, bold=True),
        ).pack(side="left")

        settings_btn = tk.Label(
            top_bar,
            text="⚙",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=ui_font(13),
            cursor="hand2",
        )
        settings_btn.pack(side="right")
        settings_btn.bind("<Button-1>", lambda _e: self._open_settings())
        settings_btn.bind("<Enter>", lambda _e: settings_btn.configure(fg=FG_COLOR))
        settings_btn.bind("<Leave>", lambda _e: settings_btn.configure(fg=MUTED_COLOR))

        tk.Frame(root, bg=BORDER_COLOR, height=1).pack(fill="x", padx=20, pady=(12, 0))

        self.container = tk.Frame(root, bg=BG_COLOR)
        self.container.pack(fill="both", expand=True, padx=20, pady=16)

        self.content = tk.Frame(self.container, bg=BG_COLOR)
        self.content.pack(fill="both", expand=True)

        log_frame = tk.Frame(root, bg=BG_COLOR)
        log_frame.pack(fill="x", side="bottom", padx=20, pady=(0, 16))

        tk.Label(
            log_frame,
            text="ACTIVITY",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=ui_font(8, bold=True),
        ).pack(anchor="w", pady=(0, 4))

        self.log_text = tk.Text(
            log_frame,
            height=7,
            bg=PANEL_COLOR,
            fg=MUTED_COLOR,
            insertbackground=FG_COLOR,
            relief="flat",
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
            font=(mono_font_family(), 8),
            state="disabled",
            wrap="word",
            padx=8,
            pady=6,
        )
        self.log_text.pack(fill="x")

        if not self.compat_tools_discovered:
            self._log(
                "No installed Steam Play compat tools found on disk — "
                "using a default Proton list"
            )

        self.render_idle()

        root.drop_target_register(DND_FILES)
        root.dnd_bind("<<DropEnter>>", self._on_drag_enter)
        root.dnd_bind("<<DropLeave>>", self._on_drag_leave)
        root.dnd_bind("<<Drop>>", self._on_drop)

    def _open_settings(self) -> None:
        SettingsModal(self)

    def _log(self, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{timestamp}] {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_content(self) -> None:
        for widget in self.content.winfo_children():
            widget.destroy()

    def _label(self, text: str, color: str, size: int, bold: bool = False) -> tk.Label:
        label = tk.Label(
            self.content,
            text=text,
            bg=BG_COLOR,
            fg=color,
            font=ui_font(size, bold),
            wraplength=440,
            justify="center",
        )
        label.pack(pady=4)
        return label

    # --- idle / drop -----------------------------------------------------

    def render_idle(self) -> None:
        self.status = "idle"
        self._clear_content()

        spacer = tk.Frame(self.content, bg=BG_COLOR)
        spacer.pack(expand=True)

        self.drop_zone = tk.Canvas(
            self.content, bg=BG_COLOR, highlightthickness=0, width=440, height=220
        )
        self.drop_zone.pack()
        self._draw_drop_zone()

        tk.Label(
            self.content,
            text="Adds it to Steam with the best available artwork",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=ui_font(10),
        ).pack(pady=(18, 4))

        Button(
            self.content, text="Browse…", command=self._browse_for_file, width=140
        ).pack(pady=(4, 0))

    def _draw_drop_zone(self) -> None:
        c = self.drop_zone
        c.delete("all")
        self.drop_zone_rect = c.create_polygon(
            _rounded_rect_points(2, 2, 438, 218, 18),
            smooth=True,
            fill=PANEL_COLOR,
            outline=BORDER_COLOR,
            width=1,
            dash=(6, 4),
        )
        c.create_text(
            220, 95, text="⇩", fill=ACCENT_COLOR, font=(font_family(), 34)
        )
        c.create_text(
            220,
            145,
            text="Drop a game shortcut here",
            fill=FG_COLOR,
            font=ui_font(13, bold=True),
        )
        c.create_text(
            220,
            170,
            text=".desktop · .lnk · .exe",
            fill=MUTED_COLOR,
            font=ui_font(9),
        )

    def _browse_for_file(self) -> None:
        file_path = filedialog.askopenfilename(
            title="Choose a game shortcut or executable",
            filetypes=[
                ("Shortcuts and executables", "*.desktop *.lnk *.exe"),
                ("All files", "*"),
            ],
        )
        if file_path:
            self.handle_file(file_path)

    def _on_drag_enter(self, _event=None) -> None:
        if self.status == "idle" and self.drop_zone.winfo_exists():
            self.drop_zone.itemconfig(
                self.drop_zone_rect, fill=BG_COLOR_DRAG, outline=ACCENT_COLOR
            )

    def _on_drag_leave(self, _event=None) -> None:
        if self.status == "idle" and self.drop_zone.winfo_exists():
            self.drop_zone.itemconfig(
                self.drop_zone_rect, fill=PANEL_COLOR, outline=BORDER_COLOR
            )

    def _on_drop(self, event) -> None:
        self._on_drag_leave()
        if self.status != "idle":
            return

        paths = self.root.tk.splitlist(event.data)
        if not paths:
            return

        self.handle_file(paths[0])

    # --- stage 1: parse + match search ------------------------------------

    def handle_file(self, file_path: str) -> None:
        self.status = "matching"
        self._clear_content()
        self._label("Reading shortcut…", FG_COLOR, 14, bold=True)
        self._log(f"Dropped: {file_path}")

        def worker() -> None:
            parsed = parse_dropped_shortcut(file_path)
            if not parsed:
                self.root.after(
                    0, lambda: self.render_error("Couldn't read that shortcut.")
                )
                return

            self.root.after(0, lambda: self._log(f"Guessed title: {parsed['title']}"))
            self.root.after(
                0, lambda: self._log("Searching Steam catalogue for a match…")
            )
            matches = search_steam_matches(parsed["title"])
            self.root.after(0, lambda: self._on_matches_found(parsed, matches))

        threading.Thread(target=worker, daemon=True).start()

    def _on_matches_found(
        self, parsed: dict[str, Any], matches: list[dict[str, Any]]
    ) -> None:
        self.parsed = parsed
        self.matches = matches
        self._log(f"Found {len(matches)} possible Steam match(es)")
        self.render_match_confirm()

    # --- stage 2: confirm match --------------------------------------------

    def render_match_confirm(self) -> None:
        self.status = "match_confirm"
        self._clear_content()
        self._back_button(target=self.render_idle)
        self._label("Confirm the Steam match", FG_COLOR, 14, bold=True)

        options = [m["title"] for m in self.matches]
        original_label = f"Keep as-is: \"{self.parsed['title']}\""
        options.append(original_label)

        self.match_listbox = tk.Listbox(
            self.content,
            bg=PANEL_COLOR,
            fg=FG_COLOR,
            selectbackground=ACCENT_COLOR,
            selectforeground="#0c0e16",
            relief="flat",
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
            font=ui_font(10),
            height=min(6, len(options)),
            exportselection=False,
            activestyle="none",
        )
        for option in options:
            self.match_listbox.insert("end", option)
        default_index = getattr(self, "selected_match_index", None)
        if default_index is None:
            default_index = 0 if self.matches else len(options) - 1
        self.match_listbox.selection_set(default_index)
        self.match_listbox.pack(fill="x", pady=(10, 14), ipady=2)

        compat_row = tk.Frame(self.content, bg=BG_COLOR)
        compat_row.pack(fill="x", pady=(0, 16))

        self.compat_var = tk.BooleanVar(value=self.force_compat_tool)
        tk.Checkbutton(
            compat_row,
            text="Force Steam Play compatibility tool",
            variable=self.compat_var,
            command=self._on_compat_toggle,
            bg=BG_COLOR,
            fg=FG_COLOR,
            selectcolor=PANEL_COLOR,
            activebackground=BG_COLOR,
            activeforeground=FG_COLOR,
            font=ui_font(9),
        ).pack(side="left")

        self.compat_tool_var = tk.StringVar(
            value=next(
                (
                    label
                    for label, tool_id in self.compat_tool_options
                    if tool_id == self.compat_tool_id
                ),
                self.compat_tool_options[0][0],
            )
        )
        self.compat_menu = tk.OptionMenu(
            compat_row,
            self.compat_tool_var,
            *[label for label, _ in self.compat_tool_options],
        )
        self.compat_menu.configure(
            bg=PANEL_COLOR,
            fg=FG_COLOR,
            activebackground=BG_COLOR_DRAG,
            activeforeground=FG_COLOR,
            relief="flat",
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
            font=ui_font(9),
        )
        self.compat_menu["menu"].configure(bg=PANEL_COLOR, fg=FG_COLOR)
        self.compat_menu.pack(side="left", padx=(8, 0))
        if not self.force_compat_tool:
            self.compat_menu.configure(state="disabled")

        Button(
            self.content,
            text="Use this match",
            command=self._on_match_confirmed,
            width=160,
        ).pack()

    def _on_compat_toggle(self) -> None:
        self.compat_menu.configure(
            state="normal" if self.compat_var.get() else "disabled"
        )

    def _on_match_confirmed(self) -> None:
        self.force_compat_tool = self.compat_var.get()
        self.compat_tool_id = self.compat_label_to_id[self.compat_tool_var.get()]
        self.config["force_compat_tool"] = self.force_compat_tool
        self.config["compat_tool"] = self.compat_tool_id
        save_config(self.config)

        if self.force_compat_tool:
            self._log(f"Will force compatibility tool: {self.compat_tool_var.get()}")

        selection = self.match_listbox.curselection()
        index = selection[0] if selection else len(self.matches)
        self.selected_match_index = index

        if index < len(self.matches):
            match = self.matches[index]
            self.display_title = match["title"]
            self.matched_steam_title = match["title"]
            self.matched_steam_appid = match.get("objectId")
            self._log(f"Matched to: {self.display_title}")
        else:
            self.display_title = self.parsed["title"]
            self.matched_steam_title = None
            self.matched_steam_appid = None
            self._log(f"Using original title: {self.display_title}")

        api_key = self.config.get("steamgriddb_api_key") or None
        if api_key:
            self.start_artwork_lookup(api_key)
        else:
            self._log("No SteamGridDB key set — skipping artwork")
            self.run_finalize({})

    # --- stage 3: artwork lookup + review -----------------------------------

    def _back_button(self, target=None) -> None:
        target = target or self.render_match_confirm
        back = tk.Label(
            self.content,
            text="← Back",
            bg=BG_COLOR,
            fg=MUTED_COLOR,
            font=ui_font(9),
            cursor="hand2",
        )
        back.pack(anchor="w")
        back.bind("<Button-1>", lambda _e: target())
        back.bind("<Enter>", lambda _e: back.configure(fg=FG_COLOR))
        back.bind("<Leave>", lambda _e: back.configure(fg=MUTED_COLOR))

    def start_artwork_lookup(self, api_key: str) -> None:
        self.status = "artwork_loading"
        self._clear_content()
        self._back_button()
        self._label("Looking up artwork…", FG_COLOR, 14, bold=True)
        self._log("Resolving SteamGridDB game…")

        def worker() -> None:
            try:
                game_id = resolve_steamgriddb_game_id(
                    api_key, self.display_title, self.matched_steam_appid
                )
            except Exception:
                game_id = None

            if self.status != "artwork_loading":
                return  # user navigated back before this finished

            if game_id is None:
                self.root.after(0, lambda: self._log("No SteamGridDB match found"))
                self.root.after(0, lambda: self.run_finalize({}))
                return

            candidates: dict[str, list[dict[str, Any]]] = {}
            for kind in ("icon", "hero", "logo", "grid"):
                try:
                    candidates[kind] = fetch_asset_candidates(api_key, game_id, kind)
                except Exception:
                    candidates[kind] = []

            self.root.after(0, lambda: self._on_artwork_candidates(candidates))

        threading.Thread(target=worker, daemon=True).start()

    def _on_artwork_candidates(self, candidates: dict[str, list[dict[str, Any]]]) -> None:
        if self.status != "artwork_loading":
            return  # user navigated back before this finished

        self.artwork_candidates = candidates
        self.artwork_index = {kind: 0 for kind in candidates}
        self.thumbnail_cache = {}
        self.grid_thumbnail_cache = {}
        total = sum(len(v) for v in candidates.values())
        self._log(f"Found {total} artwork option(s)")
        self.render_artwork_review()

    def render_artwork_review(self) -> None:
        self.status = "artwork_review"
        self._clear_content()
        self._back_button()
        self._label("Choose artwork", FG_COLOR, 14, bold=True)

        self.active_artwork_kind = ARTWORK_KINDS[0]
        self.artwork_tab_buttons = {}

        tab_bar = tk.Frame(self.content, bg=BG_COLOR)
        tab_bar.pack(pady=(12, 6))

        for kind in ARTWORK_KINDS:
            count = len(self.artwork_candidates.get(kind, []))
            tab = tk.Label(
                tab_bar,
                text=f"{ARTWORK_KIND_LABELS[kind]} ({count})",
                bg=PANEL_COLOR,
                fg=MUTED_COLOR,
                font=ui_font(9, bold=True),
                padx=12,
                pady=6,
                cursor="hand2",
            )
            tab.pack(side="left", padx=(0, 6))
            tab.bind("<Button-1>", lambda _e, k=kind: self._switch_artwork_tab(k))
            self.artwork_tab_buttons[kind] = tab

        panel = tk.Frame(self.content, bg=BG_COLOR)
        panel.pack(fill="both", expand=True, pady=(6, 10))

        self.artwork_thumb_label = tk.Label(
            panel,
            bg=PANEL_COLOR,
            highlightthickness=1,
            highlightbackground=BORDER_COLOR,
        )
        self.artwork_thumb_label.pack()

        self.artwork_score_label = tk.Label(
            panel, text="", bg=BG_COLOR, fg=MUTED_COLOR, font=ui_font(9)
        )
        self.artwork_score_label.pack(pady=(10, 10))

        self.artwork_grid_frame = tk.Frame(panel, bg=BG_COLOR)
        self.artwork_grid_frame.pack()
        self.artwork_grid_tiles: dict[int, tk.Label] = {}

        self._switch_artwork_tab(self.active_artwork_kind)

        Button(
            self.content,
            text="Add to Steam",
            command=self._on_artwork_confirmed,
            width=160,
        ).pack(pady=(6, 0))

    def _switch_artwork_tab(self, kind: str) -> None:
        self.active_artwork_kind = kind
        for tab_kind, button in self.artwork_tab_buttons.items():
            active = tab_kind == kind
            button.configure(
                bg=ACCENT_COLOR if active else PANEL_COLOR,
                fg="#0c0e16" if active else MUTED_COLOR,
            )
        self._refresh_active_artwork()
        self._build_artwork_grid(kind)

    def _build_artwork_grid(self, kind: str) -> None:
        for widget in self.artwork_grid_frame.winfo_children():
            widget.destroy()
        self.artwork_grid_tiles = {}

        candidates = self.artwork_candidates.get(kind, [])
        total_tiles = len(candidates) + 1  # +1 for the "no artwork" tile

        for index in range(total_tiles):
            row, col = divmod(index, GRID_TILE_COLUMNS)
            tile = tk.Label(
                self.artwork_grid_frame,
                bg=PANEL_COLOR,
                width=GRID_TILE_SIZE[0] // 7,
                height=GRID_TILE_SIZE[1] // 16,
                highlightthickness=2,
                highlightbackground=BORDER_COLOR,
                cursor="hand2",
            )
            tile.grid(row=row, column=col, padx=4, pady=4)
            tile.bind(
                "<Button-1>", lambda _e, i=index: self._select_artwork_tile(kind, i)
            )
            self.artwork_grid_tiles[index] = tile

            if index < len(candidates):
                self._load_grid_thumbnail(kind, index, candidates[index], tile)
            else:
                tile.configure(text="None", fg=MUTED_COLOR, font=ui_font(8))

        self._highlight_selected_tile(kind)

    def _load_grid_thumbnail(
        self, kind: str, index: int, candidate: dict[str, Any], tile: tk.Label
    ) -> None:
        cache_key = (kind, index)
        cached = self.grid_thumbnail_cache.get(cache_key)
        if cached is not None:
            tile.configure(image=cached, text="", width=0, height=0)
            tile.image = cached
            return

        def worker() -> None:
            photo = _fetch_thumbnail(candidate["thumb"], size=GRID_TILE_SIZE)
            self.grid_thumbnail_cache[cache_key] = photo
            self.root.after(0, lambda: self._on_grid_thumbnail_ready(kind, index, tile, photo))

        threading.Thread(target=worker, daemon=True).start()

    def _on_grid_thumbnail_ready(
        self, kind: str, index: int, tile: tk.Label, photo: ImageTk.PhotoImage | None
    ) -> None:
        if not tile.winfo_exists() or self.active_artwork_kind != kind:
            return
        if photo is not None:
            tile.configure(image=photo, text="", width=0, height=0)
            tile.image = photo

    def _highlight_selected_tile(self, kind: str) -> None:
        selected = self.artwork_index[kind]
        for index, tile in self.artwork_grid_tiles.items():
            tile.configure(
                highlightbackground=ACCENT_COLOR if index == selected else BORDER_COLOR
            )

    def _select_artwork_tile(self, kind: str, index: int) -> None:
        self.artwork_index[kind] = index
        self._refresh_active_artwork()
        self._highlight_selected_tile(kind)

    def _refresh_active_artwork(self) -> None:
        kind = self.active_artwork_kind
        candidates = self.artwork_candidates.get(kind, [])
        index = self.artwork_index[kind]

        if index >= len(candidates):
            self._set_artwork_thumb(None)
            self.artwork_score_label.configure(text="No artwork")
            return

        candidate = candidates[index]
        cache_key = (kind, index)

        if cache_key in self.thumbnail_cache:
            self._set_artwork_thumb(self.thumbnail_cache[cache_key])
            self.artwork_score_label.configure(
                text=f"Score {candidate['score']} ({index + 1}/{len(candidates)})"
            )
            return

        self._set_artwork_thumb(None, loading=True)
        self.artwork_score_label.configure(text="")

        def worker() -> None:
            photo = _fetch_thumbnail(candidate["thumb"])
            self.thumbnail_cache[cache_key] = photo
            self.root.after(0, lambda: self._on_thumbnail_ready(kind, index, candidate))

        threading.Thread(target=worker, daemon=True).start()

    def _on_thumbnail_ready(self, kind: str, index: int, candidate: dict[str, Any]) -> None:
        if (
            self.active_artwork_kind != kind
            or self.artwork_index.get(kind) != index
            or self.status != "artwork_review"
        ):
            return

        self._set_artwork_thumb(self.thumbnail_cache.get((kind, index)))
        candidates = self.artwork_candidates.get(kind, [])
        self.artwork_score_label.configure(
            text=f"Score {candidate['score']} ({index + 1}/{len(candidates)})"
        )

    def _set_artwork_thumb(
        self, photo: ImageTk.PhotoImage | None, loading: bool = False
    ) -> None:
        label = self.artwork_thumb_label
        if photo is not None:
            label.configure(image=photo, text="", width=0, height=0)
            label.image = photo  # keep a reference alive
        else:
            label.configure(
                image="",
                text="Loading…" if loading else "No preview",
                fg=MUTED_COLOR,
                width=THUMB_SIZE[0] // 8,
                height=THUMB_SIZE[1] // 16,
            )
            label.image = None

    def _on_artwork_confirmed(self) -> None:
        chosen: dict[str, dict[str, Any] | None] = {}
        for kind, candidates in self.artwork_candidates.items():
            index = self.artwork_index[kind]
            chosen[kind] = candidates[index] if index < len(candidates) else None
            if chosen[kind]:
                self._log(f"{ARTWORK_KIND_LABELS[kind]}: selected artwork")
            else:
                self._log(f"{ARTWORK_KIND_LABELS[kind]}: skipped")

        self.run_finalize(chosen)

    # --- stage 4: download chosen assets + write shortcut -------------------

    def run_finalize(self, chosen: dict[str, dict[str, Any] | None]) -> None:
        self.status = "finalizing"
        self._clear_content()
        self._label("Adding to Steam…", FG_COLOR, 14, bold=True)

        parsed = self.parsed
        display_title = self.display_title

        def worker() -> None:
            try:
                if chosen:
                    self.root.after(0, lambda: self._log("Downloading artwork…"))
                downloaded = download_chosen_assets(display_title, chosen)

                self.root.after(0, lambda: self._log("Writing Steam shortcut…"))
                finalize_add_to_steam(
                    display_title,
                    parsed["executable_path"],
                    parsed.get("launch_options"),
                    downloaded.get("icon"),
                    downloaded.get("hero"),
                    downloaded.get("logo"),
                    downloaded.get("grid"),
                )

                if self.force_compat_tool:
                    self.root.after(
                        0, lambda: self._log("Setting compatibility tool override…")
                    )
                    appid = generate_steam_shortcut_appid(
                        parsed["executable_path"], display_title
                    )
                    set_compat_tool_override(
                        get_steam_location(), appid, self.compat_tool_id
                    )

                any_art = any(downloaded.get(k) for k in ("icon", "hero", "logo", "grid"))
                result = {
                    "title": display_title,
                    "matched_steam_title": self.matched_steam_title,
                    "artwork_added": any_art,
                }
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

    # --- terminal states -----------------------------------------------------

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

        self._label(
            "Artwork added" if result["artwork_added"] else "No artwork added",
            MUTED_COLOR,
            10,
        )
        self._label("Restart Steam to see it", MUTED_COLOR, 9)
        self._log(f'Done: "{result["title"]}" added to Steam')
        self.root.after(AUTO_CLOSE_DELAY_MS, self.root.destroy)

    def render_error(self, message: str) -> None:
        self.status = "error"
        self._clear_content()
        self._label("Couldn't add that", ERROR_COLOR, 14, bold=True)
        self._label(message, MUTED_COLOR, 10)
        self._log(f"Error: {message}")
        self.root.after(AUTO_CLOSE_DELAY_MS, self.root.destroy)


def main() -> None:
    root = TkinterDnD.Tk()
    window = QuickAddWindow(root)
    # Allows invoking as `quick_add_steam_shortcut.py <file>` — e.g. from a
    # right-click "Add to Steam" context menu entry — skipping straight past
    # the idle drop screen to processing that file.
    if len(sys.argv) > 1:
        window.handle_file(sys.argv[1])
    root.mainloop()


if __name__ == "__main__":
    main()
