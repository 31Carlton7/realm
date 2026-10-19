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

/** A 2D context that keeps the path it is building, every path it was asked to stroke or fill, and
 *  the order of the calls that change what a fill lands on. */
function recorder() {
  let path: Point[][] = [];
  let closed = false;
  const strokes: { subpaths: Point[][]; closed: boolean }[] = [];
  const fills: { subpaths: Point[][]; rule: string | undefined; style: string }[] = [];
  const calls: string[] = [];
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 0,
    beginPath() { path = []; closed = false; },
    moveTo(x: number, y: number) { path.push([[x, y]]); },
    lineTo(x: number, y: number) { (path.at(-1) ?? path[path.push([]) - 1]!).push([x, y]); },
    closePath() { closed = true; },
    fill(rule?: string) { fills.push({ subpaths: path.map((p) => [...p]), rule, style: ctx.fillStyle }); calls.push("fill"); },
    clip() { calls.push("clip"); }, save() {}, restore() { calls.push("restore"); },
    translate(x: number, y: number) { calls.push(`translate ${x} ${y}`); },
    stroke() { strokes.push({ subpaths: path.map((p) => [...p]), closed }); },
  };
  return { ctx, strokes, fills, calls };
}

const props = (over: Record<string, unknown> = {}) => {
  const all: Record<string, unknown> = {
    // A registered colour at its initial value reaches the painter as this, not as "transparent".
    "--sq-fill": "#1a1b1d", "--sq-sheen": "rgba(0, 0, 0, 0)", "--sq-ring": "#ffffff14", "--sq-ring-w": { value: 0.5 }, "--sq-ring-open": "none",
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

/* A card's light (the owner, 10-19: no borders). It has to be light on the top edge and nothing else —
   the band between the outline and the same outline a pixel lower, inside the shape — or it is the
   outline the cards just lost. */
describe("the painter's light", () => {
  const W = 600, H = 120, LIGHT = "rgba(255, 255, 255, 0.035)";
  const card = (over: Record<string, unknown> = {}) =>
    props({ "--sq-ring-w": { value: 0 }, "--sq-radius-top": { value: 20 }, "--sq-radius-bottom": { value: 20 }, ...over });

  /* THE MUTANT: the initial value not recognised as "no light", so every painted button and field
     in the app pays for a second pass that draws nothing. */
  it("draws nothing at the input's initial value", () => {
    const { ctx, fills } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, card());
    expect(fills).toHaveLength(1);
    expect(fills[0]!.rule).toBeUndefined();
  });

  /* THE MUTANTS: the second outline moved UP (the light along the foot instead), or filled without
     the even-odd rule (the whole card washed in it). */
  it("fills, inside the shape, the band between the outline and the same outline one pixel lower", () => {
    const { ctx, fills, calls } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, card({ "--sq-sheen": LIGHT }));
    const light = fills.find((f) => f.style === LIGHT);
    expect(light?.rule).toBe("evenodd");
    const [outline, lowered] = light!.subpaths.length === 2 ? light!.subpaths : [[], []];
    expect(outline!.length).toBeGreaterThan(20);
    expect(lowered).toEqual(outline);
    // Clipped to the shape first, so the part of the lowered outline below the card is never drawn.
    const at = calls.lastIndexOf("fill");
    expect(calls.slice(0, at)).toEqual(expect.arrayContaining(["clip", "translate 0 1"]));
    expect(calls.indexOf("clip")).toBeLessThan(calls.indexOf("translate 0 1"));
  });

  /* THE MUTANT: the ring left to stroke whatever path is current — after the light, that is the
     light's own two-outline band, and focus would draw two rings a pixel apart. */
  it("leaves the ring on the one closed outline when both are drawn", () => {
    const { ctx, strokes } = recorder();
    loadPainter().paint(ctx, { width: W, height: H }, card({ "--sq-sheen": LIGHT, "--sq-ring-w": { value: 2 }, "--sq-ring": "#3d9aff" }));
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.subpaths).toHaveLength(1);
    expect(strokes[0]!.closed).toBe(true);
  });
});
