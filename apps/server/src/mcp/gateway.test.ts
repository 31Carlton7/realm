import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpCallSchema, type EventName, type EventPayload } from "@realm/contracts";
import type { McpServerConfig } from "@realm/adapters";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore } from "../store/sessions";
import { SettingsStore } from "../store/settings";
import { McpServersStore, McpCallLogStore, type McpServerRow } from "../store/mcp";
import { RpcServer } from "../rpc/server";
import { waitFor } from "../test-utils";
import { McpHub } from "./hub";
import { McpService } from "./service";
import { McpGateway } from "./gateway";
import { makeStubServer, type StubServer } from "./fixtures/stub-server";

/** Records every `rpc.broadcast` call instead of sending it anywhere — there is no WebSocket client in
 *  these tests, only the gateway's own use of `RpcServer` as an event bus. */
class RecordingRpc extends RpcServer {
  readonly broadcasts: { event: string; payload: unknown }[] = [];
  override broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
    this.broadcasts.push({ event, payload });
    super.broadcast(event, payload);
  }
}

type App = {
  db: Db;
  servers: McpServersStore;
  calls: McpCallLogStore;
  mcp: McpService;
  hub: McpHub;
  gateway: McpGateway;
  rpc: RecordingRpc;
  port: number;
  spaceId: string;
  sessionId: string;
  /** Wires a server row's connect straight to a stub's in-memory transport, bypassing stdio/http/sse
   *  entirely — same seam `hub.test.ts` uses. */
  addServer(name: string): { row: McpServerRow; stub: StubServer };
  /** A row whose transport factory always throws — stands in for a dead/unreachable upstream. */
  addBrokenServer(name: string): McpServerRow;
  /** A second (or third...) space with its own session, sharing this app's server rows — for tests that
   *  need to prove something does NOT cross a space boundary. */
  createSpaceAndSession(name: string): { spaceId: string; sessionId: string };
};

const activeApps: App[] = [];
afterEach(async () => {
  for (const app of activeApps.splice(0)) { await app.gateway.close(); app.db.close(); }
});

async function setupApp(): Promise<App> {
  const home = mkdtempSync(join(tmpdir(), "realm-mcp-gw-"));
  const db = openDatabase(join(home, "realm.db"));
  const servers = new McpServersStore(db);
  const calls = new McpCallLogStore(db);
  const settings = new SettingsStore(db);
  const sessionsStore = new SessionsStore(db);
  const spacesStore = new SpacesStore(db, home);
  const environmentsStore = new EnvironmentsStore(db);

  const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const createSpaceAndSession = (name: string): { spaceId: string; sessionId: string } => {
    const spaceId = spacesStore.create({ profileId: profile.id, name, icon: "folder" }).id;
    const envId = environmentsStore.ensurePrimary(spaceId).id;
    const sessionId = sessionsStore.create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", environmentId: envId, title: "s" }).id;
    return { spaceId, sessionId };
  };
  const { spaceId, sessionId } = createSpaceAndSession("Work");

  const stubs = new Map<string, StubServer>();
  const broken = new Set<string>();
  const mcp = new McpService({ servers, settings });
  const hub = new McpHub({
    servers,
    onStatus: () => {},
    authHeaders: async () => ({}),
    makeTransport: async (row): Promise<Transport> => {
      if (broken.has(row.id)) throw new Error(`upstream "${row.name}" is unreachable`);
      const stub = stubs.get(row.id);
      if (!stub) throw new Error(`test setup bug: no stub wired for row ${row.id}`);
      return stub.connectInMemory();
    },
  });
  const rpc = new RecordingRpc();
  const gateway = new McpGateway({ hub, mcp, sessions: sessionsStore, calls, rpc, servers });
  const port = await gateway.listen();

  const app: App = {
    db, servers, calls, mcp, hub, gateway, rpc, port, spaceId, sessionId,
    addServer: (name) => {
      const row = servers.create({ name, transport: "stdio", command: "unused-in-memory", args: [], url: "", secrets: {} });
      const stub = makeStubServer();
      stubs.set(row.id, stub);
      return { row, stub };
    },
    addBrokenServer: (name) => {
      const row = servers.create({ name, transport: "stdio", command: "unused-in-memory", args: [], url: "", secrets: {} });
      broken.add(row.id);
      return row;
    },
    createSpaceAndSession,
  };
  activeApps.push(app);
  return app;
}

