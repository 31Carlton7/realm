import { z } from "zod";
import { AgentKindSchema, type AgentKind } from "./entities";

/**
 * What a session cost, and what Realm is allowed to CLAIM it cost.
 *
 * The stats page reads one persisted source: `session_events` rows of type `usage`. That source is
 * far less uniform than its schema suggests, and every number the page draws depends on knowing how
 * it is uneven. The three facts that shape this whole module:
 *
 * 1. **Only two of the twelve agent kinds report anything at all.** `claude` emits a real
 *    `total_cost_usd` plus token counts (map-sdk-message.ts); `codex` emits token counts with
 *    `costUsd: 0` (map-codex.ts, `thread/tokenUsage/updated`). Every `acp:*` kind emits NOTHING —
 *    docs/dev/acp-protocol.md §"usage" records why: **ACP 0.4.5 has no token-usage message**, and
 *    scraping `_meta` per agent is called out there as unverified and agent-specific. So nine of the
 *    eleven selectable engines can only ever be measured in ACTIVITY (sessions, turns, tool calls),
 *    never in tokens. The page must say "not reported" for those, never `$0.00` — a zero is a claim
 *    about spend, and it would be a false one.
 *
 * 2. **The series semantics differ per adapter.** Codex's payload is the thread's RUNNING TOTAL, and
 *    so is Claude's: `claude-adapter.ts` opens ONE long-lived `query()` per session in streaming-input
 *    mode ("init arrives after the first send in streaming mode") and every user turn yields another
 *    `result` message carrying the conversation's totals to date. The renderer has always agreed with
 *    that reading — `reduceTranscript` REPLACES usage rather than adding to it (transcript-model.ts),
 *    and the session header shows the result as the session's cost. A naive `SUM(costUsd)` over the
 *    events would therefore scale with the square of the turn count. Everything here works in
 *    DELTAS instead, computed once by `usageDeltas`.
 *
 * 3. **A reported dollar is not the user's bill.** Claude Code bills through a Claude subscription;
 *    `catalog.ts` makes the same point about its OpenRouter prices and refuses to show one without
 *    the harness's billing line beside it. Nothing here is a statement about money leaving an
 *    account — it is what the run would have cost at list price. `UsageCostBasis` keeps the two
 *    apart on every row so the UI can label them differently, which it does.
 */

/** How an agent kind's `usage` events behave, or that it emits none. Exhaustive over `AgentKind`, so
 *  a new engine cannot be added without answering the question. */
export type UsageSeriesKind =
  /** Each event carries the session's RUNNING TOTAL. Deltas are differences; a drop means a restart. */
  | "cumulative"
  /** Each event carries only its own turn. Deltas are the values themselves. */
  | "per-turn"
  /** The adapter emits no `usage` event at all. Nothing to read; the session shows activity only. */
  | "none";

/** Where a dollar figure came from — carried beside every cost so the UI never presents an estimate
 *  as a report. `none` is NOT zero: it means the question cannot be answered for this session. */
export type UsageCostBasis = "reported" | "estimated" | "none";

export type UsageReporting = {
  series: UsageSeriesKind;
  /** Whether the adapter reports token counts we can bill against a catalog price. */
  tokens: boolean;
  /** The best basis available for this kind. `reported` still falls back to `estimated` for a
   *  session whose events happen to carry zeros, and to `none` when there are no events at all. */
  cost: UsageCostBasis;
};

/**
 * The table the whole module hangs on. Widening `AgentKindSchema` is a compile error here until the
 * new engine's reporting is stated — which is the point: a kind silently defaulting to "cumulative"
 * would produce confident, wrong dollars.
 *
 * `fake` is `per-turn` because that is what `fake-adapter.ts` actually does (a fixed
 * `{ costUsd: 0.001, … }` pushed once per turn). It is the dev harness's kind, and it earns its keep
 * here by being the one kind that exercises the per-turn branch.
 */
