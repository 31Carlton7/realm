/**
 * A spring, in the two numbers Apple hands designers rather than the three physics hands engineers.
 *
 * Every gesture in this app used to end in a CSS transition: a fixed curve over a fixed duration,
 * started from wherever the fingers left off and ignoring how fast they were going. That is the seam
 * between dragging and animating — you throw a page and it lands at the same speed as one you nudged
 * — and it is also why nothing could be caught mid-flight, because a transition cannot be grabbed,
 * re-aimed, or reversed without a jump.
 *
 * A spring has neither problem. It always animates from its CURRENT value, so an interrupt is just a
 * new target; it carries velocity, so a release hands its speed straight to the animation; and it
 * has no duration to run out, so a re-target mid-flight is continuous rather than a cut.
 *
 * The parameters are `damping` (a ratio: 1 is critically damped and never overshoots, below 1 bounces)
 * and `response` (seconds to reach the target, not a duration — the settle emerges from the physics).
 * Apple's own numbers: 1.0/0.4 to move something, 0.8/0.3 for a drawer or a sheet that was thrown.
 *
 * Pure: no DOM, no rAF, no clock. The caller ticks it with the frame's own delta, which is what makes
 * it testable and what lets one rAF loop drive several of them.
 */

export type SpringOptions = {
  /** Damping ratio. 1 = critically damped (no overshoot); below 1 overshoots and oscillates. */
  damping?: number;
  /** Seconds to arrive. Lower is snappier. */
  response?: number;
};

/** Where a value is considered arrived: a tenth of a pixel, moving under a pixel a second. Both have
 *  to hold — a spring at its target travelling fast is mid-swing, not finished. */
const EPSILON = 0.1;
const EPSILON_V = 1;

/* The integrator's own step, in seconds. A frame is 8–17ms and a dropped frame can be far longer;
 * integrating one big step at 60Hz is stable, but at 200ms (a background tab waking, a stalled main
 * thread) an explicit integrator diverges — the spring flies off rather than catching up. Substeps
 * keep it stable at any frame length for the cost of a few multiplications. */
const MAX_STEP = 1 / 240;
/** Longer than this and the frame is not a frame — the tab was asleep. Advance a quarter second and
 *  let the next frame carry on rather than simulating the whole gap. */
const MAX_FRAME = 0.25;

export type Spring = {
  /** Aim at a new value, keeping whatever velocity the spring already has — that continuity IS the
   *  interruption. Optionally re-tune, for a settle that should be gentler than the throw it follows. */
  to(target: number, opts?: SpringOptions): void;
  /** Put the value here with no motion at all: a hard cut, for a drag frame or a reduced-motion jump. */
  set(value: number, velocity?: number): void;
  /** Add to the current velocity — a release handing over the finger's speed. */
  nudge(velocity: number): void;
  /** Advance by a frame. Returns false once it has arrived and stopped. */
  tick(dtMs: number): boolean;
  value(): number;
  velocity(): number;
  target(): number;
  done(): boolean;
};

export function createSpring(initial = 0, options: SpringOptions = {}): Spring {
  let x = initial;
  let v = 0;
  let target = initial;
  let damping = options.damping ?? 1;
  let response = Math.max(0.01, options.response ?? 0.4);
  let resting = true;

  const settle = () => { x = target; v = 0; resting = true; };

  return {
    to(next, opts) {
      if (opts?.damping !== undefined) damping = opts.damping;
      if (opts?.response !== undefined) response = Math.max(0.01, opts.response);
      target = next;
      resting = false;
    },
    set(value, velocity = 0) { x = value; v = velocity; target = value; resting = velocity === 0; },
    nudge(velocity) { v += velocity; if (velocity !== 0) resting = false; },
    tick(dtMs) {
      if (resting) return false;
      const omega = (2 * Math.PI) / response;
      let remaining = Math.min(MAX_FRAME, Math.max(0, dtMs) / 1000);
      while (remaining > 0) {
        const h = Math.min(MAX_STEP, remaining);
        remaining -= h;
        // Semi-implicit Euler: the acceleration uses the OLD position and the new velocity is what
        // moves it. Explicit Euler (position first) gains energy on every step and never settles.
        const a = -2 * damping * omega * v - omega * omega * (x - target);
        v += a * h;
        x += v * h;
      }
      if (Math.abs(x - target) < EPSILON && Math.abs(v) < EPSILON_V) { settle(); return false; }
      return true;
    },
    value: () => x,
    velocity: () => v,
    target: () => target,
    done: () => resting,
  };
}
