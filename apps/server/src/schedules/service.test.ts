import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { SCHEDULE_CATCHUP_MS, type CreateScheduleInput, type Run } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SchedulesStore } from "../store/schedules";
import { ScheduleService } from "./service";

/**
 * The clock in front of the runs.
 *
 * `RunService` is faked here on purpose, and it is the only thing faked: this suite is about WHEN a
 * firing happens and what the row records, and the real run machinery has its own suite for what
 * happens after. The fake records every `create` so a double-fire is a length assertion rather than
 * something to infer from state.
 *
 * The named mutants:
 *
 *   - a claim that reads without advancing   → "fires once per occurrence"
 *   - catch-up run for every missed minute   → "a laptop that slept"
 *   - a missed firing dropped in silence     → "a laptop that slept"
 *   - one bad schedule taking the tick down  → "a firing that throws"
 *   - `runNow` moving the schedule's clock   → "run now"
 */

let db: Db; let spaceId: string;
let created: { spaceId: string; goal: string; dedupeKey: string | null; title?: string }[];
let nextRunId = 0;
let clock = 0;

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NINE = at(2026, 4, 6, 9); // a Monday

function service() {
  created = [];
  nextRunId = 0;
  const store = new SchedulesStore(db, () => clock);
  const runs = {
    create: (input: { spaceId: string; goal: string; dedupeKey: string | null; title?: string }) => {
      created.push(input);
      return { run: { id: `run${++nextRunId}` } as Run, created: true };
    },
  };
  const svc = new ScheduleService({ store, runs: runs as never, rpc: { broadcast: () => {} }, clock: () => clock });
  return { svc, store };
}

const input = (over: Partial<CreateScheduleInput> = {}): CreateScheduleInput =>
  ({ spaceId, title: "Morning sweep", goal: "check the inbox", cron: "0 9 * * *", enabled: true, constraints: null, ...over });

beforeEach(() => {
  const home = tempDir("realm-sched-");
  db = openDatabase(join(home, "realm.db"));
  const profileId = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" }).id;
  spaceId = new SpacesStore(db, home).create({ profileId, name: "Alpha", icon: "folder" }).id;
  clock = at(2026, 4, 6, 8); // 08:00, an hour before the daily
});

describe("creating a schedule", () => {
  it("computes the next occurrence at creation, so the list can say when", () => {
    const { svc } = service();
    expect(svc.create(input()).nextRunAt).toBe(NINE);
  });

  it("refuses an expression that will never fire, rather than letting it sit in the list looking armed", () => {
    // For unattended work, a schedule that silently never runs can go unnoticed for weeks. The
    // failure belongs on the call the user is watching.
    const { svc } = service();
    expect(() => svc.create(input({ cron: "not a cron" }))).toThrow(/will ever run/);
    expect(() => svc.create(input({ cron: "0 9 30 2 *" }))).toThrow(/will ever run/); // February 30th
    expect(svc.list(spaceId)).toEqual([]);
  });

  it("a schedule created paused has no next occurrence at all", () => {
    const { svc } = service();
    expect(svc.create(input({ enabled: false })).nextRunAt).toBeNull();
  });
});

describe("editing a schedule", () => {
  it("re-derives the next occurrence from the expression the edit leaves behind", () => {
    const { svc } = service();
    const s = svc.create(input());
    expect(svc.update({ id: s.id, cron: "0 17 * * *" }).nextRunAt).toBe(at(2026, 4, 6, 17));
  });

  it("re-arms a paused schedule off the CURRENT clock, not the stale column", () => {
    // The mutant: gating the recompute on `cron` having changed. Re-enabling is exactly the edit a
    // gate would skip, and it would leave `next_run_at` in the past — due forever.
    const { svc } = service();
    const s = svc.create(input());
    expect(svc.update({ id: s.id, enabled: false }).nextRunAt).toBeNull();
    clock = at(2026, 4, 8, 12); // two days later, past the original occurrence
    expect(svc.update({ id: s.id, enabled: true }).nextRunAt).toBe(at(2026, 4, 9, 9));
  });

  it("does not re-validate an edit that leaves the expression alone", () => {
    const { svc, store } = service();
    const s = svc.create(input());
    // A row whose stored expression the current parser refuses (written by another build, edited by
    // hand) must still be pausable — the edit is how a user gets out of that state.
    db.prepare("UPDATE schedules SET cron = 'garbage' WHERE id = ?").run(s.id);
    expect(() => svc.update({ id: s.id, title: "Renamed" })).toThrow(/will ever run/);
    expect(store.get(s.id)!.title).toBe("Morning sweep");
  });
});

