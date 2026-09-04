import { describe, expect, it } from "vitest";
import {
  bucketLabel, columnGeometry, nearestSlot, niceScale, slotCenter, sparklinePoints,
  stackSegments, tickIndices, plotHeight, plotWidth,
} from "./chart-model";

/** jsdom has no layout, so a `<rect>` with a NaN height and one with the right height are
 *  indistinguishable in a rendered test. Everything that decides where a mark lands is asserted
 *  here, on numbers, where a broken scale is a failure rather than an invisible blank card. */

describe("niceScale", () => {
  it("rounds the top up to a clean number and labels it with round ticks", () => {
    expect(niceScale(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    // A step of 2 rather than 1: the 1/2/5 progression keeps the gridline count at or under
    // `count`, which is the whole point of the progression.
    expect(niceScale(4.2)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
  });

  it("never answers a zero max — the way every bar in a chart becomes NaN tall", () => {
    // The named mutant: returning `max: 0` for an empty range divides every bar by zero, which
    // renders as nothing and reads as "no data" for data that is merely small.
    expect(niceScale(0).max).toBe(1);
    expect(niceScale(-5).max).toBe(1);
    expect(niceScale(Number.NaN).max).toBe(1);
  });

  it("keeps ticks exact rather than accumulating float drift", () => {
    // `t += 0.1` five times is 0.5000000000000001 and prints as such on an axis.
    expect(niceScale(0.5).ticks.every((t) => Number.isFinite(t) && Math.abs(t * 10 - Math.round(t * 10)) < 1e-9)).toBe(true);
  });
});

describe("columnGeometry", () => {
  it("caps the bar and leaves the rest of the slot as air", () => {
    // A bar that fills its slot reads as a solid block; the leftover IS the design.
    expect(columnGeometry(700, 7).bar).toBe(24);
    expect(columnGeometry(700, 7).slot).toBe(100);
  });

  it("takes the 2px surface gap out of the bar so slot centres stay on the band", () => {
    const { slot, bar } = columnGeometry(100, 10);
    expect(slot).toBe(10);
    expect(bar).toBe(8);
    expect(slotCenter(0, slot, 50)).toBe(55);
  });

  it("never draws a bar narrower than a pixel, however dense the range", () => {
    expect(columnGeometry(100, 200).bar).toBe(1);
    expect(columnGeometry(0, 0)).toEqual({ slot: 0, bar: 0 });
  });
});

describe("stackSegments", () => {
  it("stacks bottom-up, so the first series sits on the baseline", () => {
    const segs = stackSegments([50, 50], 100, 100, 0);
    expect(segs[0]).toEqual({ y: 50, height: 50 });
    expect(segs[1]).toEqual({ y: 0, height: 50 });
  });

  it("takes the gap from the segment ABOVE the join, never from the baseline segment's foot", () => {
    // The stack must still start exactly on the axis: shaving the bottom segment would float the
    // whole column off its own baseline.
    const segs = stackSegments([50, 50], 100, 100, 2);
    expect(segs[0]!.height).toBe(50);
    expect(segs[1]!.height).toBe(48);
  });

  it("draws a tiny value at 1px rather than inverting it", () => {
    // The named mutant: `raw - gap` on a 1px segment is negative, and a negative height renders as
    // nothing — a value that is small silently becomes a value that is absent.
    const segs = stackSegments([100, 0.5], 100, 100, 2);
    expect(segs[1]!.height).toBeGreaterThanOrEqual(1);
  });

  it("gives a zero value no height at all", () => {
    expect(stackSegments([10, 0], 10, 100).at(-1)!.height).toBe(0);
  });
});

describe("tickIndices", () => {
  it("always labels the last slot — the right edge is where a reader looks for 'now'", () => {
    expect(tickIndices(30, 20).at(-1)).toBe(29);
    expect(tickIndices(7, 100).at(-1)).toBe(6);
  });

  it("thins labels as slots get tighter, so they cannot collide", () => {
    expect(tickIndices(30, 100)).toHaveLength(30);
    expect(tickIndices(30, 10).length).toBeLessThan(30);
  });

  it("answers nothing for an empty range instead of a negative index", () => {
    expect(tickIndices(0, 10)).toEqual([]);
  });
});

describe("nearestSlot", () => {
  it("snaps to the nearest column so the reader aims at a date, not at a 2px line", () => {
    expect(nearestSlot(55, 50, 10, 5)).toBe(0);
    expect(nearestSlot(64, 50, 10, 5)).toBe(1);
  });

  it("clamps to the ends — a pointer in the padding still reads a real column", () => {
    expect(nearestSlot(0, 50, 10, 5)).toBe(0);
    expect(nearestSlot(9999, 50, 10, 5)).toBe(4);
    expect(nearestSlot(10, 50, 10, 0)).toBe(-1);
  });
});

describe("sparklinePoints", () => {
  it("flat-lines down the middle when every value is equal, rather than dividing by zero", () => {
    // The named mutant: a zero range makes every y NaN, and the polyline disappears entirely.
    expect(sparklinePoints([5, 5, 5], 96, 24)).toBe("0.00,12.00 48.00,12.00 96.00,12.00");
  });

  it("puts the maximum at the top and the minimum at the bottom", () => {
    const pts = sparklinePoints([0, 10], 100, 20).split(" ").map((p) => Number(p.split(",")[1]));
    expect(pts[0]).toBe(20);
    expect(pts[1]).toBe(0);
  });

  it("says nothing for no data", () => {
    expect(sparklinePoints([], 96, 24)).toBe("");
  });
});

describe("bucketLabel", () => {
  it("marks a week as a week-commencing date, so a Monday is not read as a single day", () => {
    expect(bucketLabel(new Date(2026, 8, 7).getTime(), "week")).toMatch(/^w\/c /);
    expect(bucketLabel(new Date(2026, 8, 7).getTime(), "day")).not.toMatch(/^w\/c /);
  });
});

describe("the plot box", () => {
  it("never answers a negative plot size when padding exceeds the box", () => {
    const tiny = { width: 10, height: 10, padTop: 12, padRight: 12, padBottom: 28, padLeft: 52 };
    expect(plotWidth(tiny)).toBe(0);
    expect(plotHeight(tiny)).toBe(0);
  });
});
