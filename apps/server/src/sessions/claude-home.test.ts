import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type ProbeResult, type StartOptions } from "@realm/adapters";
import type { AgentAccount, PlanLimits, SessionEventPayload } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

/** Holds a handle's events back until `gate` opens, so a test can act between a start and its `init`. */
async function* held<T>(events: AsyncIterable<T>, gate: Promise<void>): AsyncIterable<T> {
  await gate;
  yield* events;
}

const reading = (over: Partial<SessionEventPayload<"rate_limit">> = {}): SessionEventPayload<"rate_limit"> => ({
  subscriptionType: "max", organization: null, windows: [], alert: "none", alertWindow: null, unavailable: null, detail: null, ...over,
});

/**
 * A scripted agent that answers as Claude and keeps what a config folder decides: the environment
 * each start was handed, the folder each probe was asked about, and an account per folder.
 */
class ClaudeFake extends FakeAdapter {
  starts: { env: Record<string, string>; resume: string | null; wrap: StartOptions["wrap"] }[] = [];
  asked: (string | undefined)[] = [];
  accounts: Record<string, AgentAccount> = {};
  stated: Record<string, string> = {};
  hold: Promise<void> | null = null;
  /** Keeps a probe from answering until it opens. The probe has looked by then: it answers with the
   *  account the folder held when it was asked, as a `claude` that read the Keychain a moment ago. */
  probeHold: Promise<void> | null = null;

  override start(opts: StartOptions): AgentHandle {
    this.starts.push({ env: { ...opts.env }, resume: opts.resume ?? null, wrap: opts.wrap });
    const handle = super.start(opts);
    return this.hold ? { ...handle, events: held(handle.events, this.hold) } : handle;
  }

  override async probe(opts?: { env?: Record<string, string> }): Promise<ProbeResult> {
    const dir = opts?.env?.CLAUDE_CONFIG_DIR;
    this.asked.push(dir);
    const account = this.accounts[dir ?? "default"];
    if (this.probeHold) await this.probeHold;
    return {
      kind: "claude", available: true, version: "2.1.0", loggedIn: account !== undefined, reason: account ? null : "not signed in",
      ...(account ? { account } : {}), ...(dir ? { configDirectory: this.stated[dir] ?? dir } : {}),
    };
  }
}

class CountingFake extends FakeAdapter {
  probes = 0;
  starts: Record<string, string>[] = [];
  override start(opts: StartOptions): AgentHandle { this.starts.push({ ...opts.env }); return super.start(opts); }
  override async probe(): Promise<ProbeResult> { this.probes++; return super.probe(); }
}

const personal: AgentAccount = { email: "me@home.test", organization: null, plan: "max" };
const employer: AgentAccount = { email: "me@work.test", organization: "Work", plan: "team" };

/**
 * An app whose person keeps two Claude config folders: the default one and `~/.claude-work`. Two
 * profiles, a space in each. `userHome` is a scratch folder, so `~` never means the real one.
 */
