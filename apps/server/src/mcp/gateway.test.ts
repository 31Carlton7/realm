import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { EventName, EventPayload } from "@realm/contracts";
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

  const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  const spaceId = new SpacesStore(db, home).create({ profileId: profile.id, name: "Work", icon: "folder" }).id;
  const envId = new EnvironmentsStore(db).ensurePrimary(spaceId).id;
  const sessionId = sessionsStore.create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", environmentId: envId, title: "s" }).id;

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
  };
  activeApps.push(app);
  return app;
}

/** `register()` always returns the http variant (see the gateway's own doc comment) — narrow once here
 *  rather than casting at every call site that reads `.url`/`.headers`. `Extract` keys on `url` rather
 *  than `transport` because the http/sse member's `transport` field is itself `"http" | "sse"`, which
 *  is not assignable to the literal `"http"` `Extract<_, { transport: "http" }>` would need. */
const asHttp = (cfg: McpServerConfig) => cfg as Extract<McpServerConfig, { url: string }>;

/** Registers `sessionId` and connects a real SDK client to the gateway over real HTTP — every test that
 *  needs to actually speak MCP (as opposed to poking the listener with raw `fetch`) goes through this. */
async function connectClient(app: App, opts: { onToolsChanged?: (tools: unknown[]) => void } = {}): Promise<{ client: Client; token: string; url: string }> {
  const { url, headers } = asHttp(app.gateway.register(app.sessionId, app.spaceId));
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

  it("re-checks enablement at call time — disabling the server blocks its very next call", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    expect((await client.callTool({ name: "alpha__echo", arguments: {} })).isError).toBeFalsy();
    app.mcp.setEnabled(app.spaceId, alpha.id, false);
    const blocked = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    await client.close();
  });

  it("re-checks allowedTools at call time — narrowing mid-session blocks the excluded tool", async () => {
    const app = await setupApp();
    const { row: alpha } = app.addServer("alpha");
    app.mcp.setEnabled(app.spaceId, alpha.id, true);
    const { client } = await connectClient(app);
    expect((await client.callTool({ name: "alpha__echo", arguments: {} })).isError).toBeFalsy();
    app.mcp.setAllowedTools(app.spaceId, alpha.id, ["boom"]); // echo no longer allowed
    const blocked = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(asText(blocked)).toMatch(/space settings/i);
    await client.close();
  });

  it("blocked-call error names the space policy and where to change it", async () => {
    const app = await setupApp();
    app.addServer("alpha"); // never enabled
    const { client } = await connectClient(app);
    const blocked = (await client.callTool({ name: "alpha__echo", arguments: {} })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(asText(blocked)).toMatch(/space settings/i);
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

  it("does not log a blocked call — nothing left realm-server, so there is nothing to log", async () => {
    const app = await setupApp();
    app.addServer("alpha"); // never enabled
    const { client } = await connectClient(app);
    await client.callTool({ name: "alpha__echo", arguments: {} });
    expect(app.calls.list({ sessionId: app.sessionId })).toEqual([]);
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
});

describe("concurrent first-touch requests share one Server/transport pair", () => {
  it("two simultaneous `initialize` requests for a brand-new session both land on the SAME SDK session id", async () => {
    // A real client's connect() fires more than one request close together (the initial POST, then a
    // standalone GET for its server-push stream) — the two racing `handleMcp` calls this simulates
    // directly must share ONE `ensureSessionServer` creation, not each mint their own `Server` +
    // `StreamableHTTPServerTransport` (with its own random `sessionIdGenerator` UUID). If they didn't
    // share, this test's two responses would carry two DIFFERENT `mcp-session-id` headers — and whichever
    // pair lost the race would be silently orphaned, with any server-initiated notification sent through
    // it never reaching the client that is actually still listening on the other one.
    const app = await setupApp();
    const { url, headers } = asHttp(app.gateway.register(app.sessionId, app.spaceId));
    const init = () => fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "race-test", version: "1.0.0" } },
      }),
    });
    const [a, b] = await Promise.all([init(), init()]);
    // Two independent `Server`/transport pairs would each answer their own `initialize` with its own
    // freshly-minted `mcp-session-id` — both responses would succeed, with two DIFFERENT ids. One shared
    // transport (the fix) can only complete one `initialize`; the second is a duplicate on the SAME
    // session and the SDK rejects it — so the real signature of "they shared one pair" is: exactly one
    // session id was ever minted, not that both requests individually succeeded.
    const sidA = a.headers.get("mcp-session-id");
    const sidB = b.headers.get("mcp-session-id");
    const mintedIds = new Set([sidA, sidB].filter((x): x is string => !!x));
    expect(mintedIds.size).toBe(1);
    await a.body?.cancel().catch(() => {});
    await b.body?.cancel().catch(() => {});
  });
});
