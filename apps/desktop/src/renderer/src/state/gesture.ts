export type SwipeDir = "next" | "prev";

/** Two-finger horizontal swipe detection from wheel events (trackpad). Pure; time is injected.
 *  Accumulates horizontal deltas; fires once per gesture when |acc| >= threshold, then stays locked
 *  until `idleMs` of silence re-arms it. Vertical-dominant events are ignored. */
export function createSwipeTracker(opts: { threshold: number; idleMs: number }) {
  let acc = 0, lastTs = -Infinity, locked = false;
  return {
    wheel(dx: number, dy: number, ts: number): SwipeDir | null {
      if (ts - lastTs > opts.idleMs) { acc = 0; locked = false; }
      lastTs = ts;
      if (Math.abs(dy) > Math.abs(dx)) return null;
      if (locked) return null;
      acc += dx;
      if (Math.abs(acc) >= opts.threshold) { locked = true; const d: SwipeDir = acc > 0 ? "next" : "prev"; acc = 0; return d; }
      return null;
    },
    /** 0..1 how far towards a switch we are (for the drag preview). */
    progress(): number { return Math.min(1, Math.abs(acc) / opts.threshold); },
    /** Signed accumulated horizontal delta in px. */
    offset(): number { return acc; },
  };
}
