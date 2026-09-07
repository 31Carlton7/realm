import { newId, nextFireOf, type RunConstraints, type Schedule } from "@realm/contracts";
import type { Db } from "../db/database";
import { now } from "./rows";

type Row = {
  id: string; space_id: string; title: string; goal: string; cron: string; enabled: number;
  constraints_json: string | null; next_run_at: number | null; last_run_at: number | null;
  last_run_id: string | null; last_skipped_at: number | null; created_at: number; updated_at: number;
};

/** A constraints blob that does not parse reads as "no constraints" rather than throwing — the same
 *  posture `store/runs.ts` takes, and for the same reason: a corrupt JSON column should degrade the
 *  schedule to the defaults, not make the row unreadable and the schedule uneditable. */
function parseConstraints(json: string | null): RunConstraints | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as RunConstraints) : null;
  } catch { return null; }
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id, spaceId: r.space_id, title: r.title, goal: r.goal, cron: r.cron, enabled: r.enabled === 1,
  constraints: parseConstraints(r.constraints_json),
  nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastRunId: r.last_run_id, lastSkippedAt: r.last_skipped_at,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export type ScheduleInsert = {
  spaceId: string; title: string; goal: string; cron: string; enabled: boolean; constraints: RunConstraints | null;
};

export type ScheduleUpdate = {
  title?: string; goal?: string; cron?: string; enabled?: boolean; constraints?: RunConstraints | null;
};

/**
 * The `schedules` table.
 *
 * Two things are this store's own rather than the service's, because both have to be atomic:
 *
 *  - **`create` and `update`** derive `next_run_at` from the expression themselves. Between them and
 *    `claimDue` there are three writers of that column and no others, so "when is this next" is
 *    never a thing a caller has to remember to recompute.
 *  - **`claimDue`** reads the due rows and advances them in the same breath. Without that, two ticks
 *    arriving together — a timer firing while a boot catch-up is still running — would both see the
 *    same schedule as due and create two runs from it. The run layer's dedupe key is a second net,
 *    but a scheduler that relies on it to not double-fire has a bug it is asking someone else to
 *    absorb.
 */
export class SchedulesStore {
  constructor(private db: Db, private clock: () => number = now) {}

  list(spaceId: string): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules WHERE space_id = ? ORDER BY created_at DESC, id DESC").all(spaceId) as Row[]).map(toSchedule);
  }

  get(id: string): Schedule | null {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r ? toSchedule(r) : null;
  }

  create(input: ScheduleInsert): Schedule {
    const ts = this.clock();
    const id = newId();
    // A disabled schedule has no next occurrence, and neither does one whose expression matches
    // nothing ahead. Both are `null`, and the page reads that column to say "paused" / "never".
    const next = input.enabled ? nextFireOf(input.cron, ts) : null;
    this.db.prepare(`INSERT INTO schedules (id, space_id, title, goal, cron, enabled, constraints_json,
        next_run_at, last_run_at, last_run_id, last_skipped_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
      .run(id, input.spaceId, input.title, input.goal, input.cron, input.enabled ? 1 : 0,
        input.constraints ? JSON.stringify(input.constraints) : null, next, ts, ts);
    return this.get(id)!;
  }

  /**
   * Apply an edit and re-derive the next occurrence from the result.
   *
   * The recompute is unconditional rather than gated on `cron` or `enabled` having changed: it is a
   * pure function of two columns this row now holds, and a gate is a place for the two to drift
   * apart. Re-enabling a schedule whose last computed occurrence is in the past is exactly the case
   * a gate would miss.
   */
  update(id: string, patch: ScheduleUpdate): Schedule | null {
    const before = this.get(id);
    if (!before) return null;
    const ts = this.clock();
    const next: Schedule = {
      ...before,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {}),
    };
    this.db.prepare(`UPDATE schedules SET title = ?, goal = ?, cron = ?, enabled = ?, constraints_json = ?,
        next_run_at = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.goal, next.cron, next.enabled ? 1 : 0,
        next.constraints ? JSON.stringify(next.constraints) : null,
        next.enabled ? nextFireOf(next.cron, ts) : null, ts, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Every enabled schedule whose `next_run_at` has arrived, advanced past it in the same call.
   *
   * The advance is what makes this a CLAIM. Each row's new `next_run_at` is computed from `at` — the
   * tick's own clock — rather than from the occurrence that just came due, so a machine that slept
   * through a week of daily firings lands on tomorrow rather than walking forward one day per tick
   * for a week. The occurrence that was due is returned to the caller as `dueAt`, which is what lets
   * the service decide whether it is fresh enough to actually run (SCHEDULE_CATCHUP_MS) or should be
   * recorded as skipped.
   *
   * A schedule whose expression no longer has a next occurrence is advanced to `null`: it has fired
   * its last time and will not be seen again, which is the honest end state for `0 9 29 2 *` in the
   * year 2100 and for anything the parser now refuses.
   */
  claimDue(at: number): { schedule: Schedule; dueAt: number }[] {
    const rows = this.db.prepare(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
    ).all(at) as Row[];
    const claimed: { schedule: Schedule; dueAt: number }[] = [];
    for (const r of rows) {
      const advance = this.db.prepare(
        "UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?",
      ).run(nextFireOf(r.cron, at), at, r.id, r.next_run_at);
      // Zero rows changed means another tick got there first. Dropping the claim is the whole point.
      if (advance.changes === 0) continue;
      claimed.push({ schedule: toSchedule(r), dueAt: r.next_run_at! });
    }
    return claimed;
  }

  /** Record what a firing did. `runId` null with `skipped` true is a firing the catch-up window
   *  refused; the two are never both set, because a firing either ran or did not. */
  recordFiring(id: string, input: { at: number; runId: string | null; skipped: boolean }): void {
    if (input.skipped) {
      this.db.prepare("UPDATE schedules SET last_skipped_at = ?, updated_at = ? WHERE id = ?").run(input.at, input.at, id);
      return;
    }
    this.db.prepare("UPDATE schedules SET last_run_at = ?, last_run_id = ?, last_skipped_at = NULL, updated_at = ? WHERE id = ?")
      .run(input.at, input.runId, input.at, id);
  }
}
