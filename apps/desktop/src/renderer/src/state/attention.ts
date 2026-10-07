import type { Session, SessionStatus } from "@realm/contracts";

/**
 * What a session wants from you, as the sidebar reads it — one vocabulary for every row that draws a
 * session, in this room or another.
 *
 * Pure, so the decisions the rows make (what counts as live, what comes first, what a space's row
 * says about the room behind it) are testable without a DOM.
 */

/** The words a session's state is read out in, after its title (A-L4: the dot alone says nothing to
 *  a reader). */
export const STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;

/** The statuses worth a mark on a row: doing something, waiting on someone, or broken. Idle and ended
 *  are where most of the sidebar rests, and a grey dot on every one of them said nothing — it also hid
 *  the unread ring, which a row only wears when it has no other mark, so the ring could never draw. */
export const MARKED_STATUS: ReadonlySet<string> = new Set(["running", "waiting_permission", "error"]);

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

/** How much a live session needs you: waiting on you, then working, then finished with something
 *  you have not read. Lower comes first. */
export type Attention = 0 | 1 | 2;

/** Null for a session with nothing to show — finished and read, which is where most of them rest. */
export function attentionOf(status: SessionStatus, unread: boolean): Attention | null {
  if (status === "waiting_permission") return 0;
  if (status === "running") return 1;
  return unread ? 2 : null;
}

/** A session as the cross-room rows draw it: the row, with the live facts laid over it. */
export type LiveSession = {
  session: Session;
  status: SessionStatus;
  /** The live space — `sessionSpace` wins over the row's, because a session moved since the list was
   *  read would otherwise be filed under the room it left. */
  spaceId: string;
  unread: boolean;
  attention: Attention;
  /** When it last moved, live (`sessionUpdatedAt`), for the order within a rank. */
  movedAt: number;
};

/**
 * Every live session among `rows`, most urgent first, and within a rank the one that moved most
 * recently first.
 *
 * The status is the LIVE one, never the row's: the row is what the server said when it was listed,
 * and a session that finished since is stale there. A row with no live status is one the window has
 * forgotten (deleted here, or gone from its room's list), and it is not drawn on its row's word.
 */
export function liveSessions(rows: Iterable<Session>, live: {
  status: Readonly<Record<string, SessionStatus>>;
  space: Readonly<Record<string, string>>;
  updatedAt: Readonly<Record<string, number>>;
}): LiveSession[] {
  const out: LiveSession[] = [];
  for (const session of rows) {
    const status = live.status[session.id];
    if (status === undefined) continue;
    const unread = isUnread(session);
    const attention = attentionOf(status, unread);
    if (attention === null) continue;
    out.push({ session, status, unread, attention, spaceId: live.space[session.id] ?? session.spaceId, movedAt: live.updatedAt[session.id] ?? session.updatedAt });
  }
  return out.sort((a, b) => a.attention - b.attention || b.movedAt - a.movedAt);
}

/** What a space's row says about the room behind it: one mark at its far end and how many sessions
 *  share it, and the whole of it in words for the accessible name and the tooltip. */
export type SpaceSummary = {
  mark: "waiting_permission" | "error" | "running" | "unseen" | null;
  count: number;
  /** "2 waiting on you", "1 running", … — most urgent first; empty when nothing is happening. */
  parts: string[];
};

/**
 * The summary of one space.
 *
 * The mark is `badge` — `spaceBadge`'s answer, the one the strip at the foot of the column wears for
 * the same space, so the two can never disagree — and the count is how many sessions are in that
 * state. Where the strip has nothing to say but a session finished with something unread, the row
 * wears the unread ring instead: that is a thing the strip cannot show, and it is what the row's
 * disclosure would open onto.
 */
export function spaceSummary(spaceId: string, badge: "waiting_permission" | "error" | "running" | null, live: {
  status: Readonly<Record<string, SessionStatus>>;
  space: Readonly<Record<string, string>>;
}, sessions: readonly LiveSession[]): SpaceSummary {
  let waiting = 0, running = 0, failed = 0;
  for (const [id, st] of Object.entries(live.status)) {
    if (live.space[id] !== spaceId) continue;
    if (st === "waiting_permission") waiting++;
    else if (st === "running") running++;
    else if (st === "error") failed++;
  }
  const unread = sessions.filter((l) => l.spaceId === spaceId && l.attention === 2).length;
  const parts = [
    waiting > 0 ? `${waiting} waiting on you` : "",
    failed > 0 ? `${failed} failed` : "",
    running > 0 ? `${running} running` : "",
    unread > 0 ? `${unread} unread` : "",
  ].filter(Boolean);
  if (badge === "waiting_permission") return { mark: badge, count: waiting, parts };
  if (badge === "error") return { mark: badge, count: failed, parts };
  if (badge === "running") return { mark: badge, count: running, parts };
  return unread > 0 ? { mark: "unseen", count: unread, parts } : { mark: null, count: 0, parts };
}