/** `register()` always returns the http variant (see the gateway's own doc comment) — narrow once here
 *  rather than casting at every call site that reads `.url`/`.headers`. `Extract` keys on `url` rather
 *  than `transport` because the http/sse member's `transport` field is itself `"http" | "sse"`, which
 *  is not assignable to the literal `"http"` `Extract<_, { transport: "http" }>` would need. */
const asHttp = (cfg: McpServerConfig) => cfg as Extract<McpServerConfig, { url: string }>;

/** Registers a session (`app.sessionId`/`app.spaceId` by default; override for a test that needs a
 *  SECOND, differently-scoped session — see `createSpaceAndSession`) and connects a real SDK client to
 *  the gateway over real HTTP — every test that needs to actually speak MCP (as opposed to poking the
 *  listener with raw `fetch`) goes through this. */
async function connectClient(app: App, opts: { sessionId?: string; spaceId?: string; onToolsChanged?: (tools: unknown[]) => void } = {}): Promise<{ client: Client; token: string; url: string }> {
  const { url, headers } = asHttp(app.gateway.register(opts.sessionId ?? app.sessionId, opts.spaceId ?? app.spaceId));
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {}, listChanged: opts.onToolsChanged ? { tools: { debounceMs: 0, onChanged: (_err, tools) => opts.onToolsChanged!(tools ?? []) } } : undefined },
  );
  await client.connect(transport);
  return { client, token: headers.Authorization!.slice("Bearer ".length), url };
}

const asText = (result: CallToolResult): string => {
  const first = result.content.find((c) => c.type === "text");
  return first && "text" in first ? first.text : "";
};

describe("tools/list — namespacing and policy", () => {
  it("lists the union of enabled servers' tools, prefixed <serverName>__<toolName>", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    const { row: beta } = app.addServer("beta");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    app.mcp.setEnabled(app.spaceId, beta.id, true);
    const { client } = await connectClient(app);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha__boom", "alpha__echo", "beta__boom", "beta__echo"]);
    await client.close();
  });

  it("does not list a server the space never enabled", async () => {
    const app = await setupApp();
    app.addServer("alpha"); // defined, never enabled
    const { client } = await connectClient(app);
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
  });

  it("filters by this space's allowedTools", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    app.mcp.setAllowedTools(app.spaceId, alpha.id, ["echo"]);
    const { client } = await connectClient(app);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["alpha__echo"]);
    await client.close();
  });

  it("one dead upstream server costs only its own tools — the other's stay listable", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    const beta = app.addBrokenServer("beta"); // its transport factory throws on connect
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    app.mcp.setEnabled(app.spaceId, beta.id, true);
    const { client } = await connectClient(app);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["alpha__boom", "alpha__echo"]);
    await client.close();
  });

  it("setEnabled(false) drops the server from the very next tools/list, not just the call-time recheck", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    app.mcp.setEnabled(app.spaceId, alpha.id, false);
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
  });
});

