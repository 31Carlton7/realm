/**
 * The picture behind a session's transcript, once it has one: the picture the empty session showed,
 * printed the same way, softened by a light blur, and each pixel taken toward the pane's ground only
 * as far as every ink the transcript reads in needs to keep its ratio over it. Words can scroll over
 * any pixel, so every pixel answers for them; the dark of a night picture stays whole while its
 * bright clouds come down.
 *
 * It is drawn once into an opaque 2D canvas. Nothing here runs while the transcript scrolls or
 * streams: the canvas is drawn again only when the pane changes size or the face or theme changes,
 * and the blur is in its pixels, never a backdrop filter over moving text.
 */
import type { BackgroundEffect } from "@realm/contracts";
import { BackdropRenderer, LOOKS, type Palette, type Rgb } from "./hero-backdrop";
import { COLOR_LOOKS, GUARD_SPARE, contrast, luminance, screened, type Picture } from "./hero-backdrop-color";

/** The look's picture at `w`×`h` device px, printed as the empty session prints it. */
export async function printed(effect: BackgroundEffect | "as-is", pic: Picture, pal: Palette, w: number, h: number, dpr: number): Promise<HTMLCanvasElement> {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d")!;
  if (effect === "dither" || effect === "halftone") {
    const gl = document.createElement("canvas");
    gl.width = w;
    gl.height = h;
    const r = new BackdropRenderer(gl);
    try {
      await r.load(pic.url);
      // Held still, with no calm zone: there is no greeting behind a transcript to clear.
      r.draw(LOOKS[effect], pal, { x: -1e5, y: -1e5, w: 1, h: 1 }, dpr, 0);
      g.drawImage(gl, 0, 0);
    } finally {
      r.destroy();
    }
  } else {
    const look = COLOR_LOOKS[effect];
    const art = await screened(pic, look, w, h);
    g.imageSmoothingEnabled = false;
    g.drawImage(art.bitmap, 0, 0, art.bitmap.width * look.cell, art.bitmap.height * look.cell);
  }
  return out;
}

/** The chat's picture is kept at one canvas pixel to every `SCALE` CSS px: it is blurred well past
 *  that, so a finer canvas would hold no more detail, only more pixels to hush and to composite. */
export const SCALE = 2;

/** `art` over `ground`, brought down to `w`×`h` and blurred by `radius` of those pixels. The sharp
 *  picture goes under the blurred one, so the blur's edge, which runs out toward transparent, shows
 *  the picture rather than the ground. */
export function soften(art: HTMLCanvasElement, ground: Rgb, w: number, h: number, radius: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = `rgb(${ground.map((v) => Math.round(v * 255)).join(" ")})`;
  g.fillRect(0, 0, w, h);
  g.drawImage(art, 0, 0, w, h);
  if (radius > 0) {
    g.filter = `blur(${radius}px)`;
    g.drawImage(art, 0, 0, w, h);
    g.filter = "none";
  }
  return out;
}

/**
 * The luminances a pixel behind the transcript may have, so that every one of `inks` keeps its
 * ratio over it: 4.5:1, with the guard's spare. An ink that already misses 4.5:1 on the plain ground
 * (the light face's link blue, 3.64:1) is held to 3:1 with the spare, or to what it had if that is
 * lower; holding it to its plain ratio would leave no picture at all. `links` are held to that 3:1
 * however much more they have on the plain ground.
 */
export function readableRange(ground: Rgb, inks: Rgb[], links: Rgb[] = []): [number, number] {
  const lg = luminance(ground);
  let lo = 0, hi = 1;
  for (const ink of [...inks, ...links]) {
    const plain = contrast(ink, ground);
    // A link is held to 3:1 over the picture whatever it has on the plain ground: the light face's
    // links go a step deeper over a picture so that this costs the picture less, not the link.
    const need = links.includes(ink) || plain < 4.5 ? 3 : 4.5;
    const floor = Math.min(need + GUARD_SPARE, plain) - 0.005;
    const li = luminance(ink);
    if (li > lg) hi = Math.min(hi, (li + 0.05) / floor - 0.05);
    else lo = Math.max(lo, floor * (li + 0.05) - 0.05);
  }
  return [Math.min(lo, lg), Math.max(hi, lg)];
}

/**
 * Takes each pixel of `px` (RGBA, opaque) toward `ground` only as far as it must for its luminance to
 * be inside `range`: a pixel already there keeps all of its colour, and one too bright or too dark
 * keeps the most of it that still lets the words read.
 */
