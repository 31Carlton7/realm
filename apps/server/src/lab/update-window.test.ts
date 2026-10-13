import { describe, expect, it } from "vitest";
import { labUpdateLine, type LabUpdateState } from "@realm/contracts";
import { INSTALL_GIVE_UP_MS, nextWindow, QUIET_HOLD_MS, UpdateWindow } from "./update-window";

/** Local times, so the window's 04:00 is 04:00 in whatever zone the suite runs in. */
const at = (h: number, m = 0, day = 9) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const MIN = 60_000;

function harness(start: number, o: { hour?: number; cap?: number; saved?: LabUpdateState } = {}) {
  let now = start;
  let hour = o.hour ?? 4;
  let saved: LabUpdateState = o.saved ?? { kind: "idle" };
  const busy = { runs: 0, sessions: 0 };
  const installs: string[] = [];
  let releases = 0;
  const w = new UpdateWindow({
    now: () => now, load: () => saved, save: (s) => { saved = s; },
    hour: () => hour, capMinutes: () => o.cap ?? 30,
    busy: () => ({ ...busy }), install: (v) => installs.push(v), release: () => { releases++; }, changed: () => {},
  });
  return {
    w, busy, installs,
    get saved() { return saved; }, get releases() { return releases; },
    advance(ms: number) { now += ms; w.tick(); },
    set now(v: number) { now = v; },
    set hour(v: number) { hour = v; },
  };
}

describe("nextWindow", () => {
  it("is the next 04:00, today or tomorrow, and now while 04:xx is still running", () => {
    expect(nextWindow(at(1, 30), 4)).toBe(at(4));
    expect(nextWindow(at(15), 4)).toBe(at(4, 0, 10));
    expect(nextWindow(at(4, 20), 4)).toBe(at(4, 20));
    expect(nextWindow(at(5), 4)).toBe(at(4, 0, 10));
  });
});

