import { z } from "zod";
import { ACT_PACING } from "./team-acts";
import { RISK_CLASSES, RiskClassSchema, RiskSourceSchema, type RiskClass } from "./risk-class";

/**
 * A team's policies (the dynamic-Teams plan, §4.3–4.5): what a call to a tool of each risk class, each
 * connector or each tool does in this team's space — goes ahead, asks, waits for Review and a press, or
 * never runs. Realm's gateway applies them to every Realm tool and every MCP server's tool; this module
 * is the pure half the server, Electron main and the Policies page all read.
 *
 * Three rules hold whatever the rows say (the owner's decisions, 10-09):
 *   - A "never" or "approve, then press" rule binds EVERY session in the team's space, the person's
 *     own included, in any mode. "Ask" and "without asking" bind only the team's role runs.
 *   - Something that can't be taken back runs without the person's click only by a row for ONE tool or
 *     ONE connector, never a whole class, with a daily cap no higher than the code ceilings below.
 *   - Nothing an agent can reach writes a policy. A row looser than the floor holds only with main's
 *     seal on it; without one it reads as the floor.
 */

/** From loosest to tightest. */
export const POLICY_DECISIONS = ["auto", "ask", "ticket", "block"] as const;
export const PolicyDecisionSchema = z.enum(POLICY_DECISIONS);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const decisionRank = (d: PolicyDecision): number => POLICY_DECISIONS.indexOf(d);
export const tighterDecision = (a: PolicyDecision, b: PolicyDecision): PolicyDecision => (decisionRank(a) >= decisionRank(b) ? a : b);

/** The Policies page's menu, in its words. */
export const POLICY_DECISION_WORDS: Record<PolicyDecision, string> = {
  auto: "Without asking",
  ask: "Ask each time",
  ticket: "You approve, then press each one",
  block: "Never",
};

/** From broadest to most specific: the order a call's rows are read in. */
export const POLICY_SCOPES = ["class", "verb", "connector", "tool"] as const;
export const PolicyScopeSchema = z.enum(POLICY_SCOPES);
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

/**
 * What a call of each class does with no row of its own (§4.4, invariant 1): reading and changing this
 * space go ahead, and anything elsewhere asks — per call, for what can't be taken back.
 */
export const CLASS_FLOORS: Record<RiskClass, PolicyDecision> = {
  read: "auto",
  "internal-write": "auto",
  "reversible-external": "ask",
  "irreversible-external": "ask",
};

/** A tool row's key: the connector, then the tool. */
export const toolScopeKey = (connector: string, tool: string): string => `${connector}#${tool}`;

export const PolicyWindowSchema = z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).strict()
  .refine((w) => w.end > w.start, { message: "A window ends after it starts" });

/** Per acting-as account and verb. `window` is local hours, start inclusive, end exclusive. */
export const PolicyCapsSchema = z.object({
  perDay: z.number().int().min(1).max(500).optional(),
  gapMs: z.number().int().min(0).max(86_400_000).optional(),
  teamPerDay: z.number().int().min(1).max(500).optional(),
  window: PolicyWindowSchema.optional(),
}).strict();
export type PolicyCaps = z.infer<typeof PolicyCapsSchema>;

/** The checks a row may carry (§4.3's registry), and their words. */
export const POLICY_CHECK_WORDS = {
  "consent-on-record": "consent on the record",
  disclosure: "#ad or the platform's label",
  "recipient-in-records": "the recipient is on a record",
  "sender-from-record": "sends from the record's account",
  "no-repeat-within": "no second touch too soon",
  "unsubscribe-line": "an unsubscribe line",
} as const;
export type PolicyCheckId = keyof typeof POLICY_CHECK_WORDS;
export const PolicyCheckSchema = z.object({
  id: z.enum(Object.keys(POLICY_CHECK_WORDS) as [PolicyCheckId, ...PolicyCheckId[]]),
  recordType: z.string().max(40).optional(),
  section: z.string().max(80).optional(),
  field: z.string().max(80).optional(),
  pattern: z.string().max(300).optional(),
  label: z.boolean().optional(),
  days: z.number().int().min(1).max(365).optional(),
}).strict();
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PolicySetBySchema = z.enum(["template", "user", "migration"]);

