import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ElicitRequestSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, ToolListChangedNotificationSchema, type CallToolResult, type ElicitRequest, type ElicitResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_APPS_EXTENSION, MCP_APP_MIME, toolUiOf, type McpServerStatus, type ToolUi } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { credentialValues, redactValues } from "./redact";
import type { McpServerRow, McpServersStore, McpToolRow } from "../store/mcp";

/** The hub's live connection state for one server row — the same enum `mcp.serverStatus` puts on the
 *  wire (`McpServerStatusSchema`), so the gateway/UI never need a second vocabulary for it. */
type UpstreamStatus = McpServerStatus;

/**
 * What `tools()` returns to a live caller — name, description, AND the upstream's real `inputSchema`.
 * Distinct from `McpToolRow` (the persisted cache): the cache deliberately drops the schema because a
 * STORED one can go stale the moment an upstream server changes it between hub connections, and nothing
 * that reads the cache (settings rendering a server's tool list) constructs a tool call from it. This
 * type is fresh off the very `listTools()` call that produced it, so there is no staleness risk to guard
 * against — and the gateway's `tools/list` (W3+) forwards it straight through to the agent's own MCP
 * client, which NEEDS the real schema to construct valid tool call arguments. A placeholder schema here
 * would silently degrade every schema-heavy server (required fields, enums, nested shapes — all invisible
 * to the agent).
 */
export type McpLiveTool = { name: string; description: string; inputSchema: Tool["inputSchema"];
  /** What the tool says about a view of its own (MCP Apps), or null when it says nothing — `toolUiOf`
   *  of its `_meta`. Kept because it decides two things the gateway owes the spec: an app-only tool
   *  is never listed to the agent, and a call to a tool with a resource draws that resource. */
  ui: ToolUi | null;
  /** The tool exactly as the server listed it — what a view is told it was called through
   *  (`hostContext.toolInfo`). The fields above are projections of it. */
  def: Tool };

/** A `ui://` resource as a view is built from it: the HTML, and the `_meta.ui` it came with (CSP
 *  domains, `prefersBorder`) — the content item's own, else its entry in `resources/list`. */
export type McpUiResource = { html: string; ui: Record<string, unknown> | null };

/** How long a read template is kept before the next view reads it again. A server that changes a
 *  template says so (`resources/updated`), and a reconnect forgets them all; this bounds the rest. */
const UI_RESOURCE_TTL_MS = 10 * 60_000;

/** Consecutive THROWN failures — a rejected connect, `tools/list`, or `tools/call` — that trip the
 *  breaker. Deliberately not `isError: true` results: that is a normal, successfully round-tripped MCP
 *  response where the *tool* reported a problem (bad arguments, a lint finding, ...), not the connection.
 *  Three of those from one confused agent must not circuit-open a server that is working fine. Any
 *  success, of any kind, resets the count to zero. */
const CIRCUIT_THRESHOLD = 3;

/** How long one call may run — the SDK's own clock for it, an hour, so a server that is working is
 *  never cut off by Realm. Paired with the engines' `GATEWAY_TOOL_TIMEOUT_MS`, a minute longer, so
 *  this answer is the one that lands. A server whose process dies or whose connection closes fails
 *  the call at once: the SDK rejects every request still open when its transport closes. */
const CALL_CEILING_MS = 60 * 60_000;

/** How long a tripped breaker waits before the next call may try the server again, doubling with
 *  each trip in a row up to `CIRCUIT_COOLOFF_MAX_MS`. The hub tries once itself when the wait ends,
 *  so a server that comes back is back for every session, including one whose list it dropped out of. */
export const CIRCUIT_COOLOFF_MS = 30_000;
const CIRCUIT_COOLOFF_MAX_MS = 5 * 60_000;

/** One call on its way to a server, and who made it — what an elicitation is routed by. */
type OpenCall = { serverId: string; sessionId: string | null };

/** What the hub hands a server's question to (`elicitation.ts`): the server, the session whose call
 *  it interrupted, the request itself, and the server withdrawing it. */
export type HubElicit = (r: { serverId: string; sessionId: string; params: ElicitRequest["params"]; signal: AbortSignal }) => Promise<ElicitResult>;

