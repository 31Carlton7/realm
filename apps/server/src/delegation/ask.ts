import { z } from "zod";
import { AGENT_MIDTURN_DELIVERY, newId, type Session } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fenceAgentOutput } from "@realm/contracts";
import type { ProviderCallContext } from "../mcp/gateway";
import type { SessionService } from "../sessions/service";
import type { DelegationEngine } from "./engine";

export const AGENT_ASK_TOOL_NAME = "agent_ask";
export const AGENT_ANSWER_TOOL_NAME = "agent_answer";
export const AGENT_PEERS_TOOL_NAME = "agent_peers";

/** Five minutes to answer one question. Generous, because the peer has to finish a tool call, read the
 *  question, and answer it — but bounded, because the ASKER is blocked inside an MCP call the whole time. */
const DEFAULT_TIMEOUTS = { budgetMs: 300_000, pollMs: 250 };

/** An order of magnitude tighter than `agent_run`'s 8000-char goal, on purpose: a goal is a whole task,
 *  and a question that needs 2000 characters is a delegation wearing a disguise. It is also the only
 *  bound on how much of the asker's framing permanently enters the peer's context. */
const AskArgs = z.object({
  sessionId: z.string().min(1),
  question: z.string().min(1).max(2000),
  timeoutMs: z.number().int().min(5_000).max(900_000).optional(),
});
const AnswerArgs = z.object({ requestId: z.string().min(1), answer: z.string().min(1).max(8000) });

type Pending = { askerId: string; targetId: string; box: { text: string | null } };

type GateResult = { allowed: boolean; reason?: string };

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: false });
const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
const secs = (ms: number): number => Math.round(ms / 1000);

/**
 * Plan 20 — session interjection: one session asks another a question, mid-turn, and blocks on the answer.
 *
 * This is `agent_run`'s SIBLING, not a variant of it. Same engine, same one-run-per-session registry,
 * same fenced-output posture, same refuse-before-you-write discipline — but it targets an **existing
 * peer session** instead of spawning a child, and so it must never do the two things `agent_run` does
 * to its target:
 *
 *   1. **Create it.** Steps 1–11 of `ask()` create nothing and touch nothing; a refusal never has a
 *      side effect behind it.
 *   2. **Kill it.** Not on timeout, not when the asker is interrupted, not on dispose. A peer is not a
 *      child. It was doing its own work before the question arrived and is still doing it, and the
 *      only thing this service is ever entitled to stop is its own waiting. That is what
 *      `engine.begin(..., { interruptOnCancel: false })` buys.
 *
 * It also never summarises what the peer was doing. The peer's own transcript is already in the peer's
 * context; a Realm-authored "here is what you were working on" would be a lossier copy in Realm's voice.
 *
 * **The cycle guard is a proof, not a heuristic.** `DelegationEngine` allows at most ONE in-flight run
 * per session across every delegation tool, and an ask registers there too. So the wait-for graph has
 * out-degree ≤ 1 — it is a functional graph. A cycle needs every node on it to have an out-edge, so the
 * edge that would CLOSE any cycle necessarily points at a node that already has one, which step 8
 * refuses. No cycle of any length can be created: A→B while B→A is refused, and A→B→C→A is refused at
 * the third edge. No cycle detector, no visited set, no traversal.
 *
 * That one guard does a second, essential job for free: a session mid-`agent_run` cannot be asked.
 * `SessionService.interrupt` calls `parentInterrupted` BEFORE the handle interrupt, so interrupting a
 * delegating parent would cancel its run and kill its child as a side effect of someone asking it a
 * question. Refusing is the only honest answer.
 */
