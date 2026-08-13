import { registerEvent } from "../register-event";
import { parseExecutablePath } from "../helpers/parse-executable-path";
import { resolveInstalledUwpApp } from "@main/helpers/list-installed-uwp-apps";
import { listInstalledSteamApps } from "@main/helpers/list-installed-steam-apps";

const resolveDroppedExecutable = async (
  _event: Electron.IpcMainInvokeEvent,
  filePath: string
) => {
  const parsed = parseExecutablePath(filePath);

  if (parsed.launchesViaMicrosoftStore) {
    // The shortcut's own AUMID can be a launcher alias rather than the
    // real, activatable one (see parse-executable-path.ts) -- cross-check
    // by name against Windows' own installed-app list, same as the manual
    // "browse" flow.
    const fileName = filePath.split(/[\\/]/).pop() ?? "";
    const candidateName = fileName.replace(/\.[^/.]+$/, "");
    const resolvedApp = await resolveInstalledUwpApp(candidateName);
    return { kind: "microsoft-store" as const, resolvedApp };
  }

  if (parsed.steamAppId) {
    // Unlike the UWP AUMID, the appid Steam writes into its own shortcut is
    // authoritative -- cross-referencing by id (not name) against the
    // installed-apps scan just fills in the real name/install folder.
    const steamApps = await listInstalledSteamApps();
    const resolvedApp =
      steamApps.find((app) => app.appId === parsed.steamAppId) ?? null;
    return { kind: "steam" as const, resolvedApp };
  }

  return { kind: "plain" as const };
};

registerEvent("resolveDroppedExecutable", resolveDroppedExecutable);
