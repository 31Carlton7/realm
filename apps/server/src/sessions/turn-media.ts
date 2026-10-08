import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { directoriesNamedIn, expandHome, isPlayablePath, type SessionEvent } from "@realm/contracts";
import { HIDDEN_DIRS } from "../documents/paths";

/**
 * Finding the pictures and movies a turn left on disk, for `files_made`.
 *
 * No agent writes an image with a write tool. A picture is the side effect of a shell command, a
 * render script or the clipboard saved through osascript, and it often lands in a folder that is not
 * the session's checkout (the deck that prompted this was made by a Realm-space session into the
 * Versed space's folder). So the turn's settle looks: at the session's cwd, its space's folder, and
 * every directory the turn's tool calls and replies named, for media modified while the turn ran.
 *
 * Bounded everywhere, because it runs on every settle of a turn that called a tool: shallow walks,
 * a cap on entries and on time, and a floor under which a root is refused outright (the Realm space
 * has an environment at `/`).
 */

/** How deep the walk goes under the session's own folders, and under a folder the turn only named. */
export const OWN_ROOT_DEPTH = 4;
export const NAMED_ROOT_DEPTH = 3;
/** Directory entries one sweep reads in total, across every root, and how long it may take. */
export const SWEEP_MAX_ENTRIES = 20_000;
export const SWEEP_DEADLINE_MS = 1_500;
/** Slack on both ends of the turn's window: a file's mtime and the event's ts come off different clocks
 *  (the filesystem's and the server's), and a render that finishes as the settle lands is still the turn's. */
export const MTIME_SLACK_MS = 2_000;

/** Folders a fetch or a build fills, on top of the file picker's own list. */
const SKIP_DIRS: ReadonlySet<string> = new Set([...HIDDEN_DIRS, "Pods", "DerivedData", "build"]);

export type SweepRoot = { path: string; depth: number };

/** True for a folder the sweep must never walk: the disk, the home, the home's Library, and anything
 *  with fewer than two segments (`/tmp`, `/Users`). Checked on the resolved path. */
export function isRefusedRoot(path: string, home: string): boolean {
  const segments = path.split(sep).filter(Boolean);
  if (segments.length < 2) return true;
  const h = resolve(home);
  return path === h || path === join(h, "Library");
}

/**
 * The folders a turn could have left files in, resolved, refused where they must be, and existing.
 *
 * `events` are the turn's own: every `tool_call`'s input (as JSON, which covers a Bash `command`, a
 * `cd X`, a `D=~/x` and a `cwd` field alike) and every `assistant_text` is read for directories. A
 * relative one is taken against the cwd. Ancestors come first, so a folder already covered by one
 * above it is read once (see `sweepTurnMedia`).
 */
export async function turnSearchRoots(
  { cwd, spaceFolder, events, home }: { cwd: string | null; spaceFolder: string | null; events: readonly SessionEvent[]; home: string },
): Promise<SweepRoot[]> {
  const wanted = new Map<string, number>();
  const add = (raw: string, depth: number, base: string | null) => {
    const expanded = expandHome(raw, home);
    if (!isAbsolute(expanded) && !base) return;
    const path = isAbsolute(expanded) ? resolve(expanded) : resolve(base!, expanded);
    wanted.set(path, Math.max(wanted.get(path) ?? 0, depth));
  };
  if (cwd) add(cwd, OWN_ROOT_DEPTH, null);
  if (spaceFolder) add(spaceFolder, OWN_ROOT_DEPTH, null);
  for (const e of events) {
    const text = e.type === "tool_call" ? JSON.stringify(e.payload.input ?? null)
      : e.type === "assistant_text" ? e.payload.text : null;
    if (!text) continue;
    for (const dir of directoriesNamedIn(text)) add(dir, NAMED_ROOT_DEPTH, cwd);
  }
  const out: SweepRoot[] = [];
  for (const [path, depth] of [...wanted].sort(([a], [b]) => a.length - b.length)) {
    if (isRefusedRoot(path, home)) continue;
    const s = await stat(path).catch(() => null);
    if (s?.isDirectory()) out.push({ path, depth });
  }
  return out;
}

export type MadeFile = { path: string; size: number };

/**
 * Media files under `roots` whose mtime falls inside `[from, to]` (with MTIME_SLACK_MS either side),
 * newest first, at most `max` of them; `total` is how many there were.
 *
 * Never follows a directory symlink (`lstat`), never enters a hidden folder or one a build fills, and
 * reads each directory once however many roots reach it. Stops early, keeping what it found, when the
 * entry or time budget runs out.
 */
export async function sweepTurnMedia(
  roots: readonly SweepRoot[],
  { from, to, max, now = Date.now }: { from: number; to: number; max: number; now?: () => number },
): Promise<{ files: MadeFile[]; total: number }> {
  const lo = from - MTIME_SLACK_MS;
  const hi = to + MTIME_SLACK_MS;
  const deadline = now() + SWEEP_DEADLINE_MS;
  const seen = new Set<string>();
  const found = new Map<string, { size: number; mtime: number }>();
  let entries = 0;
  const spent = () => entries >= SWEEP_MAX_ENTRIES || now() > deadline;

  const walk = async (dir: string, depthLeft: number): Promise<void> => {
    if (seen.has(dir) || spent()) return;
    seen.add(dir);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (spent()) return;
      entries++;
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const s = await lstat(path).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) { if (depthLeft > 0) await walk(path, depthLeft - 1); continue; }
      if (!s.isFile() || !isPlayablePath(name)) continue;
      if (s.mtimeMs >= lo && s.mtimeMs <= hi) found.set(path, { size: s.size, mtime: s.mtimeMs });
    }
  };
  for (const root of roots) await walk(root.path, root.depth);

  const files = [...found].sort(([, a], [, b]) => b.mtime - a.mtime)
    .slice(0, max).map(([path, f]) => ({ path, size: f.size }));
  return { files, total: found.size };
}
