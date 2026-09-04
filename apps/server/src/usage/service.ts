import { basename } from "node:path";
import {
  USAGE_BUDGET_KEY, USAGE_REPORTING, canonicalModelKey, parseUsageBudget,
  thresholdsCrossed,
  type AgentKind, type ModelInfo, type Session, type SessionEvent, type UsageBucketKind,
  type UsageBudget, type UsageSample, type UsageSummary,
} from "@realm/contracts";
import type { Db } from "../db/database";
import type { SettingsStore } from "../store/settings";
import { aggregateUsage, sliceSession, type PriceLookup, type SessionFacts } from "./aggregate";

/**
 * The Settings → Usage tab's server half: read the range, price it, answer the whole page at once.
 *
 * Everything expensive is bounded by v21's partial index on `session_events(ts) WHERE type='usage'`.
 * The one query that deliberately reads OUTSIDE the range is `samplesFor`: a cumulative series'
 * first in-range delta is a difference against the event before the window, so the session's whole
 * usage history is loaded and the WINDOW is applied to the deltas, never to the events. Applying it
 * to the events instead would bill the reader, on every range change, for everything the session had
 * already spent before the window opened.
 */

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type UsageDeps = {
  db: Db;
  settings: SettingsStore;
  /** The public price catalog (`ModelCatalogService`). Never throws — an unreachable catalog answers
   *  from cache, or with `[]`, and the page simply shows no estimate. */
  catalog: { list(opts?: { force?: boolean }): Promise<ModelInfo[]> };
  /** The feed hook for budget thresholds. Optional so the service is testable without one. */
  notifications?: { budgetCrossed(input: { threshold: number; spendUsd: number; budgetUsd: number; monthKey: string }): void };
  now?: () => number;
};

export class UsageService {
  private readonly now: () => number;
  constructor(private d: UsageDeps) { this.now = d.now ?? Date.now; }

  budget(): UsageBudget { return parseUsageBudget(this.d.settings.get(USAGE_BUDGET_KEY)); }

  setBudget(input: UsageBudget): UsageBudget {
    const next = parseUsageBudget(input);
    this.d.settings.set(USAGE_BUDGET_KEY, next);
    return next;
  }

  /* ── the page ───────────────────────────────────────────────────────────── */

  async summary(p: { from: number; to: number; bucket: UsageBucketKind; spaceId: string | null; profileId: string | null }): Promise<UsageSummary> {
    const sessions = this.sessionFacts(p);
    const priceFor = await this.priceLookup();
    const monthStart = startOfMonth(this.now());
    // The budget meter is a MONTHLY fact and must not move when the chart's range does — so its spend
    // is computed over the calendar month regardless of `p.from`/`p.to`. A reader who narrows the
    // chart to yesterday has not spent less this month.
    const monthSpend = this.monthSpend(monthStart, priceFor);
    const budget = this.budget();

    const elapsed = this.now() - monthStart;
    const monthLength = startOfNextMonth(monthStart) - monthStart;
    // A projection off the first few hours of a month is a division by nearly nothing and prints an
    // absurd number; below a day's elapsed time the page shows no projection rather than a bad one.
    const projectedUsd = elapsed >= 24 * 60 * 60 * 1000 ? (monthSpend / elapsed) * monthLength : null;

    return aggregateUsage({
      sessions, from: p.from, to: p.to, bucket: p.bucket, priceFor,
      activity: this.activity(p),
      budget: { budget, monthSpendUsd: monthSpend, monthStart, projectedUsd },
    });
  }

  /* ── budget alerts ──────────────────────────────────────────────────────── */