export const TeamPolicyRowSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  scope: PolicyScopeSchema,
  scopeKey: z.string().min(1).max(300),
  decision: PolicyDecisionSchema,
  caps: PolicyCapsSchema,
  checks: z.array(PolicyCheckSchema).max(10),
  setBy: PolicySetBySchema,
  /** Main's seal on the row checked out on this Mac just now. */
  sealed: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TeamPolicyRow = z.infer<typeof TeamPolicyRowSchema>;

/** What a write names: everything a row says, and nothing Realm stamps on it. */
export const TeamPolicyInputSchema = z.object({
  spaceId: z.string(),
  scope: PolicyScopeSchema,
  scopeKey: z.string().min(1).max(300),
  decision: PolicyDecisionSchema,
  caps: PolicyCapsSchema.default({}),
  checks: z.array(PolicyCheckSchema).max(10).default([]),
}).strict();
export type TeamPolicyInput = z.infer<typeof TeamPolicyInputSchema>;

/** A person's word on what one tool does (`tool_classes`), as a write names it. */
export const ToolClassInputSchema = z.object({
  spaceId: z.string(),
  connector: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  class: RiskClassSchema,
}).strict();
export type ToolClassInput = z.infer<typeof ToolClassInputSchema>;

/* ─────────────────────────────── ceilings ─────────────────────────────── */

const POST_VERBS = new Set(["post", "publish", "tweet", "share"]);
const DM_VERBS = new Set(["dm", "message", "reply", "forward", "invite"]);

/**
 * The most a tool that can't be taken back may run without a click in a day, by its verb: a post no
 * more than today's posts, a message no more than today's DMs, anything else no more than today's
 * email — the highest ceiling `ACT_PACING` holds. In code, not a setting: no row, sealed or not, goes
 * past it.
 */
export function autoCeiling(verb: string): { perDay: number; teamPerDay: number } {
  const v = verb.toLowerCase();
  const p = POST_VERBS.has(v) ? ACT_PACING.post : DM_VERBS.has(v) ? ACT_PACING.dm : ACT_PACING.email;
  return { perDay: p.perDay, teamPerDay: p.teamPerDay };
}

/** The daily cap the Policies page fills in for "without asking" on something external. */
export const AUTO_CAP_PREFILL: PolicyCaps = { perDay: 20, gapMs: 60_000 };

/* ─────────────────────────────── what a row may say ─────────────────────────────── */

const EXTERNAL: ReadonlySet<RiskClass> = new Set(["reversible-external", "irreversible-external"]);

/** What a row governs, for checking it: the classes of the tools under it, and the verbs of the ones
 *  that can't be taken back. A class row governs its own class; a verb row may govern any. */
export type PolicyCover = { classes: readonly RiskClass[]; irreversibleVerbs: readonly string[] };

/**
 * Why a row may not say what it says, in a person's words — null when it may. Asked of every write,
 * pressed or not, and again of a sealed row each time a call is resolved: a seal says the person
 * pressed it, not that a rule allows it.
 */
