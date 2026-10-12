import {
  AGENT_META, USAGE_BUCKETS, USAGE_DIMENSIONS, USAGE_RANGES, defaultBucketFor, formatTokens, formatUsd,
  parseUsageBudget, planLabel, totalTokens,
  type UsageBucketKind, type UsageBudget, type UsageDimension, type UsageRangeId, type UsageSummary,
} from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../../state/store";
import { BreakdownBars, BudgetMeter, Legend, Sparkline, StackedColumns, seriesColor } from "./Charts";
import { ActivityCalendar } from "./ActivityCalendar";
import { PlanCard } from "./PlanCard";

/**
 * Settings ▸ Usage, in the order a person asks the questions:
 *
 *   1. **How much of my plan is left, and when does it come back?** — `PlanCard`, per engine, first.
 *   2. **What did it come to?** — four figures for the chosen range, then the same over time.
 *   3. **Where did it go?** — by engine, model, space or checkout, and the heaviest sessions, each of
 *      which opens.
 *   4. **Am I inside what I meant to spend?** — the monthly budget, against the calendar month.
 *   5. **How much did I use it?** — the days and the activity, which every engine has.
 *   6. **What can these numbers not say?** — named at the foot, never left as a puzzle.
 *
 * Honesty rules, none of them decoration:
 *
 * - **A dollar here is list price, not a bill.** Claude reports what its run would cost at API rates
 *   whatever plan it is on; Codex's is priced from the catalog. On a subscription neither is money
 *   leaving an account, and the figure's own caption says which it is.
 * - **Nine of the eleven engines report no usage at all.** Their sessions are counted, and named, and
 *   never contribute a `$0.00`.
 * - **Every chart has a table twin**, and every figure is text: colour never carries a value alone.
 *
 * One toolbar scopes everything under it. The plan limits above it are not scoped by it — a quota is
 * the account's now, whatever range the chart is showing.
 */

type Metric = "cost" | "tokens";

const DIMENSION_LABEL: Record<UsageDimension, string> = {
  agent: "Engine", model: "Model", space: "Space", environment: "Checkout",
};
const BUCKET_LABEL: Record<UsageBucketKind, string> = { day: "Day", week: "Week", month: "Month" };
const RANGE_SHORT: Record<UsageRangeId, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };

export function UsagePanel() {
  const usageSummary = useApp((s) => s.usageSummary);
  const refreshPlanLimits = useApp((s) => s.refreshPlanLimits);
  const setUsageBudget = useApp((s) => s.setUsageBudget);
  const run = useApp((s) => s.run);
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const claudePlan = useApp((s) => s.planLimits.find((r) => r.agentKind === "claude")?.subscriptionType ?? null);

  const [rangeId, setRangeId] = useState<UsageRangeId>("30d");
  /** The reader's own bucket, or null to follow the range's default. Reset when the range changes:
   *  "day" chosen for a week stops being a sensible choice the moment the range is all of time. */
  const [bucketChoice, setBucketChoice] = useState<UsageBucketKind | null>(null);
  const [scope, setScope] = useState<string>("all");
  const [metric, setMetric] = useState<Metric>("cost");
  const [dimension, setDimension] = useState<UsageDimension>("agent");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = USAGE_RANGES.find((r) => r.id === rangeId) ?? USAGE_RANGES[1];
  const bucket = bucketChoice ?? defaultBucketFor(range.days);
  // The window is computed from the READER's clock: "last 7 days" is a fact about where they are
  // sitting, and the server has no business guessing a zone (see the `usage.summary` contract).
  const window = useMemo(() => {
    const to = Date.now();
    // `days: null` is all-time. Epoch 0 rather than the oldest row: the server builds the bucket
    // series from the RANGE, and `bucketRange`'s cap keeps that bounded however far back it reaches.
    const from = range.days === null ? 0 : new Date(new Date().setHours(0, 0, 0, 0) - (range.days - 1) * 86_400_000).getTime();
    return { from, to };
  }, [range.days]);

  // A stale answer must never overwrite a fresh one: switching range twice quickly can land the
  // slower first request last, and the page would then show a slice nobody asked for.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await usageSummary({ from: window.from, to: window.to, bucket, spaceId: scope === "all" ? null : scope, profileId: null });
      if (seq === requestSeq.current) { setData(next); setError(null); }
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [usageSummary, window, bucket, scope]);

  useEffect(() => { void load(); }, [load]);
  /* The plan quota, read when the tab opens — which is also when the server catches up on what Codex
     wrote to disk. Live changes arrive on `limits.changed`. Not part of `load`: a quota has no range. */
  useEffect(() => { void run(refreshPlanLimits); }, [run, refreshPlanLimits]);

  const refresh = () => { void load(); void run(refreshPlanLimits); };

  return (
    <div className="form usage-panel" data-loading={loading && data !== null ? "" : undefined}>
      <PlanCard />

      <section className="usage-section" aria-labelledby="usage-spend-head">
        <header className="usage-section-head">
          <h2 id="usage-spend-head">Spend and tokens</h2>
          <span className="usage-section-sub">{basisLine(claudePlan)}</span>
        </header>

        {/* One toolbar, above everything it scopes. Never inside a card, never per chart. */}
        <div className="usage-filters" role="group" aria-label="Usage filters">
          <fieldset className="seg">
            <legend className="visually-hidden">Time range</legend>
            {USAGE_RANGES.map((r) => (
              <label key={r.id} className="seg-opt" data-selected={r.id === rangeId || undefined}>
                <input type="radio" name="usage-range" value={r.id} aria-label={r.label} checked={r.id === rangeId}
                  onChange={() => { setRangeId(r.id); setBucketChoice(null); }} />
                {RANGE_SHORT[r.id]}
              </label>
            ))}
          </fieldset>
          <fieldset className="seg">
            <legend className="visually-hidden">Group by</legend>
            {USAGE_BUCKETS.map((b) => (
              <label key={b} className="seg-opt" data-selected={b === bucket || undefined}>
                <input type="radio" name="usage-bucket" value={b} checked={b === bucket} onChange={() => setBucketChoice(b)} />
                {BUCKET_LABEL[b]}
              </label>
            ))}
          </fieldset>
          <fieldset className="seg">
            <legend className="visually-hidden">Metric</legend>
            {(["cost", "tokens"] as Metric[]).map((m) => (
              <label key={m} className="seg-opt" data-selected={m === metric || undefined}>
                <input type="radio" name="usage-metric" value={m} checked={m === metric} onChange={() => setMetric(m)} />
                {m === "cost" ? "Spend" : "Tokens"}
              </label>
            ))}
          </fieldset>
          <label className="usage-scope">
            <span className="visually-hidden">Scope</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All spaces</option>
              {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === activeSpaceId ? " (current)" : ""}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-quiet usage-refresh" onClick={refresh}>
            <Icon name="reload" size={12} /> Refresh
          </button>
        </div>

        {error !== null && (
          <p className="usage-error" role="alert">
            Usage could not be read: {error}{" "}
            <button type="button" className="btn btn-quiet" onClick={() => void load()}>Try again</button>
          </p>
        )}
        {data === null
          ? error === null && <UsageSkeleton />
          : <Figures data={data} claudePlan={claudePlan} />}
      </section>

      {data !== null && (
        <UsageBody data={data} metric={metric} dimension={dimension} setDimension={setDimension}
          onSaveBudget={(b) => run(async () => { await setUsageBudget(b); await load(); })} />
      )}
    </div>
  );
}

/** What a dollar on this page is. Worded for the plan the reader is actually on, where Realm knows it. */
function basisLine(claudePlan: string | null): string {
  const plan = planLabel("claude", claudePlan);
  return plan
    ? `Priced at API list rates. On ${plan} that is what the work would have cost, not what you pay.`
    : "Priced at API list rates — what the work would have cost, not a bill.";
}

/** The first read, before any figure exists: the figures' own shapes, so nothing moves when they land. */
function UsageSkeleton() {
  return (
    <div className="usage-figures" aria-busy="true" aria-label="Reading usage">
      {[0, 1, 2, 3].map((l) => (
        <div key={l} className="usage-figure" data-skeleton="">
          <span className="usage-figure-label usage-skeleton-line" />
          <span className="usage-figure-value usage-skeleton-bar" />
          <span className="usage-figure-sub usage-skeleton-line" />
        </div>
      ))}
    </div>
  );
}

/**
 * Four figures for the range, in one strip under hairlines rather than four floating tiles — they are
 * one reading of one range, and a card each made them look like four separate things.
 */
