import { registerEvent } from "../register-event";
import { gamesSublevel, gamesShopAssetsSublevel, levelKeys } from "@main/level";
import { randomUUID } from "node:crypto";
import type { GameShop } from "@types";
import { GameExecutables } from "@main/services";
import { parseExecutablePath } from "../helpers/parse-executable-path";
import { resolveInstalledUwpApp } from "@main/helpers/list-installed-uwp-apps";
import { listInstalledSteamApps } from "@main/helpers/list-installed-steam-apps";
import { autoApplySteamGridArtwork } from "@main/helpers/auto-apply-steam-grid-artwork";
import { logger } from "@main/services";

interface CreateCustomGameOptions {
  title: string;
  executablePath: string;
  launchOptions?: string | null;
  launchesViaMicrosoftStore?: boolean;
  uwpInstallLocation?: string | null;
  launchesViaSteamProtocol?: boolean;
  steamProtocolAppId?: string | null;
  steamInstallLocation?: string | null;
  launchesViaEpicProtocol?: boolean;
  epicProtocolAppName?: string | null;
  epicInstallLocation?: string | null;
  iconUrl?: string;
  logoImageUrl?: string;
  libraryHeroImageUrl?: string;
  matchedSteamObjectId?: string | null;
  customCoverImageUrl?: string | null;
}

const createCustomGame = async ({
  title,
  executablePath,
  launchOptions = null,
  launchesViaMicrosoftStore = false,
  uwpInstallLocation = null,
  launchesViaSteamProtocol = false,
  steamProtocolAppId = null,
  steamInstallLocation = null,
  launchesViaEpicProtocol = false,
  epicProtocolAppName = null,
  epicInstallLocation = null,
  iconUrl,
  logoImageUrl,
  libraryHeroImageUrl,
  matchedSteamObjectId,
  customCoverImageUrl,
}: CreateCustomGameOptions) => {
  const objectId = randomUUID();
  const shop: GameShop = "custom";
  const gameKey = levelKeys.game(shop, objectId);

  const existingGames = await gamesSublevel.iterator().all();
  const existingGame = existingGames.find(
    ([_key, game]) => game.executablePath === executablePath && !game.isDeleted
  );

  if (existingGame) {
    throw new Error(
      "A game with this executable path already exists in your library"
    );
  }

  const assets = {
    updatedAt: Date.now(),
    objectId,
    shop,
    title,
    iconUrl: iconUrl || null,
    libraryHeroImageUrl: libraryHeroImageUrl || "",
    libraryImageUrl: iconUrl || "",
    logoImageUrl: logoImageUrl || "",
    logoPosition: null,
    coverImageUrl: customCoverImageUrl || iconUrl || "",
    downloadSources: [],
  };
  await gamesShopAssetsSublevel.put(gameKey, assets);

  // If the user matched this custom game to a real Steam entry, pull in the
  // community-maintained known-executable list for that title so the
  // system-wide process watcher (playtime, achievements, cloud save sync)
  // can still recognize the game even if it's launched through a different
  // wrapper/launcher exe than the one picked here.
  const trackingExecutablePaths = matchedSteamObjectId
    ? (GameExecutables.getExecutablesForGame(matchedSteamObjectId)?.map(
        (executable) => executable.name
      ) ?? null)
    : null;

  const game = {
    title,
    iconUrl: iconUrl || null,
    logoImageUrl: logoImageUrl || null,
    libraryHeroImageUrl: libraryHeroImageUrl || null,
    customCoverImageUrl: customCoverImageUrl || null,
    objectId,
    shop,
    remoteId: null,
    isDeleted: false,
    playTimeInMilliseconds: 0,
    lastTimePlayed: null,
    addedToLibraryAt: new Date(),
    executablePath,
    executablePathUpdatedAt: new Date(),
    launchOptions,
    launchesViaMicrosoftStore,
    uwpInstallLocation,
    launchesViaSteamProtocol,
    steamProtocolAppId,
    steamInstallLocation,
    launchesViaEpicProtocol,
    epicProtocolAppName,
    epicInstallLocation,
    favorite: false,
    automaticCloudSync: false,
    hasManuallyUpdatedPlaytime: false,
    matchedSteamObjectId: matchedSteamObjectId || null,
    trackingExecutablePaths,
  };

  await gamesSublevel.put(gameKey, game);

  if (game.matchedSteamObjectId) {
    // Fire-and-forget: fills in whatever categories Hydra's own curated
    // assets endpoint left blank (usually logo/cover) with the user's
    // SteamGridDB picks, same as opening Customization and picking the
    // first option in each tab. Doesn't block the add response on it.
    autoApplySteamGridArtwork(objectId).catch((error) => {
      logger.error("Failed to auto-apply SteamGridDB artwork", {
        objectId,
        error,
      });
    });
  }

  return game;
};

