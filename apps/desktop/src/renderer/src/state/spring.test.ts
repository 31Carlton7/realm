import { describe, expect, it } from "vitest";
import { createSpring } from "./spring";

/** Run to rest, or give up — a spring that never settles is the bug most of these look for. */
function run(s: ReturnType<typeof createSpring>, frameMs = 16, maxFrames = 2000) {
  let frames = 0;
  while (s.tick(frameMs)) if (++frames > maxFrames) throw new Error(`did not settle in ${maxFrames} frames`);
  return frames;
}

/** The furthest the value ever gets past its target, as a fraction of the distance travelled. */
function overshoot(s: ReturnType<typeof createSpring>, target: number, frameMs = 16) {
  let worst = 0;
  while (s.tick(frameMs)) worst = Math.max(worst, (s.value() - target) / Math.abs(target || 1));
  return worst;
}

describe("createSpring", () => {
  it("arrives, and stops exactly on the target", () => {
    const s = createSpring(0);
    s.to(100);
    run(s);
    expect(s.value()).toBe(100);
    expect(s.velocity()).toBe(0);
    expect(s.done()).toBe(true);
  });

  it("a critically damped spring never overshoots", () => {
    /* THE default, and the reason it is the default: overshoot on something that merely appeared
       reads as sloppiness. Bounce is reserved for motion a hand actually threw. */
    const s = createSpring(0, { damping: 1, response: 0.4 });
    s.to(100);
    expect(overshoot(s, 100)).toBeLessThanOrEqual(0.001);
  });

  it("an under-damped spring overshoots, which is what makes a thrown thing feel thrown", () => {
    const s = createSpring(0, { damping: 0.7, response: 0.4 });
    s.to(100);
    expect(overshoot(s, 100)).toBeGreaterThan(0.02);
  });

  it("response is the dial for how quick it is", () => {
    const quick = createSpring(0, { response: 0.2 }); quick.to(100);
    const slow = createSpring(0, { response: 0.6 }); slow.to(100);
    expect(run(quick)).toBeLessThan(run(slow));
  });

  it("carries a handed-over velocity into the motion", () => {
    /* The seam this exists to close: a page thrown at 2000px/s and one nudged at 100px/s used to
       land in the same 300ms, because the animation started from rest either way. */
    const thrown = createSpring(0, { damping: 1, response: 0.4 });
    thrown.to(100); thrown.nudge(2000);
    thrown.tick(16);
    const nudged = createSpring(0, { damping: 1, response: 0.4 });
    nudged.to(100);
    nudged.tick(16);
    expect(thrown.value()).toBeGreaterThan(nudged.value() * 3);
  });

  it("a velocity pointing away still comes back — it is a spring, not a throw", () => {
    const s = createSpring(0, { damping: 1, response: 0.3 });
    s.to(0); s.nudge(-800);
    s.tick(16);
    expect(s.value()).toBeLessThan(0); // it left
    run(s);
    expect(s.value()).toBe(0); // …and came home
  });

  it("re-targets from where it IS, keeping its speed — the whole point of an interrupt", () => {
    const s = createSpring(0, { damping: 1, response: 0.4 });
    s.to(100);
    for (let i = 0; i < 6; i++) s.tick(16);
    const caught = s.value(), speed = s.velocity();
    expect(caught).toBeGreaterThan(0);
    expect(caught).toBeLessThan(100);

    // A new target mid-flight must not teleport the value or stop it dead: both would be the jump a
    // CSS transition makes when it is replaced.
    s.to(-100);
    expect(s.value()).toBe(caught);
    expect(s.velocity()).toBe(speed);
    run(s);
    expect(s.value()).toBe(-100);
  });

  it("survives a frame that is not a frame", () => {
    /* A stalled main thread or a woken tab hands over a 400ms "frame". An explicit integrator
       diverges on one of those; this one substeps and stays put. */
    const s = createSpring(0, { damping: 1, response: 0.4 });
    s.to(100);
    s.tick(400);
    expect(Number.isFinite(s.value())).toBe(true);
    expect(Math.abs(s.value())).toBeLessThanOrEqual(100);
    run(s);
    expect(s.value()).toBe(100);
  });

  it("lands in the same place whatever the frame rate", () => {
    // 120Hz and 60Hz must agree, or the same flick lands differently on two Macs.
    const fast = createSpring(0, { damping: 1, response: 0.4 }); fast.to(100); fast.nudge(600);
    const slow = createSpring(0, { damping: 1, response: 0.4 }); slow.to(100); slow.nudge(600);
    for (let i = 0; i < 12; i++) { fast.tick(8); fast.tick(8); slow.tick(16); }
    expect(Math.abs(fast.value() - slow.value())).toBeLessThan(0.5);
  });

  it("set is a cut, not a move", () => {
    // What a drag frame does: the fingers own the value outright, and no spring is running under it.
    const s = createSpring(0);
    s.to(100);
    s.tick(16);
    s.set(42);
    expect(s.value()).toBe(42);
    expect(s.done()).toBe(true);
    expect(s.tick(16)).toBe(false);
  });
});
