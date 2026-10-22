import { basename, join } from "node:path";
import {
  FINAL_REVIEW_STATES, isImageFile, itemTarget, mimeForPath,
  type Run, type Schedule, type Session, type TeamReviewDetail, type TeamReviewItem, type TeamReviewSummary,
} from "@realm/contracts";
import type { MobileResult, ReviewSummary, ScheduledTask } from "@realm/remote";
import { cadenceSentence, runState, runUnread } from "@realm/view";

/**
 * Review and Scheduled as a phone reads them (PROTOCOL.md §8): the desktop's team reviews and
 * scheduled tasks, each made into mobile.v1's row by the desktop's own words — a task's cadence and a
 * run's state as the Scheduled page says them (`@realm/view`), a review's kind and state as the
 * server keeps them.
 */

type ReviewItem = MobileResult<"review.get">["items"][number];

/** Waiting for the person, sent back for changes, or approved and not finished with: every state a
 *  review does not rest in (`FINAL_REVIEW_STATES`). */
export const isOpenReview = (r: Pick<TeamReviewSummary, "state">): boolean => !FINAL_REVIEW_STATES.includes(r.state);

/** Newest first, by when each last changed; by id between two that changed together, so two reads of
 *  the same reviews agree. */
export const newestReviewFirst = (a: TeamReviewSummary, b: TeamReviewSummary): number =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function reviewSummary(r: TeamReviewSummary, spaceName: string): ReviewSummary {
  return {
    id: r.id, spaceId: r.spaceId, spaceName, roleName: r.roleName, title: r.title, kind: r.kind, state: r.state,
    itemCount: r.itemCount, to: r.to ?? null, channels: r.channels, note: r.note, sessionId: r.sessionId, updatedAt: r.updatedAt,
  };
}

/** An item's pictures, each by its path on the Mac: the files `review.file` previews, and no other. */
export function reviewPictures(item: Pick<TeamReviewItem, "files">, root: string | null): ReviewItem["files"] {
  if (!root) return [];
  return item.files.filter(isImageFile).map((f) => ({ path: join(root, f), name: basename(f), mime: mimeForPath(f) }));
}

/**
 * One draft of a review as text: its own words where it has them — a caption, a message, an email —
 * else the text files it is (a document, a table, a diff), which the server already read for the
 * window. An email's subject is its title, as the desktop gives it a line of its own.
 */
export function reviewItem(item: TeamReviewItem, detail: Pick<TeamReviewDetail, "root" | "fileTexts">): ReviewItem {
  const target = itemTarget(item);
  const subject = Object.entries(item.meta ?? {}).find(([k]) => k.toLowerCase() === "subject")?.[1] ?? null;
  const texts = item.files.map((f) => detail.fileTexts?.[f]).filter((t): t is string => t !== undefined);
  return {
    id: item.id, title: subject, body: item.body ?? texts.join("\n\n"),
    channel: target?.channel ?? null, to: target?.to ?? null, files: reviewPictures(item, detail.root),
  };
}

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
