import { describe, expect, it, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { newId, sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * Stands in for a real adapter under a real agent kind, records the StartOptions it was handed, and —
 * for the codex kind — reports per-thread instructionSources on init the way the real adapter now does,
 * derived from cwd so a cross-session mixup is visible as the wrong path.
 */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", {
      providerSessionId: `prov_${this.starts.length}`, model: "m", tools: [], cwd: opts.cwd,
      ...(this.kind === "codex" ? { instructionSources: [join(opts.cwd, "AGENTS.md")] } : {}),
    }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => { events.push(sessionEvent("assistant_text", { messageId: "m1", text: "ok" })); events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "realm-memory-int-"));
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const claudeDir = join(home, "claude-home");
  const claude = new RecordingAdapter("claude");
  const codex = new RecordingAdapter("codex");
  const cursor = new RecordingAdapter("acp:cursor");
  app = await createApp({ home, port: 0, adapters: { claude, codex, "acp:cursor": cursor }, claudeDir });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const spA = (await c.call("spaces.create", { profileId: p.id, name: "A" })).result;
  const spB = (await c.call("spaces.create", { profileId: p.id, name: "B" })).result;
  return { home, claudeDir, c, spA, spB, claude, codex, cursor };
}

/** Starts the session's adapter the way anything real does — on the first send. */
async function startSession(c: Any, spaceId: string, agentKind: string) {
  const { session } = (await c.call("sessions.create", { spaceId, agentKind })).result;
  await c.call("sessions.send", { id: session.id, text: "go" });
  return session;
}

