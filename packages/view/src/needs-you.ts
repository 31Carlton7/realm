import type { DispatchKind, Item, Session, SessionStatus, Space } from "@realm/contracts";

/**
 * Needs you (Plan 27): what waits on an answer, across every space and every profile.
 *
 * Two readers draw this list. The desktop's sidebar builds the input from its store; realm-server
 * builds the same input from `sessions.listAll`, `items.listAll`, `spaces.list` and the quick chat's
 * setting, and answers Realm Mobile's `home.get` with it (Plan 28). One rule, so the phone's list is
 * the sidebar's by construction rather than by a copy kept in step.
 */

/** What `needsYou` reads: the sidebar's store slices that bear on it, and nothing a server cannot
 *  build from its own lists. */
export type NeedsYouState = {
  spaces: readonly Pick<Space, "id" | "profileId">[];
  /** The profile a window shows. Its own lists (`items`, `sessions`) carry every space of it; a
   *  reader with no window (the server) passes null and puts everything in `allItems`. */
  activeProfileId: string | null;
  /** Every space of the window's profile, as the window holds them, archived rows included. */
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
  /** The quick chat's session, which belongs to no list. */
  quickChatId: string | null;
};

/** The setting the quick chat's session is kept under (`{ sessionId, pos }`), by the window that
 *  opened it. The server reads it to leave the quick chat out of Needs you, as the sidebar does. */
export const QUICK_CHAT_SETTING = "ui.quickChat";

