import { BACKGROUND_EFFECTS as EFFECTS, BACKGROUND_SCHEME, DEFAULT_BACKGROUND, MINE_PREFIX, shufflePick, type BackgroundEffect, type BackgroundImage } from "@realm/contracts";
import galleryJson from "../../assets/hero-backdrops/gallery.json";
import type { LoopSource } from "./loop-player";

/** A face's loop and its poster (the loop's first frame, shown wherever it does not play), as URLs. */
export type FaceLoop = { video: string; poster: string };
/** A loop per face; a face without one shows its picture still. */
export type FaceLoops = { light: FaceLoop | null; dark: FaceLoop | null };

/** A look Realm ships: `light` and `dark` are the pictures for each face, as URLs. */
export type GalleryLook = {
  id: string; name: string; mood: string; light: string; dark: string; effect: BackgroundEffect; motion: boolean;
  /** The video each face plays when Motion is on, its picture being the video's first frame. Only a
   *  look kept in its own colours moves this way; a two-tone or halftone look drifts instead. */
  loop: FaceLoops | null;
  /** Who made the picture and where it came from, shown under Picture credits; empty when unknown. */
  credit: string;
};

/**
 * The gallery as `gallery.json` lists it, keeping only entries that can be drawn: an id of lowercase
 * letters, digits and dashes seen once, a name, a known effect, and pictures that exist among the
 * shipped files (`urls`, by file name). Anything else is dropped rather than failing the rest, so an
 * entry added by hand with a typo costs that entry alone. A `loop` (`{ light, dark }`, video file
 * names) is kept for the faces whose video was shipped with its poster beside it (`<name>.jpg`), on a
 * moving colour-kept look only.
 */
export function parseGallery(raw: unknown, urls: Record<string, string>): GalleryLook[] {
  if (!Array.isArray(raw)) return [];
  const out: GalleryLook[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const { id, name, mood, light, dark, effect, motion, loop, credit } = e;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id) || out.some((g) => g.id === id)) continue;
    if (typeof name !== "string" || !name.trim() || !EFFECTS.includes(effect as BackgroundEffect)) continue;
    const lightUrl = typeof light === "string" ? urls[light] : undefined;
    const darkUrl = typeof dark === "string" ? urls[dark] : undefined;
    if (!lightUrl || !darkUrl) continue;
    const face = (k: "light" | "dark") => {
      const file = loop && typeof loop === "object" ? (loop as Record<string, unknown>)[k] : undefined;
      const video = typeof file === "string" ? urls[file] : undefined;
      const poster = typeof file === "string" ? urls[file.replace(/\.[^.]+$/, ".jpg")] : undefined;
      return video && poster ? { video, poster } : null;
    };
    const loops = motion === true && effect === "dither-color" ? { light: face("light"), dark: face("dark") } : null;
    out.push({
      id, name, mood: typeof mood === "string" ? mood : "", light: lightUrl, dark: darkUrl, effect: effect as BackgroundEffect, motion: motion === true,
      loop: loops && (loops.light || loops.dark) ? loops : null, credit: typeof credit === "string" ? credit : "",
    });
  }
  return out;
}

const files = import.meta.glob<string>("../../assets/hero-backdrops/*.{jpg,jpeg,png,webp,mp4,webm}", { eager: true, query: "?url", import: "default" });
const byName = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));

export const GALLERY: GalleryLook[] = parseGallery(galleryJson, byName);

/** What draws behind one session: how it is printed, whether it moves, and its picture per face. */
export type Backdrop = {
  /** Stable for the picture and its treatment, so a backdrop is redrawn only when one of them changes. */
  key: string;
  effect: BackgroundEffect | "as-is";
  moves: boolean;
  image: { light: string; dark: string } | { mine: string };
  /** What it plays per face over its still, where it is a loop. Whether it plays now is the loop
   *  player's to say (loop-player.ts), so the Motion switch never redraws the still. */
  loop: { light: LoopSource | null; dark: LoopSource | null } | null;
};