describe("tools/call — round-trip, policy re-check, logging", () => {
  it("round-trips to the stub's actual result", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    const result = await client.callTool({ name: "alpha__echo", arguments: { a: 1 } });
    expect(asText(result as CallToolResult)).toBe(JSON.stringify({ a: 1 }));
    await client.close();
  });

  it("re-checks enablement at call time — disabling the server blocks its very next call, and logs the block", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    expect((await client.callTool({ name: "alpha__echo", arguments: {} })).isError).toBeFalsy();
    app.mcp.setEnabled(app.spaceId, alpha.id, false);
    const blocked = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    await waitFor(() => app.calls.list({ sessionId: app.sessionId }).length === 2); // the earlier ok call + this block
    const [blockedRow] = app.calls.list({ sessionId: app.sessionId }); // newest first
    expect(blockedRow).toMatchObject({ ok: false, serverId: alpha.id, tool: "echo" });
    expect(blockedRow!.resultSummary).toMatch(/disabled/i);
    await client.close();
  });

  it("re-checks allowedTools at call time — narrowing mid-session blocks the excluded tool, and logs the block", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    expect((await client.callTool({ name: "alpha__echo", arguments: {} })).isError).toBeFalsy();
    app.mcp.setAllowedTools(app.spaceId, alpha.id, ["boom"]); // echo no longer allowed
    const blocked = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(asText(blocked)).toMatch(/space settings/i);
    await waitFor(() => app.calls.list({ sessionId: app.sessionId }).length === 2);
    const [blockedRow] = app.calls.list({ sessionId: app.sessionId });
    expect(blockedRow).toMatchObject({ ok: false, serverId: alpha.id, tool: "echo" });
    expect(blockedRow!.resultSummary).toMatch(/allowlist/i);
    await client.close();
  });

  it("blocked-call error names the space policy and where to change it, and attributes the log to the (disabled) server", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha"); // never enabled
    const { client } = await connectClient(app);
    const blocked = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(asText(blocked)).toMatch(/space settings/i);
    await waitFor(() => app.calls.list({ sessionId: app.sessionId }).length === 1);
    const [row] = app.calls.list({ sessionId: app.sessionId });
    expect(row).toMatchObject({ ok: false, serverId: alpha.id, serverName: "alpha", tool: "echo" });
    expect(row!.resultSummary).toMatch(/disabled/i);
    await client.close();
  });

  it("logs and broadcasts every call — a clean success, an isError result, and a thrown failure alike", async () => {
    const app = await setupApp();
    const { row: alpha, stub } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);

    const ok = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(ok.isError).toBeFalsy();

    stub.failNext(1);
    const isErr = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(isErr.isError).toBe(true);

    stub.throwNext(1);
    const thrown = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    // The hub's thrown failure still reaches this test's client as a normal, successfully round-tripped
    // isError result — see `handleCall`'s doc comment for why.
    expect(thrown.isError).toBe(true);

    await waitFor(() => app.calls.list({ sessionId: app.sessionId }).length === 3);
    const rows = app.calls.list({ sessionId: app.sessionId }); // newest first
    expect(rows.map((r) => r.ok)).toEqual([false, false, true]);
    expect(rows.every((r) => r.serverId === alpha.id && r.tool === "echo")).toBe(true);

    const callBroadcasts = app.rpc.broadcasts.filter((b) => b.event === "mcp.call");
    expect(callBroadcasts).toHaveLength(3);
    await client.close();
  });

  it("logs a call to a name that matches no server at all, with no serverId to attribute it to", async () => {
    // Policy decision: blocked calls are logged (ok: false), same as any other call — this is what lets
    // W7's Activity view surface a policy denial at all. `serverId` is null here specifically because
    // nothing in the store matches "ghost" even loosely — there is no row to attribute the block to.
    const app = await setupApp();
    const { client } = await connectClient(app);
    const blocked = (await client.callTool({ name: "ghost__anything", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    await waitFor(() => app.calls.list({ sessionId: app.sessionId }).length === 1);
    const [row] = app.calls.list({ sessionId: app.sessionId });
    expect(row).toMatchObject({ ok: false, serverId: null, tool: "ghost__anything" });
    const callBroadcast = app.rpc.broadcasts.find((b) => b.event === "mcp.call");
    expect(callBroadcast).toBeTruthy();
    await client.close();
  });

  it("broadcasts a mcp.call payload that parses with McpCallSchema — the exact contract the client relies on", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    await client.callTool({ name: "alpha__echo", arguments: { a: 1 } });
    await waitFor(() => app.rpc.broadcasts.some((b) => b.event === "mcp.call"));
    const payload = app.rpc.broadcasts.find((b) => b.event === "mcp.call")!.payload;
    expect(McpCallSchema.safeParse(payload).success).toBe(true);
    await client.close();
  });

  it("truncates resultSummary at SUMMARY_MAX chars but keeps the full argsJson round-trip", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    const big = "x".repeat(500);
    await client.callTool({ name: "alpha__echo", arguments: { big } });
    await waitFor(() => app.calls.list({ sessionId: app.sessionId }).length === 1);
    const [row] = app.calls.list({ sessionId: app.sessionId });
    // `echo` returns JSON.stringify(args) as its text content, which is well over 200 chars here.
    expect(row!.resultSummary.length).toBe(200);
    // argsJson is never truncated — it round-trips the full call, big argument and all.
    expect(JSON.parse(row!.argsJson)).toEqual({ big });
    await client.close();
  });
});