async function boot(o: {
  script?: ConstructorParameters<typeof FakeAdapter>[0]; titleGenerator?: (text: string, o?: { configDir?: string | null }) => Promise<string>;
  env?: Record<string, string>;
} = {}) {
  const home = tempDir("realm-");
  const userHome = realpathSync(tempDir("realm-user-"));
  const work = join(userHome, ".claude-work");
  const next = join(userHome, ".claude-next");
  for (const dir of [join(userHome, ".claude"), work, next]) mkdirSync(dir);
  mkdirSync(join(userHome, ".claude", "commands"));
  mkdirSync(join(work, "commands"));
  const claude = new ClaudeFake(o.script ?? { script: [], resume: "continued" });
  Object.assign(claude, { kind: "claude" });
  claude.accounts = { default: personal, [work]: employer };
  const fake = new CountingFake({ script: [] });
  app = await createApp({ home, port: 0, userHome, claudeDir: join(userHome, ".claude"), adapters: { fake, claude }, titleGenerator: o.titleGenerator, cli: { env: { PATH: process.env.PATH ?? "", ...o.env } } });
  const c = await client(app.port);
  const mine = (await c.call("profiles.create", { name: "Home" })).result;
  const theirs = (await c.call("profiles.create", { name: "Work" })).result;
  const den = (await c.call("spaces.create", { profileId: mine.id, name: "Den" })).result;
  const office = (await c.call("spaces.create", { profileId: theirs.id, name: "Office" })).result;
  const create = async (spaceId: string, agentKind = "claude"): Promise<string> => (await c.call("sessions.create", { spaceId, agentKind })).result.session.id;
  const turnsEnded = (id: string): number => c.events.filter((e) => e.event === "session.event" && e.payload.sessionId === id && e.payload.event.type === "usage").length;
  /** Send, and wait for the turn to end: by then the start it caused has reported its conversation. */
  const run = async (id: string, text = "hello"): Promise<void> => {
    const before = turnsEnded(id);
    expect((await c.call("sessions.send", { id, text })).error).toBeUndefined();
    await waitFor(() => turnsEnded(id) > before);
    await waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle");
  };
  const notes = (): Record<string, string> => Object.fromEntries((app.db.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'claude.%' ORDER BY key").all() as { key: string; value_json: string }[])
    .map((r) => [r.key, JSON.parse(r.value_json) as string]));
  return { c, claude, fake, userHome, work, next, mine, theirs, den, office, create, run, notes };
}

type World = Awaited<ReturnType<typeof boot>>;

/** Holds every probe of Claude back until `open`. `received` answers once the server has taken in
 *  every call sent before it, so a test knows which asks arrived while a probe was out. */
function gated(w: World): { open: () => void; received: () => Promise<unknown> } {
  let open!: () => void;
  w.claude.probeHold = new Promise<void>((done) => { open = done; });
  return { open, received: () => w.c.call("agents.claudeDir", { profileId: w.mine.id }) };
}

/** A stand-in for a CLI's login that leaves the config folder it ran under beside itself, and
 *  finishes as a login does. `folder` is null until it has run. */
function loginStub(): { bin: string; folder: () => string | null } {
  const dir = tempDir("realm-login-");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${dir}/folder"\nprintf 'Login successful.\\n'\n`, { mode: 0o755 });
  return { bin, folder: () => (existsSync(join(dir, "folder")) ? readFileSync(join(dir, "folder"), "utf8") : null) };
}

/** Waits for the sign-in with no space that `id` names to be reported done. */
const signedIn = (w: World, id: string): Promise<void> =>
  waitFor(() => w.c.events.some((e) => e.event === "agentSignIn.changed" && e.payload.id === id && e.payload.state === "done"));

describe("a profile's Claude config folder, over rpc", () => {
  it("answers the folder in force, takes a new one, and tells every window", async () => {
    const w = await boot();
    expect((await w.c.call("agents.claudeDir", { profileId: w.theirs.id })).result).toEqual({ dir: null, inForce: join(w.userHome, ".claude"), missing: false, override: null, anyNamed: false });
    const set = await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: "~/.claude-work" });
    expect(set.result).toEqual({ dir: w.work, inForce: w.work, missing: false, override: null, anyNamed: true });
    expect((await w.c.call("agents.claudeDir", { profileId: w.theirs.id })).result.dir).toBe(w.work);
    expect((await w.c.call("agents.claudeDir", { profileId: w.mine.id })).result.dir).toBeNull();
    await waitFor(() => w.c.events.some((e) => e.event === "agents.claudeDirChanged"));
    expect(w.c.events.filter((e) => e.event === "agents.claudeDirChanged").map((e) => e.payload)).toEqual([{ profileId: w.theirs.id, dir: w.work, inForce: w.work, missing: false, override: null, anyNamed: true }]);
    w.c.close();
  });

  it("refuses a folder that is not there with its own sentence, and tells nobody", async () => {
    const w = await boot();
    const refused = await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: "~/.claude-wrok" });
    expect(refused.error).toEqual({ code: "CLAUDE_DIR_REFUSED", message: "There is no folder at ~/.claude-wrok. Realm doesn't create one." });
    expect(existsSync(join(w.userHome, ".claude-wrok"))).toBe(false);
    expect((await w.c.call("agents.setClaudeDir", { profileId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", dir: w.work })).error.code).toBe("NOT_FOUND");
    expect((await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: `/${"a".repeat(1024)}` })).error.code).toBe("INVALID_PARAMS");
    expect(w.c.events.some((e) => e.event === "agents.claudeDirChanged")).toBe(false);
    expect(w.notes()).toEqual({});
    w.c.close();
  });

  it("forgets a deleted profile's folder", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.c.call("agents.setClaudeDir", { profileId: w.mine.id, dir: w.next });
    expect((await w.c.call("profiles.delete", { id: w.theirs.id })).error).toBeUndefined();
    expect(w.notes()).toEqual({ [`claude.configDir:${w.mine.id}`]: w.next });
    w.c.close();
  });

  it("says a folder is in use while a process started under one has yet to report its conversation, though the profile that named it has given it back", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id);
    let open!: () => void;
    w.claude.hold = new Promise<void>((resolve) => { open = resolve; });
    await w.c.call("sessions.send", { id, text: "hello" });
    await waitFor(() => w.claude.starts.length === 1);
    const back = await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: null });
    expect(w.notes()).toEqual({});
    const answer = { dir: null, inForce: join(w.userHome, ".claude"), missing: false, override: null, anyNamed: true };
    expect(back.result).toEqual(answer);
    expect((await w.c.call("agents.claudeDir", { profileId: w.mine.id })).result).toEqual(answer);
    expect(w.c.events.filter((e) => e.event === "agents.claudeDirChanged").at(-1).payload).toEqual({ profileId: w.theirs.id, ...answer });
    w.claude.hold = null;
    open();
    await waitFor(async () => (await w.c.call("sessions.get", { id })).result.providerSessionId !== null);
    w.c.close();
  });

  it("says no folder is in use while the only process running was started under the default folder", async () => {
    const w = await boot();
    const id = await w.create(w.den.id);
    let open!: () => void;
    w.claude.hold = new Promise<void>((resolve) => { open = resolve; });
    await w.c.call("sessions.send", { id, text: "hello" });
    await waitFor(() => w.claude.starts.length === 1);
    expect(app.sessions.isLive(id)).toBe(true);
    expect((await w.c.call("agents.claudeDir", { profileId: w.mine.id })).result.anyNamed).toBe(false);
    w.claude.hold = null;
    open();
    await waitFor(async () => (await w.c.call("sessions.get", { id })).result.providerSessionId !== null);
    w.c.close();
  });
});

