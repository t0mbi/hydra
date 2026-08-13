import { registerEvent } from "../register-event";
import {
  fetchGameArtwork,
  logger,
  SteamGridDbDirectClient,
} from "@main/services";
import { SubscriptionRequiredError, UserNotLoggedInError } from "@shared";
import { db, gamesSublevel, levelKeys } from "@main/level";
import type {
  ArtworkKind,
  ArtworkPage,
  GameShop,
  UserPreferences,
} from "@types";

// Tries Hydra's own account-backed proxy (needs to be logged in, and the
// backend gates it behind an active subscription) for a real catalogue
// (shop, objectId) pair first, falling back to the user's personal
// SteamGridDB API key -- shared by the direct non-custom lookup below and
// the custom-but-matched-to-Steam case, which has a real catalogue pair
// available via matchedSteamObjectId even though its own (shop, objectId)
// doesn't.
const fetchWithProxyFallback = async (
  proxyShop: GameShop,
  proxyObjectId: string,
  kind: ArtworkKind,
  page: number,
  apiKey: string | null | undefined,
  directShop: GameShop,
  directObjectId: string,
  getDirectTitle: () => Promise<string | null>
): Promise<ArtworkPage | null> => {
  try {
    const proxyPage = await fetchGameArtwork(
      proxyShop,
      proxyObjectId,
      kind,
      page
    );

    if (proxyPage.items.length > 0 || page > 0 || !apiKey) {
      return proxyPage;
    }
    // Proxy succeeded but returned nothing on page 0 — fall through to the
    // user's personal SteamGridDB key below.
  } catch (error) {
    if (!apiKey) {
      if (
        error instanceof UserNotLoggedInError ||
        error instanceof SubscriptionRequiredError
      ) {
        return null;
      }

      logger.error("Failed to fetch game artwork", {
        shop: proxyShop,
        objectId: proxyObjectId,
        kind,
      });
      throw error;
    }
    // Proxy unavailable (not logged in, no subscription, or a request
    // error) — fall through to the user's personal SteamGridDB key below.
  }

  if (!apiKey) return null;

  const title = await getDirectTitle();
  if (!title) return null;

  return SteamGridDbDirectClient.fetchArtworkDirect(
    apiKey,
    directShop,
    directObjectId,
    kind,
    page,
    title
  );
};

export const getGameArtworkCore = async (
  shop: GameShop,
  objectId: string,
  kind: ArtworkKind,
  page = 0
): Promise<ArtworkPage | null> => {
  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    { valueEncoding: "json" }
  );
  const apiKey = userPreferences?.steamGridDbApiKey;

  if (shop === "custom") {
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    if (!game) return null;

    // A custom game matched to a real Steam entry (see
    // addCustomGameToLibrary) has a genuine catalogue pair available after
    // all -- try Hydra's own proxy under that Steam AppID first (same as
    // any other Steam game, same login/subscription gating), instead of
    // requiring a personal SteamGridDB key just because the game itself
    // lives under shop "custom".
    if (game.matchedSteamObjectId) {
      return fetchWithProxyFallback(
        "steam",
        game.matchedSteamObjectId,
        kind,
        page,
        apiKey,
        "steam",
        game.matchedSteamObjectId,
        async () => game.title
      );
    }

    // No real catalogue entry to look up -- only the personal SteamGridDB
    // key (searched by title) can serve these.
    if (!apiKey) return null;

    return SteamGridDbDirectClient.fetchArtworkDirect(
      apiKey,
      shop,
      objectId,
      kind,
      page,
      game.title
    );
  }

  return fetchWithProxyFallback(
    shop,
    objectId,
    kind,
    page,
    apiKey,
    shop,
    objectId,
    async () =>
      (await gamesSublevel.get(levelKeys.game(shop, objectId)))?.title ?? null
  );
};

const getGameArtwork = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  kind: ArtworkKind,
  page = 0
) => getGameArtworkCore(shop, objectId, kind, page);

registerEvent("getGameArtwork", getGameArtwork);