describe("memory over rpc", () => {
  it("round-trips the doc per space and broadcasts memory.changed", async () => {
    const { c, spA, spB, home } = await boot();
    const set = (await c.call("memory.set", { spaceId: spA.id, doc: "space A memory" })).result;
    expect(set).toMatchObject({ doc: "space A memory", path: join(home, "memory", `${spA.id}.md`) });
    await waitFor(() => c.events.some((e: Any) => e.event === "memory.changed" && e.payload.spaceId === spA.id));
    expect((await c.call("memory.get", { spaceId: spA.id })).result.doc).toBe("space A memory");
    expect((await c.call("memory.get", { spaceId: spB.id })).result.doc).toBe("");
    c.close();
  });

  it("refuses a space that does not exist rather than reading memory for a typo", async () => {
    const { c } = await boot();
    const gone = newId();
    expect((await c.call("memory.get", { spaceId: gone })).error.code).toBe("NOT_FOUND");
    expect((await c.call("memory.set", { spaceId: gone, doc: "x" })).error.code).toBe("NOT_FOUND");
    expect((await c.call("memory.setAgentsFile", { spaceId: gone, enabled: true })).error.code).toBe("NOT_FOUND");
    c.close();
  });

  it("injects each space's own doc into its sessions — never another space's (Claude and Codex)", async () => {
    const { c, spA, spB, claude, codex } = await boot();
    await c.call("memory.set", { spaceId: spA.id, doc: "space A memory" });
    await c.call("memory.set", { spaceId: spB.id, doc: "space B memory" });
    await startSession(c, spA.id, "claude");
    await startSession(c, spB.id, "claude");
    await startSession(c, spB.id, "codex");
    await waitFor(() => claude.starts.length === 2 && codex.starts.length === 1);
    expect(claude.starts[0]!.systemContext).toContain("space A memory");
    expect(claude.starts[0]!.systemContext).not.toContain("space B memory");
    expect(claude.starts[1]!.systemContext).toContain("space B memory");
    expect(claude.starts[1]!.systemContext).not.toContain("space A memory");
    expect(codex.starts[0]!.systemContext).toContain("space B memory");
    c.close();
  });

  it("hands Cursor no context at all — stated, not faked", async () => {
    const { c, spA, cursor } = await boot();
    await c.call("memory.set", { spaceId: spA.id, doc: "space A memory" });
    await startSession(c, spA.id, "acp:cursor");
    await waitFor(() => cursor.starts.length === 1);
    expect(cursor.starts[0]!.systemContext).toBeUndefined();
    c.close();
  });

  it("skills on + user CLAUDE.md present → the content still reaches the session (the W1 carry-forward)", async () => {
    const { c, spA, home, claudeDir, claude } = await boot();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "USER_MEMORY_MARKER_9317");
    mkdirSync(join(home, "skills", "mac"), { recursive: true });
    writeFileSync(join(home, "skills", "mac", "SKILL.md"), "---\nname: mac\ndescription: does mac.\n---\n");

    await startSession(c, spA.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    const start = claude.starts[0]!;
    // The dangerous combination this exists for: the skills injection is active (so the CLI will load
    // NO settings files) and the user's memory rides back in through systemContext.
    expect(start.skills).toBeTruthy();
    expect(start.systemContext).toContain("USER_MEMORY_MARKER_9317");
    c.close();
  });

  it("with skills off the CLAUDE.md is NOT re-injected — the CLI loads it itself", async () => {
    const { c, spA, claudeDir, claude } = await boot();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "USER_MEMORY_MARKER_9317");
    await startSession(c, spA.id, "claude");
    await waitFor(() => claude.starts.length === 1);
    expect(claude.starts[0]!.skills).toBeUndefined();
    expect(claude.starts[0]!.systemContext).toBeUndefined();
    c.close();
  });

  it("memory.sources reports per session: codex sessions carry their own thread's instructionSources", async () => {
    const { c, spA, spB } = await boot();
    const a = await startSession(c, spA.id, "codex");
    const b = await startSession(c, spB.id, "codex");
    const srcA = (await c.call("memory.sources", { sessionId: a.id })).result;
    const srcB = (await c.call("memory.sources", { sessionId: b.id })).result;
    expect(srcA).toMatchObject({ agent: "codex", basis: "reported" });
    // Each session's report names its own cwd — one session's sources on another's pane is the mutant.
    expect(srcA.sources.map((s: Any) => s.path)).toEqual([join(spA.folderPath, "AGENTS.md")]);
    expect(srcB.sources.map((s: Any) => s.path)).toEqual([join(spB.folderPath, "AGENTS.md")]);
    c.close();
  });

  it("memory.sources for an unstarted codex session says 'no report yet', not 'zero files'", async () => {
    const { c, spA } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: spA.id, agentKind: "codex" })).result;
    expect((await c.call("memory.sources", { sessionId: session.id })).result).toMatchObject({ basis: "none", sources: [] });
    c.close();
  });

  it("memory.sources for claude models the hierarchy; for cursor it is a stated nothing", async () => {
    const { c, spA, claudeDir } = await boot();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "user memory");
    const cl = (await c.call("sessions.create", { spaceId: spA.id, agentKind: "claude" })).result.session;
    const cu = (await c.call("sessions.create", { spaceId: spA.id, agentKind: "acp:cursor" })).result.session;
    const srcCl = (await c.call("memory.sources", { sessionId: cl.id })).result;
    expect(srcCl).toMatchObject({ agent: "claude", channel: "systemPrompt", basis: "modeled" });
    expect(srcCl.sources.find((s: Any) => s.path === join(claudeDir, "CLAUDE.md"))).toMatchObject({ origin: "user", exists: true, via: "cli" });
    const srcCu = (await c.call("memory.sources", { sessionId: cu.id })).result;
    expect(srcCu).toMatchObject({ agent: "acp:cursor", channel: "none", basis: "none", sources: [] });
    c.close();
  });

  it("the AGENTS.md toggle writes into the space's own Realm-created folder and follows doc edits", async () => {
    const { c, spA } = await boot();
    await c.call("memory.set", { spaceId: spA.id, doc: "the doc" });
    const on = (await c.call("memory.setAgentsFile", { spaceId: spA.id, enabled: true })).result;
    const path = join(spA.folderPath, "AGENTS.md");
    expect(on.agentsFile).toMatchObject({ enabled: true, exists: true, managedByRealm: true, path });
    expect(readFileSync(path, "utf8")).toContain("the doc");
    await c.call("memory.set", { spaceId: spA.id, doc: "edited" });
    expect(readFileSync(path, "utf8")).toContain("edited");
    const off = (await c.call("memory.setAgentsFile", { spaceId: spA.id, enabled: false })).result;
    expect(off.agentsFile.exists).toBe(false);
    expect(existsSync(path)).toBe(false);
    c.close();
  });

  it("never touches an AGENTS.md the user put there themselves", async () => {
    const { c, spA } = await boot();
    const path = join(spA.folderPath, "AGENTS.md");
    writeFileSync(path, "the user's own agents file");
    const r = await c.call("memory.setAgentsFile", { spaceId: spA.id, enabled: true });
    expect(r.error.code).toBe("AGENTS_FILE_FOREIGN");
    expect(readFileSync(path, "utf8")).toBe("the user's own agents file");
    c.close();
  });
});
