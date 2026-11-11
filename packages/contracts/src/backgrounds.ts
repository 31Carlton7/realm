/**
 * The picture behind an empty session. The desktop draws it; the phone reads the same settings and
 * the same gallery, so what is chosen on one is what the other means by it.
 */

/** How a picture is printed: a two-tone Bayer dither in the theme's tones, the same dither keeping
 *  the picture's own colours, or round halftone dots. */
export type BackgroundEffect = "dither" | "dither-color" | "halftone";

/** One of the person's own pictures, as main keeps it under `<REALM_HOME>/backgrounds/`. */
export type BackgroundImage = {
  id: string;
  name: string;
  added: number;
  effect: BackgroundEffect;
  /** Shown as it is, with no dither. The contrast guard still lowers it under the words. */
  asIs: boolean;
  width: number;
  height: number;
};

export type BackgroundsAdded = { added: BackgroundImage[]; refused: { name: string; reason: string }[] };

/** Which background a new session gets: `off`, `shuffle`, a gallery id, or `mine:<id>` for one of
 *  the person's own. Unset is the default look. */
export const BACKGROUND_SETTING = "ui.background";
/** Whether a look that can move does. Off unless the stored value is exactly `true`. */
export const BACKGROUND_MOTION_SETTING = "ui.backgroundMotion";
/** Where phase 1 kept the choice, read once and then cleared. */
export const LEGACY_BACKGROUND_KEY = "realm.heroBackdrop";

export const DEFAULT_BACKGROUND = "haze";
export const MINE_PREFIX = "mine:";

/** The stored choice as one the app acts on: a string it can resolve, or the default. */
export function backgroundPref(stored: unknown): string {
  return typeof stored === "string" && stored.trim() !== "" ? stored : DEFAULT_BACKGROUND;
}

/**
 * What to write when a home that chose a look through phase 1's localStorage key first boots with
 * the setting: that look, if the setting is unset and the key names one. Null is "write nothing", and
 * an unset key is always that, so a home that never chose keeps reading the default.
 */
export function migratedBackground(stored: unknown, legacy: string | null, known: (id: string) => boolean): string | null {
  if (stored !== undefined && stored !== null) return null;
  return legacy && known(legacy) ? legacy : null;
}

/** A small stable hash of a session id (FNV-1a), so Shuffle gives each session one look for good. */
export function sessionHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Shuffle's pick for a session out of `pool` (gallery ids, then `mine:` ids). */
export function shufflePick<T>(pool: readonly T[], sessionId: string): T | null {
  return pool.length ? pool[sessionHash(sessionId) % pool.length]! : null;
}
