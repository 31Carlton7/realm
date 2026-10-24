/**
 * Deletes what packages carry for their developers and nothing reads at runtime: the source maps of
 * code, and TypeScript declarations. In the staged server's node_modules that was about 2,900 of its
 * 7,200 files (77 MB of maps alone), and every file is one more for an AppImage to unpack before its
 * window opens and for codesign to seal.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DEV_ONLY = /\.(?:[cm]?js|css|[cm]?ts)\.map$|\.d\.[cm]?ts$/;

/** Real directories only: pnpm's links point back into the same tree, some of them in a circle. */
export function pruneDevFiles(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removed += pruneDevFiles(path);
    else if (entry.isFile() && DEV_ONLY.test(entry.name)) { rmSync(path); removed++; }
  }
  return removed;
}
