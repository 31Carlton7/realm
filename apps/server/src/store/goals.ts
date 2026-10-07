import type { Db } from "../db/database";
import type { Goal, GoalStatus } from "@realm/contracts";
import { now } from "./rows";

type Row = {
  session_id: string; objective: string; status: string;
  token_budget: number | null; tokens_used: number; turns: number; note: string | null;
  started_at: number; updated_at: number;
};

const toGoal = (r: Row): Goal => ({
  sessionId: r.session_id, objective: r.objective, status: r.status as GoalStatus,
  tokenBudget: r.token_budget, tokensUsed: r.tokens_used, turns: r.turns, note: r.note,
  startedAt: r.started_at, updatedAt: r.updated_at,
});

/** One objective per session. `start` is an upsert for the reason the v29 migration gives: a new
 *  objective replaces the old one rather than queueing behind it. */
export class GoalsStore {
  constructor(private db: Db) {}

  start(input: { sessionId: string; objective: string; tokenBudget: number | null }): Goal {
    const t = now();
    this.db.prepare(`
      INSERT INTO session_goals (session_id, objective, status, token_budget, tokens_used, turns, note, started_at, updated_at)
      VALUES (?, ?, 'active', ?, 0, 0, NULL, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        objective = excluded.objective, status = 'active', token_budget = excluded.token_budget,
        tokens_used = 0, turns = 0, note = NULL, started_at = excluded.started_at, updated_at = excluded.updated_at
    `).run(input.sessionId, input.objective, input.tokenBudget, t, t);
    return this.get(input.sessionId)!;
  }

  get(sessionId: string): Goal | null {
    const r = this.db.prepare("SELECT * FROM session_goals WHERE session_id = ?").get(sessionId) as Row | undefined;
    return r ? toGoal(r) : null;
  }

  /** Every goal in a status, for the boot sweep and for the sidebar's counts. */
  withStatus(status: GoalStatus): Goal[] {
    return (this.db.prepare("SELECT * FROM session_goals WHERE status = ?").all(status) as Row[]).map(toGoal);
  }

  update(sessionId: string, patch: { status?: GoalStatus; note?: string | null; tokensUsed?: number; turns?: number; tokenBudget?: number | null }): Goal | null {
    const row = this.get(sessionId);
    if (!row) return null;
    const next = {
      status: patch.status ?? row.status,
      note: patch.note === undefined ? row.note : patch.note,
      tokensUsed: patch.tokensUsed ?? row.tokensUsed,
      turns: patch.turns ?? row.turns,
      tokenBudget: patch.tokenBudget === undefined ? row.tokenBudget : patch.tokenBudget,
    };
    this.db.prepare("UPDATE session_goals SET status = ?, note = ?, tokens_used = ?, turns = ?, token_budget = ?, updated_at = ? WHERE session_id = ?")
      .run(next.status, next.note, next.tokensUsed, next.turns, next.tokenBudget, now(), sessionId);
    return this.get(sessionId);
  }

  delete(sessionId: string): void {
    this.db.prepare("DELETE FROM session_goals WHERE session_id = ?").run(sessionId);
  }
}
