import type { Db } from "../db/database";
import { newId, type ItemScope, type McpTransport } from "@realm/contracts";
import { NotFoundError, RpcError, now } from "./rows";

/** One cached entry from an upstream server's `tools/list` — enough for settings to render a tool list
 *  without a live connection. No input schema, deliberately: a STORED schema can go stale the moment an
 *  upstream server changes it between hub connections, and nothing that reads this cache (a settings
 *  screen listing tool names) ever constructs a tool call from it. This is a cache-staleness concern
 *  ONLY — `McpHub.tools()` returns the real, live `inputSchema` (see its own `McpLiveTool` type) to the
 *  gateway, which forwards it verbatim to an agent's MCP client so it can build valid call arguments.
 *  The hub still never validates a `call()`'s args against any schema, cached or live — see `call()`'s
 *  own doc comment. */
export type McpToolRow = { name: string; description: string };

/**
 * A stored MCP server definition — **including its secret values**.
 *
 * This type never leaves the server. `McpService` projects it down to the `McpServer` contract (key
 * names only) for anything a client can see; since the gateway (Plan 9 W3) the row's secrets travel
 * only into the hub's transport construction — no row, whole or partial, ever reaches an adapter.
 */
export type McpServerRow = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  /** stdio `env` or http/sse `headers`, plaintext. See MCP_SECRET_STORAGE_NOTE. */
  secrets: Record<string, string>;
  /** Client registration, tokens and expiry for a remote server, plaintext, `""` until OAuth has run
   *  once. Same honesty posture as `secrets` — see MCP_SECRET_STORAGE_NOTE. Never a contract field. */
  oauthJson: string;
  /** The last successful `tools/list`, cached so settings can render it without connecting. */
  tools: McpToolRow[];
  /** Where this server is defined (Plan 12 W2) — see the v11 migration comment and `ItemScope`. */
  scope: ItemScope;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string; name: string; transport: string; command: string; args_json: string; url: string;
  secrets_json: string; oauth_json: string; tools_json: string;
  scope: string; scope_space_id: string | null; scope_profile_id: string | null;
  created_at: number; updated_at: number;
};

/** Columns → `ItemScope`. A 'profile' row whose profile was deleted (scope_profile_id NULL — see the
 *  v11 ON DELETE SET NULL comment) degrades to the pre-scoping space scope: still listed everywhere,
 *  opt-in per space, rather than a row that exists but can never appear anywhere. */
const parseScope = (r: Row): ItemScope =>
  r.scope === "profile" && r.scope_profile_id !== null
    ? { kind: "profile", profileId: r.scope_profile_id }
    : { kind: "space", spaceId: r.scope === "profile" ? null : r.scope_space_id };

/** Both JSON columns are Realm's own writes, so a parse failure is corruption, not input — degrade to
 *  empty rather than making the whole list unreadable because one row went bad. */
const parseArgs = (s: string): string[] => {
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};
const parseSecrets = (s: string): Record<string, string> => {
  try {
    const v: unknown = JSON.parse(s);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  } catch { return {}; }
};
/** Same corruption-degrades-to-empty idiom as `parseArgs`/`parseSecrets`: a bad `tools_json` costs the
 *  row its cached tool list, not the whole `mcp.list` call. */
const parseTools = (s: string): McpToolRow[] => {
  try {
    const v: unknown = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is McpToolRow => !!x && typeof x === "object" && typeof (x as McpToolRow).name === "string" && typeof (x as McpToolRow).description === "string");
  } catch { return []; }
};

