import { shell } from "electron";
import { registerEvent } from "../register-event";
import { gamesSublevel, levelKeys } from "@main/level";
import { GameShop } from "@types";
import { getExternalLaunchInfo } from "@main/helpers/external-launch";

const openGameExecutablePath = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const game = await gamesSublevel.get(levelKeys.game(shop, objectId));

  if (!game) return;

  // executablePath (or the provider-specific target) isn't a real path for
  // these -- see external-launch.ts. Open the real install folder directly
  // (there's no single "main exe" file within it to select, so
  // showItemInFolder's file-selection behavior doesn't apply here).
  const externalLaunchInfo = getExternalLaunchInfo(game);
  if (externalLaunchInfo) {
    if (externalLaunchInfo.installLocation) {
      shell.openPath(externalLaunchInfo.installLocation);
    }
    return;
  }

  if (!game.executablePath) return;

  shell.showItemInFolder(game.executablePath);
};

registerEvent("openGameExecutablePath", openGameExecutablePath);
