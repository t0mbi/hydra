import { shell } from "electron";
import fs from "node:fs";

export interface ParsedExecutable {
  executablePath: string;
  launchOptions?: string;
  launchesViaMicrosoftStore?: boolean;
  // Set when the shortcut is a Steam desktop shortcut (target is steam.exe,
  // args are "-applaunch <appid>") -- see resolve-dropped-executable.ts /
  // add-custom-game-to-library.ts, which cross-reference this against the
  // installed-Steam-apps list and route the game through
  // launchesViaSteamProtocol instead of spawning steam.exe with no
  // arguments (which would just open the Steam client, not the game, and
  // make process-watcher think the game is "running" for as long as Steam
  // itself is open).
  steamAppId?: string;
}

const STEAM_APPLAUNCH_PATTERN = /(?:^|\s)-applaunch\s+(\d+)/i;
const STEAM_RUNGAMEID_PATTERN = /steam:\/\/rungameid\/(\d+)/i;
const STEAM_URL_SHORTCUT_PATTERN = /^\s*URL\s*=\s*steam:\/\/rungameid\/(\d+)/im;
const DESKTOP_ENTRY_EXEC_PATTERN = /^\s*Exec\s*=\s*(.+)$/im;

// Newer Steam versions write "Desktop shortcut" as a plain .url (Internet
// Shortcut) text file pointing at steam://rungameid/<appid> instead of a
// .lnk -- no COM shell-link API needed, it's just an INI-style text file.
const parseSteamUrlShortcut = (filePath: string): string | null => {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return STEAM_URL_SHORTCUT_PATTERN.exec(content)?.[1] ?? null;
  } catch {
    return null;
  }
};

// Linux's equivalent of a Windows .lnk/.url Steam shortcut -- a
// freedesktop .desktop entry whose Exec= line either invokes the
// steam://rungameid/<appid> URI directly (steam steam://rungameid/220,
// xdg-open steam://rungameid/220, etc.) or, less commonly, uses the same
// -applaunch <appid> convention Windows shortcuts use.
const parseSteamDesktopEntry = (filePath: string): string | null => {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const execLine = DESKTOP_ENTRY_EXEC_PATTERN.exec(content)?.[1];
    if (!execLine) return null;

    return (
      STEAM_RUNGAMEID_PATTERN.exec(execLine)?.[1] ??
      STEAM_APPLAUNCH_PATTERN.exec(execLine)?.[1] ??
      null
    );
  } catch {
    return null;
  }
};

export const parseExecutablePath = (filePath: string): ParsedExecutable => {
  if (process.platform === "win32" && filePath.toLowerCase().endsWith(".url")) {
    const steamAppId = parseSteamUrlShortcut(filePath);

    // Unlike the .lnk branch below, there's no real exe/args to resolve
    // here at all -- just a protocol URI -- so this is Steam-only
    // detection, not a general shortcut resolver.
    if (steamAppId) {
      return { executablePath: filePath, steamAppId };
    }

    return { executablePath: filePath };
  }

  if (process.platform === "linux" && filePath.endsWith(".desktop")) {
    const steamAppId = parseSteamDesktopEntry(filePath);

    // Same reasoning as the .url branch above -- no real exe/args to
    // resolve here, just a protocol URI (or -applaunch invocation) inside
    // the .desktop entry's Exec= line.
    if (steamAppId) {
      return { executablePath: filePath, steamAppId };
    }

    return { executablePath: filePath };
  }

  if (process.platform === "win32" && filePath.endsWith(".lnk")) {
    const { target, args, appUserModelId } = shell.readShortcutLink(filePath);

    // Microsoft Store / Xbox app shortcuts don't carry a normal target --
    // Windows identifies them only by an AppUserModelID. executablePath
    // stores that AUMID directly (it's a stable, unique-per-app string);
    // launching it goes through NativeAddon.activateUwpApp (see
    // launch-game.ts), which uses the same IApplicationActivationManager
    // COM API Explorer itself uses for these shortcuts, and returns the
    // real launched process ID for tracking -- not a spawned process, so
    // there's no meaningful launchOptions here.
    if (!target && appUserModelId) {
      return {
        executablePath: appUserModelId,
        launchesViaMicrosoftStore: true,
      };
    }

    const steamAppLaunchMatch = STEAM_APPLAUNCH_PATTERN.exec(args ?? "");
    if (target && /steam\.exe$/i.test(target) && steamAppLaunchMatch) {
      return {
        executablePath: target,
        launchOptions: args || undefined,
        steamAppId: steamAppLaunchMatch[1],
      };
    }

    return { executablePath: target, launchOptions: args || undefined };
  }

  return { executablePath: filePath };
};
