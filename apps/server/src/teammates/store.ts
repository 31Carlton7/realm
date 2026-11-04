import { TeammateIconSchema, TeammatePermissionModeSchema, failureReason, newId, sessionOutcome, teammateHandle, teammateIconFromSeed, type AgentKind, type OutcomeEvent, type SessionOutcome, type SessionStatus, type TeammateIcon, type TeammatePermissionMode } from "@realm/contracts";
import type { Db } from "../db/database";
import { payloadSql } from "../store/event-payload";
import { now } from "../store/rows";

const PAYLOAD = payloadSql("payload_json");

/** A teammate as stored: everything but the derived state, which the service reads off its sessions. */
export type TeammateRow = {
  id: string; spaceId: string; handle: string; name: string; brief: string; icon: TeammateIcon;
  agentKind: AgentKind; model: string | null; effort: string | null; permissionMode: TeammatePermissionMode;
  /** Null: the space's own folder. */
  folder: string | null;
  lead: boolean; group: string | null; sortOrder: number; archived: boolean; homeSessionId: string | null;
  createdAt: number; updatedAt: number;
};

type Raw = {
  id: string; space_id: string; handle: string | null; name: string; brief: string; icon_json: string | null; realmite_json: string;
  agent_kind: AgentKind; model: string | null; effort: string | null; permission_mode: string; folder: string | null;
  is_lead: number; group_name: string | null; sort_order: number; archived: number; home_session_id: string | null;
  created_at: number; updated_at: number;
};

/** The seed the first Teams rolled a role's Realmite from: its spec's own, else the role's id. */
function realmiteSeed(r: Pick<Raw, "id" | "realmite_json">): string {
  try {
    const seed = (JSON.parse(r.realmite_json) as { seed?: unknown }).seed;
    return typeof seed === "string" && seed ? seed : r.id;
  } catch { return r.id; }
}

function iconOf(r: Raw): TeammateIcon {
  if (r.icon_json) {
    try {
      const parsed = TeammateIconSchema.safeParse(JSON.parse(r.icon_json));
      if (parsed.success) return parsed.data;
    } catch { /* rolled below */ }
  }
  return teammateIconFromSeed(realmiteSeed(r));
}

