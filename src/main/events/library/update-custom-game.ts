import { registerEvent } from "../register-event";
import {
  updateCustomGameCore,
  type UpdateCustomGameParams,
} from "@main/helpers/update-custom-game-core";
import { autoApplySteamGridArtwork } from "@main/helpers/auto-apply-steam-grid-artwork";
import { logger } from "@main/services";

const updateCustomGame = async (
  _event: Electron.IpcMainInvokeEvent,
  params: UpdateCustomGameParams
) => {
  const updatedGame = await updateCustomGameCore(params);

  if (params.matchedSteamObjectId) {
    // A user re-picking the same (or a new) Steam match from the General
    // section's rename flow is also the natural way to backfill artwork on
    // an older game added before this existed, or one added while
    // SteamGridDB access wasn't available -- fire-and-forget, doesn't
    // block the update response on it.
    autoApplySteamGridArtwork(params.objectId).catch((error) => {
      logger.error("Failed to auto-apply SteamGridDB artwork", {
        objectId: params.objectId,
        error,
      });
    });
  }

  return updatedGame;
};

registerEvent("updateCustomGame", updateCustomGame);
