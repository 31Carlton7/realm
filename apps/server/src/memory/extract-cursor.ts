import type { Db } from "../db/database";

export type LearnedCursor = { throughSeq: number; agentSaved: boolean };

/** How far Realm has read each session for memory (`memory_learned`). */
export class LearnedCursors {
  constructor(private db: Db) {}

  get(sessionId: string): LearnedCursor | null {
    const r = this.db.prepare("SELECT through_seq, agent_saved FROM memory_learned WHERE session_id = ?").get(sessionId) as { through_seq: number; agent_saved: number } | undefined;
    return r ? { throughSeq: r.through_seq, agentSaved: r.agent_saved === 1 } : null;
  }

  /** Never backwards, and `agentSaved` never unset: two extractions finishing out of order must not
   *  hand the next one text it already read, or forget a save the earlier one saw. */
  advance(sessionId: string, throughSeq: number, agentSaved: boolean, at: number): void {
    this.db.prepare(`INSERT INTO memory_learned (session_id, through_seq, agent_saved, learned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq),
        agent_saved = MAX(agent_saved, excluded.agent_saved), learned_at = excluded.learned_at`)
      .run(sessionId, throughSeq, agentSaved ? 1 : 0, at);
  }
}
