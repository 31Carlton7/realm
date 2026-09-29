import { z } from "zod";
import { AgentKindSchema, IdSchema } from "./entities";
import { SkillIdSchema } from "./skills";

/**
 * `agent_run`'s constraints (Plan 13 W1) — every field optional, and each one only ever NARROWS what
 * the child would otherwise get:
 *
 * - `agentKind` picks the child's agent; omitted, the child keeps the caller's kind (with the same
 *   skills-injection fallback `browser_agent_run` uses).
 * - `environmentId` runs the child in an EXISTING environment of the caller's space (a worktree the
 *   parent already made, the primary, a project checkout). Same-space is enforced server-side.
 * - `newWorktree` creates a fresh worktree via Plan 7's seam — `true` titles it from the goal's first
 *   words, a string titles it verbatim. Mutually exclusive with `environmentId` (enforced in the
 *   service, where the refusal can be worded properly).
 * - `permissionMode` requests a mode for the child; the service caps it at min(parent's, requested)
 *   and `bypassPermissions` is never granted — a requested bypass degrades to `default`, stated in
 *   the tool result.
 * - `maxTurns` scales the settle deadline (there is no adapter seam that counts turns — this is a
 *   time budget, stated honestly in the tool description); `timeoutMs` overrides it wholesale.
 * - `skills` narrows the child's skill set to a SUBSET of the space's enabled skills; an id that is
 *   not enabled-and-valid in the space refuses the whole call loudly.
 */
export const AgentRunConstraintsSchema = z.object({
  agentKind: AgentKindSchema.optional(),
  environmentId: IdSchema.optional(),
  newWorktree: z.union([z.boolean(), z.string().min(1).max(80)]).optional(),
  /** Both read-only modes are requestable: they are the two most restrictive things a parent can ask
   *  a child to be, and leaving one out of the enum refuses the constraint outright rather than
   *  tightening. `MODE_RANK` ranks them equal — see `agent-run.ts`. */
  permissionMode: z.enum(["plan", "ask", "default", "acceptEdits", "bypassPermissions"]).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
  skills: z.array(SkillIdSchema).max(50).optional(),
});
export type AgentRunConstraints = z.infer<typeof AgentRunConstraintsSchema>;

/**
 * How deep delegation may nest. A root session (one nobody delegated) is depth 0; the child it
 * spawns is depth 1; that child's child is depth 2, and at `MAX_DELEGATION_DEPTH` the `agent_run`
 * family disappears from the toolset entirely.
 *
 * This replaces the flat depth-1 rule. Depth-1 was never the real constraint — it was a proxy for
 * "a delegating agent must not be able to fork-bomb the machine", chosen because with one blocking
 * run per parent there was no other bound available. The actual bound now lives where it belongs, on
 * concurrency (`MAX_RUNS_PER_PARENT` and `MAX_RUNS_TOTAL` in the delegation engine), so depth can be
 * a budget instead of a wall.
 *
 * Two is the value rather than something larger for a reason that is about legibility, not safety:
 * the human watching this has one pane per session, and a three-level tree of agents spawning agents
 * stops being something anyone can follow. The engine's total cap would hold at depth 5; the person
 * would not.
 *
 * Deliberately NOT applied to the other two delegated shapes. A browser-agent child and a reviewer
 * child stay depth-1: a reviewer that can spawn workers is no longer read-only in any sense the
 * human's ship decision can rely on, and that is a safety line, not a budget.
 */
export const MAX_DELEGATION_DEPTH = 2;

/**
 * How a delegated run ended — the delegation engine's settle vocabulary, stated once so the engine
 * and `session.agentSettled` cannot describe the same ending two ways (`ReviewOutcomeSchema` is the
 * persisted twin, and the engine's `SettledRun` is typed off this one, so a new ending that reached
 * the engine without reaching the verdict would fail to compile rather than fail to parse).
 *
 * - `done` — the child's turn ended with a report: its last status was idle and it had said something.
 * - `stopped` — a person stopped the child itself, mid-turn: it went idle with the adapter's
 *   `interrupted` mark on that status, holding whatever it had said so far. Only as good as that mark —
 *   an adapter that does not set it reports a stopped turn as `done`.
 * - `interrupted` — the delegating session was interrupted, and the run was cancelled with it.
 * - `timeout` — the child ran past its budget and was interrupted.
 * - `failed` — the child's session errored or ended before it finished.
 * - `gone` — the child's session was deleted mid-run.
 */
export const DelegationOutcomeSchema = z.enum(["done", "stopped", "interrupted", "timeout", "failed", "gone"]);
export type DelegationOutcome = z.infer<typeof DelegationOutcomeSchema>;

/**
 * Settings key for taking a finished sub-agent's pane back out of the layout when its run settles
 * `done` — the renderer's half of `session.agentSettled`. Read only by the renderer: the server
 * announces every settle whatever this says, because the announcement is a fact and this is a
 * preference about what to do with it.
 *
 * On unless it is exactly `false`. An unset key — every home from before the switch existed — and a
 * failed read both mean nobody has said otherwise, and the default is the reason the switch exists:
 * a lead agent that fans out four children otherwise leaves four finished panes to close by hand.
 */
export const CLOSE_FINISHED_AGENT_PANES_KEY = "sessions.closeFinishedAgentPanes";

/**
 * A run the delegation engine is holding open for a parent session, as the renderer reads it.
 *
 * Deliberately thin. The child is a REAL session, so its title, agent, status and space already
 * reach the renderer through the session row and the ordinary status stream; copying any of that
 * here would put a second description of the same thing on the wire, free to drift. What is left is
 * exactly what only the engine's in-memory registry knows — that this parent is waiting on this
 * session, since when, and under which of the two waits.
 */
export const DelegatedRunSchema = z.object({
  sessionId: IdSchema,
  startedAt: z.number().int(),
  /** True while the parent is free to keep working — an `agent_start` it has not collected yet.
   *  False means the parent is blocked inside the delegation call at this moment. */
  detached: z.boolean(),
  /** False when the target is a PEER the parent merely asked a question of (`agent_ask`) rather than
   *  a child it spawned. A peer was doing its own work before the question and is not the parent's
   *  to stop, so calling it a sub-agent would be wrong in both directions. */
  owned: z.boolean(),
});
export type DelegatedRun = z.infer<typeof DelegatedRunSchema>;
