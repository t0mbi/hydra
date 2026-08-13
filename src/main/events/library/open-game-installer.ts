import { shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

import { getDownloadsPath } from "../helpers/get-downloads-path";
import { updateGameExecutablePath } from "@main/helpers/update-executable-path";
import {
  rankExecutableCandidates,
  type KnownGameExecutable,
} from "@main/helpers/game-executable-ranking";
import { detectDirectRipExecutable } from "@main/helpers/detect-direct-rip-executable";
import { collectAccessibleFilePaths } from "@main/helpers/collect-accessible-file-paths";
import { registerEvent } from "../register-event";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { GameShop, UserPreferences } from "@types";
import {
  GameExecutables,
  logger,
  Umu,
  WindowManager,
  Wine,
  runAutomaticCloudSaveSync,
} from "@main/services";

// After an installer-based repack finishes installing, nothing else in the
// app ever re-checks for the resulting executable -- the only auto-detection
// pass runs once, right after extraction, before the installer has placed
// any files. This scans the plausible install destinations once the
// installer process actually exits, so the game is recognized as installed
// without the user having to set the executable path manually.
const findGameExecutableResilient = async (
  folderPath: string,
  executables: KnownGameExecutable[]
): Promise<string | null> => {
  if (executables.length === 0) return null;

  const relativeFilePaths = await collectAccessibleFilePaths(folderPath);
  const match = rankExecutableCandidates(relativeFilePaths, executables);

  return match ? path.join(folderPath, match) : null;
};

const rescanAndBindExecutableAfterInstall = async (
  shop: GameShop,
  objectId: string,
  downloadFolderPath: string,
  winePrefixPath?: string | null
): Promise<string | null> => {
  try {
    const gameKey = levelKeys.game(shop, objectId);
    const game = await gamesSublevel.get(gameKey);

    if (!game || game.executablePath) return null;

    const executables = GameExecutables.getExecutablesForGame(objectId);
    if (!executables || executables.length === 0) {
      logger.info(
        `[openGameInstaller] Installer exited for ${objectId}, but no known executables to search for -- skipping rescan`
      );
      return null;
    }

    logger.info(
      `[openGameInstaller] Installer exited for ${objectId}, scanning for executable`
    );

    const candidateFolders = [downloadFolderPath];

    // The user's own game library folder (Settings > General), separate
    // from downloadsPath -- e.g. a game installed via a repack's own
    // installer to D:\Games\... instead of landing under the downloads
    // folder Hydra manages. findGameExecutableResilient below already
    // walks a candidate folder recursively looking for a filename match
    // from the catalogue's known executables, same as it does for
    // ProgramFiles below, so this doesn't need its own separate
    // title-matching logic.
    const userPreferences = await db
      .get<string, UserPreferences | null>(levelKeys.userPreferences, {
        valueEncoding: "json",
      })
      .catch(() => null);

    if (userPreferences?.installPath) {
      candidateFolders.push(userPreferences.installPath);
    }

    if (process.platform === "linux" && winePrefixPath) {
      candidateFolders.push(path.join(winePrefixPath, "drive_c"));
    }

    if (process.platform === "win32") {
      candidateFolders.push(
        ...[
          process.env["ProgramFiles"],
          process.env["ProgramFiles(x86)"],
          process.env["LOCALAPPDATA"]
            ? path.join(process.env["LOCALAPPDATA"], "Programs")
            : undefined,
        ].filter((candidate): candidate is string => Boolean(candidate))
      );
    }

    for (const candidateFolder of candidateFolders) {
      if (!fs.existsSync(candidateFolder)) continue;

      const foundExePath = await findGameExecutableResilient(
        candidateFolder,
        executables
      );

      if (!foundExePath) continue;

      // Re-check under the lock of "hasn't been set since we started" --
      // the user may have set it manually while the installer was running.
      const latestGame = await gamesSublevel.get(gameKey);
      if (!latestGame || latestGame.executablePath) return null;

      logger.info(
        `[openGameInstaller] Auto-detected executable after installer exit for ${objectId}: ${foundExePath}`
      );

      await gamesSublevel.put(gameKey, {
        ...updateGameExecutablePath(latestGame, foundExePath),
      });

      void runAutomaticCloudSaveSync(objectId, shop, "environment-changed");
      WindowManager.sendToAppWindows("on-library-batch-complete");
      return foundExePath;
    }

    logger.info(
      `[openGameInstaller] Scanned ${candidateFolders.length} candidate folder(s) for ${objectId}, no matching executable found`
    );
    return null;
  } catch (error) {
    logger.error(
      `[openGameInstaller] Error scanning for executable after install: ${objectId}`,
      error
    );
    return null;
  }
};

const launchInstallerWithWine = async (
  filePath: string,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("wine", [filePath], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });

    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });

    child.once("exit", (code, signal) => {
      onExit?.(code, signal);
    });

    child.once("error", (error) => {
      logger.error("Failed to execute game installer with wine", error);
      resolve(false);
    });
  });
};

