import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type StartOptions } from "@realm/adapters";
import { handoffContextKey, sessionEvent, type AgentKind } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { claudeProjectName } from "../memory/claude-backfill";
import { SettingsStore } from "../store/settings";
import { SessionEventsStore, SessionsStore } from "../store/sessions";

/**
 * `sessions.move` through the real RPC surface, database, repository and (scripted) adapters: the
 * session lands in the new checkout with its uncommitted work, its agent finds its conversation there
 * or is handed it as notes, it is told once that it moved — and a move that fails leaves everything
 * as it was.
 */
let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  const statuses: string[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if ("id" in m) pending.get(m.id)?.(m);
    else if (m.event === "session.status") statuses.push(m.payload.status);
  });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 20_000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, statuses, close: () => ws.close() };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  /** Throw on a start that resumes, the way an engine that cannot boot at the target would fail. */
  failResume = false;
  /** On a start that resumes: hold the engine's first event until `release`, or report a failure. */
  onResume: "slow" | "error" | null = null;
  release: () => void = () => {};
  override start(o: StartOptions) {
    this.starts.push(o);
    if (this.failResume && o.resume) throw new Error("the engine would not start there");
    const h = super.start(o);
    if (!o.resume || !this.onResume) return h;
    const how = this.onResume;
    const held = new Promise<void>((r) => { this.release = r; });
    async function* events() {
      if (how === "error") {
        yield sessionEvent("error", { message: "signed out at the target" });
        yield sessionEvent("status", { status: "error" });
        return;
      }
      await held;
      yield* h.events;
    }
    return Object.assign(Object.create(h), { events: events() });
  }
}

