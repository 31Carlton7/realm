import { z } from "zod";
import { AGENT_META } from "./presets";
import type { AgentKind } from "./entities";

/**
 * What a provider says about the plan the user is on and how much of it is left.
 *
 * Deliberately separate from `usage.ts`, which answers a different question: that module counts what
 * Realm itself observed (tokens on the wire, dollars from a catalog) and can therefore answer for
 * every agent. This one is the PROVIDER's own accounting of an account's quota — it cannot be
 * derived, estimated, or summed, and for most agent kinds it cannot be answered at all.
 */

/**
 * One rate-limit window, as a provider reports it.
 *
 * `id` is the provider's own key where it has one (`five_hour`, `seven_day`) and a synthetic
 * `model:<label>` where it does not — Claude's per-model weekly buckets arrive in a `model_scoped`
 * array carrying a server-supplied `display_name` rather than a fixed key, so the Fable window has
 * no stable id to hardcode and neither will the next model's.
 */
export const PlanWindowSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Percent of the window consumed, 0-100. Null when the provider named the window but not its
   *  utilization — which it does, and which must not be drawn as a full bar or an empty one. */
  utilization: z.number().nullable(),
  /** Epoch ms when the window resets, or null. Stored absolute rather than as "in 3 hours": the
   *  panel may sit open for longer than the window has left. */
  resetsAt: z.number().nullable(),
});
export type PlanWindow = z.infer<typeof PlanWindowSchema>;

/**
 * How close to the limit the PROVIDER thinks we are.
 *
 * Taken from the provider's own verdict, never from a percentage Realm compared against a threshold
 * it chose. Claude's SDK reports `allowed | allowed_warning | rejected` directly, and a warning it
 * raises at a utilization Realm would have thought was fine is still a warning the user needs.
 */
export const PLAN_ALERTS = ["none", "approaching", "exceeded"] as const;
export const PlanAlertSchema = z.enum(PLAN_ALERTS);
export type PlanAlert = z.infer<typeof PlanAlertSchema>;

/** Why there is nothing to report. Each value is a real answer, and none of them is "0%". */
export const PLAN_LIMITS_UNAVAILABLE = [
  /** This agent kind's protocol has no rate-limit or plan concept. */
  "unsupported",
  /** The kind could report, but no session has run yet — nothing has arrived to report. */
  "not-yet-known",
  /** Billing is per-token against an API key, or a third-party platform (Bedrock, Vertex, Foundry).
   *  There is no subscription quota, so an empty panel here is correct rather than missing. */
  "not-on-a-plan",
  /** The provider was asked and the call failed or is no longer there — see `PlanLimits.detail`. */
  "unreadable",
] as const;
export const PlanLimitsUnavailableSchema = z.enum(PLAN_LIMITS_UNAVAILABLE);
export type PlanLimitsUnavailable = z.infer<typeof PlanLimitsUnavailableSchema>;