const addCustomGameToLibrary = async (
  _event: Electron.IpcMainInvokeEvent,
  title: string,
  droppedExecutablePath: string,
  iconUrl?: string,
  logoImageUrl?: string,
  libraryHeroImageUrl?: string,
  matchedSteamObjectId?: string | null,
  customCoverImageUrl?: string | null
) => {
  // Dragging a .lnk shortcut onto Hydra should add the game it points to,
  // not the shortcut file itself -- resolve it here, the same way
  // update-executable-path.ts already does when the path is changed later.
  // For a Microsoft Store/Xbox app shortcut, executablePath ends up being
  // its AppUserModelID (see parse-executable-path.ts) -- a stable,
  // unique-per-app string, so the plain equality check below still works
  // correctly as a duplicate-game check.
  const parsed = parseExecutablePath(droppedExecutablePath);
  let executablePath = parsed.executablePath;
  const launchesViaMicrosoftStore = parsed.launchesViaMicrosoftStore ?? false;
  let uwpInstallLocation: string | null = null;

  // The shortcut's own AppUserModelID isn't always the real, activatable
  // one -- Xbox App-created shortcuts carry a launcher-specific alias
  // instead (confirmed: ActivateApplication rejects it with E_INVALIDARG).
  // Cross-check against Windows' own installed-app list and prefer that,
  // which also gives us the real install folder for free.
  if (launchesViaMicrosoftStore) {
    const resolvedApp = await resolveInstalledUwpApp(title);
    if (resolvedApp) {
      executablePath = resolvedApp.appId;
      uwpInstallLocation = resolvedApp.installLocation;
    }
  }

  // Steam desktop shortcuts point at steam.exe with "-applaunch <appid>"
  // rather than the game's own executable -- spawning that directly would
  // just open/focus the Steam client instead of the game (see
  // parse-executable-path.ts). Route it through the same steam:// protocol
  // launch the "browse installed Steam games" picker uses instead. The
  // appid itself comes straight from Steam's own shortcut, so it's trusted
  // even if the installed-apps scan below doesn't find a manifest match
  // (e.g. an offline library drive) -- that only costs the install folder
  // (and with it, directory-based tracking), not the ability to launch.
  if (parsed.steamAppId) {
    const steamApps = await listInstalledSteamApps();
    const matchedApp = steamApps.find((app) => app.appId === parsed.steamAppId);

    return createCustomGame({
      title: matchedApp?.name ?? title,
      executablePath: `steam:${parsed.steamAppId}`,
      launchesViaSteamProtocol: true,
      steamProtocolAppId: parsed.steamAppId,
      steamInstallLocation: matchedApp?.installLocation ?? null,
      iconUrl,
      logoImageUrl,
      libraryHeroImageUrl,
      matchedSteamObjectId,
      customCoverImageUrl,
    });
  }

  return createCustomGame({
    title,
    executablePath,
    launchOptions: parsed.launchOptions ?? null,
    launchesViaMicrosoftStore,
    uwpInstallLocation,
    iconUrl,
    logoImageUrl,
    libraryHeroImageUrl,
    matchedSteamObjectId,
    customCoverImageUrl,
  });
};

registerEvent("addCustomGameToLibrary", addCustomGameToLibrary);

// For the "browse installed Xbox/Store games" picker (list-installed-uwp-apps.ts)
// -- unlike addCustomGameToLibrary, the caller already has a fully-resolved
// AppUserModelID + install location (from Windows' own installed-app list
// directly, not a possibly-unreliable shortcut), so there's no shortcut to
// parse or AUMID to cross-check here.
const addUwpAppToLibrary = async (
  _event: Electron.IpcMainInvokeEvent,
  title: string,
  appId: string,
  installLocation: string,
  iconUrl?: string,
  logoImageUrl?: string,
  libraryHeroImageUrl?: string,
  matchedSteamObjectId?: string | null,
  customCoverImageUrl?: string | null
) => {
  return createCustomGame({
    title,
    executablePath: appId,
    launchesViaMicrosoftStore: true,
    uwpInstallLocation: installLocation,
    iconUrl,
    logoImageUrl,
    libraryHeroImageUrl,
    matchedSteamObjectId,
    customCoverImageUrl,
  });
};

registerEvent("addUwpAppToLibrary", addUwpAppToLibrary);

// For the "browse installed Steam games" picker (list-installed-steam-apps.ts)
// -- launches via steam://rungameid/<appId>, same as clicking Play in Steam
// itself, instead of running the game's exe directly (see external-launch.ts).
const addSteamAppToLibrary = async (
  _event: Electron.IpcMainInvokeEvent,
  title: string,
  appId: string,
  installLocation: string,
  iconUrl?: string,
  logoImageUrl?: string,
  libraryHeroImageUrl?: string,
  matchedSteamObjectId?: string | null,
  customCoverImageUrl?: string | null
) => {
  return createCustomGame({
    title,
    // Not a real path -- a stable, unique-per-game string, same idea as
    // storing the AUMID directly for Microsoft Store apps (see
    // addUwpAppToLibrary above). Keeps the duplicate-executablePath check
    // above meaningful instead of every Steam game colliding on "".
    executablePath: `steam:${appId}`,
    launchesViaSteamProtocol: true,
    steamProtocolAppId: appId,
    steamInstallLocation: installLocation,
    iconUrl,
    logoImageUrl,
    libraryHeroImageUrl,
    matchedSteamObjectId,
    customCoverImageUrl,
  });
};

registerEvent("addSteamAppToLibrary", addSteamAppToLibrary);

// For the "browse installed Epic Games" picker (list-installed-epic-apps.ts)
// -- launches via com.epicgames.launcher://apps/<AppName>, same as clicking
// Play in the Epic Games Launcher, instead of running the exe directly (see
// external-launch.ts).
const addEpicAppToLibrary = async (
  _event: Electron.IpcMainInvokeEvent,
  title: string,
  appName: string,
  installLocation: string,
  iconUrl?: string,
  logoImageUrl?: string,
  libraryHeroImageUrl?: string,
  matchedSteamObjectId?: string | null,
  customCoverImageUrl?: string | null
) => {
  return createCustomGame({
    title,
    // Not a real path -- same reasoning as addSteamAppToLibrary above.
    executablePath: `epic:${appName}`,
    launchesViaEpicProtocol: true,
    epicProtocolAppName: appName,
    epicInstallLocation: installLocation,
    iconUrl,
    logoImageUrl,
    libraryHeroImageUrl,
    matchedSteamObjectId,
    customCoverImageUrl,
  });
};

registerEvent("addEpicAppToLibrary", addEpicAppToLibrary);