describe("the tick", () => {
  it("fires once per occurrence, however many times it is ticked", () => {
    // The claim is what guarantees this: `claimDue` advances `next_run_at` in the same call that
    // reads the row. A read-then-fire would create a run on every tick until the minute passed.
    const { svc } = service();
    svc.create(input());
    clock = NINE;
    svc.tick(); svc.tick(); svc.tick();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ spaceId, goal: "check the inbox", title: "Morning sweep" });
  });

  it("advances to the next occurrence and fires again there", () => {
    const { svc, store } = service();
    const s = svc.create(input());
    clock = NINE; svc.tick();
    expect(store.get(s.id)!.nextRunAt).toBe(at(2026, 4, 7, 9));
    clock = at(2026, 4, 7, 9); svc.tick();
    expect(created).toHaveLength(2);
  });

  it("records the run it made, so the row can point at it", () => {
    const { svc, store } = service();
    const s = svc.create(input());
    clock = NINE; svc.tick();
    const after = store.get(s.id)!;
    expect(after.lastRunAt).toBe(NINE);
    expect(after.lastRunId).toBe("run1");
    expect(after.lastSkippedAt).toBeNull();
  });

  it("keys the dedupe on the OCCURRENCE, so an hourly schedule's next hour is free to run", () => {
    // Keyed on the schedule alone, an hourly job whose 09:00 run was still going would silently
    // skip 10:00 — the run layer would hand back the live run and the schedule would record it as a
    // fresh firing. Keyed on the occurrence, "still running" and "due again" stay different facts.
    const { svc } = service();
    svc.create(input({ cron: "0 * * * *" }));
    clock = NINE; svc.tick();
    clock = at(2026, 4, 6, 10); svc.tick();
    expect(created.map((c) => c.dedupeKey)).toEqual([
      `schedule:${svc.list(spaceId)[0]!.id}:${NINE}`,
      `schedule:${svc.list(spaceId)[0]!.id}:${at(2026, 4, 6, 10)}`,
    ]);
  });

  it("leaves a paused schedule alone", () => {
    const { svc } = service();
    svc.create(input({ enabled: false }));
    clock = NINE; svc.tick();
    expect(created).toEqual([]);
  });
});

describe("a laptop that slept", () => {
  it("catches up ONCE when the miss is recent, not once per missed minute", () => {
    const { svc } = service();
    svc.create(input({ cron: "0 * * * *" })); // hourly: five missed occurrences
    clock = NINE + 5 * 60 * 60 * 1000;
    svc.tick();
    expect(created).toHaveLength(1);
  });

  it("skips a miss older than the catch-up window, and writes down that it did", () => {
    // Unattended work that quietly did not happen is the worst thing this feature could do. The row
    // records the skip so the page can say a Monday was missed.
    const { svc, store } = service();
    const s = svc.create(input());
    clock = NINE + SCHEDULE_CATCHUP_MS + 60_000;
    svc.tick();
    expect(created).toEqual([]);
    const after = store.get(s.id)!;
    expect(after.lastSkippedAt).toBe(clock);
    expect(after.lastRunAt).toBeNull();
    // …and it is armed for the NEXT real occurrence rather than walking forward one day per tick.
    expect(after.nextRunAt).toBe(at(2026, 4, 7, 9));
  });

  it("clears the skip mark once a firing really happens", () => {
    const { svc, store } = service();
    const s = svc.create(input());
    clock = NINE + SCHEDULE_CATCHUP_MS + 60_000; svc.tick();
    expect(store.get(s.id)!.lastSkippedAt).not.toBeNull();
    clock = at(2026, 4, 7, 9); svc.tick();
    expect(store.get(s.id)!.lastSkippedAt).toBeNull();
  });
});

describe("a firing that throws", () => {
  it("does not take the rest of the tick down with it", () => {
    // A run whose constraints no longer resolve — a deleted environment, a skill that has gone —
    // must not leave every later schedule unfired.
    const store = new SchedulesStore(db, () => clock);
    const calls: string[] = [];
    const runs = {
      create: (i: { goal: string }) => {
        calls.push(i.goal);
        if (i.goal === "boom") throw new Error("constraints no longer resolve");
        return { run: { id: "ok" } as Run, created: true };
      },
    };
    const svc = new ScheduleService({ store, runs: runs as never, rpc: { broadcast: () => {} }, clock: () => clock });
    const bad = svc.create(input({ title: "Bad", goal: "boom" }));
    svc.create(input({ title: "Good", goal: "fine" }));
    clock = NINE;
    svc.tick();
    // Both are due at 09:00, so the order between them is the store's; what matters is that BOTH
    // were attempted rather than the throw ending the loop.
    expect(calls).toHaveLength(2);
    expect(calls).toContain("boom");
    expect(calls).toContain("fine");
    // The failure is recorded as a skip: the row must not claim a run it never made.
    const after = store.get(bad.id)!;
    expect(after.lastRunId).toBeNull();
    expect(after.lastSkippedAt).toBe(NINE);
  });
});

describe("run now", () => {
  it("fires immediately WITHOUT moving the schedule's own clock", () => {
    // "Run this now" is how someone checks the goal works. Silently pushing tomorrow's 09:00 firing
    // would be a surprising cost for a button that looks like a preview.
    const { svc, store } = service();
    const s = svc.create(input());
    clock = at(2026, 4, 6, 8, 30);
    svc.runNow(s.id);
    expect(created).toHaveLength(1);
    expect(store.get(s.id)!.nextRunAt).toBe(NINE);
    // …and the real firing still happens.
    clock = NINE; svc.tick();
    expect(created).toHaveLength(2);
  });

  it("works on a paused schedule — pausing the clock is not disabling the goal", () => {
    const { svc } = service();
    const s = svc.create(input({ enabled: false }));
    svc.runNow(s.id);
    expect(created).toHaveLength(1);
  });
});

describe("the timer", () => {
  it("catches up on start, then ticks on the interval, and stops on close", () => {
    vi.useFakeTimers();
    try {
      const { svc } = service();
      svc.create(input()); // at 08:00, so its first occurrence is the 09:00 below
      clock = NINE;
      svc.start();
      expect(created).toHaveLength(1); // the catch-up IS the first tick, not a separate path
      clock = at(2026, 4, 7, 9);
      vi.advanceTimersByTime(60_000);
      expect(created).toHaveLength(2);
      svc.close();
      clock = at(2026, 4, 8, 9);
      vi.advanceTimersByTime(60_000);
      expect(created).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