type Entry = {
  status: UpstreamStatus;
  client: Client | null;
  /** Set while a connect is in flight, so two concurrent `tools()`/`call()` on the same row await one
   *  connection attempt instead of racing two SDK `Client`s onto the same process or socket. */
  connecting: Promise<Client> | null;
  failures: number;
  /** While the breaker is open: when the next call may try the server again, and the timer that tries
   *  it then. `trips` counts the breaker's openings since the last success — what the wait doubles by. */
  retryAt: number;
  trips: number;
  cooloff: NodeJS.Timeout | null;
  /** The last live `tools/list`, by name — what `toolOf` answers from without a round trip. Null until
   *  this client has listed once. */
  tools: Map<string, McpLiveTool> | null;
  /** `ui://` templates already read through this client, by URI. */
  resources: Map<string, { at: number; resource: McpUiResource }>;
  /** Every credential VALUE (`row.secrets`, and for http/sse the merged `authHeaders` result too)
   *  that went into the most recent transport attempt for this row, expanded by `credentialValues` so a
   *  scheme-prefixed header contributes BOTH `"Bearer <token>"` and the bare `<token>` — an upstream
   *  error quotes one or the other, never reliably the form the header happened to be stored in.
   *  Captured by `buildTransport` before it does anything that can throw, and read by `sanitize()`
   *  instead of re-fetching the row at throw time, which would silently skip redaction if the row was
   *  deleted in between. Overwritten (not accumulated) on every attempt; a fresh `Entry` after
   *  `invalidate()`/`retry()` starts empty. */
  redact: string[];
  /** The transport the live client speaks over — for a stdio row, the process Realm started. */
  transport: Transport | null;
  /** When this server was last connected to or called; what the resource report and the idle sweep read. */
  usedAt: number;
  /** A stdio server stopped for having nothing to do (`sleepIdle`): its last tool list is still served,
   *  and the next call starts it again. */
  asleep: boolean;
};

/**
 * The only code in Realm that speaks MCP to a third-party server. One SDK `Client` per server row,
 * shared across every session and space (single-user app; per-row credentials are what actually scopes
 * access, not a client-per-caller split) — created lazily on first `tools()`/`call()`, never at
 * construction.
 *
 * `authHeaders` is the OAuth seam — see its own doc comment on the constructor, including the
 * sanitization contract it places on whatever is wired into it.
 */
export class McpHub {
  private readonly entries = new Map<string, Entry>();
  private readonly open = new Set<OpenCall>();
  /** Set once by `close()`. A connect that resolves after this flips (it started before shutdown, the
   *  handshake just took a while) must be reaped, not adopted — see `connect()`'s post-resolve check. */
  private closed = false;

  constructor(private readonly d: {
    servers: McpServersStore;
    onStatus: (id: string, status: UpstreamStatus) => void;
    /** A server's cached tool list was just written: Settings draws a row's tools from it, and a
     *  connect Realm made on its own (a cool-off try) has no caller waiting to show them. */
    onTools?: (id: string, tools: McpToolRow[]) => void;
    /**
     * The OAuth seam (`McpOauth.headers`). Returns the credential headers to merge on top of
     * `row.secrets` for an http/sse row — `{}` for a row with no OAuth connection.
     *
     * **Contract: the provider sanitizes its own errors.** When this function RESOLVES, the hub adds the
     * headers it returned to `Entry.redact` and `sanitize()` can scrub them. When it REJECTS, the hub
     * has nothing but `row.secrets` to redact against — the access token, refresh token, and client
     * secret behind an OAuth header were never handed to it, and a rejection message quoting one (an
     * authorization server echoing a rejected refresh token back in a 400 body) would go straight out to
     * a log row, a broadcast, and an agent's tool result. Anything this function rejects with must
     * therefore already be free of credential values; `McpOauth` shares this hub's redaction rules
     * (`redact.ts`) so the two cannot drift apart on what "free of" means.
     */
    authHeaders: (row: McpServerRow) => Promise<Record<string, string>>;
    /**
     * The server answered 401 at connect (`McpOauth.reauthorize`). Resolves `true` when a DIFFERENT
     * credential is now stored — the GitHub CLI's token was read again and had changed — and the hub
     * then tries the connect once more with it. Same sanitization contract as `authHeaders`.
     */
    reauthorize?: (row: McpServerRow) => Promise<boolean>;
    /** Test-only seam: replaces real stdio/http/sse transport construction with whatever a test wants a
     *  row to connect through (an `InMemoryTransport`, typically — `stub-server.ts`'s `connectInMemory`
     *  is async, hence the `Promise` option, so a test factory can just forward it). Sharing, caching,
     *  and the circuit breaker below still run for real — this swaps out only the wire, never the hub's
     *  own logic. */
    makeTransport?: (row: McpServerRow, headers: Record<string, string>) => Transport | Promise<Transport>;
    /**
     * Where a server's question goes (MCP elicitation): onto the card of the session whose call it
     * came in the middle of. Absent, the hub declares no elicitation at all — a client that says it
     * can ask the user and then cannot is worse than one that says nothing.
     */
    elicit?: HubElicit;
    /** Whether `sleepIdle` may stop this server (`McpService.stopsWhenIdle`); absent, any may go. */
    stopsWhenIdle?: (id: string) => boolean;
  }) {}