export const USAGE_REPORTING: Record<AgentKind, UsageReporting> = {
  claude: { series: "cumulative", tokens: true, cost: "reported" },
  codex: { series: "cumulative", tokens: true, cost: "estimated" },
  "acp:gemini": { series: "none", tokens: false, cost: "none" },
  "acp:cursor": { series: "none", tokens: false, cost: "none" },
  "acp:opencode": { series: "none", tokens: false, cost: "none" },
  "acp:copilot": { series: "none", tokens: false, cost: "none" },
  "acp:goose": { series: "none", tokens: false, cost: "none" },
  "acp:qwen": { series: "none", tokens: false, cost: "none" },
  "acp:grok": { series: "none", tokens: false, cost: "none" },
  "acp:fx": { series: "none", tokens: false, cost: "none" },
  "acp:deepseek": { series: "none", tokens: false, cost: "none" },
  fake: { series: "per-turn", tokens: true, cost: "reported" },
};

/** One `usage` event as the aggregator reads it: the payload's four numbers plus when it landed. */
export type UsageSample = { ts: number; costUsd: number; inputTokens: number; outputTokens: number; numTurns: number };
/** What one event ADDED. Always non-negative; `ts` is the event's own, so deltas bucket by time. */
export type UsageDelta = { ts: number; costUsd: number; inputTokens: number; outputTokens: number; turns: number };

const EMPTY_DELTA = { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };

/**
 * Turn one session's `usage` events into per-event increments.
 *
 * For a `cumulative` series this is consecutive differences, with one wrinkle that is not
 * hypothetical: `claude-adapter.ts` passes `resume` when a session is picked back up, which starts a
 * fresh `query()` whose counters begin again at zero. A value BELOW its predecessor is therefore a
 * restart, not a refund — the new value is taken whole and becomes the new baseline. Clamping to
 * zero instead would silently drop everything a resumed session went on to spend.
 *
 * `samples` must be in event order (ascending `seq`, which is ascending `ts`). Callers that hold
 * events for several sessions must split them per session first: two sessions' running totals
 * interleaved would read as a storm of restarts.
 */
export function usageDeltas(samples: readonly UsageSample[], series: UsageSeriesKind): UsageDelta[] {
  if (series === "none") return [];
  if (series === "per-turn") {
    return samples.map((s) => ({
      ts: s.ts,
      costUsd: Math.max(0, s.costUsd), inputTokens: Math.max(0, s.inputTokens),
      outputTokens: Math.max(0, s.outputTokens), turns: Math.max(0, s.numTurns),
    }));
  }
  const out: UsageDelta[] = [];
  let prev = { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 };
  for (const s of samples) {
    // A restart is judged on the whole tuple, not field by field: a turn that spends no output tokens
    // leaves that one field flat while the others climb, and treating THAT as a restart would re-add
    // the running total. Any field going backwards is the signal.
    const restarted = s.costUsd < prev.costUsd || s.inputTokens < prev.inputTokens
      || s.outputTokens < prev.outputTokens || s.numTurns < prev.numTurns;
    const base = restarted ? { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 } : prev;
    out.push({
      ts: s.ts,
      costUsd: Math.max(0, s.costUsd - base.costUsd),
      inputTokens: Math.max(0, s.inputTokens - base.inputTokens),
      outputTokens: Math.max(0, s.outputTokens - base.outputTokens),
      turns: Math.max(0, s.numTurns - base.numTurns),
    });
    prev = s;
  }
  return out;
}

/** Add up deltas. Separate from `usageDeltas` because the page sums the same deltas three ways —
 *  per session, per time bucket, per breakdown key — and each of those is a different grouping of
 *  one list, never a second reading of the events. */
export function sumDeltas(deltas: readonly UsageDelta[]): Omit<UsageDelta, "ts"> {
  return deltas.reduce((a, d) => ({
    costUsd: a.costUsd + d.costUsd, inputTokens: a.inputTokens + d.inputTokens,
    outputTokens: a.outputTokens + d.outputTokens, turns: a.turns + d.turns,
  }), { ...EMPTY_DELTA });
}

