import { describe, expect, it } from "vitest";
import { squirclePath, SQUIRCLE_N } from "./squircle-path";

/** Every point the path visits, so a test can ask geometric questions of it rather than string ones. */
function points(d: string): Array<[number, number]> {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("the clip-path superellipse", () => {
  it("stays inside its box and closes", () => {
    const d = squirclePath(400, 300, 24);
    expect(d.endsWith("Z")).toBe(true);
    for (const [x, y] of points(d)) {
      expect(x).toBeGreaterThanOrEqual(-0.01);
      expect(x).toBeLessThanOrEqual(400.01);
      expect(y).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeLessThanOrEqual(300.01);
    }
  });

  it("solves the same equation the paint worklet traces", () => {
    /* The reason this file exists. The worklet cannot be imported — it is loaded by URL under a
       `script-src 'self'` CSP — so the curve is written down twice, and this is what stops the two
       copies drifting into two visibly different corners.

       Checked against |x/r|^n + |y/r|^n = 1 directly, in the corner's own frame. The mutant this
       kills is the one that matters: `2 / n` becoming `n` or `1 / n`, which still produces a
       plausible rounded rectangle and a corner that no longer matches the composer's. */
    const r = 40, w = 300, h = 200;
    const d = squirclePath(w, h, r);
    const corner = points(d).filter(([x, y]) => x < r && y < r); // the top-left quadrant's sweep
    expect(corner.length).toBeGreaterThan(8);
    for (const [x, y] of corner) {
      const u = Math.abs((x - r) / r), v = Math.abs((y - r) / r);
      expect(u ** SQUIRCLE_N + v ** SQUIRCLE_N, `(${x}, ${y}) is not on the superellipse`).toBeCloseTo(1, 2);
    }
  });

  it("is fuller than the circle of the same radius — which is the whole point", () => {
    // A superellipse sits FURTHER into the corner than a circular arc does. If this ever inverts,
    // the shape has quietly become a plain round rect and nothing else would say so.
    const r = 50;
    const sq = points(squirclePath(200, 200, r)).filter(([x, y]) => x < r && y < r);
    // Measured from the corner's CENTRE (r, r), where the circular arc sits at exactly r. Every
    // point of the superellipse is at least that far out, i.e. nearer the box's true corner.
    const radii = sq.map(([x, y]) => Math.hypot(x - r, y - r));
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(r - 0.01);
    // And at 45° it is furthest out — r * 2^(1/4) ≈ 1.19r for n = 4. A plain round rect would put
    // this at 0, which is the drift this test is here to catch.
    expect(Math.max(...radii)).toBeCloseTo(r * 2 ** (1 / 4), 0);
  });

  it("clamps to half the short side rather than returning a path that crosses itself", () => {
    // A self-crossing clip path clips to NOTHING, which is an invisible screen — the worst failure
    // available here, and reachable just by asking for a radius larger than a small guest.
    const d = squirclePath(40, 30, 200);
    for (const [, y] of points(d)) expect(y).toBeLessThanOrEqual(30.01);
    expect(points(d).some(([, y]) => y > 14 && y < 16)).toBe(true); // the corner reaches the middle
  });

  it("gives a zero-sized box no path at all, so a connecting screen is not clipped away", () => {
    expect(squirclePath(0, 500, 20)).toBe("");
    expect(squirclePath(500, 0, 20)).toBe("");
    expect(squirclePath(-1, -1, 20)).toBe("");
  });

  it("degenerates to the plain rectangle at radius 0", () => {
    expect(squirclePath(10, 20, 0)).toBe("M0 0L10 0L10 20L0 20Z");
  });
});
