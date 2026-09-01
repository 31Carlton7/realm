import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@realm/adapters";
import type { RpcServer } from "../rpc/server";
import type { SessionsStore } from "../store/sessions";
import type { McpCallLogStore, McpServerRow, McpServersStore } from "../store/mcp";
import type { McpHub, McpLiveTool } from "./hub";
import type { McpService } from "./service";

const SUMMARY_MAX = 200;
const truncate = (s: string): string => (s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s);

/** Who is calling a provider tool — the gateway's own session attribution, handed through so a
 *  provider can raise `permission_request` on the RIGHT session and scope policy per space. */
export type ProviderCallContext = { sessionId: string; spaceId: string };

/**
 * A Realm-native toolset mounted in-process on the gateway (spec §1 goal 3: "the future `browser.*` …
 * tools register as an in-process provider on this same hub instead of needing their own delivery
 * path"). The mount point is HERE rather than on `McpHub` deliberately: the hub is "the only code in
 * Realm that speaks MCP to third-party servers" — row-keyed, session-blind, circuit-broken — and none
 * of that fits code that never crosses a process boundary. What a provider needs is exactly what the
 * gateway has and the hub never sees: the calling session's identity, for permission prompts.
 *
 * Providers share the row namespace (`<name>__<tool>`) and the longest-prefix routing rule; on an
 * exact name tie with a user-defined server row, the provider wins (Realm's own tools are not
 * shadowable by config). A provider handles its own per-space enablement: `tools()` returns `[]` and
 * `call()` refuses when the space turned it off (`mcp.setProviderEnabled`).
 */
export type RealmToolProvider = {
  /** Must satisfy `McpServerNameSchema`'s charset — it becomes a tool-name prefix on the same wire. */
  name: string;
  tools(ctx: ProviderCallContext): Promise<Tool[]>;
  call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult>;
};

/** One registered Realm session: its bearer token, the space it belongs to, and — created lazily on the
 *  first authorized request — the SDK `Server`/`StreamableHTTPServerTransport` pair the agent's own MCP
 *  client actually talks to. `spaceId` is fixed at `register()` time: a session's space never changes
 *  after creation (there is no RPC for it), so there is nothing to keep in sync. */
