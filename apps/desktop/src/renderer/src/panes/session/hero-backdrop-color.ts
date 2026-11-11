/**
 * The picture behind an empty session, kept in its own colours: Zeron's treatment. The image is
 * printed through a 4×4 Bayer screen over 2×2 device-pixel cells, each cell its own colour at full
 * strength or a step darker, so the picture reads as a dotted screen and not as a photograph.
 *
 * Unlike the WebGL looks this never runs a loop. The screened picture is worked out once per
 * (image, face, size) and kept; a move of the prompter only re-lays the mask over the kept bitmap.
 * Around the greeting and the prompter the picture feathers out, it fades down the pane to the
 * plain ground, and a contrast guard lowers its opacity until every word over it still reads.
 */
import skyDay from "../../assets/hero-backdrops/sky-day.jpg";
import skyDusk from "../../assets/hero-backdrops/sky-dusk.jpg";
import type { Rect, Rgb } from "./hero-backdrop";

export type ColorLookId = "sky";

export type ColorLook = {
  id: ColorLookId;
  name: string;
  /** The light face's picture and the dark face's. */
  image: { light: string; dark: string };
  /** Device px per dither cell. */
  cell: number;
  /** How much darker a screened cell is than its colour. */
  depth: number;
  /** How far the picture feathers out from the greeting and the prompter, in CSS px. */
  feather: number;
  /** The picture is whole above `fade[0]` and gone below `fade[1]`, as shares of the pane's height. */
  fade: [number, number];
};

export const COLOR_LOOKS: Record<ColorLookId, ColorLook> = {
  sky: { id: "sky", name: "Sky", image: { light: skyDay, dark: skyDusk }, cell: 2, depth: 0.3, feather: 64, fade: [0.18, 0.62] },
};

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Screens `px` (RGBA, one entry per cell) in place. A cell is darkened when its Bayer threshold
 * falls under its coverage, and coverage rises as the colour darkens: a bright cloud keeps nearly
 * every cell, the blue sky round it takes a dot in three or four.
 */
export function ditherColor(px: Uint8ClampedArray, w: number, h: number, depth: number) {
  const keep = 1 - depth;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
      const cover = 0.04 + 0.6 * (1 - l) ** 1.4;
      if ((BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 < cover) {
        px[i] = px[i]! * keep;
        px[i + 1] = px[i + 1]! * keep;
        px[i + 2] = px[i + 2]! * keep;
      }
    }
  }
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
export const contrast = (a: Rgb, b: Rgb) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** A run of text over the picture: the picture's pixels under it (RGBA, as read off the canvas), its
 *  colour with alpha, and the ratio it must hold. */
export type GuardSample = { pixels: Uint8ClampedArray; color: [number, number, number, number]; need: number };

/**
 * The highest opacity, up to 1, at which every sample still meets its ratio against the worst
 * pixel behind it, the picture laid over `ground`. A run that misses its ratio on the plain ground
 * already (the chip strip's quiet ink) is held to that level instead: the picture must not make it
 * worse, and cannot make it better.
 */
export function safeOpacity(samples: GuardSample[], ground: Rgb): number {
  const over = (c: GuardSample["color"], bg: Rgb): Rgb => [0, 1, 2].map((k) => c[k]! * c[3] + bg[k]! * (1 - c[3])) as Rgb;
  const worst = (s: GuardSample, opacity: number) => {
    let min = Infinity;
    const p = s.pixels;
    for (let i = 0; i < p.length; i += 4) {
      const a = (p[i + 3]! / 255) * opacity;
      const bg: Rgb = [0, 1, 2].map((k) => ground[k]! * (1 - a) + (p[i + k]! / 255) * a) as Rgb;
      min = Math.min(min, contrast(over(s.color, bg), bg));
    }
    return min;
  };
  const floors = samples.map((s) => Math.min(s.need, contrast(over(s.color, ground), ground)) - 0.005);
  const reads = (opacity: number) => samples.every((s, i) => worst(s, opacity) >= floors[i]!);
  if (reads(1)) return 1;
  // Halve the gap to the opacity that reads, to within a percent.
  let lo = 0, hi = 1;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (reads(mid)) lo = mid; else hi = mid;
  }
  return +lo.toFixed(2);
}

type Screened = { bitmap: HTMLCanvasElement; ms: number };
const cache = new Map<string, Screened>();

