import type { Item, Profile, Session, SessionStatus, Space } from "@realm/contracts";
import { isUnread, STATUS_LABEL } from "../../state/attention";
import { spaceActivity } from "../../state/store";
import { CHILD_ORIGINS } from "../../panes/session-labels";
import { groupByDay, type DayGroup } from "./chat-feed";

/**
 * What the sidebar draws, as pure functions over slices of the store (Plan 27).
 *
 * The sidebar lists SESSIONS, from every space at once: Needs you across every space and profile,
 * the active profile's spaces as sections, and the same sessions by time under Recent. Nothing here
 * reads the store or the clock, so each decision — what counts as waiting, what a fan-out is, what a
 * section says about its space — is testable without a DOM.
 */

/** The store slices every derivation below reads. */
export type SidebarState = {
  spaces: readonly Space[];
  profiles: readonly Profile[];
  /** The profile this window shows. Its own lists (`items`, `sessions`) carry every space of it. */
  activeProfileId: string | null;
  activeSpaceId: string | null;
  /** Every space of the window's profile, as this window holds them, archived rows included. */
  items: readonly Item[];
  /** Every space's items, as `items.listAll` answers: archived rows are already left out. */
  allItems: readonly Item[];
  /** The active space's session rows (fresher than `allSessions` for that space). */
  sessions: Readonly<Record<string, Session>>;
  allSessions: Readonly<Record<string, Session>>;
  sessionStatus: Readonly<Record<string, SessionStatus>>;
  sessionSpace: Readonly<Record<string, string>>;
  sessionUpdatedAt: Readonly<Record<string, number>>;
  /** The quick chat's session, which belongs to no list. */
  quickChatId: string | null;
};

/** How many rows a section shows before "Show more". */
export const SECTION_ROWS = 5;

/**
 * How close together a fan-out's sessions are made. A batch was made one session after another (a
 * worktree, then the session, then the brief), so siblings land seconds apart; a minute is generous
 * for twelve worktrees on a large repository and still far shorter than the gap between two
 * dispatches a person makes by hand.
 */
export const FAN_OUT_GAP_MS = 60_000;

/** One session drawn as a sidebar row. */
export type SessionRow = {
  kind: "session";
  /** The session's id. */
  id: string;
  item: Item;
  /** The session's row, when this window holds one. */
  session: Session | undefined;
  /** The item's title: what a rename in the sidebar or a pane bar changes. */
  title: string;
  spaceId: string;
  status: SessionStatus | undefined;
  unread: boolean;
  /** Started by a schedule (a durable run's session). */
  scheduled: boolean;
  /** When it last moved, live. */
  at: number;
  createdAt: number;
};

/** A fan-out's sessions, drawn as ONE row that unfolds to them. */
export type FanOutRow = {
  kind: "fan-out";
  id: string;
  /** The first session's title — the brief the batch was started on. */
  title: string;
  spaceId: string;
  /** Newest first. */
  sessions: SessionRow[];
  at: number;
  tally: Tally;
};

export type ListRow = SessionRow | FanOutRow;

/** What is going on among some sessions, by state. */
export type Tally = { waiting: number; running: number; failed: number; unread: number };

/** The tally in words, most urgent first: "2 waiting on you", "1 failed", "3 running", "1 unread". */
export function tallyWords(t: Tally): string[] {
  return [
    t.waiting > 0 ? `${t.waiting} waiting on you` : "",
    t.failed > 0 ? `${t.failed} failed` : "",
    t.running > 0 ? `${t.running} running` : "",
    t.unread > 0 ? `${t.unread} unread` : "",
  ].filter(Boolean);
}

/** The session row the window holds for `id`: the active space's copy first, it is the fresher. */
export function sessionOf(s: SidebarState, id: string): Session | undefined {
  return s.sessions[id] ?? s.allSessions[id];
}

/** Where a session lives: the live map wins over the row, which may predate a move. */
export function spaceOfSession(s: SidebarState, session: Session): string {
  return s.sessionSpace[session.id] ?? session.spaceId;
}

