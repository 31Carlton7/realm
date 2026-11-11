/**
 * The picture behind an empty session, kept in its own colours: Zeron's treatment. The image is
 * printed through a 4×4 Bayer screen over 2×2 device-pixel cells, each cell its own colour at full
 * strength or a step darker, so the picture reads as a dotted screen and not as a photograph.
 *
 * Unlike the WebGL looks this never runs a loop. The screened picture is worked out once per
 * (image, face, size) and kept; a move of the prompter only re-lays the mask over the kept bitmap.
 * The picture runs behind the greeting and beside the prompter, feathers out round the prompter's
 * card, and fades to the plain ground below it. Under each run of text a contrast guard lowers the
 * picture there, and only there, until the words still read. A person's own picture shown as it is
 * takes the same path with no screen, so the feather and the guard are the same for it.
 */
import type { Rect, Rgb } from "./hero-backdrop";

export type ColorLook = {
  /** Device px per dither cell. */
  cell: number;
  /** How much darker a screened cell is than its colour; 0 shows the picture as it is. */
  depth: number;
  /** The share of the pane's height the picture is fitted to, from the top: the part below it is
   *  faded out anyway, so fitting the whole height would only crop the sides. */
  cover: number;
  /** How far the picture feathers out from the prompter's card, in CSS px. */
  feather: number;
  /** The picture starts to fade `fade[0]` CSS px below the card and is gone `fade[1]` of the pane's
   *  height below that. */
  fade: [number, number];
};

/** The screened look, and the same picture as it is: one device px a cell and no screen, but the
 *  same feather, fade and contrast guard. */
export const COLOR_LOOKS: Record<"dither-color" | "as-is", ColorLook> = {
  "dither-color": { cell: 2, depth: 0.22, cover: 0.8, feather: 32, fade: [0, 0.2] },
  "as-is": { cell: 1, depth: 0, cover: 0.8, feather: 32, fade: [0, 0.2] },
};

/** A picture to draw: its URL, and a short key that names it in the cache (a data: URL is megabytes). */
export type Picture = { key: string; url: string };

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
/** What the guard keeps in hand over a run's ratio, for the 8-bit mask and the canvas's
 *  premultiplied rounding, which tell most on the dark face's deep blues: there a run the model
 *  held at 3.1 measured 2.96 on a capture. */
