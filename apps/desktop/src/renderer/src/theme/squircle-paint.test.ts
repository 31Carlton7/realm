import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The painter itself, run outside a paint worklet: `registerPaint` is the one global it touches, and
 * a canvas that records its own calls is enough to read back what was stroked. jsdom has no CSS
 * Painting API, so this is the only place the ring's PATH — as opposed to the inputs it is handed —
 * can be checked; whether it then lands on the right pixels is `tray-edges`'s live check.
 */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

type Point = [number, number];
type Painter = { paint(ctx: unknown, size: { width: number; height: number }, props: { get(name: string): unknown }): void };

function loadPainter(): Painter {
  const source = readFileSync(repoFile("apps/desktop/src/renderer/public/squircle-paint.js"), "utf8");
  let Painter: (new () => Painter) | null = null;
  new Function("registerPaint", source)((_name: string, cls: new () => Painter) => { Painter = cls; });
  if (!Painter) throw new Error("the worklet registered no painter");
  return new (Painter as new () => Painter)();
}

/** A 2D context that keeps the path it is building, and every path it was asked to stroke. */
function recorder() {
  let path: Point[][] = [];
  let closed = false;
  const strokes: { subpaths: Point[][]; closed: boolean }[] = [];
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 0,
    beginPath() { path = []; closed = false; },
    moveTo(x: number, y: number) { path.push([[x, y]]); },
    lineTo(x: number, y: number) { (path.at(-1) ?? path[path.push([]) - 1]!).push([x, y]); },
    closePath() { closed = true; },
    fill() {}, clip() {}, save() {}, restore() {},
    stroke() { strokes.push({ subpaths: path.map((p) => [...p]), closed }); },
  };
  return { ctx, strokes };
}

const props = (over: Record<string, unknown> = {}) => {
  const all: Record<string, unknown> = {
    "--sq-fill": "#1a1b1d", "--sq-ring": "#ffffff14", "--sq-ring-w": { value: 0.5 }, "--sq-ring-open": "none",
    "--sq-radius-top": { value: 0 }, "--sq-radius-bottom": { value: 0 }, "--sq-n": { value: 4 }, ...over,
  };
  return { get: (name: string) => all[name] };
};

/** Every straight run along the shape's top edge (y = 0) that the stroke draws. */
const topRuns = (subpaths: Point[][]) => subpaths.flatMap((p) => p.slice(1)
  .map((pt, i) => [p[i]!, pt] as const)
  .filter(([a, b]) => Math.abs(a[1]) < 1e-6 && Math.abs(b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > 1e-6));

describe("the painter's ring", () => {
  const W = 600, H = 48;

  it("traces the whole closed outline by default, top edge included", () => {
    const { ctx, strokes } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, props());
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.closed).toBe(true);
    expect(topRuns(strokes[0]!.subpaths).length).toBeGreaterThan(0);
  });

  /* A tab stacked under another in the band above the prompter. Its top is a join inside the band, so
     a ring there rules a seam across the middle of one object — and dropping the ring altogether, the
     old answer, took the sides with it: the git footer under the plan strip read as an open-sided box.
     THE mutants: the open flag ignored (the seam comes back), or the open path cut short of a side. */
  it("leaves the top OPEN when asked, and still runs both sides the full height", () => {
    const { ctx, strokes } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, props({ "--sq-ring-open": "top" }));
    expect(strokes).toHaveLength(1);
    const { subpaths, closed } = strokes[0]!;
    expect(closed).toBe(false);
    expect(topRuns(subpaths)).toEqual([]);
    const points = subpaths.flat();
    // Down the right side from the very top, and up the left side to the very top.
    expect(points[0]).toEqual([W, 0]);
    expect(points.at(-1)).toEqual([0, 0]);
    expect(points.some(([x, y]) => x === W && y === H)).toBe(true);
    expect(points.some(([x, y]) => x === 0 && y === H)).toBe(true);
  });

  it("opens only at the top corners' ends on a tab that keeps rounded ones", () => {
    const { ctx, strokes } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, props({ "--sq-ring-open": "top", "--sq-radius-top": { value: 20 } }));
    const points = strokes[0]!.subpaths.flat();
    expect(points[0]).toEqual([W, 20]);
    expect(points.at(-1)).toEqual([0, 20]);
    expect(topRuns(strokes[0]!.subpaths)).toEqual([]);
  });

  it("draws no ring at all at zero width, open or not", () => {
    const { ctx, strokes } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, props({ "--sq-ring-open": "top", "--sq-ring-w": { value: 0 } }));
    expect(strokes).toEqual([]);
  });
});
