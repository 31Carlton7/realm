// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cutFromGround, groundMask, opaqueBounds, shrink, squareAround } from "./lib/icons3d-matte.mjs";

type Rgba = { width: number; height: number; data: Uint8ClampedArray };

const CREAM = [243, 230, 204];
const SIZE = 64;

/**
 * A render as the prompt asks for it, built in code: a cream disc on flat white with an edge
 * anti-aliased the way a renderer blends it (coverage × colour + the rest × white), a square hole
 * through it where the white shows, and a two-pixel near-white highlight inside it.
 */
function fixture(): { img: Rgba; coverage: Float64Array } {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const coverage = new Float64Array(SIZE * SIZE);
  const cx = 32, cy = 32, r = 20;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let inside = 0;
    for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
      const dx = x + (sx + 0.5) / 8 - cx, dy = y + (sy + 0.5) / 8 - cy;
      if (dx * dx + dy * dy <= r * r) inside++;
    }
    let cov = inside / 64;
    if (x >= 36 && x < 42 && y >= 22 && y < 28) cov = 0;   // the hole
    coverage[y * SIZE + x] = cov;
    const i = (y * SIZE + x) * 4;
    for (let k = 0; k < 3; k++) data[i + k] = Math.round(CREAM[k]! * cov + 255 * (1 - cov));
    data[i + 3] = 255;
  }
  for (const [x, y] of [[26, 32], [27, 32]]) data.set([253, 253, 253], (y! * SIZE + x!) * 4);
  return { img: { width: SIZE, height: SIZE, data }, coverage };
}

const px = (img: Rgba, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("cutting a render off its white ground", () => {
  const { img, coverage } = fixture();
  const cut = cutFromGround(img, { minHole: 0.005 }) as Rgba;

  it("clears the ground", () => {
    expect(px(cut, 2, 2)[3]).toBe(0);
    expect(px(cut, 60, 33)[3]).toBe(0);
  });

  // Mutant killed: colour-to-alpha over every pixel (no regions) — the cream comes out 20% opaque.
  it("keeps a pale part of the object fully opaque and its own colour", () => {
    expect(px(cut, 32, 40)).toEqual([...CREAM, 255]);
    expect(px(cut, 20, 32)).toEqual([...CREAM, 255]);
  });

  // Mutant killed: only border-touching regions count as ground — the hole stays opaque white.
  it("clears a hole through the object", () => {
    expect(px(cut, 38, 24)[3]).toBe(0);
  });

  // Mutant killed: every near-white region is ground (minHole 0) — the highlight punches a hole.
  it("keeps a small highlight inside the object", () => {
    expect(px(cut, 26, 32)).toEqual([253, 253, 253, 255]);
  });

  // Mutant killed: the edge band copied as rendered rather than unblended — its colour is the
  // cream washed toward white, which is the fringe that shows on a dark page.
  it("unblends the anti-aliased edge: alpha is the coverage and the colour is the object's, not white's", () => {
    let checked = 0;
    for (let p = 0; p < SIZE * SIZE; p++) {
      const cov = coverage[p]!;
      const x = p % SIZE, y = Math.floor(p / SIZE);
      if (cov < 0.3 || cov > 0.9 || (x >= 35 && x <= 42 && y >= 21 && y <= 28)) continue;
      const [r, g, b, a] = px(cut, x, y);
      expect(Math.abs(a! / 255 - cov), `alpha at ${x},${y}`).toBeLessThan(0.08);
      expect(Math.max(Math.abs(r! - CREAM[0]!), Math.abs(g! - CREAM[1]!), Math.abs(b! - CREAM[2]!)), `colour at ${x},${y}`).toBeLessThan(8);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("finds the ground as regions: the border's and the hole's, not the highlight", () => {
    const mask = groundMask(img, { minHole: 0.005 });
    expect(mask[0]).toBe(1);
    expect(mask[24 * SIZE + 38]).toBe(1);
    expect(mask[32 * SIZE + 26]).toBe(0);
  });
});

describe("a ground that is not exactly one white", () => {
  // Mutant killed: ground pixels kept at the alpha colour-to-alpha gives them — on a ground of 254, every
  // 255 came out opaque white, a frame round the whole render that the trim could not see past.
  it("clears all of it, so the trim finds the object's own edge", () => {
    const { img } = fixture();
    let seed = 7;
    const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 3; };
    for (let p = 0; p < SIZE * SIZE; p++) {
      if (img.data[p * 4] !== 255) continue;
      const v = 253 + noise();
      img.data.set([v, v, v], p * 4);
    }
    const cut = cutFromGround(img, { minHole: 0.005 }) as Rgba;
    const box = opaqueBounds(cut)!;
    expect(box.left).toBeGreaterThanOrEqual(11);
    expect(box.left + box.width).toBeLessThanOrEqual(53);
    expect(px(cut, 0, 0)[3]).toBe(0);
    expect(px(cut, 32, 40)).toEqual([...CREAM, 255]);
  });
});

describe("squaring and shrinking the cut", () => {
  const cut = cutFromGround(fixture().img, { minHole: 0.005 }) as Rgba;

  // Mutant killed: the object copied to the square's corner instead of its centre.
  it("trims to the object, centres it on a square and leaves the padding clear", () => {
    const sq = squareAround(cut, { pad: 0.1 }) as Rgba;
    const box = opaqueBounds(cut)!;
    expect(sq.width).toBe(sq.height);
    expect(sq.width).toBe(Math.ceil(Math.max(box.width, box.height) / 0.8));
    const inSquare = opaqueBounds(sq)!;
    expect(Math.abs(inSquare.left - (sq.width - inSquare.left - inSquare.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(inSquare.top - (sq.height - inSquare.top - inSquare.height))).toBeLessThanOrEqual(1);
    expect(inSquare.left).toBeGreaterThanOrEqual(Math.floor(sq.width * 0.1));
  });

  it("refuses a picture with nothing left in it", () => {
    const clear = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    expect(() => squareAround(clear)).toThrow(/nothing left/);
  });

  // Mutant killed: averaging straight alpha — the clear half's black darkens the red to 128.
  it("averages in premultiplied alpha, so an edge keeps its colour", () => {
    const half = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]) };
    expect(Array.from((shrink(half, 1) as Rgba).data)).toEqual([255, 0, 0, 128]);
  });

  it("shrinks by area, so a 3:1 step averages exactly three pixels a side", () => {
    const data = new Uint8ClampedArray(6 * 6 * 4);
    for (let p = 0; p < 36; p++) data.set(p % 6 < 3 ? [0, 0, 255, 255] : [255, 255, 255, 255], p * 4);
    const small = shrink({ width: 6, height: 6, data }, 2) as Rgba;
    expect(px(small, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(px(small, 1, 1)).toEqual([255, 255, 255, 255]);
  });
});
