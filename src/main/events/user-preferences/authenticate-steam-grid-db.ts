import { SteamGridDbDirectClient } from "@main/services";
import { registerEvent } from "../register-event";

const authenticateSteamGridDb = async (
  _event: Electron.IpcMainInvokeEvent,
  apiKey: string
) => {
  return SteamGridDbDirectClient.validateApiKey(apiKey);
};

registerEvent("authenticateSteamGridDb", authenticateSteamGridDb);
