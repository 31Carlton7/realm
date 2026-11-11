import { describe, expect, it } from "vitest";
import { COLOR_LOOKS, contrast, ditherColor, guard, pictureAlpha, safeOpacity, type GuardSample, type Hush, type TextRun } from "./hero-backdrop-color";
import type { Rect, Rgb } from "./hero-backdrop";

const fill = (w: number, h: number, rgb: [number, number, number]) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) px.set([...rgb, 255], i);
  return px;
};
const darkened = (px: Uint8ClampedArray, rgb: [number, number, number]) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] !== rgb[0]) n++;
  return n / (px.length / 4);
};

describe("ditherColor", () => {
  it("keeps each cell's colour, at full strength or a step darker", () => {
    const sky: [number, number, number] = [92, 128, 237];
    const px = fill(8, 8, sky);
    ditherColor(px, 8, 8, 0.3);
    const seen = new Set<string>();
    for (let i = 0; i < px.length; i += 4) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    expect([...seen].sort()).toEqual(["64,90,166", "92,128,237"].sort());
  });

  it("screens a dark colour more densely than a bright one", () => {
    const cloud: [number, number, number] = [250, 230, 220], sky: [number, number, number] = [92, 128, 237];
    const a = fill(16, 16, cloud), b = fill(16, 16, sky);
    ditherColor(a, 16, 16, 0.3);
    ditherColor(b, 16, 16, 0.3);
    expect(darkened(a, cloud)).toBeLessThan(darkened(b, sky));
    expect(darkened(b, sky)).toBeGreaterThan(0.2);
  });

  it("repeats on a 4×4 tile", () => {
    const px = fill(8, 8, [128, 128, 128]);
    ditherColor(px, 8, 8, 0.3);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      expect(px[(y * 8 + x) * 4]).toBe(px[((y + 4) * 8 + x + 4) * 4]);
    }
  });
});

describe("safeOpacity", () => {
  const ground: [number, number, number] = [1, 1, 1];
  const ink: GuardSample["color"] = [0.1, 0.1, 0.12, 1];
  const art = (rgb: [number, number, number], alpha = 255) => {
    const px = fill(4, 4, rgb);
    for (let i = 3; i < px.length; i += 4) px[i] = alpha;
    return px;
  };

  it("leaves the picture whole when nothing is behind the words", () => {
    expect(safeOpacity([{ pixels: art([0, 0, 0], 0), color: ink, need: 3 }], ground)).toBe(1);
  });

  it("lowers the picture until dark words over a dark patch read at 3:1", () => {
    const o = safeOpacity([{ pixels: art([40, 40, 90]), color: ink, need: 3 }], ground);
    expect(o).toBeGreaterThan(0);
    expect(o).toBeLessThan(1);
    const a = o, bg: [number, number, number] = [1 - a + (40 / 255) * a, 1 - a + (40 / 255) * a, 1 - a + (90 / 255) * a];
    expect(contrast([0.1, 0.1, 0.12], bg)).toBeGreaterThanOrEqual(3 - 0.01);
  });

  it("holds quiet text already under its ratio to the level it has on the plain ground", () => {
    const quiet: GuardSample["color"] = [0.55, 0.55, 0.58, 1];
    const base = contrast([0.55, 0.55, 0.58], ground);
    expect(base).toBeLessThan(4.5);
    expect(safeOpacity([{ pixels: art([255, 255, 255]), color: quiet, need: 4.5 }], ground)).toBe(1);
    expect(safeOpacity([{ pixels: art([200, 150, 220]), color: quiet, need: 4.5 }], ground)).toBeLessThan(0.05);
  });
});

