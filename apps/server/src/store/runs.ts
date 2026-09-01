import type { Db } from "../db/database";
import { newId, RUN_LIVE_STATES, type AgentKind, type Run, type RunAttempt, type RunAttemptOutcome, type RunConstraints, type RunState } from "@realm/contracts";
import { now } from "./rows";

type Row = {
  id: string; space_id: string; title: string; goal: string; agent_kind: AgentKind;
  environment_id: string | null; constraints_json: string | null; dedupe_key: string | null;
  state: RunState; attempt: number; max_attempts: number; session_id: string | null;
  deadline_at: number | null; result_text: string | null; error: string | null;
  created_at: number; started_at: number | null; settled_at: number | null; updated_at: number;
};

/** A constraints blob that does not parse reads as "no constraints" rather than throwing — it is a
 *  stored JSON column, and a corrupt one should degrade the run to the defaults, not make the row
 *  unreadable and the run unrecoverable. Same posture `ReviewService.get` takes for its verdict. */
function parseConstraints(json: string | null): RunConstraints | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as RunConstraints) : null;
  } catch { return null; }
}

const toRun = (r: Row): Run => ({
  id: r.id, spaceId: r.space_id, title: r.title, goal: r.goal, agentKind: r.agent_kind,
  environmentId: r.environment_id, constraints: parseConstraints(r.constraints_json), dedupeKey: r.dedupe_key,
  state: r.state, attempt: r.attempt, maxAttempts: r.max_attempts, sessionId: r.session_id,
  deadlineAt: r.deadline_at, result: r.result_text, error: r.error,
  createdAt: r.created_at, startedAt: r.started_at, settledAt: r.settled_at, updatedAt: r.updated_at,
});

type AttemptRow = { id: string; run_id: string; n: number; session_id: string | null; outcome: RunAttemptOutcome; detail: string | null; started_at: number; settled_at: number | null };
const toAttempt = (r: AttemptRow): RunAttempt => ({
  id: r.id, runId: r.run_id, n: r.n, sessionId: r.session_id, outcome: r.outcome, detail: r.detail,
  startedAt: r.started_at, settledAt: r.settled_at,
});

export type RunInsert = {
  spaceId: string; title: string; goal: string; agentKind: AgentKind;
  environmentId: string | null; constraints: RunConstraints | null; dedupeKey: string | null;
  maxAttempts: number; deadlineAt: number | null;
};

/** Every field a transition may write. Absent = untouched; `null` is a real value for the nullable
 *  ones, which is why this is not `Partial<Run>` with undefined doing double duty. */
export type RunUpdate = {
  state?: RunState;
  attempt?: number;
  maxAttempts?: number;
  sessionId?: string | null;
  environmentId?: string | null;
  result?: string | null;
  error?: string | null;
  startedAt?: number | null;
  settledAt?: number | null;
};

const LIVE = RUN_LIVE_STATES as readonly string[];

/**
 * Rows only — every rule about WHICH transition is legal lives in `RunService`, the one writer.
 * Feed order and pagination are the notifications store's, verbatim: `created_at DESC, id DESC`,
 * keyset cursor `${createdAt}:${id}`.
 *
 * The one piece of policy that IS here is `create`'s dedupe collision, because it is enforced by a
 * database index rather than by a read-then-write the service could lose a race on: `create` returns
 * `null` when the key is taken, and the service turns that into "here is the run you already have".
 */
export class RunsStore {
  constructor(private db: Db) {}

  get(id: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }

