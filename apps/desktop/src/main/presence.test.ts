import { describe, expect, it } from "vitest";
import { AWAY_IDLE_SECONDS, isAway, PRESENCE_REFRESH_MS, PresenceReporter } from "./presence";

function rig() {
  const sent: boolean[] = [];
  const state = { idle: 0, windows: 1, now: 1_000, fail: false };
  const reporter = new PresenceReporter({
    idleSeconds: () => state.idle,
    windows: () => state.windows,
    send: (away) => { sent.push(away); return state.fail ? Promise.reject(new Error("realm-server disconnected")) : Promise.resolve({ ok: true }); },
    now: () => state.now,
  });
  return { sent, state, reporter };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("whether the owner is at this Mac", () => {
  it("is away with the screen locked, with no Realm window, or after two minutes untouched", () => {
    expect(isAway({ idleSeconds: 0, locked: false, windows: 1 })).toBe(false);
    expect(isAway({ idleSeconds: AWAY_IDLE_SECONDS - 1, locked: false, windows: 2 })).toBe(false);
    expect(isAway({ idleSeconds: AWAY_IDLE_SECONDS, locked: false, windows: 1 })).toBe(true);
    expect(isAway({ idleSeconds: 0, locked: true, windows: 1 })).toBe(true);
    expect(isAway({ idleSeconds: 0, locked: false, windows: 0 })).toBe(true);
  });
});

describe("telling the server", () => {
  it("says the first answer, then only changes", () => {
    const r = rig();
    r.reporter.check();
    r.reporter.check();
    r.state.idle = 30;
    r.reporter.check();
    // THE chatty mutant: a report on every poll, fifteen seconds apart, all day.
    expect(r.sent).toEqual([false]);
    r.state.idle = AWAY_IDLE_SECONDS;
    r.reporter.check();
    r.state.idle = 1;
    r.reporter.check();
    expect(r.sent).toEqual([false, true, false]);
  });

  it("is away the moment the screen locks, and back when it unlocks", () => {
    const r = rig();
    r.reporter.check();
    r.reporter.setLocked(true);
    r.reporter.setLocked(false);
    expect(r.sent).toEqual([false, true, false]);
  });

  it("is away when the last window closes, though the owner may still be typing elsewhere", () => {
    const r = rig();
    r.reporter.check();
    r.state.windows = 0;
    r.reporter.check();
    expect(r.sent).toEqual([false, true]);
  });

  it("says an unchanged answer again before the server stops believing it", () => {
    const r = rig();
    r.reporter.check();
    r.state.now += PRESENCE_REFRESH_MS - 1;
    r.reporter.check();
    expect(r.sent).toEqual([false]);
    r.state.now += 1;
    r.reporter.check();
    // Two minutes is well inside the server's five: a present owner never ages into an away one.
    expect(r.sent).toEqual([false, false]);
  });

  it("tells a server that has just connected at once, and tries a failed send again on the next look", async () => {
    const r = rig();
    r.state.fail = true;
    r.reporter.check();
    await settle();
    r.state.fail = false;
    r.reporter.check();
    expect(r.sent).toEqual([false, false]);
    // A restarted server knows nothing: reset tells it, though nothing changed here.
    r.reporter.reset();
    expect(r.sent).toEqual([false, false, false]);
  });
});
