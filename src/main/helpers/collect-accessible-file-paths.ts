import fs from "node:fs";
import path from "node:path";

// Program Files on Windows (and similarly locked-down trees elsewhere)
// contains folders that throw EPERM even for elevated processes --
// WindowsApps, various Windows Defender folders, etc. There's no reliable
// list of which ones, and fs.readdir's `recursive` option aborts the
// *entire* walk on the first unreadable subdirectory it hits -- this walks
// manually instead, catching permission errors per-directory and just
// skipping that subtree, so one inaccessible folder never takes out the
// rest of the scan.
const MAX_SCAN_DEPTH = 6;

export const collectAccessibleFilePaths = async (
  rootPath: string
): Promise<string[]> => {
  const filePaths: string[] = [];

  const walk = async (currentPath: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, {
        withFileTypes: true,
      });
    } catch {
      // Expected for OS-protected folders (WindowsApps, Defender, etc.) --
      // not an error worth surfacing, just an inaccessible subtree to skip.
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await walk(entryPath, depth + 1);
        } else if (entry.isFile()) {
          filePaths.push(path.relative(rootPath, entryPath));
        }
      })
    );
  };

  await walk(rootPath, 0);
  return filePaths;
};
