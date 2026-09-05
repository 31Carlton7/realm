import {
  AGENT_META, USAGE_DIMENSIONS, USAGE_RANGES, defaultBucketFor, formatTokens, formatUsd,
  parseUsageBudget, type UsageBudget, type UsageDimension, type UsageRangeId, type UsageSummary,
} from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../../state/store";
import { BreakdownBars, BudgetMeter, Legend, Sparkline, StackedColumns, seriesColor } from "./Charts";

/**
 * Settings → Usage: what the agents did, what it cost, and how that sits against a budget.
 *
 * Three honesty rules shape the whole surface, and none of them is decoration:
 *
 * 1. **Nine of the eleven selectable engines report no usage at all** (ACP 0.4.5 carries no
 *    token-usage message — see `usage.ts` and docs/dev/acp-protocol.md). Their sessions are counted
 *    in ACTIVITY and named in the caveat line, and they never contribute a `$0.00` to a spend chart.
 *    A zero would be a claim; "not reported" is the truth.
 * 2. **Most dollars here are estimates**, priced from the public catalog rather than stated by the
 *    engine. Reported and estimated are split on the hero tile and in the table, because a number
 *    the harness stated and a number Realm computed are different kinds of fact.
 * 3. **Every chart has a table twin.** Partly because tooltips must never be the only way to read a
 *    value — and partly as the standing obligation behind the light-mode palette, three of whose
 *    slots sit below 3:1 on white (see `tokens.css`). Remove the tables and the palette stops being
 *    legal, not merely less convenient.
 *
 * The filter row scopes everything below it and there is exactly one of it: a per-card range would
 * let two numbers on one screen describe different slices, which is how a dashboard loses a reader.
 */

type Metric = "cost" | "tokens";

const DIMENSION_LABEL: Record<UsageDimension, string> = {
  agent: "Engine", model: "Model", space: "Space", environment: "Checkout",
};

