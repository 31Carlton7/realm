import type { DelegatedChild, DispatchKind, Session, SessionEvent } from "@realm/contracts";
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
    sessions: Pick<SessionsStore, "get" | "listDispatchedBy">;
    events: Pick<SessionEventsStore, "lastOfType" | "lastOfTypes">;
    items: Pick<ItemsStore, "findTab" | "create">;
    rpc: Pick<RpcServer, "broadcast">;
    agentRuns: { record(sessionId: string): AgentChildRecord | null };
    browserAgents: { goalOf(sessionId: string): string | null };
  }) {}

  /** Every sub-agent `parentId` started, oldest first — the order the lead started them in, which is
   *  also the order a person reading the lead's transcript met them. */
  list(parentId: string): DelegatedChild[] {
    return this.d.sessions.listDispatchedBy(parentId)
      .filter((s) => s.dispatchedBy && CHILD_ORIGINS.has(s.dispatchedBy.kind))
      .map((s) => this.describe(s));
  }

  private describe(session: Session): DelegatedChild {
    const record = this.d.agentRuns.record(session.id);
    const report = this.d.events.lastOfType(session.id, "assistant_text");
    const text = report?.type === "assistant_text" ? report.payload.text : null;
    return {
      session,
      goal: record?.goal ?? this.d.browserAgents.goalOf(session.id),
      // A record from before runs were timed starts where the session did, a moment earlier.
      startedAt: record?.startedAt ?? session.createdAt,
      settledAt: record?.settledAt ?? null,
      outcome: record?.outcome ?? null,
      report: text === null ? null : text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX - 1).trimEnd()}…` : text,
      activity: this.d.events.lastOfTypes(session.id, ACTIVITY),
    };
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
