import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@realm/adapters";
import type { RpcServer } from "../rpc/server";
import type { SessionsStore } from "../store/sessions";
import type { McpCallLogStore, McpServersStore, McpToolRow } from "../store/mcp";
import type { McpHub } from "./hub";
import type { McpService } from "./service";

const TOOL_ERROR_TRUNCATE = 200;
const truncate = (s: string): string => (s.length > TOOL_ERROR_TRUNCATE ? s.slice(0, TOOL_ERROR_TRUNCATE) : s);

/** One registered Realm session: its bearer token, the space it belongs to, and — created lazily on the
 *  first authorized request — the SDK `Server`/`StreamableHTTPServerTransport` pair the agent's own MCP
 *  client actually talks to. `spaceId` is fixed at `register()` time: a session's space never changes
 *  after creation (there is no RPC for it), so there is nothing to keep in sync. */
type SessionEntry = {
  token: string;
  spaceId: string;
  server: Server | null;
  transport: StreamableHTTPServerTransport | null;
  /** Set while the FIRST authorized request is still creating this session's `Server`/transport pair.
   *  A Streamable HTTP client's `connect()` fires more than one request close together (the initial POST,
   *  then a standalone GET for its server-push stream) — without this, two of those racing `handleMcp`
   *  calls would each create their OWN pair, and the loser's transport (often the one the client's real
   *  SSE stream ends up bound to) would be silently orphaned: notifications sent through the map's
   *  `entry.server` would never reach a client listening on the other one. Mirrors `hub.ts`'s `connecting`
   *  field for the exact same reason. */
  connecting: Promise<{ server: Server; transport: StreamableHTTPServerTransport }> | null;
};

/**
 * The gateway agents actually connect to. One loopback HTTP listener (port 0, bound in `listen()`)
 * speaking Streamable HTTP MCP, stateful per Realm session: `register()` mints a bearer token and hands
 * back the ONE server entry an adapter will ever see; the first authorized request against that token
 * lazily creates a dedicated low-level SDK `Server` + `StreamableHTTPServerTransport` pair, reused for
 * every later request from that same session.
 *
 * **Tool naming.** `McpServerNameSchema` allows `_`, so `__` — the namespace separator — could in
 * principle appear inside a server name too (`"my__server"`). Splitting a call's tool name on the FIRST
 * `__` would misroute a call to a server like that: `"my__server__search"` would split into server
 * `"my"` / tool `"server__search"` instead of server `"my__server"` / tool `"search"`. Server names are
 * unique per row, so instead `resolveCall` matches the full name against every ENABLED server's
 * `"<name>__"` prefix and keeps the LONGEST match — the one prefix that could not also be a truncation of
 * a longer, equally-valid server name. See `resolveCall`'s own comment.
 */
export class McpGateway {
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  /** Keyed by Realm session id. */
  private readonly sessions = new Map<string, SessionEntry>();
  /** Reverse index for auth: bearer token → session id. Kept in lockstep with `sessions` by `register`/
   *  `release` — never written anywhere else. */
  private readonly tokenToSession = new Map<string, string>();

  constructor(private readonly d: { hub: McpHub; mcp: McpService; sessions: SessionsStore; calls: McpCallLogStore; rpc: RpcServer; servers: McpServersStore }) {}

