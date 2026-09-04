import {
  AGENT_META, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS, USAGE_DIMENSIONS, USAGE_OTHER_KEY,
  USAGE_REPORTING, USAGE_SERIES_CAP, bucketRange, estimateCostUsd, sumDeltas, usageDeltas,
  type AgentKind, type UsageBucketKind, type UsageBreakdownRow, type UsageDimension,
  type UsageSample, type UsageSummary, type UsageTotals,
} from "@realm/contracts";
import { bucketStart } from "@realm/contracts";

/**
 * The pure half of the usage page: rows in, the page's payload out.
 *
 * Split from `service.ts` so the arithmetic that produces dollar figures can be tested against
 * hand-written sessions rather than against a database — the numbers here are the ones a user will
 * read as money, and "the query returned something" is not evidence that they are right.
 */

/** One session as the aggregator needs it: its identity, and ALL of its usage events in order. */
export type SessionFacts = {
  id: string; title: string;
  spaceId: string; spaceName: string; spaceSort: number;
  environmentId: string | null; environmentLabel: string;
  agentKind: AgentKind; model: string | null;
  createdAt: number; updatedAt: number;
  /**
   * Every `usage` event this session ever wrote, ascending by seq — NOT just the ones in range.
   *
   * The whole history is required because a cumulative series' first in-range delta is a difference
   * against the event before the window. Passing only the windowed events would bill the reader for
   * everything the session had already spent before the range began, every time they scrolled back.
   */
  samples: UsageSample[];
};

export type PriceLookup = (model: string | null, agentKind: AgentKind) => { priceIn: number | null; priceOut: number | null } | null;

const zeroTotals = (): UsageTotals => ({
  costUsd: 0, reportedUsd: 0, estimatedUsd: 0, inputTokens: 0, outputTokens: 0,
  turns: 0, sessions: 0, unmeasuredSessions: 0,
});

function addTotals(a: UsageTotals, b: UsageTotals): void {
  a.costUsd += b.costUsd; a.reportedUsd += b.reportedUsd; a.estimatedUsd += b.estimatedUsd;
  a.inputTokens += b.inputTokens; a.outputTokens += b.outputTokens; a.turns += b.turns;
  a.sessions += b.sessions; a.unmeasuredSessions += b.unmeasuredSessions;
}

/** What one session contributed inside the window, plus the per-bucket split of the same numbers. */
type SessionSlice = { totals: UsageTotals; byBucket: Map<number, { costUsd: number; tokens: number }> };

/**
 * Reduce one session to its in-range contribution.
 *
 * The cost rule, in order:
 *   1. An engine that reports nothing (`series: "none"` — every ACP kind) contributes activity only.
 *      Its tokens are UNKNOWN, not zero, so it lands in `unmeasuredSessions` and adds no dollars.
 *   2. Otherwise the deltas give tokens, and any dollars the engine itself stated are `reportedUsd`.
 *   3. If the engine stated no dollars but did state tokens — Codex always, and Claude on a turn
 *      whose `total_cost_usd` came back 0 — the catalog prices those tokens into `estimatedUsd`.
 *      An unpriced model yields `null` from `estimateCostUsd` and contributes nothing, which is why
 *      `unpricedModels` exists: a missing estimate has a reason and the page names it.
 *
 * Reported and estimated never both count for the same tokens; `costUsd` is their sum precisely
 * because at most one of them is ever non-zero for a given session.
 */
export function sliceSession(s: SessionFacts, from: number, to: number, bucket: UsageBucketKind, priceFor: PriceLookup): SessionSlice {
  const totals = zeroTotals();
  const byBucket = new Map<number, { costUsd: number; tokens: number }>();
  totals.sessions = 1;

  const reporting = USAGE_REPORTING[s.agentKind];
  if (reporting.series === "none") { totals.unmeasuredSessions = 1; return { totals, byBucket }; }

  const inRange = usageDeltas(s.samples, reporting.series).filter((d) => d.ts >= from && d.ts <= to);
  if (inRange.length === 0) return { totals, byBucket };

  const summed = sumDeltas(inRange);
  totals.inputTokens = summed.inputTokens;
  totals.outputTokens = summed.outputTokens;
  totals.turns = summed.turns;

  const price = priceFor(s.model, s.agentKind);
  // Per delta rather than per session, so a bucket's dollars are that bucket's own — an estimate
  // computed once on the session total and then split by token share would be the same number here,
  // but would stop being so the day a session changes model mid-run (sessions.setOptions does that).
  for (const d of inRange) {
    const reported = d.costUsd;
    const estimated = reported > 0 ? 0 : (estimateCostUsd(d.inputTokens, d.outputTokens, price) ?? 0);
    totals.reportedUsd += reported;
    totals.estimatedUsd += estimated;
    const b = bucketStart(d.ts, bucket);
    const cell = byBucket.get(b) ?? { costUsd: 0, tokens: 0 };
    cell.costUsd += reported + estimated;
    cell.tokens += d.inputTokens + d.outputTokens;
    byBucket.set(b, cell);
  }
  totals.costUsd = totals.reportedUsd + totals.estimatedUsd;
  return { totals, byBucket };
}