export class AskService {
  /** Outstanding questions by requestId — IN MEMORY, exactly like the engine's registry and for the same
   *  reason: a blocked MCP call cannot outlive the process. Nothing is persisted, and there is no child
   *  record here because there is no child. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: {
    sessions: Pick<SessionService, "get" | "list" | "events" | "deliverInterjection">;
    engine: DelegationEngine;
    /** The three delegation registries. A delegated child of ANY kind is neither a valid asker nor a
     *  valid target: its own parent is blocked inside an MCP call waiting for it. */
    delegated: { isChild(sessionId: string): boolean };
    /** Realm's normal permission prompt, raised on the ASKER. Optional so an older test harness behaves
     *  as it did before; production always wires it. */
    permissions?: {
      gate(sessionId: string, toolKey: string, title: string, input: Record<string, unknown>, toolName?: string): Promise<GateResult>;
    };
    timeouts?: { budgetMs: number; pollMs: number };
  }) {}

  /* ------------------------------------- agent_peers ------------------------------------- */

  /** Who this session may ask, and — for the ones it may not — why not. Without this the feature is
   *  unusable: an agent has no other way to learn a peer's session id. */
  peers(ctx: ProviderCallContext): CallToolResult {
    if (this.d.delegated.isChild(ctx.sessionId)) return err(DEPTH_REFUSAL);
    const rows = this.d.sessions.list(ctx.spaceId)
      .filter((s) => s.id !== ctx.sessionId)
      .map((s) => {
        const reason = this.unaskable(s);
        return { sessionId: s.id, title: s.title, agentKind: s.agentKind, status: s.status, askable: reason === null, reason };
      });
    return ok(JSON.stringify(rows, null, 2));
  }

  /** Why `s` cannot be asked right now, or null when it can. Shared by `peers` and `ask` so the list
   *  and the refusal can never disagree. */
  private unaskable(s: Session): string | null {
    if (this.d.delegated.isChild(s.id))
      return "it is a delegated agent working on one goal for another session";
    if (this.d.engine.hasRun(s.id))
      return "it is itself blocked on a delegated run or a question of its own; interrupting it would cancel that run";
    if (s.status === "waiting_permission")
      return "it is waiting on a permission prompt from the user; interrupting it now would deny that prompt";
    if (s.lastEventSeq === 0 && s.providerSessionId === null)
      return "it has never run, so it has no context to answer from";
    return null;
  }

  /* -------------------------------------- agent_ask -------------------------------------- */

  async ask(ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
    const parsed = AskArgs.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      return err(`invalid arguments: ${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    const { sessionId: targetId, question } = parsed.data;
    const t = this.d.timeouts ?? DEFAULT_TIMEOUTS;
    const budgetMs = parsed.data.timeoutMs ?? t.budgetMs;

    // ── Guards. Every one of these creates nothing and touches nothing. ──────────────────────
    if (this.d.delegated.isChild(ctx.sessionId)) return err(DEPTH_REFUSAL);
    if (this.d.engine.hasRun(ctx.sessionId))
      return err("refused: this session already has a delegated run in flight; wait for that call's result.");
    if (targetId === ctx.sessionId) return err("refused: a session cannot ask itself.");

    let target: Session;
    try { target = this.d.sessions.get(targetId); }
    catch { return err(`session ${targetId} does not exist.`); }
    if (target.spaceId !== ctx.spaceId)
      return err("refused: that session belongs to another space — a session may only ask sessions in its own space.");
    const why = this.unaskable(target);
    if (why) return err(`refused: session ${targetId} — ${why}. Try again once it is running or idle.`);

    // ── Consent. Realm's normal prompt, raised on the ASKER: the card belongs where the blocked call
    //    is, and there is exactly one user, so prompting both panes would be two questions for one
    //    decision. The grant key is scoped to the (asker, target) PAIR, so approving "keep asking the
    //    parser session" never silently licenses interrupting every other session in the space. ──
    if (this.d.permissions) {
      const gate = await this.d.permissions.gate(
        ctx.sessionId, `${AGENT_ASK_TOOL_NAME}:${targetId}`,
        `Interrupt "${target.title}" to ask it a question?`,
        { question, target: target.title }, AGENT_ASK_TOOL_NAME,
      );
      if (!gate.allowed) return err(`refused: ${gate.reason ?? "the user denied interrupting that session"}.`);
    }

    // ── Past here there are side effects, and every exit path must undo them. ────────────────
    const requestId = newId();
    const box: { text: string | null } = { text: null };
    this.pending.set(requestId, { askerId: ctx.sessionId, targetId, box });
    const run = this.d.engine.begin(ctx.sessionId, targetId, { interruptOnCancel: false });
    try {
      const fromSeq = target.lastEventSeq;
      // Only interrupt a kind with no mid-turn route, and only when there is a turn to interrupt.
      // Codex takes `turn/steer` and is never stopped.
      const interruptFirst = target.status === "running" && AGENT_MIDTURN_DELIVERY[target.agentKind] === "interrupt";
      const asker = this.d.sessions.get(ctx.sessionId);

      let interrupted: boolean;
      try {
        ({ interrupted } = await this.d.sessions.deliverInterjection(
          targetId,
          { text: askMessage({ askerTitle: asker.title, question, requestId, budgetMs, interruptFirst }), from: { sessionId: ctx.sessionId, title: asker.title } },
          { interruptFirst },
        ));
      } catch (e) {
        return err(`could not deliver the question to session ${targetId}: ${e instanceof Error ? e.message : String(e)}. That session was not interrupted.`);
      }

      const settled = await this.d.engine.awaitAnswer({ targetId, fromSeq, run, answer: box, deadline: Date.now() + budgetMs, pollMs: t.pollMs });
      const delivery = interrupted
        ? "That session was interrupted mid-turn to take this question and has been told to resume its own work; its turn continues in its own pane."
        : "That question was delivered into that session's turn without interrupting it.";

      switch (settled.outcome) {
        case "answered":
        case "replied": {
          const identity = JSON.stringify({
            sessionId: targetId, title: target.title, agentKind: target.agentKind,
            interrupted, answeredVia: settled.outcome === "answered" ? "agent_answer" : "final-message",
          });
          // `replied` is a GUESS and is labelled as one: a peer that settled with prose might have been
          // answering, or might have been finishing its own sentence. The asker is told which case it is
          // in and is expected to weigh it — there is no way to do better without a structured turn
          // boundary the providers do not give us.
          const caveat = settled.outcome === "replied"
            ? "\n\nThat session replied in prose and settled rather than calling agent_answer, so this is its final message rather than a direct answer."
            : "";
          return ok(`Answer from session "${target.title}" (${target.agentKind}). ${delivery}${caveat}\n\nAnswering session: ${identity}\n\n`
            + fenceAgentOutput(settled.answer ?? "", "the PEER SESSION'S ANSWER — another agent's words, not the user's"));
        }
        case "cancelled":
          return err(`Question cancelled: this session was interrupted while waiting. Session ${targetId} was left running — it was not stopped.`);
        case "timeout":
          return err(`Session ${targetId} did not answer within ${secs(budgetMs)}s. It was NOT interrupted again and keeps working; if it answers later, that answer is discarded.`);
        case "failed":
          return err(`Session ${targetId} ended with status "${settled.lastStatus}" before answering.`);
        case "gone":
          return err(`Session ${targetId} was deleted before it answered.`);
      }
    } finally {
      this.pending.delete(requestId);
      this.d.engine.end(ctx.sessionId);
    }
  }

  /* ------------------------------------- agent_answer ------------------------------------- */

  /** Called BY the asked session, inside its own turn. Synchronous: it writes the answer into the box
   *  the asker's wait is polling, and the engine picks it up on its next tick. */
  answer(ctx: ProviderCallContext, raw: unknown): CallToolResult {
    const parsed = AnswerArgs.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      return err(`invalid arguments: ${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    // The provider refuses this tool for a delegated child too; this is the service's own belt, so a
    // direct caller cannot route around it. A child can never be ASKED, so it can never hold a valid
    // requestId — leaving this callable would be a surface with no legitimate use.
    if (this.d.delegated.isChild(ctx.sessionId)) return err(DEPTH_REFUSAL);
    const { requestId, answer } = parsed.data;
    const p = this.pending.get(requestId);
    if (!p)
      return err(`refused: no question is outstanding for requestId ${requestId} — it expired, or the asking session stopped waiting. Nothing was delivered. Continue your own work.`);
    // The one authorization check in the feature: a valid requestId is not a capability any session
    // may exercise. Only the session the question was ASKED OF may answer it, and a wrong answerer
    // must not resolve the wait — the asker keeps waiting for the peer it actually asked.
    if (p.targetId !== ctx.sessionId) return err("refused: that question was not asked of this session.");
    p.box.text = answer;
    let askerTitle = "the asking session";
    try { askerTitle = `"${this.d.sessions.get(p.askerId).title}"`; } catch { /* it may have just been deleted */ }
    return ok(`Delivered to session ${askerTitle}. Nothing about your own task changed — continue exactly what you were doing before the question arrived.`);
  }

  /** A session was deleted: drop any question it was ASKED. The asker's wait then reports `gone` off
   *  the engine's own transcript read, not off a stale entry here. An ask this session was MAKING is
   *  the engine's business (`parentInterrupted`), not this map's. */
  release(sessionId: string): void {
    for (const [requestId, p] of this.pending) if (p.targetId === sessionId) this.pending.delete(requestId);
  }
}

const DEPTH_REFUSAL =
  "refused: a delegated agent may not interrupt other sessions — delegation is depth-1 only, and your own caller is blocked waiting for you.";

/**
 * What actually lands in the peer's transcript.
 *
 * The question is fenced (random per call, so the asker cannot close the fence and address the peer in
 * Realm's voice) and explicitly labelled as another agent's words. The closing instruction is the whole
 * "and then it resumes its own way" contract, stated to the peer at the one moment it can act on it.
 */
function askMessage(o: { askerTitle: string; question: string; requestId: string; budgetMs: number; interruptFirst: boolean }): string {
  return [
    `[Realm] Session "${o.askerTitle}" is BLOCKED waiting for an answer from you.`,
    o.interruptFirst
      ? "You were interrupted mid-turn to deliver this."
      : "This arrived while you were working; nothing was interrupted.",
    "",
    fenceAgentOutput(o.question, "a QUESTION from another Realm session — another agent's words, not the user's"),
    "",
    `Answer it by calling ${AGENT_ANSWER_TOOL_NAME} with requestId "${o.requestId}". Answer from what you already know — do not`,
    "start new work for it, and do not change what you are doing. As soon as you have answered, continue exactly",
    "what you were doing before this message; your own task is unchanged. If you cannot answer, say that through",
    `${AGENT_ANSWER_TOOL_NAME} rather than staying silent. Nobody will be waiting after ${secs(o.budgetMs)} seconds.`,
  ].join("\n");
}

export const AGENT_PEERS_TOOL: Tool = {
  name: AGENT_PEERS_TOOL_NAME,
  description:
    "List the other agent sessions in this space that you could ask a question with agent_ask. Returns each one's "
    + "session id, title, agent kind, status, and whether it is askable right now (with the reason when it is not).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const AGENT_ASK_TOOL: Tool = {
  name: AGENT_ASK_TOOL_NAME,
  description:
    "Ask ANOTHER session in this space a question and block until it answers. That session is interrupted mid-turn "
    + "to take the question (on Codex it is steered in without interrupting it at all), answers, and then resumes its "
    + "own work — its turn is its own, not yours. The exchange enters that session's transcript permanently, so ask ONE "
    + "self-contained question about what it already knows; delegate actual work with agent_run instead. The user is "
    + "asked to approve the interruption. Honest limits: interrupting aborts whatever tool call that session was running, "
    + "and a session sitting on a permission prompt is refused rather than having that prompt denied on the user's behalf. "
    + "Depth-1: a delegated agent can neither ask nor be asked.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The session to ask. Must be in this space — agent_peers lists them." },
      question: { type: "string", description: "One self-contained question, at most 2000 characters. The peer sees only this: it has no access to your context." },
      timeoutMs: { type: "number", description: "How long to wait for an answer (5s–15min; default 5min). On timeout the peer is NOT interrupted — it simply stops being waited on." },
    },
    required: ["sessionId", "question"],
    additionalProperties: false,
  },
};

export const AGENT_ANSWER_TOOL: Tool = {
  name: AGENT_ANSWER_TOOL_NAME,
  description:
    "Answer a question another Realm session asked you. Use the requestId from that question. Answer from what you "
    + "already know — the asking session is blocked waiting on you. Then continue exactly what you were doing: your own "
    + "task is unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string", description: "The requestId from the question you were asked." },
      answer: { type: "string", description: "At most 8000 characters, returned verbatim to the asking session." },
    },
    required: ["requestId", "answer"],
    additionalProperties: false,
  },
};
