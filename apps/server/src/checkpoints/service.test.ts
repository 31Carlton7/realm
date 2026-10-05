import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
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
import { decodeSessionCursor, encodeSessionCursor } from "./rewind";

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
/** Every call `CheckpointService` made to the rewind hook, and what the hook answered. The hook is
 *  `SessionService` in production; here it is a spy, because what this file is about is WHETHER and
 *  WHEN the restore asks — the transcript half is exercised end to end in rewind-restore.test.ts. */
let rewinds: { sessionId: string; throughSeq: number; fork: string }[]; let rewindAnswer: boolean;

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
  rewinds = []; rewindAnswer = true;
  svc = new CheckpointService({
    checkpoints: store, environments: envs, sessions, git: new CheckpointGit(),
    isEnvironmentBusy: (id) => busy.has(id), maxPerEnvironment: KEEP,
    rewindSession: (input) => { rewinds.push(input); return rewindAnswer; },
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

describe("a turn's own changes", () => {
  it("measures the turn its checkpoint fronted, and lets the settle claim it so nothing later borrows it", async () => {
    initRepo(folder);
    const env = primary();
    const s = newSession(env.id);
    const cp = await svc.captureTurn(s.id, "edit a");
    expect(svc.frontingCheckpoint(s.id)).toBe(cp!.id);
    writeFileSync(join(folder, "a.txt"), "two\n");
    expect(await svc.turnChanges(cp!.id)).toMatchObject({
      files: [{ path: "a.txt", oldPath: null, status: "modified", additions: 1, deletions: 1 }], totalFiles: 1,
    });
    svc.endTurn(s.id);
    expect(svc.frontingCheckpoint(s.id)).toBeNull();
  });

  it("measures nothing for a checkpoint that is gone, or a checkout that is no longer a repository", async () => {
    initRepo(folder);
    const env = primary();
    const cp = await svc.capture({ environmentId: env.id, sessionId: null, kind: "manual", label: "m" });
    expect(await svc.turnChanges("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    rmSync(join(folder, ".git"), { recursive: true, force: true });
    expect(await svc.turnChanges(cp!.id)).toBeNull();
  });
});

describe("restore", () => {

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

  it("reports no rewind for a checkpoint that never learned where the provider stood", async () => {
    // The ordinary shape for every row written before this feature, and for any turn that never
    // settled: files come back, the agent keeps its memory, and the result says so.
    initRepo(folder);
    const env = primary();
    const session = newSession(env.id);
    const cp = await svc.capture({ environmentId: env.id, sessionId: session.id, kind: "turn", label: "turn 1" });
    const preview = await svc.preview(cp!.id);
    expect(preview.rewindsConversation).toBe(false);
    const result = await svc.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 });
    expect(result.conversationRewound).toBe(false);
    expect(rewinds).toEqual([]);
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
  it("keeps the newest MAX and deletes both the row and the ref of the rest", { timeout: 20_000 }, async () => {
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

/**
 * Conversation rewind: which checkpoints carry a provider cursor, when a restore asks for one, and — the
 * part that is not about features at all — what happens when the workspace restore fails.
 */
describe("conversation rewind", () => {
  /** A Claude session that has already run a turn, with the provider's chain at `end-0`. */
  const runningSession = (environmentId: string, providerSessionId = "prov-1") => {
    const s = newSession(environmentId);
    sessions.update({ id: s.id, providerSessionId });
    sessions.setLastEventSeq(s.id, 7);
    sessions.setProviderCursor(s.id, encodeSessionCursor({ session: providerSessionId, at: "end-0" }));
    return sessions.get(s.id)!;
  };
  /** One whole turn: the checkpoint in front of it, then the settle that completes its cursor. */
  const turn = async (sessionId: string, label: string, chain: { providerSessionId?: string | null; promptUuid?: string | null; endUuid?: string | null } = {}) => {
    const cp = await svc.captureTurn(sessionId, label);
    svc.noteTurnCursor(sessionId, {
      providerSessionId: chain.providerSessionId === undefined ? "prov-1" : chain.providerSessionId,
      promptUuid: chain.promptUuid === undefined ? "p1" : chain.promptUuid,
      endUuid: chain.endUuid === undefined ? "end-1" : chain.endUuid,
    });
    return cp;
  };

  describe("recording the cursor", () => {

    it("writes no cursor for the FIRST turn of a session — there is nothing before it to fork to", async () => {
      initRepo(folder);
      const env = primary();
      const s = newSession(env.id);
      sessions.update({ id: s.id, providerSessionId: "prov-1" });
      const cp = await turn(s.id, "the very first message");
      expect(store.require(cp!.id).providerCursor).toBeNull();
      // But the session now knows where that turn ended, so the NEXT one can be rewound.
      expect(decodeSessionCursor(sessions.providerCursor(s.id))).toEqual({ session: "prov-1", at: "end-1" });
    });

    it("writes no cursor when the two uuids would come from different provider sessions", async () => {
      /* The named mutant: dropping the `session` comparison. The SDK forks to a NEW session id on every
         resume, so a pair spanning a restart names a fork point in a chain the live session may not
         contain — and the resume would be asked for a position that does not exist. */
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id, "prov-1");
      sessions.update({ id: s.id, providerSessionId: "prov-2" }); // the adapter restarted; the SDK forked
      const cp = await turn(s.id, "after a restart", { providerSessionId: "prov-2" });
      expect(store.require(cp!.id).providerCursor).toBeNull();
      expect(decodeSessionCursor(sessions.providerCursor(s.id))).toEqual({ session: "prov-2", at: "end-1" });
    });

    it("writes no cursor when the turn's prompt was never seen", async () => {
      // No `dropsTurn` means no guard, and an unguarded truncation is not on offer — so the pair is
      // stored as nothing rather than as half of itself.
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const cp = await turn(s.id, "prompt not echoed", { promptUuid: null });
      expect(store.require(cp!.id).providerCursor).toBeNull();
    });

    it("records nothing at all for an agent with no truncating resume", async () => {
      initRepo(folder);
      const env = primary();
      const s = sessions.create({ spaceId, projectId: null, agentKind: "codex", model: null, effort: null, permissionMode: "default", environmentId: env.id, title: "s" });
      sessions.update({ id: s.id, providerSessionId: "thread-1" });
      sessions.setProviderCursor(s.id, encodeSessionCursor({ session: "thread-1", at: "end-0" }));
      const cp = await turn(s.id, "codex turn", { providerSessionId: "thread-1" });
      expect(store.require(cp!.id).providerCursor).toBeNull();
      // And the session's own cursor is left alone: AGENT_CONVERSATION_REWIND says codex cannot, and a
      // position recorded for it would be a claim nobody could act on.
      expect(decodeSessionCursor(sessions.providerCursor(s.id))).toEqual({ session: "thread-1", at: "end-0" });
    });

  });

  describe("preview", () => {

    it("stops promising one when the session's provider conversation has moved on", async () => {
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const cp = await turn(s.id, "do the thing");
      sessions.update({ id: s.id, providerSessionId: "prov-2" });
      expect((await svc.preview(cp!.id)).rewindsConversation).toBe(false);
    });

    it("refuses to promise one on a build with no rewind hook wired", async () => {
      // A capability that depends on how the process was assembled has to be reported from the
      // assembled process, not from a table. This harness is the one Realm ships without.
      const unwired = new CheckpointService({ checkpoints: store, environments: envs, sessions, git: new CheckpointGit(), maxPerEnvironment: KEEP });
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const cp = await turn(s.id, "do the thing");
      expect((await unwired.preview(cp!.id)).rewindsConversation).toBe(false);
    });
  });

  describe("restore", () => {

    it("reports what happened, not what preview hoped: a hook that declines makes the answer false", async () => {
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const cp = await turn(s.id, "do the thing");
      rewindAnswer = false; // e.g. the session went live between the preview and the restore
      const result = await svc.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 });
      expect(result.conversationRewound).toBe(false);
    });

    it("stops the agent it rewinds before arming the rewind, and stops nothing on a files-only restore", async () => {
      // The rewind is honoured when that agent next starts, so a handle still running would leave it
      // armed under a conversation nothing truncates. An agent with nothing to rewind is left warm:
      // stopping one that cannot resume would cost it the conversation for no file's sake.
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const order: string[] = [];
      const releasing = new CheckpointService({
        checkpoints: store, environments: envs, sessions, git: new CheckpointGit(), maxPerEnvironment: KEEP,
        releaseSession: async (id) => { order.push(`release ${id}`); },
        rewindSession: () => { order.push("rewind"); return true; },
      });
      const cp = await releasing.captureTurn(s.id, "do the thing");
      releasing.noteTurnCursor(s.id, { providerSessionId: "prov-1", promptUuid: "p1", endUuid: "end-1" });
      await releasing.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 });
      expect(order).toEqual([`release ${s.id}`, "rewind"]);

      order.length = 0;
      const manual = await releasing.capture({ environmentId: env.id, sessionId: null, kind: "manual", label: "by hand" });
      const preview = await releasing.preview(manual!.id);
      await releasing.restore(manual!.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
      expect(order).toEqual([]);
    });

    it("still restores the files when the rewind hook throws", async () => {
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const thrower = new CheckpointService({
        checkpoints: store, environments: envs, sessions, git: new CheckpointGit(), maxPerEnvironment: KEEP,
        rewindSession: () => { throw new Error("transcript write failed"); },
      });
      const cp = await thrower.captureTurn(s.id, "do the thing");
      thrower.noteTurnCursor(s.id, { providerSessionId: "prov-1", promptUuid: "p1", endUuid: "end-1" });
      writeFileSync(join(folder, "agent-work.txt"), "hours of work\n");

      const preview = await thrower.preview(cp!.id);
      const result = await thrower.restore(cp!.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
      // The files are back — which is what the user asked for — and the conversation is honestly
      // reported as not having followed.
      expect(existsSync(join(folder, "agent-work.txt"))).toBe(false);
      expect(result.conversationRewound).toBe(false);
    });

    it("NEVER touches the transcript when the workspace restore fails", async () => {
      /* The corruption this ordering exists to make impossible. A transcript truncated first, on a
         restore that then failed, leaves the turns that wrote the files missing from Realm's record
         while the files are still on disk — and no checkpoint undoes that, because a `pre-restore`
         checkpoint holds a TREE and not a transcript. Moving the rewind above `git.restore` is the
         mutant; this is the test that kills it. */
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const failing = Object.create(CheckpointGit.prototype) as CheckpointGit;
      Object.assign(failing, new CheckpointGit(), { restore: async () => { throw new Error("checkout is locked"); } });
      const brittle = new CheckpointService({
        checkpoints: store, environments: envs, sessions, git: failing, maxPerEnvironment: KEEP,
        rewindSession: (input) => { rewinds.push(input); return true; },
      });
      const cp = await brittle.captureTurn(s.id, "do the thing");
      brittle.noteTurnCursor(s.id, { providerSessionId: "prov-1", promptUuid: "p1", endUuid: "end-1" });
      expect((await brittle.preview(cp!.id)).rewindsConversation).toBe(true);

      await expect(brittle.restore(cp!.id, { filesChanged: 0, commitsRolledBack: 0 })).rejects.toThrow(/checkout is locked/);
      expect(rewinds).toEqual([]);
      // And the pre-restore checkpoint was still taken first, so the failed restore lost nothing.
      expect(brittle.list(env.id, null).some((c) => c.kind === "pre-restore")).toBe(true);
    });

    it("leaves a pre-restore checkpoint with no cursor, so undoing a restore is files only", async () => {
      /* A `pre-restore` checkpoint fronts no turn, so there is no prompt it could honestly declare as
         dropped — and `resumeDropsTurn` validates exactly one turn. Files only is the truthful answer,
         and it is what stops an undo from arming a fork whose shape nobody can state. */
      initRepo(folder);
      const env = primary();
      const s = runningSession(env.id);
      const cp = await turn(s.id, "do the thing");
      writeFileSync(join(folder, "agent-work.txt"), "work\n");
      const preview = await svc.preview(cp!.id);
      const { undoCheckpointId } = await svc.restore(cp!.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });

      const undo = store.require(undoCheckpointId!);
      expect(undo.kind).toBe("pre-restore");
      expect(undo.providerCursor).toBeNull();
      expect((await svc.preview(undo.id)).rewindsConversation).toBe(false);
    });
  });

});
