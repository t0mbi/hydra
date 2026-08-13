import { registerEvent } from "../register-event";
import { listInstalledSteamApps as listInstalledSteamAppsHelper } from "@main/helpers/list-installed-steam-apps";

const listInstalledSteamApps = async (
  _event: Electron.IpcMainInvokeEvent,
  forceRefresh?: boolean
) => {
  return listInstalledSteamAppsHelper(forceRefresh);
};

registerEvent("listInstalledSteamApps", listInstalledSteamApps);