  /**
   * Lazily connects and lists tools. The persisted CACHE (`servers.setTools`) keeps name, description
   * and the tool's view, never a schema — see `McpToolRow`'s doc comment for why a schema does not belong in something that can go
   * stale between connections. The value THIS method returns is not the cache: it is fresh off the very
   * `listTools()` call that produced it, so it carries the real `inputSchema` too (see `McpLiveTool`) —
   * the gateway forwards it verbatim to the agent's own MCP client.
   *
   * Throws on failure rather than returning `[]`: this layer reports what happened and lets the caller
   * decide. W3's gateway treats a thrown/failed `tools()` as "this server contributes no tools right
   * now" without erroring the whole `tools/list` response.
   */
  async tools(id: string): Promise<McpLiveTool[]> {
    // Asleep is not gone: its tools are the ones it listed before it was stopped, and a list is no
    // reason to start it again — every session start asks for one.
    const resting = this.entries.get(id);
    if (resting?.asleep && resting.tools && !resting.client) return [...resting.tools.values()];
    const { client, entry } = await this.ensureClient(id);
    try {
      const { tools } = await client.listTools();
      // Cache write: name + description ONLY, and whether the tool has a view. Deliberately a separate
      // projection from the return value below, not one derived from it, so it stays obviously correct
      // even if `McpLiveTool` grows another field later.
      this.cacheTools(id, tools);
      this.recordSuccess(id, entry);
      const live = tools.map(liveTool);
      entry.tools = new Map(live.map((t) => [t.name, t]));
      return live;
    } catch (err) {
      this.dropUnauthorized(entry, err);
      this.recordFailure(id, entry);
      throw sanitize(id, err, entry.redact);
    }
  }

  /** Forwards a call verbatim — no argument validation against the cached tool list, which can go
   *  stale the moment an upstream server changes its schema (see `McpToolSchema`'s own doc comment for
   *  why the cache carries no input schema to validate against in the first place). `caller` is the
   *  session making it: what a question the server asks mid-call is routed to. */
  async call(id: string, tool: string, args: unknown, caller?: { sessionId: string }): Promise<CallToolResult> {
    const { client, entry } = await this.ensureClient(id);
    entry.usedAt = Date.now();
    const open: OpenCall = { serverId: id, sessionId: caller?.sessionId ?? null };
    this.open.add(open);
    try {
      const result = (await client.callTool({ name: tool, arguments: args as Record<string, unknown> | undefined }, undefined,
        { timeout: CALL_CEILING_MS })) as CallToolResult;
      // `isError: true` is a normal, successfully round-tripped MCP result (the tool ran and reported a
      // problem) — it counts as a working connection, same as any other resolved call. Only a REJECTED
      // `callTool()` (transport/protocol failure, not a tool-level error) reaches the catch below and
      // counts against the breaker; see `CIRCUIT_THRESHOLD`'s doc comment for why that split matters.
      this.recordSuccess(id, entry);
      return result;
    } catch (err) {
      this.dropUnauthorized(entry, err);
      this.recordFailure(id, entry);
      throw sanitize(id, err, entry.redact);
    } finally {
      this.open.delete(open);
      // The idle window runs from the end of the last call: a call of twenty minutes is twenty minutes of use.
      entry.usedAt = Date.now();
    }
  }