  /**
   * Insert a queued run, or return `null` when `dedupeKey` already names a LIVE run of this space.
   *
   * The collision is detected by CATCHING the unique-index violation rather than by checking first:
   * a check-then-insert is two statements with a window between them, and the whole promise of the
   * dedupe key is that a poller firing twice in that window still gets one run. The index is the
   * only arbiter; this method just translates its complaint.
   */
  create(input: RunInsert): Run | null {
    const id = newId(); const t = now();
    try {
      this.db.prepare(
        `INSERT INTO runs (id, space_id, title, goal, agent_kind, environment_id, constraints_json, dedupe_key,
           state, attempt, max_attempts, session_id, deadline_at, result_text, error, created_at, started_at, settled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?)`,
      ).run(id, input.spaceId, input.title, input.goal, input.agentKind, input.environmentId,
        input.constraints ? JSON.stringify(input.constraints) : null, input.dedupeKey,
        input.maxAttempts, input.deadlineAt, t, t);
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    return this.get(id)!;
  }

  /** The live run for a dedupe key, if any — what a collision resolves to. */
  findLiveByDedupeKey(spaceId: string, dedupeKey: string): Run | null {
    const r = this.db.prepare(
      `SELECT * FROM runs WHERE space_id = ? AND dedupe_key = ? AND state IN ('queued', 'running', 'blocked')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(spaceId, dedupeKey) as Row | undefined;
    return r ? toRun(r) : null;
  }

  update(id: string, u: RunUpdate): Run | null {
    const sets: string[] = []; const vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v); };
    if (u.state !== undefined) put("state", u.state);
    if (u.attempt !== undefined) put("attempt", u.attempt);
    if (u.maxAttempts !== undefined) put("max_attempts", u.maxAttempts);
    if (u.sessionId !== undefined) put("session_id", u.sessionId);
    if (u.environmentId !== undefined) put("environment_id", u.environmentId);
    if (u.result !== undefined) put("result_text", u.result);
    if (u.error !== undefined) put("error", u.error);
    if (u.startedAt !== undefined) put("started_at", u.startedAt);
    if (u.settledAt !== undefined) put("settled_at", u.settledAt);
    if (sets.length === 0) return this.get(id);
    put("updated_at", now());
    vals.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  /**
   * Claim a queued run for its next attempt — a compare-and-set, not a read-then-write.
   *
   * `AND state = 'queued'` is the whole guard: two callers racing to dispatch the same run both run
   * this UPDATE, exactly one reports a changed row, and the loser gets `null` and does nothing. A
   * `get`-then-`update` would have both of them dispatch, which is two sessions on one goal.
   */
  claim(id: string): Run | null {
    const changed = Number(this.db.prepare(
      "UPDATE runs SET state = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND state = 'queued'",
    ).run(now(), now(), id).changes);
    return changed === 1 ? this.get(id) : null;
  }

  /** One page of one space's runs. The `space_id = ?` filter is load-bearing: two spaces' runs must
   *  never appear in one listing, however their timestamps interleave. An empty `states` means all. */
  list(input: { spaceId: string; states: RunState[]; cursor: string | null; limit: number }): { runs: Run[]; nextCursor: string | null } {
    const parsed = parseCursor(input.cursor);
    const where: string[] = ["space_id = ?"]; const vals: (string | number)[] = [input.spaceId];
    if (input.states.length > 0) {
      where.push(`state IN (${input.states.map(() => "?").join(", ")})`);
      vals.push(...input.states);
    }
    if (parsed) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      vals.push(parsed.createdAt, parsed.createdAt, parsed.id);
    }
    const rows = this.db.prepare(
      `SELECT * FROM runs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...vals, input.limit) as Row[];
    const last = rows.at(-1);
    // A short page IS the end; only a full page might have more behind it.
    const nextCursor = rows.length === input.limit && last ? `${last.created_at}:${last.id}` : null;
    return { runs: rows.map(toRun), nextCursor };
  }

  /** Every live run, across every space — boot recovery's one scan. */
  listLive(): Run[] {
    return (this.db.prepare(
      `SELECT * FROM runs WHERE state IN (${LIVE.map(() => "?").join(", ")}) ORDER BY created_at ASC, id ASC`,
    ).all(...LIVE) as Row[]).map(toRun);
  }

  /* ------------------------------------- attempts ------------------------------------------- */

  /** Open attempt `n` for a run. Its unique `(run_id, n)` index means a double-dispatch that somehow
   *  got past `claim` still cannot log two attempts under one number. */
  openAttempt(input: { runId: string; n: number; sessionId: string | null }): RunAttempt {
    const id = newId();
    this.db.prepare("INSERT INTO run_attempts (id, run_id, n, session_id, outcome, detail, started_at, settled_at) VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)")
      .run(id, input.runId, input.n, input.sessionId, now());
    return toAttempt(this.db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(id) as AttemptRow);
  }

  /** Close a run's open attempt (the highest `n` still `running`). A run with none — the outcome
   *  arrived twice, or the attempt was already reconciled at boot — is a no-op, not an error. */
  closeAttempt(runId: string, outcome: RunAttemptOutcome, detail: string | null): RunAttempt | null {
    const open = this.db.prepare("SELECT * FROM run_attempts WHERE run_id = ? AND outcome = 'running' ORDER BY n DESC LIMIT 1").get(runId) as AttemptRow | undefined;
    if (!open) return null;
    this.db.prepare("UPDATE run_attempts SET outcome = ?, detail = ?, settled_at = ? WHERE id = ?").run(outcome, detail, now(), open.id);
    return toAttempt(this.db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(open.id) as AttemptRow);
  }

  /** A run's attempts, oldest first — the account of what has already been tried. */
  attempts(runId: string): RunAttempt[] {
    return (this.db.prepare("SELECT * FROM run_attempts WHERE run_id = ? ORDER BY n ASC").all(runId) as AttemptRow[]).map(toAttempt);
  }

  /** The run (if any) whose CURRENT session is this one — the settle hook's lookup. Scoped to live
   *  states so a terminal run's remembered `session_id` can never re-open it. */
  findLiveBySessionId(sessionId: string): Run | null {
    const r = this.db.prepare(
      `SELECT * FROM runs WHERE session_id = ? AND state IN ('queued', 'running', 'blocked') ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(sessionId) as Row | undefined;
    return r ? toRun(r) : null;
  }
}

/** node:sqlite reports a violated unique index in the message; there is no stable error code to key
 *  on. Narrow on purpose — a different constraint failing must still throw, not read as a collision. */
function isUniqueViolation(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("UNIQUE constraint failed") && m.includes("runs.dedupe_key");
}

/** A cursor that does not parse reads as "no cursor" (first page) — it is opaque client state, and a
 *  stale or mangled one should degrade to a fresh listing, not an error. */
function parseCursor(cursor: string | null): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  if (i <= 0) return null;
  const createdAt = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
}
