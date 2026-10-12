import type { AgentKind } from "@realm/contracts";
import { groupByBucket, type DayGroup } from "../../components/sidebar/chat-feed";
import {
  nestChildren, sessionRows, spaceRows, spaceUsualAgent, tallyOf, type FanOutRow, type SessionRow, type SidebarState, type Tally,
} from "../../components/sidebar/model";

/**
 * What a space's Sessions page lists, as one pure function over the sidebar's own slices: no store,
 * no clock, no DOM — `now` is passed in.
 *
 * It is the sidebar's derivation carried further, never a second one. A row is the sidebar's
 * `SessionRow`; leads and their agents are `nestChildren`; fan-outs fold as `spaceRows` folds them,
 * and the order inside a group is `spaceRows`' (what needs you first, then by last activity). So the
 * Active count is the number the sidebar's section adds up to under "Show more".
 */

export type SessionsView = "active" | "archived";

/** A session — on its own, or a lead with the agents it started. */
export type PageSessionRow = {
  kind: "session";
  id: string;
  row: SessionRow;
  /** Its sub-agents, in the order they were made. Folded until asked for. */
  agents: SessionRow[];
  /** The agents' live state, so a lead folded over a running agent still says so. */
  tally: Tally;
  /** Nothing was ever sent in it. */
  empty: boolean;
  /** Its agent, when that is not the one most of the space runs on; null when it is. */
  otherAgent: AgentKind | null;
  /** When it last moved, counting its agents. */
  at: number;
  /** The agents a search matched by their own title. */
  hits: string[];
};

/** A fan-out, as the sidebar folds it. */
export type PageFanOutRow = { kind: "fan-out"; id: string; row: FanOutRow; at: number; hits: string[] };

export type PageRow = PageSessionRow | PageFanOutRow;

export type SessionsPage = {
  groups: DayGroup<PageRow>[];
  /** Top-level rows in each view, before any search. Agents are never counted. */
  counts: { active: number; archived: number };
};

/** A delegated session's title, as the server writes it ("Agent: You are researching…"). The nest
 *  already says what it is, so the list drops the prefix; the accessible name says "agent" instead. */
export function agentTitle(title: string): string {
  return title.replace(/^Agent:\s*/, "");
}

const live = (r: PageRow): boolean => r.kind === "fan-out"
  ? r.row.tally.running + r.row.tally.waiting > 0
  : r.row.status === "running" || r.row.status === "waiting_permission" || r.tally.running + r.tally.waiting > 0;

/**
 * One space's page.
 *
 * - Every session item of the space, put away or not, sub-agents included, nested once
 *   (`nestChildren`): an agent follows its lead into whichever view the lead is in, whatever its own
 *   archived flag says, and is never counted.
 * - `view` keeps the top-level rows whose item is archived (Archived) or not (Active).
 * - `query` matches a row's title or any of its agents' (case-insensitive); a lead found through an
 *   agent carries the agent in `hits`.
 * - Groups by last activity, a session at work or waiting counting as now (`recentDays`' rule).
 */
export function spaceSessionPage(state: SidebarState, spaceId: string, view: SessionsView, query: string, now: number): SessionsPage {
  const nested = nestChildren(sessionRows(state).filter((r) => r.spaceId === spaceId));
  const usual = spaceUsualAgent(nested.map((n) => n.row));
  const agentsOf = new Map(nested.map((n) => [n.row.id, n.agents]));

  const fold = (archived: boolean): PageRow[] => {
    const tops = nested.filter((n) => n.row.item.archived === archived)
      .map((n) => ({ ...n.row, at: Math.max(n.row.at, ...n.agents.map((a) => a.at)) }));
    return spaceRows(tops).map((r): PageRow => {
      if (r.kind === "fan-out") return { kind: "fan-out", id: r.id, row: r, at: r.at, hits: [] };
      const agents = agentsOf.get(r.id) ?? [];
      const kind = r.session?.agentKind ?? null;
      return {
        kind: "session", id: r.id, row: r, agents, tally: tallyOf(agents),
        empty: r.session ? r.session.lastEventSeq === 0 : false,
        otherAgent: kind && usual && kind !== usual ? kind : null,
        at: r.at, hits: [],
      };
    });
  };

  const active = fold(false);
  const archived = fold(true);
  const counts = { active: active.length, archived: archived.length };

  const q = query.trim().toLowerCase();
  const found = (rows: PageRow[]): PageRow[] => {
    if (!q) return rows;
    const out: PageRow[] = [];
    for (const r of rows) {
      const children = r.kind === "fan-out" ? r.row.sessions : r.agents;
      const hits = children.filter((c) => agentTitle(c.title).toLowerCase().includes(q)).map((c) => c.id);
      if (r.row.title.toLowerCase().includes(q) || hits.length > 0) out.push({ ...r, hits });
    }
    return out;
  };

  const rows = found(view === "active" ? active : archived);
  return { groups: groupByBucket(rows, (r) => (live(r) ? Math.max(r.at, now) : r.at), now), counts };
}
