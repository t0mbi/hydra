import { shell } from "electron";
import { registerEvent } from "../register-event";
import { gamesSublevel, levelKeys } from "@main/level";
import { GameShop } from "@types";

const openGameExecutablePath = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const game = await gamesSublevel.get(levelKeys.game(shop, objectId));

  // executablePath is an AppUserModelID for these, not a real path -- see
  // parse-executable-path.ts. Nothing to show in a folder.
  if (!game || !game.executablePath || game.launchesViaMicrosoftStore) return;

  shell.showItemInFolder(game.executablePath);
};

registerEvent("openGameExecutablePath", openGameExecutablePath);
