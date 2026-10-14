import type { Item, Profile, Session, SessionStatus, Space, TeamReviewSummary, TeamRole, TeamSpace } from "@realm/contracts";
import { isChild, liveItems, listedIds, nestChildren, rootLeadOf, sessionItems, sessionOf } from "@realm/view";
import { isUnread, STATUS_LABEL } from "../../state/attention";
import { spaceActivity } from "../../state/store";
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
  /** When each session's status last moved: how long Needs you has waited. Never an order. */
  sessionUpdatedAt: Readonly<Record<string, number>>;
  /** When each session's conversation last moved (`AppState.sessionActivityAt`): the order. */
  sessionActivityAt: Readonly<Record<string, number>>;
  /** The quick chat's session, which belongs to no list. */
  quickChatId: string | null;
  /** Every team space's snapshot (`team.overview`), by space id. Absent for a space with no team. */
  teams: Readonly<Record<string, TeamSpace>>;
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
  /** When its conversation last moved — a prompt, a reply, a turn ending — live. What rows are
   *  ordered by; selecting or reading a session leaves it alone. */
  at: number;
  createdAt: number;
  /** How many of its sub-agents are waiting on a request, and the one that has waited longest — said
   *  on this row, and answered in its Agents tab, rather than as rows of their own in Needs you. */
  agentsWaiting: number;
  firstWaiting: string | null;
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

/**
 * Whether two rows draw the same. The rows are rebuilt on every store write the sidebar reads — an
 * event in any one session moves `sessions` — so a row's object is new on every write while what it
 * says almost never is. A row's view compares with this instead of by identity, so a write redraws
 * the rows it changed and not the 170 beside them, which a list being scrolled while agents work
 * cannot afford.
 */
export function sameRow(a: ListRow, b: ListRow): boolean {
  if (a === b) return true;
  if (a.kind === "session" && b.kind === "session") {
    return a.id === b.id && a.item === b.item && a.session === b.session && a.title === b.title && a.spaceId === b.spaceId
      && a.status === b.status && a.unread === b.unread && a.scheduled === b.scheduled && a.at === b.at && a.createdAt === b.createdAt
      && a.agentsWaiting === b.agentsWaiting && a.firstWaiting === b.firstWaiting;
  }
  if (a.kind === "fan-out" && b.kind === "fan-out") {
    return a.id === b.id && a.title === b.title && a.spaceId === b.spaceId && a.at === b.at
      && a.tally.waiting === b.tally.waiting && a.tally.running === b.tally.running && a.tally.failed === b.tally.failed && a.tally.unread === b.tally.unread
      && a.sessions.length === b.sessions.length && a.sessions.every((s, i) => sameRow(s, b.sessions[i]!));
  }
  return false;
}

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

// Needs you and the helpers it reads moved to `@realm/view` (Plan 28), where realm-server runs the
// same rule for Realm Mobile. Re-exported, so this module still says everything the sidebar draws.
export {
  isChild, liveItems, needsYou, nestChildren, rootLeadOf, sessionOf, spaceOfSession,
  type NeedsYouRow, type NestableRow, type Nested,
} from "@realm/view";

/** The agent most of these sessions run on — the one a list of them need not keep naming. Ties go to
 *  the agent seen first. Null for no sessions. */
export function spaceUsualAgent(rows: readonly { session: Pick<Session, "agentKind"> | undefined }[]): Session["agentKind"] | null {
  const counts = new Map<Session["agentKind"], number>();
  let best: Session["agentKind"] | null = null;
  for (const r of rows) {
    const kind = r.session?.agentKind;
    if (!kind) continue;
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    if (best === null || n > counts.get(best)!) best = kind;
  }
  return best;
}

/**
 * Sub-agents waiting on a request, by the listed lead they roll up to: how many, and the one that has
 * waited longest. A sub-agent whose lead is not a row this window lists is not here — it keeps a
 * Needs you row of its own (`needsYou`), so no request is ever left with nowhere to be seen.
 */
export function agentsWaiting(s: SidebarState, listed: ReadonlySet<string> = listedIds(s)): Map<string, { count: number; first: string; since: number }> {
  const out = new Map<string, { count: number; first: string; since: number }>();
  for (const [id, status] of Object.entries(s.sessionStatus)) {
    if (status !== "waiting_permission") continue;
    const session = sessionOf(s, id);
    if (!session || !isChild(session)) continue;
    const lead = rootLeadOf(s, session);
    if (!lead || !listed.has(lead)) continue;
    const since = s.sessionUpdatedAt[id] ?? session.updatedAt;
    const held = out.get(lead);
    if (!held) out.set(lead, { count: 1, first: id, since });
    else out.set(lead, { count: held.count + 1, ...(since < held.since ? { first: id, since } : { first: held.first, since: held.since }) });
  }
  return out;
}

/**
 * Every session the sidebar lists as a row, in any space of any profile.
 *
 * A row is a live session ITEM: an archived session is put away (it is on its space's page), the
 * quick chat has no item at all, and a sub-agent is its lead's business (`nestChildren`) — unless its
 * lead is gone, when it is a row like any other. The item's title is the
 * row's, because a rename in the sidebar changes the item and not the session.
 */
export function listedSessions(s: SidebarState): SessionRow[] {
  const roles = roleSessionIds(s.teams);
  return nestChildren(sessionRows(s)).map((n) => n.row).filter((r) => !r.item.archived && !roles.has(r.id));
}

/* ── Teams ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The sessions a team's roles ran. Work a clock or a role starts is not work the person started
 * (design.md), so these are not rows of their own: a role's row carries their state, and its page
 * lists them. Waiting on a permission, one is still in Needs you — a question is never left with
 * nowhere to be seen.
 */
