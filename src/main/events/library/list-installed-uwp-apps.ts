import { registerEvent } from "../register-event";
import { listInstalledUwpApps as listInstalledUwpAppsHelper } from "@main/helpers/list-installed-uwp-apps";

const listInstalledUwpApps = async (
  _event: Electron.IpcMainInvokeEvent,
  forceRefresh?: boolean
) => {
  return listInstalledUwpAppsHelper(forceRefresh);
};

registerEvent("listInstalledUwpApps", listInstalledUwpApps);
