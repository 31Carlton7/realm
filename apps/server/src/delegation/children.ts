import { CHILDREN_PAGE, type ChildrenCursor, type DelegatedChild, type DispatchKind, type Session, type SessionEvent } from "@realm/contracts";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import { NotFoundError } from "../store/rows";
import type { SessionEventsStore, SessionsStore } from "../store/sessions";
import type { AgentChildRecord } from "./agent-run";

/** The dispatch origins that make a session somebody's sub-agent — the renderer's `CHILD_ORIGINS`.
 *  A fork, an import or a durable run names a session it came from, but is nobody's delegate. */
const CHILD_ORIGINS: ReadonlySet<DispatchKind> = new Set<DispatchKind>(["agent_run", "browser_agent_run", "review"]);

/** The events that say what a sub-agent was DOING. Its user message is the task it was handed, which
 *  the tab already shows as the row's title, so it never stands in for activity. */
const ACTIVITY: SessionEvent["type"][] = ["tool_call", "permission_request", "assistant_text", "error"];

/** A report longer than this is the child writing a document into its answer; the tab shows the
 *  opening of it, and the child's own transcript is one click away for the rest. */
const REPORT_MAX = 2000;

/**
 * A session's sub-agents, read back from the tables, and the tab that shows them.
 *
 * The engine knows only what is running and dies with the process; the lead's Agents tab has to say
 * what every child it ever started was asked, what it ran on and how it ended — after the run was
 * collected, and after a relaunch. All of that is already persisted: the child's session row (harness,
 * model, title, status, and `dispatched_by_session_id`, the link back to its lead), its transcript,
 * and `agent_run`'s record of the task and the outcome. This reads them together and adds nothing.
 */
export class DelegatedChildren {
  constructor(private readonly d: {
    sessions: Pick<SessionsStore, "get" | "dispatchedPage" | "listDispatchedBy">;
    events: Pick<SessionEventsStore, "lastReportAndActivity">;
    items: Pick<ItemsStore, "findTab" | "create">;
    rpc: Pick<RpcServer, "broadcast">;
    agentRuns: { records(sessionIds: readonly string[]): Map<string, AgentChildRecord>; working(record: AgentChildRecord, sessionId: string): number | null };
    browserAgents: { goalsOf(sessionIds: readonly string[]): Map<string, string> };
  }) {}

  /** A page of the sub-agents `parentId` started, newest first: `limit` of them (CHILDREN_PAGE when
   *  absent, every one for `null`) started before `before`, and how many there are in all. A fixed
   *  handful of reads whatever the page holds: the sessions, then their transcripts' newest lines,
   *  then their records. */
  list(parentId: string, page: { limit?: number | null; before?: ChildrenCursor } = {}): { children: DelegatedChild[]; nextBefore: ChildrenCursor | null; total: number } {
    const { children, nested, nextBefore, total } = this.d.sessions.dispatchedPage(parentId, [...CHILD_ORIGINS], { limit: page.limit === undefined ? CHILDREN_PAGE : page.limit, before: page.before });
    return { children: this.describeAll(children, nested), nextBefore, total };
  }

  /** One row of `list(parentId)`, read alone: what a window patches in when that one run moved. Null
   *  when `childId` is not one of `parentId`'s sub-agents. */
  one(parentId: string, childId: string): DelegatedChild | null {
    const s = this.d.sessions.get(childId);
    if (!s?.dispatchedBy || s.dispatchedBy.sessionId !== parentId || !CHILD_ORIGINS.has(s.dispatchedBy.kind)) return null;
    const kids = this.d.sessions.listDispatchedBy(childId).filter((g) => g.dispatchedBy && CHILD_ORIGINS.has(g.dispatchedBy.kind));
    return this.describeAll([s], new Map([[s.id, kids]]))[0]!;
  }

  /** `children`, each with the sub-agents it started (`nested`, by parent id) under it, in the same
   *  few reads however many there are. */
  private describeAll(children: Session[], nested: Map<string, Session[]>): DelegatedChild[] {
    // A sub-agent can no longer start its own, but one from before that rule may have: its children
    // are listed under it, one level, which is as deep as delegation ever went.
    const ids = children.flatMap((s) => [s.id, ...(nested.get(s.id) ?? []).map((g) => g.id)]);
    const lines = this.d.events.lastReportAndActivity(ids, ACTIVITY);
    const records = this.d.agentRuns.records(ids);
    const goals = this.d.browserAgents.goalsOf(ids.filter((id) => !records.has(id)));
    const now = Date.now();
    const describe = (session: Session): DelegatedChild => {
      const record = records.get(session.id) ?? null;
      const live = record ? this.d.agentRuns.working(record, session.id) : null;
      const working = live !== null ? { ms: live, at: now } : record?.workedMs !== undefined ? { ms: record.workedMs, at: now } : null;
      const { report, activity } = lines.get(session.id)!;
      const text = report?.type === "assistant_text" ? report.payload.text : null;
      return {
        session,
        goal: record?.goal ?? goals.get(session.id) ?? null,
        // A record from before runs were timed starts where the session did, a moment earlier.
        startedAt: record?.startedAt ?? session.createdAt,
        settledAt: record?.settledAt ?? null,
        outcome: record?.outcome ?? null,
        report: text === null ? null : text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX - 1).trimEnd()}…` : text,
        activity,
        budgetMs: record?.budgetMs ?? null,
        working,
        ...(record?.stopNote ? { note: record.stopNote } : {}),
      };
    };
    return children.map((s) => {
      const kids = nested.get(s.id) ?? [];
      return kids.length > 0 ? { ...describe(s), children: kids.map(describe) } : describe(s);
    });
  }

  /**
   * The session's Agents tab: the item it has, or a new one in the session's space.
   *
   * One per session, found by kind and session id rather than remembered anywhere, so a second
   * window asking for it gets the same tab and a tab deleted with its × is simply made again the
   * next time someone opens it — there is nothing under it to lose.
   */
  tab(sessionId: string): { itemId: string } {
    const existing = this.d.items.findTab(sessionId);
    if (existing) return { itemId: existing.id };
    const session = this.d.sessions.get(sessionId);
    if (!session) throw new NotFoundError("session", sessionId);
    const item = this.d.items.create({ spaceId: session.spaceId, kind: "agents", title: "Agents", refId: sessionId });
    this.d.rpc.broadcast("items.changed", { spaceId: session.spaceId });
    return { itemId: item.id };
  }
}