describe("UpdateWindow", () => {
  it("waits for its hour, holds new team runs, waits out running ones, installs, and resumes on the new version", () => {
    const h = harness(at(15));
    h.w.ready("2.1.0", "2.0.3");
    expect(h.saved).toMatchObject({ kind: "waiting", version: "2.1.0", opensAt: at(4, 0, 10) });
    expect(h.w.holding).toBe(false);

    // 04:00: the window opens with two runs working.
    h.busy.runs = 2;
    h.now = at(4, 0, 10);
    h.w.tick();
    expect(h.saved).toMatchObject({ kind: "draining", running: 2, capAt: at(4, 30, 10) });
    expect(h.w.holding).toBe(true);
    expect(h.installs).toEqual([]);

    // One finishes; still waiting. Then the other.
    h.busy.runs = 1;
    h.advance(5 * MIN);
    expect(h.saved).toMatchObject({ kind: "draining", running: 1 });
    h.busy.runs = 0;
    h.advance(MIN);
    // Quiet must HOLD before the install: a settled turn may start its next one.
    expect(h.installs).toEqual([]);
    h.advance(QUIET_HOLD_MS - 1);
    expect(h.installs).toEqual([]);
    h.advance(1);
    expect(h.installs).toEqual(["2.1.0"]);
    expect(h.saved).toMatchObject({ kind: "installing", leftRunning: 0, heldSince: at(4, 0, 10) });
    expect(h.w.holding).toBe(true);
    expect(h.releases).toBe(0);

    // The relaunched app connects on the new version.
    h.advance(2 * MIN);
    h.w.appVersion("2.1.0");
    expect(h.saved).toMatchObject({ kind: "resumed", applied: true, version: "2.1.0" });
    expect((h.saved as { heldMs: number }).heldMs).toBe(8 * MIN + QUIET_HOLD_MS);
    expect(h.w.holding).toBe(false);
    expect(h.releases).toBe(1);
  });

  it("installs at the cap with work still running, and says how much", () => {
    const h = harness(at(4, 10), { cap: 30 });
    h.busy.runs = 1;
    h.busy.sessions = 1;
    h.w.ready("2.1.0", "2.0.3");
    expect(h.saved.kind).toBe("draining");
    h.advance(29 * MIN);
    expect(h.installs).toEqual([]);
    h.advance(MIN);
    expect(h.installs).toEqual(["2.1.0"]);
    expect(h.saved).toMatchObject({ kind: "installing", leftRunning: 2 });
  });

  it("re-reports of the same update change nothing, and a newer one restarts the wait", () => {
    const h = harness(at(15));
    h.w.ready("2.1.0", "2.0.3");
    const first = h.saved;
    h.w.ready("2.1.0", "2.0.3");
    expect(h.saved).toBe(first);
    h.w.ready("2.1.1", "2.0.3");
    expect(h.saved).toMatchObject({ kind: "waiting", version: "2.1.1" });
  });

  it("opens now when asked", () => {
    const h = harness(at(15));
    h.w.ready("2.1.0", "2.0.3");
    h.w.openNow();
    expect(h.saved.kind).toBe("draining");
    h.advance(QUIET_HOLD_MS);
    expect(h.installs).toEqual(["2.1.0"]);
  });

  it("gives up on an install that never happened, and lets the runs go", () => {
    const h = harness(at(4));
    h.w.ready("2.1.0", "2.0.3");
    h.advance(QUIET_HOLD_MS);
    expect(h.saved.kind).toBe("installing");
    h.advance(INSTALL_GIVE_UP_MS - 1);
    expect(h.saved.kind).toBe("installing");
    h.advance(1);
    expect(h.saved).toMatchObject({ kind: "resumed", applied: false });
    expect(h.releases).toBe(1);
  });

  it("an app back on the old version means the install did not apply", () => {
    const h = harness(at(4));
    h.w.ready("2.1.0", "2.0.3");
    h.advance(QUIET_HOLD_MS);
    h.w.appVersion("2.0.3");
    expect(h.saved).toMatchObject({ kind: "resumed", applied: false, from: "2.0.3" });
  });

  it("keeps holding across a server restart mid-drain", () => {
    const first = harness(at(4));
    first.busy.runs = 1;
    first.w.ready("2.1.0", "2.0.3");
    const reborn = harness(at(4, 5), { saved: first.saved });
    expect(reborn.w.holding).toBe(true);
    reborn.busy.runs = 0;
    reborn.w.tick();
    reborn.advance(QUIET_HOLD_MS);
    expect(reborn.installs).toEqual(["2.1.0"]);
  });

  it("stands down when lab mode is turned off, releasing what it held", () => {
    const h = harness(at(4));
    h.busy.runs = 1;
    h.w.ready("2.1.0", "2.0.3");
    expect(h.w.holding).toBe(true);
    h.w.standDown();
    expect(h.saved).toEqual({ kind: "idle" });
    expect(h.w.holding).toBe(false);
    expect(h.releases).toBe(1);
  });

  it("moves a waiting update when the hour changes", () => {
    const h = harness(at(15), { hour: 4 });
    h.w.ready("2.1.0", "2.0.3");
    expect((h.saved as { opensAt: number }).opensAt).toBe(at(4, 0, 10));
    h.hour = 22;
    h.w.rescheduled();
    expect((h.saved as { opensAt: number }).opensAt).toBe(at(22));
  });
});

describe("labUpdateLine", () => {
  const now = at(3);
  it("says nothing at rest, and one sentence at every other step", () => {
    expect(labUpdateLine({ kind: "idle" }, now)).toBeNull();
    expect(labUpdateLine({ kind: "waiting", version: "2.1.0", from: "2.0.3", readyAt: now, opensAt: at(4) }, now))
      .toBe("Realm v2.1.0 is ready. It installs at 4:00 AM, once team runs have finished.");
    expect(labUpdateLine({ kind: "draining", version: "2.1.0", from: "2.0.3", startedAt: now, capAt: at(4, 30), running: 2 }, now))
      .toBe("Updating to v2.1.0: no new team run starts. Waiting for 2 runs to finish, until 4:30 AM.");
    expect(labUpdateLine({ kind: "installing", version: "2.1.0", from: "2.0.3", at: now, heldSince: now, leftRunning: 1 }, now))
      .toBe("Installing v2.1.0. 1 run still running starts again after the restart.");
    expect(labUpdateLine({ kind: "resumed", version: "2.1.0", from: "2.0.3", at: at(4, 12), applied: true, heldMs: 12 * MIN }, now))
      .toBe("Updated to v2.1.0 at 4:12 AM. Team runs were held for 12 minutes and have started again.");
    expect(labUpdateLine({ kind: "resumed", version: "2.1.0", from: "2.0.3", at: now, applied: false, heldMs: 0 }, now))
      .toBe("The update to v2.1.0 did not install, so Realm stayed on v2.0.3. Team runs have started again.");
  });
});
