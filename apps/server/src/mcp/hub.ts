import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerStatus } from "@realm/contracts";
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
export type McpLiveTool = { name: string; description: string; inputSchema: Tool["inputSchema"] };

/** Consecutive THROWN failures — a rejected connect, `tools/list`, or `tools/call` — that trip the
 *  breaker. Deliberately not `isError: true` results: that is a normal, successfully round-tripped MCP
 *  response where the *tool* reported a problem (bad arguments, a lint finding, ...), not the connection.
 *  Three of those from one confused agent must not circuit-open a server that is working fine. Any
 *  success, of any kind, resets the count to zero. */
const CIRCUIT_THRESHOLD = 3;

type Entry = {
  status: UpstreamStatus;
  client: Client | null;
  /** Set while a connect is in flight, so two concurrent `tools()`/`call()` on the same row await one
   *  connection attempt instead of racing two SDK `Client`s onto the same process or socket. */
  connecting: Promise<Client> | null;
  failures: number;
  /** Every credential VALUE (`row.secrets`, and for http/sse the merged `authHeaders` result too)
   *  that went into the most recent transport attempt for this row, expanded by `credentialValues` so a
   *  scheme-prefixed header contributes BOTH `"Bearer <token>"` and the bare `<token>` — an upstream
   *  error quotes one or the other, never reliably the form the header happened to be stored in.
   *  Captured by `buildTransport` before it does anything that can throw, and read by `sanitize()`
   *  instead of re-fetching the row at throw time, which would silently skip redaction if the row was
   *  deleted in between. Overwritten (not accumulated) on every attempt; a fresh `Entry` after
   *  `invalidate()`/`retry()` starts empty. */
  redact: string[];
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
  /** Set once by `close()`. A connect that resolves after this flips (it started before shutdown, the
   *  handshake just took a while) must be reaped, not adopted — see `connect()`'s post-resolve check. */
  private closed = false;

  constructor(private readonly d: {
    servers: McpServersStore;
    onStatus: (id: string, status: UpstreamStatus) => void;
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
    /** Test-only seam: replaces real stdio/http/sse transport construction with whatever a test wants a
     *  row to connect through (an `InMemoryTransport`, typically — `stub-server.ts`'s `connectInMemory`
     *  is async, hence the `Promise` option, so a test factory can just forward it). Sharing, caching,
     *  and the circuit breaker below still run for real — this swaps out only the wire, never the hub's
     *  own logic. */
    makeTransport?: (row: McpServerRow, headers: Record<string, string>) => Transport | Promise<Transport>;
  }) {}

  /**
   * Lazily connects and lists tools. The persisted CACHE (`servers.setTools`) keeps name + description
   * only — see `McpToolRow`'s doc comment for why a schema does not belong in something that can go
   * stale between connections. The value THIS method returns is not the cache: it is fresh off the very
   * `listTools()` call that produced it, so it carries the real `inputSchema` too (see `McpLiveTool`) —
   * the gateway forwards it verbatim to the agent's own MCP client.
   *
   * Throws on failure rather than returning `[]`: this layer reports what happened and lets the caller
   * decide. W3's gateway treats a thrown/failed `tools()` as "this server contributes no tools right
   * now" without erroring the whole `tools/list` response.
   */
  async tools(id: string): Promise<McpLiveTool[]> {
    const { client, entry } = await this.ensureClient(id);
    try {
      const { tools } = await client.listTools();
      // Cache write: name + description ONLY. Deliberately a separate projection from the return value
      // below, not a `.map(t => ({ name, description }))` derived from it, so it stays obviously correct
      // even if `McpLiveTool` grows another field later.
      this.d.servers.setTools(id, tools.map((t): McpToolRow => ({ name: t.name, description: t.description ?? "" })));
      this.recordSuccess(id, entry);
      return tools.map((t): McpLiveTool => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
    } catch (err) {
      this.recordFailure(id, entry);
      throw sanitize(id, err, entry.redact);
    }
  }

  /** Forwards a call verbatim — no argument validation against the cached tool list, which can go
   *  stale the moment an upstream server changes its schema (see `McpToolSchema`'s own doc comment for
   *  why the cache carries no input schema to validate against in the first place). */
  async call(id: string, tool: string, args: unknown): Promise<CallToolResult> {
    const { client, entry } = await this.ensureClient(id);
    try {
      const result = (await client.callTool({ name: tool, arguments: args as Record<string, unknown> | undefined })) as CallToolResult;
      // `isError: true` is a normal, successfully round-tripped MCP result (the tool ran and reported a
      // problem) — it counts as a working connection, same as any other resolved call. Only a REJECTED
      // `callTool()` (transport/protocol failure, not a tool-level error) reaches the catch below and
      // counts against the breaker; see `CIRCUIT_THRESHOLD`'s doc comment for why that split matters.
      this.recordSuccess(id, entry);
      return result;
    } catch (err) {
      this.recordFailure(id, entry);
      throw sanitize(id, err, entry.redact);
    }
  }

  /** Closes the circuit and drops the client; the next `tools()`/`call()` reconnects from scratch. */
  async retry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
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
    if (!e) { e = { status: "idle", client: null, connecting: null, failures: 0, redact: [] }; this.entries.set(id, e); }
    return e;
  }

  /**
   * Get-or-create the shared client for a row: an existing client is reused, an in-flight connect is
   * awaited (never restarted), a tripped circuit fails fast without touching the network, and a closed
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
    if (entry.status === "circuit_open") throw circuitOpenError(id);
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

  private async connect(id: string, entry: Entry, row: McpServerRow): Promise<Client> {
    try {
      const client = new Client({ name: "realm-hub", version: "1.0.0" });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onToolsChanged(id));
      await client.connect(await this.buildTransport(row, entry));
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
      return (await this.d.makeTransport?.(row, {})) ?? new StdioClientTransport({ command: row.command, args: row.args, env: row.secrets });
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
        this.d.servers.setTools(id, tools.map((t): McpToolRow => ({ name: t.name, description: t.description ?? "" })));
        entry.failures = 0;
        entry.status = "connected";
        this.d.onStatus(id, "connected");
      } catch { /* see doc comment above: swallowed, not counted against the breaker */ }
    })();
  }

  private recordSuccess(id: string, entry: Entry): void {
    entry.failures = 0;
    if (entry.status !== "connected") { entry.status = "connected"; this.d.onStatus(id, "connected"); }
  }

  private recordFailure(id: string, entry: Entry): void {
    entry.failures += 1;
    if (entry.failures >= CIRCUIT_THRESHOLD) {
      if (entry.client) { const c = entry.client; entry.client = null; void c.close().catch(() => {}); }
      entry.status = "circuit_open";
      this.d.onStatus(id, "circuit_open");
    } else {
      entry.status = "error";
      this.d.onStatus(id, "error");
    }
  }
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

/** Names `mcp.retry` in the message itself, per the plan's error-handling table, so a caller that only
 *  surfaces `.message` (a tool-call error handed back to an agent, say) still tells the human what to
 *  do about it. */
function circuitOpenError(id: string): RpcError {
  return new RpcError("MCP_CIRCUIT_OPEN", `mcp server ${id} is unavailable after repeated failures — retry from settings (mcp.retry)`);
}

/** A connect that lost the race to `invalidate()`/`retry()`/`close()` — see `connect()`'s post-resolve
 *  check. Its own code so callers (and `connect()`'s own catch) can tell it apart from a real failure. */
function supersededError(id: string): RpcError {
  return new RpcError("MCP_SUPERSEDED", `mcp server ${id}: connection attempt superseded by a config change or shutdown`);
}
