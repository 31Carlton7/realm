import { describe, expect, it } from "vitest";
import { BACKOFF_CAP_MS, CRASH_LOOP_LIMIT, DOWN_GRACE_MS, DaemonSupervisor, backoffFor, type SupervisorState } from "./daemon-supervisor";

/** A fake clock and a fake timer queue, so every wait in here is a number rather than a delay. */
function harness(over: { pidAlive?: (pid: number) => boolean; recordedPid?: () => number | null } = {}) {
  let clock = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const states: SupervisorState[] = [];
  let spawns = 0;
  const sup = new DaemonSupervisor({
    logPath: "/tmp/realm/logs/server.log",
    recordedPid: over.recordedPid ?? (() => 4242),
    pidAlive: over.pidAlive ?? (() => false),
    spawn: () => { spawns++; },
    onState: (s) => states.push(s),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as { at: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  return { sup, states, advance, spawns: () => spawns, clock: () => clock };
}

describe("DaemonSupervisor", () => {
  it("respawns a daemon whose pid is gone, once the grace period is up", () => {
    const h = harness({ pidAlive: () => false });
    h.sup.onDisconnected();
    h.sup.tick();
    expect(h.spawns()).toBe(0); // too soon — this is the window an ordinary restart lives in
    h.advance(DOWN_GRACE_MS);
    h.sup.tick();
    expect(h.states.at(-1)).toEqual({ kind: "restarting", attempt: 1 });
    h.advance(backoffFor(1));
    expect(h.spawns()).toBe(1);
  });

  it("never respawns while the recorded pid is alive — that is the two-daemons bug", () => {
    const h = harness({ pidAlive: () => true });
    h.sup.onDisconnected();
    for (let i = 0; i < 20; i++) { h.advance(2_000); h.sup.tick(); }
    expect(h.spawns()).toBe(0);
    expect(h.states.map((s) => s.kind)).toEqual(["disconnected"]);
  });

  it("treats a missing state file as a dead daemon", () => {
    const h = harness({ recordedPid: () => null, pidAlive: () => true });
    h.sup.onDisconnected();
    h.advance(DOWN_GRACE_MS);
    h.sup.tick();
    expect(h.states.at(-1)).toMatchObject({ kind: "restarting" });
  });

  it("backs off, and caps", () => {
    expect(backoffFor(1)).toBe(1_000);
    expect(backoffFor(2)).toBe(2_000);
    expect(backoffFor(5)).toBe(16_000);
    expect(backoffFor(20)).toBe(BACKOFF_CAP_MS);
  });

  it("gives up after a crash loop, naming the log", () => {
    const h = harness({ pidAlive: () => false });
    for (let i = 0; i < CRASH_LOOP_LIMIT + 1; i++) {
      h.sup.onDisconnected();
      h.advance(DOWN_GRACE_MS);
      h.sup.tick();
      h.advance(backoffFor(i + 1));
    }
    expect(h.spawns()).toBe(CRASH_LOOP_LIMIT);
    expect(h.states.at(-1)).toEqual({ kind: "failed", logPath: "/tmp/realm/logs/server.log" });
    // Terminal: nothing after this brings it back, not even a connect.
    h.sup.onConnected();
    expect(h.states.at(-1)).toEqual({ kind: "failed", logPath: "/tmp/realm/logs/server.log" });
  });

  it("a reconnect clears the clock, so the next outage starts from one again", () => {
    const h = harness({ pidAlive: () => false });
    h.sup.onDisconnected();
    h.advance(DOWN_GRACE_MS);
    h.sup.tick();
    h.advance(backoffFor(1));
    h.sup.onConnected();
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
    h.sup.onDisconnected();
    h.advance(DOWN_GRACE_MS);
    h.sup.tick();
    expect(h.states.at(-1)).toEqual({ kind: "restarting", attempt: 1 });
  });

  it("stops cleanly: a pending respawn never fires", () => {
    const h = harness({ pidAlive: () => false });
    h.sup.onDisconnected();
    h.advance(DOWN_GRACE_MS);
    h.sup.tick();
    h.sup.stop();
    h.advance(BACKOFF_CAP_MS);
    expect(h.spawns()).toBe(0);
  });
});
