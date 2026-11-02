import { describe, expect, it } from "vitest";
import { contrast, hexToOklch, oklchToHex, parseOklch } from "@realm/contracts";
import { deriveVars, REALM_SEED } from "../themes";
import { BADGE_OKLCH, bodyOklch, EYE_OKLCH, TEAMMATE_COLORS, type Face, type TeammateColor } from "./palette";
import { SHAPE_GEO, TEAMMATE_SHAPES, type TeammateShape } from "./shapes";
import { eyeStrokes, leadStar } from "./TeammateIcon";

const FACES: Face[] = ["dark", "light"];
const COLORS = Object.keys(TEAMMATE_COLORS) as TeammateColor[];
const SHAPES = Object.keys(TEAMMATE_SHAPES) as TeammateShape[];
const GROUNDS = ["--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2"];
const SIZES = [16, 20, 24, 32, 64];

describe("teammate colours", () => {
  it("are the twelve the contract names", () => {
    expect(COLORS).toEqual(["red", "orange", "amber", "yellow", "lime", "green", "teal", "sky", "blue", "violet", "pink", "graphite"]);
    expect(SHAPES).toEqual(["circle", "flower", "squircle", "pill", "triangle", "hexagon", "cloud", "drop"]);
  });

  it("are drawable in sRGB on both faces, so no display clips one into its neighbour", () => {
    for (const face of FACES) for (const id of COLORS) {
      const o = bodyOklch(id, face);
      expect(hexToOklch(oklchToHex(o)).c, `${id} ${face}`).toBeCloseTo(o.c, 2);
    }
  });

  it("hold a body at 3 : 1 on every ground and the eyes at 3 : 1 on the body, in both faces", () => {
    for (const face of FACES) {
      const vars = deriveVars(REALM_SEED[face], face);
      for (const id of COLORS) {
        const body = bodyOklch(id, face);
        for (const g of GROUNDS) expect(contrast(body, parseOklch(vars[g]!)), `${id} ${face} on ${g}`).toBeGreaterThanOrEqual(3);
        expect(contrast(EYE_OKLCH[face], body), `${id} ${face} eyes`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("set the Lead's star off every ground", () => {
    for (const face of FACES) {
      const vars = deriveVars(REALM_SEED[face], face);
      const worst = Math.min(...GROUNDS.map((g) => contrast(BADGE_OKLCH[face], parseOklch(vars[g]!))));
      expect(worst, face).toBeGreaterThanOrEqual(face === "dark" ? 3 : 1.8);
    }
  });
});

describe("eyes", () => {
  it("lie on the pixel grid at the row and head sizes", () => {
    for (const shape of SHAPES) for (const size of [16, 20, 24, 32]) {
      const s = size / 64;
      const { d, width } = eyeStrokes(SHAPE_GEO[shape].face, size);
      const w = width * s;
      expect(Number.isInteger(Math.round(w * 1000) / 1000), `${shape} ${size} width ${w}`).toBe(true);
      const xs = [...d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => Number(m[1]) * s);
      // each stroke's centre line is mid-way between its ends; its left edge lands on a pixel boundary
      for (const i of [0, 2]) {
        const edge = (xs[i]! + xs[i + 1]!) / 2 - w / 2;
        expect(Math.abs(edge - Math.round(edge)), `${shape} ${size}`).toBeLessThan(0.01);
      }
    }
  });

  it("are two distinct strokes at row size, never run together", () => {
    for (const shape of SHAPES) {
      const { d, width } = eyeStrokes(SHAPE_GEO[shape].face, 16);
      const xs = [...d.matchAll(/M([\d.-]+)/g)].map((m) => Number(m[1]));
      expect((xs[1]! - xs[0]!) * 0.25 - width * 0.25, shape).toBeGreaterThanOrEqual(1.5);
    }
  });
});

describe("the Lead's star", () => {
  it("never cuts into the eyes, at any size, on any shape", () => {
    const hits: string[] = [];
    for (const shape of SHAPES) for (const size of SIZES) {
      const { d, width } = eyeStrokes(SHAPE_GEO[shape].face, size);
      const star = leadStar(size);
      const pts = [...star.d.matchAll(/([\d.-]+) ([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const ends = [...d.matchAll(/([\d.-]+) ([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const nearest = Math.min(...pts.flatMap(([px, py]) => ends.map(([ex, ey]) => Math.hypot(px - ex, py - ey))));
      if (nearest <= star.cut / 2 + width / 2) hits.push(`${shape} at ${size}px`);
    }
    expect(hits).toEqual([]);
  });
});