  /** Binds 127.0.0.1:0 (OS-assigned — see the plan's port-0 amendment) and returns the bound port. */
  async listen(): Promise<number> {
    this.httpServer = createServer((req, res) => void this.handleHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.httpServer.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  /**
   * Mint a fresh bearer token for this session and return the one MCP server config an adapter will
   * ever be started with. Calling this twice for the same sessionId (a session restart re-registering)
   * revokes the OLD token and closes whatever SDK `Server`/transport it had created — the previous
   * connection belongs to an adapter process that is gone, so nothing should still answer with it.
   */
  register(sessionId: string, spaceId: string): McpServerConfig {
    if (this.port === null) throw new Error("McpGateway.register() called before listen()");
    const previous = this.sessions.get(sessionId);
    if (previous) {
      this.tokenToSession.delete(previous.token);
      void previous.server?.close().catch(() => {});
      void previous.transport?.close().catch(() => {});
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, { token, spaceId, server: null, transport: null, connecting: null });
    this.tokenToSession.set(token, sessionId);
    return { name: "realm", transport: "http", url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
  }

  /** Revoke this session's token and close its SDK `Server`/transport, if any were ever created. A
   *  no-op for a sessionId that was never registered (or already released) — every call site (the pump's
   *  `finally`, session delete, `closeAll`) calls this unconditionally rather than tracking whether it
   *  already ran. */
  release(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.tokenToSession.delete(entry.token);
    this.sessions.delete(sessionId);
    void entry.server?.close().catch(() => {});
    void entry.transport?.close().catch(() => {});
  }

  /** An enablement or allowedTools edit landed for this space: tell every registered session IN that
   *  space to re-list. A session that never connected (no `entry.server` yet) has nothing to notify —
   *  its first connection will read the new policy fresh. */
  notifyPolicyChanged(spaceId: string): void {
    for (const entry of this.sessions.values()) {
      if (entry.spaceId === spaceId) void entry.server?.sendToolListChanged().catch(() => {});
    }
  }

  /** The hub's own signal that a cached tool list changed (a `tools/list_changed` from upstream, or a
   *  reconnect) — unlike a policy edit this isn't scoped to one space, so every registered session with a
   *  live connection is notified. Status events can repeat (see `hub.ts`), so this must tolerate being
   *  called more often than the tool list actually changed — a redundant `tools/list_changed` costs the
   *  agent one extra re-list, not correctness. */
  notifyToolsChanged(): void {
    for (const entry of this.sessions.values()) void entry.server?.sendToolListChanged().catch(() => {});
  }

  /** Shutdown: close every registered session's SDK `Server`/transport, then stop accepting connections.
   *  Best-effort throughout — a client mid-request when the process exits was always going to see the
   *  connection drop; this just does not let closing one client's transport stop the others from
   *  closing too. */
  async close(): Promise<void> {
    for (const entry of this.sessions.values()) {
      // A connect racing shutdown must be awaited rather than abandoned, so its server/transport (once
      // created) is reachable below to close — an abandoned `connectSession` would finish adopting a
      // client after `close()` had already returned and the process was on its way out.
      if (entry.connecting) { try { await entry.connecting; } catch { /* superseded or failed; nothing left to close */ } }
      if (entry.server) { try { await entry.server.close(); } catch { /* shutting down anyway */ } }
      if (entry.transport) { try { await entry.transport.close(); } catch { /* shutting down anyway */ } }
    }
    this.sessions.clear();
    this.tokenToSession.clear();
    await new Promise<void>((resolve) => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/oauth/callback") {
      // W5 replaces this. A 501 (not 404) says "the route exists, the feature does not" — the
      // distinction a redirect-URI-not-found error would otherwise hide from whoever is debugging it.
      res.writeHead(501, { "Content-Type": "text/plain" });
      res.end("OAuth arrives in a later workstream");
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      await this.handleMcp(req, res);
    } catch {
      // The SDK transport handles MCP-protocol-level errors itself; this is the backstop for anything
      // that escapes it (a handler throwing outside a CallToolResult, a mid-response socket error) so one
      // bad request can't take the whole listener down.
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "internal" })); }
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    const sessionId = token ? this.tokenToSession.get(token) : undefined;
    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    // `d.sessions.get` is a second, independent check that the session row itself still exists —
    // defense in depth against the token map ever going stale (a crash mid-`release`, say). A token is
    // never valid MCP framing here: an unauthorized caller gets a plain JSON 401, nothing that looks like
    // a protocol response.
    if (!token || !sessionId || !entry || !this.d.sessions.get(sessionId)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const { transport } = await this.ensureSessionServer(sessionId, entry);
    await transport.handleRequest(req, res);
  }

  /** Get-or-create this session's SDK `Server` + `StreamableHTTPServerTransport` pair. Created on the
   *  FIRST authorized request and reused for every later one — stateful mode, one pair per Realm session
   *  for its whole lifetime. Concurrent first-touch requests (see `SessionEntry.connecting`'s doc
   *  comment) share the ONE in-flight creation rather than racing separate ones. */
  private async ensureSessionServer(sessionId: string, entry: SessionEntry): Promise<{ server: Server; transport: StreamableHTTPServerTransport }> {
    if (entry.server && entry.transport) return { server: entry.server, transport: entry.transport };
    if (!entry.connecting) entry.connecting = this.connectSession(sessionId, entry);
    return entry.connecting;
  }

  private async connectSession(sessionId: string, entry: SessionEntry): Promise<{ server: Server; transport: StreamableHTTPServerTransport }> {
    try {
      const server = new Server({ name: "realm-gateway", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
      server.setRequestHandler(ListToolsRequestSchema, async () => this.listTools(entry.spaceId));
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        this.handleCall(sessionId, entry.spaceId, request.params.name, request.params.arguments));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      await server.connect(transport);
      // `register()` (a session restart) may have swapped in a FRESH entry for `sessionId` while this
      // connect was in flight — `entry` here would then be an orphan nothing else references. Adopting it
      // would leak exactly the dangling transport a restart's token revocation is supposed to prevent, so
      // close it instead of storing it.
      if (this.sessions.get(sessionId) !== entry) {
        await server.close().catch(() => {});
        throw new Error(`mcp gateway: session ${sessionId}'s connection was superseded before it finished`);
      }
      entry.server = server;
      entry.transport = transport;
      entry.connecting = null;
      return { server, transport };
    } catch (err) {
      // Reset BEFORE rethrowing: a future request for this (still-live) entry must retry the connect,
      // not replay this same rejection forever — see `hub.ts`'s `connect()` for the identical reasoning.
      entry.connecting = null;
      throw err;
    }
  }

  /**
   * The union of this space's enabled servers' tools, re-exported as `<serverName>__<toolName>` and
   * filtered by `allowedTools`. `hub.tools()` THROWS on failure (see its own doc comment) — caught here
   * per server, so one dead upstream contributes no tools of its own rather than erroring the whole list.
   * `inputSchema: { type: "object" }` (no `properties`) is deliberately permissive: the hub forwards
   * calls verbatim without validating against the cached tool list (see `McpToolRow`'s doc comment), so
   * this schema promises nothing it might have to take back the moment an upstream tool's real schema
   * changes.
   */
  private async listTools(spaceId: string): Promise<{ tools: Tool[] }> {
    const perServer = await Promise.all(this.d.mcp.enabledServerIds(spaceId).map(async (id): Promise<Tool[]> => {
      const row = this.d.servers.get(id);
      if (!row) return [];
      let tools: McpToolRow[];
      try { tools = await this.d.hub.tools(id); } catch { return []; }
      const allowed = this.d.mcp.allowedTools(spaceId, id);
      const visible = allowed ? tools.filter((t) => allowed.includes(t.name)) : tools;
      return visible.map((t): Tool => ({ name: `${row.name}__${t.name}`, description: t.description, inputSchema: { type: "object" } }));
    }));
    return { tools: perServer.flat() };
  }

  /**
   * Resolve `fullName` (`<serverName>__<toolName>`) against THIS space's enabled servers, re-checking
   * enablement and the tool allowlist at call time rather than trusting whatever `listTools` last
   * returned — a policy edit (disable the server, narrow its tools) must reach a session already running,
   * not just the next `tools/list`. Corrupted `allowedTools` storage fails OPEN (every tool allowed) —
   * `McpService.allowedTools`'s doc comment has the reasoning (Realm writes this key itself, so
   * corruption is a bug, not an attacker, and failing closed would silently kill tools with no UI
   * explaining why); this handler does not re-litigate it.
   *
   * A blocked call is never forwarded to the hub and never logged — nothing left realm-server, so there
   * is nothing for Activity to have a row about (the tool error text is the whole of what a policy
   * decision produces here).
   */
  private async handleCall(sessionId: string, spaceId: string, fullName: string, args: unknown): Promise<CallToolResult> {
    const resolved = this.resolveCall(spaceId, fullName);
    if (!resolved) {
      return errorResult(`mcp: no MCP server enabled in this space provides "${fullName}" — check Space Settings → MCP.`);
    }
    const { serverId, serverName, tool } = resolved;
    const allowed = this.d.mcp.allowedTools(spaceId, serverId);
    if (allowed && !allowed.includes(tool)) {
      return errorResult(`mcp: "${tool}" on "${serverName}" is not enabled for this space — turn it on in Space Settings → MCP → ${serverName}.`);
    }
    const argsJson = JSON.stringify(args ?? {});
    const start = Date.now();
    try {
      const result = await this.d.hub.call(serverId, tool, args);
      // `isError: true` is a normal, successfully round-tripped MCP result — the call reached the
      // server and the SERVER reported a problem. It still counts as `ok: false` in Activity: from the
      // user's perspective a failed tool call is a failed tool call, whether the failure came back as a
      // thrown transport error or as a reported result. See `hub.ts`'s own `isError`/breaker distinction
      // for why the HUB treats the two differently — Activity's `ok` is a different question than the
      // circuit breaker's.
      this.record(sessionId, serverId, serverName, tool, argsJson, result.isError !== true, Date.now() - start, summarize(result));
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record(sessionId, serverId, serverName, tool, argsJson, false, Date.now() - start, truncate(message));
      // A thrown hub failure is already sanitized (see `hub.ts`'s `sanitize()`). Surfacing it as an
      // `isError: true` CallToolResult rather than letting it propagate as a JSON-RPC protocol error
      // gives the agent the same shape of failure it would get from any other failed tool call.
      return errorResult(message);
    }
  }

  private record(sessionId: string, serverId: string, serverName: string, tool: string, argsJson: string, ok: boolean, durationMs: number, resultSummary: string): void {
    const row = this.d.calls.append({ sessionId, serverId, serverName, tool, argsJson, resultSummary, ok, durationMs });
    this.d.rpc.broadcast("mcp.call", row);
  }

  /** See the class doc comment's "Tool naming" section for why this is a longest-enabled-prefix match
   *  rather than a split on the first `__`. */
  private resolveCall(spaceId: string, fullName: string): { serverId: string; serverName: string; tool: string } | null {
    let best: { id: string; name: string } | null = null;
    for (const id of this.d.mcp.enabledServerIds(spaceId)) {
      const row = this.d.servers.get(id);
      if (!row) continue;
      const prefix = `${row.name}__`;
      if (fullName.startsWith(prefix) && (!best || row.name.length > best.name.length)) best = { id, name: row.name };
    }
    return best ? { serverId: best.id, serverName: best.name, tool: fullName.slice(best.name.length + 2) } : null;
  }
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** First text-content block, truncated to `TOOL_ERROR_TRUNCATE` chars — never the full payload (an
 *  upstream tool result can be arbitrarily large; Activity shows an excerpt, not a mirror). */
function summarize(result: CallToolResult): string {
  const first = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  return truncate(first?.text ?? "");
}
