import {
  AGENT_META, SELECTABLE_AGENT_KINDS, currentAlert, planUnavailableNote, reportsPlanLimits, windowHasReset, windowsByUrgency,
  type AgentKind, type PlanLimits, type UsageSummary,
} from "@realm/contracts";
import type { MobileResult } from "@realm/remote";

/**
 * Usage as a phone reads it (PROTOCOL.md §8): each agent's plan as Settings ▸ Usage draws it, and this
 * calendar month's spend. The honesty rules are the page's: a window with no figure, or one that has
 * reset since it was read, has no percent rather than a zero, and an agent that cannot report says why
 * in the page's own sentence.
 */

type Usage = MobileResult<"usage.get">;
type Limits = Usage["limits"][number];

/** How many of the month's sessions the phone is shown, heaviest first. */
export const TOP_SESSIONS = 5;

/** The agents a person can run, in the order the page lists them. `limits.get` answers for every kind
 *  there is, the scripted one the suite drives among them, which the page leaves out. */
const RUNNABLE: readonly AgentKind[] = SELECTABLE_AGENT_KINDS;

/** The first of this month on the Mac's clock: a budget is a calendar month where the Mac is. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** The provider's warning in words, beside the page's "limit reached", naming the window it is about
 *  where the provider named one. Null once that window has reset, and when there is no warning. */
function alertWords(row: PlanLimits, now: number): string | null {
  const alert = currentAlert(row, now);
  if (alert === "none") return null;
  const window = row.windows.find((w) => w.id === row.alertWindow);
  const limit = window ? `${window.label} limit` : "Limit";
  return alert === "exceeded" ? `${limit} reached` : `${limit} nearly reached`;
}

/** Why there is nothing to draw, in the page's sentence: the provider's own reason, or a kind that
 *  reports and has not been heard from yet. Null while there are windows. */
function unavailableWords(row: PlanLimits, kind: AgentKind): string | null {
  if (row.unavailable) return `${planUnavailableNote(kind, row.unavailable)}${row.detail ? ` (${row.detail})` : ""}`;
  return row.windows.length === 0 ? planUnavailableNote(kind, "not-yet-known") : null;
}

export function planLimits(row: PlanLimits, now: number): Limits {
  const kind = row.agentKind as AgentKind;
  return {
    agent: kind, agentName: AGENT_META[kind].label, agentMark: AGENT_META[kind].icon, plan: row.subscriptionType,
    // Fullest first, as the page draws them: what stops the person next.
    windows: windowsByUrgency(row.windows).map((w) => ({
      id: w.id, label: w.label, resetsAt: w.resetsAt,
      usedPercent: w.utilization === null || windowHasReset(w, now) ? null : Math.max(0, Math.min(100, w.utilization)),
    })),
    alert: alertWords(row, now), unavailable: unavailableWords(row, kind), at: row.ts,
  };
}

/** Every runnable agent's plan, those that report first, as the page puts its cards before the one
 *  line naming the agents that cannot. */
export function everyPlan(rows: readonly PlanLimits[], now: number): Limits[] {
  const by = new Map(rows.map((r) => [r.agentKind, r]));
  const kinds = RUNNABLE.filter((k) => by.has(k));
  return [...kinds.filter(reportsPlanLimits), ...kinds.filter((k) => !reportsPlanLimits(k))].map((k) => planLimits(by.get(k)!, now));
}

/** This month's spend, its budget, and the heaviest sessions by the names their rows have. */
export function spend(summary: UsageSummary, titles: ReadonlyMap<string, string>): Usage["spend"] {
  const heaviest = summary.sessions.filter((s) => s.totals.costUsd > 0)
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, TOP_SESSIONS);
  return {
    monthToDate: summary.budget.monthSpendUsd,
    budget: summary.budget.budget.monthlyUsd,
    topSessions: heaviest.map((s) => ({ id: s.id, title: titles.get(s.id) || s.title, spaceName: s.spaceName, cost: s.totals.costUsd })),
  };
}