  /**
   * The `SessionService` event hook (fanned out beside the notifications and runs hooks in app.ts).
   *
   * Only `usage` events can move spend, so everything else returns immediately — this runs on the hot
   * append path for every event of every session. When one does land, the crossing is computed from
   * the month's spend BEFORE and AFTER this event rather than from the new total alone: a threshold
   * derived from the total would re-fire on every subsequent turn for the rest of the month.
   */
  handleSessionEvent(session: Session, ev: SessionEvent): void {
    if (ev.type !== "usage") return;
    const budget = this.budget();
    if (budget.monthlyUsd === null || budget.monthlyUsd <= 0) return;
    if (!this.d.notifications) return;

    const monthStart = startOfMonth(ev.ts);
    // This event is already appended by the time the hook runs, so `after` is the month's real spend
    // and `before` is that minus what this one event added.
    const priceFor = this.cachedPriceLookup ?? (() => null);
    const after = this.monthSpend(monthStart, priceFor);
    const delta = this.lastDeltaUsd(session, ev, priceFor);
    const before = Math.max(0, after - delta);

    const crossed = thresholdsCrossed(before, after, budget);
    if (crossed.length === 0) return;
    const monthKey = monthKeyOf(monthStart);
    for (const threshold of crossed) {
      this.d.notifications.budgetCrossed({ threshold, spendUsd: after, budgetUsd: budget.monthlyUsd, monthKey });
    }
  }

  /**
   * What the event that just landed added, in dollars.
   *
   * Re-derived from the session's own events rather than read off the payload, because for a
   * cumulative engine the payload is a running total and taking it at face value would report the
   * session's whole spend as this turn's increment on every single turn.
   */
  private lastDeltaUsd(session: Session, ev: SessionEvent & { type: "usage" }, priceFor: PriceLookup): number {
    const samples = this.samplesFor([session.id]).get(session.id) ?? [];
    const reporting = USAGE_REPORTING[session.agentKind];
    if (reporting.series === "none") return 0;
    // The single instant this event occupies: `sliceUsage` already knows every cost rule, so the
    // alert path and the page path cannot drift apart on what a turn cost.
    const { totals } = sliceUsage({ agentKind: session.agentKind, model: session.model, samples }, ev.ts, ev.ts, priceFor);
    return totals.costUsd;
  }

  /* ── reads ──────────────────────────────────────────────────────────────── */

  /** Sessions with any activity in range, or created in it — the page's population. */
  private sessionFacts(p: { from: number; to: number; spaceId: string | null; profileId: string | null }): SessionFacts[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (p.spaceId) { where.push("s.space_id = ?"); args.push(p.spaceId); }
    if (p.profileId) { where.push("sp.profile_id = ?"); args.push(p.profileId); }
    const scope = where.length ? ` AND ${where.join(" AND ")}` : "";

    const rows = this.d.db.prepare(`
      SELECT s.id, s.title, s.space_id, s.agent_kind, s.model, s.environment_id, s.created_at, s.updated_at,
             sp.name AS space_name, sp.sort_order AS space_sort, e.path AS env_path, e.branch AS env_branch
        FROM sessions s
        JOIN spaces sp ON sp.id = s.space_id
        LEFT JOIN environments e ON e.id = s.environment_id
       WHERE (
              (s.created_at BETWEEN ? AND ?)
              OR EXISTS (SELECT 1 FROM session_events ev WHERE ev.session_id = s.id AND ev.ts BETWEEN ? AND ?)
             )${scope}
    `).all(p.from, p.to, p.from, p.to, ...args) as Row[];

    const samples = this.samplesFor(rows.map((r) => str(r.id)));
    return rows.map((r) => ({
      id: str(r.id), title: str(r.title) || "Untitled session",
      spaceId: str(r.space_id), spaceName: str(r.space_name), spaceSort: num(r.space_sort),
      environmentId: r.environment_id === null ? null : str(r.environment_id),
      environmentLabel: environmentLabel(r.env_path, r.env_branch),
      agentKind: str(r.agent_kind) as AgentKind,
      model: r.model === null ? null : str(r.model),
      createdAt: num(r.created_at), updatedAt: num(r.updated_at),
      samples: samples.get(str(r.id)) ?? [],
    }))
      // An `agent_kind` the current build has never heard of (a home written by a newer Realm) would
      // index `USAGE_REPORTING` to `undefined` and crash the aggregator. Dropping the row is the
      // honest answer: the page cannot say what an engine it does not know reports.
      .filter((f) => USAGE_REPORTING[f.agentKind] !== undefined);
  }

