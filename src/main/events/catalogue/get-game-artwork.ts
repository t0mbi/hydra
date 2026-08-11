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

const getGameArtwork = async (
  _event: Electron.IpcMainInvokeEvent,
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
    // Custom games have no real catalogue entry for Hydra's proxy to look up,
    // so only the personal SteamGridDB key (searched by title) can serve them.
    if (!apiKey) return null;

    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    if (!game) return null;

    // A custom game matched to a real Steam entry (see
    // addCustomGameToLibrary) can be looked up by that AppID directly,
    // which is far more reliable than a name search.
    if (game.matchedSteamObjectId) {
      return SteamGridDbDirectClient.fetchArtworkDirect(
        apiKey,
        "steam",
        game.matchedSteamObjectId,
        kind,
        page,
        game.title
      );
    }

    return SteamGridDbDirectClient.fetchArtworkDirect(
      apiKey,
      shop,
      objectId,
      kind,
      page,
      game.title
    );
  }

  try {
    const proxyPage = await fetchGameArtwork(shop, objectId, kind, page);

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

      logger.error("Failed to fetch game artwork", { shop, objectId, kind });
      throw error;
    }
    // Proxy unavailable (not logged in, no subscription, or a request
    // error) — fall through to the user's personal SteamGridDB key below.
  }

  const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
  if (!game) return null;

  return SteamGridDbDirectClient.fetchArtworkDirect(
    apiKey,
    shop,
    objectId,
    kind,
    page,
    game.title
  );
};

registerEvent("getGameArtwork", getGameArtwork);
