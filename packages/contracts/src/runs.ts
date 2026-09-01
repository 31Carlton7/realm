import { z } from "zod";
import { AgentKindSchema, IdSchema } from "./entities";
import { SkillIdSchema } from "./skills";

/**
 * A durable run's lifecycle.
 *
 * The three LIVE states — `queued`, `running`, `blocked` — are what the dedupe index scopes over, so
 * a trigger that fires twice for one piece of work cannot open a second run while the first is still
 * going. The four TERMINAL states are the ways it can be over; a terminal run releases its dedupe key,
 * which is what lets tomorrow's run of the same recurring thing exist at all.
 *
 * - `queued`    — created, not yet dispatched. The state a retry and an approval both return to.
 * - `running`   — a session exists and is working. Exactly one attempt is open.
 * - `blocked`   — the run stopped and wants a human: a draft to sign off, a login wall, an ambiguity
 *                 it refuses to guess at. Holds no execution. `runs.approve` moves it on.
 * - `succeeded` / `failed` / `cancelled` / `expired` — terminal.
 *
 * `expired` exists as a distinct terminal state rather than a flavour of `failed` because a run that
 * ran out of wall-clock says nothing about whether the work was possible, and the two should not be
 * retried by the same policy.
 */
export const RUN_STATES = ["queued", "running", "blocked", "succeeded", "failed", "cancelled", "expired"] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

/** The states the dedupe index scopes over — see `RUN_STATES`. Exported because the migration's
 *  partial index hard-codes the same three, and `runs.test.ts` pins that they agree. */
export const RUN_LIVE_STATES = ["queued", "running", "blocked"] as const;
export const isRunLive = (state: RunState): boolean => (RUN_LIVE_STATES as readonly string[]).includes(state);
export const isRunTerminal = (state: RunState): boolean => !isRunLive(state);

/**
 * How one attempt ended. `blocked` is an outcome as well as a state: the attempt is genuinely over
 * (its session settled) even though the run is not, and the attempt log should say so rather than
 * recording an open-ended `running` forever.
 */
export const RUN_ATTEMPT_OUTCOMES = ["running", "succeeded", "failed", "blocked", "cancelled", "expired", "abandoned"] as const;
export const RunAttemptOutcomeSchema = z.enum(RUN_ATTEMPT_OUTCOMES);
export type RunAttemptOutcome = z.infer<typeof RunAttemptOutcomeSchema>;

/**
 * What a run may narrow about the session it dispatches. Deliberately a SUBSET of
 * `AgentRunConstraintsSchema`: no `maxTurns`/`timeoutMs` (a run's bound is `deadlineAt`, wall-clock,
 * because a run outlives the process that started it and a relative budget does not survive that),
 * and no `bypassPermissions` in the mode enum AT ALL.
 *
 * That last one is the safety line and it is stricter than delegation's. `agent_run` degrades a
 * requested bypass to `default`; a run cannot even ask. A run is by definition unattended — the human
 * who would answer the prompts that bypass skips is not there — so the mode is rejected at the schema
 * edge rather than quietly downgraded, and the caller finds out at `runs.create` instead of
 * discovering later that their run was not running as they asked.
 */
export const RunConstraintsSchema = z.object({
  agentKind: AgentKindSchema.optional(),
  environmentId: IdSchema.optional(),
  newWorktree: z.union([z.boolean(), z.string().min(1).max(80)]).optional(),
  permissionMode: z.enum(["plan", "default", "acceptEdits"]).optional(),
  skills: z.array(SkillIdSchema).max(50).optional(),
});
export type RunConstraints = z.infer<typeof RunConstraintsSchema>;

/**
 * One durable run: a goal that owns a session across attempts and survives restarts.
 *
 * `sessionId` is the CURRENT attempt's session and is plain `string`, not `IdSchema.nullable()` in
 * the row's foreign-key sense — there is no FK behind it on purpose, the same log posture
 * `sessions.dispatched_by_session_id` and the notifications feed already take: "run X produced
 * session Y" stays a true and useful statement after Y is deleted.
 *
 * `dedupeKey` is caller-chosen and only ever unique among LIVE runs of one space. It is the whole
 * reason a naive poller is safe to write: fire `runs.create` with the same key on every tick and at
 * most one run exists.
 */
export const RunSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  title: z.string(),
  goal: z.string(),
  agentKind: AgentKindSchema,
  environmentId: IdSchema.nullable(),
  constraints: RunConstraintsSchema.nullable(),
  dedupeKey: z.string().nullable(),
  state: RunStateSchema,
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  sessionId: z.string().nullable(),
  deadlineAt: z.number().int().nullable(),
  /** The final report of the attempt that settled it — the deliverable, verbatim. */
  result: z.string().nullable(),
  /** Why it is not `succeeded`. Null on every happy path. */
  error: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  settledAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

/** One attempt's record. Retrying without a durable account of what the last attempt did is how a
 *  run burns three attempts on the same wall; `detail` is that account. */
export const RunAttemptSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  n: z.number().int(),
  sessionId: z.string().nullable(),
  outcome: RunAttemptOutcomeSchema,
  detail: z.string().nullable(),
  startedAt: z.number().int(),
  settledAt: z.number().int().nullable(),
});
export type RunAttempt = z.infer<typeof RunAttemptSchema>;

/**
 * The sentinel a run's session writes to stop and ask for a human. Matched at the START of a trimmed
 * line in the agent's final message, case-insensitively.
 *
 * A sentinel rather than a tool call because the settle path already has the final text in hand and
 * an extra tool is an extra thing to be unavailable; a line-anchored match rather than a substring
 * because "the run should print NEEDS-HUMAN: when it is stuck" appearing in a goal must not itself
 * block the run.
 */
export const RUN_BLOCK_SENTINEL = "NEEDS-HUMAN:";
export function parseBlockRequest(finalText: string | null): string | null {
  if (!finalText) return null;
  for (const raw of finalText.split("\n")) {
    const line = raw.trim();
    if (line.toUpperCase().startsWith(RUN_BLOCK_SENTINEL)) {
      return line.slice(RUN_BLOCK_SENTINEL.length).trim() || "The run asked for a human but gave no reason.";
    }
  }
  return null;
}
