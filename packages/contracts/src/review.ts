import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * The reviewer recipe's persisted verdict (Plan 13 W3). ONE result per environment, stored in the
 * settings KV under `reviewResultKey(environmentId)` — the diff pane's `review` section reads it, so
 * a reload keeps the verdict until the next review or a ship clears it. Deliberately a KV blob and
 * not a table: the pane shows at most the LATEST review of a checkout, history lives in the reviewer
 * session's own transcript, and a table would be a second copy of that with no reader.
 *
 * `outcome` is the delegation engine's settle vocabulary — a review that timed out or errored still
 * lands (with whatever partial text existed) rather than vanishing, because "the review died" is a
 * fact the user needs on the pane at least as much as a verdict.
 *
 * What this record is NOT: an input to shipping. Nothing may read a review result to trigger
 * `workspace.ship` or any commit — the plan bans wiring review→ship, structurally (the review module
 * never imports git-write; see delegation/structure.test.ts). Review informs the human's ship click.
 */
export const ReviewOutcomeSchema = z.enum(["done", "interrupted", "timeout", "failed", "gone"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

export const ReviewResultSchema = z.object({
  environmentId: IdSchema,
  /** The reviewer session — the pane links to its full trace. Plain id, log posture: the session may
   *  be deleted while the verdict stays worth reading. */
  sessionId: IdSchema,
  sessionTitle: z.string(),
  outcome: ReviewOutcomeSchema,
  /** The reviewer's final message, verbatim — rendered on the diff pane as fenced agent output. */
  text: z.string(),
  createdAt: z.number().int(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** Settings-KV key for an environment's latest review result. */
export const reviewResultKey = (environmentId: string): string => `review.result:${environmentId}`;