export function policyRowProblem(row: Pick<TeamPolicyInput, "scope" | "scopeKey" | "decision" | "caps" | "checks">, cover: PolicyCover): string | null {
  if (row.scope === "class" && !(RISK_CLASSES as readonly string[]).includes(row.scopeKey)) return "That is not a kind of action Realm knows.";
  if (row.scope === "tool" && !/^[^#]+#.+$/.test(row.scopeKey)) return "A tool's rule names its connection and the tool.";
  const capped = Object.keys(row.caps).length > 0;
  if (capped && row.decision !== "auto" && row.decision !== "ticket") return "Limits go with “Without asking” or “You approve, then press each one”.";
  if (row.checks.length > 0 && (row.decision === "block")) return "A rule that never lets a call run has nothing to check.";
  if (row.decision !== "auto") return null;
  const irreversible = cover.classes.includes("irreversible-external");
  if (irreversible && (row.scope === "class" || row.scope === "verb")) {
    return "Something that can't be taken back runs without you only for one connection or one tool, never a whole kind of action.";
  }
  if (row.scope === "verb" && cover.classes.some((c) => EXTERNAL.has(c))) return "A verb spans every connection; let one connection or one tool go without asking instead.";
  if (cover.classes.some((c) => EXTERNAL.has(c))) {
    if (row.caps.perDay === undefined) return "Without asking, a change elsewhere needs a daily limit.";
    for (const verb of irreversible ? cover.irreversibleVerbs : []) {
      const ceiling = autoCeiling(verb);
      if (row.caps.perDay > ceiling.perDay) return `Realm never lets a “${verb}” go without you more than ${ceiling.perDay} times a day.`;
      if (row.caps.teamPerDay !== undefined && row.caps.teamPerDay > ceiling.teamPerDay) return `Realm never lets a team “${verb}” without you more than ${ceiling.teamPerDay} times a day.`;
    }
  }
  return null;
}

/* ─────────────────────────────── resolving one call ─────────────────────────────── */

export type PolicyCall = {
  connector: string;
  tool: string;
  class: RiskClass;
  verb: string;
  /** Realm's own read that asks first in both engines (`REALM_TOOL_CLASSES`): its floor is ask. */
  asksFirst?: boolean;
};

export type PolicyVerdict = {
  decision: PolicyDecision;
  floor: PolicyDecision;
  /** The row that decided; null when the floor did. */
  row: TeamPolicyRow | null;
  /** A row that would have loosened this call but holds no seal that checks out — read as if absent. */
  unconfirmed: TeamPolicyRow | null;
};

/** What a call of this class does with no row at all. */
export const floorFor = (call: Pick<PolicyCall, "class" | "asksFirst">): PolicyDecision =>
  call.asksFirst && CLASS_FLOORS[call.class] === "auto" ? "ask" : CLASS_FLOORS[call.class];

/**
 * One call's decision (§4.5 step 2). The rows are read from the broadest to the most specific — its
 * class, its verb, its connector, the tool itself — starting from the floor:
 *   - a row whose seal checked out, and which a rule allows, says exactly what it says, so a sealed
 *     "without asking" for one tool stands under a class that asks;
 *   - any other row only TIGHTENS: one looser than what stands so far is set aside, and said so.
 * So a row an agent wrote with sqlite3 can make a call ask more, and never less.
 */
export function resolvePolicy(rows: readonly TeamPolicyRow[], call: PolicyCall): PolicyVerdict {
  const floor = floorFor(call);
  const keys: Record<PolicyScope, string> = { class: call.class, verb: call.verb, connector: call.connector, tool: toolScopeKey(call.connector, call.tool) };
  const cover: PolicyCover = { classes: [call.class], irreversibleVerbs: call.class === "irreversible-external" ? [call.verb] : [] };
  let decision = floor;
  let from: TeamPolicyRow | null = null;
  let unconfirmed: TeamPolicyRow | null = null;
  for (const scope of POLICY_SCOPES) {
    const row = rows.find((r) => r.scope === scope && r.scopeKey === keys[scope]);
    if (!row) continue;
    if (row.sealed && policyRowProblem(row, cover) === null) { decision = row.decision; from = row; continue; }
    if (decisionRank(row.decision) >= decisionRank(decision)) { decision = row.decision; from = row; }
    else unconfirmed = row;
  }
  return { decision, floor, row: from, unconfirmed };
}

/** "Never" and "approve, then press" bind every session in the space; "ask" and "without asking" bind
 *  only role runs, and the person's own sessions keep their mode (the owner's decision 1). */
export const bindsEverySession = (d: PolicyDecision): boolean => d === "block" || d === "ticket";

/* ─────────────────────────────── seals ─────────────────────────────── */

/** JSON with every object's keys in order, so main and the server write the same bytes for one row. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Exactly what main's seal on a policy row covers. */
export const policySealText = (r: Pick<TeamPolicyInput, "spaceId" | "scope" | "scopeKey" | "decision" | "caps" | "checks">): string =>
  canonicalJson({ kind: "team-policy", spaceId: r.spaceId, scope: r.scope, scopeKey: r.scopeKey, decision: r.decision, caps: r.caps, checks: r.checks });

/** The Keychain stamp scope one policy row's seal is tied to (`policy-stamp.ts`): moved on by every
 *  write at that scope, so a copy of an older sealed row put back reads as not confirmed. */
export const policyStampScope = (spaceId: string, scope: PolicyScope, scopeKey: string): string => `team-policy:${spaceId}|${scope}|${scopeKey}`;

/** Exactly what main's seal on a tool's class covers. */
export const toolClassSealText = (r: { profileId: string; connector: string; tool: string; class: RiskClass }): string =>
  canonicalJson({ kind: "tool-class", profileId: r.profileId, connector: r.connector, tool: r.tool, class: r.class });

export const toolClassStampScope = (profileId: string, connector: string, tool: string): string => `tool-class:${profileId}|${connector}|${tool}`;

/** A press in Realm's window, as main takes it: a policy row or a tool's class, each confirmed by
 *  macOS and sealed. The `reason` is the sentence macOS shows. */
export const PolicyPressInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("policy"), row: TeamPolicyInputSchema, reason: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("tool-class"), profileId: z.string().min(1).max(64), row: ToolClassInputSchema, reason: z.string().min(1).max(200) }).strict(),
]);
export type PolicyPressInput = z.infer<typeof PolicyPressInputSchema>;

