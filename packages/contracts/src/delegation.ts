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
  permissionMode: z.enum(["plan", "default", "acceptEdits", "bypassPermissions"]).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
  skills: z.array(SkillIdSchema).max(50).optional(),
});
export type AgentRunConstraints = z.infer<typeof AgentRunConstraintsSchema>;