describe("the folder a session's agent is started under", () => {
  it("is its profile's for a Claude session, and no variable at all where the profile names none", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.run(await w.create(w.office.id));
    await w.run(await w.create(w.den.id));
    expect(w.claude.starts[0]!.env.CLAUDE_CONFIG_DIR).toBe(w.work);
    expect("CLAUDE_CONFIG_DIR" in w.claude.starts[1]!.env).toBe(false);
    expect(w.claude.starts[0]!.env.REALM_PORT_BASE).toBeDefined();
    w.c.close();
  });

  it("is never handed to another agent's process, in a profile that names one", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id, "fake");
    await w.run(id);
    expect("CLAUDE_CONFIG_DIR" in w.fake.starts[0]!).toBe(false);
    expect(w.notes()).toEqual({ [`claude.configDir:${w.theirs.id}`]: w.work });
    w.c.close();
  });

  it("stays the one a conversation began under, when its profile names another afterwards", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id);
    await w.run(id);
    const began = await w.c.call("sessions.get", { id });
    await app.sessions.stopAgent(id);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.next });
    await w.run(id, "again");
    expect(w.claude.starts[1]).toMatchObject({ env: { CLAUDE_CONFIG_DIR: w.work }, resume: began.result.providerSessionId });
    await w.run(await w.create(w.office.id));
    expect(w.claude.starts[2]).toMatchObject({ env: { CLAUDE_CONFIG_DIR: w.next }, resume: null });
    w.c.close();
  });

  it("stays the one its process was started with, when the profile's changes before the conversation is known", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id);
    let open!: () => void;
    w.claude.hold = new Promise<void>((resolve) => { open = resolve; });
    await w.c.call("sessions.send", { id, text: "hello" });
    await waitFor(() => w.claude.starts.length === 1);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.next });
    expect(app.sessions.claudeHome(id)).toBe(w.work);
    w.claude.hold = null;
    open();
    await waitFor(async () => (await w.c.call("sessions.get", { id })).result.providerSessionId !== null);
    expect(w.notes()[`claude.sessionHome:${id}`]).toBe(w.work);
    await app.sessions.stopAgent(id);
    expect(app.sessions.claudeHome(id)).toBe(w.work);
    w.c.close();
  });

  it("is the default one for a conversation from before its profile named a folder", async () => {
    const w = await boot();
    const id = await w.create(w.office.id);
    await w.run(id);
    expect(w.notes()).toEqual({});
    await app.sessions.stopAgent(id);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.run(id, "again");
    expect("CLAUDE_CONFIG_DIR" in w.claude.starts[1]!.env).toBe(false);
    expect(w.claude.starts[1]!.resume).not.toBeNull();
    w.c.close();
  });

  it("is refused when the folder has gone, for a new session and for a conversation, and nothing makes the folder", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const old = await w.create(w.office.id);
    await w.run(old);
    await app.sessions.stopAgent(old);
    rmSync(w.work, { recursive: true });
    const fresh = await w.create(w.office.id);
    expect((await w.c.call("sessions.send", { id: fresh, text: "hello" })).error).toEqual({ code: "CLAUDE_DIR_MISSING",
      message: "~/.claude-work, the Claude config folder for this profile, is missing. Choose another folder on the profile's page, or use the default." });
    expect((await w.c.call("sessions.send", { id: old, text: "again" })).error).toEqual({ code: "CLAUDE_DIR_MISSING",
      message: "This conversation's Claude sign-in is kept in ~/.claude-work, and that folder is missing. Put the folder back to continue the conversation." });
    expect(w.claude.starts).toHaveLength(1);
    expect(app.sessions.isLive(fresh)).toBe(false);
    expect(existsSync(w.work)).toBe(false);
    await w.run(await w.create(w.den.id));
    expect(w.claude.starts).toHaveLength(2);
    w.c.close();
  });

  it("is forgotten with the session", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const kept = await w.create(w.office.id);
    const gone = await w.create(w.office.id);
    await w.run(kept);
    await w.run(gone);
    await w.c.call("sessions.delete", { id: gone });
    expect(Object.keys(w.notes())).toEqual([`claude.configDir:${w.theirs.id}`, `claude.sessionHome:${kept}`]);
    w.c.close();
  });

  it("files a plan reading under the folder the reporting process runs in", async () => {
    const w = await boot({ script: { resume: "continued", script: [{ on: "limit", emit: [{ kind: "rateLimit", payload: reading({ subscriptionType: "team" }) }] }] } });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.run(await w.create(w.office.id), "limit");
    await w.run(await w.create(w.den.id), "limit");
    const rows: PlanLimits[] = (await w.c.call("limits.get", {})).result.limits;
    expect(rows.filter((r) => r.agentKind === "claude").map((r) => r.home)).toEqual([null, w.work]);
    w.c.close();
  });
});

