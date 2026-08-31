import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerStatus } from "@realm/contracts";
import { RpcError } from "../store/rows";
import type { McpServerRow, McpServersStore, McpToolRow } from "../store/mcp";

/** The hub's live connection state for one server row — the same enum `mcp.serverStatus` puts on the
 *  wire (`McpServerStatusSchema`), so the gateway/UI never need a second vocabulary for it. */
type UpstreamStatus = McpServerStatus;

/** Consecutive failures (a failed connect, `tools/list`, or `tools/call` — including a `tools/call`
 *  result that comes back `isError: true`, which MCP returns as a normal result, not a rejection) that
 *  trip the breaker. Any success, of any kind, resets the count to zero. */
const CIRCUIT_THRESHOLD = 3;

type Entry = {
  status: UpstreamStatus;
  client: Client | null;
  /** Set while a connect is in flight, so two concurrent `tools()`/`call()` on the same row await one
   *  connection attempt instead of racing two SDK `Client`s onto the same process or socket. */
  connecting: Promise<Client> | null;
  failures: number;
};

/**
 * The only code in Realm that speaks MCP to a third-party server. One SDK `Client` per server row,
 * shared across every session and space (single-user app; per-row credentials are what actually scopes
 * access, not a client-per-caller split) — created lazily on first `tools()`/`call()`, never at
 * construction.
 *
 * `authHeaders` is the OAuth seam: W2's caller passes `async () => ({})`; W5 wires `McpOauth.headers`
 * in without this file changing.
 */
export class McpHub {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly d: {
    servers: McpServersStore;
    onStatus: (id: string, status: UpstreamStatus) => void;
    authHeaders: (row: McpServerRow) => Promise<Record<string, string>>;
    /** Test-only seam: replaces real stdio/http/sse transport construction with whatever a test wants a
     *  row to connect through (an `InMemoryTransport`, typically — `stub-server.ts`'s `connectInMemory`
     *  is async, hence the `Promise` option, so a test factory can just forward it). Sharing, caching,
     *  and the circuit breaker below still run for real — this swaps out only the wire, never the hub's
     *  own logic. */
    makeTransport?: (row: McpServerRow, headers: Record<string, string>) => Transport | Promise<Transport>;
  }) {}

  /**
   * Lazily connects, lists tools, and caches them on the row (name + description only — see
   * `McpToolRow`'s doc comment for why no input schema rides along).
   *
   * Throws on failure rather than returning `[]`: this layer reports what happened and lets the caller
   * decide. W3's gateway treats a thrown/failed `tools()` as "this server contributes no tools right
   * now" without erroring the whole `tools/list` response.
   */
  async tools(id: string): Promise<McpToolRow[]> {
    const client = await this.ensureClient(id);
    const entry = this.entry(id);
    try {
      const { tools } = await client.listTools();
      const rows = tools.map((t): McpToolRow => ({ name: t.name, description: t.description ?? "" }));
      this.d.servers.setTools(id, rows);
      this.recordSuccess(id, entry);
      return rows;
    } catch (err) {
      this.recordFailure(id, entry);
      throw sanitize(id, err);
    }
  }

  /** Forwards a call verbatim — no argument validation against the cached tool list, which can go
   *  stale the moment an upstream server changes its schema (see `McpToolSchema`'s own doc comment for
   *  why the cache carries no input schema to validate against in the first place). */
  async call(id: string, tool: string, args: unknown): Promise<CallToolResult> {
    const client = await this.ensureClient(id);
    const entry = this.entry(id);
    try {
      const result = (await client.callTool({ name: tool, arguments: args as Record<string, unknown> | undefined })) as CallToolResult;
      // A tool error is a normal MCP result (`isError: true`), not a thrown error — the breaker has to
      // look inside the result, or a tool that always fails "cleanly" would never trip it.
      if (result.isError) this.recordFailure(id, entry); else this.recordSuccess(id, entry);
      return result;
    } catch (err) {
      this.recordFailure(id, entry);
      throw sanitize(id, err);
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

  /** Server shutdown: best-effort close of every live client, never throws. */
  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.client) { try { await entry.client.close(); } catch { /* shutting down anyway */ } }
    }
    this.entries.clear();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) { e = { status: "idle", client: null, connecting: null, failures: 0 }; this.entries.set(id, e); }
    return e;
  }

  /** Get-or-create the shared client for a row: an existing client is reused, an in-flight connect is
   *  awaited (never restarted), and a tripped circuit fails fast without touching the network. */
  private async ensureClient(id: string): Promise<Client> {
    const entry = this.entry(id);
    if (entry.status === "circuit_open") throw circuitOpenError(id);
    if (entry.client) return entry.client;
    if (!entry.connecting) entry.connecting = this.connect(id, entry);
    return entry.connecting;
  }

  private async connect(id: string, entry: Entry): Promise<Client> {
    try {
      const row = this.d.servers.get(id);
      // The gateway only ever calls the hub with ids it read from the store a moment earlier, so a
      // missing row here means it was deleted in that window — treat it like any other connect failure
      // rather than a distinct case the caller has to special-case.
      if (!row) throw new Error(`mcp server ${id} not found`);
      const client = new Client({ name: "realm-hub", version: "1.0.0" });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onToolsChanged(id));
      await client.connect(await this.buildTransport(row));
      entry.client = client;
      entry.connecting = null;
      this.recordSuccess(id, entry);
      return client;
    } catch (err) {
      entry.connecting = null;
      this.recordFailure(id, entry);
      throw sanitize(id, err);
    }
  }

  private async buildTransport(row: McpServerRow): Promise<Transport> {
    if (row.transport === "stdio") {
      return (await this.d.makeTransport?.(row, {})) ?? new StdioClientTransport({ command: row.command, args: row.args, env: row.secrets });
    }
    // OAuth (W5) is merged in last so a completed connection overrides a leftover header of the same
    // name from before the server was switched to OAuth (mirrors `authKind`'s "oauth beats secrets").
    const headers = { ...row.secrets, ...(await this.d.authHeaders(row)) };
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

/** Wraps an upstream failure as a structured, sanitized error — `err.message` only, and never anything
 *  built from `row.secrets`/`oauthJson`, which is the whole discipline this function exists to enforce
 *  in one place rather than at every throw site. */
function sanitize(id: string, err: unknown): RpcError {
  const message = err instanceof Error ? err.message : String(err);
  return new RpcError("MCP_UPSTREAM_ERROR", `mcp server ${id}: ${message}`);
}

/** Names `mcp.retry` in the message itself, per the plan's error-handling table, so a caller that only
 *  surfaces `.message` (a tool-call error handed back to an agent, say) still tells the human what to
 *  do about it. */
function circuitOpenError(id: string): RpcError {
  return new RpcError("MCP_CIRCUIT_OPEN", `mcp server ${id} is unavailable after repeated failures — retry from settings (mcp.retry)`);
}
