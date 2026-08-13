import fs from "node:fs/promises";
import path from "node:path";

const copyDirectoryRecursive = async (srcDir: string, destDir: string) => {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
};

/**
 * Moves a directory to a new location. fs.rename fails with EXDEV when the
 * source and destination are on different drives (a very normal case here
 * -- downloads and install paths are commonly on separate drives), so this
 * falls back to a recursive copy + delete of the source in that case.
 */
export const moveDirectory = async (
  src: string,
  dest: string
): Promise<void> => {
  try {
    await fs.rename(src, dest);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  await copyDirectoryRecursive(src, dest);
  await fs.rm(src, { recursive: true, force: true });
};
