export type SwipeUpdate =
  | { type: "move"; offset: number }
  | { type: "commit"; dir: "next" | "prev" }
  | { type: "ignore" };

export type SwipeBounds = { canPrev: boolean; canNext: boolean };

/**
 * Drag-follow swipe from trackpad wheel events (macOS-Spaces feel).
 *
 * The content follows the fingers 1:1 (`move`), rubber-bands past the first/last page, and
 * `commit`s when the drag crosses `commitFraction` of the page width — or earlier on a fast
 * flick. Pulling back below the threshold and pausing yields `settle` (ease back to rest).
 *
 * DOM wheel events carry no touch phases, so "fingers lifted" is approximated by an idle gap
 * (`idleMs` with no events — the host calls `idle(ts)` from a timer). macOS momentum events
 * keep arriving after lift; the post-commit lock swallows them so one gesture moves one page.
 *
 * Pure state machine — time is injected, no DOM, no timers.
 */
export function createDragSwipe(opts: { width: number; commitFraction?: number; flickVelocity?: number; flickMinPx?: number; idleMs?: number; rubber?: number }) {
  const commitPx = () => Math.max(48, opts.width * (opts.commitFraction ?? 0.5));
  const flickVelocity = opts.flickVelocity ?? 0.9; // px/ms
  const flickMinPx = opts.flickMinPx ?? 32;
  const idleMs = opts.idleMs ?? 220; // hold window: a brief finger-rest keeps the drag; a longer gap settles/re-arms
  const rubber = opts.rubber ?? 0.35;

  let acc = 0;               // raw accumulated horizontal delta (px, + = towards next)
  let shown = 0;             // rubber-adjusted offset actually shown
  let locked = false;        // true after a commit until the gesture's momentum tail ends
  let dragging = false;
  let lastTs = -Infinity;
  let samples: Array<{ dx: number; ts: number }> = [];

  const reset = () => { acc = 0; shown = 0; locked = false; dragging = false; samples = []; };

  const velocity = (now: number): number => {
    samples = samples.filter((s) => now - s.ts <= 100);
    if (samples.length === 0) return 0;
    const dt = Math.max(1, now - samples[0]!.ts);
    return samples.reduce((a, s) => a + s.dx, 0) / dt;
  };

  return {
    wheel(dx: number, dy: number, ts: number, bounds: SwipeBounds): SwipeUpdate {
      if (ts - lastTs > idleMs) reset(); // long gap = new gesture
      lastTs = ts;
      if (locked) return { type: "ignore" };
      if (!dragging && Math.abs(dy) > Math.abs(dx)) return { type: "ignore" }; // vertical scroll
      dragging = true;
      acc += dx;
      samples.push({ dx, ts });

      const wall = (acc > 0 && !bounds.canNext) || (acc < 0 && !bounds.canPrev);
      shown = wall ? acc * rubber : acc;

      if (!wall) {
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

    /** Host calls this from a timer ~idleMs after the last wheel event. */
    idle(ts: number): { type: "settle" } | { type: "ignore" } {
      if (ts - lastTs < idleMs) return { type: "ignore" };
      const hadOffset = shown !== 0;
      reset();
      lastTs = -Infinity;
      return hadOffset ? { type: "settle" } : { type: "ignore" };
    },

    offset(): number { return shown; },
    reset,
  };
}
