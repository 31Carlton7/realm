import {
  goalBudgetPrompt, goalContinuationPrompt, goalToolWireName, MAX_GOAL_TOKEN_BUDGET, parseGoalSentinel, RESUMABLE_GOAL_STATUSES,
  type Goal, type GoalStatus, type SessionEventOf,
} from "@realm/contracts";
import type { RpcServer } from "../rpc/server";
import type { GoalsStore } from "../store/goals";
import { NotFoundError, RpcError } from "../store/rows";

/**
 * Goal mode's engine: the thing that starts the next turn.
 *
 * Everything else about a goal is a row. This is the part with teeth — an object that can make an
 * agent run again without anyone asking — so its rules are narrow and stated here rather than spread
 * across the call sites:
 *
 *   1. It continues only on a SETTLE it was told about, never on a timer. No clock anywhere in this
 *      file: a goal that could start a turn while nothing was happening would be a background daemon
 *      wearing a session's clothes.
 *   2. It never continues a turn the USER stopped. Stop means stop — the same rule the message queue
 *      follows one file over, for the same reason.
 *   3. A queued message wins. If the person typed something while the turn ran, that is the next
 *      turn; the goal picks up after it. Otherwise the user would be talking over their own agent.
 *   4. The budget is checked BEFORE the continuation, so the last thing a goal does is hand over
 *      rather than stop mid-thought.
 *   5. It stops itself when the turns stop doing anything (`STALL_LIMIT`) and when there have been
 *      too many of them (`MAX_GOAL_TURNS`). An agent that cannot close its goal — no tool, a tool it
 *      cannot find — otherwise answers "nothing has changed" on every continuation, forever.
 *
 * `deliver` is the seam back into the session service, and it is a function rather than a reference
 * to the service so the loop can be tested without one.
 */
export type GoalServiceDeps = {
  rpc: RpcServer;
  goals: GoalsStore;
  /** Send a turn on this session, as a user message. Returns when the message is accepted, not when
   *  the turn ends — this is the start of the work, not the work. */
  deliver: (sessionId: string, text: string, tag: string) => Promise<void>;
  /** Whether anything the user typed is still waiting to go out on this session. */
  queued: (sessionId: string) => boolean;
  /** Throw away this session's goal turns still waiting in its queue. Called when the goal stops:
   *  a continuation queued behind the turn that called `update_goal` would otherwise go out after it. */
  dropQueued?: (sessionId: string) => void;
  /** Tell the session's running agent its tool list may have changed, and wait briefly for it to read
   *  it again (`McpGateway.refreshTools`). */
  notifyTools?: (sessionId: string) => Promise<void>;
  /** `update_goal` under the name this session's agent sees it by, or null when the session cannot
   *  reach it — then the continuation teaches the `GOAL COMPLETE:` line instead. Absent: the
   *  gateway's own name. */
  closeWith?: (sessionId: string) => string | null;
  log?: (line: string) => void;
};

/** What the session service saw of the turn that just settled, for the stall guard and the text
 *  fallback. */
export type SettledTurn = {
  /** The turn was one of the goal's own continuations rather than something a person sent. */
  continuation: boolean;
  /** Tool calls the agent made during the turn. */
  toolCalls: number;
  /** From the message going out to the settle. */
  wallMs: number;
  /** The agent's last message of the turn, whole. */
  finalText: string | null;
};

/** Three, the same count the continuation asks the agent to apply to a blocker it can see. */
const ERROR_STREAK_LIMIT = 3;
/** Continuation turns in a row that made no progress before the goal stops itself. Three, for the
 *  same reason as the error streak. */
export const STALL_LIMIT = 3;
/** How short a one-tool-call turn has to be to count as no progress — see `madeNoProgress`. */
const STALL_FAST_MS = 20_000;
/** The most turns a goal with no token budget may take. The budget is the ceiling a goal is meant to
 *  have; this is the one it gets when nobody set one, high enough that real work never meets it. */
export const MAX_GOAL_TURNS = 200;

