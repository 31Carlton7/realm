import { AGENT_FAST_MODE, cadenceOf, cronOf, parseOnce, type AgentKind, type Run, type RunConstraints, type Schedule, type Session, type Teammate } from "@realm/contracts";
import { TASK_ERROR_MAX, type ScheduledTask, type SuggestedTask, type TaskCadence } from "@realm/remote";
import { FALLBACK_AGENT, SUGGESTIONS, cadenceSentence, runState, runUnread } from "@realm/view";

/**
 * Scheduled as a phone reads it (PROTOCOL.md §8): the desktop's scheduled tasks, each made into
 * mobile.v1's row by the desktop's own words — a task's cadence and a run's state as the Scheduled
 * page says them (`@realm/view`).
 */

/** A succeeded run wears no word on the Scheduled page, where it is the ordinary case; a phone's row
 *  says what the space's Tasks list says of it. */
const FINISHED = "Finished";

/** An expression in the Repeat rows' terms, by the desktop's own reading of it. */
export function taskCadence(cron: string): TaskCadence {
  const at = parseOnce(cron);
  if (at !== null) return { repeat: "once", at };
  return cadenceOf(cron) ?? { repeat: "custom" };
}

/** What the Scheduled page suggests, each with the Repeat rows it opens the sheet on. */
export function suggestedTasks(): SuggestedTask[] {
  return SUGGESTIONS.map(({ title, blurb, goal, every, time, weekday }) => {
    const [hour, minute] = time.split(":").map(Number) as [number, number];
    const clock = { hour, minute };
    const cron = every === "weekly" ? cronOf({ repeat: every, weekday: weekday ?? 1, ...clock })
      : every === "monthly" ? cronOf({ repeat: every, day: 1, ...clock })
      : every === "hourly" ? cronOf({ repeat: every, minute })
      : cronOf({ repeat: every, ...clock });
    return { title, blurb, goal, cadence: taskCadence(cron) };
  });
}

/** A teammate's clock as the row in `schedules` it is: its title is the teammate's name, and what it is
 *  told is the prompt. */
export function checkInOf(t: Teammate): Schedule | null {
  const clock = t.schedule;
  if (!clock) return null;
  return {
    id: clock.id, spaceId: t.spaceId, title: t.name, goal: clock.prompt, cron: clock.cron, enabled: clock.enabled, constraints: null,
    nextRunAt: clock.nextRunAt, lastRunAt: clock.lastRunAt, lastRunId: null, lastSkippedAt: clock.lastSkippedAt,
    newSessionPerRun: false, archiveSucceeded: false, roleId: t.id, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

/**
 * The run constraints a task's sheet asks for, laid over what the task carried, as the desktop's sheet
 * lays them (`constraintsOf`): anything else its runs were given stays, and a permission it still holds
 * goes, since every scheduled run is Full access. Fast mode is not on the phone's sheet, so it stays while
 * the agent can be asked for it.
 */
export function taskConstraints(before: RunConstraints | null, agentKind: AgentKind, model: string | null, effort: string | null): RunConstraints {
  const { model: _model, effort: _effort, fastMode, permissionMode: _permission, ...kept } = before ?? {};
  return {
    ...kept, agentKind,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode && AGENT_FAST_MODE[agentKind] ? { fastMode } : {}),
  };
}

const cut = (text: string): string => (text.length <= TASK_ERROR_MAX ? text : `${text.slice(0, TASK_ERROR_MAX - 1).trimEnd()}…`);

/** A task, with how its last run went: the run `lastRunId` names, and that run's session for whether it
 *  has been read. */
export function scheduledTask(s: Schedule, spaceName: string, run: Run | null, session: Session | undefined, now = Date.now()): ScheduledTask {
  return {
    id: s.id, spaceId: s.spaceId, spaceName, title: s.title, when: cadenceSentence(s.cron, now), enabled: s.enabled,
    nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt,
    lastRun: run ? { state: runState(run)?.label ?? FINISHED, sessionId: run.sessionId, unread: runUnread(session), error: run.error ? cut(run.error) : null } : null,
    goal: s.goal, cron: s.cron, cadence: taskCadence(s.cron),
    agentKind: s.roleId !== null ? null : s.constraints?.agentKind ?? FALLBACK_AGENT, model: s.constraints?.model ?? null, effort: s.constraints?.effort ?? null,
    newSessionPerRun: s.newSessionPerRun, archiveSucceeded: s.archiveSucceeded, lastSkippedAt: s.lastSkippedAt, teammateId: s.roleId,
  };
}
