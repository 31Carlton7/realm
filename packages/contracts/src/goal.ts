import { z } from "zod";
import { IdSchema } from "./entities";

/**
 * Goal mode: an objective the session keeps working on across turns, without being re-prompted.
 *
 * Ported from Codex's goal extension, whose shape is worth taking seriously because it is mostly a
 * set of refusals rather than a feature. The mechanics carried over, and why each one exists:
 *
 *   - **The objective outlives the turn.** A turn ending is not the work ending; when one settles
 *     with a goal active, Realm sends the next turn itself. That is the whole feature — everything
 *     else is a guard on it.
 *   - **The objective may not shrink.** The failure mode of a self-continuing agent is redefining
 *     success as whatever it managed to do, so the continuation says the opposite in as many words.
 *   - **`blocked` needs repetition, not a first sight of trouble.** One failed command is not an
 *     impasse; the same blocker three turns running is. Without this an agent stops at the first
 *     thing it has not thought about yet.
 *   - **`complete` is a claim about evidence.** Marking a goal done asserts every requirement is met
 *     and can survive being checked one by one — not that the agent is out of ideas, out of budget,
 *     or has written a plausible-sounding summary.
 *   - **A budget stops it, and stopping is resumable.** An agent that can start its own turns needs
 *     a ceiling that is not "the user noticed".
 *
 * What is NOT carried over: Codex's wording. The prose below is Realm's own, and the templates say
 * what Realm's agents need to hear rather than what another product's model was tuned against.
 *
 * Goal mode is orthogonal to the Build/Plan/Ask axis, and deliberately so: a goal is an objective,
 * not a permission. A session can pursue one in any mode, and `permissionMode` is untouched by all
 * of this — which is also why the goal is its own row rather than another value on that field.
 */

/**
 * Where a goal stands.
 *
 * `active` is the only status that continues itself. Every other one is a stop, and the three that
 * are not terminal (`paused`, `blocked`, `budget_limited`) are stops the user can lift with resume —
 * which is the difference between a goal that failed and a goal that is waiting for something.
 */
export const GoalStatusSchema = z.enum([
  /** Pursuing it: each settled turn starts the next one. */
  "active",
  /** The user stopped it. Nothing is lost; resume picks the objective back up. */
  "paused",
  /** The agent hit the same wall three turns running and said so. A stop with a reason. */
  "blocked",
  /** The token budget ran out. The work so far stands; resume raises the ceiling by starting again. */
  "budget_limited",
  /** The agent says every requirement is met. Terminal. */
  "complete",
  /** The user dropped it. Terminal, and the objective is kept only as history. */
  "abandoned",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/** The statuses a resume can lift. Terminal ones are not on the list: a completed goal is finished,
 *  and an abandoned one is a decision rather than a pause. */
export const RESUMABLE_GOAL_STATUSES: readonly GoalStatus[] = ["paused", "blocked", "budget_limited"];

export const GoalSchema = z.object({
  sessionId: IdSchema,
  /** What is to be true when this is done, in the user's own words. */
  objective: z.string().min(1).max(8_000),
  status: GoalStatusSchema,
  /** Tokens this goal may spend before it stops itself, or null for no ceiling. Counted across every
   *  turn the goal has run, continuations included — which is the number a runaway would grow. */
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  /** Turns run under this goal, the user's first one included. What "three turns running" counts. */
  turns: z.number().int().nonnegative(),
  /** Why it stopped, when the agent or the budget stopped it. The pane's own sentence. */
  note: z.string().max(2_000).nullable(),
  startedAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Goal = z.infer<typeof GoalSchema>;

/** The ceiling on a ceiling. A budget is a guard against a runaway, and a "budget" of a billion
 *  tokens is not one — it is the absence of a guard written down as though it were present. */
export const MAX_GOAL_TOKEN_BUDGET = 50_000_000;

/**
 * What a continuation turn says.
 *
 * Sent as an ordinary user message, because that is the only channel every adapter has: Claude,
 * Codex and ACP all take a prompt, and none of them takes "resume your previous objective". It is
 * marked in the transcript as a continuation so a reader never mistakes it for something the person
 * typed.
 *
 * The three paragraphs are the three refusals from the doc comment above, in the order an agent
 * needs them: what to do, what not to call finished, and what not to call blocked.
 */
export function goalContinuationPrompt(goal: { objective: string; turns: number; tokensUsed: number; tokenBudget: number | null }): string {
  const spent = goal.tokenBudget
    ? `You have used ${goal.tokensUsed.toLocaleString("en-US")} of ${goal.tokenBudget.toLocaleString("en-US")} tokens for this objective.`
    : `You have used ${goal.tokensUsed.toLocaleString("en-US")} tokens on this objective so far.`;
  return [
    `Continue working towards this objective:\n\n${goal.objective}`,
    `This is turn ${goal.turns + 1}. ${spent} The objective persists across turns, so ending a turn is not a reason to shrink it — take the next real step towards the end state that was asked for, rather than redefining success as whatever fits in this turn.`,
    "Start by deciding what the last turn actually achieved. Work that changed something, finished something, or produced evidence that changes what to do next is progress; restating a status or writing a plan you did not carry out is not. If the last turn made no progress, do something different this turn.",
    "Call `update_goal` with `complete` only when every requirement is met and you can show it — evidence, not intent, not a plausible summary, and never because you are running low on budget. Call it with `blocked` only once the same obstacle has stopped you on three turns in a row and you have no safe action left; the first appearance of a problem is a thing to work around, not a wall.",
  ].join("\n\n");
}

/** What the session is told when its budget runs out. It is the last turn, so it asks for a handover
 *  rather than more work — the alternative is a goal that stops mid-thought with nothing written down. */
export function goalBudgetPrompt(goal: { objective: string; tokensUsed: number; tokenBudget: number | null }): string {
  return [
    `The token budget for this objective is spent (${goal.tokensUsed.toLocaleString("en-US")} used).`,
    `The objective was:\n\n${goal.objective}`,
    "This is the last turn on it. Do not start new work. Say what is done, what is not, and what the next step would be, so it can be picked up — by you on a resume, or by someone else.",
  ].join("\n\n");
}

/** How a goal's own turns are labelled in the transcript, so a continuation is never mistaken for
 *  something a person typed. The renderer reads this off the event; nothing infers it from the text. */
export const GOAL_CONTINUATION_TAG = "goal-continuation";
