import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * Moving a started session to somewhere else to run (docs/superpowers/specs/2026-11-03-switch-session-runtime.md).
 *
 * Phase 1 moves within this machine: to another of the space's checkouts, or to a new worktree made
 * for the move. The session keeps its id, its transcript and its queue; what changes is the
 * environment it runs in, and whatever the agent needs to find its conversation there.
 */

/** Where a move sends the session. A new worktree branches off `from` (the session's own checkout
 *  when absent) at `base` (the session's HEAD when absent). */
export const MoveTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("environment"), environmentId: IdSchema }),
  z.object({ kind: z.literal("worktree"), from: IdSchema.nullable().optional(), base: z.string().nullable().optional() }),
]);
export type MoveTarget = z.infer<typeof MoveTargetSchema>;

/**
 * When a move asked for during a turn happens. `now` is refused mid-turn (SESSION_BUSY); `after-turn`
 * waits for the turn to settle; `stop` stops the turn, denying any open permission card, and moves.
 * Between turns all three move at once.
 */
export const MoveWhenSchema = z.enum(["now", "after-turn", "stop"]);
export type MoveWhen = z.infer<typeof MoveWhenSchema>;

/** The pipeline's steps, in order: what the progress row names, and where a failure happened. */
export const MoveStepSchema = z.enum(["preflight", "freeze", "snapshot", "place", "boot", "commit"]);
export type MoveStep = z.infer<typeof MoveStepSchema>;

/** One end of a move. `machine` is null for this server, the only machine phase 1 moves within. */
export const MovePlaceSchema = z.object({
  machine: z.string().nullable(),
  environmentId: IdSchema,
  cwd: z.string(),
  branch: z.string().nullable(),
});
export type MovePlace = z.infer<typeof MovePlaceSchema>;

/**
 * How the conversation travels. `native`: the agent resumes its own record of it in the new place.
 * `notes`: the agent starts fresh there, handed the conversation as a hand-off note.
 */
export const MoveConversationSchema = z.enum(["native", "notes"]);
export type MoveConversation = z.infer<typeof MoveConversationSchema>;

/** What the Move sheet shows before anything happens (`sessions.moveOptions`). */
export const MoveOptionsSchema = z.object({
  from: MovePlaceSchema,
  /** A turn is live: the sheet offers Move after this turn or Stop and move. */
  busy: z.boolean(),
  /** Why this session cannot move at all, or null. A teammate's chat, a sub-agent still running. */
  blocked: z.string().nullable(),
  /** A move of this session is queued behind the turn, or under way. */
  pending: z.boolean(),
  /** How the conversation would travel, as far as Realm can tell beforehand. Codex and the ACP
   *  agents are asked at boot, and one that declines moves on notes after all. */
  conversation: MoveConversationSchema,
  /** Uncommitted paths in the session's checkout, untracked files included. They go with it. */
  changedFiles: z.number().int(),
  /** What stays behind, by name: the terminal, and ignored files that look like secrets. */
  leftBehind: z.array(z.string()),
  /** What the agent is running beyond a turn — background tasks, commands, scheduled jobs — which only
   *  Stop and move stops; any other move is refused (MOVE_STOPS_WORK) while it runs. */
  stops: z.array(z.string()).optional(),
  /** The space's other checkouts the session can move to. */
  environments: z.array(z.object({ environmentId: IdSchema, path: z.string(), branch: z.string().nullable(), kind: z.string() })),
  /** Whether a new worktree can be made for it, and why not when it cannot. */
  worktree: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type MoveOptions = z.infer<typeof MoveOptionsSchema>;
