import { describe, expect, it } from "vitest";
import { EMPTY_TRAIL, WINDOW_TRAIL_LIMIT, pushStop, settleStop, stepTarget, type WindowTrail } from "./window-trail";

const a = { spaceId: "s1", itemId: "i1" }, b = { spaceId: "s2", itemId: "i2" }, c = { spaceId: "s3", itemId: null };

describe("pushStop", () => {

  it("a landing from the middle of the trail drops the way forward", () => {
    const t: WindowTrail = { stops: [a, b, c], index: 0 };
    expect(pushStop(t, c)).toEqual({ stops: [a, c], index: 1 });
  });

  it("forgets from the old end, never the step just taken", () => {
    let t = EMPTY_TRAIL;
    for (let i = 0; i < WINDOW_TRAIL_LIMIT + 5; i++) t = pushStop(t, { spaceId: "s1", itemId: `i${i}` });
    expect(t.stops).toHaveLength(WINDOW_TRAIL_LIMIT);
    expect(t.stops.at(-1)).toEqual({ spaceId: "s1", itemId: `i${WINDOW_TRAIL_LIMIT + 4}` });
    expect(t.index).toBe(WINDOW_TRAIL_LIMIT - 1);
  });
});

describe("stepTarget", () => {
  const t: WindowTrail = { stops: [a, b, c], index: 1 };
  const all = () => true;
  it("is one step away in either direction, and nothing past either end", () => {
    expect(stepTarget(t, -1, all)).toBe(0);
    expect(stepTarget(t, 1, all)).toBe(2);
    expect(stepTarget({ ...t, index: 0 }, -1, all)).toBeNull();
    expect(stepTarget({ ...t, index: 2 }, 1, all)).toBeNull();
    expect(stepTarget(t, 0, all)).toBeNull();
  });

  it("steps over a room that is gone rather than landing in it", () => {
    const t2: WindowTrail = { stops: [a, b, c], index: 2 };
    expect(stepTarget(t2, -1, (s) => s.spaceId !== "s2")).toBe(0);
    expect(stepTarget(t2, -1, (s) => s.spaceId === "s3")).toBeNull();
  });
});

describe("settleStop", () => {

  it("folds into a neighbour it now equals, so no key press goes nowhere", () => {
    expect(settleStop({ stops: [a, b, c], index: 1 }, c)).toEqual({ stops: [a, c], index: 1 });
    expect(settleStop({ stops: [a, b, c], index: 1 }, a)).toEqual({ stops: [a, c], index: 0 });
  });
});
