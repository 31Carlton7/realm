import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { RUN_LIVE_STATES } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { RunsStore, type RunInsert } from "./runs";

let db: Db; let store: RunsStore; let spaceA: string; let spaceB: string;

const insert = (extra: Partial<RunInsert> = {}): RunInsert => ({
  spaceId: spaceA, title: "t", goal: "g", agentKind: "fake", environmentId: null,
  constraints: null, dedupeKey: null, maxAttempts: 1, deadlineAt: null, ...extra,
});

beforeEach(() => {
  const home = tempDir("realm-runstore-");
  db = openDatabase(join(home, "realm.db"));
  const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(db, home);
  spaceA = spaces.create({ profileId: profile.id, name: "A", icon: "folder" }).id;
  spaceB = spaces.create({ profileId: profile.id, name: "B", icon: "folder" }).id;
  store = new RunsStore(db);
});

/** Force a row's created_at so ordering tests don't depend on Date.now ties. */
const at = (id: string, createdAt: number) => db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(createdAt, id);

describe("RunsStore — the dedupe key", () => {
  it("refuses a second LIVE run for one key in one space", () => {
    expect(store.create(insert({ dedupeKey: "hw-week-3" }))).not.toBeNull();
    expect(store.create(insert({ dedupeKey: "hw-week-3" }))).toBeNull();
  });

  it("scopes per space — the same key in another space is a different run", () => {
    expect(store.create(insert({ dedupeKey: "hw-week-3" }))).not.toBeNull();
    expect(store.create(insert({ spaceId: spaceB, dedupeKey: "hw-week-3" }))).not.toBeNull();
  });

  it.each(["succeeded", "failed", "cancelled", "expired"] as const)(
    "frees the key once the run is %s — tomorrow's run of a recurring thing must be creatable",
    (state) => {
      const first = store.create(insert({ dedupeKey: "daily" }))!;
      expect(store.create(insert({ dedupeKey: "daily" }))).toBeNull();
      store.update(first.id, { state });
      expect(store.create(insert({ dedupeKey: "daily" }))).not.toBeNull();
    },
  );

  it.each(RUN_LIVE_STATES)("holds the key while the run is %s", (state) => {
    const first = store.create(insert({ dedupeKey: "daily" }))!;
    store.update(first.id, { state });
    expect(store.create(insert({ dedupeKey: "daily" }))).toBeNull();
  });

  it("does not dedupe rows with no key at all", () => {
    expect(store.create(insert({ dedupeKey: null }))).not.toBeNull();
    expect(store.create(insert({ dedupeKey: null }))).not.toBeNull();
  });

  it("findLiveByDedupeKey names the run a collision resolved to", () => {
    const first = store.create(insert({ dedupeKey: "k" }))!;
    expect(store.findLiveByDedupeKey(spaceA, "k")?.id).toBe(first.id);
    store.update(first.id, { state: "succeeded" });
    expect(store.findLiveByDedupeKey(spaceA, "k")).toBeNull();
  });

  it("a violation of a DIFFERENT unique index still throws rather than reading as a collision", () => {
    const run = store.create(insert())!;
    store.openAttempt({ runId: run.id, n: 1, sessionId: null });
    // run_attempts(run_id, n) is unique: a second attempt 1 is a bug, not a dedupe hit.
    expect(() => store.openAttempt({ runId: run.id, n: 1, sessionId: null })).toThrow(/UNIQUE/);
  });
});

