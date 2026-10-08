/**
 * Whether the Realm.app this process launched from is still the one on disk.
 *
 * ⌘Q only puts Realm away (quit-policy.ts), so the main process routinely outlives an update: an
 * agent asked to "update Realm" swaps /Applications/Realm.app, then `open`s it, and macOS hands that
 * open to the process that is already running. Electron read `app.asar`'s header once, at launch, and
 * keeps reading by those offsets from whatever file now has the name — rename or in-place copy alike.
 * The next window it loads is a slice of some unrelated chunk, rendered as a wall of minified source.
 *
 * Nothing in this process can be trusted to load another file after that, so the only answer is to
 * relaunch into the new bundle. The daemon is left alone: the new launch's handoff deals with it.
 */
import { statSync } from "node:fs";

export type AsarStamp = { ino: number; size: number; mtimeMs: number };

/** Inode for a rename-swap (Squirrel, `install-local.mjs`, `mv`), size and mtime for a copy over the
 *  top. Null is "nothing there", which is replaced too: the bundle moved or is mid-swap. */
export function asarReplaced(launched: AsarStamp, now: AsarStamp | null): boolean {
  if (!now) return true;
  return now.ino !== launched.ino || now.size !== launched.size || Math.trunc(now.mtimeMs) !== Math.trunc(launched.mtimeMs);
}

/**
 * The archive file's own stat. Electron's fs answers a stat of `app.asar` as the archive's root
 * directory (inode 1, size 0), so the real file is only visible with asar support switched off for
 * the length of one synchronous call.
 */
export function readAsarStamp(path: string): AsarStamp | null {
  const proc = process as NodeJS.Process & { noAsar?: boolean };
  const was = proc.noAsar;
  proc.noAsar = true;
  try {
    const s = statSync(path);
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  } finally {
    proc.noAsar = was;
  }
}
