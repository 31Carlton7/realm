import type { Session, SessionStatus } from "@realm/contracts";

/**
 * What a session wants from you, as the sidebar reads it — one vocabulary for every row that draws a
 * session, in this room or another.
 *
 * Pure, so the decisions the rows make (what counts as unread, which mark a row wears) are testable
 * without a DOM.
 */

/** The words a session's state is read out in, after its title (A-L4: the dot alone says nothing to
 *  a reader). */
export const STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;

/**
 * Something happened in this session that you have not read: its log has been written past the mark
 * its pane last stamped while it had the keyboard.
 *
 * A session never opened (`seenSeq` 0) has missed nothing. The mark is a claim about what you read,
 * and until the first open there is no such claim to make (`SessionSchema.seenSeq`).
 */
export function isUnread(row: Pick<Session, "seenSeq" | "lastEventSeq">): boolean {
  return row.seenSeq > 0 && row.lastEventSeq > row.seenSeq;
}

/** The mark a session row wears at its far end, and the words it is read out in: its state when that
 *  is worth a mark, else the unread ring, else nothing. Two marks on one row would ask a reader to
 *  tell "this is running" from "this said something" at four pixels. */
export function sessionMark(status: SessionStatus | undefined, unread: boolean):
  { mark: "running" | "waiting_permission" | "error" | "unseen"; label: string } | null {
  if (status === "running" || status === "waiting_permission" || status === "error") return { mark: status, label: STATUS_LABEL[status] };
  return unread ? { mark: "unseen", label: "new since you were here" } : null;
}
