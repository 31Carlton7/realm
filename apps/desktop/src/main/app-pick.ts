/**
 * The element picker over Realm's own window, main's half (the renderer's is `app-pick/`): which
 * windows are picking, and the picture of a pick.
 *
 * The picture is the window's OWN capture — `webContents.capturePage` on the sender, with a rect worked
 * out here — and nothing else, so it can only ever hold Realm. It is never taken inside a browser pane's
 * native view: that capture cannot see one (it reads the window's own DOM, where a view is only the
 * placeholder under it), and a picture with a blank where the page was would be a picture that lies.
 * Where the margin round an element would reach into a view, the margin gives way on that side; where
 * the element itself lies under one, there is no picture, and the chip says so.
 *
 * And only while the person is picking: the renderer says so on the way in and out, a capture asked
 * for at any other time is refused, and realm-app's `app_act` is refused for as long as a window is
 * picking (`AppDriveHost`), so an agent's click can never land as the person's pick.
 *
 * Electron-free, like browser-controls.ts: the window, the capture and the disk are seams.
 */
import type { PickedFile } from "./attachments";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** How much of what surrounds an element the picture keeps, in DIPs on every side: enough to say where
 *  it sits — the row it is in, the edge it is against — without becoming a picture of the pane. */
export const PICTURE_MARGIN = 24;

/** What a capture came back as. `webView` is why there is no `file`, when that was the reason. */
export type AppPickShot = { file: PickedFile | null; webView: boolean };

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);
const overlaps = (a: Rect, b: Rect) => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
const clampTo = (r: Rect, size: Size): Rect => {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, width: Math.min(size.width, right(r)) - x, height: Math.min(size.height, bottom(r)) - y };
};

/**
 * The rectangle to capture for an element, in the window's DIPs: the element with `margin` of its
 * surroundings, inside the window, and clear of every native view.
 *
 * A view that only the margin reaches is cut away on the side it lies — above, below, left or right of
 * the element, whichever keeps more of the picture — so the button above a page still comes with the
 * bar it sits in. A view over the element itself means no rectangle at all. Rounded INWARD, as a view's
 * own bounds are (browser-host.ts `toViewBounds`): a picture a pixel short of its margin is invisible,
 * a picture with a pixel of a page's placeholder at its edge is not.
 */
export function pictureRect(element: Rect, window: Size, views: readonly Rect[], margin = PICTURE_MARGIN): { rect: Rect | null; webView: boolean } {
  const el = clampTo(element, window);
  if (el.width <= 0 || el.height <= 0) return { rect: null, webView: false };
  const live = views.filter((v) => v.width > 0 && v.height > 0);
  if (live.some((v) => overlaps(v, el))) return { rect: null, webView: true };
  let r = clampTo({ x: el.x - margin, y: el.y - margin, width: el.width + margin * 2, height: el.height + margin * 2 }, window);
  for (const v of live) {
    if (!overlaps(v, r)) continue;
    // Every side of the element the view lies wholly beyond is a cut that keeps the element whole.
    const cuts: Rect[] = [];
    if (bottom(v) <= el.y) cuts.push({ ...r, y: bottom(v), height: bottom(r) - bottom(v) });
    if (v.y >= bottom(el)) cuts.push({ ...r, height: v.y - r.y });
    if (right(v) <= el.x) cuts.push({ ...r, x: right(v), width: right(r) - right(v) });
    if (v.x >= right(el)) cuts.push({ ...r, width: v.x - r.x });
    r = cuts.sort((a, b) => area(b) - area(a))[0] ?? el;
  }
  const x = Math.ceil(r.x), y = Math.ceil(r.y);
  const rect = { x, y, width: Math.floor(right(r)) - x, height: Math.floor(bottom(r)) - y };
  return rect.width > 0 && rect.height > 0 ? { rect, webView: false } : { rect: null, webView: false };
}

/** The renderer's rect is in CSS px; a window zoomed with ⌘+ lays those out larger, in DIPs. */
export const toDips = (r: { x: number; y: number; w: number; h: number }, zoom: number): Rect => {
  const k = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { x: r.x * k, y: r.y * k, width: r.w * k, height: r.h * k };
};

