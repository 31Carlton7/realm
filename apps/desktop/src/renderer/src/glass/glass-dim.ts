/**
 * How far dark Glass takes the picture under it toward black (`--glass-dim`, tokens.css). macOS's
 * glass stays about as bright as the picture behind it and carries its colour; a fixed dim made ours
 * navy over Synth Coast's sun and near black over its sky. So the dim follows the picture: worked out
 * once each time the picture is drawn, from the picture where the prompter and its pickers sit, as
 * the least that keeps the words over it at their ratios. A dark picture takes none, and a bright one
 * as much as its words need, up to `GLASS_DIM_MAX`. Until a picture has been measured the glass takes
 * the picture's own dim (`--picture-dim`). Light glass keeps that dim and never reads this one.
 */
import type { Rgb } from "../panes/session/hero-backdrop";
import { GUARD_SPARE, luminance } from "../panes/session/hero-backdrop-color";

/** A word on the glass: its ink, the ratio it must hold over the picture, and whether it can stand
 *  on the tint (a lit row, a well) rather than on the glass itself. */
export type GlassInk = { color: Rgb; need: number; onTint?: boolean };
/** A see-through tint laid on the glass under some of its words (the lit row, a well). */
export type GlassTint = { color: Rgb; alpha: number };

/** The most the glass is dimmed, whatever the picture: the cap for an ink no dim could hold. */
export const GLASS_DIM_MAX = 0.8;
/** The share of the picture, brightest first, let past the ceiling: a star or a glint, which the
 *  frost spreads to nothing. */
export const GLASS_DIM_TAIL = 0.01;
/** How far above and below the prompter a picker reaches, in CSS px. */
export const PICKER_REACH = 480;
/** One sample per this many CSS px, which the glass's own frost blurs together anyway. */
const SAMPLE_PX = 8;

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** `saturate(s) brightness(k)` as CSS draws them on an sRGB colour, 0 to 1 (Filter Effects' matrices). */
export function toned([r, g, b]: Rgb, s: number, k: number): Rgb {
  const sat = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
  return sat.map(([a, c, d]) => clamp(clamp(a! * r + c! * g + d! * b) * k)) as Rgb;
}

const tinted = (c: Rgb, t: GlassTint | null): Rgb => (t ? c.map((v, i) => v * (1 - t.alpha) + t.color[i]! * t.alpha) as Rgb : c);

/**
 * The least dim, from 0 to `GLASS_DIM_MAX`, at which every ink keeps its ratio (with the guard's
 * spare) over the picture's `samples`, all but the brightest `GLASS_DIM_TAIL` of them, once the
 * glass has saturated them by `saturate`, and laid `tint` on them under the words that can stand on
 * it. Dark glass's words are lighter than what is under them.
 */
export function glassDim(samples: readonly Rgb[], inks: readonly GlassInk[], saturate: number, tint: GlassTint | null = null): number {
  if (!samples.length || !inks.length) return 0;
  const ceiling = ({ color, need }: GlassInk) => (luminance(color) + 0.05) / (need + GUARD_SPARE) - 0.05;
  const lit = samples.map((c) => toned(c, saturate, 1)).sort((a, b) => luminance(b) - luminance(a));
  const bright = lit[Math.floor(lit.length * GLASS_DIM_TAIL)]!;
  const fits = (k: number) => inks.every((ink) => luminance(tinted(toned(bright, 1, k), ink.onTint ? tint : null)) <= ceiling(ink));
  if (fits(1)) return 0;
  let keep = 0, over = 1;
  for (let i = 0; i < 16; i++) {
    const k = (keep + over) / 2;
    if (fits(k)) keep = k;
    else over = k;
  }
  return Math.min(GLASS_DIM_MAX, 1 - keep);
}

/**
 * The picture `source` draws over `pane` (it covers the pane, at `source.width` px across), laid on
 * `ground` at `opacity`, as colours from 0 to 1, where the glass goes: the prompter's dock widened by
 * a picker's reach above and below it, one sample per `SAMPLE_PX`. Read straight after a draw, so a
 * WebGL canvas still holds its frame.
 */
export function pictureUnderGlass(source: HTMLCanvasElement, pane: Element, ground: Rgb, opacity = 1): Rgb[] {
  const box = pane.getBoundingClientRect();
  const dock = pane.querySelector(".composer-dock")?.getBoundingClientRect();
  if (!dock || !box.width || !box.height || !source.width) return [];
  const x0 = Math.max(0, dock.left - box.left - SAMPLE_PX * 4), x1 = Math.min(box.width, dock.right - box.left + SAMPLE_PX * 4);
  const y0 = Math.max(0, dock.top - box.top - PICKER_REACH), y1 = Math.min(box.height, dock.bottom - box.top + PICKER_REACH);
  if (x1 <= x0 || y1 <= y0) return [];
  const w = Math.ceil((x1 - x0) / SAMPLE_PX), h = Math.ceil((y1 - y0) / SAMPLE_PX);
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const g = small.getContext("2d", { willReadFrequently: true });
  if (!g) return [];
  const k = source.width / box.width;
  g.fillStyle = `rgb(${ground.map((c) => c * 255).join(" ")})`;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = opacity;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const out: Rgb[] = [];
  for (let i = 0; i < px.length; i += 4) out.push([px[i]! / 255, px[i + 1]! / 255, px[i + 2]! / 255]);
  return out;
}

/** The words on dark glass over a picture: typed text and labels in `--ink` at 4.5:1, the quiet words
 *  and the placeholder in `--ink-2` at 3:1, both of which a picker sets on its lit row and its
 *  account's well, and the picker's level in `--accent` at 3:1 on the glass (styles.css, "Glass").
 *  Read in the pane, so a theme's inks arrive as colours. */
function glassInks(pane: Element, resolve: (css: string) => Rgb): GlassInk[] {
  const s = getComputedStyle(pane);
  return [
    { color: resolve(s.getPropertyValue("--ink")), need: 4.5, onTint: true },
    { color: resolve(s.getPropertyValue("--ink-2")), need: 3, onTint: true },
    { color: resolve(s.getPropertyValue("--accent")), need: 3 },
  ];
}

/** The picker's lit row (`--glass-row`), the lightest tint a word on the glass stands on, read as
 *  its colour and alpha off one pixel laid over black and over white. */
function glassTint(pane: Element): GlassTint | null {
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  const over = (ground: string) => {
    g.fillStyle = ground;
    g.fillRect(0, 0, 1, 1);
    g.fillStyle = getComputedStyle(pane).getPropertyValue("--glass-row");
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0]! / 255, d[1]! / 255, d[2]! / 255];
  };
  const black = over("#000"), white = over("#fff");
  const alpha = 1 - (white[0]! - black[0]!);
  return alpha > 0 ? { color: black.map((v) => Math.min(1, v / alpha)) as Rgb, alpha } : null;
}

/** Measures the picture `source` has just drawn and sets the pane's `--glass-dim`, in the dark face. */
export function setGlassDim(pane: HTMLElement, source: HTMLCanvasElement, ground: Rgb, resolve: (css: string) => Rgb, opacity = 1) {
  if (document.documentElement.getAttribute("data-mode") === "light") return;
  const samples = pictureUnderGlass(source, pane, ground, opacity);
  if (!samples.length) return;
  const saturate = parseFloat(getComputedStyle(pane).getPropertyValue("--glass-saturate")) || 1;
  pane.style.setProperty("--glass-dim", glassDim(samples, glassInks(pane, resolve), saturate, glassTint(pane)).toFixed(3));
}