describe("RunsStore.claim — compare-and-set", () => {
  it("increments the attempt and moves queued → running", () => {
    const run = store.create(insert())!;
    expect(run.state).toBe("queued");
    expect(run.attempt).toBe(0);
    const claimed = store.claim(run.id)!;
    expect(claimed.state).toBe("running");
    expect(claimed.attempt).toBe(1);
    expect(claimed.startedAt).not.toBeNull();
  });

  it("only ONE of two racing claims wins — the second sees null and does nothing", () => {
    const run = store.create(insert())!;
    expect(store.claim(run.id)).not.toBeNull();
    expect(store.claim(run.id)).toBeNull();
    expect(store.get(run.id)!.attempt).toBe(1); // not 2 — the loser did not also increment
  });

  it.each(["running", "blocked", "succeeded", "failed", "cancelled", "expired"] as const)(
    "refuses to claim a run that is %s", (state) => {
      const run = store.create(insert())!;
      store.update(run.id, { state });
      expect(store.claim(run.id)).toBeNull();
    },
  );

  it("keeps the FIRST startedAt across attempts — a retry does not restate when the run began", () => {
    const run = store.create(insert({ maxAttempts: 3 }))!;
    const first = store.claim(run.id)!.startedAt;
    store.update(run.id, { state: "queued" });
    expect(store.claim(run.id)!.startedAt).toBe(first);
  });
});

