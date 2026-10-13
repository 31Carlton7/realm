import { newId, type HandoffKind } from "@realm/contracts";
import type { Db } from "../../db/database";
import { now } from "../../store/rows";

/** A handoff or mention as stored. Its state is not a column: it is read off the run or sub-agent. */
export type HandoffRow = {
  id: string; spaceId: string; kind: HandoffKind;
  fromRoleId: string | null; fromSessionId: string | null; toRoleId: string;
  recordPath: string | null; note: string; files: string[];
  runId: string | null; sessionId: string | null;
  /** A mention's sub-agent outcome, once it settled (`DelegationOutcome`). Null for a handoff. */
  outcome: string | null; costUsd: number | null;
  createdAt: number; settledAt: number | null;
};

type Raw = {
  id: string; space_id: string; kind: HandoffKind;
  from_role_id: string | null; from_session_id: string | null; to_role_id: string;
  record_path: string | null; note: string; files_json: string;
  run_id: string | null; session_id: string | null; outcome: string | null; cost_usd: number | null;
  created_at: number; settled_at: number | null;
};

const toRow = (r: Raw): HandoffRow => {
  let files: string[] = [];
  try { const v = JSON.parse(r.files_json) as unknown; if (Array.isArray(v)) files = v.filter((x): x is string => typeof x === "string"); } catch { /* an unreadable list is no files */ }
  return {
    id: r.id, spaceId: r.space_id, kind: r.kind, fromRoleId: r.from_role_id, fromSessionId: r.from_session_id, toRoleId: r.to_role_id,
    recordPath: r.record_path, note: r.note, files, runId: r.run_id, sessionId: r.session_id, outcome: r.outcome, costUsd: r.cost_usd,
    createdAt: r.created_at, settledAt: r.settled_at,
  };
};

/**
 * The Phase 4 rows: a role's handoff edges and its mention switch (two `team_roles` columns v47 added,
 * read and written only here), and `team_handoffs`. Every rule about what is allowed is
 * `HandoffService`'s.
 */
export class HandoffStore {
  constructor(private db: Db, private clock: () => number = now) {}

  edges(roleId: string): string[] {
    const r = this.db.prepare("SELECT handoffs_json AS j FROM team_roles WHERE id = ?").get(roleId) as { j: string } | undefined;
    if (!r) return [];
    try { const v = JSON.parse(r.j) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
  }

  setEdges(roleId: string, ids: readonly string[]): void {
    this.db.prepare("UPDATE team_roles SET handoffs_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...new Set(ids)]), this.clock(), roleId);
  }

  wakeOnMention(roleId: string): boolean {
    const r = this.db.prepare("SELECT wake_on_mention AS w FROM team_roles WHERE id = ?").get(roleId) as { w: number } | undefined;
    return r ? r.w === 1 : true;
  }

  setWakeOnMention(roleId: string, on: boolean): void {
    this.db.prepare("UPDATE team_roles SET wake_on_mention = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, this.clock(), roleId);
  }

  create(input: Omit<HandoffRow, "id" | "createdAt" | "settledAt" | "outcome" | "costUsd">): HandoffRow {
    const id = newId();
    this.db.prepare(`INSERT INTO team_handoffs (id, space_id, kind, from_role_id, from_session_id, to_role_id, record_path, note, files_json, run_id, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.spaceId, input.kind, input.fromRoleId, input.fromSessionId, input.toRoleId, input.recordPath, input.note,
        JSON.stringify(input.files), input.runId, input.sessionId, this.clock());
    return this.get(id)!;
  }

  get(id: string): HandoffRow | null {
    const r = this.db.prepare("SELECT * FROM team_handoffs WHERE id = ?").get(id) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  forRun(runId: string): HandoffRow | null {
    const r = this.db.prepare("SELECT * FROM team_handoffs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  forSession(sessionId: string): HandoffRow | null {
    const r = this.db.prepare("SELECT * FROM team_handoffs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  inSpace(spaceId: string, limit: number): HandoffRow[] {
    return (this.db.prepare("SELECT * FROM team_handoffs WHERE space_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(spaceId, limit) as Raw[]).map(toRow);
  }

  /** A role's mentions, newest first — its page lists them beside its runs. */
  mentionsOf(roleId: string, limit: number): HandoffRow[] {
    return (this.db.prepare("SELECT * FROM team_handoffs WHERE to_role_id = ? AND kind = 'mention' ORDER BY created_at DESC LIMIT ?").all(roleId, limit) as Raw[]).map(toRow);
  }

  /** Mentions not yet settled — the sub-agents a role may be working as right now. */
  liveMentions(): HandoffRow[] {
    return (this.db.prepare("SELECT * FROM team_handoffs WHERE kind = 'mention' AND settled_at IS NULL AND session_id IS NOT NULL").all() as Raw[]).map(toRow);
  }

  /** What a role's mentions (or a team's) cost since a moment: the half of its week no run row holds. */
  mentionSpendSince(where: { roleId?: string; spaceId?: string }, since: number): number {
    const col = where.roleId ? "to_role_id" : "space_id";
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM team_handoffs WHERE kind = 'mention' AND ${col} = ? AND created_at >= ?`)
      .get(where.roleId ?? where.spaceId ?? "", since) as { s: number };
    return r.s;
  }

  settleMention(id: string, outcome: string, costUsd: number | null): void {
    this.db.prepare("UPDATE team_handoffs SET outcome = ?, cost_usd = COALESCE(?, cost_usd), settled_at = ? WHERE id = ? AND settled_at IS NULL").run(outcome, costUsd, this.clock(), id);
  }

  setMentionCost(id: string, costUsd: number): void {
    this.db.prepare("UPDATE team_handoffs SET cost_usd = ? WHERE id = ?").run(costUsd, id);
  }
}