  /**
   * One tool as this server last listed it, listing it first if this connection has not yet. Null for
   * a name the server does not have. What the gateway asks at call time, where it needs a tool's view
   * and its visibility but has only the name the agent sent.
   */
  async toolOf(id: string, name: string): Promise<McpLiveTool | null> {
    const listed = this.entries.get(id)?.tools;
    if (listed?.has(name)) return listed.get(name)!;
    return (await this.tools(id)).find((t) => t.name === name) ?? null;
  }

  /**
   * A `ui://` resource read for a view: `resources/read`, as the spec has a host fetch one, then held
   * for the rest of this connection (bounded by `UI_RESOURCE_TTL_MS`).
   *
   * Only an MCP App's own content type is accepted, as text or base64: anything else is not a view
   * and is refused with a reason rather than framed. There is no size cap: the HTML reaches the frame
   * over Realm's own loopback listener, which serves any length, and what bounds it is the JSON-RPC
   * message it arrived in — a string, so V8's longest (`buffer.constants.MAX_STRING_LENGTH`, ~512 MiB).
   * The resource's `_meta.ui` is the content item's, falling back to its `resources/list` entry —
   * both places a server may put its CSP, the item winning where both say something.
   *
   * A failed read does not count against the breaker. A view is a picture of a tool's result; a server
   * that mislabels one still answers its tools, and must not be cut off for it.
   */
  async uiResource(id: string, uri: string): Promise<McpUiResource> {
    if (!uri.startsWith("ui://")) throw new RpcError("MCP_NOT_A_VIEW", `mcp server ${id}: ${uri} is not a ui:// resource`);
    const { client, entry } = await this.ensureClient(id);
    const cached = entry.resources.get(uri);
    if (cached && Date.now() - cached.at < UI_RESOURCE_TTL_MS) return cached.resource;
    let contents: Array<Record<string, unknown>>;
    try { contents = (await client.readResource({ uri })).contents as Array<Record<string, unknown>>; }
    catch (err) { throw sanitize(id, err, entry.redact); }
    const item = contents.find((c) => c.uri === uri) ?? (contents.length === 1 ? contents[0] : undefined);
    if (!item) throw new RpcError("MCP_NOT_A_VIEW", `mcp server ${id}: ${uri} came back empty`);
    if (!isAppMime(item.mimeType)) throw new RpcError("MCP_NOT_A_VIEW", `mcp server ${id}: ${uri} is ${typeof item.mimeType === "string" ? item.mimeType : "untyped"}, not ${MCP_APP_MIME}`);
    const html = typeof item.text === "string" ? item.text : typeof item.blob === "string" ? Buffer.from(item.blob, "base64").toString("utf8") : null;
    if (html === null) throw new RpcError("MCP_NOT_A_VIEW", `mcp server ${id}: ${uri} carries no HTML`);
    const resource: McpUiResource = { html, ui: uiMetaOf(item._meta) ?? await this.listedUiMeta(client, uri) };
    entry.resources.set(uri, { at: Date.now(), resource });
    return resource;
  }