/**
 * Whether a continuation turn did nothing.
 *
 * Deliberately conservative: a false "stall" stops a goal that was working, which is worse than a
 * few wasted turns before the error streak, the budget or `MAX_GOAL_TURNS` gets there. So a turn is
 * no-progress only when it made NO tool calls at all, or exactly one and was over in under twenty
 * seconds. The turns this was written against (2026-10-07) each made zero or one call and ran five
 * to ten seconds, saying "nothing has changed"; a turn that read a file, edited one and ran a test
 * is three calls and never counts, however fast it was. Text alone is not looked at — an agent that
 * says it made progress is not evidence that it did.
 */
export function madeNoProgress(turn: Pick<SettledTurn, "toolCalls" | "wallMs">): boolean {
  return turn.toolCalls === 0 || (turn.toolCalls === 1 && turn.wallMs < STALL_FAST_MS);
}

export class GoalService {
  /** The last cumulative token reading seen per session. The `usage` event carries the SESSION's
   *  running total, so the goal's own figure is the sum of the deltas between readings — and the
   *  first reading after a start seeds this rather than counting, which loses at most one turn's
   *  tokens and can never charge a goal for the whole transcript that came before it. */
  private readonly lastTokens = new Map<string, number>();
  /** Turns in a row that ended in an error, per session. Reset by any turn that did not. */
  private readonly errorStreak = new Map<string, number>();
  /** Whether the turn now in flight has reported an error. */
  private readonly errored = new Set<string>();
  /** Continuation turns in a row that made no progress (`madeNoProgress`), per session. */
  private readonly stallStreak = new Map<string, number>();

  constructor(private readonly d: GoalServiceDeps) {}

  get(sessionId: string): Goal | null { return this.d.goals.get(sessionId); }

