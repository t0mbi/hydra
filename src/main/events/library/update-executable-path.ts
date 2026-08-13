import { registerEvent } from "../register-event";
import { parseExecutablePath } from "../helpers/parse-executable-path";
import { getDirectorySize } from "../helpers/get-directory-size";
import { findGameRootFromExe } from "../helpers/find-game-root";
import { gamesSublevel, levelKeys } from "@main/level";
import {
  updateGameExecutablePath,
  updateGameTrackingExecutablePaths,
} from "@main/helpers/update-executable-path";
import { logger, WindowManager } from "@main/services";
import { runAutomaticCloudSaveSync } from "@main/services/cloud-save";
import { resolveInstalledUwpApp } from "@main/helpers/list-installed-uwp-apps";
import type { GameShop } from "@types";

const updateExecutablePath = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  executablePath: string | null
) => {
  const parsed = executablePath ? parseExecutablePath(executablePath) : null;
  let parsedPath = parsed?.executablePath ?? null;
  const launchesViaMicrosoftStore = parsed?.launchesViaMicrosoftStore ?? false;
  let uwpInstallLocation: string | null = null;

  const gameKey = levelKeys.game(shop, objectId);

  const game = await gamesSublevel.get(gameKey);
  if (!game) return;

  // See add-custom-game-to-library.ts -- the shortcut's own AppUserModelID
  // isn't always the real, activatable one.
  if (launchesViaMicrosoftStore) {
    const resolvedApp = await resolveInstalledUwpApp(game.title);
    if (resolvedApp) {
      parsedPath = resolvedApp.appId;
      uwpInstallLocation = resolvedApp.installLocation;
    }
  }

  const environmentChanged =
    parsedPath !== null && game.executablePath !== parsedPath;

  // Update immediately without size so UI responds fast
  await gamesSublevel.put(gameKey, {
    ...updateGameExecutablePath(game, parsedPath),
    installedSizeInBytes: parsedPath ? game.installedSizeInBytes : null,
    automaticCloudSync:
      executablePath === null ? false : game.automaticCloudSync,
    launchesViaMicrosoftStore,
    uwpInstallLocation,
  });

  if (environmentChanged) {
    void runAutomaticCloudSaveSync(objectId, shop, "environment-changed");
  }

  // Unlike most other library-mutating handlers (update-game-custom-assets.ts,
  // scan-installed-games.ts, etc.), this one never told other open windows
  // the game record changed -- a renderer that wasn't the one making this
  // call (or wasn't separately doing its own local refresh afterwards, the
  // way game-options-modal.tsx's change-executable-path flow does) kept
  // showing the stale pre-link game state (e.g. the game page still showing
  // "Download" after successfully linking an executable from the downloads
  // page's "Already installed?" button, which doesn't do that local
  // refresh) until something else happened to trigger a refetch.
  WindowManager.sendToAppWindows("on-library-batch-complete");

  // Calculate size in background and update later. For Microsoft Store
  // games, parsedPath is an AppUserModelID, not a real path, so measure
  // uwpInstallLocation (the real folder) directly instead of trying to
  // derive a game root from the (non-existent) executable path.
  if (launchesViaMicrosoftStore && uwpInstallLocation) {
    getDirectorySize(uwpInstallLocation)
      .then(async (installedSizeInBytes) => {
        const currentGame = await gamesSublevel.get(gameKey);
        if (!currentGame) return;

        await gamesSublevel.put(gameKey, {
          ...currentGame,
          installedSizeInBytes,
        });
      })
      .catch((err) => {
        logger.error(`Failed to calculate UWP app size: ${err}`);
      });
  } else if (parsedPath && !launchesViaMicrosoftStore) {
    findGameRootFromExe(parsedPath)
      .then(async (gameRoot) => {
        if (!gameRoot) {
          logger.warn(`Could not determine game root for: ${parsedPath}`);
          return;
        }

        logger.log(`Game root detected: ${gameRoot} (exe: ${parsedPath})`);

        const installedSizeInBytes = await getDirectorySize(gameRoot);

        const currentGame = await gamesSublevel.get(gameKey);
        if (!currentGame) return;

        await gamesSublevel.put(gameKey, {
          ...currentGame,
          installedSizeInBytes,
        });
      })
      .catch((err) => {
        logger.error(`Failed to calculate game size: ${err}`);
      });
  }
};

registerEvent("updateExecutablePath", updateExecutablePath);

const updateTrackingExecutablePaths = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  trackingExecutablePaths: string[]
) => {
  const parsedPaths = trackingExecutablePaths.map(
    (trackingExecutablePath) =>
      parseExecutablePath(trackingExecutablePath).executablePath
  );

  const gameKey = levelKeys.game(shop, objectId);

  const game = await gamesSublevel.get(gameKey);
  if (!game) return;

  await gamesSublevel.put(
    gameKey,
    updateGameTrackingExecutablePaths(game, parsedPaths)
  );

  WindowManager.sendToAppWindows("on-library-batch-complete");
};

registerEvent("updateTrackingExecutablePaths", updateTrackingExecutablePaths);