/** The quick chat's session id, from `QUICK_CHAT_SETTING`'s value. */
export function quickChatIdOf(value: unknown): string | null {
  const id = value && typeof value === "object" ? (value as { sessionId?: unknown }).sessionId : null;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The session row the window holds for `id`: the active space's copy first, it is the fresher. */
export function sessionOf(s: Pick<NeedsYouState, "sessions" | "allSessions">, id: string): Session | undefined {
  return s.sessions[id] ?? s.allSessions[id];
}

/** Where a session lives: the live map wins over the row, which may predate a move. */
export function spaceOfSession(s: Pick<NeedsYouState, "sessionSpace">, session: Session): string {
  return s.sessionSpace[session.id] ?? session.spaceId;
}

/** The dispatch origins that make a session a delegated CHILD: listed under its lead's running-agents
 *  control and named by the call that started it, never given a row or a pane of its own. */
export const CHILD_ORIGINS: ReadonlySet<DispatchKind> = new Set<DispatchKind>(["agent_run", "browser_agent_run", "review"]);

/** A sub-agent a session started — listed under its lead's running-agents control, never as a row. */
export const isChild = (session: Pick<Session, "dispatchedBy"> | undefined): boolean => !!session?.dispatchedBy && CHILD_ORIGINS.has(session.dispatchedBy.kind);

/** What `nestChildren` needs of a row: which session it is, where it lives, and who started it. */
export type NestableRow = { id: string; spaceId: string; session: Pick<Session, "dispatchedBy"> | undefined; createdAt: number };

/** A lead and the agents it started, or a session standing on its own (`agents` empty). */
export type Nested<T> = { row: T; agents: T[] };

/**
 * Which rows are leads and which are their agents — the one definition of "lead / agent" that the
 * sidebar, the space's Sessions page and anything else that lists sessions share.
 *
 * A row is an agent when its session was started by another (`isChild`) and that other is among
 * `rows` in the same space. It goes under its TOP-MOST such ancestor, so the nest is one level deep
 * and a grandchild sits beside its parent under the lead the person started. A child whose lead is
 * not here — deleted, or in another space — stands at the top level as itself: dropping it would lose
 * a session nobody put away. Fan-outs (`user-dispatch`) have no lead and are not nested.
 *
 * Top-level rows keep the order they came in; each lead's agents are in the order they were made.
 */
export function nestChildren<T extends NestableRow>(rows: readonly T[]): Nested<T>[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const leadOf = (row: T): T | null => {
    let lead: T | null = null;
    const seen = new Set<string>([row.id]);
    for (let at = row; isChild(at.session);) {
      const parent = byId.get(at.session!.dispatchedBy!.sessionId ?? "");
      if (!parent || parent.spaceId !== row.spaceId || seen.has(parent.id)) break;
      seen.add(parent.id);
      lead = parent; at = parent;
    }
    return lead;
  };
  const out = new Map<string, Nested<T>>();
  const agentsOf = new Map<string, T[]>();
  for (const r of rows) {
    const lead = leadOf(r);
    if (!lead) { out.set(r.id, { row: r, agents: [] }); continue; }
    const held = agentsOf.get(lead.id);
    if (held) held.push(r); else agentsOf.set(lead.id, [r]);
  }
  for (const [id, agents] of agentsOf) out.get(id)!.agents = agents.sort((a, b) => a.createdAt - b.createdAt);
  return [...out.values()];
}

/** How far up a chain of sub-agents `rootLeadOf` looks. Delegation is one level deep now and was two;
 *  the cap is what keeps a cycle in bad data from hanging the sidebar. */
const MAX_HOPS = 4;

/** The session a sub-agent's chain of leads ends at — the one the person started — or null when
 *  this window does not hold a link in the chain. A session that is nobody's sub-agent is its own. */
export function rootLeadOf(s: Pick<NeedsYouState, "sessions" | "allSessions">, session: Session): string | null {
  let at: Session | undefined = session;
  for (let hop = 0; hop < MAX_HOPS && isChild(at); hop++) {
    const lead: string | null | undefined = at!.dispatchedBy?.sessionId;
    at = lead ? sessionOf(s, lead) : undefined;
    if (!at) return null;
  }
  return isChild(at) ? null : at!.id;
}

/** Every live item the window knows of, each once. The window's own list carries every space of its
 *  profile (there is no room any more) and is the fresher of the two, so for those spaces it alone
 *  is trusted — a stale `allItems` copy of a row this window has since deleted must not come back.
 *  `allItems` adds the other profiles' spaces. Archived rows are not live. */
export function liveItems(s: Pick<NeedsYouState, "spaces" | "activeProfileId" | "items" | "allItems">): Item[] {
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

/** `sessionRows`' items: every session item, put away or not, each once, the quick chat left out. */
export function sessionItems(s: Pick<NeedsYouState, "spaces" | "activeProfileId" | "items" | "allItems" | "quickChatId">): Item[] {
  const mine = new Set(s.spaces.filter((sp) => sp.profileId === s.activeProfileId).map((sp) => sp.id));
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of [...s.items, ...s.allItems.filter((x) => !mine.has(x.spaceId))]) {
    if (item.kind !== "session" || seen.has(item.refId) || item.refId === s.quickChatId) continue;
    seen.add(item.refId);
    out.push(item);
  }
  return out;
}

/** The sessions the sidebar lists as rows, by id — `listedSessions`' rule, without building rows
 *  (which would ask `agentsWaiting`, and so this, again). */
export function listedIds(s: NeedsYouState): Set<string> {
  const rows = sessionItems(s).map((item) => {
    const session = sessionOf(s, item.refId);
    return { id: item.refId, item, session, spaceId: s.sessionSpace[item.refId] ?? item.spaceId, createdAt: session?.createdAt ?? item.createdAt };
  });
  return new Set(nestChildren(rows).map((n) => n.row).filter((r) => !r.item.archived).map((r) => r.id));
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
 * whether or not it was put away. A sub-agent's request is the one exception, and only where its
 * lead is a row: it is said on the lead's row as a count and answered in the lead's Agents tab,
 * because the person started the lead, not the child (`agentsWaiting`). A sub-agent whose lead this
 * window does not list keeps its own row here — a request is never left with nowhere to be seen. A
 * failure is listed until it is read — a session opened since it failed has told you — and only
 * where it is a row the person owns: a sub-agent's failure is reported to its lead, and an archived
 * session is one they put away.
 */
export function needsYou(s: NeedsYouState): NeedsYouRow[] {
  const titles = new Map<string, string>();
  for (const item of liveItems(s)) if (item.kind === "session") titles.set(item.refId, item.title);
  const listed = listedIds(s);
  const out: NeedsYouRow[] = [];
  for (const [id, status] of Object.entries(s.sessionStatus)) {
    if (status !== "waiting_permission" && status !== "error") continue;
    if (id === s.quickChatId) continue;
    const session = sessionOf(s, id);
    if (!session) continue;
    if (status === "waiting_permission" && isChild(session)) {
      const lead = rootLeadOf(s, session);
      if (lead && listed.has(lead)) continue;
    }
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