  /** The `_meta.ui` a resource's `resources/list` entry carries, for a content item that carried none.
   *  A server with no resources to list (the spec lets it leave view-only ones out) answers null. */
  private async listedUiMeta(client: Client, uri: string): Promise<Record<string, unknown> | null> {
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const { resources, nextCursor } = await client.listResources(cursor ? { cursor } : undefined);
        const hit = resources.find((r) => r.uri === uri);
        if (hit) return uiMetaOf(hit._meta);
        if (!nextCursor) return null;
        cursor = nextCursor;
      }
      return null;
    } catch { return null; }
  }

  /**
   * A server asking the user something in the middle of a call (MCP elicitation).
   *
   * The protocol does not say which call a question belongs to, and one client serves every session,
   * so the question goes to the session with a call open on this server — and only when there is
   * exactly one. Two sessions mid-call, or a call nobody owns, and Realm cannot tell whose question
   * it is: it declines rather than put it in front of the wrong person.
   */
  private async onElicit(id: string, params: ElicitRequest["params"], signal: AbortSignal): Promise<ElicitResult> {
    const calls = [...this.open].filter((c) => c.serverId === id);
    const sessions = new Set(calls.map((c) => c.sessionId));
    const [sessionId] = sessions;
    if (!this.d.elicit || sessions.size !== 1 || !sessionId) return { action: "decline" };
    try { return await this.d.elicit({ serverId: id, sessionId, params, signal }); }
    catch { return { action: "cancel" }; }
  }

  /**
   * Every stdio server running right now: the process Realm started for it, and when it was last
   * called (`resources/attribute.ts`). A remote server is a socket, not a process on this Mac, and is
   * not listed.
   */
  processes(): { serverId: string; pid: number; usedAt: number }[] {
    const out: { serverId: string; pid: number; usedAt: number }[] = [];
    for (const [id, e] of this.entries) {
      const pid = e.client ? (e.transport as { pid?: unknown } | null)?.pid : null;
      if (typeof pid === "number" && pid > 0) out.push({ serverId: id, pid, usedAt: e.usedAt });
    }
    return out;
  }

  /**
   * Stop every stdio server that has gone `idleMs` without a call, and say which. Its process goes;
   * its tool list stays (`tools` answers from it), and the next call starts it again — a few seconds a
   * session waits once, against a process held all day for nothing (mobile-mcp had been up 17 hours).
   * Never one with a call open, a connect under way, or a question to the user out; never a remote
   * server, which is a socket and holds no memory here.
   */
  sleepIdle(idleMs: number, now = Date.now()): string[] {
    const stopped: string[] = [];
    for (const [id, e] of this.entries) {
      if (!e.client || e.connecting || !e.tools) continue;
      if (typeof (e.transport as { pid?: unknown } | null)?.pid !== "number") continue;
      // One holding a browser or a device keeps it, unless someone chose otherwise.
      if (this.d.stopsWhenIdle?.(id) === false) continue;
      if ([...this.open].some((c) => c.serverId === id)) continue;
      if (now - e.usedAt < idleMs) continue;
      const client = e.client;
      e.client = null;
      e.asleep = true;
      void client.close().catch(() => {});
      stopped.push(id);
    }
    return stopped;
  }

  /** Closes the circuit and drops the client; the next `tools()`/`call()` reconnects from scratch. */
  async retry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearCooloff(entry);
    if (entry.client) { try { await entry.client.close(); } catch { /* best-effort; retry must never throw */ } }
    this.d.onStatus(id, "idle");
  }

  /**
   * A server row was edited or deleted: forget the client so nothing keeps serving through stale
   * transport config (a renamed command, a rotated key, a URL that no longer exists). Never throws — a
   * caller (settings save, row delete) that can't recover from an invalidate failure is worse than one
   * where a client lingers one extra tick before GC.
   */
  invalidate(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearCooloff(entry);
    if (entry.client) void entry.client.close().catch(() => {});
    this.d.onStatus(id, "idle");
  }

  /**
   * Server shutdown: best-effort close of every live client, never throws. Also awaits every in-flight
   * `connecting` promise rather than abandoning it — a connect racing shutdown must be reaped by its own
   * post-resolve check in `connect()` (see `closed`), not left to finish adopting a client after `close()`
   * has already returned and the process is on its way out.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.connecting) { try { await entry.connecting; } catch { /* superseded or already failed; nothing left to close once it settles */ } }
      if (entry.client) { try { await entry.client.close(); } catch { /* shutting down anyway */ } }
    }
    this.entries.clear();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { status: "idle", client: null, connecting: null, failures: 0, retryAt: 0, trips: 0, cooloff: null, tools: null, resources: new Map(), redact: [], transport: null, usedAt: Date.now(), asleep: false }; this.entries.set(id, e); }
    return e;
  }

  /**
   * Get-or-create the shared client for a row: an existing client is reused, an in-flight connect is
   * awaited (never restarted), a tripped circuit fails fast without touching the network until its
   * cool-off is over (then this call is the one that tries again), and a closed
   * hub refuses new work outright rather than starting a connect it will only have to reap.
   *
   * Returns the `Entry` alongside the `Client` — `tools()`/`call()` need it for `recordSuccess`/
   * `recordFailure`/`sanitize`, and re-deriving it themselves via a second `this.entry(id)` after their
   * own `await` would reopen a race: an `invalidate()` landing in that gap would find no entry, silently
   * create a fresh "zombie" one, and have this call's failure/success count against a row nothing else
   * is using anymore. Handing back the exact `Entry` this call resolved against closes that gap.
   */
  private async ensureClient(id: string): Promise<{ client: Client; entry: Entry }> {
    if (this.closed) throw supersededError(id);
    const entry = this.entry(id);
    if (entry.status === "circuit_open" && Date.now() < entry.retryAt) throw circuitOpenError(id, entry.retryAt);
    if (entry.client) return { client: entry.client, entry };
    if (!entry.connecting) {
      const row = this.d.servers.get(id);
      // The gateway only ever calls the hub with ids it read from the store a moment earlier, so a
      // missing row here means it was deleted in that window — treat it like any other connect failure.
      //
      // Checked HERE, before `entry.connecting` is ever assigned, not inside `connect()`. `connect()` is
      // async, so throwing synchronously from inside it (before its first `await`) still returns a
      // rejected promise to this call site — and the assignment `entry.connecting = this.connect(...)`
      // only happens AFTER that call returns. Any `entry.connecting = null` written from inside
      // `connect()` before the throw would therefore be overwritten by the rejected promise a moment
      // later, wedging the entry: every future call would see `entry.connecting` already set and replay
      // the same cached rejection forever, without ever reaching `recordFailure` again. Failing fast
      // right here, before there is any promise to assign, avoids the whole class of bug.
      if (!row) {
        this.recordFailure(id, entry);
        throw sanitize(id, new Error("server row not found"), entry.redact);
      }
      entry.connecting = this.connect(id, entry, row);
    }
    return { client: await entry.connecting, entry };
  }

  private newClient(id: string, entry: Entry): Client {
    // Elicitation, in both of MCP's modes, when there is somewhere to send it: a form becomes the
    // question card, a page to open becomes a card that names its host and opens on a click. And MCP
    // Apps, always: Realm frames a server's views, so a server that registers its UI tools only for
    // a host that says so (as the spec asks it to) registers them here.
    const client = new Client({ name: "realm-hub", version: "1.0.0" }, { capabilities: {
      ...(this.d.elicit ? { elicitation: { form: {}, url: {} } } : {}),
      extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } },
    } });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onToolsChanged(id));
    // A template the server changed, or a resource list that moved, is read again on the next view.
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => entry.resources.clear());
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { entry.resources.delete(n.params.uri); });
    if (this.d.elicit) client.setRequestHandler(ElicitRequestSchema, (request, extra) => this.onElicit(id, request.params, extra.signal));
    return client;
  }

  /** A live client the server has started answering 401: drop it, so the next call reconnects — and
   *  a reconnect is where `reauthorize` gets its chance to find a fresh credential. */
  private dropUnauthorized(entry: Entry, err: unknown): void {
    if (!isUnauthorized(err) || !entry.client) return;
    const c = entry.client; entry.client = null; void c.close().catch(() => {});
  }

  private async connect(id: string, entry: Entry, row: McpServerRow): Promise<Client> {
    try {
      let client = this.newClient(id, entry);
      try {
        await client.connect(await this.buildTransport(row, entry));
      } catch (err) {
        // A 401 may only mean the credential moved on (a CLI's token was refreshed): ask for it again,
        // and try once more if what is stored now is different. Once — a second 401 is the answer.
        if (!isUnauthorized(err) || !(await this.d.reauthorize?.(row))) throw err;
        await client.close().catch(() => {});
        client = this.newClient(id, entry);
        await client.connect(await this.buildTransport(this.d.servers.get(id) ?? row, entry));
      }
      // The handshake just resolved, but `invalidate()`/`retry()`/`close()` may have raced it — this
      // entry may no longer be the hub's live state for `id`, or the hub may be shutting down entirely.
      // Either way the client has no owner: adopting it would leak exactly the dangling child
      // process/socket the reviewer reproduced, so close it here instead of storing it.
      if (this.closed || this.entries.get(id) !== entry) {
        await client.close().catch(() => {});
        throw supersededError(id);
      }
      entry.client = client;
      entry.connecting = null;
      entry.usedAt = Date.now();
      entry.asleep = false;
      // A server that exits (a crash, a stdio server quitting when idle) leaves a client that can only
      // answer "Not connected": let go of it, so the next call connects again.
      client.onclose = () => { if (entry.client === client) entry.client = null; };
      this.recordSuccess(id, entry);
      return client;
    } catch (err) {
      entry.connecting = null;
      // A superseded connect is Realm changing its mind mid-handshake, not the server failing — it must
      // not trip the breaker or have its message rewritten into an upstream-failure error.
      if (err instanceof RpcError && err.code === "MCP_SUPERSEDED") throw err;
      this.recordFailure(id, entry);
      throw sanitize(id, err, entry.redact);
    }
  }

  private async buildTransport(row: McpServerRow, entry: Entry): Promise<Transport> {
    if (row.transport === "stdio") {
      // Captured before `makeTransport`/`StdioClientTransport` run, so a failure in either still has
      // something to redact against in `connect()`'s catch — see `Entry.redact`'s doc comment.
      entry.redact = credentialValues(Object.values(row.secrets));
      const transport = (await this.d.makeTransport?.(row, {})) ?? new StdioClientTransport({ command: row.command, args: row.args, env: row.secrets });
      entry.transport = transport;
      return transport;
    }
    // Captured from `row.secrets` alone BEFORE `authHeaders` runs, same reasoning as the stdio branch
    // above: `authHeaders` (the OAuth seam) can itself reject — a network error hitting the token
    // refresh endpoint, say — and if that rejection's message happens to echo a row secret (a header
    // value quoted back in a provider error), `sanitize()` below needs something to redact against.
    // Without this line, a mid-`await` throw here left `entry.redact` at its previous (possibly empty)
    // value and the row's secrets sailed through unredacted.
    entry.redact = credentialValues(Object.values(row.secrets));
    // OAuth (W5) is merged in last so a completed connection overrides a leftover header of the same
    // name from before the server was switched to OAuth (mirrors `authKind`'s "oauth beats secrets").
    const headers = { ...row.secrets, ...(await this.d.authHeaders(row)) };
    // `credentialValues`, not `Object.values`: an OAuth header is `"Bearer <token>"`, and an upstream
    // error is just as likely to quote the BARE token back as the whole header value. Storing only the
    // full string matched neither form of the bare quote — see `redact.ts` for the leak that caused.
    entry.redact = credentialValues(Object.values(headers));
    if (this.d.makeTransport) return this.d.makeTransport(row, headers);
    return row.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(row.url), { requestInit: { headers } })
      : new SSEClientTransport(new URL(row.url), { requestInit: { headers } });
  }

  /**
   * `notifications/tools/list_changed`: re-list, re-cache, and re-emit `onStatus(id, "connected")`.
   * Unlike `recordSuccess` below, this emits even when the status was already `"connected"` — the
   * event doubles as the gateway's (W3) only signal that the cached tool list just changed, so
   * de-duplicating it here would silently drop that signal on the common case of an already-healthy
   * server relisting its tools.
   *
   * Best-effort: a failed background refresh does not touch the breaker. The server may genuinely be
   * fine and just noisy; the next explicit `tools()`/`call()` will hit the same failure through the
   * normal path if it is not.
   */
  private onToolsChanged(id: string): void {
    void (async () => {
      const entry = this.entries.get(id);
      if (!entry?.client) return;
      try {
        const { tools } = await entry.client.listTools();
        this.cacheTools(id, tools);
        entry.tools = new Map(tools.map(liveTool).map((t) => [t.name, t]));
        entry.failures = 0;
        entry.status = "connected";
        this.d.onStatus(id, "connected");
      } catch { /* see doc comment above: swallowed, not counted against the breaker */ }
    })();
  }

  private cacheTools(id: string, tools: Tool[]): void {
    const cached = tools.map(cachedTool);
    this.d.servers.setTools(id, cached);
    this.d.onTools?.(id, cached);
  }

  private recordSuccess(id: string, entry: Entry): void {
    entry.failures = 0;
    entry.trips = 0;
    clearCooloff(entry);
    if (entry.status !== "connected") { entry.status = "connected"; this.d.onStatus(id, "connected"); }
  }

  private recordFailure(id: string, entry: Entry): void {
    entry.failures += 1;
    if (entry.failures >= CIRCUIT_THRESHOLD) {
      if (entry.client) { const c = entry.client; entry.client = null; void c.close().catch(() => {}); }
      // Open, or open again after a try that failed: wait, then try once more without waiting for a
      // caller. A session whose tool list was read while the circuit was open has no tool of this
      // server's to call, so nothing else would ever try it; a success re-lists for every session.
      const wait = Math.min(CIRCUIT_COOLOFF_MS * 2 ** entry.trips, CIRCUIT_COOLOFF_MAX_MS);
      entry.trips += 1;
      entry.retryAt = Date.now() + wait;
      clearCooloff(entry);
      entry.cooloff = setTimeout(() => {
        entry.cooloff = null;
        if (this.closed || this.entries.get(id) !== entry) return;
        void this.tools(id).catch(() => {});
      }, wait);
      entry.cooloff.unref?.();
      entry.status = "circuit_open";
      this.d.onStatus(id, "circuit_open");
    } else {
      entry.status = "error";
      this.d.onStatus(id, "error");
    }
  }
}