const launchInstallerDirectly = async (
  filePath: string,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(filePath, [], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });

    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });

    child.once("exit", (code, signal) => {
      onExit?.(code, signal);
    });

    child.once("error", (error) => {
      logger.error("Failed to execute game installer directly", error);
      resolve(false);
    });
  });
};

const openPathAndCheck = async (filePath: string): Promise<boolean> => {
  const openError = await shell.openPath(filePath);
  return openError.length === 0;
};

const executeGameInstaller = async (
  filePath: string,
  options?: {
    gameId?: string;
    winePrefixPath?: string | null;
    protonPath?: string | null;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  }
) => {
  if (process.platform === "win32") {
    const launchedDirectly = await launchInstallerDirectly(
      filePath,
      options?.onExit
    );
    if (launchedDirectly) {
      return true;
    }

    return await openPathAndCheck(filePath);
  }

  if (process.platform === "linux") {
    try {
      await Umu.launchExecutable(filePath, [], {
        gameId: options?.gameId,
        winePrefixPath: options?.winePrefixPath,
        protonPath: options?.protonPath,
        onExit: options?.onExit,
      });
      return true;
    } catch (error) {
      logger.error("Failed to execute game installer with umu-run", error);

      const launchedWithWine = await launchInstallerWithWine(
        filePath,
        options?.onExit
      );
      if (launchedWithWine) {
        return true;
      }

      return await openPathAndCheck(filePath);
    }
  }

  return await openPathAndCheck(filePath);
};

const openGameInstaller = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);
  const game = await gamesSublevel.get(downloadKey).catch(() => null);
  const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );

  if (!download?.folderName) return true;

  const gamePath = path.join(
    download.downloadPath ?? (await getDownloadsPath()),
    download.folderName
  );

  if (!fs.existsSync(gamePath)) {
    return true;
  }

  if (process.platform === "darwin") {
    shell.openPath(gamePath);
    return true;
  }

  if (fs.lstatSync(gamePath).isFile()) {
    shell.showItemInFolder(gamePath);
    return true;
  }

  const onInstallerExit = () => {
    void rescanAndBindExecutableAfterInstall(
      shop,
      objectId,
      gamePath,
      effectiveWinePrefixPath
    );
  };

  const setupPath = path.join(gamePath, "setup.exe");
  if (fs.existsSync(setupPath)) {
    return await executeGameInstaller(setupPath, {
      gameId: objectId,
      winePrefixPath: effectiveWinePrefixPath,
      protonPath: game?.protonPath,
      onExit: onInstallerExit,
    });
  }

  const directRipExecutable = await detectDirectRipExecutable(gamePath);

  if (directRipExecutable) {
    return await executeGameInstaller(directRipExecutable, {
      gameId: objectId,
      winePrefixPath: effectiveWinePrefixPath,
      protonPath: game?.protonPath,
      onExit: onInstallerExit,
    });
  }

  shell.openPath(gamePath);
  return true;
};

// On-demand version of rescanAndBindExecutableAfterInstall, for when a user
// installed the game themselves (outside Hydra's own installer flow) and
// wants to tell Hydra "this is already installed" without knowing the exact
// executable path.
const rescanGameExecutable = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<string | null> => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);
  const game = await gamesSublevel.get(downloadKey).catch(() => null);

  if (!download?.folderName) return null;

  const gamePath = path.join(
    download.downloadPath ?? (await getDownloadsPath()),
    download.folderName
  );

  const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );

  return rescanAndBindExecutableAfterInstall(
    shop,
    objectId,
    gamePath,
    effectiveWinePrefixPath
  );
};

registerEvent("openGameInstaller", openGameInstaller);
registerEvent("rescanGameExecutable", rescanGameExecutable);