/**
 * List-price cost for a token count, or `null` when the catalog quoted no price for the model.
 *
 * `null` and `0` are different answers and stay different all the way to the screen: a free tier is
 * a real zero, an unknown model is a gap. Prices are per MILLION tokens (`ModelInfo.priceIn`), which
 * is the unit `catalog.ts` already converted to so that no caller multiplies by 1e6 twice.
 */
export function estimateCostUsd(
  inputTokens: number, outputTokens: number,
  price: { priceIn: number | null; priceOut: number | null } | null,
): number | null {
  if (!price || (price.priceIn === null && price.priceOut === null)) return null;
  const inUsd = (price.priceIn ?? 0) * (inputTokens / 1_000_000);
  const outUsd = (price.priceOut ?? 0) * (outputTokens / 1_000_000);
  return inUsd + outUsd;
}

/* ────────────────────────────── time buckets ────────────────────────────── */

export const USAGE_BUCKETS = ["day", "week", "month"] as const;
export const UsageBucketSchema = z.enum(USAGE_BUCKETS);
export type UsageBucketKind = z.infer<typeof UsageBucketSchema>;

/**
 * The start of the bucket a timestamp falls in, in the LOCAL zone.
 *
 * Local rather than UTC because the user reads "yesterday" off a wall clock, and a UTC day boundary
 * would file an 8pm PDT session under tomorrow. `new Date(y, m, d)` is the local-midnight
 * constructor, so DST transitions land on the right day without arithmetic on 86_400_000 — a
 * fixed-length day is exactly what breaks twice a year.
 *
 * Weeks start Monday: `getDay()` returns 0 for Sunday, so the shift is `(day + 6) % 7`.
 */
export function bucketStart(ts: number, kind: UsageBucketKind): number {
  const d = new Date(ts);
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (kind === "week") {
    const back = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The bucket after this one. Same local-calendar arithmetic, for the same DST reason. */
export function bucketNext(start: number, kind: UsageBucketKind): number {
  const d = new Date(start);
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (kind === "week" ? 7 : 1)).getTime();
}

/**
 * Every bucket start from `from` to `to` inclusive of the bucket `to` lands in.
 *
 * The series is built from the RANGE, not from the data, so a week with no sessions renders as a gap
 * in the chart rather than vanishing and silently compressing the axis. Capped at `limit` buckets so
 * a range typed as "since 1970" cannot allocate for years.
 */
export function bucketRange(from: number, to: number, kind: UsageBucketKind, limit = 800): number[] {
  const out: number[] = [];
  let cur = bucketStart(from, kind);
  const end = bucketStart(to, kind);
  while (cur <= end && out.length < limit) { out.push(cur); cur = bucketNext(cur, kind); }
  return out;
}

/** Presets for the range row, newest-first as the picker lists them. `null` days means all of time. */
export const USAGE_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "all", label: "All time", days: null },
] as const;
export type UsageRangeId = (typeof USAGE_RANGES)[number]["id"];

/** The bucket that keeps a range readable: days for a week or a month, weeks for a quarter, months
 *  for all of time. A 90-day range drawn in days is 90 columns in a settings pane — unreadable. */
