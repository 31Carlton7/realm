import {
  CreateScheduleSchema, SCHEDULE_CATCHUP_MS, SCHEDULE_TICK_MS, isOnce, isRunLive, nextFireOf, parseOnce,
  type CreateScheduleInput, type Run, type Schedule, type UpdateScheduleInput,
} from "@realm/contracts";
import type { SchedulesStore } from "../store/schedules";
import type { RunService } from "../runs/service";
import type { RpcServer } from "../rpc/server";
import { NotFoundError, RpcError } from "../store/rows";

/** The dedupe key a firing hands `runs.create`. Scoped to the schedule and the occurrence, so the
 *  same minute can never open two runs even if the claim and the retry both got through — and so a
 *  LATER occurrence of the same schedule is a different key and is free to run while the first is
 *  still going, which is the honest reading of "every hour". */
const dedupeKeyFor = (scheduleId: string, dueAt: number) => `schedule:${scheduleId}:${dueAt}`;

/**
 * Scheduled tasks: work Realm starts on a clock.
 *
 * **It owns a timer, and the runs service deliberately does not.** That comment in `runs/service.ts`
 * is about a poll standing in for state — a drain loop that a restart silently loses. This timer is
 * the opposite shape: every fact it acts on is a column (`next_run_at`), the claim is a write, and a
 * restart replays from the row rather than from anything the process was holding. Kill the app
 * mid-tick and the worst case is a schedule that fires once when it comes back.
 *
 * **A firing creates a RUN and stops there.** Attempts, the human gate, worktrees, restart recovery
 * and the refusal of `bypassPermissions` are all `RunService`'s, already built and already tested. A
 * scheduler that dispatched sessions itself would be a second, worse answer to every one of those.
 *
 * **A missed firing is either caught up or admitted.** A Mac sleeps. A daily schedule on a laptop
 * that woke five hours late runs once (inside `SCHEDULE_CATCHUP_MS`); one that woke five days late
 * does not, and the row records `lastSkippedAt` so the page can say so. Running every missed
 * occurrence would start a week of agents at once, and running none would make schedules useless on
 * a machine that is not always on — neither is a thing to do silently.
 *
 * **A one-shot is the exception, and runs however late it is.** The catch-up window exists to stop a
 * recurring schedule stampeding after a long sleep, and a one-shot cannot stampede: it has exactly
 * one occurrence, so the only thing the window could do is drop it. "In two weeks, open the PR"
 * dropped because the lid was shut on the day is the failure this whole feature would be judged on,
 * and firing it late — visibly, with the run in the Tasks lens — is the better of the two answers.
 */
