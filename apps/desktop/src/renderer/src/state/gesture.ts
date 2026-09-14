export type SwipeUpdate =
  | { type: "move"; offset: number }
  /** Release velocity in px/ms, in `offset`'s own sign: the animation that follows a gesture has to
   *  continue at the speed the fingers left, or there is a visible seam between the two. */
  | { type: "commit"; dir: "next" | "prev"; velocity: number }
  | { type: "settle"; velocity: number }
  | { type: "ignore" };

export type SwipeBounds = { canPrev: boolean; canNext: boolean };

/** The fastest a gesture is believed to be going, px/ms. See `velocity`. */
const MAX_VELOCITY = 8;

/**
 * Where a flick would come to rest, at the rate a scroll decelerates.
 *
 * Apple's own projection from *Designing Fluid Interfaces* — exponential decay, not the textbook
 * `v²/2a`, which is a different curve and lands short. `rate` is how much speed survives each
 * millisecond: 0.998 is a full scroll's long coast, and 0.99 is the snappier one a small surface
 * wants. A sidebar page is 240px, not a screen.
 */
export function project(velocityPxPerMs: number, rate: number): number {
  return velocityPxPerMs * (rate / (1 - rate));
}

/**
 * How far the content actually moves when it is being pulled past its end.
 *
 * Progressive resistance, which is what "rubber" means: the first pixels give at `constant` of the
 * pull and each one after gives less, approaching `dimension` and never reaching it.
 * A flat multiplier — what this was — is not resistance at all, it is the content simply becoming
 * heavier, and the hand reads that as a slow drag rather than as an edge.
 */