  /** Every `usage` event of the given sessions, in seq order, grouped by session. */
  private samplesFor(sessionIds: readonly string[]): Map<string, UsageSample[]> {
    const out = new Map<string, UsageSample[]>();
    if (sessionIds.length === 0) return out;
    // Chunked: SQLite's default parameter ceiling is in the hundreds, and a busy home can hold
    // thousands of sessions in a 90-day window.
    for (let i = 0; i < sessionIds.length; i += 400) {
      const chunk = sessionIds.slice(i, i + 400);
      const rows = this.d.db.prepare(`
        SELECT session_id, ts,
               json_extract(payload_json, '$.costUsd') AS cost,
               json_extract(payload_json, '$.inputTokens') AS input,
               json_extract(payload_json, '$.outputTokens') AS output,
               json_extract(payload_json, '$.numTurns') AS turns
          FROM session_events
         WHERE type = 'usage' AND session_id IN (${chunk.map(() => "?").join(",")})
         ORDER BY session_id, seq
      `).all(...chunk) as Row[];
      for (const r of rows) {
        const id = str(r.session_id);
        const list = out.get(id) ?? [];
        list.push({ ts: num(r.ts), costUsd: num(r.cost), inputTokens: num(r.input), outputTokens: num(r.output), numTurns: num(r.turns) });
        out.set(id, list);
      }
    }
    return out;
  }

  /** Calendar-month spend, computed with the same rules as the page so the meter and the chart agree. */
  private monthSpend(monthStart: number, priceFor: PriceLookup): number {
    const end = startOfNextMonth(monthStart) - 1;
    const ids = (this.d.db.prepare(
      "SELECT DISTINCT session_id AS id FROM session_events WHERE type = 'usage' AND ts BETWEEN ? AND ?",
    ).all(monthStart, end) as Row[]).map((r) => str(r.id));
    if (ids.length === 0) return 0;

    const samples = this.samplesFor(ids);
    const meta = new Map<string, { agentKind: AgentKind; model: string | null }>();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of this.d.db.prepare(
        `SELECT id, agent_kind, model FROM sessions WHERE id IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as Row[]) {
        meta.set(str(r.id), { agentKind: str(r.agent_kind) as AgentKind, model: r.model === null ? null : str(r.model) });
      }
    }

    let total = 0;
    for (const [id, list] of samples) {
      const m = meta.get(id);
      if (!m || !USAGE_REPORTING[m.agentKind]) continue;
      const { totals } = sliceUsage({ agentKind: m.agentKind, model: m.model, samples: list }, monthStart, end, priceFor);
      total += totals.costUsd;
    }
    return total;
  }

  /** Counts the tokens cannot give: what every engine did, including the nine that report no usage. */
  private activity(p: { from: number; to: number; spaceId: string | null; profileId: string | null }): UsageSummary["activity"] {
    const where: string[] = ["ev.ts BETWEEN ? AND ?"];
    const args: (string | number)[] = [p.from, p.to];
    if (p.spaceId || p.profileId) {
      where.push("ev.session_id IN (SELECT s.id FROM sessions s JOIN spaces sp ON sp.id = s.space_id WHERE "
        + [p.spaceId ? "s.space_id = ?" : null, p.profileId ? "sp.profile_id = ?" : null].filter(Boolean).join(" AND ") + ")");
      if (p.spaceId) args.push(p.spaceId);
      if (p.profileId) args.push(p.profileId);
    }
    const scope = where.join(" AND ");

    const counts = new Map<string, number>();
    for (const r of this.d.db.prepare(
      `SELECT type, COUNT(*) AS n FROM session_events ev WHERE ${scope} GROUP BY type`,
    ).all(...args) as Row[]) counts.set(str(r.type), num(r.n));

    const topTools = (this.d.db.prepare(`
      SELECT json_extract(ev.payload_json, '$.name') AS name, COUNT(*) AS n
        FROM session_events ev WHERE ${scope} AND ev.type = 'tool_call'
       GROUP BY name ORDER BY n DESC, name ASC LIMIT 8
    `).all(...args) as Row[]).map((r) => ({ name: str(r.name) || "(unnamed)", calls: num(r.n) }));

    const mcpScope = p.spaceId || p.profileId
      ? `c.ts BETWEEN ? AND ? AND c.session_id IN (SELECT s.id FROM sessions s JOIN spaces sp ON sp.id = s.space_id WHERE ${[p.spaceId ? "s.space_id = ?" : null, p.profileId ? "sp.profile_id = ?" : null].filter(Boolean).join(" AND ")})`
      : "c.ts BETWEEN ? AND ?";
    const mcpArgs = [p.from, p.to, ...(p.spaceId ? [p.spaceId] : []), ...(p.profileId ? [p.profileId] : [])];

    const mcpAgg = this.d.db.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS bad FROM mcp_call_log c WHERE ${mcpScope}`,
    ).get(...mcpArgs) as Row | undefined;
    const mcpCalls = num(mcpAgg?.n);
    // The median by offset rather than by pulling every duration into memory: two indexed reads
    // instead of a materialised array that grows with the log.
    const medianRow = mcpCalls === 0 ? undefined : this.d.db.prepare(
      `SELECT c.duration_ms AS d FROM mcp_call_log c WHERE ${mcpScope} ORDER BY c.duration_ms LIMIT 1 OFFSET ?`,
    ).get(...mcpArgs, Math.floor(mcpCalls / 2)) as Row | undefined;

    const topMcpServers = (this.d.db.prepare(`
      SELECT c.server_name AS name, COUNT(*) AS n, SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS bad
        FROM mcp_call_log c WHERE ${mcpScope}
       GROUP BY c.server_name ORDER BY n DESC, name ASC LIMIT 6
    `).all(...mcpArgs) as Row[]).map((r) => ({ name: str(r.name) || "(unnamed)", calls: num(r.n), failures: num(r.bad) }));

    return {
      toolCalls: counts.get("tool_call") ?? 0,
      userMessages: counts.get("user_message") ?? 0,
      errors: counts.get("error") ?? 0,
      mcpCalls, mcpFailures: num(mcpAgg?.bad), mcpMedianMs: num(medianRow?.d),
      topTools, topMcpServers,
    };
  }