const toServer = (r: Row): McpServerRow => ({
  id: r.id, name: r.name, transport: r.transport as McpTransport, command: r.command,
  args: parseArgs(r.args_json), url: r.url, secrets: parseSecrets(r.secrets_json),
  oauthJson: r.oauth_json, tools: parseTools(r.tools_json),
  scope: parseScope(r),
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export type McpServerInput = { name: string; transport: McpTransport; command: string; args: string[]; url: string; secrets: Record<string, string> };

export class McpServersStore {
  constructor(private db: Db) {}

  /**
   * Every server, oldest first — the order a settings list shows them in and the order they reach an
   * agent. `name` breaks ties rather than `id`: two servers added in the same millisecond have ULIDs
   * whose random suffixes order arbitrarily, so an id tiebreak makes the list flicker between calls.
   */
  list(): McpServerRow[] {
    return (this.db.prepare("SELECT * FROM mcp_servers ORDER BY created_at, name").all() as Row[]).map(toServer);
  }
  get(id: string): McpServerRow | null {
    const r = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as Row | undefined;
    return r ? toServer(r) : null;
  }

  /** `scope` defaults to the pre-scoping space scope (spaceId null) — `McpService.add` passes the real
   *  defining scope; older callers and tests get exactly the pre-W2 row. */
  create(input: McpServerInput, scope: ItemScope = { kind: "space", spaceId: null }): McpServerRow {
    const id = newId(); const t = now();
    this.guardName(input.name, null);
    this.db.prepare(`INSERT INTO mcp_servers (id, name, transport, command, args_json, url, secrets_json, scope, scope_space_id, scope_profile_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.transport, input.command, JSON.stringify(input.args), input.url, JSON.stringify(input.secrets),
        scope.kind, scope.kind === "space" ? scope.spaceId : null, scope.kind === "profile" ? scope.profileId : null, t, t);
    return this.get(id)!;
  }

  /**
   * Move the row's defining scope (promote/demote). Deliberately NOT part of `update()`: a scope move
   * is a different user action from an edit (it changes which spaces see the server, not what the
   * server is), and `update()`'s carry-forward semantics must never be able to move a scope as a side
   * effect of a rename.
   */
  setScope(id: string, scope: ItemScope): McpServerRow {
    if (!this.get(id)) throw new NotFoundError("mcp server", id);
    this.db.prepare("UPDATE mcp_servers SET scope = ?, scope_space_id = ?, scope_profile_id = ?, updated_at = ? WHERE id = ?")
      .run(scope.kind, scope.kind === "space" ? scope.spaceId : null, scope.kind === "profile" ? scope.profileId : null, now(), id);
    return this.get(id)!;
  }

  update(id: string, patch: Partial<McpServerInput>): McpServerRow {
    const existing = this.get(id); if (!existing) throw new NotFoundError("mcp server", id);
    if (patch.name !== undefined) this.guardName(patch.name, id);
    const next = { ...existing, ...patch };
    this.db.prepare("UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args_json = ?, url = ?, secrets_json = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.transport, next.command, JSON.stringify(next.args), next.url, JSON.stringify(next.secrets), now(), id);
    return this.get(id)!;
  }

  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("mcp server", id);
    this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  }

  /**
   * Cache the hub's last successful `tools/list`, or clear it. Deliberately not routed through
   * `update()`: this is a connection-derived cache write, not a user edit, so it must not run the name
   * guard and must not be diffable from an edit in any log that later distinguishes the two.
   */
  setTools(id: string, tools: McpToolRow[]): void {
    if (!this.get(id)) throw new NotFoundError("mcp server", id);
    this.db.prepare("UPDATE mcp_servers SET tools_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tools), now(), id);
  }

  /** Persist the OAuth state (client registration, tokens, expiry) as an opaque JSON blob — the hub/
   *  oauth module (W5) owns its shape. Same non-`update()` reasoning as `setTools`. */
  setOauth(id: string, json: string): void {
    if (!this.get(id)) throw new NotFoundError("mcp server", id);
    this.db.prepare("UPDATE mcp_servers SET oauth_json = ?, updated_at = ? WHERE id = ?").run(json, now(), id);
  }

  /** The UNIQUE index would catch this too, as a SQLite error with no `code` a client could act on. */
  private guardName(name: string, exceptId: string | null): void {
    const clash = this.db.prepare("SELECT id FROM mcp_servers WHERE name = ?").get(name) as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new RpcError("MCP_NAME_TAKEN", `an MCP server named "${name}" already exists`);
  }
}

export type McpCallLogRow = {
  id: string;
  sessionId: string;
  /** Null once the server row that produced this call has been deleted — the log outlives the config. */
  serverId: string | null;
  serverName: string;
  tool: string;
  argsJson: string;
  resultSummary: string;
  ok: boolean;
  durationMs: number;
  ts: number;
};

type LogRow = {
  id: string; session_id: string; server_id: string | null; server_name: string; tool: string;
  args_json: string; result_summary: string; ok: number; duration_ms: number; ts: number;
};

const toCall = (r: LogRow): McpCallLogRow => ({
  id: r.id, sessionId: r.session_id, serverId: r.server_id, serverName: r.server_name, tool: r.tool,
  argsJson: r.args_json, resultSummary: r.result_summary, ok: r.ok === 1, durationMs: r.duration_ms, ts: r.ts,
});

const CALL_LOG_DEFAULT_LIMIT = 50;
const CALL_LOG_MAX_LIMIT = 200;

/**
 * Realm's own view of every proxied MCP tool call (Activity) — separate from the transcript, which
 * carries the agent's own view of the same call (see the v9 migration comment). Append-only: nothing
 * here is ever edited, only listed.
 */
export class McpCallLogStore {
  constructor(private db: Db) {}

  /** Insert one completed call and return the full row — the caller supplies everything but `id`/`ts`,
   *  which are the store's to generate, same as every other `create`. */
  append(row: Omit<McpCallLogRow, "id" | "ts">): McpCallLogRow {
    const id = newId(); const ts = now();
    this.db.prepare(`INSERT INTO mcp_call_log
      (id, session_id, server_id, server_name, tool, args_json, result_summary, ok, duration_ms, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, row.sessionId, row.serverId, row.serverName, row.tool, row.argsJson, row.resultSummary, row.ok ? 1 : 0, row.durationMs, ts);
    return toCall(this.db.prepare("SELECT * FROM mcp_call_log WHERE id = ?").get(id) as LogRow);
  }

  /**
   * Newest first. `before` pages backward through the log by a composite `{ ts, id }` cursor rather than
   * a plain `ts <` filter — a plain ts cursor drops every OTHER row sharing the boundary millisecond (W1
   * review; the same-ms tie-break test below proves the case is real: three rows can share one `ts`, and
   * a naive `ts < boundary` would skip straight past all of them instead of resuming mid-tie). The filter
   * `(ts < ? OR (ts = ? AND id < ?))`, ordered `ts DESC, id DESC`, resumes exactly after the last row the
   * caller saw. `id` is what breaks the tie, NOT because it reflects insertion order (see line 77:
   * `newId()` is the plain, non-monotonic `ulid()` — two ids minted in the same millisecond have no
   * guaranteed relative order) but because any total order that agrees between the `WHERE` filter and the
   * `ORDER BY` is enough to page through a tied boundary without skipping or repeating a row; `id DESC` is
   * simply an arbitrary, STABLE order (unique per row, always comparable) that both clauses share.
   *
   * `limit` is clamped to [1, CALL_LOG_MAX_LIMIT] so a client cannot ask for the whole table in one call.
   */
  list(filter: { sessionId?: string; serverId?: string; before?: { ts: number; id: string }; limit?: number } = {}): McpCallLogRow[] {
    const limit = Math.max(1, Math.min(filter.limit ?? CALL_LOG_DEFAULT_LIMIT, CALL_LOG_MAX_LIMIT));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sessionId !== undefined) { clauses.push("session_id = ?"); params.push(filter.sessionId); }
    if (filter.serverId !== undefined) { clauses.push("server_id = ?"); params.push(filter.serverId); }
    if (filter.before !== undefined) { clauses.push("(ts < ? OR (ts = ? AND id < ?))"); params.push(filter.before.ts, filter.before.ts, filter.before.id); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM mcp_call_log ${where} ORDER BY ts DESC, id DESC LIMIT ?`).all(...params, limit);
    return (rows as LogRow[]).map(toCall);
  }
}