export function UsagePanel() {
  const run = useApp((s) => s.run);
  const usageSummary = useApp((s) => s.usageSummary);
  const setUsageBudget = useApp((s) => s.setUsageBudget);
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);

  const [rangeId, setRangeId] = useState<UsageRangeId>("30d");
  const [scope, setScope] = useState<string>("all");
  const [metric, setMetric] = useState<Metric>("cost");
  const [dimension, setDimension] = useState<UsageDimension>("agent");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const range = USAGE_RANGES.find((r) => r.id === rangeId) ?? USAGE_RANGES[1];
  // The window is computed from the READER's clock: "last 7 days" is a fact about where they are
  // sitting, and the server has no business guessing a zone (see the `usage.summary` contract).
  const window = useMemo(() => {
    const to = Date.now();
    // `days: null` is all-time. Epoch 0 rather than the oldest row: the server builds the bucket
    // series from the RANGE, and `bucketRange`'s cap keeps that bounded however far back it reaches.
    const from = range.days === null ? 0 : new Date(new Date().setHours(0, 0, 0, 0) - (range.days - 1) * 86_400_000).getTime();
    return { from, to, bucket: defaultBucketFor(range.days) };
  }, [range.days]);

  // A stale answer must never overwrite a fresh one: switching range twice quickly can land the
  // slower first request last, and the page would then show a slice nobody asked for.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await usageSummary({
        from: window.from, to: window.to, bucket: window.bucket,
        spaceId: scope === "all" ? null : scope,
        profileId: null,
      });
      if (seq === requestSeq.current) setData(next);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [usageSummary, window, scope]);

  useEffect(() => { void run(load); }, [run, load]);

  const rows = data?.breakdowns[dimension] ?? [];
  const value = (t: { costUsd: number; inputTokens: number; outputTokens: number }) =>
    metric === "cost" ? t.costUsd : t.inputTokens + t.outputTokens;
  const format = metric === "cost" ? formatUsd : formatTokens;

  return (
    <div className="form usage-panel" data-loading={loading && data !== null ? "" : undefined}>
      <p className="page-lede">
        What the engines did and what it cost, read off the transcripts Realm already stores.
      </p>

      {/* One filter row, above everything it scopes. Never inside a card, never per-chart. */}
      <div className="usage-filters" role="group" aria-label="Usage filters">
        <fieldset className="seg">
          <legend className="visually-hidden">Time range</legend>
          {USAGE_RANGES.map((r) => (
            <label key={r.id} className="seg-opt" data-selected={r.id === rangeId || undefined}>
              <input type="radio" name="usage-range" value={r.id} checked={r.id === rangeId} onChange={() => setRangeId(r.id)} />
              {r.label}
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
        <fieldset className="seg seg-metric">
          <legend className="visually-hidden">Metric</legend>
          {(["cost", "tokens"] as Metric[]).map((m) => (
            <label key={m} className="seg-opt" data-selected={m === metric || undefined}>
              <input type="radio" name="usage-metric" value={m} checked={m === metric} onChange={() => setMetric(m)} />
              {m === "cost" ? "Spend" : "Tokens"}
            </label>
          ))}
        </fieldset>
        <button type="button" className="btn usage-refresh" onClick={() => run(load)}>Refresh</button>
      </div>

      {data === null
        ? <p className="env-empty">Reading usage…</p>
        : <UsageBody data={data} metric={metric} dimension={dimension} setDimension={setDimension}
            rows={rows} value={value} format={format} onSaveBudget={(b) => run(async () => { await setUsageBudget(b); await load(); })} />}
    </div>
  );
}

function UsageBody({ data, metric, dimension, setDimension, rows, value, format, onSaveBudget }: {
  data: UsageSummary;
  metric: Metric;
  dimension: UsageDimension;
  setDimension: (d: UsageDimension) => void;
  rows: UsageSummary["breakdowns"][UsageDimension];
  value: (t: { costUsd: number; inputTokens: number; outputTokens: number }) => number;
  format: (n: number) => string;
  onSaveBudget: (b: UsageBudget) => void;
}) {
  const t = data.totals;
  const measured = t.sessions - t.unmeasuredSessions;
  const series = (rows ?? []).map((r) => ({
    key: r.key, label: r.label, colorIndex: r.colorIndex,
    values: r.buckets.map((b) => (metric === "cost" ? b.costUsd : b.tokens)),
  }));

  return (
    <>
      <section className="usage-tiles" aria-label="Totals">
        {/* Exactly one hero figure on the view, in the same sans as everything else, with
            proportional figures — `tabular-nums` on a display-size number makes 121 look loose. */}
        <div className="stat-tile stat-hero">
          <span className="stat-label">Spend in range</span>
          <span className="stat-value stat-value-hero">{formatUsd(t.costUsd)}</span>
          <span className="stat-delta">
            {t.reportedUsd > 0 && <>{formatUsd(t.reportedUsd)} reported</>}
            {t.reportedUsd > 0 && t.estimatedUsd > 0 && " · "}
            {t.estimatedUsd > 0 && <>{formatUsd(t.estimatedUsd)} estimated</>}
            {t.costUsd === 0 && "No engine in range reported or priced any spend"}
          </span>
          <Sparkline values={data.series.map((p) => p.totals.costUsd)} />
        </div>
        <StatTile label="Tokens" value={formatTokens(t.inputTokens + t.outputTokens)}
          delta={`${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out`}
          trend={data.series.map((p) => p.totals.inputTokens)} />
        <StatTile label="Sessions" value={t.sessions.toLocaleString()}
          delta={t.unmeasuredSessions > 0 ? `${measured.toLocaleString()} report usage · ${t.unmeasuredSessions.toLocaleString()} don't` : "all report usage"} />
        <StatTile label="Turns" value={t.turns.toLocaleString()}
          delta={measured > 0 ? `${(t.turns / measured).toFixed(1)} per measured session` : "no engine in range reports turns"} />
      </section>

      <BudgetCard data={data} onSave={onSaveBudget} />

      <section className="usage-card">
        <header className="usage-card-head">
          <h3>{metric === "cost" ? "Spend" : "Tokens"} over time</h3>
          <span className="usage-card-sub">By {DIMENSION_LABEL[dimension].toLowerCase()}, {bucketWord(data.bucket)}</span>
        </header>
        <StackedColumns buckets={data.buckets} bucketKind={data.bucket} series={series} format={format}
          label={`${metric === "cost" ? "Spend" : "Tokens"} by ${DIMENSION_LABEL[dimension].toLowerCase()} over time`} />
        <Legend series={series} />
      </section>

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
          rows={[...(rows ?? [])].sort((a, b) => value(b.totals) - value(a.totals)).map((r) => ({
            key: r.key, label: r.label, colorIndex: r.colorIndex, value: value(r.totals),
            caption: `${r.totals.sessions} session${r.totals.sessions === 1 ? "" : "s"}`,
          }))} format={format} />
        <BreakdownTable rows={rows ?? []} dimension={dimension} />
      </section>

      <SessionsCard data={data} />
      <ActivityCard data={data} />
      <Caveats data={data} />
    </>
  );
}

function StatTile({ label, value, delta, trend }: { label: string; value: string; delta: string; trend?: number[] }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-delta">{delta}</span>
      {trend && trend.length > 1 && <Sparkline values={trend} />}
    </div>
  );
}

/**
 * The chart's table twin — every value the chart draws, readable without hovering anything.
 *
 * `tabular-nums` here and NOT on the stat tiles: these are columns that must align vertically, which
 * is the one place equal-width digits earn their looseness.
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
            <td>{r.totals.inputTokens + r.totals.outputTokens > 0 ? formatTokens(r.totals.inputTokens + r.totals.outputTokens) : <span className="muted">—</span>}</td>
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
    <section className="usage-card budget-card">
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
              <input type="checkbox" checked={thresholds.includes(x)}
                onChange={(e) => setThresholds(e.target.checked ? [...thresholds, x].sort((a, b) => a - b) : thresholds.filter((y) => y !== x))} />
              {Math.round(x * 100)}%
            </label>
          ))}
        </fieldset>
        <button type="button" className="btn" onClick={save} disabled={!valid}>Save budget</button>
      </div>
      <p className="budget-note">
        Spend counts what the engines report plus catalog-priced estimates for the rest. It is not a bill:
        Claude Code runs bill through a Claude subscription, and the nine ACP engines report no usage at all.
      </p>
    </section>
  );
}

function SessionsCard({ data }: { data: UsageSummary }) {
  const run = useApp((s) => s.run);
  const revealSession = useApp((s) => s.revealSession);
  if (data.sessions.length === 0) return null;
  return (
    <section className="usage-card">
      <header className="usage-card-head">
        <h3>Heaviest sessions</h3>
        <span className="usage-card-sub">Only sessions whose engine reports usage can appear here.</span>
      </header>
      <table className="usage-table usage-sessions">
        <thead>
          <tr><th scope="col">Session</th><th scope="col">Engine</th><th scope="col">Spend</th><th scope="col">Tokens</th><th scope="col">Turns</th><th scope="col"><span className="visually-hidden">Open</span></th></tr>
        </thead>
        <tbody>
          {data.sessions.map((s) => (
            <tr key={s.id}>
              <th scope="row">
                <span className="usage-session-title">{s.title}</span>
                <span className="usage-session-space">{s.spaceName}</span>
              </th>
              <td>{AGENT_META[s.agentKind].label}{s.model && <span className="usage-session-model">{s.model}</span>}</td>
              <td>{formatUsd(s.totals.costUsd)}</td>
              <td>{formatTokens(s.totals.inputTokens + s.totals.outputTokens)}</td>
              <td>{s.totals.turns.toLocaleString()}</td>
              <td>
                <button type="button" className="btn btn-quiet" aria-label={`Go to ${s.title}`}
                  onClick={() => run(() => revealSession(s.id, s.spaceId))}>
                  <Icon name="focusPane" size={12} /> Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The half of the page that covers every engine.
 *
 * Tool calls, messages and proxied MCP traffic are recorded by Realm itself rather than reported by
 * the agent, so this is the only section where a Cursor or a goose session is measured on the same
 * footing as a Claude one. On a machine that mostly runs ACP engines it is the ONLY section with
 * anything in it, which is why it is a peer of the spend charts and not a footnote under them.
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
        <div className="usage-activity-stats">
          <StatTile label="Messages sent" value={a.userMessages.toLocaleString()} delta={`${a.toolCalls.toLocaleString()} tool calls`} />
          <StatTile label="MCP calls" value={a.mcpCalls.toLocaleString()}
            delta={a.mcpCalls > 0 ? `${failRate.toFixed(failRate < 10 ? 1 : 0)}% failed · ${a.mcpMedianMs.toLocaleString()}ms median` : "none proxied"} />
          <StatTile label="Errors" value={a.errors.toLocaleString()} delta="agent errors in transcripts" />
        </div>
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

function TopList({ title, rows }: { title: string; rows: { key: string; label: string; value: string; note: string | null }[] }) {
  return (
    <div className="usage-toplist">
      <h4>{title}</h4>
      {rows.length === 0 ? <p className="muted">Nothing in this range.</p> : (
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

/** Why numbers are missing, named rather than left as a puzzle. A gap the reader can explain is a
 *  limitation; a gap they cannot is a bug they will assume you have. */
function Caveats({ data }: { data: UsageSummary }) {
  if (data.unmeasuredKinds.length === 0 && data.unpricedModels.length === 0) return null;
  return (
    <section className="usage-caveats" aria-label="Why some numbers are missing">
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
    </section>
  );
}

const bucketWord = (b: UsageSummary["bucket"]): string => (b === "day" ? "daily" : b === "week" ? "weekly" : "monthly");
