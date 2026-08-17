import type { Db } from "../db/database";
import { newId, SessionEventSchema, type AgentKind, type Session, type SessionEvent, type SessionStatus, type StoredSessionEvent } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; space_id: string; project_id: string | null; agent_kind: AgentKind; model: string | null; effort: string | null;
  permission_mode: string; cwd: string; status: SessionStatus; provider_session_id: string | null; title: string; last_event_seq: number;
  created_at: number; updated_at: number };
const toSession = (r: Row): Session => ({
  id: r.id, spaceId: r.space_id, projectId: r.project_id, agentKind: r.agent_kind, model: r.model, effort: r.effort,
  permissionMode: r.permission_mode, cwd: r.cwd, status: r.status, providerSessionId: r.provider_session_id, title: r.title,
  lastEventSeq: r.last_event_seq, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type SessionUpdate = { id: string; status?: SessionStatus; providerSessionId?: string | null; lastEventSeq?: number; title?: string;
  model?: string | null; effort?: string | null; permissionMode?: string };

export class SessionsStore {
  constructor(private db: Db) {}
  list(spaceId: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE space_id = ? ORDER BY created_at").all(spaceId) as Row[]).map(toSession);
  }
  listAll(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY created_at").all() as Row[]).map(toSession);
  }
  get(id: string): Session | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined; return r ? toSession(r) : null;
  }
  create(input: { spaceId: string; projectId: string | null; agentKind: AgentKind; model: string | null; effort: string | null; permissionMode: string; cwd: string; title: string }): Session {
    if (!this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(input.spaceId)) throw new NotFoundError("space", input.spaceId);
    const id = newId(); const t = now();
    this.db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, cwd, status, provider_session_id, title, last_event_seq, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, ?, 0, ?, ?)`)
      .run(id, input.spaceId, input.projectId, input.agentKind, input.model, input.effort, input.permissionMode, input.cwd, input.title, t, t);
    return this.get(id)!;
  }
  update(input: SessionUpdate): Session {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("session", input.id);
    this.db.prepare("UPDATE sessions SET status = ?, provider_session_id = ?, last_event_seq = ?, title = ?, model = ?, effort = ?, permission_mode = ?, updated_at = ? WHERE id = ?")
      .run(input.status ?? cur.status,
        input.providerSessionId === undefined ? cur.providerSessionId : input.providerSessionId,
        input.lastEventSeq ?? cur.lastEventSeq, input.title ?? cur.title,
        input.model === undefined ? cur.model : input.model,
        input.effort === undefined ? cur.effort : input.effort,
        input.permissionMode ?? cur.permissionMode, now(), input.id);
    return this.get(input.id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("session", id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}

type EventRow = { seq: number; session_id: string; ts: number; type: string; payload_json: string };

export class SessionEventsStore {
  constructor(private db: Db) {}
  append(sessionId: string, event: SessionEvent): StoredSessionEvent {
    const r = this.db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)")
      .run(sessionId, event.ts, event.type, JSON.stringify(event.payload));
    return { seq: Number(r.lastInsertRowid), sessionId, event };
  }
  hasType(sessionId: string, type: SessionEvent["type"]): boolean {
    return !!this.db.prepare("SELECT 1 FROM session_events WHERE session_id = ? AND type = ? LIMIT 1").get(sessionId, type);
  }
  /** Events with seq > afterSeq, ascending. Rows that fail schema validation (e.g. from an older build) are skipped. */
  listAfter(sessionId: string, afterSeq: number, limit: number): StoredSessionEvent[] {
    const rows = this.db.prepare("SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(sessionId, afterSeq, limit) as EventRow[];
    const out: StoredSessionEvent[] = [];
    for (const r of rows) {
      let payload: unknown; try { payload = JSON.parse(r.payload_json); } catch { continue; }
      const p = SessionEventSchema.safeParse({ type: r.type, ts: r.ts, payload });
      if (p.success) out.push({ seq: r.seq, sessionId, event: p.data });
    }
    return out;
  }
}