export const PlanLimitsSchema = z.object({
  agentKind: z.string().min(1),
  /** The provider's word for the tier, verbatim (`pro`, `max`, `team`, `enterprise`). Kept raw and
   *  titled only at the edge, so a tier Realm has never heard of still renders as itself. */
  subscriptionType: z.string().nullable(),
  /** The organization, when the provider names one — a team seat is a different thing to explain
   *  than a personal plan at the same tier. */
  organization: z.string().nullable(),
  windows: z.array(PlanWindowSchema),
  alert: PlanAlertSchema,
  /** Which window the alert is about, by `id`. Null when the provider warned without naming one. */
  alertWindow: z.string().nullable(),
  unavailable: PlanLimitsUnavailableSchema.nullable(),
  /** A provider-supplied reason worth showing beside `unavailable` — the SDK's own
   *  `overageDisabledReason`, or the message from a failed read. Never invented. */
  detail: z.string().nullable(),
  /** When this was last heard. A stale panel says how stale rather than looking current. */
  ts: z.number(),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

/**
 * What each agent kind can actually answer.
 *
 * Same discipline as `USAGE_REPORTING`: widening `AgentKind` is a compile error here until the new
 * engine's answer is stated, because a kind defaulting to "reports limits" would draw an empty panel
 * that reads as "you have used nothing" when the truth is "nobody asked".
 */
export type PlanLimitReporting = {
  /** Where the numbers come from, or `none` when the protocol has no notion of them. */
  source: "claude-sdk" | "codex-app-server" | "none";
  /** Whether the provider names the plan tier. */
  plan: boolean;
  /** Whether it raises its own warning BEFORE the limit is hit. Without this, the best Realm can do
   *  is draw a bar — there is no honest "you are about to run out". */
  warns: boolean;
};

export const PLAN_LIMIT_REPORTING: Record<AgentKind, PlanLimitReporting> = {
  // `SDKRateLimitEvent` on the message stream (status + utilization + resetsAt + rateLimitType), plus
  // the control call behind `/usage` for every window at once and the subscription tier.
  claude: { source: "claude-sdk", plan: true, warns: true },
  // `account/rateLimits/updated`, captured live from codex-cli 0.154.0 (the verbatim payload is in
  // docs/dev/codex-app-server-protocol.md §3). Two windows, 300 and 10080 minutes — the same 5-hour
  // and weekly pair Claude reports.
  //
  // `warns: false`, and the asymmetry is real rather than an omission: the only status on this wire
  // is `rateLimitReachedType`, which reports a limit ALREADY hit. There is no approaching-the-limit
  // signal, so a Codex account gets the bars in Settings but no push warning before it runs out.
  // Deriving one from `usedPercent` would mean Realm picking the threshold, which is the one thing
  // this module refuses to do — the provider owns the verdict or there is no verdict.
  //
  // `plan: true` because the channel exists (`planType`), not because it answered: on a live ChatGPT
  // account it was the literal string "unknown", which the mapper carries through as null so the card
  // says "plan not reported" instead of inventing a tier.
  codex: { source: "codex-app-server", plan: true, warns: false },
  // No ACP kind has a rate-limit or plan concept anywhere in the protocol — there is no request to
  // make and no notification to listen for. Absence is the honest answer, not a zeroed bar.
  "acp:gemini": { source: "none", plan: false, warns: false },
  "acp:cursor": { source: "none", plan: false, warns: false },
  "acp:opencode": { source: "none", plan: false, warns: false },
  "acp:copilot": { source: "none", plan: false, warns: false },
  "acp:goose": { source: "none", plan: false, warns: false },
  "acp:qwen": { source: "none", plan: false, warns: false },
  "acp:grok": { source: "none", plan: false, warns: false },
  "acp:fx": { source: "none", plan: false, warns: false },
  "acp:deepseek": { source: "none", plan: false, warns: false },
  "acp:openhands": { source: "none", plan: false, warns: false },
  "acp:hermes": { source: "none", plan: false, warns: false },
  // The scripted adapter reports, because it is the only kind that can drive this whole path in a
  // test — the same keep-its-keep argument `USAGE_REPORTING` makes for `fake` being `per-turn`.
  fake: { source: "claude-sdk", plan: true, warns: true },
};

export const reportsPlanLimits = (kind: AgentKind): boolean => PLAN_LIMIT_REPORTING[kind].source !== "none";

/**
 * Human labels for the windows Claude's SDK names.
 *
 * The five-hour window is what a person means by "hourly" and the seven-day one by "weekly", so those
 * are the words used; `seven_day_opus` and `seven_day_sonnet` are the two model buckets with fixed
 * keys. A key absent from this map is labelled by `planWindowLabel` from the key itself rather than
 * dropped — the provider adds windows on its own schedule, and one Realm cannot name is still one the
 * user is being limited by.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_oauth_apps: "Weekly (connected apps)",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
  seven_day_overage_included: "Weekly (with extra usage)",
  overage: "Extra usage",
};

/**
 * A window's label from the length of the window itself.
 *
 * Codex names its two windows `primary` and `secondary` — positions, not durations — and puts the
 * duration in `windowDurationMins` beside them. Reading the label off the duration is what makes
 * "5-hour" and "Weekly" line up with the windows Claude reports under those names, and what keeps
 * the labels right if Codex ever changes what primary means. Measured on codex-cli 0.154.0:
 * `primary` is 300 minutes and `secondary` is 10080.
 */
export function windowLabelForMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Plan";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) { const d = minutes / 1440; return d === 1 ? "Daily" : `${d}-day`; }
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** A window id as a label. Unknown ids become sentence-cased words rather than vanishing. */
export function planWindowLabel(id: string): string {
  const known = WINDOW_LABELS[id];
  if (known) return known;
  // `model:Fable` — the server named this bucket itself, so its label is the authority.
  if (id.startsWith("model:")) return `${id.slice("model:".length)} weekly`;
  const words = id.replace(/_/g, " ").trim();
  return words.length === 0 ? id : words[0]!.toUpperCase() + words.slice(1);
}

/**
 * The plan, named for a person: "Claude Max", "Codex Pro".
 *
 * The agent's label leads because a workspace runs several providers at once and a bare "Max" does
 * not say whose. The tier is title-cased but otherwise untouched, so a tier this build has never
 * seen renders as the provider spelled it instead of falling back to "Unknown".
 */
export function planLabel(kind: AgentKind, subscriptionType: string | null): string | null {
  if (!subscriptionType) return null;
  const tier = subscriptionType.trim();
  if (tier.length === 0) return null;
  return `${AGENT_META[kind].label} ${tier[0]!.toUpperCase()}${tier.slice(1)}`;
}

/** One sentence for a panel with nothing to draw. */
export function planUnavailableNote(kind: AgentKind, reason: PlanLimitsUnavailable): string {
  const label = AGENT_META[kind].label;
  switch (reason) {
    case "unsupported": return `${label} does not report plan limits.`;
    case "not-yet-known": return `Run a ${label} session and its plan limits will appear here.`;
    case "not-on-a-plan": return `This ${label} account bills per token, so there is no plan quota to show.`;
    case "unreadable": return `${label} could not be asked for its plan limits.`;
  }
}

/**
 * The windows worth putting in front of someone who is running out, most urgent first.
 *
 * Sorted by utilization rather than by the provider's key order: the question the panel answers is
 * "what stops me first", and that is whichever bar is fullest, not whichever window the wire happened
 * to list first. A window with no utilization sorts last — it cannot be the answer.
 */
export function windowsByUrgency(windows: readonly PlanWindow[]): PlanWindow[] {
  return [...windows].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
}

/** The fullest window, or null when none of them reported a number. What a one-line chip shows. */
export function tightestWindow(windows: readonly PlanWindow[]): PlanWindow | null {
  const [first] = windowsByUrgency(windows);
  return first && first.utilization !== null ? first : null;
}

/**
 * Lay fresher window readings over a fuller set, by id.
 *
 * The two sources report different amounts: the control request answers every window but knows
 * nothing about status, and the stream event carries status plus the ONE window that moved. Merging
 * by id keeps the complete list while letting the moved window's newer number win — taking either
 * side wholesale would mean a panel that is either complete and stale or current and nearly empty.
 *
 * Ids the fuller set does not have are appended: the stream is free to name a window this build's
 * label map has never seen, and dropping it would hide a limit the user is actually being held to.
 */
export function mergeWindows(base: readonly PlanWindow[], fresher: readonly PlanWindow[]): PlanWindow[] {
  const merged = base.map((w) => fresher.find((f) => f.id === w.id) ?? w);
  const known = new Set(base.map((w) => w.id));
  return [...merged, ...fresher.filter((f) => !known.has(f.id))];
}
