import { z } from "zod";
import { IdSchema } from "./entities";
import { GoalStatusSchema } from "./goal";

/**
 * Teams, Phase 4: roles that pass work to each other, roles woken by a mention, roles given a goal,
 * and the limits every unattended run waits behind.
 *
 * A HANDOFF is one role passing work to another along an edge the person drew on the role's page
 * ("Content Producer hands off to Creator Manager"), with a note, the record it is about and the
 * files that go with it. It wakes the receiving role as an ordinary run — one live run per role and
 * record, so a second handoff about the same creator does not start a second run.
 *
 * A MENTION is `@Creator Manager` in a session — the person's prompter, or an agent's `team_mention`
 * call. It starts the role as that session's sub-agent through the delegation tools every session
 * already has, so it shows in the lead's Agents tab and runs in the lead's mode or the role's,
 * whichever is tighter. A person asked, so it waits on no slot.
 */

export const TEAM_HANDOFF_TOOL = "team_handoff";
export const TEAM_MENTION_TOOL = "team_mention";

export const HANDOFF_KINDS = ["handoff", "mention"] as const;
export const HandoffKindSchema = z.enum(HANDOFF_KINDS);
export type HandoffKind = z.infer<typeof HandoffKindSchema>;

/** Where a handoff or mention stands, read off the run or sub-agent it started. */
export const HANDOFF_STATES = ["queued", "working", "needs-you", "done", "failed", "stopped"] as const;
export const HandoffStateSchema = z.enum(HANDOFF_STATES);
export type HandoffState = z.infer<typeof HandoffStateSchema>;

export const TeamHandoffSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  kind: HandoffKindSchema,
  /** The role that handed off; null for a mention from a person's or an agent's session. */
  fromRoleId: z.string().nullable(),
  /** The session the handoff or mention was made in. */
  fromSessionId: z.string().nullable(),
  toRoleId: z.string(),
  recordPath: z.string().nullable(),
  note: z.string(),
  /** Space-relative paths passed with it. */
  files: z.array(z.string()),
  /** The run a handoff started. */
  runId: z.string().nullable(),
  /** The session doing the work: the run's, or the mention's sub-agent. */
  sessionId: z.string().nullable(),
  state: HandoffStateSchema,
  costUsd: z.number().nullable(),
  createdAt: z.number().int(),
  settledAt: z.number().int().nullable(),
});
export type TeamHandoff = z.infer<typeof TeamHandoffSchema>;

/** A role's goal, as its page shows it: what it is working toward, and where the loop stands. `queued`
 *  is a goal whose run is waiting for a slot and has no session yet. */
export const RoleGoalSchema = z.object({
  runId: z.string(),
  sessionId: z.string().nullable(),
  objective: z.string(),
  status: z.union([GoalStatusSchema, z.literal("queued")]),
  turns: z.number().int(),
  note: z.string().nullable(),
  startedAt: z.number().int(),
});
export type RoleGoal = z.infer<typeof RoleGoalSchema>;

/** An engine said its account hit a rate or plan limit: unattended runs on it wait until `until`. */
export const TeamBackoffSchema = z.object({
  agentKind: z.string(),
  until: z.number().int(),
  why: z.string(),
  since: z.number().int(),
});
export type TeamBackoff = z.infer<typeof TeamBackoffSchema>;

/** How many runs may go at once, how many are, and any back-off in force — the plan-limit protection,
 *  said where the person looks. */
export const TeamLimitsSchema = z.object({
  teamMaxLive: z.number().int(),
  realmMaxUnattended: z.number().int(),
  /** This team's role runs going now. */
  teamRunning: z.number().int(),
  /** Every team's role runs going now, across Realm. */
  realmRunning: z.number().int(),
  /** This team's role runs waiting for a slot. */
  teamQueued: z.number().int(),
  backoff: z.array(TeamBackoffSchema),
});
export type TeamLimits = z.infer<typeof TeamLimitsSchema>;

/** Who a starter hands off to when a team is made, by template id. The person changes them on the
 *  role's page; these are only where a new team starts. */
export const TEMPLATE_HANDOFFS: Readonly<Record<string, readonly string[]>> = {
  "content-producer": ["creator-manager", "editor"],
  "creator-manager": ["content-producer"],
  researcher: ["editor"],
  "community-manager": ["creator-manager"],
};

export const SetRoleHandoffsSchema = z.object({
  id: IdSchema,
  /** Role ids this role may hand work to. */
  handsOffTo: z.array(IdSchema).max(20).optional(),
  wakeOnMention: z.boolean().optional(),
});
export type SetRoleHandoffsInput = z.infer<typeof SetRoleHandoffsSchema>;

export const SetTeamLimitsSchema = z.object({
  spaceId: IdSchema,
  /** This team's runs at once. */
  teamMaxLive: z.number().int().min(1).max(10).optional(),
  /** Unattended runs at once across Realm. */
  realmMaxUnattended: z.number().int().min(1).max(10).optional(),
});

/**
 * A back-off's end, read from what the engine said. A `rate_limit` reading names its window's reset;
 * Claude's own "usage limit reached|<epoch seconds>" names one too. Anything else gets an hour, which
 * the line says — never a retry into the limit a minute later.
 */
export function backoffUntil(source: { windows?: readonly { id: string; utilization: number | null; resetsAt: number | null }[]; alertWindow?: string | null; message?: string },
  now: number): { until: number; named: boolean } {
  const ws = source.windows ?? [];
  const named = ws.find((w) => w.id === source.alertWindow && w.resetsAt !== null)
    ?? ws.filter((w) => w.resetsAt !== null && (w.utilization ?? 0) >= 100).sort((a, b) => b.resetsAt! - a.resetsAt!)[0];
  if (named?.resetsAt && named.resetsAt > now) return { until: named.resetsAt, named: true };
  const epoch = source.message ? /\|(\d{10})\b/.exec(source.message)?.[1] : undefined;
  if (epoch && Number(epoch) * 1000 > now) return { until: Number(epoch) * 1000, named: true };
  return { until: now + 60 * 60_000, named: false };
}
