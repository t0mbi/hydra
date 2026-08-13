import { registerEvent } from "../register-event";
import { listInstalledEpicApps as listInstalledEpicAppsHelper } from "@main/helpers/list-installed-epic-apps";

const listInstalledEpicApps = async (
  _event: Electron.IpcMainInvokeEvent,
  forceRefresh?: boolean
) => {
  return listInstalledEpicAppsHelper(forceRefresh);
};

registerEvent("listInstalledEpicApps", listInstalledEpicApps);