  /**
   * Start pursuing an objective. The objective itself is the first turn's prompt: `/goal ship the
   * release notes` should get to work, not acknowledge.
   */
  async start(sessionId: string, objective: string, tokenBudget: number | null): Promise<Goal> {
    const text = objective.trim();
    if (!text) throw new RpcError("INVALID_ARGUMENT", "a goal needs an objective");
    if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
      throw new RpcError("INVALID_ARGUMENT", "a token budget is a positive whole number of tokens");
    }
    if (tokenBudget !== null && tokenBudget > MAX_GOAL_TOKEN_BUDGET) {
      throw new RpcError("INVALID_ARGUMENT", `the largest token budget a goal may have is ${MAX_GOAL_TOKEN_BUDGET.toLocaleString("en-US")}`);
    }
    const goal = this.d.goals.start({ sessionId, objective: text, tokenBudget });
    this.forgetTurns(sessionId);
    this.publish(goal);
    // Before the turn goes out, so it is planned against a list that has the goal tools in it.
    await this.d.notifyTools?.(sessionId);
    await this.d.deliver(sessionId, text, "goal-start");
    return goal;
  }

  /** The user's pause, and the agent's own `blocked`/`complete`, arrive here. */
  set(sessionId: string, status: GoalStatus, note: string | null): Goal {
    const goal = this.require(sessionId);
    const next = this.d.goals.update(sessionId, { status, note })!;
    this.d.log?.(`[goal] ${sessionId} ${goal.status} → ${status}${note ? `: ${note}` : ""}`);
    if (status !== "active") this.d.dropQueued?.(sessionId);
    this.publish(next);
    return next;
  }

  /**
   * Pick a stopped goal back up, and start a turn now.
   *
   * A resume is not just a status change: the session is idle, so nothing else would continue it.
   *
   * Resuming a goal the BUDGET stopped grants the same allowance again, spent from zero — the
   * alternative is a resume that stops on its own next settle, which reads as the button not
   * working. So `tokensUsed` is what this stretch has cost rather than what the objective has cost
   * in total; the session's own meter is where the lifetime figure lives, and it never resets.
   */
  async resume(sessionId: string): Promise<Goal> {
    const goal = this.require(sessionId);
    if (!RESUMABLE_GOAL_STATUSES.includes(goal.status)) {
      throw new RpcError("INVALID_ARGUMENT", goal.status === "active" ? "that goal is already running" : "that goal is finished");
    }
    const next = this.d.goals.update(sessionId, {
      status: "active", note: null,
      ...(goal.status === "budget_limited" ? { tokensUsed: 0 } : {}),
    })!;
    // A resume is a fresh audit, the same way it is for the agent's own blocked count.
    this.forgetTurns(sessionId);
    this.publish(next);
    await this.d.notifyTools?.(sessionId);
    await this.d.deliver(sessionId, this.continuation(sessionId, next), "goal-continuation");
    return next;
  }

  /** Drop it. The row goes: an objective nobody is pursuing is not state, it is litter. */
  clear(sessionId: string): void {
    if (!this.d.goals.get(sessionId)) return;
    this.d.goals.delete(sessionId);
    this.forgetTurns(sessionId);
    this.d.dropQueued?.(sessionId);
    this.d.rpc.broadcast("goal.changed", { sessionId, goal: null });
  }

  /**
   * The turn in flight has failed.
   *
   * This is the runaway guard, and it is not optional. A turn that cannot start — a missing CLI, an
   * expired login, a harness that dies on spawn — errors and settles in milliseconds, and a goal
   * with no token budget would then continue itself as fast as the machine allows, forever. Nothing
   * else in the loop stops that: the model never runs, so it never calls `update_goal`, and no
   * tokens are spent so no budget is reached.
   *
   * Three in a row is the same shape as the blocked audit the continuation asks the agent to apply —
   * one failure is a thing to retry, three is a wall.
   */
  onError(sessionId: string): void {
    if (this.d.goals.get(sessionId)?.status === "active") this.errored.add(sessionId);
  }

  /**
   * A `usage` event landed. Tokens are counted here rather than at the settle because a turn that
   * errors out still spent them, and a budget that only counted clean turns would not be a ceiling.
   */
  onUsage(sessionId: string, payload: SessionEventOf<"usage">["payload"]): void {
    const goal = this.d.goals.get(sessionId);
    if (!goal || goal.status !== "active") return;
    const total = (payload.inputTokens ?? 0) + (payload.outputTokens ?? 0);
    const seen = this.lastTokens.get(sessionId);
    this.lastTokens.set(sessionId, total);
    if (seen === undefined) return; // the seeding reading: see `lastTokens`
    const delta = total - seen;
    if (delta <= 0) return; // a compaction can lower the running total; it never spends negative tokens
    const next = this.d.goals.update(sessionId, { tokensUsed: goal.tokensUsed + delta })!;
    this.publish(next);
  }

  /**
   * A turn settled. Count it, then decide whether the goal gets another one.
   *
   * Returns what it did, which is what the tests assert on and what the log line says — "nothing
   * happened" has several different reasons here and they are not interchangeable.
   *
   * `turn` is what the session service saw of the turn; without it (older callers, most tests) the
   * text fallback and the stall guard have nothing to read and stay out of it.
   *
   * `queuedNext` says the settle is already sending a queued message as the next turn. The session
   * service takes that message off its queue before this runs, so `queued()` alone would read empty
   * and the goal would send its continuation beside the user's message.
   */
  async onSettled(sessionId: string, opts: { interrupted: boolean; queuedNext?: boolean; turn?: SettledTurn }): Promise<"continued" | "budget" | "stopped" | "failing" | "stalled" | "closed" | "capped" | "idle"> {
    const goal = this.d.goals.get(sessionId);
    if (!goal || goal.status !== "active") return "idle";
    // The user's stop, and the user's own next message, both outrank the goal.
    if (opts.interrupted) {
      this.publish(this.d.goals.update(sessionId, { status: "paused", note: "You stopped the turn." })!);
      return "stopped";
    }
    const counted = this.d.goals.update(sessionId, { turns: goal.turns + 1 })!;
    const failed = this.errored.delete(sessionId);
    const streak = failed ? (this.errorStreak.get(sessionId) ?? 0) + 1 : 0;
    this.errorStreak.set(sessionId, streak);
    if (streak >= ERROR_STREAK_LIMIT) {
      this.stop(sessionId, "blocked", `${streak} turns in a row ended in an error, so Realm stopped continuing this goal.`);
      return "failing";
    }
    const turn = opts.turn;
    /* The text fallback: a `GOAL COMPLETE:` / `GOAL BLOCKED:` line is the agent's `update_goal` when
       it has no tool to call. Honoured whatever the session has — an agent that wrote the line meant
       it, and continuing past it would be the very loop this exists to end. */
    const said = turn?.finalText ? parseGoalSentinel(turn.finalText) : null;
    if (said) {
      this.stop(sessionId, said.status, said.note);
      return "closed";
    }
    /* The stall guard counts only the goal's OWN turns: a person's message is not the goal stalling,
       and it resets the count because they have just steered. An errored turn is the error streak's. */
    if (turn && !failed) {
      const stalls = turn.continuation && madeNoProgress(turn) ? (this.stallStreak.get(sessionId) ?? 0) + 1 : 0;
      this.stallStreak.set(sessionId, stalls);
      if (stalls >= STALL_LIMIT) {
        this.stop(sessionId, "blocked", `${stalls} turns in a row made no progress, so Realm stopped continuing this goal.`);
        return "stalled";
      }
    }
    if (opts.queuedNext || this.d.queued(sessionId)) return "idle";
    if (counted.tokenBudget === null && counted.turns >= MAX_GOAL_TURNS) {
      this.stop(sessionId, "blocked", `This goal has taken ${counted.turns} turns, the most Realm runs one with no token budget. Resume it to keep going.`);
      return "capped";
    }
    if (counted.tokenBudget !== null && counted.tokensUsed >= counted.tokenBudget) {
      // The stop is published BEFORE the handover turn goes out, so the pane says "budget spent"
      // while that turn runs rather than after it — the run is the goal's last act, not a new one.
      this.publish(this.d.goals.update(sessionId, { status: "budget_limited", note: `The ${counted.tokenBudget.toLocaleString("en-US")} token budget is spent.` })!);
      await this.d.deliver(sessionId, goalBudgetPrompt(counted), "goal-budget");
      return "budget";
    }
    this.publish(counted);
    await this.d.deliver(sessionId, this.continuation(sessionId, counted), "goal-continuation");
    return "continued";
  }

  /**
   * Boot: park every active goal instead of resuming it.
   *
   * Codex restores a running goal and carries on. Realm does not, and the difference is when the
   * process starts: a CLI is relaunched by someone who is sitting there, and a desktop app is
   * relaunched by someone opening it — possibly days later, possibly to look at something else. A
   * burst of autonomous turns on launch is a surprise nobody consented to, so the objective is kept
   * and the decision to carry on is handed back.
   */
  parkOnBoot(): number {
    const active = this.d.goals.withStatus("active");
    for (const g of active) {
      this.publish(this.d.goals.update(g.sessionId, { status: "paused", note: "Realm restarted while this goal was running." })!);
    }
    return active.length;
  }

  /** Stop the goal from inside the loop, with Realm's (or the agent's) reason. */
  private stop(sessionId: string, status: "blocked" | "complete", note: string): void {
    this.d.log?.(`[goal] ${sessionId} → ${status}: ${note}`);
    this.d.dropQueued?.(sessionId);
    this.publish(this.d.goals.update(sessionId, { status, note })!);
  }

  private continuation(sessionId: string, goal: Goal): string {
    const closeWith = this.d.closeWith ? this.d.closeWith(sessionId) : goalToolWireName("");
    return goalContinuationPrompt(goal, closeWith);
  }

  /** Per-stretch bookkeeping, dropped when a goal starts, resumes or goes. */
  private forgetTurns(sessionId: string): void {
    this.lastTokens.delete(sessionId);
    this.errorStreak.delete(sessionId);
    this.errored.delete(sessionId);
    this.stallStreak.delete(sessionId);
  }

  private require(sessionId: string): Goal {
    const goal = this.d.goals.get(sessionId);
    if (!goal) throw new NotFoundError("goal", sessionId);
    return goal;
  }

  private publish(goal: Goal): void {
    this.d.rpc.broadcast("goal.changed", { sessionId: goal.sessionId, goal });
  }
}
