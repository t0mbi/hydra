import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@main/services";

const execFileAsync = promisify(execFile);

interface StartApp {
  Name: string;
  AppID: string;
}

const normalize = (value: string) => value.toLowerCase().trim();

/**
 * A .lnk shortcut's own AppUserModelID property isn't always the real,
 * activatable one -- Xbox App-created shortcuts for Game Pass titles carry
 * a launcher-specific alias instead (confirmed against a real shortcut:
 * "XboxGames.Microsoft.<id>_AppFoo" was rejected by ActivateApplication
 * with E_INVALIDARG, while the actual registered AUMID from `Get-StartApps`
 * -- "Microsoft.<id>_8wekyb3d8bbwe!AppFoo" -- launches correctly). This
 * cross-references the shortcut's display name against Windows' own
 * authoritative installed-app list to find the real one, since that's
 * exactly what `Get-StartApps` (and the Start Menu search) uses.
 */
export const resolveInstalledUwpAppId = async (
  candidateName: string
): Promise<string | null> => {
  if (process.platform !== "win32") return null;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-StartApps | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 15000 }
    );

    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    const apps: StartApp[] = Array.isArray(parsed)
      ? parsed
      : [parsed as StartApp];

    const target = normalize(candidateName);

    const exact = apps.find((app) => normalize(app.Name) === target);
    if (exact) return exact.AppID;

    const partial = apps.find(
      (app) =>
        normalize(app.Name).includes(target) ||
        target.includes(normalize(app.Name))
    );

    return partial?.AppID ?? null;
  } catch (error) {
    logger.warn("Failed to resolve installed UWP app ID via Get-StartApps", {
      candidateName,
      error,
    });
    return null;
  }
};
