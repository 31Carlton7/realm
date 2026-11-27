import { isOnce, machineZone, newId, nextFireOf, slotOf, type RunConstraints, type Schedule } from "@realm/contracts";
import type { Db } from "../db/database";
import { now } from "./rows";

type Row = {
  id: string; space_id: string; title: string; goal: string; cron: string; enabled: number;
  constraints_json: string | null; next_run_at: number | null; last_run_at: number | null;
  last_run_id: string | null; last_skipped_at: number | null;
  new_session_per_run: number; archive_succeeded: number; created_at: number; updated_at: number;
  role_id: string | null; permission_mode: string | null;
  time_zone: string | null; last_slot: string | null; created_by_session: string | null;
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
  newSessionPerRun: r.new_session_per_run === 1, archiveSucceeded: r.archive_succeeded === 1,
  roleId: r.role_id ?? null, permissionMode: r.permission_mode ?? null, createdBySession: r.created_by_session ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export type ScheduleInsert = {
  spaceId: string; title: string; goal: string; cron: string; enabled: boolean; constraints: RunConstraints | null;
  newSessionPerRun: boolean; archiveSucceeded: boolean;
  /** The teammate whose clock this is (`TeammateSchedule`). */
  roleId?: string | null;
  /** What its runs start in (`Schedule.permissionMode`); a teammate's clock has none. */
  permissionMode?: string | null;
  /** The session whose agent made it (`Schedule.createdBySession`); the person's own make none. */
  createdBySession?: string | null;
};

export type ScheduleUpdate = {
  spaceId?: string; title?: string; goal?: string; cron?: string; enabled?: boolean; constraints?: RunConstraints | null;
  newSessionPerRun?: boolean; archiveSucceeded?: boolean; permissionMode?: string;
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
 *
 * Every next occurrence is computed in the zone on the row (`time_zone`), never in whatever zone the
 * process happens to be in, and never into a slot at or before the one the row last fired
 * (`last_slot`, see `slotOf`). When the Mac's zone changes, the next tick re-anchors each row to the
 * new zone without firing it.
 */
export class SchedulesStore {
  constructor(private db: Db, private clock: () => number = now, private zone: () => string = machineZone) {}

  /** A space's schedules. A teammate's clock (`role_id`) is its page's to show, not this list's. */
  list(spaceId: string): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules WHERE space_id = ? AND role_id IS NULL ORDER BY created_at DESC, id DESC").all(spaceId) as Row[]).map(toSchedule);
  }

  /** The clocks of a space's teammates still in its Team list, oldest first. */
  clocks(spaceId: string): Schedule[] {
    return (this.db.prepare(`SELECT * FROM schedules WHERE space_id = ? AND role_id IN (SELECT id FROM team_roles WHERE archived = 0)
      ORDER BY created_at, id`).all(spaceId) as Row[]).map(toSchedule);
  }

  /** A teammate's clock. The first Teams kept one per role; should there be more, the oldest is it. */
  forRole(roleId: string): Schedule | null {
    const r = this.db.prepare("SELECT * FROM schedules WHERE role_id = ? ORDER BY created_at, id LIMIT 1").get(roleId) as Row | undefined;
    return r ? toSchedule(r) : null;
  }

  get(id: string): Schedule | null {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r ? toSchedule(r) : null;
  }

  create(input: ScheduleInsert): Schedule {
    const ts = this.clock();
    const zone = this.zone();
    const id = newId();
    // A disabled schedule has no next occurrence, and neither does one whose expression matches
    // nothing ahead. Both are `null`, and the page reads that column to say "paused" / "never".
    const next = input.enabled ? nextFireOf(input.cron, ts, zone) : null;
    this.db.prepare(`INSERT INTO schedules (id, space_id, title, goal, cron, enabled, constraints_json,
        next_run_at, last_run_at, last_run_id, last_skipped_at, new_session_per_run, archive_succeeded, role_id, permission_mode,
        time_zone, created_by_session, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.spaceId, input.title, input.goal, input.cron, input.enabled ? 1 : 0,
        input.constraints ? JSON.stringify(input.constraints) : null, next,
        input.newSessionPerRun ? 1 : 0, input.archiveSucceeded ? 1 : 0, input.roleId ?? null, input.permissionMode ?? null, zone,
        input.createdBySession ?? null, ts, ts);
    return this.get(id)!;
  }

  /**
   * Apply an edit and re-derive the next occurrence from the result.
   *
   * The recompute is unconditional rather than gated on `cron` or `enabled` having changed: it is a
   * pure function of two columns this row now holds, and a gate is a place for the two to drift
   * apart. Re-enabling a schedule whose last computed occurrence is in the past is exactly the case
   * a gate would miss.
   *
   * Re-arming from now never lands on a slot the row already fired. In one zone every such slot is
   * behind now anyway; after the Mac moves west it is not, and "today at nine" is still ahead.
   */
  update(id: string, patch: ScheduleUpdate): Schedule | null {
    const before = this.get(id);
    if (!before) return null;
    const { last_slot: lastSlot } = this.db.prepare("SELECT last_slot FROM schedules WHERE id = ?").get(id) as Pick<Row, "last_slot">;
    const ts = this.clock();
    const zone = this.zone();
    const next: Schedule = {
      ...before,
      ...(patch.spaceId !== undefined ? { spaceId: patch.spaceId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.constraints !== undefined ? { constraints: patch.constraints } : {}),
      ...(patch.newSessionPerRun !== undefined ? { newSessionPerRun: patch.newSessionPerRun } : {}),
      ...(patch.archiveSucceeded !== undefined ? { archiveSucceeded: patch.archiveSucceeded } : {}),
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
    };
    this.db.prepare(`UPDATE schedules SET space_id = ?, title = ?, goal = ?, cron = ?, enabled = ?, constraints_json = ?,
        new_session_per_run = ?, archive_succeeded = ?, permission_mode = ?, next_run_at = ?, time_zone = ?, updated_at = ? WHERE id = ?`)
      .run(next.spaceId, next.title, next.goal, next.cron, next.enabled ? 1 : 0,
        next.constraints ? JSON.stringify(next.constraints) : null,
        next.newSessionPerRun ? 1 : 0, next.archiveSucceeded ? 1 : 0, next.permissionMode,
        next.enabled ? nextAfterSlot(next.cron, ts, zone, lastSlot) : null, zone, ts, id);
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
   *
   * A teammate's clock is claimed while its teammate is in the list. An archived one's stays where it
   * was, unclaimed, and is re-armed from now if the teammate comes back (`TeammatesService.archive`).
   *
   * The claim also records the occurrence's slot, and is dropped when that slot is at or before the
   * one the row last fired: the dedupe key for a teammate's clock, which makes no run for the run
   * layer's own key to catch.
   */
  claimDue(at: number): { schedule: Schedule; dueAt: number }[] {
    const zone = this.zone();
    this.reanchor(at, zone);
    const rows = this.db.prepare(
      `SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        AND (role_id IS NULL OR role_id IN (SELECT id FROM team_roles WHERE archived = 0)) ORDER BY next_run_at`,
    ).all(at) as Row[];
    const claimed: { schedule: Schedule; dueAt: number }[] = [];
    for (const r of rows) {
      const slot = slotOf(r.next_run_at!, zone);
      const repeat = !isOnce(r.cron) && r.last_slot !== null && slot <= r.last_slot;
      const lastSlot = repeat ? r.last_slot : slot;
      const advance = this.db.prepare(
        "UPDATE schedules SET next_run_at = ?, last_slot = ?, updated_at = ? WHERE id = ? AND next_run_at = ?",
      ).run(nextFireOf(r.cron, at, zone), lastSlot, at, r.id, r.next_run_at);
      // Zero rows changed means another tick got there first. Dropping the claim is the whole point.
      if (advance.changes === 0 || repeat) continue;
      claimed.push({ schedule: toSchedule(r), dueAt: r.next_run_at! });
    }
    return claimed;
  }

  /**
   * Move every row computed in another zone onto `zone`, without firing any of them.
   *
   * A row with no zone was written before rows had one, and its `next_run_at` was computed in the
   * zone the Mac is in now: it takes that zone as it stands, and its last slot is read off
   * `last_run_at`. A row in another zone is the Mac having moved: its next occurrence is recomputed
   * from now, in the new zone, past the slot it last fired. An occurrence that was already due and
   * does not survive the move is recorded as skipped, as a missed one is.
   */
  private reanchor(at: number, zone: string): void {
    const rows = this.db.prepare("SELECT * FROM schedules WHERE time_zone IS NULL OR time_zone <> ?").all(zone) as Row[];
    for (const r of rows) {
      if (r.time_zone === null) {
        this.db.prepare("UPDATE schedules SET time_zone = ?, last_slot = ? WHERE id = ?")
          .run(zone, r.last_run_at === null ? null : slotOf(r.last_run_at, zone), r.id);
        continue;
      }
      // A one-shot's moment is an instant, the same in every zone.
      if (r.enabled !== 1 || r.next_run_at === null || isOnce(r.cron)) {
        this.db.prepare("UPDATE schedules SET time_zone = ? WHERE id = ?").run(zone, r.id);
        continue;
      }
      const next = nextAfterSlot(r.cron, at, zone, r.last_slot);
      const dropped = r.next_run_at <= at && (next === null || slotOf(next, zone) !== slotOf(r.next_run_at, r.time_zone));
      this.db.prepare("UPDATE schedules SET time_zone = ?, next_run_at = ?, last_skipped_at = ?, updated_at = ? WHERE id = ?")
        .run(zone, next, dropped ? at : r.last_skipped_at, at, r.id);
    }
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

/** The first occurrence after `after` in `zone` whose slot is later than `lastSlot`. A one-shot has
 *  one moment and no slots to repeat, so it is only ever "after". */
function nextAfterSlot(cron: string, after: number, zone: string, lastSlot: string | null): number | null {
  let next = nextFireOf(cron, after, zone);
  if (lastSlot === null || isOnce(cron)) return next;
  while (next !== null && slotOf(next, zone) <= lastSlot) next = nextFireOf(cron, next, zone);
  return next;
}