/** A sub-agent a session started — listed under its lead's running-agents control, never as a row. */
const isChild = (session: Session | undefined): boolean => !!session?.dispatchedBy && CHILD_ORIGINS.has(session.dispatchedBy.kind);

/** Every live item the window knows of, each once. The window's own list carries every space of its
 *  profile (there is no room any more) and is the fresher of the two, so for those spaces it alone
 *  is trusted — a stale `allItems` copy of a row this window has since deleted must not come back.
 *  `allItems` adds the other profiles' spaces. Archived rows are not live. */
export function liveItems(s: SidebarState): Item[] {
  const mine = new Set(s.spaces.filter((sp) => sp.profileId === s.activeProfileId).map((sp) => sp.id));
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const i of [...s.items, ...s.allItems.filter((x) => !mine.has(x.spaceId))]) {
    if (i.archived || seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

/**
 * Every session the sidebar lists as a row, in any space of any profile.
 *
 * A row is a live session ITEM: an archived session is put away (it is on its space's page), the
 * quick chat has no item at all, and a sub-agent is its lead's business. The item's title is the
 * row's, because a rename in the sidebar changes the item and not the session.
 */
export function listedSessions(s: SidebarState): SessionRow[] {
  const seen = new Set<string>();
  const out: SessionRow[] = [];
  for (const item of liveItems(s)) {
    if (item.kind !== "session" || seen.has(item.refId) || item.refId === s.quickChatId) continue;
    seen.add(item.refId);
    const session = sessionOf(s, item.refId);
    if (isChild(session)) continue;
    out.push({
      kind: "session", id: item.refId, item, session,
      title: item.title || session?.title || "",
      spaceId: s.sessionSpace[item.refId] ?? item.spaceId,
      status: s.sessionStatus[item.refId] ?? session?.status,
      unread: session ? isUnread(session) : false,
      scheduled: session?.dispatchedBy?.kind === "run",
      at: s.sessionUpdatedAt[item.refId] ?? session?.updatedAt ?? item.updatedAt,
      createdAt: session?.createdAt ?? item.createdAt,
    });
  }
  return out;
}

/** The tally of some rows: their live states, and the read mark where nothing louder is showing. */
export function tallyOf(rows: readonly SessionRow[]): Tally {
  const t: Tally = { waiting: 0, running: 0, failed: 0, unread: 0 };
  for (const r of rows) {
    if (r.status === "waiting_permission") t.waiting++;
    else if (r.status === "running") t.running++;
    else if (r.status === "error") t.failed++;
    else if (r.unread) t.unread++;
  }
  return t;
}

/**
 * A space's tally, for its section's head.
 *
 * The states come from EVERY session working in the space — a sub-agent running or waiting is
 * something happening there, even though it is listed under its lead — and the read mark from the
 * space's own rows, which are the ones a person reads.
 */
export function spaceTally(s: SidebarState, spaceId: string, rows: readonly SessionRow[]): Tally {
  const t: Tally = { waiting: 0, running: 0, failed: 0, unread: 0 };
  for (const [id, st] of Object.entries(s.sessionStatus)) {
    if (id === s.quickChatId || s.sessionSpace[id] !== spaceId) continue;
    if (st === "waiting_permission") t.waiting++;
    else if (st === "running") t.running++;
    else if (st === "error") t.failed++;
  }
  for (const r of rows) {
    if (r.spaceId === spaceId && r.status !== "waiting_permission" && r.status !== "running" && r.status !== "error" && r.unread) t.unread++;
  }
  return t;
}

/** A fan-out's sibling: a session the user dispatched with no agent behind it. */
const fanOutCandidate = (r: SessionRow): boolean =>
  r.session?.dispatchedBy?.kind === "user-dispatch" && r.session.dispatchedBy.sessionId === null;

/**
 * How much a row asks for a look: waiting on you or failed, then working, then something new, then
 * the rest. A section shows what needs you before what is merely recent — a session working for an
 * hour last moved when it started, and ordering by that alone would bury it under "Show more".
 */
export function attentionRank(r: ListRow): number {
  if (r.kind === "fan-out") {
    const t = r.tally;
    return t.waiting + t.failed > 0 ? 0 : t.running > 0 ? 1 : t.unread > 0 ? 2 : 3;
  }
  if (r.status === "waiting_permission" || r.status === "error") return 0;
  if (r.status === "running") return 1;
  return r.unread ? 2 : 3;
}

/**
 * One space's rows — what needs you first, then by when each last moved (`attentionRank`) — with a
 * fan-out folded into one row.
 *
 * There is no fan-out record: a batch is several sessions made in a row, each dispatched by the user
 * (`dispatchedBy: user-dispatch`), one agent kind, seconds apart. Those are what fold together — two
 * or more siblings each made within `FAN_OUT_GAP_MS` of the last. A single dispatched session stays a
 * row of its own.
 */
export function spaceRows(rows: readonly SessionRow[]): ListRow[] {
  const byCreation = rows.filter(fanOutCandidate).sort((a, b) => a.createdAt - b.createdAt);
  const clusters: SessionRow[][] = [];
  for (const r of byCreation) {
    const run = clusters[clusters.length - 1];
    const prev = run?.[run.length - 1];
    if (run && prev && prev.spaceId === r.spaceId && prev.session?.agentKind === r.session?.agentKind
      && r.createdAt - prev.createdAt <= FAN_OUT_GAP_MS) run.push(r);
    else clusters.push([r]);
  }
  const folded = new Set<string>();
  const out: ListRow[] = [];
  for (const run of clusters) {
    if (run.length < 2) continue;
    for (const r of run) folded.add(r.id);
    const sessions = [...run].sort((a, b) => b.at - a.at);
    out.push({ kind: "fan-out", id: `fan-out:${run[0]!.id}`, title: run[0]!.title, spaceId: run[0]!.spaceId,
      sessions, at: sessions[0]!.at, tally: tallyOf(sessions) });
  }
  for (const r of rows) if (!folded.has(r.id)) out.push(r);
  return out.sort((a, b) => attentionRank(a) - attentionRank(b) || b.at - a.at);
}

/** Rows by space, each space's folded and ordered by `spaceRows`. */
export function rowsBySpace(rows: readonly SessionRow[]): Map<string, ListRow[]> {
  const grouped = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const held = grouped.get(r.spaceId);
    if (held) held.push(r); else grouped.set(r.spaceId, [r]);
  }
  return new Map([...grouped].map(([id, list]) => [id, spaceRows(list)]));
}

/** The rows a section shows, and how many wait behind "Show more". */
export function sectionView(rows: readonly ListRow[], limit = SECTION_ROWS): { shown: ListRow[]; hidden: number } {
  return { shown: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
}

/**
 * The Recent lens: the profile's rows across all its spaces, by last activity, cut into days. A
 * session still at work — or stopped on a question — is active now, whenever its status last moved.
 */
export function recentDays(rows: readonly SessionRow[], now: number): DayGroup<ListRow>[] {
  const folded = [...rowsBySpace(rows).values()].flat();
  const live = (r: ListRow) => (r.kind === "fan-out" ? r.tally.running + r.tally.waiting > 0 : r.status === "running" || r.status === "waiting_permission");
  return groupByDay(folded, (r) => (live(r) ? Math.max(r.at, now) : r.at), now);
}

/** A row Needs you lists: waiting on a permission or a question, or failed. */
export type NeedsYouRow = {
  session: Session;
  status: "waiting_permission" | "error";
  title: string;
  spaceId: string;
  /** When it started waiting (or failed), live. */
  since: number;
  scheduled: boolean;
};

/**
 * Needs you: what waits on an answer, across every space and every profile — the waiting first,
 * longest-waiting first, then the failed.
 *
 * Waiting is always listed: a question nobody sees is a session stuck for as long as nobody looks,
 * whether or not it has a row (a sub-agent's question blocks its lead) and whether or not it was put
 * away. A failure is listed until it is read — a session opened since it failed has told you — and
 * only where it is a row the person owns: a sub-agent's failure is reported to its lead, and an
 * archived session is one they put away.
 */
export function needsYou(s: SidebarState): NeedsYouRow[] {
  const titles = new Map<string, string>();
  for (const item of liveItems(s)) if (item.kind === "session") titles.set(item.refId, item.title);
  const out: NeedsYouRow[] = [];
  for (const [id, status] of Object.entries(s.sessionStatus)) {
    if (status !== "waiting_permission" && status !== "error") continue;
    if (id === s.quickChatId) continue;
    const session = sessionOf(s, id);
    if (!session) continue;
    if (status === "error") {
      const caughtUp = session.seenSeq > 0 && session.lastEventSeq <= session.seenSeq;
      if (caughtUp || isChild(session) || !titles.has(id)) continue;
    }
    out.push({ session, status, title: titles.get(id) || session.title, spaceId: spaceOfSession(s, session),
      since: s.sessionUpdatedAt[id] ?? session.updatedAt, scheduled: session.dispatchedBy?.kind === "run" });
  }
  const rank = (r: NeedsYouRow) => (r.status === "waiting_permission" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.since - b.since);
}

/** The words Needs you reads a row's state out in. */
export const NEEDS_YOU_LABEL = { waiting_permission: "waiting on you", error: STATUS_LABEL.error } as const;

/** How many sessions in a profile's spaces are waiting on a permission or a question. */
export function profileWaiting(s: SidebarState, profileId: string): number {
  const mine = new Set(s.spaces.filter((sp) => sp.profileId === profileId).map((sp) => sp.id));
  let n = 0;
  for (const [id, st] of Object.entries(s.sessionStatus)) {
    if (st === "waiting_permission" && id !== s.quickChatId && mine.has(s.sessionSpace[id] ?? "")) n++;
  }
  return n;
}

/** The profile's pinned items across its spaces, in the order of the spaces and then their own. */
export function pinnedItems(s: SidebarState, spaces: readonly Space[]): Item[] {
  const order = new Map(spaces.map((sp, i) => [sp.id, i]));
  return liveItems(s)
    .filter((i) => i.pinned && order.has(i.spaceId))
    .sort((a, b) => order.get(a.spaceId)! - order.get(b.spaceId)! || a.sortOrder - b.sortOrder);
}

/**
 * The profile's spaces in section order: the order they were arranged in by hand, or — with
 * Settings ▸ General ▸ Sidebar's "Sort spaces by activity" on — a space with something waiting
 * first, then whichever moved most recently (`spaceActivity`). A sorted copy: turning the setting
 * off lands on the hand-made order, untouched.
 */
export function orderSpaces(spaces: readonly Space[], byActivity: boolean, s: Pick<SidebarState, "sessionStatus" | "sessionSpace" | "sessionUpdatedAt">): Space[] {
  if (!byActivity) return [...spaces];
  const score = (id: string) => spaceActivity(s.sessionStatus as Record<string, SessionStatus>, s.sessionSpace as Record<string, string>,
    s.sessionUpdatedAt as Record<string, number>, id);
  return [...spaces].sort((a, b) => score(b.id) - score(a.id));
}

/**
 * The whole home's order after dropping `from` onto `to`'s place, both in the same profile.
 *
 * `reorderSpaces` takes every space's order, and a section drag only ever moves one profile's: this
 * rewrites that profile's slots in place, so a drag in one profile never resequences another.
 */
export function reorderWithin(all: readonly Space[], within: readonly Space[], from: string, to: string): string[] | null {
  const ids = within.map((sp) => sp.id);
  const fromIdx = ids.indexOf(from), toIdx = ids.indexOf(to);
  if (fromIdx < 0 || toIdx < 0 || from === to) return null;
  ids.splice(fromIdx, 1); ids.splice(toIdx, 0, from);
  const scoped = new Set(ids);
  let n = 0;
  return all.map((sp) => (scoped.has(sp.id) ? ids[n++]! : sp.id));
}
