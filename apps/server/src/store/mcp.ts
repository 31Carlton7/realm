import type { Db } from "../db/database";
import { newId, type McpTransport } from "@realm/contracts";
import { NotFoundError, RpcError, now } from "./rows";

/**
 * A stored MCP server definition — **including its secret values**.
 *
 * This type never leaves the server. `McpService` projects it down to the `McpServer` contract (key
 * names only) for anything a client can see, and hands the whole row to an adapter only as part of a
 * session's `StartOptions`.
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
  createdAt: number;
  updatedAt: number;
};

type Row = { id: string; name: string; transport: string; command: string; args_json: string; url: string; secrets_json: string; created_at: number; updated_at: number };

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

const toServer = (r: Row): McpServerRow => ({
  id: r.id, name: r.name, transport: r.transport as McpTransport, command: r.command,
  args: parseArgs(r.args_json), url: r.url, secrets: parseSecrets(r.secrets_json),
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

  create(input: McpServerInput): McpServerRow {
    const id = newId(); const t = now();
    this.guardName(input.name, null);
    this.db.prepare("INSERT INTO mcp_servers (id, name, transport, command, args_json, url, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.transport, input.command, JSON.stringify(input.args), input.url, JSON.stringify(input.secrets), t, t);
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

  /** The UNIQUE index would catch this too, as a SQLite error with no `code` a client could act on. */
  private guardName(name: string, exceptId: string | null): void {
    const clash = this.db.prepare("SELECT id FROM mcp_servers WHERE name = ?").get(name) as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new RpcError("MCP_NAME_TAKEN", `an MCP server named "${name}" already exists`);
  }
}