export function hush(px: Uint8ClampedArray, ground: Rgb, [lo, hi]: [number, number]) {
  const p: Rgb = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    p[0] = px[i]! / 255; p[1] = px[i + 1]! / 255; p[2] = px[i + 2]! / 255;
    const keep = keepShare(p, ground, lo, hi);
    if (keep === 1) continue;
    for (let k = 0; k < 3; k++) px[i + k] = Math.round((ground[k]! + (p[k]! - ground[k]!) * keep) * 255);
  }
}

const mixed: Rgb = [0, 0, 0];
/** The largest share of `p` over `ground` whose luminance is inside [lo, hi], to 1/256. The ground
 *  fits by construction, so the search always ends on a share that fits. */
function keepShare(p: Rgb, ground: Rgb, lo: number, hi: number): number {
  const fits = (a: number) => {
    for (let k = 0; k < 3; k++) mixed[k] = ground[k]! + (p[k]! - ground[k]!) * a;
    const l = luminance(mixed);
    return l >= lo && l <= hi;
  };
  if (fits(1)) return 1;
  let keep = 0, miss = 1;
  for (let step = 0; step < 8; step++) {
    const a = (keep + miss) / 2;
    if (fits(a)) keep = a; else miss = a;
  }
  return keep;
}

/**
 * The transcript's track (the owner, 11-17: on send the picture "shouldn't get so much darker"; the
 * track "where the text and all the content shows up should remain a little bit darker, have a bit
 * of a blur around it, but very, very slight"). The words only ever sit in the transcript's column,
 * so the column, `pad` wider each side, takes the whole hush, a faint step toward the ground
 * (`tint`: darker in dark, lighter in light) and the whole blur. Past it the picture keeps its light:
 * `sideHush` of the hush and `sideBlur` of the blur, reached over a smooth `feather`, so the track has
 * no edge. Sizes in CSS px; the still and the loop's shader both read these.
 */
export const TRACK = { pad: 24, feather: 120, tint: 0.1, sideHush: 0.3, sideBlur: 0.4 } as const;

/** The track in a backdrop canvas's px (`k` canvas px to a CSS px), from the pane's column. */
export type Track = { x0: number; x1: number; feather: number };
export function trackOf(pane: Element, box: { left: number }, k: number): Track | undefined {
  const col = pane.querySelector(".transcript-col")?.getBoundingClientRect();
  if (!col?.width) return undefined;
  return { x0: (col.left - box.left - TRACK.pad) * k, x1: (col.right - box.left + TRACK.pad) * k, feather: TRACK.feather * k };
}

/** How much of the track a pixel column at `x` is in: 1 across it, easing to 0 over the feather. */
export function trackWeight(x: number, t: Track): number {
  const d = Math.max(t.x0 - x, x - t.x1);
  if (d <= 0) return 1;
  const s = Math.min(1, d / t.feather);
  return 1 - s * s * (3 - 2 * s);
}

/**
 * The chat's still through the track: `px` is the blurred picture and `sharp` the same picture
 * unblurred, both RGBA `w` px wide. Inside the track this is hush() over the blurred picture taken
 * `tint` toward the ground; outside it the picture is mostly sharp and hushed by `sideHush`. With no
 * track (no column yet) every pixel is the track.
 */
export function hushTrack(px: Uint8ClampedArray, sharp: Uint8ClampedArray, w: number, ground: Rgb, [lo, hi]: [number, number], t?: Track) {
  const p: Rgb = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    const wt = t ? trackWeight(((i / 4) % w) + 0.5, t) : 1;
    const blur = TRACK.sideBlur + (1 - TRACK.sideBlur) * wt, tint = t ? TRACK.tint * wt : 0;
    for (let k = 0; k < 3; k++) {
      const c = (sharp[i + k]! + (px[i + k]! - sharp[i + k]!) * blur) / 255;
      p[k] = c + (ground[k]! - c) * tint;
    }
    const keep = keepShare(p, ground, lo, hi);
    const share = TRACK.sideHush + (1 - TRACK.sideHush) * wt;
    const a = 1 - share * (1 - keep);
    for (let k = 0; k < 3; k++) px[i + k] = Math.round((ground[k]! + (p[k]! - ground[k]!) * a) * 255);
  }
}