/** The image screened at `w`×`h` device px, cover-fit: worked out the first time and kept after. */
async function screened(url: string, look: ColorLook, w: number, h: number): Promise<Screened & { cached: boolean }> {
  const cols = Math.ceil(w / look.cell), rows = Math.ceil(h / look.cell);
  const key = `${url}|${look.cell}|${look.depth}|${cols}x${rows}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const img = new Image();
  img.src = url;
  await img.decode();
  const start = performance.now();
  const bitmap = document.createElement("canvas");
  bitmap.width = cols;
  bitmap.height = rows;
  const g = bitmap.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.max(cols / img.naturalWidth, rows / img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  g.imageSmoothingQuality = "high";
  // Cover-fit from the top, so the sky's upper edge stays in the window as it narrows.
  g.drawImage(img, (cols - dw) / 2, 0, dw, dh);
  const data = g.getImageData(0, 0, cols, rows);
  ditherColor(data.data, cols, rows, look.depth);
  g.putImageData(data, 0, 0);
  const entry = { bitmap, ms: performance.now() - start };
  // A window resized by hand passes through many sizes; keep the last few, not every one.
  if (cache.size >= 6) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return { ...entry, cached: false };
}

const smoothstep = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of the picture shows at (x, y), in the pane's CSS px of a pane `h` tall: whole at the
 * top, fading down the pane, none inside the calm box, and back to whole a feather's width outside
 * it. The box is a rounded rect, measured by its signed distance.
 */
export function pictureAlpha(x: number, y: number, h: number, calm: Rect, look: Pick<ColorLook, "feather" | "fade">) {
  const fade = 1 - smoothstep(look.fade[0] * h, look.fade[1] * h, y);
  if (calm.w <= 0 || calm.h <= 0) return fade;
  const r = 24;
  const qx = Math.abs(x - (calm.x + calm.w / 2)) - calm.w / 2 + r;
  const qy = Math.abs(y - (calm.y + calm.h / 2)) - calm.h / 2 + r;
  const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return fade * smoothstep(0, look.feather, dist);
}

/** `pictureAlpha` over the pane, drawn at an eighth of its CSS size: the mask is that soft
 *  everywhere, so scaling it up loses nothing, and it costs a few thousand pixels. */
function mask(look: ColorLook, calm: Rect, w: number, h: number) {
  const k = 1 / 8;
  const m = document.createElement("canvas");
  m.width = Math.ceil(w * k);
  m.height = Math.ceil(h * k);
  const g = m.getContext("2d")!;
  const data = g.createImageData(m.width, m.height);
  for (let j = 0; j < m.height; j++) {
    for (let i = 0; i < m.width; i++) {
      data.data[(j * m.width + i) * 4 + 3] = 255 * pictureAlpha((i + 0.5) / k, (j + 0.5) / k, h, calm, look);
    }
  }
  g.putImageData(data, 0, 0);
  return m;
}

export type ColorRender = { screenMs: number; composeMs: number; cached: boolean; opacity: number };

/**
 * Lays the screened picture onto `canvas`, feathers it out round `calm` and down the pane, then
 * sets the canvas's opacity from the guard. `texts` reads the runs the picture could reach, in the
 * canvas's CSS px; it is asked after the mask is down, so it sees what will be behind them.
 */
export async function paintColorBackdrop(canvas: HTMLCanvasElement, look: ColorLook, dark: boolean, calm: Rect, dpr: number,
  ground: Rgb, texts: () => { rect: Rect; color: GuardSample["color"]; need: number }[]): Promise<ColorRender | null> {
  const { width: w, height: h } = canvas;
  if (!w || !h) return null;
  const art = await screened(dark ? look.image.dark : look.image.light, look, w, h);
  if (canvas.width !== w || canvas.height !== h) return null;
  const start = performance.now();
  const g = canvas.getContext("2d")!;
  g.save();
  g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = false;
  g.drawImage(art.bitmap, 0, 0, art.bitmap.width * look.cell, art.bitmap.height * look.cell);
  g.imageSmoothingEnabled = true;
  g.globalCompositeOperation = "destination-in";
  g.drawImage(mask(look, calm, w / dpr, h / dpr), 0, 0, w, h);
  g.restore();
  const samples = texts().flatMap(({ rect, color, need }) => {
    const x = Math.max(0, Math.floor(rect.x * dpr)), y = Math.max(0, Math.floor(rect.y * dpr));
    const rw = Math.min(w - x, Math.ceil(rect.w * dpr)), rh = Math.min(h - y, Math.ceil(rect.h * dpr));
    return rw > 0 && rh > 0 ? [{ pixels: g.getImageData(x, y, rw, rh).data, color, need }] : [];
  });
  const opacity = safeOpacity(samples, ground);
  canvas.style.opacity = String(opacity);
  return { screenMs: art.ms, composeMs: performance.now() - start, cached: art.cached, opacity };
}
