import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { sessionEvent, type AgentKind, type Environment, type SessionEvent } from "@realm/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../app";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { waitFor } from "../test-utils";
import { MEMORY_PROVIDER_NAME } from "./agent-tools";
import { MemoryService } from "./service";

/**
 * A session's memory block is composed once and handed to every later start of that session in this
 * server run, so the prompt's prefix stays byte-identical for the provider's prompt cache — until the
 * USER changes something it is made of. These drive `MemoryService` with a repo seam whose index an
 * "agent" rewrites between starts, the way a `memory_save` does.
 */

const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

let app: App | null = null;
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await app?.close(); app = null; });

type Index = { scope: "profile" | "space"; kind?: "root" | "spaceFolder"; path: string; index: string; truncated: boolean };

function harness() {
  const home = tempDir("realm-memory-freeze-");
  const claudeDir = join(home, "claude-home");
  const folder = join(home, "space");
  mkdirSync(folder, { recursive: true });
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  /** What the repos hold right now — the test writes it as an agent's save would. */
  const repos: { list: Index[] } = { list: [{ scope: "profile", kind: "root", path: "/mine", index: "# Memory\n\n- Prefers tabs", truncated: false }] };
  const environments = { ensurePrimary: (spaceId: string): Environment => ({ id: `env-${spaceId}`, spaceId, path: folder, branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }) };
  const memory = new MemoryService({
    home, settings, claudeDir, environments, scopes: { profileIdOf: () => "P" },
    repos: { indexesFor: () => repos.list.map((r) => ({ ...r })) },
  });
  const start = (sessionId: string, o: Partial<{ kind: "codex" | "claude" | "acp:cursor"; skillsInjected: boolean; spaceId: string }> = {}) =>
    memory.contextForSession(sessionId, { spaceId: o.spaceId ?? SPACE, kind: o.kind ?? "codex", cwd: folder, skillsInjected: o.skillsInjected ?? false });
  /** An agent's save: the index gains a line, nothing the user wrote changes. */
  const agentSaves = (line: string) => { repos.list[0]!.index += `\n${line}`; };
  return { memory, repos, start, agentSaves, claudeDir, folder };
}

describe("a session's memory block, frozen for its later starts", () => {
  it("composes the same bytes twice from the same inputs, whatever the clock says", () => {
    const { memory, claudeDir, folder } = harness();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "user claude file");
    memory.setProfile("P", "profile doc");
    memory.set(SPACE, "space doc");
    const o = { spaceId: SPACE, kind: "claude" as const, cwd: folder, skillsInjected: true };
    vi.useFakeTimers({ now: new Date("2026-10-28T09:00:00Z") });
    const first = memory.systemContextFor(o);
    vi.setSystemTime(new Date("2027-03-01T23:59:59Z"));
    // No timestamp, no order that depends on iteration: the cache key is the text itself.
    expect(memory.systemContextFor(o)).toBe(first);
    expect(first).toContain("user claude file");
    expect(first).toContain("Prefers tabs");
  });

  it("hands a restart the bytes the first start got, though an agent saved to memory in between", () => {
    const { start, agentSaves, memory, folder } = harness();
    memory.set(SPACE, "space doc");
    const first = start("s1");
    agentSaves("- Deploys from main");
    // THE MUTANT: compose afresh on every start. The prefix changes with every save and the cache misses.
    expect(start("s1")).toBe(first);
    expect(first).not.toContain("Deploys from main");
    // The save is real: a session starting now composes it in.
    expect(start("s2")).toContain("Deploys from main");
    expect(memory.systemContextFor({ spaceId: SPACE, kind: "codex", cwd: folder, skillsInjected: false })).toContain("Deploys from main");
  });

  it("does not take an agent's first save into a space folder for a change of repos", () => {
    const { start, repos, agentSaves } = harness();
    const first = start("s1");
    // The save that makes the folder also links it from the root index — so a block composed afresh
    // would differ, and only a key that ignored the folder's arrival keeps the first one.
    repos.list.push({ scope: "profile", kind: "spaceFolder", path: "/mine/spaces/a", index: "- [Ports](ports.md) — the port map", truncated: false });
    agentSaves("- [[spaces/a/MEMORY]]");
    // THE MUTANT: key on every index entry, the folder's included — the first save in a space
    // recomposes every running session's block there.
    expect(start("s1")).toBe(first);
  });

  it("composes afresh when the user edits the space document — the new index comes with it", () => {
    const { start, agentSaves, memory } = harness();
    memory.set(SPACE, "space doc");
    const first = start("s1");
    agentSaves("- Deploys from main");
    // THE MUTANT: a key that leaves the user's document out. Their edit would wait for a new session.
    memory.set(SPACE, "space doc, edited");
    const after = start("s1");
    expect(after).not.toBe(first);
    expect(after).toContain("space doc, edited");
    expect(after).toContain("Deploys from main");
    expect(start("s1")).toBe(after);
  });

  it("composes afresh when the user edits the profile document, or this space stops inheriting it", () => {
    const { start, memory } = harness();
    memory.setProfile("P", "profile doc");
    const first = start("s1");
    memory.setProfile("P", "profile doc, edited");
    const edited = start("s1");
    expect(edited).toContain("profile doc, edited");
    expect(edited).not.toBe(first);
    memory.setProfileDocEnabled(SPACE, false);
    expect(start("s1")).not.toContain("profile doc");
  });

  it("composes afresh when the space's repos change — a repo switched off takes its tools' instructions with it", () => {
    const { start, repos } = harness();
    expect(start("s1")).toContain("memory_save");
    repos.list = [];
    expect(start("s1") ?? "").not.toContain("memory_save");
  });

  it("composes afresh when the session moves to another agent", () => {
    const { start, agentSaves } = harness();
    start("s1");
    agentSaves("- Deploys from main");
    expect(start("s1", { kind: "acp:cursor" })).toContain("Deploys from main");
  });

  it("forgets a deleted session's block", () => {
    const { start, agentSaves, memory } = harness();
    start("s1");
    agentSaves("- Deploys from main");
    memory.forgetSession("s1");
    expect(start("s1")).toContain("Deploys from main");
  });
});

