import { readFileSync, writeFileSync } from "node:fs";

/**
 * The window comes back where it was left. A Mac app reopens at its last size and place, maximised or
 * in full screen if it was; this one opened at 1400×900 in the middle of the main display every
 * launch, which is the behaviour of something that does not remember being used.
 *
 * Kept in userData as a small JSON file rather than in the server's database: it is a fact about
 * this Mac's displays, not about the person's work, and it has to be known before the server is up.
 */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Which file a window's place is kept in. The first window keeps `window-state.json`, as it always
 * has; a window opened for a profile (Plan 27 Phase 2) keeps its own, under that profile, so Work's
 * window comes back where Work's window was and does not land on top of the first.
 */
export function windowStateFileName(profileId: string | null): string {
  if (profileId === null) return "window-state.json";
  // An id is ULID-shaped; anything else is reduced to what a file name can hold rather than trusted.
  return `window-state-${profileId.replace(/[^0-9A-Za-z]/g, "").slice(0, 64) || "profile"}.json`;
}
export type SavedWindow = Rect & { maximized?: boolean; fullScreen?: boolean };

/** The smallest share of the window that must land on a display for the saved place to be kept. A
 *  window parked mostly off a display that has since been unplugged is a window nobody can reach. */
const MIN_VISIBLE = 0.5;

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Where the window opens. The saved place when enough of it is still on a display; otherwise the
 * saved SIZE (clamped to the display) centred on the primary display, because the size is a
 * preference worth keeping even when the place has gone; otherwise the defaults.
 */
export function restoredBounds(
  saved: SavedWindow | null,
  displays: Rect[],
  defaults: { width: number; height: number; minWidth: number; minHeight: number },
): Rect & { center: boolean } {
  const fallback = { x: 0, y: 0, width: defaults.width, height: defaults.height, center: true };
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return fallback;
  const width = Math.max(defaults.minWidth, Math.round(saved.width));
  const height = Math.max(defaults.minHeight, Math.round(saved.height));
  const rect = { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
  const visible = Math.max(0, ...displays.map((d) => overlap(rect, d)));
  if (visible >= MIN_VISIBLE * width * height) return { ...rect, center: false };
  const primary = displays[0];
  if (!primary) return fallback;
  return { x: 0, y: 0, width: Math.min(width, primary.width), height: Math.min(height, primary.height), center: true };
}

export function readWindowState(file: string): SavedWindow | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedWindow>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      x: Number(raw.x), y: Number(raw.y), width: Number(raw.width), height: Number(raw.height),
      maximized: raw.maximized === true, fullScreen: raw.fullScreen === true,
    };
  } catch {
    return null; // first launch, or a file someone edited by hand — either way, the defaults
  }
}

export type TrackedWindow = {
  getNormalBounds(): Rect;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  on(event: "resize" | "move" | "close" | "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen", fn: () => void): unknown;
};

/** How long after the last move or resize the place is written. A drag fires dozens of events. */
export const SAVE_DEBOUNCE_MS = 400;

/**
 * Keep the file current as the window moves. `getNormalBounds` is the size the window returns to
 * from maximised or full screen, which is the one worth restoring under the flag.
 */
export function trackWindowState(win: TrackedWindow, file: string, write = writeFileSync): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    if (win.isDestroyed()) return;
    const state: SavedWindow = { ...win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
    try { write(file, JSON.stringify(state)); } catch { /* a read-only userData costs only the memory */ }
  };
  const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(save, SAVE_DEBOUNCE_MS); };
  for (const ev of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) win.on(ev, later);
  win.on("close", () => { if (timer) clearTimeout(timer); save(); });
}
