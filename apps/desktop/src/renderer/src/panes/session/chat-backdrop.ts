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
 * lower; holding it to its plain ratio would leave no picture at all.
 */
export function readableRange(ground: Rgb, inks: Rgb[]): [number, number] {
  const lg = luminance(ground);
  let lo = 0, hi = 1;
  for (const ink of inks) {
    const plain = contrast(ink, ground);
    const floor = Math.min((plain >= 4.5 ? 4.5 : 3) + GUARD_SPARE, plain) - 0.005;
    const li = luminance(ink);
    if (li > lg) hi = Math.min(hi, (li + 0.05) / floor - 0.05);
    else lo = Math.max(lo, floor * (li + 0.05) - 0.05);
  }
  return [Math.min(lo, lg), Math.max(hi, lg)];
}

/**
 * Takes each pixel of `px` (RGBA, opaque) toward `ground` only as far as it must for its luminance to
 * be inside `range`: a pixel already there keeps all of its colour, and one too bright or too dark
 * keeps the most of it that still lets the words read. Returns the share of pixels it lowered.
 */
export function hush(px: Uint8ClampedArray, ground: Rgb, [lo, hi]: [number, number]): number {
  let lowered = 0;
  const p: Rgb = [0, 0, 0], m: Rgb = [0, 0, 0];
  const mix = (a: number) => {
    for (let k = 0; k < 3; k++) m[k] = ground[k]! + (p[k]! - ground[k]!) * a;
    return m;
  };
  const fits = (rgb: Rgb) => { const l = luminance(rgb); return l >= lo && l <= hi; };
  for (let i = 0; i < px.length; i += 4) {
    p[0] = px[i]! / 255; p[1] = px[i + 1]! / 255; p[2] = px[i + 2]! / 255;
    if (fits(p)) continue;
    // The ground fits by construction, so the search keeps a share that fits.
    let keep = 0, miss = 1;
    for (let step = 0; step < 8; step++) {
      const a = (keep + miss) / 2;
      if (fits(mix(a))) keep = a; else miss = a;
    }
    mix(keep);
    px[i] = Math.round(m[0] * 255); px[i + 1] = Math.round(m[1] * 255); px[i + 2] = Math.round(m[2] * 255);
    lowered++;
  }
  return px.length ? lowered / (px.length / 4) : 0;
}

/** `art` with every pixel hushed into `range` over `ground`, in place. Returns the share lowered. */
export function hushCanvas(art: HTMLCanvasElement, ground: Rgb, range: [number, number]): number {
  const g = art.getContext("2d", { willReadFrequently: true })!;
  const data = g.getImageData(0, 0, art.width, art.height);
  const lowered = hush(data.data, ground, range);
  g.putImageData(data, 0, 0);
  return lowered;
}
