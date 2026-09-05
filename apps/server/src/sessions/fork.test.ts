import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { sessionEvent, type Checkpoint } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SettingsStore } from "../store/settings";
import { ItemsStore } from "../store/items";
import { CheckpointsStore } from "../store/checkpoints";
import { SessionsStore, SessionEventsStore } from "../store/sessions";
import { EnvironmentsStore } from "../store/environments";
import { PortAllocator } from "../workspace/ports";
import { WorktreeService } from "../workspace/worktrees";
import { CheckpointGit } from "../workspace/checkpoints";
import { CheckpointService } from "../checkpoints/service";
import { EnvironmentService } from "../environments/service";
import { FORK_CONTEXT_MAX, ForkService, buildForkContext, forkContextKey, forkTitle } from "./fork";
import type { CreateSessionInput } from "./service";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init");
}

function harness() {
  const home = tempDir("realm-fork-");
  const db = openDatabase(join(home, "realm.db"));
  const profiles = new ProfilesStore(db);
  const spaces = new SpacesStore(db, home);
  const settings = new SettingsStore(db);
  const environments = new EnvironmentsStore(db);
  const sessionsStore = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const items = new ItemsStore(db);
  const cpStore = new CheckpointsStore(db);
  const cpGit = new CheckpointGit();
  const worktrees = new WorktreeService(home);
  const envService = new EnvironmentService({ environments, spaces, worktrees, ports: new PortAllocator(db, { probe: async () => true }) });
  const checkpoints = new CheckpointService({ checkpoints: cpStore, environments, sessions: sessionsStore, git: cpGit });

  const p = profiles.create({ name: "W", icon: "x", color: "#000" });
  const space = spaces.create({ profileId: p.id, name: "S", icon: "f" });
  const env = environments.ensurePrimary(space.id);
  initRepo(env.path);

  const broadcasts: { event: string; payload: unknown }[] = [];
  const createSession = (input: CreateSessionInput) => {
    const session = sessionsStore.create({
      spaceId: input.spaceId, projectId: input.projectId, agentKind: input.agentKind, model: input.model,
      effort: input.effort, permissionMode: input.permissionMode ?? "default",
      environmentId: input.environmentId!, title: input.title ?? "s", dispatchedBy: input.dispatchedBy ?? null,
    });
    const item = items.create({ spaceId: input.spaceId, kind: "session", title: session.title, refId: session.id });
    return { session, itemId: item.id };
  };
  const forks = new ForkService({
    checkpoints: cpStore, environments, envService, worktrees, sessionsStore, events, settings, git: cpGit,
    rpc: { broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload }) } as never,
    createSession,
  });

  const newSession = (title = "Fix the login flow") => sessionsStore.create({
    spaceId: space.id, projectId: null, agentKind: "fake", model: "m1", effort: "high",
    permissionMode: "acceptEdits", environmentId: env.id, title,
  });
  const capture = async (sessionId: string | null, label = "a turn") =>
    (await checkpoints.capture({ environmentId: env.id, sessionId, kind: sessionId ? "turn" : "manual", label }))!;

  return { home, db, settings, environments, sessionsStore, events, items, cpStore, cpGit, envService, checkpoints, forks, broadcasts, space, env, newSession, capture };
}