export function defaultBucketFor(days: number | null): UsageBucketKind {
  if (days === null) return "month";
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

/* ────────────────────────────── budget ────────────────────────────── */

/** `settings` row holding the budget. Generic table, so no migration (the `models.catalog` posture). */
export const USAGE_BUDGET_KEY = "usage.budget";

/**
 * A monthly ceiling and the fractions of it worth interrupting the user for.
 *
 * `monthlyUsd: null` means no budget — the page still reports, it just draws no meter and fires no
 * notification. Thresholds are fractions (0.8 = 80%), sorted and de-duplicated on write so the
 * crossing check can walk them in order.
 *
 * The honesty caveat the UI must repeat: for `codex` the spend being measured is ESTIMATED from
 * catalog list prices, so a budget alert is an alert about an estimate. That is worth having and
 * worth labelling; it is not worth pretending otherwise.
 */
export const UsageBudgetSchema = z.object({
  monthlyUsd: z.number().nonnegative().nullable().default(null),
  /**
   * Deliberately permissive per item: the range rule lives in `normalizeThresholds` alone, and this
   * array only has to be an array of numbers.
   *
   * Enforcing `gt(0).lte(2)` here as well made ONE bad threshold fail the whole object, which
   * `parseUsageBudget` then answered with the default — so a client that sent `[0.5, 99]` alongside a
   * perfectly good $50 ceiling silently lost the ceiling too. Filtering the offending entry and
   * keeping the rest is both what the user meant and what the write path already promised by
   * answering with the stored budget.
   */
  thresholds: z.array(z.number()).default([0.5, 0.8, 1]),
  /** Whether estimated spend counts toward the budget. Off means only `reported` dollars do — the
   *  strict reading, which for today's engines means Claude alone. */
  includeEstimated: z.boolean().default(true),
});
export type UsageBudget = z.infer<typeof UsageBudgetSchema>;

export const DEFAULT_USAGE_BUDGET: UsageBudget = { monthlyUsd: null, thresholds: [0.5, 0.8, 1], includeEstimated: true };

/** Parse a stored budget, falling back to the default rather than throwing: the `settings` table is
 *  user-editable JSON and a bad row must not take the page down (`SettingsStore.getIds`' posture). */
export function parseUsageBudget(raw: unknown): UsageBudget {
  const parsed = UsageBudgetSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_USAGE_BUDGET };
  return { ...parsed.data, thresholds: normalizeThresholds(parsed.data.thresholds) };
}

export function normalizeThresholds(thresholds: readonly number[]): number[] {
  return [...new Set(thresholds.filter((t) => t > 0 && t <= 2))].sort((a, b) => a - b);
}

/**
 * The thresholds crossed by moving from `before` to `after` spend against `monthlyUsd`.
 *
 * Takes both endpoints rather than just the new total so the caller fires ONE notification per
 * crossing: re-deriving "are we over 80%?" from the total alone would re-fire on every subsequent
 * usage event for the rest of the month. Returns them in ascending order, so a single expensive turn
 * that vaults 50% and 80% at once reports both.
 */
export function thresholdsCrossed(before: number, after: number, budget: UsageBudget): number[] {
  if (budget.monthlyUsd === null || budget.monthlyUsd <= 0 || after <= before) return [];
  return normalizeThresholds(budget.thresholds)
    .filter((t) => { const at = t * budget.monthlyUsd!; return before < at && after >= at; });
}

/* ────────────────────────────── formatting ────────────────────────────── */

/**
 * Money, at the precision the number deserves.
 *
 * Agent runs cost fractions of a cent often enough that a flat 2dp renders a whole page of `$0.00`,
 * which reads as "nothing was spent" rather than "less than a cent". Sub-cent values keep enough
 * digits to be a number; everything else is the ordinary 2dp, and thousands get a separator.
 */
