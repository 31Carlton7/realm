import type { Db } from "../db/database";
import { newId, SessionEventSchema, type AgentKind, type DispatchedBy, type DispatchKind, type Session, type SessionEvent, type SessionStatus, type StoredSessionEvent } from "@realm/contracts";
import { NotFoundError, RpcError, now } from "./rows";

type Row = { id: string; space_id: string; project_id: string | null; agent_kind: AgentKind; model: string | null; effort: string | null;
  permission_mode: string; environment_id: string; cwd: string; status: SessionStatus; provider_session_id: string | null; title: string; last_event_seq: number;
  terminal_item_id: string | null; dispatched_by_kind: DispatchKind | null; dispatched_by_session_id: string | null; created_at: number; updated_at: number };
const toSession = (r: Row): Session => ({
  id: r.id, spaceId: r.space_id, projectId: r.project_id, agentKind: r.agent_kind, model: r.model, effort: r.effort,
  permissionMode: r.permission_mode, environmentId: r.environment_id, cwd: r.cwd, status: r.status, providerSessionId: r.provider_session_id, title: r.title,
  lastEventSeq: r.last_event_seq, terminalItemId: r.terminal_item_id,
  dispatchedBy: r.dispatched_by_kind ? { kind: r.dispatched_by_kind, sessionId: r.dispatched_by_session_id } : null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * `cwd` is not a column (Plan 7 W1): it is the session's environment's path, read through this join on
 * every read, so moving an environment moves every session in it with no cache to invalidate. The join
 * is inner on purpose — the schema's triggers make a session without an environment unwritable, so a
 * row that failed to match would be corruption, not a state to render.
 */
const SELECT = "SELECT s.*, e.path AS cwd FROM sessions s JOIN environments e ON e.id = s.environment_id";

export type SessionUpdate = { id: string; status?: SessionStatus; providerSessionId?: string | null; lastEventSeq?: number; title?: string;
  model?: string | null; effort?: string | null; permissionMode?: string; agentKind?: AgentKind };

export class SessionsStore {
  constructor(private db: Db) {}
  list(spaceId: string): Session[] {
    return (this.db.prepare(`${SELECT} WHERE s.space_id = ? ORDER BY s.created_at`).all(spaceId) as Row[]).map(toSession);
  }
  listAll(): Session[] {
    return (this.db.prepare(`${SELECT} ORDER BY s.created_at`).all() as Row[]).map(toSession);
  }
  get(id: string): Session | null {
    const r = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row | undefined; return r ? toSession(r) : null;
  }
  /** Every provider session id Realm holds — the import's dedup key (`ImportService`). One set
   *  rather than a query per candidate: the question is asked of ~1100 transcripts per scan, and the
   *  column is small enough that reading it whole is cheaper than the round trips. Sessions with no
   *  provider id yet (created, never started) contribute nothing, which is right: they are not a
   *  record of any CLI conversation. */
  providerSessionIds(): Set<string> {
    const rows = this.db.prepare("SELECT provider_session_id AS id FROM sessions WHERE provider_session_id IS NOT NULL").all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }
  create(input: { spaceId: string; projectId: string | null; agentKind: AgentKind; model: string | null; effort: string | null; permissionMode: string; environmentId: string; title: string; dispatchedBy?: DispatchedBy | null }): Session {
    if (!this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(input.spaceId)) throw new NotFoundError("space", input.spaceId);
    const env = this.db.prepare("SELECT space_id FROM environments WHERE id = ?").get(input.environmentId) as { space_id: string } | undefined;
    if (!env) throw new NotFoundError("environment", input.environmentId);
    // A session in space A running in space B's checkout would give the sidebar one cwd and the space
    // header another; there is no reading of that which is not a bug.
    if (env.space_id !== input.spaceId) throw new RpcError("ENVIRONMENT_WRONG_SPACE", "that environment belongs to another space");
    const id = newId(); const t = now();
    this.db.prepare(`INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, environment_id, status, provider_session_id, title, last_event_seq, dispatched_by_kind, dispatched_by_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, ?, 0, ?, ?, ?, ?)`)
      .run(id, input.spaceId, input.projectId, input.agentKind, input.model, input.effort, input.permissionMode, input.environmentId, input.title,
        input.dispatchedBy?.kind ?? null, input.dispatchedBy?.sessionId ?? null, t, t);
    return this.get(id)!;
  }
  update(input: SessionUpdate): Session {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("session", input.id);
    this.db.prepare("UPDATE sessions SET status = ?, provider_session_id = ?, last_event_seq = ?, title = ?, model = ?, effort = ?, permission_mode = ?, agent_kind = ?, updated_at = ? WHERE id = ?")
      .run(input.status ?? cur.status,
        input.providerSessionId === undefined ? cur.providerSessionId : input.providerSessionId,
        input.lastEventSeq ?? cur.lastEventSeq, input.title ?? cur.title,
        input.model === undefined ? cur.model : input.model,
        input.effort === undefined ? cur.effort : input.effort,
        input.permissionMode ?? cur.permissionMode,
        input.agentKind ?? cur.agentKind, now(), input.id);
    return this.get(input.id)!;
  }
  /** Re-point the session at another environment. Deliberately not part of `update` (whose callers only
   *  ever patch turn-scoped fields): the column is guarded by SessionService.setEnvironment's no-events
   *  check, and the wrong-space refusal lives HERE, mirroring `create` — the two write paths for
   *  `environment_id` must enforce the same invariant or one of them is the leak. */
  setEnvironment(id: string, environmentId: string): Session {
    const cur = this.get(id); if (!cur) throw new NotFoundError("session", id);
    const env = this.db.prepare("SELECT space_id FROM environments WHERE id = ?").get(environmentId) as { space_id: string } | undefined;
    if (!env) throw new NotFoundError("environment", environmentId);
    if (env.space_id !== cur.spaceId) throw new RpcError("ENVIRONMENT_WRONG_SPACE", "that environment belongs to another space");
    this.db.prepare("UPDATE sessions SET environment_id = ?, updated_at = ? WHERE id = ?").run(environmentId, now(), id);
    return this.get(id)!;
  }
  /** Re-point space_id, environment_id, and project_id together (SessionService.moveToSpace's write
   *  path). Distinct from `setEnvironment`: that method holds space_id fixed and only lets the
   *  environment change within it; this one moves the space itself, so the wrong-space refusal is
   *  checked against the NEW spaceId, not the session's current one. */
  moveToSpace(id: string, spaceId: string, environmentId: string, projectId: string | null): Session {
    const cur = this.get(id); if (!cur) throw new NotFoundError("session", id);
    if (!this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(spaceId)) throw new NotFoundError("space", spaceId);
    const env = this.db.prepare("SELECT space_id FROM environments WHERE id = ?").get(environmentId) as { space_id: string } | undefined;
    if (!env) throw new NotFoundError("environment", environmentId);
    if (env.space_id !== spaceId) throw new RpcError("ENVIRONMENT_WRONG_SPACE", "that environment belongs to another space");
    this.db.prepare("UPDATE sessions SET space_id = ?, environment_id = ?, project_id = ?, updated_at = ? WHERE id = ?")
      .run(spaceId, environmentId, projectId, now(), id);
    return this.get(id)!;
  }
  /** Point the session at its terminal's item, or clear it. Deliberately not part of `update`: the
   *  column is owned by SessionService.openTerminal, and SQLite clears it on its own (ON DELETE SET
   *  NULL) when the item goes. */
  setTerminalItem(id: string, itemId: string | null): void {
    this.db.prepare("UPDATE sessions SET terminal_item_id = ?, updated_at = ? WHERE id = ?").run(itemId, now(), id);
  }
  /** Hot path (every persisted event): touch only the seq column. */
  setLastEventSeq(id: string, seq: number): void {
    this.db.prepare("UPDATE sessions SET last_event_seq = ?, updated_at = ? WHERE id = ?").run(seq, now(), id);
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("session", id);
    // The FTS rows do not cascade (virtual tables have no foreign keys), so a deleted session's
    // transcript is scrubbed from the index here — search must not keep quoting a transcript whose
    // events are gone.
    this.db.prepare("DELETE FROM search_index WHERE kind = 'session' AND ref = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}

type EventRow = { seq: number; session_id: string; ts: number; type: string; payload_json: string };

export class SessionEventsStore {
  constructor(private db: Db) {}
  append(sessionId: string, event: SessionEvent): StoredSessionEvent {
    const r = this.db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)")
      .run(sessionId, event.ts, event.type, JSON.stringify(event.payload));
    const seq = Number(r.lastInsertRowid);
    // The search index's session source (Plan 16 W1), written HERE — the one choke point every
    // persisted event passes through — so no producer (pump, emitExternal, boot's synthetic denies)
    // can skip it, and so the FTS row commits in the same transaction as the event when the caller
    // (SessionService.persist) holds one. Only the two spoken-text types are search material.
    if ((event.type === "user_message" || event.type === "assistant_text") && event.payload.text.trim() !== "") {
      this.db.prepare("INSERT INTO search_index (text, kind, ref, seq) VALUES (?, 'session', ?, ?)")
        .run(event.payload.text, sessionId, seq);
    }
    return { seq, sessionId, event };
  }
  /** Any persisted event at all — the authority behind the `sessions.setAgent` guard. */
  hasAny(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1").get(sessionId);
  }
  hasType(sessionId: string, type: SessionEvent["type"]): boolean {
    return !!this.db.prepare("SELECT 1 FROM session_events WHERE session_id = ? AND type = ? LIMIT 1").get(sessionId, type);
  }
  /** requestIds of every permission_request without a permission_response, oldest first. */
  findDanglingPermissions(sessionId: string): string[] {
    const rows = this.db.prepare("SELECT type, payload_json FROM session_events WHERE session_id = ? AND type IN ('permission_request', 'permission_response') ORDER BY seq").all(sessionId) as Pick<EventRow, "type" | "payload_json">[];
    const open = new Set<string>();
    for (const r of rows) {
      let requestId: unknown; try { requestId = (JSON.parse(r.payload_json) as { requestId?: unknown }).requestId; } catch { continue; }
      if (typeof requestId !== "string") continue;
      if (r.type === "permission_request") open.add(requestId); else open.delete(requestId);
    }
    return [...open];
  }
  /** The newest persisted event of one type, or null. Skips rows that fail schema validation. */
  lastOfType(sessionId: string, type: SessionEvent["type"]): SessionEvent | null {
    const r = this.db.prepare("SELECT * FROM session_events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1")
      .get(sessionId, type) as EventRow | undefined;
    if (!r) return null;
    let payload: unknown; try { payload = JSON.parse(r.payload_json); } catch { return null; }
    const p = SessionEventSchema.safeParse({ type: r.type, ts: r.ts, payload });
    return p.success ? p.data : null;
  }

  /** The timestamp of the session's newest persisted event, or null when it has none. Boot-time
   *  repairs date their synthetic events here rather than at `Date.now()`, so a log written before a
   *  crash does not gain an event stamped hours later. */
  lastTs(sessionId: string): number | null {
    const r = this.db.prepare("SELECT ts FROM session_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
      .get(sessionId) as Pick<EventRow, "ts"> | undefined;
    return r ? r.ts : null;
  }

  /**
   * The session's SPOKEN transcript — user/assistant text only — up to `upToTs`, ascending (Plan 16
   * W3's fork context). The cut is by event timestamp against the checkpoint's `createdAt`: a turn
   * checkpoint is captured BEFORE its user_message event is minted, so that turn's events carry later
   * timestamps and fall on the far side — "up to the checkpoint" means up to but not including the
   * turn it fronted. An honest approximation (clock, not causality), and stated as one.
   */
  transcript(sessionId: string, upToTs: number): { role: "user" | "assistant"; text: string }[] {
    const rows = this.db.prepare(
      "SELECT type, payload_json FROM session_events WHERE session_id = ? AND ts <= ? AND type IN ('user_message', 'assistant_text') ORDER BY seq")
      .all(sessionId, upToTs) as Pick<EventRow, "type" | "payload_json">[];
    const out: { role: "user" | "assistant"; text: string }[] = [];
    for (const r of rows) {
      let text: unknown; try { text = (JSON.parse(r.payload_json) as { text?: unknown }).text; } catch { continue; }
      if (typeof text !== "string" || text.trim() === "") continue;
      out.push({ role: r.type === "user_message" ? "user" : "assistant", text });
    }
    return out;
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