/** A listed tool as the persisted cache keeps it: name, description, and whether it has a view. */
function cachedTool(t: Tool): McpToolRow {
  const ui = toolUiOf(t._meta);
  return { name: t.name, description: t.description ?? "",
    ...(ui?.resourceUri ? { view: ui.resourceUri } : {}),
    ...(ui && !ui.visibility.includes("model") ? { appOnly: true } : {}) };
}

/** A listed tool as a live caller sees it — see `McpLiveTool`. */
function liveTool(t: Tool): McpLiveTool {
  return { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, ui: toolUiOf(t._meta), def: t };
}

/** `text/html;profile=mcp-app`, compared as a media type: case and the spacing around `;` vary. */
function isAppMime(mime: unknown): boolean {
  return typeof mime === "string" && mime.toLowerCase().replace(/\s+/g, "") === MCP_APP_MIME;
}

/** `_meta.ui` when it is an object, else null. */
function uiMetaOf(meta: unknown): Record<string, unknown> | null {
  const ui = meta && typeof meta === "object" ? (meta as Record<string, unknown>).ui : undefined;
  return ui && typeof ui === "object" && !Array.isArray(ui) ? ui as Record<string, unknown> : null;
}

/**
 * Wraps an upstream failure as a structured error: `err.message`, with every value in `redact` scrubbed
 * to `[redacted]` under `redact.ts`'s shared rules (including its length floor).
 *
 * Not just defensive: never *constructing* a message from a secret isn't enough, because a transport
 * error can legitimately echo part of a failed request back (`Error POSTing to endpoint: ${responseBody}`,
 * a 401 body quoting the bearer token it rejected), and a "bad credential" response body is exactly the
 * kind of body that contains the credential. `redact` is `Entry.redact` — row secrets AND, for http/sse,
 * whatever `authHeaders` (the OAuth seam) merged in — captured at transport-build time rather than
 * re-read from the row here, so a row deleted between the failure and this call doesn't silently skip
 * redaction (a fresh `servers.get(id)` at throw time can come back `null`; `Entry.redact` can't).
 */
