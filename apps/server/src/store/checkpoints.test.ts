import { describe, expect, it, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { newId } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { EnvironmentsStore } from "./environments";
import { SessionsStore } from "./sessions";
import { CheckpointsStore } from "./checkpoints";
import type { CapturedState } from "../workspace/checkpoints";

let db: Db; let envs: EnvironmentsStore; let sessions: SessionsStore; let store: CheckpointsStore;
let spaceId: string; let envId: string;

const state = (n: number): CapturedState =>
  ({ commitSha: `c${n}`, worktreeTree: `w${n}`, indexTree: `i${n}`, headSha: "h", headRef: "refs/heads/main" });

beforeEach(() => {
  const home = tempDir("realm-cpstore-");
  db = openDatabase(join(home, "realm.db"));
  const p = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(db, home);
  envs = new EnvironmentsStore(db);
  sessions = new SessionsStore(db);
  store = new CheckpointsStore(db);
  spaceId = spaces.create({ profileId: p.id, name: "Work", icon: "folder" }).id;
  envId = envs.ensurePrimary(spaceId).id;
});

let seq = 0;
const add = (kind: "turn" | "pre-restore" | "manual", label: string, sessionId: string | null = null, environmentId = envId) => {
  const id = newId();
  return store.create({ id, environmentId, sessionId, kind, label, ref: `refs/realm/checkpoints/${environmentId}/${id}`, state: state(++seq) });
};

describe("ordering", () => {
  it("returns newest first, and breaks a same-millisecond tie by insertion order", () => {
    // Two checkpoints in one millisecond is not hypothetical: a restore captures its undo point
    // microseconds before it runs, so `created_at` alone would make "the newest" ambiguous.
    const a = add("turn", "a"); const b = add("turn", "b"); const c = add("turn", "c");
    // Forced rather than raced: three inserts usually land in one millisecond, but "usually" would
    // make this test tell the truth only most of the time.
    db.exec("UPDATE checkpoints SET created_at = 5");
    expect(store.list(envId).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });
});

describe("lifecycle", () => {
  /** The named mutant: a session's deletion taking its checkpoints with it. The work an agent did is
   *  in the checkout, not in the transcript — closing the session must not throw away the undo. */
  it("keeps a checkpoint when its session is deleted, forgetting only which session it was", () => {
    const s = sessions.create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", environmentId: envId, title: "s" });
    const cp = add("turn", "a turn", s.id);
    sessions.delete(s.id);
    const kept = store.get(cp.id);
    expect(kept).not.toBeNull();
    expect(kept!.sessionId).toBeNull();
    expect(kept!.state.worktreeTree).toBe(cp.commitSha.replace("c", "w"));
  });

  it("drops a checkpoint when its environment is deleted, because there is no tree left to restore into", () => {
    const other = envs.ensureAt(spaceId, "/tmp/other", "checkout");
    const cp = add("turn", "a turn", null, other.id);
    envs.delete(other.id);
    expect(store.get(cp.id)).toBeNull();
  });
});

describe("prunable", () => {
  it("names everything past the budget, oldest first", () => {
    const made = [add("turn", "1"), add("turn", "2"), add("turn", "3"), add("turn", "4")];
    expect(store.prunable(envId, 2).map((c) => c.label)).toEqual(["1", "2"]);
    expect(store.prunable(envId, 10)).toEqual([]);
    expect(made).toHaveLength(4);
  });

  it("never names the newest checkpoint, so an environment always has one to go back to", () => {
    add("turn", "1"); add("turn", "2"); const newest = add("turn", "3");
    expect(store.prunable(envId, 0).map((c) => c.id)).not.toContain(newest.id);
  });

  /** The named mutant: retention pruning the undo of the last restore. It is by construction older
   *  than everything the restore then produced, so "drop the oldest" deletes exactly it, first. */
  it("never names the newest pre-restore checkpoint, however far it falls behind", () => {
    const undo = add("pre-restore", "before restoring");
    for (let i = 0; i < 10; i++) add("turn", `later ${i}`);
    const doomed = store.prunable(envId, 2).map((c) => c.id);
    expect(doomed).not.toContain(undo.id);
    expect(doomed.length).toBeGreaterThan(0); // it really did prune, it just spared that one
  });

  it("spares only the NEWEST pre-restore, not every one of them", () => {
    const old = add("pre-restore", "first undo");
    for (let i = 0; i < 5; i++) add("turn", `t${i}`);
    const recent = add("pre-restore", "second undo");
    for (let i = 0; i < 5; i++) add("turn", `u${i}`);
    const doomed = store.prunable(envId, 2).map((c) => c.id);
    expect(doomed).toContain(old.id);
    expect(doomed).not.toContain(recent.id);
  });

  it("counts each environment's budget separately", () => {
    const other = envs.ensureAt(spaceId, "/tmp/other", "checkout");
    for (let i = 0; i < 5; i++) add("turn", `mine ${i}`);
    const theirs = add("turn", "theirs", null, other.id);
    expect(store.prunable(envId, 2).map((c) => c.id)).not.toContain(theirs.id);
    expect(store.prunable(other.id, 2)).toEqual([]);
  });
});