/* ── breakdown keys ──────────────────────────────────────────────────────────
 * Each dimension answers three questions about a session: which bucket it belongs to, what to call
 * that bucket, and where the bucket sits in the dimension's INTRINSIC order (see
 * `UsageBreakdownRow.colorIndex` — sorting the table must not repaint the chart).
 */

type KeyFn = (s: SessionFacts) => { key: string; label: string; sort: string };

/** Engines sort in `SELECTABLE_AGENT_KINDS` order — a genuinely fixed, product-level order, which is
 *  exactly what a stable colour assignment wants. Anything unlisted (`fake`) sorts after. */
const agentSort = (k: AgentKind): string => {
  const i = (SELECTABLE_AGENT_KINDS as readonly string[]).indexOf(k);
  return String(i < 0 ? 99 : i).padStart(2, "0");
};

const KEY_FNS: Record<UsageDimension, KeyFn> = {
  agent: (s) => ({ key: s.agentKind, label: AGENT_META[s.agentKind].label, sort: agentSort(s.agentKind) }),
  // A null model is the harness's own default, and "Default" alone would merge Claude's default with
  // Codex's into one meaningless row. Keyed per engine, labelled with the engine's known default.
  model: (s) => (s.model
    ? { key: s.model, label: s.model, sort: s.model.toLowerCase() }
    : { key: `default:${s.agentKind}`, label: `${AGENT_META[s.agentKind].label} default (${DEFAULT_MODEL_LABEL[s.agentKind]})`, sort: `￿${agentSort(s.agentKind)}` }),
  space: (s) => ({ key: s.spaceId, label: s.spaceName, sort: String(s.spaceSort).padStart(6, "0") }),
  environment: (s) => ({ key: s.environmentId ?? "none", label: s.environmentLabel, sort: s.environmentLabel.toLowerCase() }),
};

/**
 * Group slices into the rows one breakdown draws.
 *
 * Rows past `USAGE_SERIES_CAP` fold into a single "Other" row, because a ninth categorical hue is
 * indistinguishable from one already on screen under simulated colour-vision deficiency — the cap is
 * the palette's, not an arbitrary tidiness rule. Which rows survive the fold is decided by spend
 * (the reader's question is "where did the money go"), but the survivors are then EMITTED in
 * intrinsic order and take their colour from that, so changing the range never shuffles the palette
 * out from under someone who has learned it.
 */