const toRow = (r: Raw): TeammateRow => ({
  id: r.id, spaceId: r.space_id, handle: r.handle ?? teammateHandle(r.name), name: r.name, brief: r.brief, icon: iconOf(r),
  agentKind: r.agent_kind, model: r.model, effort: r.effort,
  // The first Teams knew three modes, all of which a teammate has; anything else reads as asking.
  permissionMode: TeammatePermissionModeSchema.safeParse(r.permission_mode).data ?? "default",
  folder: r.folder, lead: r.is_lead === 1, group: r.group_name, sortOrder: r.sort_order, archived: r.archived === 1,
  homeSessionId: r.home_session_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export type TeammateInsert = Omit<TeammateRow, "id" | "sortOrder" | "archived" | "homeSessionId" | "createdAt" | "updatedAt">;
export type TeammatePatch = Partial<Omit<TeammateRow, "id" | "spaceId" | "createdAt" | "updatedAt">>;

/** A session of a teammate's, as the Team list and its page read it: the columns, never the transcript. */
export type TeammateSessionRow = {
  id: string; teammateId: string; home: boolean; title: string; status: SessionStatus;
  dispatchedBy: string | null; askedBy: string | null; unread: boolean; activityAt: number; updatedAt: number;
};

/**
 * Teammates, in the `team_roles` table the first Teams made. Rows only: which change is allowed is the
 * service's. Columns the old roles used and teammates do not (skills, budgets) are left as they are, and
 * a new teammate writes their defaults. A teammate's clock is a `schedules` row tagged with its id, as a
 * role's was.
 */
export class TeammatesStore {
  constructor(private db: Db, private clock: () => number = now) {}

  list(spaceId: string, archived = false): TeammateRow[] {
    return (this.db.prepare("SELECT * FROM team_roles WHERE space_id = ? AND archived = ? ORDER BY is_lead DESC, sort_order, created_at")
      .all(spaceId, archived ? 1 : 0) as Raw[]).map(toRow);
  }

  get(id: string): TeammateRow | null {
    const r = this.db.prepare("SELECT * FROM team_roles WHERE id = ?").get(id) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  byHandle(spaceId: string, handle: string): TeammateRow | null {
    const r = this.db.prepare("SELECT * FROM team_roles WHERE space_id = ? AND archived = 0 AND handle = ?").get(spaceId, handle) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  lead(spaceId: string): TeammateRow | null {
    const r = this.db.prepare("SELECT * FROM team_roles WHERE space_id = ? AND archived = 0 AND is_lead = 1").get(spaceId) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  /** Whether the space has a teammate who is not archived — what puts the team tools in its sessions. */
  hasAny(spaceId: string): boolean {
    return this.db.prepare("SELECT 1 FROM team_roles WHERE space_id = ? AND archived = 0 LIMIT 1").get(spaceId) !== undefined;
  }

  /** The teammate whose home session this is, if it is one. */
  byHomeSession(sessionId: string): TeammateRow | null {
    const r = this.db.prepare("SELECT * FROM team_roles WHERE home_session_id = ?").get(sessionId) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  /** `handle`, or the first of `handle-2`, `handle-3`… no other teammate in the space holds. */
  freeHandle(spaceId: string, handle: string, exceptId: string | null = null): string {
    const taken = new Set((this.db.prepare("SELECT handle FROM team_roles WHERE space_id = ? AND handle IS NOT NULL AND id IS NOT ?")
      .all(spaceId, exceptId) as { handle: string }[]).map((r) => r.handle));
    if (!taken.has(handle)) return handle;
    for (let n = 2; ; n++) {
      const next = `${handle.slice(0, 40 - String(n).length - 1)}-${n}`;
      if (!taken.has(next)) return next;
    }
  }

  create(input: TeammateInsert): TeammateRow {
    const id = newId(); const t = this.clock();
    const order = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM team_roles WHERE space_id = ?").get(input.spaceId) as { n: number }).n;
    this.db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, template, agent_kind, model, effort, permission_mode,
        handle, icon_json, folder, is_lead, group_name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.spaceId, input.name, input.brief, input.agentKind, input.model, input.effort, input.permissionMode,
        input.handle, JSON.stringify(input.icon), input.folder, input.lead ? 1 : 0, input.group, order, t, t);
    return this.get(id)!;
  }

  update(id: string, p: TeammatePatch): TeammateRow | null {
    const sets: string[] = []; const vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v); };
    if (p.handle !== undefined) put("handle", p.handle);
    if (p.name !== undefined) put("name", p.name);
    if (p.brief !== undefined) put("brief", p.brief);
    if (p.icon !== undefined) put("icon_json", JSON.stringify(p.icon));
    if (p.agentKind !== undefined) put("agent_kind", p.agentKind);
    if (p.model !== undefined) put("model", p.model);
    if (p.effort !== undefined) put("effort", p.effort);
    if (p.permissionMode !== undefined) put("permission_mode", p.permissionMode);
    if (p.folder !== undefined) put("folder", p.folder);
    if (p.lead !== undefined) put("is_lead", p.lead ? 1 : 0);
    if (p.group !== undefined) put("group_name", p.group);
    if (p.sortOrder !== undefined) put("sort_order", p.sortOrder);
    if (p.archived !== undefined) put("archived", p.archived ? 1 : 0);
    if (p.homeSessionId !== undefined) put("home_session_id", p.homeSessionId);
    if (sets.length === 0) return this.get(id);
    put("updated_at", this.clock());
    vals.push(id);
    this.db.prepare(`UPDATE team_roles SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  /** Gone for good — only a teammate whose making was refused half way, before it had a session. */
  remove(id: string): void {
    this.db.prepare("DELETE FROM team_roles WHERE id = ?").run(id);
  }

  /** Make `id` the space's one Lead, or clear the Lead with null. */
  setLead(spaceId: string, id: string | null): void {
    const t = this.clock();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE team_roles SET is_lead = 0, updated_at = ? WHERE space_id = ? AND is_lead = 1 AND id IS NOT ?").run(t, spaceId, id);
      if (id) this.db.prepare("UPDATE team_roles SET is_lead = 1, updated_at = ? WHERE id = ? AND space_id = ?").run(t, id, spaceId);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  reorder(spaceId: string, order: readonly { id: string; group: string | null }[]): void {
    const t = this.clock();
    const write = this.db.prepare("UPDATE team_roles SET sort_order = ?, group_name = ?, updated_at = ? WHERE id = ? AND space_id = ?");
    this.db.exec("BEGIN");
    try {
      order.forEach((o, i) => write.run(i, o.group, t, o.id, spaceId));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /**
   * The roles the first Teams made, given what a teammate needs that they lacked: a handle from the
   * name, unique in the space, and an icon rolled from the Realmite's seed, so a role keeps the same
   * face on every boot. Only rows that have no handle yet — every teammate is made with one — so each
   * role is brought through once; returns how many it filled.
   *
   * Each comes through in Full access. Its column said Plan, Ask or Accept edits, but every run a role
   * made went in Full access whatever it said (the first Teams' `runPermissionMode` in runs/service.ts),
   * and a teammate's clock runs in the teammate's mode: carrying the column over would park the 9am
   * work on its first permission prompt with nobody there. A teammate made since takes the space's default.
   */
  backfill(): number {
    const rows = this.db.prepare("SELECT * FROM team_roles WHERE handle IS NULL ORDER BY created_at").all() as Raw[];
    for (const r of rows) {
      const handle = this.freeHandle(r.space_id, teammateHandle(r.name), r.id);
      this.db.prepare("UPDATE team_roles SET handle = ?, icon_json = ?, permission_mode = 'bypassPermissions' WHERE id = ?")
        .run(handle, JSON.stringify(teammateIconFromSeed(realmiteSeed(r))), r.id);
    }
    return rows.length;
  }

  /** The session is no longer its teammate's chat — it stays among the teammate's sessions. */
  unhome(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET teammate_home = 0 WHERE id = ?").run(sessionId);
  }

  /** Every session of the space's teammates — homes and the sessions they started — newest first. */
  sessions(spaceId: string): TeammateSessionRow[] {
    return (this.db.prepare(`SELECT id, teammate_id, teammate_home, title, status, dispatched_by_session_id, asked_by_session_id,
        last_event_seq, seen_seq, activity_at, updated_at
      FROM sessions WHERE space_id = ? AND teammate_id IS NOT NULL ORDER BY activity_at DESC`).all(spaceId) as {
        id: string; teammate_id: string; teammate_home: number; title: string; status: SessionStatus; dispatched_by_session_id: string | null;
        asked_by_session_id: string | null; last_event_seq: number; seen_seq: number; activity_at: number; updated_at: number }[])
      .map((r) => ({
        id: r.id, teammateId: r.teammate_id, home: r.teammate_home === 1, title: r.title, status: r.status,
        dispatchedBy: r.dispatched_by_session_id, askedBy: r.asked_by_session_id,
        // A teammate's sessions are made for the person to read, so one never opened is unread too.
        unread: r.seen_seq < r.last_event_seq, activityAt: r.activity_at, updatedAt: r.updated_at,
      }));
  }

  /**
   * What each of these finished sessions produced, by id: the error its last turn ended on for one
   * whose status is `error`, else what its `gh` commands did (`sessionOutcome`). Only the calls that
   * could be one are read — a `gh pr` or `gh release create` command and the results answering them —
   * so a long session costs a few rows, not its whole log.
   */
  outcomes(sessions: readonly { id: string; status: SessionStatus }[]): Map<string, SessionOutcome> {
    const out = new Map<string, SessionOutcome>();
    if (sessions.length === 0) return out;
    const ids = sessions.map((s) => s.id);
    const marks = ids.map(() => "?").join(", ");
    const calls = this.db.prepare(`SELECT seq, session_id, type, ${PAYLOAD} AS payload_json FROM session_events
      WHERE session_id IN (${marks}) AND type = 'tool_call' AND (${PAYLOAD} LIKE '%gh pr %' OR ${PAYLOAD} LIKE '%gh release create%')
      ORDER BY seq`).all(...ids) as { seq: number; session_id: string; type: "tool_call"; payload_json: string }[];
    const callIds = calls.map((c) => (JSON.parse(c.payload_json) as { toolUseId: string }).toolUseId);
    const results = callIds.length === 0 ? [] : this.db.prepare(`SELECT seq, session_id, type, ${PAYLOAD} AS payload_json FROM session_events
      WHERE session_id IN (${marks}) AND type = 'tool_result' AND json_extract(${PAYLOAD}, '$.toolUseId') IN (${callIds.map(() => "?").join(", ")})
      ORDER BY seq`).all(...ids, ...callIds) as { seq: number; session_id: string; type: "tool_result"; payload_json: string }[];
    const bySession = new Map<string, OutcomeEvent[]>();
    for (const r of [...calls, ...results].sort((a, b) => a.seq - b.seq)) {
      bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), { type: r.type, payload: JSON.parse(r.payload_json) } as OutcomeEvent]);
    }
    const lastError = this.db.prepare(`SELECT ${PAYLOAD} AS payload_json FROM session_events WHERE session_id = ? AND type = 'error' ORDER BY seq DESC LIMIT 1`);
    for (const s of sessions) {
      if (s.status === "error") {
        const e = lastError.get(s.id) as { payload_json: string } | undefined;
        const message = e ? (JSON.parse(e.payload_json) as { message?: string }).message ?? "" : "";
        out.set(s.id, { kind: "failed", reason: failureReason(message) });
        continue;
      }
      const o = sessionOutcome(bySession.get(s.id) ?? []);
      if (o) out.set(s.id, o);
    }
    return out;
  }
}