/** Records the StartOptions each start of its sessions is handed. */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: `prov_${this.starts.length}`, model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => { events.push(sessionEvent("status", { status: "idle" })); },
      respondPermission: () => {}, interrupt: async () => {}, setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

describe("frozen through a session's restarts, end to end", () => {
  it("gives a restarted session the exact context of its first start after an agent's save, and a new one after the user's edit", async () => {
    const home = tempDir("realm-memory-freeze-int-");
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    const codex = new RecordingAdapter("codex");
    app = await createApp({ home, port: 0, adapters: { codex }, claudeDir: join(home, "claude-home") });
    const c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "W" })).result;
    const space = (await c.call("spaces.create", { profileId: p.id, name: "A" })).result;
    await c.call("memory.set", { spaceId: space.id, doc: "SPACE_DOC" });
    await c.call("memory.repo.create", { scope: "profile", ownerId: p.id });
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "codex" })).result;
    const startOnce = async () => {
      const before = codex.starts.length;
      await c.call("sessions.send", { id: session.id, text: "go" });
      await waitFor(() => codex.starts.length === before + 1);
      return codex.starts.at(-1)!;
    };

    const first = await startOnce();
    // The agent saves a fact through its own gateway entry, as `memory_save` does mid-session.
    const cfg = first.mcpServers[0] as { url: string; headers: Record<string, string> };
    const mcp = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    expect((await mcp.callTool({ name: `${MEMORY_PROVIDER_NAME}__memory_save`, arguments: { entry: "Deploys from main" } })).isError).toBe(false);
    await mcp.close();

    await app.sessions.stopAgent(session.id);
    const second = await startOnce();
    // The whole context the adapter was handed — preamble, memory, all of it — byte for byte.
    expect(second.systemContext).toBe(first.systemContext);
    expect(second.systemContext).not.toContain("Deploys from main");

    await c.call("memory.set", { spaceId: space.id, doc: "SPACE_DOC, edited" });
    await app.sessions.stopAgent(session.id);
    const third = await startOnce();
    expect(third.systemContext).not.toBe(first.systemContext);
    expect(third.systemContext).toContain("SPACE_DOC, edited");
    expect(third.systemContext).toContain("Deploys from main");
    c.close();
  }, 20_000);
});