const video = (url: string | null): LoopSource | null => (url ? { kind: "video", url } : null);

/** A face with a loop is drawn still from the loop's poster, so the loop starts on the picture already
 *  there. */
function fromGallery(g: GalleryLook, motion: boolean): Backdrop {
  return {
    key: g.id, effect: g.effect, moves: motion && g.motion && !g.loop,
    image: { light: g.loop?.light?.poster ?? g.light, dark: g.loop?.dark?.poster ?? g.dark },
    loop: g.loop && { light: video(g.loop.light?.video ?? null), dark: video(g.loop.dark?.video ?? null) },
  };
}

/** A loop of the person's own plays printed in colour or as it is; under two-tone or halftone it
 *  is its still. */
function fromMine(m: BackgroundImage): Backdrop {
  const effect = m.asIs ? "as-is" : m.effect;
  const src: LoopSource | null = !m.loop || (effect !== "as-is" && effect !== "dither-color") ? null
    : m.loop === "gif" ? { kind: "gif", id: m.id } : { kind: "video", url: `${BACKGROUND_SCHEME}://loop/${m.id}` };
  return { key: `${MINE_PREFIX}${m.id}:${effect}`, effect, moves: false, image: { mine: m.id }, loop: src && { light: src, dark: src } };
}

/**
 * The backdrop a session shows for the stored choice. `mine` is the person's own pictures, or
 * undefined while they load (a choice among them waits for them rather than flashing the default).
 * Shuffle picks per session from every look and picture, the same one each time. A choice that names
 * nothing that exists — a removed picture, a look a newer build shipped — is the default look.
 */
export function resolveBackdrop(pref: string, sessionId: string, motion: boolean, mine: readonly BackgroundImage[] | undefined, gallery: readonly GalleryLook[] = GALLERY): Backdrop | null {
  if (pref === "off") return null;
  if (pref === "shuffle") {
    if (!mine) return null;
    const pick = shufflePick([...gallery.map((g) => g.id), ...mine.map((m) => `${MINE_PREFIX}${m.id}`)], sessionId);
    return pick ? resolveBackdrop(pick, sessionId, motion, mine, gallery) : null;
  }
  if (pref.startsWith(MINE_PREFIX)) {
    if (!mine) return null;
    const m = mine.find((x) => `${MINE_PREFIX}${x.id}` === pref);
    if (m) return fromMine(m);
  }
  const g = gallery.find((x) => x.id === pref) ?? gallery.find((x) => x.id === DEFAULT_BACKGROUND) ?? gallery[0];
  return g ? fromGallery(g, motion) : null;
}

/** Whether a choice can move at all, which is when the Motion switch has something to do. */
export function prefCanMove(pref: string, gallery: readonly GalleryLook[] = GALLERY, mine: readonly BackgroundImage[] = []): boolean {
  if (pref === "off") return false;
  if (pref.startsWith(MINE_PREFIX)) return !!mine.find((m) => `${MINE_PREFIX}${m.id}` === pref)?.loop;
  if (pref === "shuffle") return gallery.some((g) => g.motion) || mine.some((m) => m.loop);
  return (gallery.find((g) => g.id === pref) ?? gallery.find((g) => g.id === DEFAULT_BACKGROUND))?.motion === true;
}

/**
 * Whether a frame loop may run now: only for a backdrop that moves, and never under Reduce motion,
 * while the root is quiet (`data-quiet`: Low power is "always", a window not in front, idle), in
 * macOS Low Power Mode (`data-low-power-mode`) or while
 * the document is hidden. Read fresh on every frame, so the loop stops the frame any of them changes.
 */
export function loopMayRun(moves: boolean, root: Element, reduce: { matches: boolean } | null): boolean {
  return moves && !reduce?.matches && !root.hasAttribute("data-quiet") && !root.hasAttribute("data-low-power-mode") && !document.hidden;
}