// The fake matches on the text it is handed, preface and all — and the preface names the branch,
// which is named for the first message — so no first message here is a scripted token.
const SCRIPT = [
  { on: "ask-permission", emit: [{ kind: "tool" as const, name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] },
  // Cards Realm raises itself, through the session's gateway: the adapter knows nothing of them.
  { on: "open-a-pane", emit: [{ kind: "call" as const, tool: "realm-browser__browser_open", input: { url: "https://example.com" } }] },
  { on: "ask-a-question", emit: [{ kind: "call" as const, tool: "realm-ui__ui_ask", input: { questions: [
    { id: "db", prompt: "Which database?", kind: "choice", options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }] },
];

async function setup(kind: AgentKind, resume?: "continued" | "declined" | "unsupported") {
  const home = tempDir("realm-move-");
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  const claudeCfg = join(home, "claude-cfg");
  const agent = new RecordingFake({ script: SCRIPT, ...(resume ? { resume } : {}) });
  app = await createApp({ home, port: 0, adapters: { [kind]: agent } as never, accounts: { defaults: { claude: claudeCfg, codex: join(home, "codex-home") } } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const repo: string = sp.folderPath;
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "bee\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: kind, permissionMode: "default" })).result;
  await turn(c, session.id, "start");
  // Uncommitted work of every kind: an edit, a staged edit, an untracked file, and an ignored secret.
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "b.txt"), "bees\n"); git(repo, "add", "b.txt");
  writeFileSync(join(repo, "new.txt"), "fresh\n");
  writeFileSync(join(repo, ".env"), "TOKEN=x\n");
  const row = (await c.call("sessions.get", { id: session.id })).result;
  return { home, c, sp, repo, session: row, agent, claudeCfg };
}

const idle = (c: Awaited<ReturnType<typeof client>>, id: string) =>
  waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle");
const eventsOf = async (c: Awaited<ReturnType<typeof client>>, id: string) =>
  (await c.call("sessions.events", { id, afterSeq: 0, limit: 2000 })).result.map((e: Any) => e.event);
/** Send, and wait for the answer: `idle` alone is already true before the turn has begun. */
async function turn(c: Awaited<ReturnType<typeof client>>, id: string, text: string): Promise<string> {
  const answers = async () => (await eventsOf(c, id)).filter((e: Any) => e.type === "assistant_text");
  const before = (await answers()).length;
  await c.call("sessions.send", { id, text });
  await waitFor(async () => (await answers()).length > before);
  await idle(c, id);
  return (await answers()).at(-1).payload.text;
}
const status = (cwd: string) => git(cwd, "status", "--porcelain").split("\n").filter(Boolean).sort();

describe("sessions.move", () => {
  it("moves a Claude session into a new worktree with its changes, its record and a one-time preface", async () => {
    const { c, repo, session, agent, claudeCfg, sp } = await setup("claude");
    const pid: string = session.providerSessionId;
    const record = join(claudeCfg, "projects", claudeProjectName(realpathSync(repo)), `${pid}.jsonl`);
    mkdirSync(join(record, ".."), { recursive: true });
    writeFileSync(record, "{\"conversation\":true}\n");
    const sourceStatus = status(repo);

    const moved = (await c.call("sessions.move", { id: session.id, to: { kind: "worktree" } })).result;
    const env = (await c.call("environments.list", { spaceId: sp.id })).result.find((e: Any) => e.id === moved.environmentId);
    expect(env.kind).toBe("worktree");
    expect(moved).toMatchObject({ status: "idle", providerSessionId: pid, cwd: env.path });

    // The work came with it, staged as it was staged; the source is untouched.
    expect(readFileSync(join(env.path, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(env.path, "new.txt"), "utf8")).toBe("fresh\n");
    expect(status(env.path)).toEqual(sourceStatus.filter((l) => !l.includes(".env")));
    expect(existsSync(join(env.path, ".env"))).toBe(false);
    expect(status(repo)).toEqual(sourceStatus);

    // Claude's record is where the CLI looks first from the new cwd.
    expect(readFileSync(join(claudeCfg, "projects", claudeProjectName(realpathSync(env.path)), `${pid}.jsonl`), "utf8")).toBe("{\"conversation\":true}\n");
    // …and the old cwd's copy is gone from its reach, so a later account switch cannot carry a stale one.
    expect(existsSync(record)).toBe(false);

    const events = await eventsOf(c, session.id);
    const line = events.find((e: Any) => e.type === "moved").payload;
    expect(line).toMatchObject({ conversation: "native", changedFiles: 3, leftBehind: [".env"], from: { cwd: repo }, to: { cwd: env.path } });
    expect(line.note).toContain("The conversation continued.");
    expect(events.some((e: Any) => e.type === "context_reset")).toBe(false);
    const cps = (await c.call("checkpoints.list", { environmentId: session.environmentId, sessionId: session.id })).result;
    expect(cps.some((cp: Any) => cp.label === "Before move to a new worktree")).toBe(true);

    // The next turn resumes there and is told it moved; the one after is not told again.
    const before = agent.starts.length;
    const echo = await turn(c, session.id, "carry on");
    expect(agent.starts[before]).toMatchObject({ cwd: env.path, resume: pid });
    expect(echo).toContain(line.preface);
    expect(line.preface).toContain(`now runs in ${env.path}`);
    expect(await turn(c, session.id, "and again")).not.toContain("Realm moved");
  });

  it("carries a Codex conversation as notes when its resume is declined at the target", async () => {
    const { c, sp, repo, session, agent, home } = await setup("codex", "declined");
    const target = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "elsewhere" })).result;
    // The checkout has work of its own, which the move must leave as it found it.
    writeFileSync(join(target.path, "own.txt"), "mine\n"); git(target.path, "add", "own.txt");
    writeFileSync(join(target.path, "scratch.txt"), "notes\n");
    const starts = agent.starts.length;

    const moved = (await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: target.id } })).result;
    expect(moved).toMatchObject({ environmentId: target.id, providerSessionId: null, status: "idle" });
    // Booted once at the target, asked to resume — and declined.
    expect(agent.starts[starts]).toMatchObject({ cwd: target.path, resume: session.providerSessionId });
    expect(readFileSync(join(target.path, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(target.path, "new.txt"), "utf8")).toBe("fresh\n");
    expect(status(target.path)).toEqual([" M a.txt", " M b.txt", "?? new.txt", "?? scratch.txt", "A  own.txt"].sort());

    const events = await eventsOf(c, session.id);
    expect(events.find((e: Any) => e.type === "moved").payload.conversation).toBe("notes");
    // The moved line tells it; a context_reset beside it would contradict the notes.
    expect(events.some((e: Any) => e.type === "context_reset")).toBe(false);
    const context = new SettingsStore(app!.db).get(handoffContextKey(session.id)) as string;
    expect(context).toContain("# Moved mid-session");
    expect(context).toContain(`now under ${target.path}`);

    await turn(c, session.id, "go on");
    const last = agent.starts.at(-1)!;
    expect(last).toMatchObject({ cwd: target.path, resume: null });
    expect(last.systemContext).toContain("# Moved mid-session");
    expect(existsSync(join(home, "handoffs", session.id, "handoff-1.md"))).toBe(true);
    expect(status(repo)).toContain("?? new.txt");
  });

  it("keeps a continued ACP resume native, with the id the engine reported", async () => {
    const { c, sp, session, agent } = await setup("acp:cursor", "continued");
    const target = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "there" })).result;
    c.statuses.length = 0;
    const moved = (await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: target.id } })).result;
    expect(moved).toMatchObject({ environmentId: target.id, providerSessionId: session.providerSessionId });
    // The engine booted at the target reports itself idle; every client still sees one move, start to end.
    expect(c.statuses).toEqual(["moving", "idle"]);
    expect((await eventsOf(c, session.id)).find((e: Any) => e.type === "moved").payload.conversation).toBe("native");
    expect(new SettingsStore(app!.db).get(handoffContextKey(session.id))).toBeFalsy();
    // The engine booted for the move is the one the next turn uses.
    const starts = agent.starts.length;
    await turn(c, session.id, "go on");
    expect(agent.starts.length).toBe(starts);
  });

  it("puts everything back when the target cannot start the engine", async () => {
    const { c, sp, repo, session, agent } = await setup("codex", "continued");
    agent.failResume = true;
    const sourceStatus = status(repo);
    const envsBefore = (await c.call("environments.list", { spaceId: sp.id })).result.length;

    const res = await c.call("sessions.move", { id: session.id, to: { kind: "worktree" } });
    expect(res.error.code).toBe("MOVE_FAILED");
    const row = (await c.call("sessions.get", { id: session.id })).result;
    expect(row).toMatchObject({ environmentId: session.environmentId, providerSessionId: session.providerSessionId, status: "idle" });
    expect((await c.call("environments.list", { spaceId: sp.id })).result.length).toBe(envsBefore);
    expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(status(repo)).toEqual(sourceStatus);
    expect(new SettingsStore(app!.db).get(handoffContextKey(session.id))).toBeFalsy();
    const failed = (await eventsOf(c, session.id)).find((e: Any) => e.type === "move_failed").payload;
    expect(failed).toMatchObject({ step: "boot" });
    expect(failed.reason).toContain("would not start");

    // Unfrozen, and the next send runs where it always did.
    agent.failResume = false;
    await turn(c, session.id, "start");
    expect(agent.starts.at(-1)!.cwd).toBe(repo);
  });

  it("stays moving while the target boots, and a cancel there puts the session back as it was", async () => {
    const { c, session, agent, sp } = await setup("codex", "declined");
    agent.onResume = "slow";
    const moving = c.call("sessions.move", { id: session.id, to: { kind: "worktree" } });
    await waitFor(async () => agent.starts.some((o) => o.resume));
    expect((await c.call("sessions.get", { id: session.id })).result.status).toBe("moving");
    expect((await c.call("sessions.cancelMove", { id: session.id })).result.cancelled).toBe(true);
    agent.release();
    expect((await moving).error.code).toBe("MOVE_FAILED");
    const row = (await c.call("sessions.get", { id: session.id })).result;
    // The declined boot reported a fresh id; the move never committed, so the row keeps the old one.
    expect(row).toMatchObject({ status: "idle", environmentId: session.environmentId, providerSessionId: session.providerSessionId });
    expect((await c.call("environments.list", { spaceId: sp.id })).result.filter((e: Any) => e.kind === "worktree")).toEqual([]);
    expect((await eventsOf(c, session.id)).find((e: Any) => e.type === "move_failed").payload.reason).toBe("the move was cancelled");
  });

  it("fails at boot on the engine's own error rather than waiting it out", async () => {
    const { c, session, agent } = await setup("codex", "continued");
    agent.onResume = "error";
    app!.sessions.moveBootTimeoutMs = 15_000;
    const started = Date.now();
    const res = await c.call("sessions.move", { id: session.id, to: { kind: "worktree" } });
    expect(res.error.message).toContain("signed out at the target");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses changes that conflict with the target's own, and takes back what it merged when a later step fails", async () => {
    const { c, sp, session, agent } = await setup("codex", "continued");
    const target = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "kept" })).result;
    agent.failResume = true;
    const res = await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: target.id } });
    expect(res.error.code).toBe("MOVE_FAILED");
    expect(status(target.path)).toEqual([]);
    expect(readFileSync(join(target.path, "a.txt"), "utf8")).toBe("one\n");

    agent.failResume = false;
    writeFileSync(join(target.path, "a.txt"), "three\n");
    const clash = await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: target.id } });
    expect(clash.error.message).toContain("conflict with the work already there, in a.txt");
    expect(readFileSync(join(target.path, "a.txt"), "utf8")).toBe("three\n");
    expect(status(target.path)).toEqual([" M a.txt"]);
    expect((await eventsOf(c, session.id)).filter((e: Any) => e.type === "move_failed").at(-1).payload.step).toBe("place");
  });

  it("waits out a live turn when asked to, refuses to interrupt it otherwise, and stops it on request", async () => {
    const { c, session, sp } = await setup("claude");
    await c.call("sessions.send", { id: session.id, text: "ask-permission" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "waiting_permission");

    expect((await c.call("sessions.move", { id: session.id, to: { kind: "worktree" } })).error.code).toBe("SESSION_BUSY");
    const queued = (await c.call("sessions.move", { id: session.id, to: { kind: "worktree" }, when: "after-turn" })).result;
    expect(queued.environmentId).toBe(session.environmentId);
    expect((await c.call("sessions.moveOptions", { id: session.id })).result.pending).toBe(true);
    expect((await c.call("sessions.cancelMove", { id: session.id })).result.cancelled).toBe(true);
    expect((await c.call("sessions.cancelMove", { id: session.id })).result.cancelled).toBe(false);

    await c.call("sessions.move", { id: session.id, to: { kind: "worktree" }, when: "after-turn" });
    const pending = (await eventsOf(c, session.id)).filter((e: Any) => e.type === "permission_request").at(-1).payload.requestId;
    await c.call("sessions.respondPermission", { id: session.id, requestId: pending, decision: "allow" });
    await waitFor(async () => (await eventsOf(c, session.id)).some((e: Any) => e.type === "moved"));
    await idle(c, session.id);
    const envs = (await c.call("environments.list", { spaceId: sp.id })).result;
    expect((await c.call("sessions.get", { id: session.id })).result.environmentId).toBe(envs.find((e: Any) => e.kind === "worktree").id);

    // Stop and move: the open card is denied, the turn stopped, and the move made.
    await c.call("sessions.send", { id: session.id, text: "ask-permission" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "waiting_permission");
    const stopped = await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: session.environmentId }, when: "stop" });
    const second = stopped.result;
    expect(second).toMatchObject({ environmentId: session.environmentId, status: "idle" });
    // Back where it started, which kept its changes: they merge to themselves.
    expect(readFileSync(join(second.cwd, "a.txt"), "utf8")).toBe("two\n");
    const responses = (await eventsOf(c, session.id)).filter((e: Any) => e.type === "permission_response");
    expect(responses.at(-1).payload.decision).toBe("deny");
  }, 30_000);

  it("runs one move when a second is asked for while the first stops the turn", async () => {
    const { c, session, sp, repo } = await setup("claude");
    const worktrees = async () => (await c.call("environments.list", { spaceId: sp.id })).result.filter((e: Any) => e.kind === "worktree");
    for (const second of ["stop", "after-turn"]) {
      await c.call("sessions.send", { id: session.id, text: "ask-permission" });
      await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "waiting_permission");
      const before = (await worktrees()).length;
      const moves = async () => (await eventsOf(c, session.id)).filter((e: Any) => e.type === "moved").length;
      const movesBefore = await moves();
      const first = c.call("sessions.move", { id: session.id, to: { kind: "worktree" }, when: "stop" });
      const again = c.call("sessions.move", { id: session.id, to: { kind: "worktree" }, when: second });
      const [a, b] = await Promise.all([first, again]);
      expect(a.result?.status, second).toBe("idle");
      expect(b.error?.code, second).toBe("SESSION_SWITCHING");
      await idle(c, session.id);
      expect((await worktrees()).length, second).toBe(before + 1);
      expect(await moves(), second).toBe(movesBefore + 1);
      // Back to the first checkout, so the next round starts from it.
      await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: session.environmentId } });
    }
    expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(3);
  }, 30_000);

  it("denies a browser tool's card and a ui_ask card when a move stops the turn they are open in", async () => {
    const { c, session } = await setup("claude");
    const stopAndMove = async (text: string, to: Any) => {
      await c.call("sessions.send", { id: session.id, text });
      await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "waiting_permission");
      expect((await c.call("sessions.move", { id: session.id, to, when: "stop" })).result.status).toBe("idle");
    };
    await stopAndMove("open-a-pane", { kind: "worktree" });
    await stopAndMove("ask-a-question", { kind: "environment", environmentId: session.environmentId });

    const events = await eventsOf(c, session.id);
    const requests = events.filter((e: Any) => e.type === "permission_request");
    expect(requests.map((e: Any) => e.payload.toolName)).toEqual(["browser_open", "ui_ask"]);
    for (const { payload } of requests) {
      const answers = events.filter((e: Any) => e.type === "permission_response" && e.payload.requestId === payload.requestId);
      expect(answers.map((e: Any) => e.payload.decision), payload.toolName).toEqual(["deny"]);
    }
    expect(new SessionEventsStore(app!.db).findDanglingPermissions(session.id)).toEqual([]);
  }, 60_000);

  it("merges the changes onto another base when the new worktree starts from one", async () => {
    const { c, repo, session, sp } = await setup("claude");
    const head = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "branch", "other");
    const side = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "side", base: "other" })).result;
    writeFileSync(join(side.path, "c.txt"), "sea\n");
    git(side.path, "add", "c.txt"); git(side.path, "commit", "-qm", "c");
    const base = git(side.path, "rev-parse", "HEAD").trim();
    expect(base).not.toBe(head);

    const moved = (await c.call("sessions.move", { id: session.id, to: { kind: "worktree", base } })).result;
    expect(git(moved.cwd, "rev-parse", "HEAD").trim()).toBe(base);
    expect(readFileSync(join(moved.cwd, "c.txt"), "utf8")).toBe("sea\n");
    expect(readFileSync(join(moved.cwd, "a.txt"), "utf8")).toBe("two\n");
    expect(status(moved.cwd)).toEqual([" M a.txt", " M b.txt", "?? new.txt"]);
    // A worktree made for the move takes no checkpoint of its own.
    expect((await c.call("checkpoints.list", { environmentId: moved.environmentId, sessionId: null })).result).toEqual([]);
  });

  it("resets the source to HEAD after the move only when asked to", async () => {
    const { c, repo, session } = await setup("claude");
    const moved = (await c.call("sessions.move", { id: session.id, to: { kind: "worktree" }, keepSourceChanges: false })).result;
    expect(status(repo)).toEqual([]);
    expect(existsSync(join(repo, ".env"))).toBe(true);
    expect(readFileSync(join(moved.cwd, "new.txt"), "utf8")).toBe("fresh\n");
  });

  it("says what it would carry, and refuses what it cannot do before touching anything", async () => {
    const { c, session, sp } = await setup("claude");
    await c.call("sessions.openTerminal", { id: session.id });
    const options = (await c.call("sessions.moveOptions", { id: session.id })).result;
    expect(options).toMatchObject({ busy: false, blocked: null, pending: false, conversation: "native", changedFiles: 3,
      leftBehind: ["the terminal", ".env"], environments: [], worktree: { available: true, reason: null } });
    expect((await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: session.environmentId } })).error.code).toBe("BAD_REQUEST");
    const other = (await c.call("spaces.create", { profileId: sp.profileId, name: "T" })).result;
    const foreign = (await c.call("environments.list", { spaceId: other.id })).result[0]
      ?? (await c.call("environments.createWorktree", { spaceId: other.id, title: "x" })).result;
    if (foreign) expect((await c.call("sessions.move", { id: session.id, to: { kind: "environment", environmentId: foreign.id } })).error.code).toBe("ENVIRONMENT_WRONG_SPACE");
    expect((await eventsOf(c, session.id)).some((e: Any) => e.type === "move_failed")).toBe(false);

    const moved = (await c.call("sessions.move", { id: session.id, to: { kind: "worktree" } })).result;
    expect((await eventsOf(c, session.id)).find((e: Any) => e.type === "moved").payload.leftBehind).toEqual(["the terminal", ".env"]);
    expect((await c.call("sessions.get", { id: moved.id })).result.terminalItemId).toBeNull();
  });

  it("refuses a teammate's chat, a running sub-agent, and a checkout another session is mid-turn in", async () => {
    const { c, sp, session } = await setup("claude");
    const store = new SessionsStore(app!.db);
    const code = async (req: Any) => (await c.call("sessions.move", { id: session.id, to: { kind: "worktree" }, ...req })).error?.code;

    app!.db.prepare("UPDATE sessions SET teammate_home = 1 WHERE id = ?").run(session.id);
    expect(await code({})).toBe("SESSION_MOVE_REFUSED");
    app!.db.prepare("UPDATE sessions SET teammate_home = 0 WHERE id = ?").run(session.id);

    const child = store.create({ spaceId: sp.id, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default",
      environmentId: session.environmentId, title: "child", dispatchedBy: { kind: "agent_run", sessionId: session.id } });
    store.update({ id: child.id, status: "running" });
    expect(await code({})).toBe("SESSION_MOVE_REFUSED");
    store.update({ id: child.id, status: "idle" });

    // A session mid-turn in the target blocks moving into it; one mid-turn in the source blocks clearing it.
    const target = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "busy" })).result;
    const there = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "claude", environmentId: target.id, permissionMode: "default" })).result.session;
    await c.call("sessions.send", { id: there.id, text: "ask-permission" });
    await waitFor(async () => (await c.call("sessions.get", { id: there.id })).result.status === "waiting_permission");
    expect(await code({ to: { kind: "environment", environmentId: target.id } })).toBe("ENVIRONMENT_BUSY");
    const here = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "claude", environmentId: session.environmentId, permissionMode: "default" })).result.session;
    await c.call("sessions.send", { id: here.id, text: "ask-permission" });
    await waitFor(async () => (await c.call("sessions.get", { id: here.id })).result.status === "waiting_permission");
    expect(await code({ keepSourceChanges: false })).toBe("ENVIRONMENT_BUSY");
    expect((await c.call("sessions.get", { id: session.id })).result.environmentId).toBe(session.environmentId);
    expect((await eventsOf(c, session.id)).some((e: Any) => e.type === "move_failed")).toBe(false);
  });

  it("brings a session the server stopped mid-move back where it was", async () => {
    const { home, session } = await setup("claude");
    new SessionsStore(app!.db).update({ id: session.id, status: "moving" });
    new SettingsStore(app!.db).set(`move.inFlight:${session.id}`, "m1");
    await app!.close();
    app = await createApp({ home, port: 0, adapters: { claude: new FakeAdapter({ script: [] }) } as never });
    const row = new SessionsStore(app.db).get(session.id)!;
    expect(row).toMatchObject({ status: "idle", environmentId: session.environmentId });
    const failed = new SessionEventsStore(app.db).listAfter(session.id, 0, 1000).map((e) => e.event).find((e) => e.type === "move_failed");
    expect(failed?.payload).toMatchObject({ moveId: "m1", step: "commit" });
  });
});
