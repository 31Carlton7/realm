import { describe, expect, it } from "vitest";
import { createDragSwipe } from "./gesture";

const BOUNDS = { canPrev: true, canNext: true };
const mk = () => createDragSwipe({ width: 240, idleMs: 90 });

describe("drag swipe", () => {
  it("small drag moves the content, then settles back on idle", () => {
    const t = mk();
    expect(t.wheel(30, 2, 0, BOUNDS)).toEqual({ type: "move", offset: 30 });
    expect(t.wheel(20, 0, 60, BOUNDS)).toEqual({ type: "move", offset: 50 }); // slow — no flick
    expect(t.idle(60 + 89)).toEqual({ type: "ignore" });   // not idle yet
    expect(t.idle(60 + 91)).toEqual({ type: "settle" });   // eases back to rest
    expect(t.offset()).toBe(0);
  });

  it("dragging past half the width commits next exactly once, then locks until the gesture ends", () => {
    const t = mk();
    let ts = 0;
    // slow drag: low velocity so only the distance rule can commit
    let committed = 0;
    for (let i = 0; i < 20; i++) { const r = t.wheel(8, 0, (ts += 60), BOUNDS); if (r.type === "commit") { committed++; expect(r.dir).toBe("next"); break; } }
    expect(committed).toBe(1);
    // momentum tail after the commit is swallowed
    expect(t.wheel(50, 0, ts + 16, BOUNDS)).toEqual({ type: "ignore" });
    expect(t.wheel(50, 0, ts + 32, BOUNDS)).toEqual({ type: "ignore" });
    // after an idle gap the tracker re-arms for a fresh gesture
    expect(t.idle(ts + 200)).toEqual({ type: "ignore" });
    expect(t.wheel(-30, 0, ts + 300, BOUNDS)).toEqual({ type: "move", offset: -30 });
  });

  it("a fast flick commits without reaching half the width", () => {
    const t = mk();
    expect(t.wheel(20, 0, 0, BOUNDS).type).toBe("move");
    const r = t.wheel(25, 0, 16, BOUNDS); // 45px in 16ms — way past flick velocity
    expect(r).toEqual({ type: "commit", dir: "next" });
  });

  it("dragging out then pulling back below the threshold settles instead of committing", () => {
    const t = mk();
    let ts = 0;
    for (let i = 0; i < 10; i++) t.wheel(10, 0, (ts += 60), BOUNDS); // 100px out (below 120 commit)
    for (let i = 0; i < 8; i++) t.wheel(-10, 0, (ts += 60), BOUNDS); // pull back to 20px
    expect(t.offset()).toBe(20);
    expect(t.idle(ts + 100)).toEqual({ type: "settle" });
    expect(t.offset()).toBe(0);
  });

  it("vertical-dominant scrolling is ignored and does not start a drag", () => {
    const t = mk();
    expect(t.wheel(4, 40, 0, BOUNDS)).toEqual({ type: "ignore" });
    expect(t.wheel(8, 90, 16, BOUNDS)).toEqual({ type: "ignore" });
    expect(t.offset()).toBe(0);
  });

  it("rubber-bands at the ends and never commits into a wall", () => {
    const t = mk();
    let ts = 0; let last = 0;
    for (let i = 0; i < 30; i++) {
      const r = t.wheel(10, 0, (ts += 60), { canPrev: true, canNext: false });
      expect(r.type).toBe("move");
      if (r.type === "move") last = r.offset;
    }
    expect(last).toBeLessThan(300 * 0.5);      // resisted, well under the raw 300px
    expect(last).toBeGreaterThan(0);
    expect(t.idle(ts + 100)).toEqual({ type: "settle" });
  });

  it("commits prev when dragging the other way", () => {
    const t = mk();
    let ts = 0; let dir: string | null = null;
    for (let i = 0; i < 20; i++) { const r = t.wheel(-8, 0, (ts += 60), BOUNDS); if (r.type === "commit") { dir = r.dir; break; } }
    expect(dir).toBe("prev");
  });
});
