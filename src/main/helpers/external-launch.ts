import type { Game } from "@types";

export type ExternalLaunchProvider = "microsoft-store" | "steam" | "epic";

export interface ExternalLaunchInfo {
  provider: ExternalLaunchProvider;
  // What actually gets handed to the launch call: an AppUserModelID for
  // Microsoft Store apps, a Steam appid, or an Epic AppName.
  target: string;
  installLocation: string | null;
}

/**
 * Single place that knows how a game added via one of the "browse
 * installed X games" pickers (Xbox/Steam/Epic) should launch -- none of
 * these have a conventional executablePath to spawn, so launch-game.ts,
 * process-watcher.ts, close-game.ts, open-game-executable-path.ts, and
 * create-steam-shortcut.ts all branch on this instead of repeating the
 * same three provider checks.
 */
export const getExternalLaunchInfo = (
  game: Game
): ExternalLaunchInfo | null => {
  if (game.launchesViaMicrosoftStore && game.executablePath) {
    return {
      provider: "microsoft-store",
      target: game.executablePath,
      installLocation: game.uwpInstallLocation ?? null,
    };
  }

  if (game.launchesViaSteamProtocol && game.steamProtocolAppId) {
    return {
      provider: "steam",
      target: game.steamProtocolAppId,
      installLocation: game.steamInstallLocation ?? null,
    };
  }

  if (game.launchesViaEpicProtocol && game.epicProtocolAppName) {
    return {
      provider: "epic",
      target: game.epicProtocolAppName,
      installLocation: game.epicInstallLocation ?? null,
    };
  }

  return null;
};