function Figures({ data, claudePlan }: { data: UsageSummary; claudePlan: string | null }) {
  const t = data.totals;
  const tokens = totalTokens(t);
  const cache = t.cacheReadTokens + t.cacheWriteTokens;
  const b = data.budget;
  const monthName = new Date(b.monthStart).toLocaleDateString(undefined, { month: "long" });
  const subscription = planLabel("claude", claudePlan);
  return (
    <div className="usage-figures" data-usage-ready="">
      <div className="usage-figure usage-figure-hero">
        <span className="usage-figure-label">Spend in range</span>
        <span className="usage-figure-value">{formatUsd(t.costUsd)}</span>
        <span className="usage-figure-sub">
          {t.reportedUsd > 0 && <>{formatUsd(t.reportedUsd)} reported</>}
          {t.reportedUsd > 0 && t.estimatedUsd > 0 && " · "}
          {t.estimatedUsd > 0 && <span title="Priced from public catalog list prices">{formatUsd(t.estimatedUsd)} estimated</span>}
          {t.costUsd === 0 && "No engine in range reported or priced any spend"}
          {t.costUsd > 0 && subscription && <> · API value, not billed on {subscription}</>}
        </span>
      </div>
      <div className="usage-figure">
        <span className="usage-figure-label">Tokens</span>
        <span className="usage-figure-value">{tokens > 0 ? formatTokens(tokens) : "—"}</span>
        <span className="usage-figure-sub">
          {tokens === 0 ? "none reported in range"
            : cache > 0 ? `${Math.round((cache / tokens) * 100)}% served from cache · ${formatTokens(t.outputTokens)} out`
            : `${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out`}
        </span>
      </div>
      <div className="usage-figure">
        <span className="usage-figure-label">Sessions</span>
        <span className="usage-figure-value">{t.sessions.toLocaleString()}</span>
        <span className="usage-figure-sub">
          {t.unmeasuredSessions > 0 ? `${t.unmeasuredSessions.toLocaleString()} on engines that report no usage` : "all report usage"}
        </span>
      </div>
      <div className="usage-figure">
        <span className="usage-figure-label">{monthName} so far</span>
        <span className="usage-figure-value">{formatUsd(b.monthSpendUsd)}</span>
        <span className="usage-figure-sub">
          {b.budget.monthlyUsd !== null
            ? `${Math.round((b.monthSpendUsd / Math.max(b.budget.monthlyUsd, 1e-9)) * 100)}% of the ${formatUsd(b.budget.monthlyUsd)} budget`
            : b.projectedUsd !== null ? `On pace for ${formatUsd(b.projectedUsd)}` : "Too early to project"}
        </span>
      </div>
    </div>
  );
}

function UsageBody({ data, metric, dimension, setDimension, onSaveBudget }: {
  data: UsageSummary;
  metric: Metric;
  dimension: UsageDimension;
  setDimension: (d: UsageDimension) => void;
  onSaveBudget: (b: UsageBudget) => void;
}) {
  const rows = data.breakdowns[dimension] ?? [];
  const value = (t: UsageSummary["totals"]) => (metric === "cost" ? t.costUsd : totalTokens(t));
  const format = metric === "cost" ? formatUsd : formatTokens;
  const series = rows.map((r) => ({
    key: r.key, label: r.label, colorIndex: r.colorIndex,
    values: r.buckets.map((b) => (metric === "cost" ? b.costUsd : b.tokens)),
  }));
  const noun = metric === "cost" ? "Spend" : "Tokens";

  return (
    <>
      <section className="usage-card usage-chart-card">
        <header className="usage-card-head">
          <h3>{noun} over time</h3>
          <span className="usage-card-sub">By {DIMENSION_LABEL[dimension].toLowerCase()}, {bucketWord(data.bucket)}</span>
        </header>
        <StackedColumns buckets={data.buckets} bucketKind={data.bucket} series={series} format={format}
          tickFormat={metric === "cost" ? compactUsd : formatTokens}
          label={`${noun} by ${DIMENSION_LABEL[dimension].toLowerCase()} over time`} />
        <Legend series={series} />
      </section>

      <div className="usage-pair">
        <section className="usage-card">
          <header className="usage-card-head">
            <h3>Where it went</h3>
            <fieldset className="seg seg-dim">
              <legend className="visually-hidden">Breakdown dimension</legend>
              {USAGE_DIMENSIONS.map((d) => (
                <label key={d} className="seg-opt" data-selected={d === dimension || undefined}>
                  <input type="radio" name="usage-dimension" value={d} checked={d === dimension} onChange={() => setDimension(d)} />
                  {DIMENSION_LABEL[d]}
                </label>
              ))}
            </fieldset>
          </header>
          <BreakdownBars label={`${DIMENSION_LABEL[dimension]} breakdown`}
            rows={[...rows].sort((a, b) => value(b.totals) - value(a.totals)).map((r) => ({
              key: r.key, label: r.label, colorIndex: r.colorIndex,
              value: r.totals.sessions > 0 && r.totals.unmeasuredSessions === r.totals.sessions ? null : value(r.totals),
              caption: `${r.totals.sessions} session${r.totals.sessions === 1 ? "" : "s"}`,
            }))} format={format} />
          <BreakdownTable rows={rows} dimension={dimension} />
        </section>

        <SessionsCard data={data} metric={metric} />
      </div>

      <BudgetCard data={data} onSave={onSaveBudget} />

      {/* Outside the toolbar's scope on purpose — see ActivityCalendar: a year of days, whatever the
          chart's range is. */}
      <ActivityCalendar />
      <ActivityCard data={data} />
      <Caveats data={data} />
    </>
  );
}

