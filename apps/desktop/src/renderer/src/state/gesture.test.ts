import { describe, expect, it } from "vitest";
import { createDragSwipe } from "./gesture";

const BOUNDS = { canPrev: true, canNext: true };
const mk = () => createDragSwipe({ width: 240, idleMs: 90 });

describe("drag swipe (timer fallback — no phase source)", () => {
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
    let ts = 0; let committed = 0;
    for (let i = 0; i < 20; i++) { const r = t.wheel(8, 0, (ts += 60), BOUNDS); if (r.type === "commit") { committed++; expect(r.dir).toBe("next"); break; } }
    expect(committed).toBe(1);
    expect(t.wheel(50, 0, ts + 16, BOUNDS)).toEqual({ type: "ignore" }); // momentum tail swallowed
    expect(t.wheel(50, 0, ts + 32, BOUNDS)).toEqual({ type: "ignore" });
    expect(t.idle(ts + 200)).toEqual({ type: "ignore" });
    expect(t.wheel(-30, 0, ts + 300, BOUNDS)).toEqual({ type: "move", offset: -30 }); // re-armed
  });

  it("fallback: a deliberate swipe back during the momentum tail starts a new gesture immediately", () => {
    const t = mk();
    let ts = 0; let r;
    do { r = t.wheel(9, 0, (ts += 50), BOUNDS); } while (r.type !== "commit");
    expect(r).toEqual({ type: "commit", dir: "next" });
    // momentum tail (same direction) is swallowed…
    expect(t.wheel(30, 0, ts + 16, BOUNDS)).toEqual({ type: "ignore" });
    // …but a real opposite-direction delta re-arms and follows right away
    expect(t.wheel(-12, 0, ts + 32, BOUNDS)).toEqual({ type: "move", offset: -12 });
  });

  it("a fast flick commits without reaching half the width", () => {
    const t = mk();
    expect(t.wheel(20, 0, 0, BOUNDS).type).toBe("move");
    expect(t.wheel(25, 0, 16, BOUNDS)).toEqual({ type: "commit", dir: "next" });
  });

  it("dragging out then pulling back below the threshold settles instead of committing", () => {
    const t = mk();
    let ts = 0;
    for (let i = 0; i < 10; i++) t.wheel(10, 0, (ts += 60), BOUNDS);
    for (let i = 0; i < 8; i++) t.wheel(-10, 0, (ts += 60), BOUNDS);
    expect(t.offset()).toBe(20);
    expect(t.idle(ts + 100)).toEqual({ type: "settle" });
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
    for (let i = 0; i < 30; i++) { const r = t.wheel(10, 0, (ts += 60), { canPrev: true, canNext: false }); expect(r.type).toBe("move"); if (r.type === "move") last = r.offset; }
    expect(last).toBeLessThan(150); expect(last).toBeGreaterThan(0);
    expect(t.idle(ts + 100)).toEqual({ type: "settle" });
  });

  it("commits prev when dragging the other way", () => {
    const t = mk();
    let ts = 0; let dir: string | null = null;
    for (let i = 0; i < 20; i++) { const r = t.wheel(-8, 0, (ts += 60), BOUNDS); if (r.type === "commit") { dir = r.dir; break; } }
    expect(dir).toBe("prev");
  });
});

describe("drag swipe (native phases — macOS Spaces feel)", () => {
  it("holding still keeps the offset: idle does NOT settle while fingers are down", () => {
    const t = mk();
    t.phase("began", 0);
    t.wheel(40, 0, 10, BOUNDS);
    t.wheel(20, 0, 30, BOUNDS);
    expect(t.offset()).toBe(60);
    expect(t.idle(1000)).toEqual({ type: "ignore" });  // a whole second of rest — still held
    expect(t.offset()).toBe(60);
  });

  it("lifting below the threshold settles back immediately", () => {
    const t = mk();
    t.phase("began", 0);
    t.wheel(20, 0, 60, BOUNDS); t.wheel(20, 0, 120, BOUNDS); // slow drag to 40px, then rest
    expect(t.phase("ended", 400)).toEqual({ type: "settle" });  // released after a pause: no velocity, under threshold
    expect(t.offset()).toBe(0);
  });

  it("lifting past the threshold commits", () => {
    const t = mk();
    t.phase("began", 0);
    let ts = 0;
    for (let i = 0; i < 12; i++) t.wheel(9, 0, (ts += 50), BOUNDS); // 108px, under commit (120) — no auto-commit while held
    expect(t.offset()).toBe(108);
    t.wheel(20, 0, (ts += 50), BOUNDS); // 128px ≥ 120 → but held: still moving, not committed yet
    expect(t.offset()).toBe(128);
    expect(t.phase("ended", ts + 10)).toEqual({ type: "commit", dir: "next" });
  });

  it("a flick (momentum begins) commits on lift even if short, and momentum deltas are ignored", () => {
    const t = mk();
    t.phase("began", 0);
    t.wheel(20, 0, 8, BOUNDS); t.wheel(25, 0, 16, BOUNDS); // fast
    expect(t.phase("ended", 20)).toEqual({ type: "commit", dir: "next" });
    t.phase("momentumBegan", 30);
    expect(t.wheel(30, 0, 40, BOUNDS)).toEqual({ type: "ignore" });
    expect(t.wheel(10, 0, 56, BOUNDS)).toEqual({ type: "ignore" });
    t.phase("momentumEnded", 300);
    // next gesture works normally
    t.phase("began", 400);
    expect(t.wheel(-10, 0, 410, BOUNDS)).toEqual({ type: "move", offset: -10 });
  });

  it("drag out past threshold, drag back under, lift → settle (no commit)", () => {
    const t = mk();
    t.phase("began", 0);
    let ts = 0;
    for (let i = 0; i < 14; i++) t.wheel(10, 0, (ts += 50), BOUNDS); // 140 (past 120) while held
    for (let i = 0; i < 9; i++) t.wheel(-10, 0, (ts += 50), BOUNDS);  // back to 50
    expect(t.phase("ended", ts + 10)).toEqual({ type: "settle" });
  });

  it("phase 'cancelled' settles", () => {
    const t = mk();
    t.phase("began", 0); t.wheel(30, 0, 10, BOUNDS);
    expect(t.phase("cancelled", 20)).toEqual({ type: "settle" });
  });
});
