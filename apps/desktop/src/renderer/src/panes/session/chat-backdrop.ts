/**
 * The picture behind a session's transcript, once it has one: the picture the empty session showed,
 * printed the same way, softened by a light blur and laid over the pane's ground at the largest share
 * at which every ink the transcript reads in keeps its ratio against every pixel of it.
 *
 * It is drawn once into an opaque 2D canvas. Nothing here runs while the transcript scrolls or
 * streams: the canvas is drawn again only when the pane changes size or the face or theme changes,
 * and the blur is in its pixels, never a backdrop filter over moving text.
 */
import type { BackgroundEffect } from "@realm/contracts";
import { BackdropRenderer, LOOKS, type Palette, type Rgb } from "./hero-backdrop";
import { COLOR_LOOKS, safeOpacity, screened, type Picture } from "./hero-backdrop-color";

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

/** `art` blurred by `radius` device px. The sharp picture stays under the blurred one, so the
 *  blur's edge, which runs out toward transparent, shows the picture rather than the ground. */
export function soften(art: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return art;
  const out = document.createElement("canvas");
  out.width = art.width;
  out.height = art.height;
  const g = out.getContext("2d")!;
  g.drawImage(art, 0, 0);
  g.filter = `blur(${radius}px)`;
  g.drawImage(art, 0, 0);
  return out;
}

/**
 * The share of the picture, laid over `ground`, at which each of `inks` holds 4.5:1 against every
 * one of `pixels` (RGBA, opaque). An ink that misses its ratio on the plain ground already is held to
 * what it had there, as the empty session's guard holds a run.
 */
export function readableShare(pixels: Uint8ClampedArray, ground: Rgb, inks: Rgb[]): number {
  return safeOpacity(inks.map((ink) => ({ pixels, color: [...ink, 1] as [number, number, number, number], need: 4.5 })), ground);
}

/** The blurred picture leaves no detail finer than its radius, so a sample every four CSS px (the
 *  empty session's mask works at the same scale) finds the same worst pixel as every pixel would. */
const SAMPLE_SCALE = 1 / 4;

/** `art`'s pixels across the band of columns `x`…`x + w` (device px) where text can stand, sampled
 *  at a quarter of their CSS size. */
export function sample(art: HTMLCanvasElement, band: { x: number; w: number }, dpr: number): Uint8ClampedArray {
  const s = document.createElement("canvas");
  s.width = Math.max(1, Math.round((band.w / dpr) * SAMPLE_SCALE));
  s.height = Math.max(1, Math.round((art.height / dpr) * SAMPLE_SCALE));
  const g = s.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(art, band.x, 0, band.w, art.height, 0, 0, s.width, s.height);
  return g.getImageData(0, 0, s.width, s.height).data;
}

/** Lays `art` over the ground at `share`, opaque, so what the transcript reads against is exactly
 *  what was measured, whatever is behind the window. */
export function paintChat(canvas: HTMLCanvasElement, art: HTMLCanvasElement, share: number, ground: Rgb) {
  const g = canvas.getContext("2d")!;
  g.globalAlpha = 1;
  g.fillStyle = `rgb(${ground.map((v) => Math.round(v * 255)).join(" ")})`;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalAlpha = share;
  g.drawImage(art, 0, 0, canvas.width, canvas.height);
  g.globalAlpha = 1;
}
