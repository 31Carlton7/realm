import { AGENT_META, AddTeammateSchema, DEFAULT_MODEL_LABEL, type AgentRunConstraints, type Goal, type MentionRef, type Session } from "@realm/contracts";
import type { z } from "zod";
import { clip } from "../mcp/tool-result";
import type { SessionService } from "../sessions/service";
import type { SessionEventsStore } from "../store/sessions";
import { RpcError } from "../store/rows";
import type { AgentRunService } from "./agent-run";
import { taskName } from "./dispatch";

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

/** The teammates a lead has been given since its agent last heard from the person — what its next
 *  message tells it. Persisted, so a relaunch between the add and that message still says so. */
const joinedKey = (leadId: string): string => `teammates.joined:${leadId}`;
/** What the person took off the lead's row of agents (`dismiss`). */
const dismissedKey = (leadId: string): string => `delegation.dismissed:${leadId}`;

/** How many dismissals a lead keeps. The row only ever shows what is running or what the latest turn
 *  started, so an id older than this belongs to an agent the row stopped showing long ago. */
const DISMISSED_MAX = 100;
/** How much of the lead's conversation a teammate is handed, in characters: the tail, cut at a turn.
 *  A briefing, not the transcript — `agent_run`'s goal is capped at 8000, and the brief, the goal and
 *  the summary ride in the same string. */
const CONVERSATION_MAX = 4_000;
const OBJECTIVE_MAX = 1_000;
const SUMMARY_MAX = 1_200;

/**
 * Teammates: agents the person adds to a session from its prompter's "+", to help its agent.
 *
 * **No second spawn path.** A teammate is `agent_start` with the person asking instead of the agent:
 * `AgentRunService.startChild` makes the child, under the same mode rule (min of the lead's and none
 * asked), the same caps, the same budget and the same run registry, keyed on the lead. So everything
 * the lead's agent can do with a sub-agent it started works on one it was given — `agent_status` lists
 * it and `agent_wait` collects its report — and the Agents tab shows it among the rest.
 *
 * **The lead is told on its next message.** Its agent cannot act between turns, so the moment that
 * matters is the next one: `joinedNote` rides on it, beside the user's text, the way a mentioned file
 * or a woken role does (`SessionService.deliver`). Nothing is sent on its own — a turn nobody typed is
 * a bill nobody asked for.
 */
export class Teammates {
  constructor(private readonly d: {
    agentRuns: Pick<AgentRunService, "startChild" | "record">;
    sessions: Pick<SessionService, "get" | "send">;
    events: Pick<SessionEventsStore, "transcript" | "lastOfType">;
    goals: { get(sessionId: string): Goal | null };
    settings: SettingsLike;
    /** The lead's list of sub-agents changed: every window re-reads it (`announceDelegation`). */
    announce: (leadId: string) => void;
  }) {}

  /**
   * Start a teammate beside `sessionId`. Same folder means the lead's own checkout, wherever that is —
   * the space's folder or a worktree — not the space's primary, which is what a child given no
   * environment would get.
   */
  async add(input: z.output<typeof AddTeammateSchema>): Promise<{ childId: string }> {
    const lead = this.d.sessions.get(input.sessionId);
    const brief = input.brief?.trim() ?? "";
    const kind = input.agentKind ?? lead.agentKind;
    const constraints: AgentRunConstraints = {
      ...(input.agentKind ? { agentKind: input.agentKind } : {}),
      // The lead's own model on the lead's own harness is what naming no model already means, and
      // naming it would send an id through a resolver that only needs to see names it was not given.
      ...(input.model && !(kind === lead.agentKind && input.model === lead.model) ? { model: input.model } : {}),
      ...(input.newWorktree ? { newWorktree: true } : { environmentId: lead.environmentId }),
    };
    const title = brief ? taskName(brief) : `${AGENT_META[kind].label} teammate`;
    const started = await this.d.agentRuns.startChild({ sessionId: lead.id, spaceId: lead.spaceId }, { goal: this.goalFor(lead, brief), title, constraints });
    if (!started.ok) throw new RpcError("TEAMMATE_REFUSED", started.message.replace(/^refused:\s*/, ""));
    this.d.settings.set(joinedKey(lead.id), [...this.joined(lead.id), started.childId]);
    return { childId: started.childId };
  }