  /* ── prices ─────────────────────────────────────────────────────────────── */

  /** Last resolved lookup, reused by the notification path so a budget check never awaits the network. */
  private cachedPriceLookup: PriceLookup | null = null;

  private async priceLookup(): Promise<PriceLookup> {
    let rows: ModelInfo[] = [];
    // `models.catalog`'s contract is that it never fails; belt and braces here anyway, because a
    // throw would take down a page whose whole job is to report, and a page with no estimates is
    // strictly better than no page.
    try { rows = await this.d.catalog.list(); } catch { rows = []; }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const lookup: PriceLookup = (model) => {
      if (!model) return null; // the harness's own default: no id, so nothing to price against
      const hit = byKey.get(canonicalModelKey(model));
      return hit ? { priceIn: hit.priceIn, priceOut: hit.priceOut } : null;
    };
    this.cachedPriceLookup = lookup;
    return lookup;
  }

}

/* ── helpers shared by the page and the alert path ──────────────────────────── */

/**
 * `sliceSession`'s cost rules over an arbitrary window, for callers that hold a session's usage
 * without the identity fields the page needs.
 *
 * Both the chart and the budget alert come through here, so a turn cannot cost one thing on screen
 * and another in the notification that interrupts you about it. `bucket` is irrelevant to the totals
 * — only `byBucket` reads it — so "day" is passed because the signature requires one.
 */
function sliceUsage(
  s: { agentKind: AgentKind; model: string | null; samples: UsageSample[] },
  from: number, to: number, priceFor: PriceLookup,
): { totals: { costUsd: number } } {
  const facts: SessionFacts = {
    id: "", title: "", spaceId: "", spaceName: "", spaceSort: 0,
    environmentId: null, environmentLabel: "", agentKind: s.agentKind, model: s.model,
    createdAt: 0, updatedAt: 0, samples: s.samples,
  };
  return sliceSession(facts, from, to, "day", priceFor);
}

/* ── small pure helpers ─────────────────────────────────────────────────────── */

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function startOfNextMonth(monthStart: number): number {
  const d = new Date(monthStart);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** `2026-09` — the calendar-month half of a budget notification's dedup key, so each threshold
 *  announces itself once a month and next month starts clean. */
export function monthKeyOf(monthStart: number): string {
  const d = new Date(monthStart);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** What to call a checkout in the breakdown: its directory, with the branch when it has one. A full
 *  path would be unreadable in a table cell and identical for every worktree of one repo. */
export function environmentLabel(path: unknown, branch: unknown): string {
  const p = typeof path === "string" ? path : "";
  if (!p) return "No checkout";
  const dir = basename(p) || p;
  const b = typeof branch === "string" ? branch : "";
  return b ? `${dir} (${b})` : dir;
}
