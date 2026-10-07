import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

/**
 * One folder, read off the disk, newest first — what the session's file browser lists.
 *
 * It exists because the Library cannot answer the question. That index is built from EVENTS: a
 * `tool_call` whose tool is one of the writers (`artifactsFromEvent`). So a file the agent produced
 * by running something — a zip built by a shell line, a PDF a Python script wrote, anything made by
 * a process rather than by a Write — is not in it, and never was. The summary's Outputs list has the
 * same blind spot for the same reason, which is exactly what a user sees when they generate a file,
 * open Summary, and find nothing there.
 *
 * A directory listing has no such gap: a file is on disk or it is not.
 *
 * In MAIN rather than the server because it is a local read for the UI, the same as `files:stat` and
 * `files:preview` beside it — no session owns it, and routing it through the agent server would put
 * a filesystem walk on the RPC socket for something the window can answer itself.
 */

/** Names never descended into or listed. Build output and dependency trees are not what anybody
 *  opens this for, and one of them can hold more files than the rest of a home put together. */
const SKIP = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", "__pycache__", "venv", ".venv",
  "Pods", "DerivedData", ".next", ".turbo", ".cache",
]);

/** The most entries one folder ever reports. A directory with more than this in it is a data dump
 *  rather than a place someone is looking for a file, and the newest few hundred are the answer to
 *  the question being asked either way. */
export const BROWSE_LIMIT = 400;

export type BrowseEntry = {
  /** Relative to the root, `/`-separated — what the UI passes back to descend. */
  path: string;
  name: string;
  isDir: boolean;
  /** Bytes. 0 for a directory: a folder's size is a walk, and a walk per row is a walk per frame. */
  size: number;
  /** Last modified, epoch ms. The sort key, and what the browser groups its days by. */
  mtimeMs: number;
};

export type BrowseResult = {
  /** The directory that was read, relative to the root ("" at the top). */
  dir: string;
  entries: BrowseEntry[];
  /** True when the folder held more than `BROWSE_LIMIT`, so the list says it is a page not a whole. */
  truncated: boolean;
};

/**
 * Resolve `dir` inside `root`, or null when it points outside it.
 *
 * Symlinks are resolved by the caller's `stat`, not here: this is about the PATH a window asked for,
 * and the check that matters is that a `../..` typed into a breadcrumb cannot walk out of the folder
 * the user is browsing.
 */
export function insideRoot(root: string, dir: string): string | null {
  const base = resolve(root);
  const abs = resolve(base, dir);
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

export async function browseFolder(root: string, dir = "", limit = BROWSE_LIMIT): Promise<BrowseResult> {
  const base = resolve(root);
  const abs = insideRoot(base, dir);
  if (abs === null) throw new Error("that folder is outside the one being browsed");
  const names = await readdir(abs);

  const entries: BrowseEntry[] = [];
  for (const name of names) {
    // Dotfiles and build trees are noise here in a way they are not in an editor's file picker: this
    // list answers "what is in this folder", and `.DS_Store` has never been the answer.
    if (name.startsWith(".") || SKIP.has(name)) continue;
    let st;
    // A file removed mid-listing, or a symlink pointing at nothing, is not worth failing the whole
    // folder over — it is simply not there any more.
    try { st = await stat(join(abs, name)); } catch { continue; }
    if (!st.isDirectory() && !st.isFile()) continue; // sockets, fifos: not files anyone browses
    entries.push({
      path: relative(base, join(abs, name)).split(sep).join("/"),
      name,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
    });
  }

  /* Newest first, folders and files together. A picker sorts folders-then-alphabetical because it is
     being navigated; this is being SEARCHED, by someone who just asked for a file and wants to see
     it — and the thing they are looking for is, by definition, the most recent thing in here. */
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return { dir: relative(base, abs).split(sep).join("/"), entries: entries.slice(0, limit), truncated: entries.length > limit };
}

/** The folder's own name, for a breadcrumb. `""` at the root answers with the root's basename. */
export const folderLabel = (root: string, dir: string): string => (dir === "" ? basename(resolve(root)) : basename(dir));