  /**
   * What a teammate is handed: the person's brief first — it is the task, and the line its name and
   * its card are read from — then where it has landed: the session's goal, the model's account of the
   * session where one was written, and the tail of the conversation, as text.
   */
  private goalFor(lead: Session, brief: string): string {
    const goal = this.d.goals.get(lead.id);
    const summary = this.d.events.lastOfType(lead.id, "summary");
    const turns = this.d.events.transcript(lead.id, Date.now());
    const conversation = tail(turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n"), CONVERSATION_MAX);
    const fence = "`".repeat(Math.max(3, ...(conversation.match(/`+/g) ?? []).map((r) => r.length + 1)));
    return [
      brief || "Help with the work in this session wherever you can.",
      "",
      "# Joining as a teammate",
      `The person running the Realm session "${lead.title}" added you to it, to help its agent (${AGENT_META[lead.agentKind].label}). `
        + "That agent leads the session: it is told you joined, it receives your final report, and it splits the work — so stay on what you were asked.",
      ...(goal && goal.status !== "complete" && goal.status !== "abandoned" ? ["", `The session's goal: ${clip(goal.objective.trim(), OBJECTIVE_MAX)}`] : []),
      ...(summary?.type === "summary" ? ["", `Where the session stands: ${clip(summary.payload.text.trim(), SUMMARY_MAX)}`] : []),
      ...(turns.length > 0
        ? ["", "Its conversation so far, newest last (the tail, as plain text):", `${fence}transcript\n${conversation}\n${fence}`]
        : ["", "The session has no conversation yet."]),
    ].join("\n");
  }

  private joined(leadId: string): string[] {
    const v = this.d.settings.get(joinedKey(leadId));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  /**
   * The lead's word about the teammates it was given since its last message, and spent by asking —
   * `SessionService.deliver` calls this once per message it sends. Empty when there are none. Each
   * says its handle, what runs it, where and on what, and whether it is still working, so the agent
   * can plan around it without a call to find out.
   */
  joinedNote(leadId: string): string {
    const ids = this.joined(leadId);
    if (ids.length === 0) return "";
    this.d.settings.set(joinedKey(leadId), null);
    const leadCwd = this.d.sessions.get(leadId).cwd;
    const lines: string[] = [];
    for (const id of ids) {
      let child: Session;
      try { child = this.d.sessions.get(id); } catch { continue; }
      const brief = this.d.agentRuns.record(id)?.goal.split("\n")[0] ?? "";
      const on = `${AGENT_META[child.agentKind].label} · ${child.model ?? DEFAULT_MODEL_LABEL[child.agentKind]}`;
      const where = child.cwd === leadCwd ? "in your folder" : `in its own checkout, ${child.cwd}`;
      const state = child.status === "running" || child.status === "waiting_permission" ? "It is working now." : "It has already finished: collect its report with agent_wait.";
      lines.push(`- "${child.title}" (handle ${id}) on ${on}, ${where}, asked to: ${brief} ${state}`);
    }
    if (lines.length === 0) return "";
    return `\n\nThe user added teammates to this session since your last message:\n${lines.join("\n")}\n`
      + "Each is your sub-agent, started for you: agent_status lists it and agent_wait collects its report. "
      + "Do not start it again or redo its part — plan your own work around it.\n";
  }

  /**
   * The `@` chips of a message about to be sent that name one of the session's own sub-agents: each
   * is passed the message, and its chip told whether it was, for the lead's context block. What a
   * client wrote in either field is dropped first.
   *
   * Queued rather than steered into a child mid-turn: an interrupt there reads to its run as the
   * person stopping it, and the report its lead is waiting on would come back as "stopped". It reads
   * the message when the turn it is in ends.
   */
  async passMentioned(leadId: string, text: string, refs: readonly MentionRef[]): Promise<MentionRef[]> {
    const said = text.replace(/@\[([^\]]+)\]/g, "@$1");
    const out: MentionRef[] = [];
    for (const r of refs) {
      if (r.kind !== "agent") { out.push(r); continue; }
      const clean = { kind: "agent" as const, label: r.label, sessionId: r.sessionId };
      if (!text.includes(`@[${r.label}]`)) { out.push(clean); continue; }
      const why = this.unreachable(leadId, r.sessionId);
      if (why) { out.push({ ...clean, refused: why }); continue; }
      try {
        await this.d.sessions.send(r.sessionId, { text: said, attachments: [] }, "queue");
        out.push({ ...clean, delivered: true });
      } catch (e) {
        out.push({ ...clean, refused: clip(e instanceof Error ? e.message : "Realm could not send it", 400) });
      }
    }
    return out;
  }

  /** Why `childId` cannot be passed a message from `leadId`'s prompter, or null when it can. */
  private unreachable(leadId: string, childId: string): string | null {
    let child: Session;
    try { child = this.d.sessions.get(childId); } catch { return "it no longer exists"; }
    if (child.dispatchedBy?.sessionId !== leadId) return "it is not one of this session's sub-agents";
    return null;
  }

  /** The sub-agents taken off the lead's row, oldest first. */
  dismissed(leadId: string): string[] {
    const v = this.d.settings.get(dismissedKey(leadId));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  /** Take `id` off the lead's row. It is not stopped, and the Agents tab still lists it. */
  dismiss(leadId: string, id: string): string[] {
    this.d.sessions.get(leadId);
    const ids = [...this.dismissed(leadId).filter((x) => x !== id), id].slice(-DISMISSED_MAX);
    this.d.settings.set(dismissedKey(leadId), ids);
    this.d.announce(leadId);
    return ids;
  }

  /** A session was deleted: what it was owed and what it hid go with it. */
  release(sessionId: string): void {
    if (this.d.settings.get(joinedKey(sessionId)) != null) this.d.settings.set(joinedKey(sessionId), null);
    if (this.d.settings.get(dismissedKey(sessionId)) != null) this.d.settings.set(dismissedKey(sessionId), null);
  }
}

/** The end of `text`, at most `max` characters, opening on a turn boundary when one is in reach. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.slice(text.length - max);
  const boundary = end.indexOf("\n\n");
  return boundary === -1 ? end : end.slice(boundary + 2);
}
