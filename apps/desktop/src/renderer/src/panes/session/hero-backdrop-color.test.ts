import { describe, expect, it } from "vitest";
import { contrast, ditherColor, pictureAlpha, safeOpacity, type GuardSample } from "./hero-backdrop-color";

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
  const look = { feather: 64, fade: [0.2, 0.6] as [number, number] };
  const calm = { x: 200, y: 150, w: 600, h: 300 };

  it("shows nothing inside the calm box, up to its edge", () => {
    expect(pictureAlpha(500, 300, 900, calm, look)).toBe(0);
    expect(pictureAlpha(201, 151 + 30, 900, calm, look)).toBe(0);
    expect(pictureAlpha(500, 449, 900, calm, look)).toBe(0);
  });

  it("feathers back to the whole picture a feather's width out", () => {
    const near = pictureAlpha(200 - 16, 160, 900, calm, look), far = pictureAlpha(200 - 64, 160, 900, calm, look);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
    expect(far).toBeCloseTo(1, 5);
  });

  it("fades down the pane to the ground", () => {
    const none = { x: 0, y: 0, w: 0, h: 0 };
    expect(pictureAlpha(10, 100, 900, none, look)).toBe(1);
    expect(pictureAlpha(10, 360, 900, none, look)).toBeCloseTo(0.5, 5);
    expect(pictureAlpha(10, 600, 900, none, look)).toBe(0);
  });
});
