import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Never a real key. Every assertion here is about where it does NOT appear. */
const KEY = "pat-do-not-leak-me";

/** Stands in for a real adapter under a real agent kind, and records the StartOptions it was handed. */
class RecordingAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  readonly logs: string[] = [];
  constructor(readonly kind: "claude" | "codex") {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: "prov_1", model: "m", tools: [], cwd: opts.cwd }));
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
  const home = mkdtempSync(join(tmpdir(), "realm-mcp-int-"));
  const claude = new RecordingAdapter("claude");
  app = await createApp({ home, port: 0, adapters: { claude } });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "P" })).result;
  const work = (await c.call("spaces.create", { profileId: profile.id, name: "Work" })).result;
  const school = (await c.call("spaces.create", { profileId: profile.id, name: "School" })).result;
  return { c, claude, work, school };
}

/** Start a session in `spaceId` and return the StartOptions the adapter was handed. */
async function startSession(c: Any, adapter: RecordingAdapter, spaceId: string): Promise<StartOptions> {
  const before = adapter.starts.length;
  const { session } = (await c.call("sessions.create", { spaceId, agentKind: "claude" })).result;
  await c.call("sessions.send", { id: session.id, text: "go" });
  await waitFor(() => adapter.starts.length > before);
  return adapter.starts[before]!;
}

const addStdio = (c: Any, spaceId: string | null, name: string) =>
  c.call("mcp.add", { spaceId, name, transport: "stdio", command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { AIRTABLE_API_KEY: KEY } });

describe("mcp reaches a session", () => {
  it("hands the space's enabled servers to the adapter at start", async () => {
    // The named mutant: restore `mcpServers: []` in SessionService.ensureLive and this fails.
    const { c, claude, work } = await boot();
    await addStdio(c, work.id, "airtable");
    const opts = await startSession(c, claude, work.id);
    expect(opts.mcpServers).toEqual([
      { name: "airtable", transport: "stdio", command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { AIRTABLE_API_KEY: KEY } },
    ]);
    c.close();
  });

  it("hands over an empty list when the space has enabled nothing", async () => {
    const { c, claude, work } = await boot();
    await addStdio(c, null, "airtable"); // defined, opted into nowhere
    const opts = await startSession(c, claude, work.id);
    expect(opts.mcpServers).toEqual([]);
    c.close();
  });

  it("does not leak one space's servers into another's session", async () => {
    const { c, claude, work, school } = await boot();
    await addStdio(c, work.id, "work_only");
    expect((await startSession(c, claude, school.id)).mcpServers).toEqual([]);
    expect((await startSession(c, claude, work.id)).mcpServers.map((s) => s.name)).toEqual(["work_only"]);
    c.close();
  });

  it("stops handing over a server that was disabled between sessions", async () => {
    const { c, claude, work } = await boot();
    const server = (await addStdio(c, work.id, "airtable")).result;
    expect((await startSession(c, claude, work.id)).mcpServers).toHaveLength(1);
    await c.call("mcp.setEnabled", { spaceId: work.id, id: server.id, enabled: false });
    expect((await startSession(c, claude, work.id)).mcpServers).toEqual([]);
    c.close();
  });

  it("carries an http server's url and headers through unchanged", async () => {
    const { c, claude, work } = await boot();
    await c.call("mcp.add", { spaceId: work.id, name: "vercel", transport: "http", url: "https://mcp.vercel.com", headers: { Authorization: `Bearer ${KEY}` } });
    expect((await startSession(c, claude, work.id)).mcpServers).toEqual([
      { name: "vercel", transport: "http", url: "https://mcp.vercel.com", headers: { Authorization: `Bearer ${KEY}` } },
    ]);
    c.close();
  });
});

describe("mcp over rpc", () => {
  it("never puts a secret value on the wire, in a result or in an event", async () => {
    // The named mutant: secrets echoed into an event payload. `mcp.changed` carries no payload at all,
    // and every result is the key-names projection.
    const { c, claude, work } = await boot();
    const added = await addStdio(c, work.id, "airtable");
    const listed = await c.call("mcp.list", { spaceId: work.id });
    const updated = await c.call("mcp.update", { spaceId: work.id, id: added.result.id, name: "airtable2" });
    await startSession(c, claude, work.id);
    await waitFor(() => c.events.some((e: Any) => e.event === "mcp.changed"));
    const everything = JSON.stringify([added, listed, updated, c.events]);
    expect(everything).not.toContain(KEY);
    expect(listed.result.servers[0].envKeys).toEqual(["AIRTABLE_API_KEY"]);
    c.close();
  });

  it("returns the storage note on every list, so a key-taking UI cannot forget it", async () => {
    const { c, work } = await boot();
    const listed = await c.call("mcp.list", { spaceId: work.id });
    expect(listed.result.secretNote).toMatch(/plain text/);
    c.close();
  });

  it("broadcasts mcp.changed on add, edit, toggle and remove", async () => {
    const { c, work } = await boot();
    const count = () => c.events.filter((e: Any) => e.event === "mcp.changed").length;
    const added = await addStdio(c, work.id, "airtable");
    await waitFor(() => count() === 1);
    await c.call("mcp.update", { spaceId: work.id, id: added.result.id, name: "renamed" });
    await waitFor(() => count() === 2);
    await c.call("mcp.setEnabled", { spaceId: work.id, id: added.result.id, enabled: false });
    await waitFor(() => count() === 3);
    await c.call("mcp.remove", { id: added.result.id });
    await waitFor(() => count() === 4);
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers).toEqual([]);
    c.close();
  });

  it("refuses a space that does not exist rather than writing preferences for it", async () => {
    const { c } = await boot();
    const ghost = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    for (const [method, params] of [
      ["mcp.list", { spaceId: ghost }],
      ["mcp.add", { spaceId: ghost, name: "x", transport: "stdio", command: "/bin/x" }],
      ["mcp.setEnabled", { spaceId: ghost, id: "01ARZ3NDEKTSV4RRFFQ69G5FAY", enabled: true }],
    ] as const) {
      expect((await c.call(method, params)).error?.code).toBe("NOT_FOUND");
    }
    c.close();
  });

  it("reports a bad definition as an error code rather than storing it", async () => {
    const { c, work } = await boot();
    expect((await c.call("mcp.add", { spaceId: work.id, name: "empty", transport: "stdio" })).error?.code).toBe("MCP_INCOMPLETE");
    await addStdio(c, work.id, "airtable");
    expect((await addStdio(c, work.id, "airtable")).error?.code).toBe("MCP_NAME_TAKEN");
    expect((await c.call("mcp.list", { spaceId: work.id })).result.servers).toHaveLength(1);
    c.close();
  });

  it("removes a server from every space's enabled set, not just the one that asked", async () => {
    const { c, claude, work, school } = await boot();
    const server = (await addStdio(c, work.id, "airtable")).result;
    await c.call("mcp.setEnabled", { spaceId: school.id, id: server.id, enabled: true });
    await c.call("mcp.remove", { id: server.id });
    expect((await startSession(c, claude, school.id)).mcpServers).toEqual([]);
    c.close();
  });
});