/**
 * Lay a capture over the theme's own ground.
 *
 * The window is transparent behind its material (index.ts), so its capture carries the alpha the
 * translucent surfaces are drawn with — and an agent shown that picture sees it on whatever its viewer
 * puts behind it, where light text on a clear ground can vanish outright. Over the theme's page colour
 * it reads as the window does with Reduce Transparency on. BGRA, as `NativeImage.toBitmap` gives it;
 * premultiplied or not is read off the pixels — a channel above its own alpha cannot be premultiplied.
 */
export function flattenBgra(bgra: Uint8Array, ground: readonly [number, number, number]): Uint8Array {
  let straight = false;
  for (let i = 0; i < bgra.length && !straight; i += 4) {
    const a = bgra[i + 3]!;
    if (bgra[i]! > a || bgra[i + 1]! > a || bgra[i + 2]! > a) straight = true;
  }
  const out = new Uint8Array(bgra.length);
  const [r, g, b] = ground;
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3]! / 255;
    const k = straight ? a : 1;
    out[i] = Math.round(bgra[i]! * k + b * (1 - a));
    out[i + 1] = Math.round(bgra[i + 1]! * k + g * (1 - a));
    out[i + 2] = Math.round(bgra[i + 2]! * k + r * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** A colour the renderer sends, held to what one is: three channels, each a byte. */
export function groundOf(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  return v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? [v[0], v[1], v[2]] : null;
}

/** The parts of a window the picker needs from Electron. */
export type PickWindow = {
  /** The content area, in DIPs — what the renderer lays out into and a capture's rect is relative to. */
  size(): Size;
  /** The window's native views that are showing, in the same DIPs. */
  views(): Rect[];
  zoom(): number;
  /** The window's own capture of `rect`, as BGRA at the display's scale, or null for an empty one. */
  capture(rect: Rect): Promise<{ bgra: Uint8Array; width: number; height: number } | null>;
};

export type AppPickDeps = {
  on(channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => void): void;
  handle(channel: string, fn: (e: { sender: unknown }, ...args: unknown[]) => unknown): void;
  /** The sender's window, and a stable key for it; null for a sender that is not one of Realm's. */
  windowOf(sender: unknown): { key: number; window: PickWindow } | null;
  /** Encode and keep the picture where a pasted image goes, under the name it was asked for. */
  save(bitmap: { bgra: Uint8Array; width: number; height: number }, name: string): Promise<PickedFile>;
};

/** Which windows are picking, by their key. Read by the app drive, which stands down meanwhile. */
export class AppPicks {
  private readonly armed = new Set<number>();
  set(key: number, on: boolean): void { if (on) this.armed.add(key); else this.armed.delete(key); }
  isPicking(key: number): boolean { return this.armed.has(key); }
  any(): boolean { return this.armed.size > 0; }
}

const NAME = /^[\w.\- ]{1,120}\.png$/;

export function registerAppPick(deps: AppPickDeps, picks = new AppPicks()): AppPicks {
  deps.on("app-pick:arm", (e, on) => {
    const w = deps.windowOf(e.sender);
    if (w) picks.set(w.key, on === true);
  });
  deps.handle("app-pick:capture", async (e, rect, ground, name): Promise<AppPickShot> => {
    const w = deps.windowOf(e.sender);
    // Only for a window whose person is picking: the picture is part of their pick, never a thing the
    // renderer can ask for on its own.
    if (!w || !picks.isPicking(w.key) || !isBox(rect)) return { file: null, webView: false };
    const plan = pictureRect(toDips(rect, w.window.zoom()), w.window.size(), w.window.views());
    if (!plan.rect) return { file: null, webView: plan.webView };
    const shot = await w.window.capture(plan.rect).catch(() => null);
    if (!shot || shot.bgra.length === 0) return { file: null, webView: false };
    const flat = groundOf(ground);
    const bitmap = flat ? { ...shot, bgra: flattenBgra(shot.bgra, flat) } : shot;
    const file = await deps.save(bitmap, typeof name === "string" && NAME.test(name) ? name : "realm.png").catch(() => null);
    return { file, webView: false };
  });
  return picks;
}

function isBox(v: unknown): v is { x: number; y: number; w: number; h: number } {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}