export function buildBreakdown(
  entries: readonly { facts: SessionFacts; slice: SessionSlice }[],
  dim: UsageDimension, buckets: readonly number[],
): UsageBreakdownRow[] {
  const groups = new Map<string, { label: string; sort: string; totals: UsageTotals; byBucket: Map<number, { costUsd: number; tokens: number }> }>();
  for (const { facts, slice } of entries) {
    const { key, label, sort } = KEY_FNS[dim](facts);
    let g = groups.get(key);
    if (!g) { g = { label, sort, totals: zeroTotals(), byBucket: new Map() }; groups.set(key, g); }
    addTotals(g.totals, slice.totals);
    for (const [b, cell] of slice.byBucket) {
      const into = g.byBucket.get(b) ?? { costUsd: 0, tokens: 0 };
      into.costUsd += cell.costUsd; into.tokens += cell.tokens;
      g.byBucket.set(b, into);
    }
  }

  const all = [...groups.entries()];
  // Spend decides who survives; tokens then sessions break ties, so two engines that both report no
  // dollars (every ACP kind) still order by something real rather than by Map insertion order.
  const ranked = [...all].sort(([, a], [, b]) =>
    b.totals.costUsd - a.totals.costUsd
    || (b.totals.inputTokens + b.totals.outputTokens) - (a.totals.inputTokens + a.totals.outputTokens)
    || b.totals.sessions - a.totals.sessions);
  const keep = new Set(ranked.slice(0, USAGE_SERIES_CAP).map(([k]) => k));

  const rows: UsageBreakdownRow[] = all
    .filter(([k]) => keep.has(k))
    .sort(([, a], [, b]) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
    .map((entry, i) => {
      const [key, g] = entry;
      return {
        key, label: g.label, colorIndex: i, totals: g.totals,
        buckets: buckets.map((b) => g.byBucket.get(b) ?? { costUsd: 0, tokens: 0 }),
      };
    });

  const folded = ranked.slice(USAGE_SERIES_CAP);
  if (folded.length > 0) {
    const totals = zeroTotals();
    const byBucket = new Map<number, { costUsd: number; tokens: number }>();
    for (const [, g] of folded) {
      addTotals(totals, g.totals);
      for (const [b, cell] of g.byBucket) {
        const into = byBucket.get(b) ?? { costUsd: 0, tokens: 0 };
        into.costUsd += cell.costUsd; into.tokens += cell.tokens;
        byBucket.set(b, into);
      }
    }
    rows.push({
      key: USAGE_OTHER_KEY, label: `Other (${folded.length})`, colorIndex: USAGE_SERIES_CAP, totals,
      buckets: buckets.map((b) => byBucket.get(b) ?? { costUsd: 0, tokens: 0 }),
    });
  }
  return rows;
}

/** How many sessions the leaderboard carries. Enough to see the tail of a heavy week without turning
 *  the settings pane into a session list — the full list is the sidebar's job. */
export const USAGE_SESSION_LIMIT = 12;

export type AggregateInput = {
  sessions: readonly SessionFacts[];
  from: number; to: number; bucket: UsageBucketKind;
  priceFor: PriceLookup;
  activity: UsageSummary["activity"];
  budget: UsageSummary["budget"];
};

export function aggregateUsage(input: AggregateInput): UsageSummary {
  const { sessions, from, to, bucket, priceFor } = input;
  const buckets = bucketRange(from, to, bucket);
  const entries = sessions.map((facts) => ({ facts, slice: sliceSession(facts, from, to, bucket, priceFor) }));

  const totals = zeroTotals();
  const seriesCells = new Map<number, { costUsd: number; tokens: number }>();
  const unmeasured = new Set<AgentKind>();
  const unpriced = new Set<string>();
  for (const { facts, slice } of entries) {
    addTotals(totals, slice.totals);
    for (const [b, cell] of slice.byBucket) {
      const into = seriesCells.get(b) ?? { costUsd: 0, tokens: 0 };
      into.costUsd += cell.costUsd; into.tokens += cell.tokens;
      seriesCells.set(b, into);
    }
    if (USAGE_REPORTING[facts.agentKind].series === "none") unmeasured.add(facts.agentKind);
    // Only a session that actually reported tokens AND got no dollars for them has an estimate gap
    // worth naming; a session with no usage at all is the `unmeasured` story, not this one.
    else if (slice.totals.costUsd === 0 && slice.totals.inputTokens + slice.totals.outputTokens > 0) {
      unpriced.add(facts.model ?? `${AGENT_META[facts.agentKind].label} default`);
    }
  }

  // The series carries the same UsageTotals shape as everything else, but only the money and tokens
  // are per-bucket facts: a session spans buckets, so counting it in each would double-count it.
  const series = buckets.map((b) => {
    const cell = seriesCells.get(b) ?? { costUsd: 0, tokens: 0 };
    const t = zeroTotals();
    t.costUsd = cell.costUsd;
    t.inputTokens = cell.tokens;
    return { bucket: b, totals: t };
  });

  const breakdowns = Object.fromEntries(
    USAGE_DIMENSIONS.map((d) => [d, buildBreakdown(entries, d, buckets)]),
  ) as UsageSummary["breakdowns"];

  const sessionRows = entries
    .filter(({ slice }) => slice.totals.costUsd > 0 || slice.totals.inputTokens + slice.totals.outputTokens > 0)
    .sort((a, b) => b.slice.totals.costUsd - a.slice.totals.costUsd
      || (b.slice.totals.inputTokens + b.slice.totals.outputTokens) - (a.slice.totals.inputTokens + a.slice.totals.outputTokens))
    .slice(0, USAGE_SESSION_LIMIT)
    .map(({ facts, slice }) => ({
      id: facts.id, title: facts.title, spaceId: facts.spaceId, spaceName: facts.spaceName,
      agentKind: facts.agentKind, model: facts.model, totals: slice.totals,
      createdAt: facts.createdAt, updatedAt: facts.updatedAt,
    }));

  return {
    from, to, bucket, buckets, totals, series, breakdowns,
    sessions: sessionRows, activity: input.activity, budget: input.budget,
    unmeasuredKinds: [...unmeasured].sort(),
    unpricedModels: [...unpriced].sort(),
  };
}
