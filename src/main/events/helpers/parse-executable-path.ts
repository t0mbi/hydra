import { shell } from "electron";

export interface ParsedExecutable {
  executablePath: string;
  launchOptions?: string;
  launchesViaMicrosoftStore?: boolean;
}

export const parseExecutablePath = (filePath: string): ParsedExecutable => {
  if (process.platform === "win32" && filePath.endsWith(".lnk")) {
    const { target, args, appUserModelId } = shell.readShortcutLink(filePath);

    // Microsoft Store / Xbox app shortcuts don't carry a normal target --
    // Windows identifies them only by an AppUserModelID. executablePath
    // stores that AUMID directly (it's a stable, unique-per-app string);
    // launching it goes through NativeAddon.activateUwpApp (see
    // launch-game.ts), which uses the same IApplicationActivationManager
    // COM API Explorer itself uses for these shortcuts, and returns the
    // real launched process ID for tracking -- not a spawned process, so
    // there's no meaningful launchOptions here.
    if (!target && appUserModelId) {
      return {
        executablePath: appUserModelId,
        launchesViaMicrosoftStore: true,
      };
    }

    return { executablePath: target, launchOptions: args || undefined };
  }

  return { executablePath: filePath };
};