/** Everything durable about the ancestor, for byte-identity assertions across a fork. */
function ancestorSnapshot(h: ReturnType<typeof harness>, sessionId: string) {
  return {
    session: JSON.stringify(h.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId)),
    events: JSON.stringify(h.db.prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY seq").all(sessionId)),
    checkpoints: JSON.stringify(h.db.prepare("SELECT * FROM checkpoints WHERE environment_id = ? ORDER BY rowid").all(h.env.id)),
    refs: git(h.env.path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/realm/"),
    worktreeFiles: git(h.env.path, "status", "--porcelain"),
  };
}

describe("buildForkContext — the fenced, capped summary-of-ancestor", () => {
  it("fences user/assistant turns and states what it is", () => {
    const ctx = buildForkContext({ ancestorTitle: "Login fix", checkpointLabel: "add tests",
      turns: [{ role: "user", text: "please fix login" }, { role: "assistant", text: "done, tests added" }] });
    expect(ctx).toContain('forked from "Login fix" at the checkpoint "add tests"');
    expect(ctx).toContain("could not be rewound");
    expect(ctx).toContain("```transcript\nUser: please fix login\n\nAssistant: done, tests added\n```");
  });

  it("escalates the fence past any backtick run in the transcript — content can never break out", () => {
    const ctx = buildForkContext({ ancestorTitle: "t", checkpointLabel: "l",
      turns: [{ role: "assistant", text: "use ```bash\nrm -rf\n``` carefully" }] });
    expect(ctx).toContain("````transcript");
    expect(ctx.trimEnd().endsWith("````")).toBe(true);
  });

  it("truncates a long transcript to the CAP, keeps the tail, and says so — the unbounded mutant", () => {
    const turns = Array.from({ length: 400 }, (_, i) => ({ role: "user" as const, text: `turn ${i}: ${"x".repeat(200)}` }));
    const ctx = buildForkContext({ ancestorTitle: "t", checkpointLabel: "l", turns });
    expect(ctx.length).toBeLessThan(FORK_CONTEXT_MAX + 1_000); // body capped; header is the slack
    expect(ctx).toContain("truncated to its newest 24,000 characters");
    expect(ctx).not.toContain("turn 0:");         // the oldest turns fell off…
    expect(ctx).toContain("turn 399:");           // …the newest survived
  });

  it("an ancestor with no spoken turns carries no fence and says so", () => {
    const ctx = buildForkContext({ ancestorTitle: "t", checkpointLabel: "l", turns: [] });
    expect(ctx).toContain("no transcript is carried");
    expect(ctx).not.toContain("```");
  });

  it("forkTitle clips to TITLE_MAX", () => {
    expect(forkTitle("short")).toBe("Fork: short");
    expect(forkTitle("x".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("ForkService.fork — the workspace fork", () => {
  it("restores the NEW worktree to the checkpoint's tree while the ancestor stays byte-untouched — the cardinal mutant", { timeout: 20_000 }, async () => {
    const h = harness();
    const s = h.newSession();
    h.events.append(s.id, sessionEvent("user_message", { text: "please change things", attachments: [] }, 1_000));
    h.events.append(s.id, sessionEvent("assistant_text", { messageId: "m1", text: "changed them" }, 2_000));

    // The state the checkpoint captures: a tracked edit plus an untracked file.
    writeFileSync(join(h.env.path, "a.txt"), "two\n");
    writeFileSync(join(h.env.path, "b.txt"), "bee\n");
    const cp = await h.capture(s.id, "please change things");

    // The ancestor moves ON after the checkpoint — and so does its transcript.
    writeFileSync(join(h.env.path, "a.txt"), "three\n");
    writeFileSync(join(h.env.path, "c.txt"), "sea\n");
    h.events.append(s.id, sessionEvent("user_message", { text: "post-checkpoint request", attachments: [] }, cp.createdAt + 10));
    const before = ancestorSnapshot(h, s.id);

    const { session, itemId, environment } = await h.forks.fork(cp.id);

    // The fork: a worktree under Realm's home, at the checkpoint's captured state.
    expect(environment.kind).toBe("worktree");
    expect(environment.path).not.toBe(h.env.path);
    expect(environment.path.startsWith(join(h.home, "worktrees"))).toBe(true);
    expect(readFileSync(join(environment.path, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(environment.path, "b.txt"), "utf8")).toBe("bee\n");   // untracked captured
    expect(existsSync(join(environment.path, "c.txt"))).toBe(false);               // postdates the checkpoint

    // The ancestor: every durable byte exactly as it was, working tree included.
    expect(ancestorSnapshot(h, s.id)).toEqual(before);
    expect(readFileSync(join(h.env.path, "a.txt"), "utf8")).toBe("three\n");
    expect(readFileSync(join(h.env.path, "c.txt"), "utf8")).toBe("sea\n");

    // The new session: pinned to the fork, agent setup copied, origin recorded with the parent link.
    expect(session.environmentId).toBe(environment.id);
    expect(session).toMatchObject({ agentKind: "fake", model: "m1", effort: "high", permissionMode: "acceptEdits" });
    expect(session.dispatchedBy).toEqual({ kind: "fork", sessionId: s.id });
    expect(session.title).toBe("Fork: Fix the login flow");
    expect(h.items.get(itemId)!.refId).toBe(session.id);

    // The carried context: the transcript up to the checkpoint, not the turn after it.
    const ctx = h.forks.extraSystemContext(session.id)!;
    expect(ctx).toContain("please change things");
    expect(ctx).toContain("changed them");
    expect(ctx).not.toContain("post-checkpoint request");
    expect(h.broadcasts).toContainEqual({ event: "environments.changed", payload: { spaceId: h.space.id } });
  });

  it("carries the staged/unstaged split into the fork", async () => {
    const h = harness();
    const s = h.newSession();
    writeFileSync(join(h.env.path, "a.txt"), "staged\n");
    git(h.env.path, "add", "a.txt");
    writeFileSync(join(h.env.path, "a.txt"), "staged-then-edited\n");
    const cp = await h.capture(s.id);
    const { environment } = await h.forks.fork(cp.id);
    expect(readFileSync(join(environment.path, "a.txt"), "utf8")).toBe("staged-then-edited\n");
    expect(git(environment.path, "diff", "--cached", "--name-only")).toContain("a.txt");
    expect(git(environment.path, "diff", "--name-only")).toContain("a.txt"); // the unstaged half too
  });

  it("moves the fork's OWN fresh branch back to the checkpoint's commit — later ancestor commits are not in the fork", async () => {
    const h = harness();
    const s = h.newSession();
    const cp = await h.capture(s.id);
    writeFileSync(join(h.env.path, "later.txt"), "later\n");
    git(h.env.path, "add", "."); git(h.env.path, "commit", "-m", "later");
    const laterSha = git(h.env.path, "rev-parse", "HEAD").trim();
    const { environment } = await h.forks.fork(cp.id);
    expect(git(environment.path, "rev-parse", "HEAD").trim()).toBe(cp.headSha);
    expect(git(environment.path, "rev-parse", "HEAD").trim()).not.toBe(laterSha);
    expect(existsSync(join(environment.path, "later.txt"))).toBe(false);
    // …and the ancestor's own branch did not move.
    expect(git(h.env.path, "rev-parse", "HEAD").trim()).toBe(laterSha);
  });

  it("refuses a checkpoint no session took (FORK_NO_SESSION) — including one whose session was since deleted (ON DELETE SET NULL)", async () => {
    const h = harness();
    const manual = await h.capture(null, "manual point");
    await expect(h.forks.fork(manual.id)).rejects.toMatchObject({ code: "FORK_NO_SESSION" });
    const s = h.newSession();
    const cp = await h.capture(s.id);
    h.sessionsStore.delete(s.id);
    await expect(h.forks.fork(cp.id)).rejects.toMatchObject({ code: "FORK_NO_SESSION" });
  });

  it("refuses when the checkpoint's objects are gone (CHECKPOINT_GONE), creating nothing", async () => {
    const h = harness();
    const s = h.newSession();
    const cp = await h.capture(s.id);
    git(h.env.path, "update-ref", "-d", cp.ref);
    await expect(h.forks.fork(cp.id)).rejects.toMatchObject({ code: "CHECKPOINT_GONE" });
    expect(h.environments.list(h.space.id).filter((e) => e.kind === "worktree")).toHaveLength(0);
  });

  it("unwinds the half-made worktree when extraction fails — no stranded row, no stranded directory", async () => {
    const h = harness();
    const s = h.newSession();
    const cp = await h.capture(s.id);
    // Corrupt the stored worktree tree so `read-tree` fails after the worktree exists. The ref still
    // resolves to the commit, so the intact check passes — this is exactly the mid-fork failure.
    h.db.prepare("UPDATE checkpoints SET worktree_tree = ? WHERE id = ?")
      .run("0000000000000000000000000000000000000000", cp.id);
    await expect(h.forks.fork(cp.id)).rejects.toMatchObject({ code: "FORK_FAILED" });
    expect(h.environments.list(h.space.id).filter((e) => e.kind === "worktree")).toHaveLength(0);
    expect(git(h.env.path, "worktree", "list")).not.toContain("worktrees"); // registration gone too
    expect(h.sessionsStore.list(h.space.id).filter((x) => x.dispatchedBy?.kind === "fork")).toHaveLength(0);
  });

  it("two forks of one checkpoint coexist — names disambiguate, nothing collides", async () => {
    const h = harness();
    const s = h.newSession();
    const cp = await h.capture(s.id);
    const a = await h.forks.fork(cp.id);
    const b = await h.forks.fork(cp.id);
    expect(a.environment.path).not.toBe(b.environment.path);
    expect(a.session.id).not.toBe(b.session.id);
    expect(readFileSync(join(b.environment.path, "a.txt"), "utf8")).toBe("one\n");
  });

  it("the ancestor's checkpoints stay the ancestor's: the fork's fresh environment has none", async () => {
    const h = harness();
    const s = h.newSession();
    const cp = await h.capture(s.id);
    const { environment } = await h.forks.fork(cp.id);
    expect(h.cpStore.list(environment.id)).toHaveLength(0);
    expect(h.cpStore.list(h.env.id).map((c: Checkpoint) => c.id)).toContain(cp.id);
  });

  it("release() forgets a deleted fork's carried context", async () => {
    const h = harness();
    const s = h.newSession();
    h.events.append(s.id, sessionEvent("user_message", { text: "remember me", attachments: [] }, 1_000));
    const cp = await h.capture(s.id);
    const { session } = await h.forks.fork(cp.id);
    expect(h.forks.extraSystemContext(session.id)).toContain("remember me");
    h.forks.release(session.id);
    expect(h.forks.extraSystemContext(session.id)).toBeUndefined();
    expect(h.settings.get(forkContextKey(session.id))).toBeNull();
  });
});
