export type SwipeUpdate =
  | { type: "move"; offset: number }
  | { type: "commit"; dir: "next" | "prev" }
  | { type: "settle" }
  | { type: "ignore" };

export type SwipeBounds = { canPrev: boolean; canNext: boolean };

/** Trackpad gesture phases as reported by macOS (via the native ScrollPhase helper). */
export type SwipePhase = "began" | "changed" | "ended" | "cancelled" | "momentumBegan" | "momentumEnded";

/**
 * Drag-follow swipe (macOS-Spaces feel).
 *
 * The content follows the fingers 1:1 (`move`) and rubber-bands past the first/last page.
 *
 * Two modes:
 *  • **Native phases** (preferred): call `phase()` with the trackpad's phase stream. While fingers are
 *    down the content is simply held wherever it is — no timers, no auto-commit. On lift (`ended`)
 *    we decide: past `commitFraction` of the width, or a fast release velocity → `commit`; otherwise
 *    `settle`. Momentum deltas after a lift are ignored so one gesture moves one page.
 *  • **Timer fallback** (no phase source): the host calls `idle(ts)` after a quiet gap. Distance
 *    or a flick commits live; a quiet gap below the threshold settles.
 *
 * Pure state machine — time is injected, no DOM, no timers.
 */
export function createDragSwipe(opts: { width: number; commitFraction?: number; flickVelocity?: number; flickMinPx?: number; idleMs?: number; rubber?: number }) {
  const commitPx = () => Math.max(48, opts.width * (opts.commitFraction ?? 0.5));
  const flickVelocity = opts.flickVelocity ?? 0.9; // px/ms
  const flickMinPx = opts.flickMinPx ?? 32;
  const idleMs = opts.idleMs ?? 220;
  const rubber = opts.rubber ?? 0.35;

  let acc = 0;               // raw accumulated horizontal delta (px, + = towards next)
  let shown = 0;             // rubber-adjusted offset actually shown
  let locked = false;        // after a commit / during momentum: swallow deltas
  let dragging = false;
  let fingersDown = false;   // only meaningful with native phases
  let hasPhases = false;     // once we've seen any phase, timers stop deciding
  let lastTs = -Infinity;
  let lastBounds: SwipeBounds = { canPrev: true, canNext: true };
  let samples: Array<{ dx: number; ts: number }> = [];

  const reset = () => { acc = 0; shown = 0; locked = false; dragging = false; samples = []; };

  const velocity = (now: number): number => {
    samples = samples.filter((s) => now - s.ts <= 100);
    if (samples.length === 0) return 0;
    const dt = Math.max(1, now - samples[0]!.ts);
    return samples.reduce((a, s) => a + s.dx, 0) / dt;
  };

  const decide = (now: number): SwipeUpdate => {
    const wall = (acc > 0 && !lastBounds.canNext) || (acc < 0 && !lastBounds.canPrev);
    const v = velocity(now);
    const flick = Math.abs(acc) >= flickMinPx && Math.abs(v) >= flickVelocity && Math.sign(v) === Math.sign(acc);
    if (!wall && (Math.abs(acc) >= commitPx() || flick)) {
      const dir = acc > 0 ? "next" : "prev";
      acc = 0; shown = 0; samples = []; locked = true;
      return { type: "commit", dir };
    }
    const had = shown !== 0;
    acc = 0; shown = 0; samples = [];
    return had ? { type: "settle" } : { type: "ignore" };
  };

  return {
    wheel(dx: number, dy: number, ts: number, bounds: SwipeBounds): SwipeUpdate {
      lastBounds = bounds;
      if (!hasPhases && ts - lastTs > idleMs) reset(); // fallback: long gap = new gesture
      lastTs = ts;
      if (locked) return { type: "ignore" };
      if (!dragging && Math.abs(dy) > Math.abs(dx)) return { type: "ignore" }; // vertical scroll
      dragging = true;
      acc += dx;
      samples.push({ dx, ts });

      const wall = (acc > 0 && !bounds.canNext) || (acc < 0 && !bounds.canPrev);
      shown = wall ? acc * rubber : acc;

      // Without phases we can't wait for the lift, so commit live on distance/flick.
      if (!hasPhases && !wall) {
        const v = velocity(ts);
        const flick = Math.abs(acc) >= flickMinPx && Math.abs(v) >= flickVelocity && Math.sign(v) === Math.sign(acc);
        if (Math.abs(acc) >= commitPx() || flick) {
          const dir = acc > 0 ? "next" : "prev";
          acc = 0; shown = 0; samples = []; locked = true;
          return { type: "commit", dir };
        }
      }
      return { type: "move", offset: shown };
    },

    /** Native trackpad phase stream. */
    phase(p: SwipePhase, ts: number): SwipeUpdate {
      hasPhases = true;
      lastTs = ts;
      switch (p) {
        case "began":
          fingersDown = true; locked = false; acc = 0; shown = 0; dragging = false; samples = [];
          return { type: "ignore" };
        case "changed":
          return { type: "ignore" };
        case "ended":
        case "cancelled": {
          fingersDown = false;
          if (locked) return { type: "ignore" };
          const r = p === "cancelled" ? (shown !== 0 ? ({ type: "settle" } as const) : ({ type: "ignore" } as const)) : decide(ts);
          if (p === "cancelled") { acc = 0; shown = 0; samples = []; }
          dragging = false;
          return r;
        }
        case "momentumBegan":
          locked = true; // coasting after a lift — ignore until it ends
          return { type: "ignore" };
        case "momentumEnded":
          locked = false; reset();
          return { type: "ignore" };
      }
    },

    /** Timer fallback: host calls this ~idleMs after the last wheel event. No-op once phases are flowing. */
    idle(ts: number): SwipeUpdate {
      if (hasPhases) return { type: "ignore" };
      if (ts - lastTs < idleMs) return { type: "ignore" };
      const had = shown !== 0;
      reset();
      lastTs = -Infinity;
      return had ? { type: "settle" } : { type: "ignore" };
    },

    offset(): number { return shown; },
    fingersDown(): boolean { return fingersDown; },
    reset,
  };
}