describe("what else follows the folder a session runs under", () => {
  it("lists the memory file of that folder, not of the default one", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const userFiles = async (id: string): Promise<string[]> =>
      (await w.c.call("memory.sources", { sessionId: id })).result.sources.filter((s: Any) => s.origin === "user").map((s: Any) => s.path);
    expect(await userFiles(await w.create(w.office.id))).toEqual([join(w.work, "CLAUDE.md")]);
    expect(await userFiles(await w.create(w.den.id))).toEqual([join(w.userHome, ".claude", "CLAUDE.md")]);
    w.c.close();
  });

  it("keeps listing the folder a conversation began under after its profile names another", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id);
    await w.run(id);
    await app.sessions.stopAgent(id);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.next });
    const sources = (await w.c.call("memory.sources", { sessionId: id })).result.sources;
    expect(sources.filter((s: Any) => s.origin === "user").map((s: Any) => s.path)).toEqual([join(w.work, "CLAUDE.md")]);
    w.c.close();
  });

  it("reads a space's Claude commands from the folder its profile names", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const agentRoots = async (spaceId: string | null): Promise<string[]> =>
      (await w.c.call("commands.sources", { spaceId })).result.sources.filter((s: Any) => s.kind === "agent").map((s: Any) => s.path);
    expect(await agentRoots(w.office.id)).toEqual([join(w.work, "commands")]);
    expect(await agentRoots(w.den.id)).toEqual([join(w.userHome, ".claude", "commands")]);
    expect(await agentRoots(null)).toEqual([join(w.userHome, ".claude", "commands")]);
    w.c.close();
  });

  it("lets a sandboxed session write in its own config folder, and gives no other session that folder", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const confined = { posture: "workspace-write", network: true };
    const office = (await w.c.call("sandbox.set", { spaceId: w.office.id, prefs: confined })).result;
    await w.c.call("sandbox.set", { spaceId: w.den.id, prefs: confined });
    if (!office.available) { w.c.close(); return; }
    expect(office.policy.writableRoots).toContain(w.work);
    await w.run(await w.create(w.office.id));
    await w.run(await w.create(w.den.id));
    const roots = (start: number): string[] => w.claude.starts[start]!.wrap!("claude", []).args.filter((a) => /^REALM_WRITE_\d+=/.test(a));
    expect(roots(0).some((a) => a.endsWith(`=${w.work}`))).toBe(true);
    expect(roots(1).some((a) => a.includes(".claude-work"))).toBe(false);
    w.c.close();
  });

  it("gives a sandboxed conversation the folder it began under, not the one its profile names now", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const state = (await w.c.call("sandbox.set", { spaceId: w.office.id, prefs: { posture: "workspace-write", network: true } })).result;
    if (!state.available) { w.c.close(); return; }
    const id = await w.create(w.office.id);
    await w.run(id);
    await app.sessions.stopAgent(id);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.next });
    await w.run(id, "again");
    const roots = w.claude.starts[1]!.wrap!("claude", []).args.filter((a) => a.includes("="));
    expect(roots.some((a) => a.endsWith(`=${w.work}`))).toBe(true);
    expect(roots.some((a) => a.endsWith(`=${w.next}`))).toBe(false);
    w.c.close();
  });
});

