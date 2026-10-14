/**
 * Where each video was left, and how loud the player was — kept across a relaunch, as a player is
 * expected to. A long screen recording an agent made is watched in sittings, and opening it at 0:00
 * again is the player forgetting what it was just told.
 *
 * Kept in the window's localStorage, by the file's path, newest first and capped: a position is a
 * number per file, and the oldest are the ones nobody is coming back to. A position near either end
 * is not kept — a few seconds in is the start, and a few seconds from the end is finished.
 */
const POSITIONS_KEY = "realm.video.positions";
const VOLUME_KEY = "realm.video.volume";
const MAX_FILES = 200;
/** Closer than this to either end is not a place worth putting someone back. */
export const EDGE_SECONDS = 3;

type Positions = Record<string, { t: number; at: number }>;

function read(): Positions {
  try {
    const raw = globalThis.localStorage?.getItem(POSITIONS_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return parsed && typeof parsed === "object" ? parsed as Positions : {};
  } catch { return {}; }
}

function write(all: Positions): void {
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_FILES);
  try { globalThis.localStorage?.setItem(POSITIONS_KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* storage full or gone */ }
}

/** Where to start this file, or null to start at the beginning. */
export function savedPosition(path: string, duration: number): number | null {
  const t = read()[path]?.t;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (t < EDGE_SECONDS || (Number.isFinite(duration) && t > duration - EDGE_SECONDS)) return null;
  return t;
}

/** Remember where this file is; a time near either end forgets it instead. */
export function rememberPosition(path: string, t: number, duration: number, now = Date.now()): void {
  const all = read();
  if (!Number.isFinite(t) || t < EDGE_SECONDS || (Number.isFinite(duration) && duration > 0 && t > duration - EDGE_SECONDS)) {
    if (!(path in all)) return;
    delete all[path];
  } else {
    all[path] = { t: Math.round(t * 10) / 10, at: now };
  }
  write(all);
}

export function savedVolume(): { volume: number; muted: boolean } {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(VOLUME_KEY) ?? "null") as { volume?: unknown; muted?: unknown } | null;
    const volume = typeof v?.volume === "number" && v.volume >= 0 && v.volume <= 1 ? v.volume : 1;
    return { volume, muted: v?.muted === true };
  } catch { return { volume: 1, muted: false }; }
}

export function rememberVolume(volume: number, muted: boolean): void {
  try { globalThis.localStorage?.setItem(VOLUME_KEY, JSON.stringify({ volume, muted })); } catch { /* storage full or gone */ }
}
