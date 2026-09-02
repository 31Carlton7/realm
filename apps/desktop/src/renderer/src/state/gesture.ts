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
 *    we decide: past `commitFraction` of the width, or a release velocity that would carry it there
 *    within `projectMs` → `commit`; otherwise `settle`. Momentum deltas after a lift are ignored so
 *    one gesture moves one page.
 *  • **Timer fallback** (no phase source): the host calls `idle(ts)` after a quiet gap. Distance
 *    or a flick commits live; a quiet gap below the threshold settles.
 *
 * Pure state machine — time is injected, no DOM, no timers.
 */
export function createDragSwipe(opts: { width: number; commitFraction?: number; flickMinPx?: number; idleMs?: number; rubber?: number; staleMs?: number; projectMs?: number }) {
  // Arc commits well before half a page: a confident third-of-a-width push is already a decision,
  // and making the user drag to the midpoint is most of what reads as "sluggish" beside it.
  const commitPx = () => Math.max(40, opts.width * (opts.commitFraction ?? 0.3));
  // A twitch is never a swipe, however fast — the floor that keeps projection from firing on noise.
  const flickMinPx = opts.flickMinPx ?? 12;
  // How far ahead the current speed is projected. This is what replaces a separate "flick" velocity
  // threshold: position alone can't tell a flick from a nudge, but position + where the fingers are
  // heading can, on one scale, with no second constant to keep in sync.
  const projectMs = opts.projectMs ?? 70;
  const idleMs = opts.idleMs ?? 320;
  const rubber = opts.rubber ?? 0.35;
  const staleMs = opts.staleMs ?? 4000;

  let acc = 0;               // raw accumulated horizontal delta (px, + = towards next)
  let shown = 0;             // rubber-adjusted offset actually shown
  let locked = false;        // after a commit / during momentum: swallow deltas
  let dragging = false;
  let lastCommitDir: "next" | "prev" | null = null;
  let fingersDown = false;   // only meaningful with native phases
  let hasPhases = false;     // once we've seen any phase, timers stop deciding
  let lastTs = -Infinity;
  let lastBounds: SwipeBounds = { canPrev: true, canNext: true };
  let samples: Array<{ dx: number; ts: number }> = [];

  const reset = () => { acc = 0; shown = 0; locked = false; dragging = false; samples = []; };

  /** Mean px/ms over the last 100ms. The first sample in the window contributes its *timestamp*, not
   *  its delta: that delta was travelled before the window opened, and counting it against zero
   *  elapsed time inflated every reading. `now` past the last sample is a pause before the lift,
   *  which correctly decays the result towards 0. */
  const velocity = (now: number): number => {
    samples = samples.filter((s) => now - s.ts <= 100);
    if (samples.length < 2) return 0;
    const dt = Math.max(1, now - samples[0]!.ts);
    return samples.slice(1).reduce((a, s) => a + s.dx, 0) / dt;
  };

  /** Committed if the drag is already past the threshold, or heading there fast enough to arrive. */
  const past = (now: number): boolean => {
    if (Math.abs(acc) >= commitPx()) return true;
    if (Math.abs(acc) < flickMinPx) return false;
    const v = velocity(now);
    if (Math.sign(v) !== Math.sign(acc)) return false; // already being pulled back
    return Math.abs(acc + v * projectMs) >= commitPx();
  };

  const decide = (now: number): SwipeUpdate => {
    const wall = (acc > 0 && !lastBounds.canNext) || (acc < 0 && !lastBounds.canPrev);
    if (!wall && past(now)) {
      const dir = acc > 0 ? "next" : "prev";
      acc = 0; shown = 0; samples = []; locked = true; lastCommitDir = dir;
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
      if (locked) {
        // Fallback only: a deliberate swipe *back* during the momentum tail (opposite sign, real
        // magnitude) is a new gesture — don't make the user wait for the tail to die out.
        if (!hasPhases && lastCommitDir && Math.sign(dx) === (lastCommitDir === "next" ? -1 : 1) && Math.abs(dx) >= 6) { reset(); }
        else return { type: "ignore" };
      }
      if (hasPhases && !fingersDown) return { type: "ignore" }; // stray delta after lift (e.g. momentum) — never displaces
      if (!dragging && Math.abs(dy) > Math.abs(dx)) return { type: "ignore" }; // vertical scroll
      dragging = true;
      acc += dx;
      samples.push({ dx, ts });

      const wall = (acc > 0 && !bounds.canNext) || (acc < 0 && !bounds.canPrev);
      shown = wall ? acc * rubber : acc;

      // Without phases we can't wait for the lift, so commit live on distance/flick.
      if (!hasPhases && !wall) {
        if (past(ts)) {
          const dir = acc > 0 ? "next" : "prev";
          acc = 0; shown = 0; samples = []; locked = true; lastCommitDir = dir;
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

    /** Timer fallback: host calls this ~idleMs after the last wheel event. With native phases it only
     *  guards against a missed 'ended' (no events at all for `staleMs` while displaced → settle). */
    idle(ts: number): SwipeUpdate {
      if (hasPhases) {
        if (shown !== 0 && ts - lastTs >= staleMs) { reset(); fingersDown = false; return { type: "settle" }; }
        return { type: "ignore" };
      }
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
