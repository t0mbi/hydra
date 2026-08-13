import fs from "node:fs";
import path from "node:path";
import { getSteamLibraryFolders } from "@main/services/steam";
import { logger } from "@main/services";
import type { InstalledSteamApp } from "@types";

const CACHE_TTL_MS = 10_000;
let cache: { apps: InstalledSteamApp[]; fetchedAt: number } | null = null;

const readAcfField = (content: string, field: string): string | null =>
  content.match(new RegExp(`"${field}"\\s*"([^"]*)"`, "i"))?.[1] ?? null;

const readManifest = async (
  steamappsPath: string,
  fileName: string
): Promise<InstalledSteamApp | null> => {
  const content = await fs.promises
    .readFile(path.join(steamappsPath, fileName), "utf8")
    .catch(() => null);
  if (!content) return null;

  const appId = readAcfField(content, "appid");
  const name = readAcfField(content, "name");
  const installDir = readAcfField(content, "installdir");
  if (!appId || !name || !installDir) return null;

  return {
    appId,
    name,
    installLocation: path.join(steamappsPath, "common", installDir),
  };
};

/**
 * Every locally installed Steam game, read straight from each Steam
 * library's appmanifest_*.acf files (libraryfolders.vdf is already parsed
 * by getSteamLibraryFolders, reused from the "Add to Steam"/scan-installed
 * feature). Unlike scan-installed-games.ts, this isn't limited to games
 * already known to Hydra's own catalogue -- it's a plain listing of
 * whatever Steam itself has installed, for the "browse installed Steam
 * games" custom-game picker.
 */
export const listInstalledSteamApps = async (
  forceRefresh = false
): Promise<InstalledSteamApp[]> => {
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.apps;
  }

  try {
    const libraryFolders = await getSteamLibraryFolders();
    const apps: InstalledSteamApp[] = [];

    for (const libraryFolder of libraryFolders) {
      const steamappsPath = path.join(libraryFolder, "steamapps");
      const entries = await fs.promises
        .readdir(steamappsPath)
        .catch(() => [] as string[]);

      const manifestFiles = entries.filter(
        (entry) => entry.startsWith("appmanifest_") && entry.endsWith(".acf")
      );

      for (const fileName of manifestFiles) {
        const app = await readManifest(steamappsPath, fileName);
        if (app) apps.push(app);
      }
    }

    cache = { apps, fetchedAt: Date.now() };
    return apps;
  } catch (error) {
    logger.warn("Failed to enumerate installed Steam apps", { error });
    return cache?.apps ?? [];
  }
};