describe("what a sandboxed process may write of a Claude config folder", () => {
  const confined = { posture: "workspace-write", network: true };

  it("freezes what Claude Code runs from a profile's folder for every sandboxed process, another profile's included", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const den = (await w.c.call("sandbox.set", { spaceId: w.den.id, prefs: confined })).result;
    expect(den.policy.readOnlyPaths).toContain(join(w.work, "settings.json"));
    expect(den.policy.readOnlyPaths).toContain(join(w.work, ".claude.json"));
    expect(den.policy.writableRoots).not.toContain(w.work);
    w.c.close();
  });

  it("goes on freezing the folder a conversation began under after its profile names none, until the conversation is deleted", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id);
    await w.run(id);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: null });
    await w.c.call("sandbox.set", { spaceId: w.den.id, prefs: confined });
    const frozen = async (): Promise<string[]> => (await w.c.call("sandbox.get", { spaceId: w.den.id })).result.policy.readOnlyPaths;
    expect(await frozen()).toContain(join(w.work, "settings.json"));
    await w.c.call("sessions.delete", { id });
    expect((await frozen()).some((path) => path.startsWith(w.work))).toBe(false);
    w.c.close();
  });

  it("freezes nothing more where no profile names a folder", async () => {
    const w = await boot();
    const den = (await w.c.call("sandbox.set", { spaceId: w.den.id, prefs: confined })).result;
    expect(den.policy.readOnlyPaths.some((path: string) => path.includes(".claude-"))).toBe(false);
    w.c.close();
  });

  it("gives a terminal no root in a profile's folder that has gone, and goes on freezing what would run from it", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const had = (await w.c.call("sandbox.set", { spaceId: w.office.id, prefs: confined })).result;
    expect(had.policy.writableRoots).toContain(w.work);
    rmSync(w.work, { recursive: true });
    const has = (await w.c.call("sandbox.get", { spaceId: w.office.id })).result;
    expect(has.policy.writableRoots).not.toContain(w.work);
    expect(has.policy.readOnlyPaths).toContain(join(w.work, "settings.json"));
    w.c.close();
  });
});

