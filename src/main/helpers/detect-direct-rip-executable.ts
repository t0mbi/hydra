import path from "node:path";
import { collectAccessibleFilePaths } from "./collect-accessible-file-paths";
import { isRedistributablePath } from "./game-executable-ranking";

const pathDepth = (relativePath: string) => relativePath.split(/[\\/]/).length;

/**
 * Detects a "direct rip" folder -- a repack that's already ready to play,
 * no installer wizard needed -- for games Hydra's community exe catalogue
 * doesn't recognize yet. Many repacks nest the real game a level or two
 * down (e.g. GameName.rar -> GameName/ -> the actual exe) alongside sibling
 * folders like _CommonRedist full of prerequisite installers -- this
 * recursively collects every .exe under the folder and discards anything
 * matching the same known-redistributable/shared-runtime filter used
 * elsewhere for known executables (_CommonRedist, vc_redist, dxwebsetup,
 * setup.exe, UnityCrashHandler, etc.).
 *
 * What's left can still be more than one real exe -- Unreal Engine games
 * in particular commonly ship a lightweight root-level launcher (e.g.
 * GameName.exe) that wraps a separate, more deeply nested shipping binary
 * (GameName/Binaries/Win64/GameName-Win64-Shipping.exe). The shallowest
 * candidate is the conventional thing to point Play at, so this prefers
 * it; only a genuine tie at the shallowest depth (or zero candidates) is
 * treated as ambiguous, returning null rather than guessing.
 */
export const detectDirectRipExecutable = async (
  folderPath: string
): Promise<string | null> => {
  try {
    const relativeFilePaths = await collectAccessibleFilePaths(folderPath);

    const exeCandidates = relativeFilePaths.filter(
      (relativePath) =>
        path.extname(relativePath).toLowerCase() === ".exe" &&
        !isRedistributablePath(relativePath)
    );

    if (exeCandidates.length === 0) return null;

    const minDepth = Math.min(...exeCandidates.map(pathDepth));
    const shallowestCandidates = exeCandidates.filter(
      (candidate) => pathDepth(candidate) === minDepth
    );

    if (shallowestCandidates.length !== 1) return null;

    return path.join(folderPath, shallowestCandidates[0]);
  } catch {
    return null;
  }
};
