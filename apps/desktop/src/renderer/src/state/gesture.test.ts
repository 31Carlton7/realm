import { describe, expect, it } from "vitest";
import { createSwipeTracker } from "./gesture";
describe("swipe tracker", () => {
  it("emits next after horizontal deltas exceed threshold, ignores vertical, and re-arms after idle", () => {
    const t = createSwipeTracker({ threshold: 80, idleMs: 120 });
    let now = 0; const out: string[] = [];
    const feed = (dx: number, dy: number) => { const r = t.wheel(dx, dy, now); if (r) out.push(r); };
    feed(30, 2); feed(30, 0); expect(out).toEqual([]);
    feed(30, 0); expect(out).toEqual(["next"]);          // 90 > 80
    feed(50, 0); expect(out).toEqual(["next"]);          // locked until idle
    now = 200; feed(-90, 0); expect(out).toEqual(["next", "prev"]);
    now = 400; feed(10, 100); feed(100, 400); expect(out).toEqual(["next", "prev"]); // vertical-dominant ignored
    expect(t.progress()).toBeGreaterThanOrEqual(0);
  });
});
