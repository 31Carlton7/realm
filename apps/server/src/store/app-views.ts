import type { Db } from "../db/database";
import { now } from "./rows";

/**
 * One view an MCP server drew for a tool call (MCP Apps, migration v39): the call as it was made and
 * answered, kept so the view can be opened again from the transcript after a relaunch.
 *
 * `tool` is the server's own definition of the tool, `input` its arguments and `result` the server's
 * whole `CallToolResult` — the payloads a view is handed, never the compressed text the agent read.
 */
export type AppViewRecord = {
  id: string;
  sessionId: string;
  toolUseId: string;
  serverId: string;
  serverName: string;
  /** The server's name for the tool (`show_chart`). */
  tool: string;
  toolDef: Record<string, unknown>;
  resourceUri: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: number;
};

type Row = {
  id: string; session_id: string; tool_use_id: string; server_id: string; server_name: string; tool: string;
  tool_json: string; resource_uri: string; input_json: string; result_json: string; created_at: number;
};

/** A stored JSON object, or `{}` for one that does not parse — a damaged row draws an empty view
 *  rather than failing the read. */
const object = (s: string): Record<string, unknown> => {
  try { const v: unknown = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
};

const toRecord = (r: Row): AppViewRecord => ({
  id: r.id, sessionId: r.session_id, toolUseId: r.tool_use_id, serverId: r.server_id, serverName: r.server_name, tool: r.tool,
  toolDef: object(r.tool_json), resourceUri: r.resource_uri, input: object(r.input_json), result: object(r.result_json), createdAt: r.created_at,
});

export class AppViewsStore {
  constructor(private db: Db) {}

  insert(v: Omit<AppViewRecord, "createdAt">): AppViewRecord {
    this.db.prepare(`INSERT INTO app_views
      (id, session_id, tool_use_id, server_id, server_name, tool, tool_json, resource_uri, input_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.id, v.sessionId, v.toolUseId, v.serverId, v.serverName, v.tool, JSON.stringify(v.toolDef), v.resourceUri, JSON.stringify(v.input), JSON.stringify(v.result), now());
    return this.get(v.id)!;
  }

  get(id: string): AppViewRecord | null {
    const row = this.db.prepare("SELECT * FROM app_views WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }
}
