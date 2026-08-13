import fs from "node:fs";
import path from "node:path";
import { logger } from "@main/services";
import type { InstalledEpicApp } from "@types";

const CACHE_TTL_MS = 10_000;
let cache: { apps: InstalledEpicApp[]; fetchedAt: number } | null = null;

const MANIFESTS_DIR = String.raw`C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests`;

interface EpicManifest {
  DisplayName?: string;
  InstallLocation?: string;
  AppName?: string;
  bIsIncompleteInstall?: boolean;
}

const readManifest = async (
  fileName: string
): Promise<InstalledEpicApp | null> => {
  const content = await fs.promises
    .readFile(path.join(MANIFESTS_DIR, fileName), "utf8")
    .catch(() => null);
  if (!content) return null;

  let manifest: EpicManifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    return null;
  }

  if (
    manifest.bIsIncompleteInstall ||
    !manifest.AppName ||
    !manifest.DisplayName ||
    !manifest.InstallLocation
  ) {
    return null;
  }

  return {
    appName: manifest.AppName,
    name: manifest.DisplayName,
    installLocation: manifest.InstallLocation,
  };
};

/**
 * Every locally installed Epic Games title, read from the Epic Games
 * Launcher's own .item manifest files -- the same source Epic's launcher
 * itself uses to know what's installed. There's no registry lookup like
 * Steam's install path (Epic always installs its ProgramData manifests
 * folder at a fixed path), so this reads it directly.
 */
export const listInstalledEpicApps = async (
  forceRefresh = false
): Promise<InstalledEpicApp[]> => {
  if (process.platform !== "win32") return [];

  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.apps;
  }

  try {
    const entries = await fs.promises
      .readdir(MANIFESTS_DIR)
      .catch(() => [] as string[]);

    const itemFiles = entries.filter((entry) => entry.endsWith(".item"));

    const apps: InstalledEpicApp[] = [];
    for (const fileName of itemFiles) {
      const app = await readManifest(fileName);
      if (app) apps.push(app);
    }

    cache = { apps, fetchedAt: Date.now() };
    return apps;
  } catch (error) {
    logger.warn("Failed to enumerate installed Epic Games apps", { error });
    return cache?.apps ?? [];
  }
};
