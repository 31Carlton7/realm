import type { Run, Schedule, Session } from "@realm/contracts";
import type { ScheduledTask } from "@realm/remote";
import { cadenceSentence, runState, runUnread } from "@realm/view";

/**
 * Scheduled as a phone reads it (PROTOCOL.md §8): the desktop's scheduled tasks, each made into
 * mobile.v1's row by the desktop's own words — a task's cadence and a run's state as the Scheduled
 * page says them (`@realm/view`).
 */

/** A succeeded run wears no word on the Scheduled page, where it is the ordinary case; a phone's row
 *  says what the space's Tasks list says of it. */
const FINISHED = "Finished";

/** A task, with how its last run went: the run `lastRunId` names, and that run's session for whether it
 *  has been read. */
export function scheduledTask(s: Schedule, spaceName: string, run: Run | null, session: Session | undefined, now = Date.now()): ScheduledTask {
  return {
    id: s.id, spaceId: s.spaceId, spaceName, title: s.title, when: cadenceSentence(s.cron, now), enabled: s.enabled,
    nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt,
    lastRun: run ? { state: runState(run)?.label ?? FINISHED, sessionId: run.sessionId, unread: runUnread(session) } : null,
  };
}