type SessionEntry = {
  token: string;
  spaceId: string;
  server: Server | null;
  transport: StreamableHTTPServerTransport | null;
  /**
   * Set while the FIRST authorized request is still creating this session's `Server`/transport pair.
   *
   * `connectSession` has no genuine I/O await today — creating and wiring the SDK `Server` is pure
   * in-process setup, so two calls to `ensureSessionServer` issued back-to-back in the SAME synchronous
   * tick are guaranteed (by ordinary JS scheduling, not by this field) to see `entry.connecting` already
   * set before the second one could ever start its own `connectSession`. This field is therefore a
   * PRE-EMPTIVE guard against a hazard that is not observably reachable yet, not a fix for a bug that was
   * caught happening — two real concurrent HTTP requests (the case that motivated adding it) did not
   * reproduce it in testing. It earns its keep the moment this path gains a real await (W5's OAuth token
   * check is the obvious candidate) — see `hub.ts`'s own `connecting` field, which guards the identical
   * shape of race in a place where the await is real today.
   */
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
  /** In-process Realm toolsets, keyed by provider name — see `RealmToolProvider`. */
  private readonly providers = new Map<string, RealmToolProvider>();
  /** Reverse index for auth: bearer token → session id. Kept in lockstep with `sessions` by `register`/
   *  `release` — never written anywhere else. */
  private readonly tokenToSession = new Map<string, string>();

  constructor(private readonly d: {
    hub: McpHub; mcp: McpService; sessions: SessionsStore; calls: McpCallLogStore; rpc: RpcServer; servers: McpServersStore;
    /**
     * `GET /oauth/callback` handler — `McpOauth.handleCallback`, wired in `app.ts`. A seam rather than an
     * `McpOauth` dependency so this file stays ignorant of OAuth entirely: it owns the loopback listener
     * that the redirect URI necessarily points at, and its whole job here is to turn one URL into one of
     * two static pages. Unwired (older tests, a harness with no OAuth), the route keeps its honest 501.
     *
     * Rejections are rendered as the failure page using `Error.message`, so the handler must return
     * messages that are safe to show — `McpOauth` sanitizes its own errors for exactly this reason.
     */
    onOauthCallback?: (url: string) => Promise<{ serverId: string }>;
  }) {}

  /** The bound loopback port, or `null` before `listen()`. Read by the OAuth redirect URI, which cannot
   *  exist until there is a listener to redirect to. */
  get boundPort(): number | null {
    return this.port;
  }

  /** Mount an in-process Realm toolset (see `RealmToolProvider`). Registering the same name twice
   *  replaces — a test convenience; production registers each provider once at startup. Connected
   *  sessions are told to re-list, since the tool surface just changed under them. */
  registerProvider(provider: RealmToolProvider): void {
    this.providers.set(provider.name, provider);
    this.notifyToolsChanged();
  }

  /** Binds 127.0.0.1:0 (OS-assigned — see the plan's port-0 amendment) and returns the bound port. */
  async listen(): Promise<number> {
    this.httpServer = createServer((req, res) => void this.handleHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.httpServer.address();
    // A non-object address (a pipe) or a zero port means the listener is bound to nothing usable. Left
    // as `0`, that number would go on to mint `http://127.0.0.1:0/oauth/callback` as a redirect URI and
    // a session's gateway URL — both silently unreachable. `boundPort` stays null instead (so
    // `oauth.start` refuses outright) and startup fails here, which is where the spec puts this failure.
    this.port = typeof addr === "object" && addr && addr.port > 0 ? addr.port : null;
    if (this.port === null) throw new Error("mcp gateway: the listener bound without a usable TCP port");
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
      await this.handleOauthCallback(url, res);
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
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "internal" }));
      } else {
        // Headers (or an SSE stream) already went out — there is no clean response left to send, and
        // leaving the socket open would strand the agent's request until ITS OWN timeout instead of
        // failing fast. Destroy rather than `.end()`: an in-flight SSE stream has no well-formed way to
        // signal "actually, this failed" after framing has already started.
        res.destroy();
      }
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

  /**
   * The OAuth redirect target. The user's browser lands here, so both outcomes are a tiny static page
   * addressed to a human — never JSON, never a redirect back to anything.
   *
   * **Neither page carries user data or a token.** The success page says one sentence and names no
   * server (the browser tab is a dead end; Realm's own window is where the connection now shows up).
   * The failure page adds the handler's sanitized reason — see the `onOauthCallback` doc comment — and
   * HTML-escapes it, because that reason can quote text an upstream authorization server wrote.
   */
  private async handleOauthCallback(url: URL, res: ServerResponse): Promise<void> {
    if (!this.d.onOauthCallback) {
      // A 501 (not 404) says "the route exists, the feature is not wired here" — the distinction a
      // redirect-URI-not-found error would otherwise hide from whoever is debugging it.
      res.writeHead(501, { "Content-Type": "text/plain" });
      res.end("OAuth is not enabled on this gateway");
      return;
    }
    try {
      // Re-based on the real bound port so the handler sees the exact URL the authorization server
      // redirected to, not `handleHttp`'s portless parsing base.
      await this.d.onOauthCallback(new URL(url.pathname + url.search, `http://127.0.0.1:${this.port}`).toString());
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(oauthPage("Connected", "Connected — return to Realm."));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(oauthPage("Connection failed", "Connection failed — try again from Realm settings.", err instanceof Error ? err.message : String(err)));
    }
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
      server.setRequestHandler(ListToolsRequestSchema, async () => this.listTools(sessionId, entry.spaceId));
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
   *
   * `inputSchema` is forwarded VERBATIM from the upstream server's own `tools/list` (`McpHub.tools()`'s
   * live return, not its persisted cache — see `McpLiveTool`'s doc comment). Agents construct a tool
   * call's arguments FROM this schema, so a placeholder `{type:"object"}` here would silently degrade
   * every schema-heavy server: required fields, enums, nested shapes all become invisible to the agent.
   * The hub itself still never validates a call's arguments against it (see `McpHub.call()`'s own doc
   * comment) — this is purely what the agent sees, not something Realm checks. The `?? { type: "object"
   * }` fallback only ever fires for a malformed upstream tool that omitted its own schema; the MCP spec
   * requires one.
   */
  private async listTools(sessionId: string, spaceId: string): Promise<{ tools: Tool[] }> {
    // In-process providers first — same failure posture as a dead upstream: a throwing provider
    // contributes no tools rather than erroring the whole list. A provider that is disabled for this
    // space reports that itself by returning [].
    const perProvider = await Promise.all([...this.providers.values()].map(async (p): Promise<Tool[]> => {
      try {
        const tools = await p.tools({ sessionId, spaceId });
        return tools.map((t): Tool => ({ ...t, name: `${p.name}__${t.name}` }));
      } catch { return []; }
    }));
    const perServer = await Promise.all(this.d.mcp.enabledServerIds(spaceId).map(async (id): Promise<Tool[]> => {
      const row = this.d.servers.get(id);
      if (!row) return [];
      let tools: McpLiveTool[];
      try { tools = await this.d.hub.tools(id); } catch { return []; }
      const allowed = this.d.mcp.allowedTools(spaceId, id);
      const visible = allowed ? tools.filter((t) => allowed.includes(t.name)) : tools;
      return visible.map((t): Tool => ({ name: `${row.name}__${t.name}`, description: t.description, inputSchema: t.inputSchema ?? { type: "object" } }));
    }));
    return { tools: [...perProvider.flat(), ...perServer.flat()] };
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
   * A blocked call is never forwarded to the hub, but IS logged (ok: false, `resultSummary` naming the
   * policy that blocked it) and broadcast, same as any other call — Activity is Realm's own record of
   * what agents tried to do through it, and a denied call is exactly the kind of thing a space owner
   * wants visible there (this is what W7's Activity view surfaces policy denials from).
   */
  private async handleCall(sessionId: string, spaceId: string, fullName: string, args: unknown): Promise<CallToolResult> {
    const argsJson = JSON.stringify(args ?? {});
    // In-process providers route first, under the same longest-prefix rule (an exact name tie goes to
    // the provider — Realm's own tools are not shadowable by a config row; see `RealmToolProvider`).
    // Provider calls land in the same Activity log, with `serverId: null` — there is no row behind them.
    const provider = this.resolveProvider(spaceId, fullName);
    if (provider) {
      const start = Date.now();
      try {
        const result = await provider.p.call({ sessionId, spaceId }, provider.tool, args);
        this.record(sessionId, null, provider.p.name, provider.tool, argsJson, result.isError !== true, Date.now() - start, summarize(result));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.record(sessionId, null, provider.p.name, provider.tool, argsJson, false, Date.now() - start, truncate(message));
        return errorResult(message);
      }
    }
    // Routing (which server actually receives an ALLOWED call) only ever considers ENABLED servers — see
    // `resolveCall`'s own comment on why that is what keeps the longest-prefix match unambiguous. A
    // blocked call's log entry still deserves real attribution when one exists, so a name that matches a
    // known but DISABLED server is looked up separately, purely for that log row — it never feeds back
    // into routing or the enabled-only prefix match above it.
    const resolved = this.resolveCall(spaceId, fullName);
    if (!resolved) {
      const disabled = this.resolveAnyServer(fullName);
      if (disabled) {
        return this.blocked(sessionId, disabled.row.id, disabled.row.name, disabled.tool, argsJson,
          `mcp: "${disabled.row.name}" is disabled for this space — turn it on in Space Settings → MCP.`,
          `blocked: ${disabled.row.name} is disabled in this space`);
      }
      return this.blocked(sessionId, null, "", fullName, argsJson,
        `mcp: no MCP server enabled in this space provides "${fullName}" — check Space Settings → MCP.`,
        `blocked: no server provides "${fullName}"`);
    }
    const { serverId, serverName, tool } = resolved;
    const allowed = this.d.mcp.allowedTools(spaceId, serverId);
    if (allowed && !allowed.includes(tool)) {
      return this.blocked(sessionId, serverId, serverName, tool, argsJson,
        `mcp: "${tool}" on "${serverName}" is not enabled for this space — turn it on in Space Settings → MCP → ${serverName}.`,
        `blocked: tool not in this space's allowlist`);
    }
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

  /** A policy-blocked call: logs it (ok: false, `durationMs: 0` — nothing actually reached the hub) and
   *  returns the tool error the AGENT sees. `agentMessage` is the fuller, addressed-to-a-human text (names
   *  the space setting to change); `logSummary` is the short form Activity's `resultSummary` column shows. */
  private blocked(sessionId: string, serverId: string | null, serverName: string, tool: string, argsJson: string, agentMessage: string, logSummary: string): CallToolResult {
    this.record(sessionId, serverId, serverName, tool, argsJson, false, 0, logSummary);
    return errorResult(agentMessage);
  }

  private record(sessionId: string, serverId: string | null, serverName: string, tool: string, argsJson: string, ok: boolean, durationMs: number, resultSummary: string): void {
    const row = this.d.calls.append({ sessionId, serverId, serverName, tool, argsJson, resultSummary, ok, durationMs });
    this.d.rpc.broadcast("mcp.call", row);
  }

  /** Longest provider-name prefix of `fullName` — unless an ENABLED server row's still-longer name
   *  out-prefixes every provider, in which case the row keeps the call (`resolveCall` will find it) and
   *  this returns null. An exact-length tie goes to the provider: Realm's own tools win over a config
   *  row that happens to share their name. */
  private resolveProvider(spaceId: string, fullName: string): { p: RealmToolProvider; tool: string } | null {
    let best: RealmToolProvider | null = null;
    for (const p of this.providers.values()) {
      if (fullName.startsWith(`${p.name}__`) && (!best || p.name.length > best.name.length)) best = p;
    }
    if (!best) return null;
    const row = this.resolveCall(spaceId, fullName);
    if (row && row.serverName.length > best.name.length) return null;
    return { p: best, tool: fullName.slice(best.name.length + 2) };
  }

  /** See the class doc comment's "Tool naming" section for why this is a longest-enabled-prefix match
   *  rather than a split on the first `__`. Enabled servers ONLY — see `handleCall`'s comment on why a
   *  disabled server's name must never win this match. */
  private resolveCall(spaceId: string, fullName: string): { serverId: string; serverName: string; tool: string } | null {
    const match = longestPrefixMatch(fullName, this.d.mcp.enabledServerIds(spaceId).map((id) => this.d.servers.get(id)).filter((r): r is McpServerRow => r !== null));
    return match ? { serverId: match.row.id, serverName: match.row.name, tool: match.tool } : null;
  }

  /** Same longest-prefix match as `resolveCall`, but over EVERY known server row regardless of
   *  enablement — used only to attribute a blocked-call log entry to a real (if disabled) server, never
   *  for routing. Keeping this a separate method (rather than an "include disabled" flag on `resolveCall`)
   *  is what guarantees a disabled server's longer name can never shadow an enabled one's shorter name
   *  in the match that actually decides where a call goes. */
  private resolveAnyServer(fullName: string): { row: McpServerRow; tool: string } | null {
    return longestPrefixMatch(fullName, this.d.servers.list());
  }
}

/** The longest `"<row.name>__"` prefix of `fullName` among `rows`, or null if none matches. Shared by
 *  `resolveCall` (enabled rows, for routing) and `resolveAnyServer` (every row, for blocked-call
 *  attribution) so the matching rule itself — and the reasoning in the class doc comment's "Tool naming"
 *  section for why it is longest-match rather than split-on-first-`__` — lives in exactly one place. */
function longestPrefixMatch(fullName: string, rows: readonly McpServerRow[]): { row: McpServerRow; tool: string } | null {
  let best: McpServerRow | null = null;
  for (const row of rows) {
    const prefix = `${row.name}__`;
    if (fullName.startsWith(prefix) && (!best || row.name.length > best.name.length)) best = row;
  }
  return best ? { row: best, tool: fullName.slice(best.name.length + 2) } : null;
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The whole OAuth callback UI: a title, a sentence, and — on failure only — the reason. No stylesheet,
 *  no script, no link back (a loopback page cannot focus the Realm window anyway), and nothing
 *  interpolated that has not been escaped. */
const oauthPage = (title: string, message: string, detail?: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Realm — ${escapeHtml(title)}</title>` +
  `<body style="font: 15px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 32rem; padding: 0 1.5rem">` +
  `<p>${escapeHtml(message)}</p>${detail ? `<p style="color:#777">${escapeHtml(detail)}</p>` : ""}</body>`;

/** First text-content block, truncated to `SUMMARY_MAX` chars — never the full payload (an
 *  upstream tool result can be arbitrarily large; Activity shows an excerpt, not a mirror). */
function summarize(result: CallToolResult): string {
  const first = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  return truncate(first?.text ?? "");
}