function sanitize(id: string, err: unknown, redact: string[]): RpcError {
  const raw = err instanceof Error ? err.message : String(err);
  return new RpcError("MCP_UPSTREAM_ERROR", `mcp server ${id}: ${redactValues(raw, redact)}`);
}

/** Says when Realm tries again, and names `mcp.retry` for trying now, so a caller that only surfaces
 *  `.message` (a tool-call error handed back to an agent, say) still tells the human what happens. */
function circuitOpenError(id: string, retryAt: number): RpcError {
  const secs = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return new RpcError("MCP_CIRCUIT_OPEN", `mcp server ${id} is unavailable after repeated failures — Realm tries it again in ${secs}s, or retry from settings now (mcp.retry)`);
}

function clearCooloff(entry: Entry): void {
  if (entry.cooloff) clearTimeout(entry.cooloff);
  entry.cooloff = null;
}

/** A 401 from the server: the SDK's own `UnauthorizedError`, or a transport error carrying the status
 *  (streamable HTTP and SSE both put it on `code` when no auth provider is attached, as here). */
function isUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedError || (err instanceof Error && (err as { code?: unknown }).code === 401);
}

/** A connect that lost the race to `invalidate()`/`retry()`/`close()` — see `connect()`'s post-resolve
 *  check. Its own code so callers (and `connect()`'s own catch) can tell it apart from a real failure. */
function supersededError(id: string): RpcError {
  return new RpcError("MCP_SUPERSEDED", `mcp server ${id}: connection attempt superseded by a config change or shutdown`);
}