describe("Claude's probe row, per config folder", () => {
  it("answers for the default folder without a profile, and says so on the row", async () => {
    const w = await boot();
    const rows = (await w.c.call("agents.probe", {})).result;
    expect(rows).toEqual([
      { kind: "fake", available: true, version: "fake", loggedIn: true, reason: null },
      { kind: "claude", available: true, version: "2.1.0", loggedIn: true, reason: null, account: personal, home: null },
    ]);
    expect(w.claude.asked).toEqual([undefined]);
    w.c.close();
  });

  it("answers for the folder a profile names, with that folder's account, and asks no other agent again", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const theirs = (await w.c.call("agents.probe", { profileId: w.theirs.id })).result;
    expect(theirs).toEqual([
      { kind: "fake", available: true, version: "fake", loggedIn: true, reason: null },
      { kind: "claude", available: true, version: "2.1.0", loggedIn: true, reason: null, account: employer, home: w.work },
    ]);
    const mine = (await w.c.call("agents.probe", { profileId: w.mine.id })).result;
    expect(mine[1]).toMatchObject({ account: personal, home: null });
    expect(w.claude.asked).toEqual([undefined, w.work]);
    expect(w.fake.probes).toBe(1);
    w.c.close();
  });

  it("keeps each folder's answer for a while, and asks that folder again when forced", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.c.call("agents.probe", { profileId: w.theirs.id });
    await w.c.call("agents.probe", { profileId: w.theirs.id });
    expect(w.claude.asked).toEqual([undefined, w.work]);
    w.claude.accounts[w.work] = { ...employer, plan: "enterprise" };
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id })).result[1].account.plan).toBe("team");
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id, force: true })).result[1].account.plan).toBe("enterprise");
    expect(w.claude.asked.filter((d) => d === w.work)).toHaveLength(2);
    w.c.close();
  });

  it("asks a folder again once a profile is pointed at it", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    delete w.claude.accounts[w.work];
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id })).result[1].loggedIn).toBe(false);
    w.claude.accounts[w.work] = employer;
    await w.c.call("agents.setClaudeDir", { profileId: w.mine.id, dir: w.work });
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id })).result[1]).toMatchObject({ loggedIn: true, account: employer });
    w.c.close();
  });

  it("never asks Claude about a folder that has gone, and says the folder is missing", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    rmSync(w.work, { recursive: true });
    for (const params of [{ profileId: w.theirs.id }, { profileId: w.theirs.id, force: true }]) {
      expect((await w.c.call("agents.probe", params)).result[1]).toEqual({ kind: "claude", available: true, version: "2.1.0", loggedIn: false, reason: "The Claude config folder ~/.claude-work is missing.", homeMissing: true, home: w.work });
    }
    expect((await w.c.call("agents.probeOne", { kind: "claude", profileId: w.theirs.id })).result).toMatchObject({ loggedIn: false, home: w.work, homeMissing: true });
    expect(w.claude.asked.includes(w.work)).toBe(false);
    expect(existsSync(w.work)).toBe(false);
    mkdirSync(w.work);
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id })).result[1]).toMatchObject({ loggedIn: true, account: employer });
    w.c.close();
  });

  it("reads an answer Claude Code gave for another folder as not known, and shows no account under it", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    w.claude.stated[w.work] = join(w.userHome, ".claude");
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id })).result[1]).toEqual({ kind: "claude", available: true, version: "2.1.0", loggedIn: null,
      reason: "Claude Code answered for ~/.claude, not ~/.claude-work, so Realm can't tell whether this folder is signed in.", home: w.work });
    w.c.close();
  });

  it("takes an answer for the same folder under another spelling", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    symlinkSync(w.work, join(w.userHome, "work-link"));
    w.claude.stated[w.work] = join(w.userHome, "work-link");
    expect((await w.c.call("agents.probe", { profileId: w.theirs.id })).result[1]).toMatchObject({ loggedIn: true, account: employer, home: w.work });
    w.c.close();
  });

  it("answers one row for a session's own folder, which is not always its profile's", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const id = await w.create(w.office.id);
    await w.run(id);
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.next });
    w.claude.accounts[w.next] = personal;
    expect((await w.c.call("agents.probeOne", { kind: "claude", sessionId: id })).result).toMatchObject({ home: w.work, account: employer });
    expect((await w.c.call("agents.probeOne", { kind: "claude", profileId: w.theirs.id })).result).toMatchObject({ home: w.next, account: personal });
    expect((await w.c.call("agents.probeOne", { kind: "claude", sessionId: id, profileId: w.mine.id })).result.home).toBe(w.work);
    expect((await w.c.call("agents.probeOne", { kind: "claude" })).result).toMatchObject({ home: null, account: personal });
    expect((await w.c.call("agents.probeOne", { kind: "fake", sessionId: id })).result).toEqual({ kind: "fake", available: true, version: "fake", loggedIn: true, reason: null });
    expect((await w.c.call("agents.probeOne", { kind: "claude", sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).error.code).toBe("NOT_FOUND");
    w.c.close();
  });

  it("answers one row from what it last learned when it is not forced, and asks again when it is", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const ask = async (params: object): Promise<Any> => (await w.c.call("agents.probeOne", { kind: "claude", ...params })).result;
    await ask({ profileId: w.theirs.id, force: false });
    await ask({ profileId: w.theirs.id, force: false });
    expect(w.claude.asked).toEqual([w.work]);
    expect(w.fake.probes).toBe(0);
    await ask({ profileId: w.theirs.id });
    expect(w.claude.asked).toEqual([w.work, w.work]);
    await ask({ force: false });
    await ask({ force: false });
    expect(w.claude.asked).toEqual([w.work, w.work, undefined]);
    w.c.close();
  });
});