describe("RunsStore — listing", () => {
  it("lists one space's runs newest first and never another space's", () => {
    const a = store.create(insert({ title: "a" }))!; at(a.id, 100);
    const b = store.create(insert({ title: "b" }))!; at(b.id, 300);
    const other = store.create(insert({ spaceId: spaceB, title: "other" }))!; at(other.id, 200);
    const { runs } = store.list({ spaceId: spaceA, states: [], cursor: null, limit: 10 });
    expect(runs.map((r) => r.title)).toEqual(["b", "a"]);
  });

  it("narrows to the named states, and an empty list means all", () => {
    const q = store.create(insert({ title: "q" }))!;
    const done = store.create(insert({ title: "done" }))!;
    store.update(done.id, { state: "succeeded" });
    expect(store.list({ spaceId: spaceA, states: ["queued"], cursor: null, limit: 10 }).runs.map((r) => r.title)).toEqual(["q"]);
    expect(store.list({ spaceId: spaceA, states: [], cursor: null, limit: 10 }).runs).toHaveLength(2);
    expect(q.state).toBe("queued");
  });

  it("pages with a keyset cursor and ends on a short page", () => {
    for (let i = 0; i < 5; i++) at(store.create(insert({ title: `r${i}` }))!.id, 100 + i);
    const first = store.list({ spaceId: spaceA, states: [], cursor: null, limit: 2 });
    expect(first.runs.map((r) => r.title)).toEqual(["r4", "r3"]);
    expect(first.nextCursor).not.toBeNull();
    const second = store.list({ spaceId: spaceA, states: [], cursor: first.nextCursor, limit: 2 });
    expect(second.runs.map((r) => r.title)).toEqual(["r2", "r1"]);
    const third = store.list({ spaceId: spaceA, states: [], cursor: second.nextCursor, limit: 2 });
    expect(third.runs.map((r) => r.title)).toEqual(["r0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("a mangled cursor degrades to the first page rather than throwing", () => {
    at(store.create(insert({ title: "only" }))!.id, 100);
    expect(store.list({ spaceId: spaceA, states: [], cursor: "garbage", limit: 10 }).runs.map((r) => r.title)).toEqual(["only"]);
  });

  it("listLive spans every space and excludes terminal runs", () => {
    const live = store.create(insert())!;
    const alsoLive = store.create(insert({ spaceId: spaceB }))!;
    const gone = store.create(insert())!;
    store.update(gone.id, { state: "succeeded" });
    expect(store.listLive().map((r) => r.id).sort()).toEqual([live.id, alsoLive.id].sort());
  });
});

describe("RunsStore — attempts", () => {
  it("opens, closes and lists attempts oldest first", () => {
    const run = store.create(insert())!;
    store.openAttempt({ runId: run.id, n: 1, sessionId: "s1" });
    store.closeAttempt(run.id, "failed", "hit a login wall");
    store.openAttempt({ runId: run.id, n: 2, sessionId: "s1" });
    store.closeAttempt(run.id, "succeeded", null);
    const attempts = store.attempts(run.id);
    expect(attempts.map((a) => [a.n, a.outcome, a.detail])).toEqual([[1, "failed", "hit a login wall"], [2, "succeeded", null]]);
    expect(attempts.every((a) => a.settledAt !== null)).toBe(true);
  });

  it("closes the NEWEST open attempt, never an already-settled one", () => {
    const run = store.create(insert())!;
    store.openAttempt({ runId: run.id, n: 1, sessionId: null });
    store.closeAttempt(run.id, "failed", "first");
    store.openAttempt({ runId: run.id, n: 2, sessionId: null });
    store.closeAttempt(run.id, "succeeded", "second");
    expect(store.attempts(run.id).map((a) => a.outcome)).toEqual(["failed", "succeeded"]);
  });

  it("closing with nothing open is a no-op, not an error — an outcome can arrive twice", () => {
    const run = store.create(insert())!;
    expect(store.closeAttempt(run.id, "failed", null)).toBeNull();
    store.openAttempt({ runId: run.id, n: 1, sessionId: null });
    expect(store.closeAttempt(run.id, "failed", null)).not.toBeNull();
    expect(store.closeAttempt(run.id, "succeeded", null)).toBeNull();
    expect(store.attempts(run.id).map((a) => a.outcome)).toEqual(["failed"]); // not overwritten
  });

  it("cascades attempts away with the run's space", () => {
    const run = store.create(insert())!;
    store.openAttempt({ runId: run.id, n: 1, sessionId: null });
    db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceA);
    expect(store.get(run.id)).toBeNull();
    expect(store.attempts(run.id)).toEqual([]);
  });
});

describe("RunsStore — round-tripping and lookups", () => {
  it("round-trips constraints, and a corrupt blob degrades to no constraints rather than an unreadable row", () => {
    const run = store.create(insert({ constraints: { permissionMode: "plan", skills: ["a"] } }))!;
    expect(store.get(run.id)!.constraints).toEqual({ permissionMode: "plan", skills: ["a"] });
    db.prepare("UPDATE runs SET constraints_json = ? WHERE id = ?").run("{not json", run.id);
    expect(store.get(run.id)!.constraints).toBeNull();
    expect(store.get(run.id)!.goal).toBe("g"); // the rest of the row still reads
  });

  it("findLiveBySessionId ignores a terminal run that still remembers its session", () => {
    const run = store.create(insert())!;
    store.update(run.id, { sessionId: "sess-1" });
    expect(store.findLiveBySessionId("sess-1")?.id).toBe(run.id);
    store.update(run.id, { state: "succeeded" });
    expect(store.findLiveBySessionId("sess-1")).toBeNull();
  });

  it("keeps session_id after the session row is gone — a run's pointer to its transcript is a log, not an FK", () => {
    const run = store.create(insert())!;
    store.update(run.id, { sessionId: "deleted-session" });
    expect(store.get(run.id)!.sessionId).toBe("deleted-session");
  });

  it("an update with no fields touches nothing", () => {
    const run = store.create(insert())!;
    expect(store.update(run.id, {})).toEqual(run);
  });
});

/**
 * The migration hard-codes the live-state list inside a partial index; the contract exports it as
 * `RUN_LIVE_STATES`. Nothing but this test connects them, and the failure mode if they drift is
 * silent and bad: a state that the code calls live but the index does not would let a second run
 * open under a key that is already taken.
 */
describe("the dedupe index and RUN_LIVE_STATES agree", () => {
  it("names exactly the same states", () => {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../db/migrations.ts"), "utf8");
    const index = /CREATE UNIQUE INDEX runs_dedupe[\s\S]*?WHERE dedupe_key IS NOT NULL AND state IN \(([^)]*)\)/.exec(sql);
    expect(index).not.toBeNull();
    const named = [...index![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(named).toEqual([...RUN_LIVE_STATES].sort());
  });
});