export function roleSessionIds(teams: Readonly<Record<string, TeamSpace>>): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(teams)) for (const id of t.runSessionIds) out.add(id);
  return out;
}

/** A team's reviews waiting on a person, oldest first. */
export function waitingReviews(team: TeamSpace | undefined): TeamReviewSummary[] {
  return (team?.reviews ?? []).filter((r) => r.state === "waiting").sort((a, b) => a.createdAt - b.createdAt);
}

/** The one mark a role's row wears at its far end — a session row's vocabulary: working, waiting on
 *  you, or the unread ring when its last run finished unseen. Idle, queued and paused say nothing
 *  there (the tooltip does). */
export function roleMark(role: TeamRole): { mark: "running" | "waiting_permission" | "unseen"; label: string } | null {
  if (role.state === "waiting") return { mark: "waiting_permission", label: "waiting on you" };
  if (role.state === "working") return { mark: "running", label: "working" };
  return role.unread ? { mark: "unseen", label: "finished a run you have not read" } : null;
}

/** The Team row's tally: its roles, counted the way a section counts its sessions. */
export function teamTally(team: TeamSpace): Tally {
  const t: Tally = { waiting: 0, running: 0, failed: 0, unread: 0 };
  for (const r of team.roles) {
    if (r.state === "waiting") t.waiting++;
    else if (r.state === "working") t.running++;
    else if (r.unread) t.unread++;
  }
  return t;
}

/** A review waiting on a person, as a Needs you row. */
export type ReviewNeedsRow = { review: TeamReviewSummary; spaceId: string; since: number };

/** Every review waiting on a person, in every space this window knows, oldest first. */
export function reviewsNeedingYou(s: SidebarState): ReviewNeedsRow[] {
  const known = new Set(s.spaces.map((sp) => sp.id));
  return Object.values(s.teams).filter((t) => known.has(t.spaceId))
    .flatMap((t) => waitingReviews(t).map((review) => ({ review, spaceId: t.spaceId, since: review.createdAt })))
    .sort((a, b) => a.since - b.since);
}

/** A session item as a row, with the live facts laid over it. `waiting` is `agentsWaiting`'s answer,
 *  for a caller building many rows at once. */
export function sessionRowOf(s: SidebarState, item: Item, waiting: ReturnType<typeof agentsWaiting> = agentsWaiting(s)): SessionRow {
  const session = sessionOf(s, item.refId);
  return {
    kind: "session", id: item.refId, item, session,
    title: item.title || session?.title || "",
    spaceId: s.sessionSpace[item.refId] ?? item.spaceId,
    status: s.sessionStatus[item.refId] ?? session?.status,
    unread: session ? isUnread(session) : false,
    scheduled: session?.dispatchedBy?.kind === "run",
    at: s.sessionActivityAt[item.refId] ?? session?.activityAt ?? item.createdAt,
    createdAt: session?.createdAt ?? item.createdAt,
    agentsWaiting: waiting.get(item.refId)?.count ?? 0,
    firstWaiting: waiting.get(item.refId)?.first ?? null,
  };
}

/**
 * Every session item the window holds, put away or not, each once — sub-agents included. Archived
 * rows are here so that an agent under an archived lead stays under it rather than surfacing as a
 * row of its own. The window's own list is trusted for its spaces, as in `liveItems`; the quick chat
 * has no item.
 */
export function sessionRows(s: SidebarState): SessionRow[] {
  const waiting = agentsWaiting(s);
  return sessionItems(s).map((item) => sessionRowOf(s, item, waiting));
}

/** The tally of some rows: their live states, and the read mark where nothing louder is showing. */
export function tallyOf(rows: readonly SessionRow[]): Tally {
  const t: Tally = { waiting: 0, running: 0, failed: 0, unread: 0 };
  for (const r of rows) {
    if (r.status === "waiting_permission" || r.agentsWaiting > 0) t.waiting++;
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
  // A batch in Review is waiting on you as surely as a session's question is.
  t.waiting += waitingReviews(s.teams[spaceId]).length;
  return t;
}

/** A fan-out's sibling: a session the user dispatched with no agent behind it. */
const fanOutCandidate = (r: SessionRow): boolean =>
  r.session?.dispatchedBy?.kind === "user-dispatch" && r.session.dispatchedBy.sessionId === null;

/**
 * How much a row asks for a look: waiting on you or failed, then working, then the rest. A section
 * shows what needs you before what is merely recent — a session working for an hour last moved when
 * it started, and ordering by that alone would bury it under "Show more".
 *
 * Unread is NOT a rank. Opening a session reads it, and a rank that reading changes is a row that
 * jumps away from under the click that selected it; the ring on the row says it is unread.
 */
export function attentionRank(r: ListRow): number {
  if (r.kind === "fan-out") {
    const t = r.tally;
    return t.waiting + t.failed > 0 ? 0 : t.running > 0 ? 1 : 2;
  }
  // A lead whose sub-agents wait is waiting on you too: the request is answered from it.
  if (r.status === "waiting_permission" || r.status === "error" || r.agentsWaiting > 0) return 0;
  return r.status === "running" ? 1 : 2;
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
export function orderSpaces(spaces: readonly Space[], byActivity: boolean, s: Pick<SidebarState, "sessionStatus" | "sessionSpace" | "sessionActivityAt">): Space[] {
  if (!byActivity) return [...spaces];
  const score = (id: string) => spaceActivity(s.sessionStatus as Record<string, SessionStatus>, s.sessionSpace as Record<string, string>,
    s.sessionActivityAt as Record<string, number>, id);
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
