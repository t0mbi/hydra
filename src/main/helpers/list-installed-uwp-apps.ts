import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@main/services";
import type { InstalledUwpApp } from "@types";

const execFileAsync = promisify(execFile);

// Shape emitted by ENUMERATE_SCRIPT below (already joined server-side in
// PowerShell), not the raw Get-StartApps/Get-AppxPackage cmdlet output.
interface EnumeratedAppRow {
  Name: string;
  AppId: string;
  PackageFamilyName: string;
  InstallLocation: string;
}

// Shortcut filenames drop punctuation Windows keeps in the real display
// name (e.g. a dropped "Halo Campaign Evolved.lnk" vs. the actual
// "Halo: Campaign Evolved") -- collapsing everything but alphanumerics to
// single spaces makes both sides comparable regardless of colons, dashes,
// trademark symbols, etc.
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const CACHE_TTL_MS = 10_000;
let cache: { apps: InstalledUwpApp[]; fetchedAt: number } | null = null;

// Get-StartApps alone gives Name+AppID (the real, activatable AUMID -- see
// resolveInstalledUwpApp below for why that matters) but no install path.
// Get-AppxPackage gives InstallLocation but not the AppId suffix a package
// might register under. Joining both on PackageFamilyName is what actually
// gives us a complete, launchable, locatable picture -- the same
// information Playnite gets from PackageManager.FindPackagesForUser() +
// AppxManifest.xml, just sourced through PowerShell instead of a WinRT
// binding.
const ENUMERATE_SCRIPT = `
$startApps = Get-StartApps
$packages = Get-AppxPackage
$result = foreach ($app in $startApps) {
  $familyName = $app.AppID.Split('!')[0]
  $pkg = $packages | Where-Object { $_.PackageFamilyName -eq $familyName } | Select-Object -First 1
  if ($pkg) {
    [PSCustomObject]@{
      Name = $app.Name
      AppId = $app.AppID
      PackageFamilyName = $familyName
      InstallLocation = $pkg.InstallLocation
    }
  }
}
$result | ConvertTo-Json -Compress
`;

/**
 * Every installed, launchable Microsoft Store/Xbox app, with its real
 * AppUserModelID and install folder. Result is cached briefly since this
 * shells out to PowerShell and enumerates every installed package on the
 * system (not free) -- pass forceRefresh to bypass the cache (e.g. a
 * "rescan" button).
 */
export const listInstalledUwpApps = async (
  forceRefresh = false
): Promise<InstalledUwpApp[]> => {
  if (process.platform !== "win32") return [];

  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.apps;
  }

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ENUMERATE_SCRIPT],
      { windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    const rows = (
      Array.isArray(parsed) ? parsed : [parsed]
    ) as EnumeratedAppRow[];

    const apps: InstalledUwpApp[] = rows
      .filter((row) => row?.AppId && row?.InstallLocation)
      .map((row) => ({
        name: row.Name,
        appId: row.AppId,
        packageFamilyName: row.PackageFamilyName,
        installLocation: row.InstallLocation,
      }));

    cache = { apps, fetchedAt: Date.now() };
    return apps;
  } catch (error) {
    logger.warn("Failed to enumerate installed UWP apps", { error });
    return cache?.apps ?? [];
  }
};

/**
 * A .lnk shortcut's own AppUserModelID property isn't always the real,
 * activatable one -- Xbox App-created shortcuts for Game Pass titles carry
 * a launcher-specific alias instead (confirmed against a real shortcut:
 * "XboxGames.Microsoft.<id>_AppFoo" was rejected by ActivateApplication
 * with E_INVALIDARG, while the actual registered AUMID -- from this same
 * installed-apps list -- "Microsoft.<id>_8wekyb3d8bbwe!AppFoo" -- launches
 * correctly). This cross-references a candidate display name against
 * Windows' own authoritative installed-app list to find the real entry.
 */
export const resolveInstalledUwpApp = async (
  candidateName: string
): Promise<InstalledUwpApp | null> => {
  const apps = await listInstalledUwpApps();
  const target = normalize(candidateName);

  const exact = apps.find((app) => normalize(app.name) === target);
  if (exact) return exact;

  const partial = apps.find(
    (app) =>
      normalize(app.name).includes(target) ||
      target.includes(normalize(app.name))
  );

  return partial ?? null;
};