const GUARD_SPARE = 0.3;

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
  const floors = samples.map((s) => Math.min(s.need + GUARD_SPARE, contrast(over(s.color, ground), ground)) - 0.005);
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
async function screened(pic: Picture, look: ColorLook, w: number, h: number): Promise<Screened & { cached: boolean }> {
  const cols = Math.ceil(w / look.cell), rows = Math.ceil(h / look.cell);
  const key = `${pic.key}|${look.cell}|${look.depth}|${look.cover}|${cols}x${rows}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const img = new Image();
  img.src = pic.url;
  await img.decode();
  const start = performance.now();
  const bitmap = document.createElement("canvas");
  bitmap.width = cols;
  bitmap.height = rows;
  const g = bitmap.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.max(cols / img.naturalWidth, (rows * look.cover) / img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  g.imageSmoothingQuality = "high";
  // Cover-fit from the top, so the sky's upper edge stays in the window as it narrows.
  g.drawImage(img, (cols - dw) / 2, 0, dw, dh);
  const data = g.getImageData(0, 0, cols, rows);
  if (look.depth > 0) ditherColor(data.data, cols, rows, look.depth);
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

/** How far (x, y) is outside a rounded rect of corner radius `r`, negative inside. */
function outside(x: number, y: number, box: Rect, r: number) {
  const qx = Math.abs(x - (box.x + box.w / 2)) - box.w / 2 + r;
  const qy = Math.abs(y - (box.y + box.h / 2)) - box.h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Where the guard lowers the picture: under `rect` it shows at `level`, rising back to whole
 *  `reach` CSS px outside it. */
export type Hush = { rect: Rect; level: number; reach: number };

/**
 * How much of the picture shows at (x, y), in the pane's CSS px of a pane `h` tall: whole down to
 * just below the prompter's `card`, then fading to the ground; none inside the card, and back to
 * whole a feather's width outside it; and lowered under each `hush`.
 */
export function pictureAlpha(x: number, y: number, h: number, card: Rect, look: Pick<ColorLook, "feather" | "fade">, hushes: Hush[] = []) {
  const has = card.w > 0 && card.h > 0;
  const from = has ? card.y + card.h + look.fade[0] : 0.4 * h;
  let a = 1 - smoothstep(from, from + look.fade[1] * h, y);
  if (has) a *= smoothstep(0, look.feather, outside(x, y, card, 16));
  for (const s of hushes) {
    if (s.level < 1) a *= s.level + (1 - s.level) * smoothstep(0, s.reach, outside(x, y, s.rect, Math.min(s.rect.h / 2, 24)));
  }
  return a;
}

/** `pictureAlpha` over the pane at a quarter of its CSS size: the mask has no edge sharper than
 *  that, so scaling it up loses nothing. */
const MASK_SCALE = 1 / 4;
function mask(look: ColorLook, card: Rect, hushes: Hush[], w: number, h: number) {
  const m = document.createElement("canvas");
  m.width = Math.ceil(w * MASK_SCALE);
  m.height = Math.ceil(h * MASK_SCALE);
  const g = m.getContext("2d")!;
  const data = g.createImageData(m.width, m.height);
  for (let j = 0; j < m.height; j++) {
    for (let i = 0; i < m.width; i++) {
      data.data[(j * m.width + i) * 4 + 3] = 255 * pictureAlpha((i + 0.5) / MASK_SCALE, (j + 0.5) / MASK_SCALE, h, card, look, hushes);
    }
  }
  g.putImageData(data, 0, 0);
  return m;
}

/** A run of text the picture could sit behind. Runs that share a `group` (the greeting's words) are
 *  lowered together, under one box, so the picture thins evenly behind the whole line. */
export type TextRun = { rect: Rect; color: GuardSample["color"]; need: number; group: string };

export type ColorRender = { screenMs: number; composeMs: number; cached: boolean; opacity: number; hushes: Hush[] };

const union = (rects: Rect[]): Rect => {
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** How far a hush reaches past its text before the picture is whole again, in CSS px. */
const HUSH_REACH = 64;

/**
 * The contrast guard: per group of runs, how far the picture must come down under it for every run
 * to keep its ratio against its worst pixel, and the opacity of the whole canvas if a run still
 * misses with those in. `under` is the picture as it will land under a rect with the given hushes,
 * one RGBA entry per cell, its alpha the mask's.
 */
export function guard(runs: TextRun[], under: (rect: Rect, hushes: Hush[]) => Uint8ClampedArray | null, ground: Rgb): { hushes: Hush[]; opacity: number } {
  const sample = (members: TextRun[], hushes: Hush[]) => members.flatMap((r) => {
    const pixels = under(r.rect, hushes);
    return pixels ? [{ pixels, color: r.color, need: r.need }] : [];
  });
  const groups = new Map<string, TextRun[]>();
  for (const r of runs) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const hushes: Hush[] = [];
  for (const members of groups.values()) {
    const level = safeOpacity(sample(members, []), ground);
    if (level < 1) hushes.push({ rect: union(members.map((m) => m.rect)), level, reach: HUSH_REACH });
  }
  return { hushes, opacity: hushes.length ? safeOpacity(sample(runs, hushes), ground) : 1 };
}

/**
 * Lays the screened picture onto `canvas`, feathered out round the prompter's `card` and down the
 * pane, and hushed under the text. The guard works the hushes out first, from the screened cells
 * and `pictureAlpha` rather than by reading the canvas back: per group of runs `texts` returns, how
 * far the picture must come down there for every run to keep its ratio against its worst pixel.
 * The canvas's own opacity is the backstop if a run still misses with the hushes in.
 */
export async function paintColorBackdrop(canvas: HTMLCanvasElement, look: ColorLook, pic: Picture, card: Rect, dpr: number,
  ground: Rgb, texts: () => TextRun[]): Promise<ColorRender | null> {
  const { width: w, height: h } = canvas;
  if (!w || !h) return null;
  const art = await screened(pic, look, w, h);
  if (canvas.width !== w || canvas.height !== h) return null;
  const start = performance.now();
  const cells = art.bitmap.getContext("2d", { willReadFrequently: true })!;
  const paneH = h / dpr, css = look.cell / dpr;
  // The picture as it will land under `rect`, one entry per cell.
  const under = (rect: Rect, hushes: Hush[]) => {
    const c0 = Math.max(0, Math.floor(rect.x / css)), r0 = Math.max(0, Math.floor(rect.y / css));
    const c1 = Math.min(art.bitmap.width, Math.ceil((rect.x + rect.w) / css)), r1 = Math.min(art.bitmap.height, Math.ceil((rect.y + rect.h) / css));
    if (c1 <= c0 || r1 <= r0) return null;
    const px = cells.getImageData(c0, r0, c1 - c0, r1 - r0).data;
    for (let j = r0; j < r1; j++) {
      for (let i = c0; i < c1; i++) {
        px[((j - r0) * (c1 - c0) + i - c0) * 4 + 3] = 255 * pictureAlpha((i + 0.5) * css, (j + 0.5) * css, paneH, card, look, hushes);
      }
    }
    return px;
  };
  const { hushes, opacity } = guard(texts(), under, ground);
  const g = canvas.getContext("2d")!;
  g.save();
  g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = false;
  g.drawImage(art.bitmap, 0, 0, art.bitmap.width * look.cell, art.bitmap.height * look.cell);
  g.imageSmoothingEnabled = true;
  g.globalCompositeOperation = "destination-in";
  g.drawImage(mask(look, card, hushes, w / dpr, h / dpr), 0, 0, w, h);
  g.restore();
  canvas.style.opacity = String(opacity);
  return { screenMs: art.ms, composeMs: performance.now() - start, cached: art.cached, opacity, hushes };
}