describe("fresh asks about one folder that arrive together", () => {
  it("cost two probes of the default folder, however many arrive", async () => {
    const w = await boot();
    const gate = gated(w);
    const asks = [1, 2, 3, 4, 5].map(() => w.c.call("agents.probeOne", { kind: "claude" }));
    await gate.received();
    expect(w.claude.asked).toEqual([undefined]);
    gate.open();
    const rows = await Promise.all(asks);
    expect(rows.map((r) => r.result.loggedIn)).toEqual([true, true, true, true, true]);
    expect(w.claude.asked).toEqual([undefined, undefined]);
    w.c.close();
  });

  it("cost two probes of a named folder, and none of any other", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const gate = gated(w);
    const asks = [1, 2, 3, 4].map(() => w.c.call("agents.probeOne", { kind: "claude", profileId: w.theirs.id }));
    await gate.received();
    expect(w.claude.asked).toEqual([w.work]);
    gate.open();
    const rows = await Promise.all(asks);
    expect(rows.map((r) => r.result.home)).toEqual([w.work, w.work, w.work, w.work]);
    expect(w.claude.asked).toEqual([w.work, w.work]);
    w.c.close();
  });

  for (const named of [false, true]) {
    it(`answer an ask about ${named ? "a named folder" : "the default folder"} that arrives while a probe is out from a probe that began after it, so a sign-in finished in between shows`, async () => {
      const w = await boot();
      const key = named ? w.work : "default";
      const about = named ? { profileId: w.theirs.id } : {};
      if (named) await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
      const account = w.claude.accounts[key]!;
      delete w.claude.accounts[key];
      const gate = gated(w);
      const before = w.c.call("agents.probeOne", { kind: "claude", ...about });
      await gate.received();
      w.claude.accounts[key] = account;
      const after = w.c.call("agents.probeOne", { kind: "claude", ...about });
      await gate.received();
      gate.open();
      expect((await before).result.loggedIn).toBe(false);
      expect((await after).result.loggedIn).toBe(true);
      expect((await w.c.call("agents.probeOne", { kind: "claude", ...about, force: false })).result.loggedIn).toBe(true);
      w.c.close();
    });
  }

  it("start a probe at once when none is out, each time", async () => {
    const w = await boot();
    await w.c.call("agents.probeOne", { kind: "claude" });
    await w.c.call("agents.probeOne", { kind: "claude" });
    await w.c.call("agents.probeOne", { kind: "claude" });
    expect(w.claude.asked).toEqual([undefined, undefined, undefined]);
    w.c.close();
  });

  it("keep one folder's asks apart from another's", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.c.call("agents.setClaudeDir", { profileId: w.mine.id, dir: w.next });
    const gate = gated(w);
    const first = w.c.call("agents.probeOne", { kind: "claude", profileId: w.theirs.id });
    const other = w.c.call("agents.probeOne", { kind: "claude", profileId: w.mine.id });
    const second = w.c.call("agents.probeOne", { kind: "claude", profileId: w.theirs.id });
    await gate.received();
    expect(w.claude.asked).toEqual([w.work, w.next]);
    gate.open();
    expect((await first).result).toMatchObject({ home: w.work, loggedIn: true });
    expect((await other).result).toMatchObject({ home: w.next, loggedIn: false });
    expect((await second).result).toMatchObject({ home: w.work, loggedIn: true, account: employer });
    expect(w.claude.asked).toEqual([w.work, w.next, w.work]);
    w.c.close();
  });

  it("go on being answered after a probe that broke, the one waiting behind another included", async () => {
    const w = await boot();
    const working = w.fake.probe.bind(w.fake);
    let open!: () => void;
    const gate = new Promise<void>((done) => { open = done; });
    const turns: (() => Promise<ProbeResult>)[] = [
      async () => { await gate; return working(); },
      () => { throw new Error("the probe broke"); },
    ];
    w.fake.probe = () => (turns.shift() ?? working)();
    const first = w.c.call("agents.probeOne", { kind: "fake" });
    const behind = w.c.call("agents.probeOne", { kind: "fake" });
    await w.c.call("agents.claudeDir", { profileId: w.mine.id });
    open();
    expect((await first).result).toMatchObject({ kind: "fake" });
    expect((await behind).error).toMatchObject({ message: expect.stringContaining("the probe broke") });
    expect((await w.c.call("agents.probeOne", { kind: "fake" })).result).toMatchObject({ kind: "fake" });
    expect((await w.c.call("agents.probeOne", { kind: "fake" })).result).toMatchObject({ kind: "fake" });
    w.c.close();
  });

  it("keep one agent's asks apart from another's", async () => {
    const w = await boot();
    const gate = gated(w);
    const claudes = w.c.call("agents.probeOne", { kind: "claude" });
    const others = await w.c.call("agents.probeOne", { kind: "fake" });
    expect(others.result.kind).toBe("fake");
    expect(w.fake.probes).toBe(1);
    gate.open();
    await claudes;
    w.c.close();
  });
});

