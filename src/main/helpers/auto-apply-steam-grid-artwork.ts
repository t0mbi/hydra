import { getGameArtworkCore } from "../events/catalogue/get-game-artwork";
import { updateCustomGameCore } from "./update-custom-game-core";
import { gamesSublevel, levelKeys } from "@main/level";
import { logger } from "@main/services";
import type { ArtworkKind } from "@types";

/**
 * A custom game (Xbox/Steam/Epic picker, or "Is this one of these Steam
 * games?") matched to a real Steam AppID only gets Hydra's own curated
 * ShopAssets by default (get-game-assets.ts) -- often just an icon (and
 * that one blurry, stretched from a small source) and hero, leaving
 * logo/cover blank, since that endpoint isn't SteamGridDB's full
 * per-category library.
 *
 * For custom-shop games, the Customization tab reads icon/logo/hero/cover
 * straight off the game record itself (game.iconUrl, .logoImageUrl,
 * .libraryHeroImageUrl, .customCoverImageUrl) -- NOT the
 * gamesArtworkSelectionSublevel "selection" overlay that non-custom shop
 * games use (see game-assets-settings.tsx's refreshArtworkSelection,
 * which explicitly no-ops that lookup for shop === "custom"). So getting
 * SteamGridDB art onto a matched custom game means fetching it (via
 * get-game-artwork.ts's custom-shop branch, which already knows how to
 * query SteamGridDB using matchedSteamObjectId -- through Hydra's own
 * account-backed proxy when logged in with an active subscription, falling
 * back to a personal SteamGridDB API key) and writing it directly onto
 * those fields through the same updateCustomGame path a manual pick in
 * Customization uses -- not the selection sublevel.
 */
export const autoApplySteamGridArtwork = async (objectId: string) => {
  const shop = "custom" as const;
  const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
  if (!game) return;

  const fetchTop = async (kind: ArtworkKind) => {
    try {
      const page = await getGameArtworkCore(shop, objectId, kind, 0);
      return page?.items[0]?.url ?? null;
    } catch (error) {
      logger.warn(`Failed to fetch ${kind} artwork for matched custom game`, {
        objectId,
        error,
      });
      return null;
    }
  };

  const [iconUrl, logoImageUrl, libraryHeroImageUrl, customCoverImageUrl] =
    await Promise.all([
      fetchTop("icons"),
      fetchTop("logos"),
      fetchTop("heroes"),
      fetchTop("grids"),
    ]);

  if (
    !iconUrl &&
    !logoImageUrl &&
    !libraryHeroImageUrl &&
    !customCoverImageUrl
  ) {
    return;
  }

  await updateCustomGameCore({
    shop,
    objectId,
    title: game.title,
    iconUrl: iconUrl ?? game.iconUrl ?? undefined,
    logoImageUrl: logoImageUrl ?? game.logoImageUrl ?? undefined,
    libraryHeroImageUrl:
      libraryHeroImageUrl ?? game.libraryHeroImageUrl ?? undefined,
    customCoverImageUrl: customCoverImageUrl ?? game.customCoverImageUrl,
  });
};