export function formatUsd(usd: number): string {
  const abs = Math.abs(usd);
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `$${usd.toFixed(4)}`;
  if (abs < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Token counts, compacted. `formatContext` in catalog.ts does this for context WINDOWS (round
 *  numbers by construction); usage counts are arbitrary, so this keeps a decimal where it matters. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

/* ────────────────────────────── the page's payload ────────────────────────────── */

/** One breakdown axis. Each is a grouping of the SAME deltas, never a re-read of the events. */
export const USAGE_DIMENSIONS = ["agent", "model", "space", "environment"] as const;
export const UsageDimensionSchema = z.enum(USAGE_DIMENSIONS);
export type UsageDimension = z.infer<typeof UsageDimensionSchema>;

/**
 * How many series a stacked chart may carry before the tail folds into "Other".
 *
 * Eight is the categorical palette's hard ceiling — a ninth hue is indistinguishable from an
 * existing one under simulated colour-vision deficiency — and the eighth slot is reserved for
 * "Other" itself, so seven real series is the cap.
 */
export const USAGE_SERIES_CAP = 7;
export const USAGE_OTHER_KEY = "__other__";

export const UsageTotalsSchema = z.object({
  costUsd: z.number(),
  /** The `reported` half of `costUsd` — dollars an agent actually stated. */
  reportedUsd: z.number(),
  /** The `estimated` half — catalog list price applied to reported tokens. */
  estimatedUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  turns: z.number(),
  sessions: z.number(),
  /** Sessions in this group whose engine reports no usage at all. Their tokens and dollars are not
   *  zero, they are UNKNOWN, and the UI says so instead of drawing a zero-height bar. */
  unmeasuredSessions: z.number(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageSeriesPointSchema = z.object({ bucket: z.number().int(), totals: UsageTotalsSchema });
export const UsageBreakdownRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  /**
   * The row's categorical palette slot, assigned by the server and stable across queries.
   *
   * This exists to defeat recolour-on-filter: if the client coloured by row index after sorting the
   * table by spend, a reader who learned "Codex is orange" would watch it turn green the moment a
   * different range put another engine on top. Rows are emitted in an INTRINSIC order (engines in
   * `SELECTABLE_AGENT_KINDS` order, spaces in their own sort order, models and checkouts
   * alphabetically) and the slot follows that, so re-sorting the table for display repaints nothing
   * and changing the range only moves a colour when the set of rows itself changes.
   *
   * `USAGE_SERIES_CAP` is the last real slot; the folded "Other" row always takes the one after it.
   */
  colorIndex: z.number().int(),
  totals: UsageTotalsSchema,
  /** Per-bucket values for this row, aligned index-for-index with `buckets` — what the stacked
   *  columns and the row's sparkline both draw, in both metrics so the toggle costs no round trip. */
  buckets: z.array(z.object({ costUsd: z.number(), tokens: z.number() })),
});
export type UsageBreakdownRow = z.infer<typeof UsageBreakdownRowSchema>;

export const UsageSessionRowSchema = z.object({
  id: z.string(), title: z.string(), spaceId: z.string(), spaceName: z.string(),
  agentKind: AgentKindSchema, model: z.string().nullable(),
  totals: UsageTotalsSchema, createdAt: z.number().int(), updatedAt: z.number().int(),
});
export type UsageSessionRow = z.infer<typeof UsageSessionRowSchema>;

export const UsageActivitySchema = z.object({
  toolCalls: z.number(), userMessages: z.number(), errors: z.number(),
  /** Proxied MCP calls in range (`mcp_call_log`), with how many failed and the median duration. */
  mcpCalls: z.number(), mcpFailures: z.number(), mcpMedianMs: z.number(),
  topTools: z.array(z.object({ name: z.string(), calls: z.number() })),
  topMcpServers: z.array(z.object({ name: z.string(), calls: z.number(), failures: z.number() })),
});

export const UsageBudgetStateSchema = z.object({
  budget: UsageBudgetSchema,
  /** Spend in the CURRENT calendar month, whatever the page's range is — a budget is a monthly fact
   *  and must not move when the reader changes the chart's range. */
  monthSpendUsd: z.number(),
  monthStart: z.number().int(),
  /** Straight-line projection to month end from the elapsed fraction, or null on the first day
   *  (where the projection would be a division by nearly zero and would read as nonsense). */
  projectedUsd: z.number().nullable(),
});

export const UsageSummarySchema = z.object({
  from: z.number().int(), to: z.number().int(), bucket: UsageBucketSchema,
  /** Bucket starts covering the whole range, so empty buckets stay visible as gaps. */
  buckets: z.array(z.number().int()),
  totals: UsageTotalsSchema,
  series: z.array(UsageSeriesPointSchema),
  breakdowns: z.record(UsageDimensionSchema, z.array(UsageBreakdownRowSchema)),
  sessions: z.array(UsageSessionRowSchema),
  activity: UsageActivitySchema,
  budget: UsageBudgetStateSchema,
  /** Agent kinds present in range that report no usage, so the page can name them in its caveat
   *  rather than leaving the reader to wonder why Cursor is missing from the spend chart. */
  unmeasuredKinds: z.array(AgentKindSchema),
  /** Models seen in range with no catalog price — the reason an estimate is missing. */
  unpricedModels: z.array(z.string()),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
