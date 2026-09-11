import { describe, expect, it } from "vitest";
import { Drain, QUIESCENT_HOLD_MS, type DrainCounts } from "./drain";

function harness(initial: DrainCounts) {
  let counts = initial;
  let clock = 0;
  let closes = 0;
  const drain = new Drain({ counts: () => counts, now: () => clock, close: () => { closes++; } });
  return {
    drain,
    closes: () => closes,
    set: (c: DrainCounts) => { counts = c; },
    advance: (ms: number) => { clock += ms; },
  };
}

describe("Drain", () => {
  it("waits while anything is running", () => {
    const h = harness({ liveHandles: 1, activeRuns: 0 });
    for (let i = 0; i < 20; i++) { h.drain.tick(); h.advance(1_000); }
    expect(h.closes()).toBe(0);
    expect(h.drain.quiet).toBe(false);
  });

  it("counts unattended work too — a run nobody is watching still stops a close", () => {
    const h = harness({ liveHandles: 0, activeRuns: 1 });
    h.drain.tick();
    h.advance(QUIESCENT_HOLD_MS * 2);
    h.drain.tick();
    expect(h.closes()).toBe(0);
  });

  it("closes once it has been quiet for the hold", () => {
    const h = harness({ liveHandles: 0, activeRuns: 0 });
    h.drain.tick();
    expect(h.drain.quiet).toBe(true);
    h.advance(QUIESCENT_HOLD_MS - 1);
    h.drain.tick();
    expect(h.closes()).toBe(0); // not yet
    h.advance(1);
    h.drain.tick();
    expect(h.closes()).toBe(1);
  });

  it("restarts the hold when work comes back", () => {
    const h = harness({ liveHandles: 0, activeRuns: 0 });
    h.drain.tick();
    h.advance(QUIESCENT_HOLD_MS - 1);
    // A session that just settled starts its next turn from a queued message. MUTANT: sample
    // quiescence once instead of holding it, and the daemon closes in that gap — taking the queue,
    // and the turn it was about to run, with it.
    h.set({ liveHandles: 1, activeRuns: 0 });
    h.drain.tick();
    expect(h.drain.quiet).toBe(false);
    h.set({ liveHandles: 0, activeRuns: 0 });
    h.drain.tick();
    h.advance(QUIESCENT_HOLD_MS - 1);
    h.drain.tick();
    expect(h.closes()).toBe(0);
  });

  it("closes once and then stops", () => {
    const h = harness({ liveHandles: 0, activeRuns: 0 });
    h.drain.tick();
    h.advance(QUIESCENT_HOLD_MS);
    h.drain.tick(); h.drain.tick(); h.drain.tick();
    expect(h.closes()).toBe(1);
  });
});
