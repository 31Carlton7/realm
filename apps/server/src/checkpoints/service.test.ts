import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore } from "../store/sessions";
import { CheckpointsStore } from "../store/checkpoints";
import { CheckpointGit, CHECKPOINT_REF_PREFIX } from "../workspace/checkpoints";
import { CheckpointService, labelFrom } from "./service";

/** Retention budget the tests run against. Small on purpose: the policy is what is under test, not the
 *  production number, and fifty captures is fifty rounds of git subprocesses. */
const KEEP = 5;

/**
 * Real repositories, a real SQLite database, and no mocks. The named mutants this file exists to kill:
 * a restore that does not capture what it overwrites, retention that prunes the undo of the last
 * restore, and a restore that reaches an environment other than the one it belongs to.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "init");
}
const refsIn = (repo: string) => git(repo, "for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_PREFIX}/`).split("\n").filter(Boolean);

let db: Db; let home: string; let envs: EnvironmentsStore; let sessions: SessionsStore; let store: CheckpointsStore;
let svc: CheckpointService; let spaceId: string; let folder: string; let busy: Set<string>;

beforeEach(() => {
  home = tempDir("realm-cpsvc-");
  // These tests rewrite working trees. Anything outside the scratch dir is a bug worth crashing on.
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  db = openDatabase(join(home, "realm.db"));
  const p = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(db, home);
  envs = new EnvironmentsStore(db);
  sessions = new SessionsStore(db);
  store = new CheckpointsStore(db);
  busy = new Set();
  const space = spaces.create({ profileId: p.id, name: "Work", icon: "folder" });
  spaceId = space.id; folder = space.folderPath;
  svc = new CheckpointService({
    checkpoints: store, environments: envs, sessions, git: new CheckpointGit(),
    isEnvironmentBusy: (id) => busy.has(id), maxPerEnvironment: KEEP,
  });
});

const primary = () => envs.ensurePrimary(spaceId);
const newSession = (environmentId: string) =>
  sessions.create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", environmentId, title: "s" });

describe("labelFrom", () => {
  it("takes the first line, collapses whitespace and clips", () => {
    expect(labelFrom("  fix   the login\n\nand more ")).toBe("fix the login");
    expect(labelFrom("")).toBe("Untitled turn");
    expect(labelFrom("x".repeat(200))).toHaveLength(72);
  });
});

describe("capture", () => {
  it("records the ref on the row and points it at the commit git wrote", async () => {
    initRepo(folder);
    const env = primary();
    const cp = await svc.capture({ environmentId: env.id, sessionId: null, kind: "manual", label: "one" });
    expect(cp).not.toBeNull();
    expect(cp!.ref).toBe(`${CHECKPOINT_REF_PREFIX}/${env.id}/${cp!.id}`);
    expect(git(folder, "rev-parse", cp!.ref).trim()).toBe(cp!.commitSha);
    expect(svc.list(env.id, null).map((c) => c.id)).toEqual([cp!.id]);
  });

  it("declines, rather than fails, when the checkout is not a git repository", async () => {
    const env = primary(); // a plain folder — an ordinary Realm space
    expect(await svc.capture({ environmentId: env.id, sessionId: null, kind: "manual", label: "one" })).toBeNull();
    expect(svc.list(env.id, null)).toEqual([]);
  });

  it("lists one session's turns without another session's", async () => {
    initRepo(folder);
    const env = primary();
    const a = newSession(env.id); const b = newSession(env.id);
    await svc.capture({ environmentId: env.id, sessionId: a.id, kind: "turn", label: "a1" });
    await svc.capture({ environmentId: env.id, sessionId: b.id, kind: "turn", label: "b1" });
    expect(svc.list(env.id, a.id).map((c) => c.label)).toEqual(["a1"]);
    expect(svc.list(env.id, null).map((c) => c.label)).toEqual(["b1", "a1"]); // newest first
  });
});

describe("restore", () => {
  it("captures the state it is about to overwrite, and that capture undoes it", async () => {
    initRepo(folder);
    const env = primary();
    const first = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: "turn 1" });
    writeFileSync(join(folder, "agent-work.txt"), "hours of work\n");

    const preview = await svc.preview(first!.id);
    const result = await svc.restore(first!.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    expect(existsSync(join(folder, "agent-work.txt"))).toBe(false);

    // The undo checkpoint exists, is a `pre-restore`, and really holds the overwritten work.
    expect(result.undoCheckpointId).not.toBeNull();
    const undo = store.require(result.undoCheckpointId!);
    expect(undo.kind).toBe("pre-restore");
    const undoPreview = await svc.preview(undo.id);
    await svc.restore(undo.id, { filesChanged: undoPreview.filesChanged, commitsRolledBack: undoPreview.commitsRolledBack });
    expect(readFileSync(join(folder, "agent-work.txt"), "utf8")).toBe("hours of work\n");
  });

  it("refuses an acknowledgement that does not match what git reports now", async () => {
    initRepo(folder);
    const env = primary();
    const cp = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: "turn 1" });
    writeFileSync(join(folder, "one.txt"), "1\n");
    const stale = await svc.preview(cp!.id);
    expect(stale.filesChanged).toBe(1);

    writeFileSync(join(folder, "two.txt"), "2\n"); // the agent kept working while the sheet was open
    await expect(svc.restore(cp!.id, { filesChanged: stale.filesChanged, commitsRolledBack: 0 }))
      .rejects.toMatchObject({ code: "RESTORE_UNSAFE" });
    // Nothing was restored, and no `pre-restore` checkpoint was made for a restore that did not happen.
    expect(existsSync(join(folder, "one.txt"))).toBe(true);
    expect(svc.list(env.id, null).filter((c) => c.kind === "pre-restore")).toEqual([]);
  });

  it("refuses while an agent is live in that environment", async () => {
    initRepo(folder);
    const env = primary();
    const cp = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: "turn 1" });
    busy.add(env.id);
    await expect(svc.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 }))
      .rejects.toMatchObject({ code: "CHECKPOINT_ENVIRONMENT_BUSY" });
  });

  it("reaches only the environment the checkpoint belongs to", async () => {
    initRepo(folder);
    const other = tempDir("realm-cp-other-");
    try {
      initRepo(other);
      const mine = primary();
      const theirs = envs.ensureAt(spaceId, other, "checkout");
      const cp = await svc.capture({ environmentId: mine.id, sessionId: null, kind: "turn", label: "turn 1" });

      writeFileSync(join(folder, "mine.txt"), "m\n");
      writeFileSync(join(other, "theirs.txt"), "t\n");
      const preview = await svc.preview(cp!.id);
      expect(preview.environmentId).toBe(mine.id);
      expect(preview.path).toBe(folder);
      expect(preview.filesChanged).toBe(1); // only `mine.txt` — the other checkout is not looked at

      await svc.restore(cp!.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
      expect(existsSync(join(folder, "mine.txt"))).toBe(false);
      // The other environment is untouched: its file survives and it gained no checkpoints.
      expect(existsSync(join(other, "theirs.txt"))).toBe(true);
      expect(svc.list(theirs.id, null)).toEqual([]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it("reports the conversation as not rewound, because no adapter can", async () => {
    initRepo(folder);
    const env = primary();
    const session = newSession(env.id);
    const cp = await svc.capture({ environmentId: env.id, sessionId: session.id, kind: "turn", label: "turn 1" });
    const preview = await svc.preview(cp!.id);
    expect(preview.rewindsConversation).toBe(false);
    const result = await svc.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 });
    expect(result.conversationRewound).toBe(false);
  });

  it("refuses a checkpoint whose objects have been taken away", async () => {
    initRepo(folder);
    const env = primary();
    const cp = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: "turn 1" });
    git(folder, "update-ref", "-d", cp!.ref);
    expect((await svc.preview(cp!.id)).intact).toBe(false);
    await expect(svc.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 }))
      .rejects.toMatchObject({ code: "CHECKPOINT_GONE" });
  });
});

describe("retention", () => {
  it("keeps the newest MAX and deletes both the row and the ref of the rest", async () => {
    initRepo(folder);
    const env = primary();
    const made: string[] = [];
    for (let i = 0; i < KEEP + 5; i++) {
      const cp = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: `turn ${i}` });
      made.push(cp!.id);
    }
    const kept = svc.list(env.id, null);
    expect(kept).toHaveLength(KEEP);
    expect(kept.map((c) => c.label)).toContain(`turn ${KEEP + 4}`);
    expect(kept.map((c) => c.label)).not.toContain("turn 0");
    // The refs went with the rows — a row deleted alone is the disk leak this policy exists to stop.
    expect(refsIn(folder).sort()).toEqual(kept.map((c) => c.ref).sort());
    expect(made.slice(0, 5).some((id) => store.get(id) !== null)).toBe(false);
  });

  // Timeout headroom, not a behaviour change: a restore plus KEEP+5 real-git captures runs ~2s alone
  // but crosses vitest's 5s default under a fully parallel suite — Plan 14 W1 added more real-git
  // test files, and this was the one test the extra contention pushed over.
  it("never prunes the undo of the last restore, however old it gets", { timeout: 20_000 }, async () => {
    initRepo(folder);
    const env = primary();
    const first = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: "turn 1" });
    writeFileSync(join(folder, "work.txt"), "work\n");
    const preview = await svc.preview(first!.id);
    const { undoCheckpointId } = await svc.restore(first!.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    expect(undoCheckpointId).not.toBeNull();

    // Bury it under a full retention window of newer turns.
    for (let i = 0; i < KEEP + 5; i++) {
      await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: `later ${i}` });
    }
    expect(store.get(undoCheckpointId!)).not.toBeNull();
    expect(refsIn(folder)).toContain(store.get(undoCheckpointId!)!.ref);
    // And it still works: the overwritten file comes back.
    const undoPreview = await svc.preview(undoCheckpointId!);
    await svc.restore(undoCheckpointId!, { filesChanged: undoPreview.filesChanged, commitsRolledBack: undoPreview.commitsRolledBack });
    expect(readFileSync(join(folder, "work.txt"), "utf8")).toBe("work\n");
  });

  it("prunes one environment without touching another's refs", async () => {
    initRepo(folder);
    const other = tempDir("realm-cp-other-");
    try {
      initRepo(other);
      const mine = primary();
      const theirs = envs.ensureAt(spaceId, other, "checkout");
      const keeper = await svc.capture({ environmentId: theirs.id, sessionId: null, kind: "turn", label: "theirs" });
      for (let i = 0; i < KEEP + 3; i++) {
        await svc.capture({ environmentId: mine.id, sessionId: null, kind: "turn", label: `t${i}` });
      }
      expect(store.get(keeper!.id)).not.toBeNull();
      expect(refsIn(other)).toEqual([keeper!.ref]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe("forgetEnvironment", () => {
  it("deletes every ref and row for that environment and nothing else", async () => {
    initRepo(folder);
    const other = tempDir("realm-cp-other-");
    try {
      initRepo(other);
      const mine = primary();
      const theirs = envs.ensureAt(spaceId, other, "checkout");
      await svc.capture({ environmentId: mine.id, sessionId: null, kind: "turn", label: "a" });
      await svc.capture({ environmentId: mine.id, sessionId: null, kind: "turn", label: "b" });
      const keeper = await svc.capture({ environmentId: theirs.id, sessionId: null, kind: "turn", label: "c" });

      await svc.forgetEnvironment(mine.id);
      expect(svc.list(mine.id, null)).toEqual([]);
      expect(refsIn(folder)).toEqual([]);
      expect(store.get(keeper!.id)).not.toBeNull();
      expect(refsIn(other)).toEqual([keeper!.ref]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it("also removes a ref whose row was lost — the leak a row-only sweep would leave", async () => {
    initRepo(folder);
    const env = primary();
    const orphan = await svc.capture({ environmentId: env.id, sessionId: null, kind: "turn", label: "orphan" });
    store.delete([orphan!.id]); // the row goes; the ref, and its objects, do not
    expect(refsIn(folder)).toEqual([orphan!.ref]);

    await svc.forgetEnvironment(env.id);
    expect(refsIn(folder)).toEqual([]);
  });
});

describe("captureTurn", () => {
  it("takes a `turn` checkpoint labelled from the message", async () => {
    initRepo(folder);
    const env = primary();
    const session = newSession(env.id);
    const cp = await svc.captureTurn(session.id, "Refactor the login flow\n\nand tidy up");
    expect(cp).toMatchObject({ kind: "turn", label: "Refactor the login flow", sessionId: session.id, environmentId: env.id });
  });

  it("returns null instead of throwing when git cannot capture", async () => {
    const env = primary(); // not a repository
    const session = newSession(env.id);
    expect(await svc.captureTurn(session.id, "hello")).toBeNull();
  });
});