export function rubberband(overshoot: number, dimension: number, constant: number): number {
  if (dimension <= 0) return 0;
  const d = Math.abs(overshoot);
  return Math.sign(overshoot) * ((d * dimension * constant) / (dimension + constant * d));
}


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
export function createDragSwipe(opts: { width: number; commitFraction?: number; flickMinPx?: number; idleMs?: number; rubber?: number; staleMs?: number; decelerationRate?: number; intentPx?: number }) {
  // Arc commits well before half a page: a confident third-of-a-width push is already a decision,
  // and making the user drag to the midpoint is most of what reads as "sluggish" beside it.
  const commitPx = () => Math.max(40, opts.width * (opts.commitFraction ?? 0.3));
  // A twitch is never a swipe, however fast — the floor that keeps projection from firing on noise.
  const flickMinPx = opts.flickMinPx ?? 12;
  /* How fast a flick is taken to decay when projecting where it would land. 0.99 rather than the
     0.998 of a full-screen scroll: this page is 240px wide, and a coast measured for a screen throws
     a sidebar three spaces along. */
  const decelerationRate = opts.decelerationRate ?? 0.99;
  const idleMs = opts.idleMs ?? 320;
  /* How much the content gives to the FIRST pixels past the end. Apple's own constant, 0.55: the
     pull follows at just over half speed at first and asymptotes at the page's own width however
     hard it is dragged, so the edge announces itself by feel rather than by stopping. */
  const rubber = opts.rubber ?? 0.55;
  const staleMs = opts.staleMs ?? 4000;

  /* How far a gesture has to travel horizontally before it moves anything, and how much more
     horizontal than vertical it has to be. Both from §10's hysteresis rule, and both about the same
     failure: the sidebar twitching sideways under a diagonal scroll nobody meant as a swipe. */
  const intentPx = opts.intentPx ?? 6;
  const intentRatio = 1.5;

  let acc = 0;               // raw accumulated horizontal delta (px, + = towards next)
  let pendingX = 0;          // horizontal travel that has not yet earned the drag
  let shown = 0;             // rubber-adjusted offset actually shown
  let locked = false;        // after a commit / during momentum: swallow deltas
  let dragging = false;
  let lastCommitDir: "next" | "prev" | null = null;
  let fingersDown = false;   // only meaningful with native phases
  let hasPhases = false;     // once we've seen any phase, timers stop deciding
  let lastTs = -Infinity;
  let lastBounds: SwipeBounds = { canPrev: true, canNext: true };
  let samples: Array<{ dx: number; ts: number }> = [];

  const reset = () => { acc = 0; pendingX = 0; shown = 0; locked = false; dragging = false; samples = []; };

  /** Mean px/ms over the last 100ms. The first sample in the window contributes its *timestamp*, not
   *  its delta: that delta was travelled before the window opened, and counting it against zero
   *  elapsed time inflated every reading. `now` past the last sample is a pause before the lift,
   *  which correctly decays the result towards 0. */
  const velocity = (now: number): number => {
    samples = samples.filter((s) => now - s.ts <= 100);
    if (samples.length < 2) return 0;
    const dt = Math.max(1, now - samples[0]!.ts);
    const v = samples.slice(1).reduce((a, s) => a + s.dx, 0) / dt;
    /* Clamped to what a hand can actually do. Two deltas that arrive in the same millisecond divide
       by the 1ms floor above and report tens of pixels per millisecond — a measurement artefact, not
       a throw — and it is handed to a spring as an initial velocity, where it becomes a page flung
       clean off the track and swinging back. A real trackpad flick peaks near 3px/ms. */
    return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
  };

  /** Committed if the drag is already past the threshold, or heading there fast enough to arrive.
   *
   *  "Fast enough" is a PROJECTION, not a velocity threshold: where the fingers were going, at the
   *  rate a scroll decelerates, is a question with one answer on the same scale as the distance — so
   *  a flick and a shove are told apart by the same number, and there is no second constant to keep
   *  in sync with the first. */
  const past = (now: number): boolean => {
    if (Math.abs(acc) >= commitPx()) return true;
    if (Math.abs(acc) < flickMinPx) return false;
    const v = velocity(now);
    if (Math.sign(v) !== Math.sign(acc)) return false; // already being pulled back
    return Math.abs(acc + project(v, decelerationRate)) >= commitPx();
  };

  const decide = (now: number): SwipeUpdate => {
    const v = velocity(now);
    const wall = (acc > 0 && !lastBounds.canNext) || (acc < 0 && !lastBounds.canPrev);
    if (!wall && past(now)) {
      const dir = acc > 0 ? "next" : "prev";
      acc = 0; shown = 0; samples = []; locked = true; lastCommitDir = dir;
      return { type: "commit", dir, velocity: v };
    }
    const had = shown !== 0;
    acc = 0; shown = 0; samples = [];
    return had ? { type: "settle", velocity: v } : { type: "ignore" };
  };

  return {
    wheel(dx: number, dy: number, ts: number, bounds: SwipeBounds): SwipeUpdate {
      lastBounds = bounds;
      /* One space is not a track. There is nowhere to go in either direction, so the page does not
         move at all — rubber-banding a lone space says "there is more over here" about a place that
         does not exist. */
      if (!bounds.canPrev && !bounds.canNext) {
        const displaced = shown !== 0;
        reset();
        return displaced ? { type: "settle", velocity: 0 } : { type: "ignore" };
      }
      if (!hasPhases && ts - lastTs > idleMs) reset(); // fallback: long gap = new gesture
      lastTs = ts;
      if (locked) {
        // Fallback only: a deliberate swipe *back* during the momentum tail (opposite sign, real
        // magnitude) is a new gesture — don't make the user wait for the tail to die out.
        if (!hasPhases && lastCommitDir && Math.sign(dx) === (lastCommitDir === "next" ? -1 : 1) && Math.abs(dx) >= 6) { reset(); }
        else return { type: "ignore" };
      }
      if (hasPhases && !fingersDown) return { type: "ignore" }; // stray delta after lift (e.g. momentum) — never displaces
      if (!dragging) {
        // Horizontal INTENT before anything moves, rather than merely before a page commits: a
        // diagonal flick down a long list used to slide the whole sidebar a few pixels sideways on
        // its way, which reads as the column being loose.
        if (Math.abs(dx) <= Math.abs(dy) * intentRatio) { pendingX = 0; return { type: "ignore" }; }
        pendingX += dx;
        if (Math.abs(pendingX) < intentPx) return { type: "ignore" };
        dragging = true;
        acc = pendingX;
      } else acc += dx;
      samples.push({ dx, ts });

      const wall = (acc > 0 && !bounds.canNext) || (acc < 0 && !bounds.canPrev);
      shown = wall ? rubberband(acc, opts.width, rubber) : acc;

      // Without phases we can't wait for the lift, so commit live on distance/flick.
      if (!hasPhases && !wall) {
        if (past(ts)) {
          const dir = acc > 0 ? "next" : "prev";
          const v = velocity(ts);
          acc = 0; shown = 0; samples = []; locked = true; lastCommitDir = dir;
          return { type: "commit", dir, velocity: v };
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
          fingersDown = true; reset();
          return { type: "ignore" };
        case "changed":
          return { type: "ignore" };
        case "ended":
        case "cancelled": {
          fingersDown = false;
          if (locked) return { type: "ignore" };
          const r = p === "cancelled" ? (shown !== 0 ? ({ type: "settle", velocity: 0 } as const) : ({ type: "ignore" } as const)) : decide(ts);
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
        if (shown !== 0 && ts - lastTs >= staleMs) { reset(); fingersDown = false; return { type: "settle", velocity: 0 }; }
        return { type: "ignore" };
      }
      if (ts - lastTs < idleMs) return { type: "ignore" };
      const had = shown !== 0;
      reset();
      lastTs = -Infinity;
      // No velocity: a gesture that ended in a quiet gap ended at rest, whatever it was doing before.
      return had ? { type: "settle", velocity: 0 } : { type: "ignore" };
    },

    offset(): number { return shown; },
    fingersDown(): boolean { return fingersDown; },
    reset,
  };
}
