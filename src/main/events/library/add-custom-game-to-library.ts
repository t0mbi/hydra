import { registerEvent } from "../register-event";
import { gamesSublevel, gamesShopAssetsSublevel, levelKeys } from "@main/level";
import { randomUUID } from "node:crypto";
import type { GameShop } from "@types";
import { GameExecutables } from "@main/services";
import { parseExecutablePath } from "../helpers/parse-executable-path";
import { resolveInstalledUwpAppId } from "@main/helpers/resolve-uwp-app-id";

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
  const launchesViaMicrosoftStore = parsed.launchesViaMicrosoftStore;

  // The shortcut's own AppUserModelID isn't always the real, activatable
  // one -- Xbox App-created shortcuts carry a launcher-specific alias
  // instead (confirmed: ActivateApplication rejects it with E_INVALIDARG).
  // Cross-check against Windows' own installed-app list and prefer that.
  if (launchesViaMicrosoftStore) {
    const resolvedAppId = await resolveInstalledUwpAppId(title);
    if (resolvedAppId) {
      executablePath = resolvedAppId;
    }
  }

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
    launchOptions: null,
    launchesViaMicrosoftStore: launchesViaMicrosoftStore ?? false,
    favorite: false,
    automaticCloudSync: false,
    hasManuallyUpdatedPlaytime: false,
    matchedSteamObjectId: matchedSteamObjectId || null,
    trackingExecutablePaths,
  };

  await gamesSublevel.put(gameKey, game);

  return game;
};

registerEvent("addCustomGameToLibrary", addCustomGameToLibrary);