describe("auth", () => {
  it("401s a request with an unknown bearer token — plain JSON, no MCP framing", async () => {
    const app = await setupApp();
    const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
      method: "POST", headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("401s a request with no Authorization header at all", async () => {
    const app = await setupApp();
    const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("401s after release — the token dies with the session", async () => {
    const app = await setupApp();
    const { url, headers } = asHttp(app.gateway.register(app.sessionId, app.spaceId));
    const token = headers.Authorization!;
    const before = await fetch(url, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: "{}" });
    expect(before.status).not.toBe(401);
    app.gateway.release(app.sessionId);
    const after = await fetch(url, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
  });

  it("register() called twice for the same session revokes the OLD token", async () => {
    const app = await setupApp();
    const first = asHttp(app.gateway.register(app.sessionId, app.spaceId));
    const second = asHttp(app.gateway.register(app.sessionId, app.spaceId));
    expect(second.headers.Authorization).not.toBe(first.headers.Authorization);
    const oldReq = await fetch(first.url, { method: "POST", headers: { ...first.headers, "Content-Type": "application/json" }, body: "{}" });
    expect(oldReq.status).toBe(401);
    const newReq = await fetch(second.url, { method: "POST", headers: { ...second.headers, "Content-Type": "application/json" }, body: "{}" });
    expect(newReq.status).not.toBe(401);
  });
});

describe("notifications", () => {
  it("notifyPolicyChanged sends tools/list_changed to a connected session in that space", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const notifications: unknown[][] = [];
    const { client } = await connectClient(app, { onToolsChanged: (tools) => notifications.push(tools) });
    await client.listTools(); // establish the live connection the notification needs a server for
    // The SDK client opens its standalone GET SSE stream (the channel a server-initiated notification
    // actually arrives on) fire-and-forget right after the `initialize` handshake — `client.connect()`
    // resolving is no guarantee that stream is up yet. Re-sending the notification on every poll tick
    // (rather than once before the wait) makes this robust to that race instead of flaky under load.
    await waitFor(() => { app.gateway.notifyPolicyChanged(app.spaceId); return notifications.length > 0; });
    await client.close();
  });

  it("notifyToolsChanged reaches every registered session, regardless of space", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const notifications: unknown[][] = [];
    const { client } = await connectClient(app, { onToolsChanged: (tools) => notifications.push(tools) });
    await client.listTools();
    // Same fire-and-forget SSE-stream race as the test above.
    await waitFor(() => { app.gateway.notifyToolsChanged(); return notifications.length > 0; });
    await client.close();
  });

  it("notifyPolicyChanged does NOT reach a session registered in a different space", async () => {
    const app = await setupApp();
    const other = app.createSpaceAndSession("School");
    const notifications: unknown[][] = [];
    const { client } = await connectClient(app, { sessionId: other.sessionId, spaceId: other.spaceId, onToolsChanged: (tools) => notifications.push(tools) });
    await client.listTools();
    // `app.spaceId` ("Work") is a DIFFERENT space than the one this client registered in ("School").
    app.gateway.notifyPolicyChanged(app.spaceId);
    // Asserting an absence: give the (should-never-arrive) notification every reasonable chance, including
    // the SSE-stream-establishment race the other tests above poll around, then confirm nothing landed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(notifications).toEqual([]);
    await client.close();
  });
});

describe("concurrent first-touch calls to the session-creation path share one Server/transport pair", () => {
  it("two callers reaching ensureSessionServer for the same session in the same tick get back the SAME server and transport", async () => {
    // An earlier version of this test fired two REAL concurrent HTTP `initialize` requests and asserted
    // on the response shape. A reviewer proved that was a false green: `connectSession` has no genuine
    // I/O await today (creating and wiring the SDK `Server` is pure in-process setup), so two HTTP
    // requests rarely if ever land inside the actual race window — the test passed even with the
    // `connecting` guard (see its doc comment on `SessionEntry`) removed entirely. Reaching into the
    // private method directly and calling it twice in ONE synchronous tick is what exercises the guard
    // for real, without depending on network-level timing this codebase does not control.
    const app = await setupApp();
    app.gateway.register(app.sessionId, app.spaceId);

    type Entry = { spaceId: string };
    type Internal = {
      sessions: Map<string, Entry>;
      ensureSessionServer(sessionId: string, entry: Entry): Promise<{ server: unknown; transport: unknown }>;
    };
    const internal = app.gateway as unknown as Internal;
    const entry = internal.sessions.get(app.sessionId)!;

    // Both calls are made synchronously (before either is awaited), same as `Promise.all` would produce
    // from two callers that happened to both reach this path in the same tick.
    const first = internal.ensureSessionServer(app.sessionId, entry);
    const second = internal.ensureSessionServer(app.sessionId, entry);
    const [a, b] = await Promise.all([first, second]);
    expect(a.server).toBe(b.server);
    expect(a.transport).toBe(b.transport);
  });
});

describe("routes", () => {
  it("/oauth/callback returns 501 — W5 replaces this, so the route exists but says the feature does not", async () => {
    const app = await setupApp();
    const res = await fetch(`http://127.0.0.1:${app.port}/oauth/callback`);
    expect(res.status).toBe(501);
  });

  it("an unrecognized path 404s", async () => {
    const app = await setupApp();
    const res = await fetch(`http://127.0.0.1:${app.port}/nope`);
    expect(res.status).toBe(404);
  });
});
