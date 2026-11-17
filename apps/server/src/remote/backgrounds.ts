import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_EFFECTS, DEFAULT_BACKGROUND, MINE_PREFIX, shufflePick, type BackgroundEffect } from "@realm/contracts";
import type { BackgroundLook } from "@realm/remote";

/**
 * The picture behind a session, for a phone: the look `ui.background` names, resolved on the Mac the
 * way the desktop resolves it, and its stills. A look's faces are still keys: `gallery:<file>` for one
 * Realm ships, `mine:<id>` for one of the person's own. A key is only ever looked up among the
 * pictures that exist, never joined onto a path as given.
 */

/** The longest side of a still sent to a phone: a Pro Max screen's long side, in pixels. */
export const STILL_SIDE = 1290;
export const STILL_QUALITY = 70;

export type GalleryEntry = { id: string; effect: BackgroundEffect; light: string; dark: string };
export type MineEntry = { id: string; effect: BackgroundEffect; asIs: boolean };

/**
 * Where the gallery's pictures and `gallery.json` are: `REALM_GALLERY_DIR`, then the desktop's assets
 * in the workspace, then `<resources>/gallery` in a packaged build (stage-pack.mjs puts them there).
 */
export function galleryDir(): string | null {
  const override = process.env.REALM_GALLERY_DIR;
  if (override) return existsSync(override) ? override : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const assets = join(dir, "apps", "desktop", "src", "renderer", "src", "assets", "hero-backdrops");
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(assets)) return assets;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? join(resources, "gallery") : null;
  return packaged && existsSync(packaged) ? packaged : null;
}

/** The gallery's looks whose pictures are there, each face the file its still is read from: a face
 *  with a loop is its poster, the loop's first frame. Entries that cannot be drawn are dropped. */
export async function readGallery(dir: string | null): Promise<GalleryEntry[]> {
  if (!dir) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, "gallery.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: GalleryEntry[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const { id, effect, light, dark, motion, loop } = e;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id) || out.some((g) => g.id === id)) continue;
    if (!BACKGROUND_EFFECTS.includes(effect as BackgroundEffect) || typeof light !== "string" || typeof dark !== "string") continue;
    const face = (k: "light" | "dark", still: string) => {
      const video = motion === true && effect === "dither-color" && loop && typeof loop === "object" ? (loop as Record<string, unknown>)[k] : undefined;
      const poster = typeof video === "string" ? video.replace(/\.[^.]+$/, ".jpg") : null;
      return poster && existsSync(join(dir, poster)) ? poster : still;
    };
    if (!existsSync(join(dir, light)) || !existsSync(join(dir, dark))) continue;
    out.push({ id, effect: effect as BackgroundEffect, light: face("light", light), dark: face("dark", dark) });
  }
  return out;
}

const MINE_ID = /^[0-9a-f]{16}$/;

/** The person's own pictures, as the desktop keeps them under `<REALM_HOME>/backgrounds/`. */
export async function readMine(realmHome: string): Promise<MineEntry[]> {
  try {
    const raw = JSON.parse(await readFile(join(realmHome, "backgrounds", "index.json"), "utf8")) as { images?: unknown };
    if (!Array.isArray(raw.images)) return [];
    return raw.images.flatMap((e: Record<string, unknown>) => e && typeof e.id === "string" && MINE_ID.test(e.id) && existsSync(join(realmHome, "backgrounds", `${e.id}.jpg`))
      ? [{ id: e.id, effect: BACKGROUND_EFFECTS.includes(e.effect as BackgroundEffect) ? (e.effect as BackgroundEffect) : "dither-color", asIs: e.asIs === true }]
      : []);
  } catch {
    return [];
  }
}

/**
 * The look a session shows for the stored choice, as the desktop's `resolveBackdrop` picks it: none
 * for `off`; Shuffle's pick for the session among every look and picture; one of the person's own;
 * a gallery look. A choice that names nothing there is the default look.
 */
export function resolveLook(pref: string, sessionId: string, gallery: readonly GalleryEntry[], mine: readonly MineEntry[]): BackgroundLook | null {
  if (pref === "off") return null;
  if (pref === "shuffle") {
    const pick = shufflePick([...gallery.map((g) => g.id), ...mine.map((m) => `${MINE_PREFIX}${m.id}`)], sessionId);
    return pick ? resolveLook(pick, sessionId, gallery, mine) : null;
  }
  if (pref.startsWith(MINE_PREFIX)) {
    const m = mine.find((x) => `${MINE_PREFIX}${x.id}` === pref);
    if (m) return { id: pref, effect: m.effect, asIs: m.asIs, faces: { light: pref, dark: pref } };
  }
  const g = gallery.find((x) => x.id === pref) ?? gallery.find((x) => x.id === DEFAULT_BACKGROUND) ?? gallery[0];
  return g ? { id: g.id, effect: g.effect, asIs: false, faces: { light: `gallery:${g.light}`, dark: `gallery:${g.dark}` } } : null;
}

/** The file a still key names, or null for a key that names no picture there. */
export function stillPath(key: string, galleryAt: string | null, gallery: readonly GalleryEntry[], realmHome: string, mine: readonly MineEntry[]): string | null {
  if (key.startsWith(MINE_PREFIX)) {
    const m = mine.find((x) => `${MINE_PREFIX}${x.id}` === key);
    return m ? join(realmHome, "backgrounds", `${m.id}.jpg`) : null;
  }
  const file = key.startsWith("gallery:") ? key.slice("gallery:".length) : null;
  return galleryAt && file && gallery.some((g) => g.light === file || g.dark === file) ? join(galleryAt, file) : null;
}