export class ScheduleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(private readonly d: {
    store: SchedulesStore;
    runs: Pick<RunService, "create" | "latestForSchedule">;
    rpc: Pick<RpcServer, "broadcast">;
    /** Put a session away, or bring it back — its sidebar row's archive flag (`runSettled`). */
    archiveSession?: (sessionId: string, archived: boolean) => void;
    /** Whether a space exists, for an edit that moves a schedule into one. */
    spaceExists?: (spaceId: string) => boolean;
    /** Why a team role's clock may not fire now (its week's budget is spent), or null. A refused
     *  firing is recorded as a skip, like a missed one — unattended work that did not happen is
     *  written down. */
    refuse?: (schedule: Schedule) => string | null;
    /** Test seam only — production leaves this alone and uses the real clock. */
    clock?: () => number;
  }) {}

  private now(): number { return this.d.clock ? this.d.clock() : Date.now(); }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  /**
   * Start ticking, catching up first.
   *
   * The catch-up is `tick()` itself rather than a separate boot path: a schedule that came due while
   * the app was closed is a DUE schedule, and the same claim-then-decide logic that handles a
   * sleeping laptop handles a closed one. A second code path for boot would be a second place for
   * the catch-up window to be applied differently.
   */
  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), SCHEDULE_TICK_MS);
    // Node keeps the process alive for a pending interval; a scheduler should not be the reason a
    // shutdown hangs. The server's own listener is what holds the process open.
    this.timer.unref?.();
  }

  close(): void {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /* ── the tick ──────────────────────────────────────────────────────────── */

  /**
   * Fire everything that has come due.
   *
   * Public because the tests drive it directly and because `runNow` shares its firing path — never
   * because anything in production calls it on demand. A firing that throws (a run whose constraints
   * no longer resolve — a deleted environment, a skill that has gone) must not take the tick down
   * with it and leave every later schedule unfired, so each one is caught and recorded.
   */
  tick(): void {
    if (this.closing) return;
    const at = this.now();
    for (const { schedule, dueAt } of this.d.store.claimDue(at)) {
      // Too old to be worth starting. The occurrence is already advanced past by the claim, so this
      // is genuinely a skip rather than a deferral — and it is written down, because unattended work
      // that quietly did not happen is the worst thing this feature could do.
      //
      // A one-shot is never old enough: the window guards against a backlog, and a schedule with one
      // occurrence has no backlog to guard against. See the class comment.
      if (!isOnce(schedule.cron) && at - dueAt > SCHEDULE_CATCHUP_MS) {
        this.d.store.recordFiring(schedule.id, { at, runId: null, skipped: true });
        this.announce(schedule.spaceId);
        continue;
      }
      try {
        this.fire(schedule, dueAt, at);
      } catch (e) {
        // The firing failed at CREATE — bad constraints, a space that has gone. The schedule stays
        // alive on its next occurrence (already claimed) and the failure is recorded as a skip, so
        // the row does not claim a run it never made.
        this.d.store.recordFiring(schedule.id, { at, runId: null, skipped: true });
        this.announce(schedule.spaceId);
        void e;
      }
    }
  }

  /**
   * One firing: create the run, record what it produced, tell the clients.
   *
   * A schedule that continues one session hands the run the session its last run left, and is the
   * one case a firing can be refused for something other than age: while that run is still live —
   * working, or `blocked` on a person — the session is mid-conversation, and a second turn sent into
   * it would be settled as the first one's answer. The occurrence is skipped and written down, like a
   * missed one, rather than forking the conversation the schedule was asked to keep.
   */
  private fire(schedule: Schedule, dueAt: number, at: number): void {
    if (schedule.roleId && this.d.refuse?.(schedule)) {
      this.d.store.recordFiring(schedule.id, { at, runId: null, skipped: true });
      this.announce(schedule.spaceId);
      return;
    }
    let sessionId: string | null = null;
    if (!schedule.newSessionPerRun) {
      const last = this.d.runs.latestForSchedule(schedule.id);
      if (last && isRunLive(last.state)) {
        this.d.store.recordFiring(schedule.id, { at, runId: null, skipped: true });
        this.announce(schedule.spaceId);
        return;
      }
      // A session belongs to a space, so a schedule moved since its last run starts afresh there.
      sessionId = last?.spaceId === schedule.spaceId ? last.sessionId : null;
    }
    const { run } = this.d.runs.create({
      spaceId: schedule.spaceId,
      goal: schedule.goal,
      title: schedule.title,
      constraints: schedule.constraints,
      dedupeKey: dedupeKeyFor(schedule.id, dueAt),
      // One attempt. A schedule IS the retry policy — the next occurrence is the next try — and
      // stacking `maxAttempts` on top of a recurrence means a flaky goal on an hourly schedule can
      // have several runs of itself alive at once.
      maxAttempts: 1,
      // No deadline: a run's bound is wall-clock and a schedule has no opinion about how long its
      // work should take. Cancelling one is a thing a person does, in the runs list.
      deadlineAt: null,
      scheduleId: schedule.id,
      sessionId,
      ...(schedule.roleId ? { roleId: schedule.roleId, wokeOn: "schedule" } : {}),
    });
    this.d.store.recordFiring(schedule.id, { at, runId: run.id, skipped: false });
    this.announce(schedule.spaceId);
  }

  /**
   * A run this schedule fired is over. With "archive successful runs" on, a success puts its session
   * away and anything else brings it back — so a schedule that continues one session shows it again
   * the moment a run in it fails, which is the run a person has to come back to.
   */
  runSettled(run: Run): void {
    if (!run.scheduleId || !run.sessionId) return;
    const schedule = this.d.store.get(run.scheduleId);
    if (!schedule?.archiveSucceeded) return;
    this.d.archiveSession?.(run.sessionId, run.state === "succeeded");
  }

  /* ── the API ───────────────────────────────────────────────────────────── */

  list(spaceId: string): Schedule[] { return this.d.store.list(spaceId); }

  create(input: CreateScheduleInput): Schedule {
    const parsed = CreateScheduleSchema.parse(input);
    // Validated HERE, not at fire time. A schedule whose expression cannot be parsed would sit in
    // the list looking armed and never fire — the failure would be invisible until someone noticed
    // the work had not happened, which for unattended work can be weeks.
    if (nextFireOf(parsed.cron, this.now()) === null) throw this.unfireable(parsed.cron);
    const made = this.d.store.create(parsed);
    this.announce(made.spaceId);
    return made;
  }

  /** A team role's clock: an ordinary schedule, tagged with the role so its firings run as the role. */
  createForRole(input: CreateScheduleInput, roleId: string): Schedule {
    const parsed = CreateScheduleSchema.parse(input);
    if (nextFireOf(parsed.cron, this.now()) === null) throw this.unfireable(parsed.cron);
    const made = this.d.store.create({ ...parsed, roleId });
    this.announce(made.spaceId);
    return made;
  }

  forRole(roleId: string): Schedule | null { return this.d.store.forRole(roleId); }

  update(input: UpdateScheduleInput): Schedule {
    const before = this.d.store.get(input.id);
    if (!before) throw new NotFoundError("schedule", input.id);
    // Same gate as create, against the expression the edit would LEAVE behind rather than the one it
    // sent: an edit that only flips `enabled` must not be re-validated into a failure, and an edit
    // that changes the expression must be.
    const cron = input.cron ?? before.cron;
    if (nextFireOf(cron, this.now()) === null) throw this.unfireable(cron);
    if (input.spaceId !== undefined && input.spaceId !== before.spaceId && this.d.spaceExists && !this.d.spaceExists(input.spaceId))
      throw new NotFoundError("space", input.spaceId);
    const next = this.d.store.update(input.id, input)!;
    // A move is a change to BOTH spaces' lists: the old one loses the row, the new one gains it.
    if (next.spaceId !== before.spaceId) this.announce(before.spaceId);
    this.announce(next.spaceId);
    return next;
  }

  remove(id: string): boolean {
    const before = this.d.store.get(id);
    if (!before) return false;
    const gone = this.d.store.remove(id);
    if (gone) this.announce(before.spaceId);
    return gone;
  }

  /**
   * Run a schedule now, without disturbing its clock.
   *
   * `next_run_at` is deliberately untouched: "run this now" is a thing a person does to see whether
   * the goal works, and having it silently push tomorrow's 9am firing to tomorrow-plus-a-bit would
   * be a surprising cost for a button that looks like a preview. The dedupe key is keyed on the
   * manual moment rather than on an occurrence, so it can never collide with a real firing's.
   */
  runNow(id: string): Schedule {
    const schedule = this.d.store.get(id);
    if (!schedule) throw new NotFoundError("schedule", id);
    // The clock records a skip when the conversation is still busy; a person who clicked is told.
    const last = schedule.newSessionPerRun ? null : this.d.runs.latestForSchedule(id);
    if (last && isRunLive(last.state))
      throw new RpcError("SCHEDULE_BUSY", "this task continues one session, and its last run is still going — let it finish, or start each run in a new session");
    const at = this.now();
    this.fire(schedule, at, at);
    return this.d.store.get(id)!;
  }

  /** Why an expression was refused, in the terms of the spelling it was written in. A one-shot in
   *  the past is not a malformed expression and telling its author to "check the five fields" sends
   *  them looking for a syntax error in a date that is simply behind them. */
  private unfireable(expr: string): RpcError {
    const once = parseOnce(expr);
    return new RpcError("SCHEDULE_CRON", once !== null
      ? `${new Date(once).toLocaleString()} has already passed — a one-shot can only be scheduled ahead of now`
      : `\`${expr}\` is not a schedule that will ever run — check the expression`);
  }

  private announce(spaceId: string): void {
    this.d.rpc.broadcast("schedules.changed", { spaceId });
  }
}