/* ─────────────────────────────── the Policies page ─────────────────────────────── */

export const PolicyDecidedBySchema = z.enum(["floor", ...POLICY_SCOPES]);

export const TeamPolicyToolSchema = z.object({
  tool: z.string(),
  class: RiskClassSchema,
  source: RiskSourceSchema,
  verb: z.string(),
  floor: z.string().nullable(),
  overrideIgnored: z.boolean(),
  asksFirst: z.string().nullable(),
  /** What a role run's call does now: true when it shows a card, waits for Review or never runs. */
  asksToday: z.boolean(),
  /** What a role run's call does now, and which row said so. */
  decision: PolicyDecisionSchema,
  decidedBy: PolicyDecidedBySchema,
  /** A looser row for this tool holds no seal that checks out on this Mac, so it is not in force. */
  unconfirmed: z.boolean(),
});
export type TeamPolicyTool = z.infer<typeof TeamPolicyToolSchema>;

export const TeamPolicyConnectorSchema = z.object({
  /** `realm:<provider>` or `mcp:<server row id>`. */
  connector: z.string(),
  kind: z.enum(["realm", "server"]),
  /** What the person calls it: "Realm", "Linear", or a server row's own name. */
  name: z.string(),
  /** A brand mark for a connector Realm offers; null otherwise. */
  icon: z.string().nullable(),
  /** False when the server could not be reached to list its tools just now. */
  reached: z.boolean(),
  tools: z.array(TeamPolicyToolSchema),
});
export type TeamPolicyConnector = z.infer<typeof TeamPolicyConnectorSchema>;

export const TeamPoliciesSchema = z.object({
  spaceId: z.string(),
  /** The space's own name, for the page's sentences: "Versed's policy asks…". */
  spaceName: z.string(),
  profileId: z.string().nullable(),
  connectors: z.array(TeamPolicyConnectorSchema),
  /** Every row the team keeps, sealed or not, as stored. */
  rows: z.array(TeamPolicyRowSchema),
  /** Whether main answered for the seals just now; false reads every looser row as not confirmed. */
  sealsChecked: z.boolean(),
});
export type TeamPolicies = z.infer<typeof TeamPoliciesSchema>;

export const ToolClassSetResultSchema = z.object({ class: RiskClassSchema, sealed: z.boolean() });