describe("a sign-in with no space around it", () => {
  it("lands in the folder its profile names, and is confirmed against that folder", async () => {
    const stub = loginStub();
    const w = await boot({ env: { REALM_CLAUDE_BIN: stub.bin } });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    w.claude.asked = [];
    const started = (await w.c.call("agentSignIn.start", { kind: "claude", profileId: w.theirs.id })).result;
    await signedIn(w, started.id);
    expect(stub.folder()).toBe(w.work);
    expect(w.claude.asked).toEqual([w.work]);
    w.c.close();
  });

  it("lands in the default folder for a profile that names none, and with no profile, and is handed no variable", async () => {
    const stub = loginStub();
    const w = await boot({ env: { REALM_CLAUDE_BIN: stub.bin } });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    for (const params of [{ profileId: w.mine.id }, {}]) {
      w.claude.asked = [];
      const started = (await w.c.call("agentSignIn.start", { kind: "claude", ...params })).result;
      await signedIn(w, started.id);
      expect(stub.folder()).toBe("");
      expect(w.claude.asked).toEqual([undefined]);
    }
    w.c.close();
  });

  it("hands another agent's login no folder, whatever its profile names", async () => {
    const stub = loginStub();
    const w = await boot({ env: { REALM_CODEX_BIN: stub.bin } });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const started = (await w.c.call("agentSignIn.start", { kind: "codex", profileId: w.theirs.id })).result;
    await signedIn(w, started.id);
    expect(stub.folder()).toBe("");
    w.c.close();
  });

  it("is refused where the profile's folder has gone, and runs nothing that would make it", async () => {
    const stub = loginStub();
    const w = await boot({ env: { REALM_CLAUDE_BIN: stub.bin } });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    rmSync(w.work, { recursive: true });
    const refused = await w.c.call("agentSignIn.start", { kind: "claude", profileId: w.theirs.id });
    expect(refused.error).toMatchObject({ code: "CLAUDE_DIR_MISSING", message: expect.stringContaining("~/.claude-work, the Claude config folder for this profile, is missing") });
    expect(stub.folder()).toBeNull();
    expect(existsSync(w.work)).toBe(false);
    w.c.close();
  });
});

describe("where a sign-in asked for in a space lands", () => {
  it("is the asking Claude session's own folder, and the profile's for anyone else who asks", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    const claudes = await w.create(w.office.id);
    await w.run(claudes);
    const others = await w.create(w.office.id, "fake");
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.next });
    expect(app.sessions.signInHome(w.office.id, claudes)).toBe(w.work);
    expect(app.sessions.signInHome(w.office.id, others)).toBe(w.next);
    expect(app.sessions.signInHome(w.office.id, null)).toBe(w.next);
    expect(app.sessions.signInHome(w.office.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(w.next);
    expect(app.sessions.signInHome(w.den.id, null)).toBeNull();
    w.c.close();
  });

  it("is refused when that folder has gone", async () => {
    const w = await boot();
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    rmSync(w.work, { recursive: true });
    expect(() => app.sessions.signInHome(w.office.id, null)).toThrow(/~\/\.claude-work, the Claude config folder for this profile, is missing/);
    w.c.close();
  });
});

describe("Realm's own Claude calls", () => {
  it("title a session on the account its folder holds, and with no folder ask exactly as before", async () => {
    const titleGenerator = vi.fn(async (text: string) => `About ${text}`);
    const w = await boot({ titleGenerator });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    await w.run(await w.create(w.office.id), "one");
    await w.run(await w.create(w.den.id), "two");
    await w.run(await w.create(w.office.id, "fake"), "three");
    await waitFor(() => titleGenerator.mock.calls.length === 3);
    expect(titleGenerator.mock.calls).toEqual([["one", { configDir: w.work }], ["two"], ["three", { configDir: w.work }]]);
    w.c.close();
  });

  it("skip a title where the folder it would run under has gone", async () => {
    const titleGenerator = vi.fn(async (text: string) => `About ${text}`);
    const w = await boot({ titleGenerator });
    await w.c.call("agents.setClaudeDir", { profileId: w.theirs.id, dir: w.work });
    rmSync(w.work, { recursive: true });
    await w.run(await w.create(w.office.id, "fake"), "one");
    await w.run(await w.create(w.den.id, "fake"), "two");
    await waitFor(() => titleGenerator.mock.calls.length === 1);
    expect(titleGenerator.mock.calls).toEqual([["two"]]);
    expect(existsSync(w.work)).toBe(false);
    w.c.close();
  });
});
