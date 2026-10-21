import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Where a file that arrived as bytes rather than as a path is written, so that an agent can be handed
 * a path: a desktop paste (Electron main) and a file sent from Realm Mobile (realm-server). Both must
 * write, name and sweep these the same way, so the two share this file.
 *
 * Like `secret-box.ts`, this is **not re-exported from `index.ts`**: it imports `node:fs`, and
 * `index.ts` is pulled into the renderer's browser bundle. Import it by path
 * (`@realm/contracts/src/temp-attachments`) from Node contexts only.
 */

/**
 * Where a pasted image is written.
 *
 * A pasted image has no file on disk, and every adapter's contract is a PATH — so one has to be made.
 * It goes under Realm's own home rather than the OS temp dir for two reasons: macOS purges
 * `/var/folders` on its own schedule, which would break the path recorded in the session's
 * `user_message` event while the session is still open; and a file the user can go and look at is
 * better than one they cannot.
 */
export const tempAttachmentDir = (home: string): string => join(home, "tmp", "attachments");

/** How long a pasted file survives. Longer than any single turn (the adapter reads it asynchronously,
 *  after `sessions.send` has already resolved), short enough that the directory cannot creep. */
export const TEMP_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A filesystem-safe name for a pasted file.
 *
 * The name arrives from the renderer (`File.name` on a clipboard item), so it is untrusted: strip it to
 * a basename, then to a conservative character set, so nothing can escape the directory or collide with
 * a name the sweep is meant to recognise. The extension is preserved when there is one — it is what
 * `mimeForPath` reads, and what makes the file openable.
 *
 * `fallback` is for the name that sanitizes away to nothing (`...`, `///`, an empty string). Pastes
 * want "pasted"; a download wants "download", and since downloads stopped requiring an extension
 * that case reaches disk where it never used to. One sanitizer with a caller-chosen word beats a
 * second sanitizer that drifts from this one.
 */
export function safeAttachmentName(name: string, fallback = "pasted"): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim();
  return base.length === 0 ? fallback : base.slice(0, 120);
}

/**
 * Delete pasted files older than `ttlMs`.
 *
 * Called at launch AND on every save: a launch-only sweep leaks for as long as the app stays up, which
 * for a workstation app is the normal case. Each sweep is one directory read over a handful of entries.
 * Errors are swallowed per entry — a file another window is mid-read is not worth failing a paste over.
 */
export async function sweepTempAttachments(dir: string, ttlMs = TEMP_ATTACHMENT_TTL_MS, now = Date.now()): Promise<string[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; } // never created = nothing to sweep
  const removed: string[] = [];
  for (const name of names) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (now - s.mtimeMs < ttlMs) continue;
      await rm(p, { recursive: true, force: true });
      removed.push(name);
    } catch { /* vanished, or not ours to remove */ }
  }
  return removed;
}