/** Axis figures without cents: "$1.5K" reads at a glance where "$1,500.00" is a number to parse. */
function compactUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  if (n >= 10 || n === 0) return `$${Math.round(n)}`;
  return formatUsd(n);
}

/**
 * The chart's table twin — every value the chart draws, readable without hovering anything.
 * `tabular-nums` here and not on the figures: these are columns that must align vertically.
 */
function BreakdownTable({ rows, dimension }: { rows: UsageSummary["breakdowns"][UsageDimension]; dimension: UsageDimension }) {
  if (!rows || rows.length === 0) return null;
  return (
    <table className="usage-table">
      <caption className="visually-hidden">{DIMENSION_LABEL[dimension]} breakdown, as a table</caption>
      <thead>
        <tr><th scope="col">{DIMENSION_LABEL[dimension]}</th><th scope="col">Spend</th><th scope="col">Basis</th><th scope="col">Tokens</th><th scope="col">Sessions</th></tr>
      </thead>
      <tbody>
        {[...rows].sort((a, b) => b.totals.costUsd - a.totals.costUsd).map((r) => (
          <tr key={r.key}>
            <th scope="row"><span className="usage-swatch" style={{ background: seriesColor(r.colorIndex) }} />{r.label}</th>
            <td>{r.totals.unmeasuredSessions === r.totals.sessions ? <span className="muted">not reported</span> : formatUsd(r.totals.costUsd)}</td>
            <td>{basisWord(r.totals)}</td>
            <td>{totalTokens(r.totals) > 0 ? formatTokens(totalTokens(r.totals)) : <span className="muted">—</span>}</td>
            <td>{r.totals.sessions.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Which kind of dollar a row's total is. Split rather than summed into one word, because a row that
 *  is half stated and half computed is exactly the row a reader should be told about. */
function basisWord(t: { reportedUsd: number; estimatedUsd: number; sessions: number; unmeasuredSessions: number }): React.ReactNode {
  if (t.sessions > 0 && t.sessions === t.unmeasuredSessions) return <span className="muted">engine reports none</span>;
  if (t.reportedUsd > 0 && t.estimatedUsd > 0) return "reported + estimated";
  if (t.reportedUsd > 0) return "reported";
  if (t.estimatedUsd > 0) return <span title="Priced from public catalog list prices, not a bill">estimated</span>;
  return <span className="muted">—</span>;
}

/**
 * The heaviest sessions, as rows that open. A whole row is the target rather than an "Open" button at
 * its end: the session is the thing being pointed at, and a reader scanning for "what was that $500"
 * clicks the name they recognise.
 */
function SessionsCard({ data, metric }: { data: UsageSummary; metric: Metric }) {
  const run = useApp((s) => s.run);
  const revealSession = useApp((s) => s.revealSession);
  return (
    <section className="usage-card" data-setting="usage-sessions">
      <header className="usage-card-head">
        <h3>Heaviest sessions</h3>
        <span className="usage-card-sub">Engines that report usage only</span>
      </header>
      {data.sessions.length === 0 ? <p className="chart-empty">No session in this range reported any usage.</p> : (
        <ol className="usage-sessions">
          {[...data.sessions]
            .sort((a, b) => (metric === "cost" ? b.totals.costUsd - a.totals.costUsd : totalTokens(b.totals) - totalTokens(a.totals)))
            .map((s) => (
              <li key={s.id}>
                <button type="button" className="usage-session" data-session-id={s.id}
                  aria-label={`Open ${s.title} — ${formatUsd(s.totals.costUsd)}, ${formatTokens(totalTokens(s.totals))} tokens`}
                  onClick={() => run(() => revealSession(s.id, s.spaceId))}>
                  <span className="usage-session-title">{s.title}</span>
                  <span className="usage-session-meta">{s.spaceName} · {AGENT_META[s.agentKind].label}{s.model ? ` · ${s.model}` : ""}</span>
                  <span className="usage-session-cost">{formatUsd(s.totals.costUsd)}</span>
                  <span className="usage-session-tokens">{formatTokens(totalTokens(s.totals))} tokens</span>
                </button>
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}

function BudgetCard({ data, onSave }: { data: UsageSummary; onSave: (b: UsageBudget) => void }) {
  const stored = data.budget.budget;
  const [draft, setDraft] = useState(stored.monthlyUsd === null ? "" : String(stored.monthlyUsd));
  const [thresholds, setThresholds] = useState(stored.thresholds);
  // The saved budget is the authority: a refresh that brings back a different one (another window
  // saved it) must win over a draft nobody is typing in.
  useEffect(() => { setDraft(stored.monthlyUsd === null ? "" : String(stored.monthlyUsd)); setThresholds(stored.thresholds); }, [stored.monthlyUsd, stored.thresholds]);

  const parsed = draft.trim() === "" ? null : Number(draft);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  const spent = data.budget.monthSpendUsd;
  const monthName = new Date(data.budget.monthStart).toLocaleDateString(undefined, { month: "long" });

  const save = () => { if (valid) onSave(parseUsageBudget({ monthlyUsd: parsed, thresholds, includeEstimated: stored.includeEstimated })); };

  return (
    <section className="usage-card budget-card" data-setting="usage-budget">
      <header className="usage-card-head">
        <h3>Monthly budget</h3>
        <span className="usage-card-sub">
          {monthName} so far: {formatUsd(spent)}
          {stored.monthlyUsd !== null && <> of {formatUsd(stored.monthlyUsd)}</>}
          {/* Deliberately NOT scoped to the chart's range — a reader who narrows the chart to
              yesterday has not spent less this month. */}
        </span>
      </header>

      {stored.monthlyUsd !== null && (
        <>
          <BudgetMeter spent={spent} budget={stored.monthlyUsd} projected={data.budget.projectedUsd} />
          <p className="budget-line">
            {data.budget.projectedUsd !== null
              ? <>On this pace, {formatUsd(data.budget.projectedUsd)} by month end.</>
              : <>Too early in the month to project a total.</>}
            {" "}Alerts at {stored.thresholds.map((x) => `${Math.round(x * 100)}%`).join(", ")}.
          </p>
        </>
      )}

      <div className="budget-controls">
        <label className="budget-input">
          <span>Monthly ceiling (USD)</span>
          <input type="number" min={0} step="1" value={draft} placeholder="No budget"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </label>
        <fieldset className="budget-thresholds">
          <legend>Alert at</legend>
          {[0.5, 0.8, 1, 1.25].map((x) => (
            <label key={x} className="budget-threshold" data-selected={thresholds.includes(x) || undefined}>
              <input type="checkbox" className="checkbox" checked={thresholds.includes(x)}
                onChange={(e) => setThresholds(e.target.checked ? [...thresholds, x].sort((a, b) => a - b) : thresholds.filter((y) => y !== x))} />
              {Math.round(x * 100)}%
            </label>
          ))}
        </fieldset>
        <button type="button" className="btn" onClick={save} disabled={!valid}>Save budget</button>
      </div>
      <p className="budget-note">
        Counts what the engines report plus catalog-priced estimates for the rest, at API list prices. It is not a bill:
        Claude Code and Codex on a subscription are billed by the plan, and the ACP engines report no usage at all.
      </p>
    </section>
  );
}

/**
 * The half of the page that covers every engine. Tool calls, messages and proxied MCP traffic are
 * recorded by Realm itself, so a Cursor or goose session is measured on the same footing as Claude.
 */
function ActivityCard({ data }: { data: UsageSummary }) {
  const a = data.activity;
  const failRate = a.mcpCalls > 0 ? (a.mcpFailures / a.mcpCalls) * 100 : 0;
  return (
    <section className="usage-card" aria-label="Activity">
      <header className="usage-card-head">
        <h3>Activity</h3>
        <span className="usage-card-sub">Counted by Realm, so every engine is measured the same way.</span>
      </header>
      <div className="usage-activity">
        <dl className="usage-activity-stats">
          <div><dt>Messages sent</dt><dd>{a.userMessages.toLocaleString()}</dd><dd className="usage-activity-sub">{`${a.toolCalls.toLocaleString()} tool calls`}</dd></div>
          <div><dt>MCP calls</dt><dd>{a.mcpCalls.toLocaleString()}</dd>
            <dd className="usage-activity-sub">{a.mcpCalls > 0 ? `${failRate.toFixed(failRate < 10 ? 1 : 0)}% failed · ${a.mcpMedianMs.toLocaleString()}ms median` : "none proxied"}</dd></div>
          <div><dt>Errors</dt><dd>{a.errors.toLocaleString()}</dd><dd className="usage-activity-sub">agent errors in transcripts</dd></div>
        </dl>
        <div className="usage-activity-lists">
          <TopList title="Top tools" rows={a.topTools.map((r) => ({ key: r.name, label: r.name, value: r.calls.toLocaleString(), note: null }))} />
          <TopList title="MCP servers" rows={a.topMcpServers.map((r) => ({
            key: r.name, label: r.name, value: r.calls.toLocaleString(),
            note: r.failures > 0 ? `${r.failures} failed` : null,
          }))} />
        </div>
      </div>
    </section>
  );
}

/** One figure: what it is, the number, and a line of context under it. The page about you uses it. */
export function StatTile({ label, value, delta, trend, title }: { label: string; value: string; delta: React.ReactNode; trend?: number[]; title?: string }) {
  return (
    <div className="stat-tile" title={title}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-delta">{delta}</span>
      {trend && trend.length > 1 && <Sparkline values={trend} />}
    </div>
  );
}

/** A short ranked list with its count on the right. `empty` says why there is nothing, in the
 *  terms of the page it is on — "in this range" is only true where there is a range. */
export function TopList({ title, rows, empty = "Nothing in this range." }: {
  title: string; rows: { key: string; label: string; value: string; note: string | null }[]; empty?: string;
}) {
  return (
    <div className="usage-toplist">
      <h4>{title}</h4>
      {rows.length === 0 ? <p className="muted">{empty}</p> : (
        <ul>
          {rows.map((r) => (
            <li key={r.key}>
              <span className="usage-toplist-label" title={r.label}>{r.label}</span>
              {r.note && <span className="usage-toplist-note">{r.note}</span>}
              <span className="usage-toplist-value">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the numbers cannot say, named rather than left as a puzzle. A gap the reader can explain is a
 *  limitation; a gap they cannot is a bug they will assume you have. */
function Caveats({ data }: { data: UsageSummary }) {
  const any = data.unmeasuredKinds.length > 0 || data.unpricedModels.length > 0 || data.unsplitTokens > 0 || data.mainLoopOnlySessions > 0;
  if (!any) return null;
  return (
    <section className="usage-caveats" aria-label="Why some numbers are missing">
      <h3>How these numbers are counted</h3>
      {data.unmeasuredKinds.length > 0 && (
        <p>
          <Icon name="alert" size={12} />{" "}
          <strong>{data.unmeasuredKinds.map((k) => AGENT_META[k].label).join(", ")}</strong>{" "}
          {data.unmeasuredKinds.length === 1 ? "reports" : "report"} no token usage — the ACP protocol these engines speak
          carries no usage message, so their sessions appear in Activity but never in spend.
        </p>
      )}
      {data.unpricedModels.length > 0 && (
        <p>
          <Icon name="alert" size={12} />{" "}
          No catalog price for <strong>{data.unpricedModels.slice(0, 4).join(", ")}</strong>
          {data.unpricedModels.length > 4 && ` and ${data.unpricedModels.length - 4} more`}, so their tokens are counted but not costed.
        </p>
      )}
      {data.unsplitTokens > 0 && (
        <p>
          <Icon name="alert" size={12} />{" "}
          <strong>{formatTokens(data.unsplitTokens)} Codex tokens</strong> were recorded before Realm kept their cache split, so they
          are counted but not priced — at the full input rate they would read several times what they cost.
        </p>
      )}
      {data.mainLoopOnlySessions > 0 && (
        <p>
          <Icon name="alert" size={12} />{" "}
          <strong>{data.mainLoopOnlySessions.toLocaleString()} Claude session{data.mainLoopOnlySessions === 1 ? "" : "s"}</strong> ran before
          Realm counted sub-agents and cache in tokens. Their spend is complete; their token counts are the main agent's alone.
        </p>
      )}
    </section>
  );
}

const bucketWord = (b: UsageSummary["bucket"]): string => (b === "day" ? "daily" : b === "week" ? "weekly" : "monthly");