describe("pictureAlpha", () => {
  const look = { feather: 32, fade: [0, 0.2] as [number, number] };
  const card = { x: 200, y: 300, w: 600, h: 120 };

  it("runs the whole picture above the card, where the greeting sits", () => {
    expect(pictureAlpha(500, 200, 900, card, look)).toBe(1);
    expect(pictureAlpha(500, 300 - 32, 900, card, look)).toBeCloseTo(1, 5);
  });

  it("shows nothing on the card, and feathers back within a feather's width of it", () => {
    expect(pictureAlpha(500, 360, 900, card, look)).toBe(0);
    const near = pictureAlpha(200 - 12, 360, 900, card, look), far = pictureAlpha(200 - 32, 360, 900, card, look);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
    expect(far).toBeCloseTo(1, 5);
  });

  it("starts to fade at the card's foot and is gone a fifth of the pane below it", () => {
    expect(pictureAlpha(50, 420, 900, card, look)).toBe(1);
    expect(pictureAlpha(50, 420 + 90, 900, card, look)).toBeCloseTo(0.5, 5);
    expect(pictureAlpha(50, 420 + 180, 900, card, look)).toBe(0);
  });

  it("lowers the picture under a hush to its level, and only near it", () => {
    const hush = { rect: { x: 300, y: 100, w: 400, h: 40 }, level: 0.3, reach: 40 };
    expect(pictureAlpha(500, 120, 900, card, look, [hush])).toBeCloseTo(0.3, 5);
    expect(pictureAlpha(500, 100 - 40, 900, card, look, [hush])).toBeCloseTo(1, 5);
    expect(pictureAlpha(50, 120, 900, card, look, [hush])).toBe(1);
  });
});

describe("a picture shown as it is", () => {
  const W = 1000, H = 800;
  const look = COLOR_LOOKS["as-is"];
  const card: Rect = { x: 200, y: 400, w: 600, h: 120 };
  // Busy on purpose: saturated colour changing every pixel, bright and dark side by side.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const busy = Array.from({ length: W * H }, () => [rand() > 0.5 ? 255 : 0, Math.floor(rand() * 256), rand() > 0.5 ? 255 : 20]);
  const under = (rect: Rect, hushes: Hush[]) => {
    const x0 = Math.floor(rect.x), y0 = Math.floor(rect.y), x1 = Math.ceil(rect.x + rect.w), y1 = Math.ceil(rect.y + rect.h);
    const px = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = ((y - y0) * (x1 - x0) + x - x0) * 4;
      px.set([...busy[y * W + x]!, 255 * pictureAlpha(x + 0.5, y + 0.5, H, card, look, hushes)], i);
    }
    return px;
  };
  const worst = (run: TextRun, hushes: Hush[], opacity: number, ground: Rgb) => {
    const p = under(run.rect, hushes);
    let min = Infinity;
    for (let i = 0; i < p.length; i += 4) {
      const a = (p[i + 3]! / 255) * opacity;
      const bg = [0, 1, 2].map((k) => ground[k]! * (1 - a) + (p[i + k]! / 255) * a) as Rgb;
      min = Math.min(min, contrast(run.color.slice(0, 3) as Rgb, bg));
    }
    return min;
  };

  for (const face of [
    { name: "light", ground: [0.98, 0.98, 0.98] as Rgb, ink: [0.1, 0.1, 0.12] as Rgb, quiet: [0.33, 0.33, 0.37] as Rgb },
    { name: "dark", ground: [0.09, 0.09, 0.1] as Rgb, ink: [0.95, 0.95, 0.96] as Rgb, quiet: [0.7, 0.7, 0.74] as Rgb },
  ]) {
    it(`keeps every run of text at its ratio over a busy picture, ${face.name}`, () => {
      expect(look.depth).toBe(0);
      const runs: TextRun[] = [
        { rect: { x: 300, y: 250, w: 400, h: 40 }, color: [...face.ink, 1], need: 3, group: "greeting" },
        { rect: { x: 420, y: 310, w: 160, h: 16 }, color: [...face.quiet, 1], need: 4.5, group: "1" },
      ];
      // Unguarded, the picture would bury the words.
      for (const r of runs) expect(worst(r, [], 1, face.ground)).toBeLessThan(2);
      const { hushes, opacity } = guard(runs, under, face.ground);
      expect(hushes.length).toBeGreaterThan(0);
      for (const r of runs) expect(worst(r, hushes, opacity, face.ground)).toBeGreaterThanOrEqual(r.need);
    });
  }
});
