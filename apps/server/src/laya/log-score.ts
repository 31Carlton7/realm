import { LAYA_ASSIST_MIN_ACCURACY } from "@realm/contracts";
import { ASSIST_PRECISION, MIN_THRESHOLD_SUPPORT, atThreshold, fitThreshold, percentile } from "./eval";
import type { ShadowRow } from "./shadow";

/**
 * How Laya did on the user's own steps: the decision log scored against what actually happened, by
 * surface and by the app or site each step was in.
 *
 * The benchmark (`eval.ts`) says how a checkpoint does on screens someone labelled; this says how it
 * does on the screens this Mac really drove, which is the evidence a site needs before Laya acts on it.
 * A `target` is right when Laya picked the element the agent chose. A step Laya itself chose in Assist
 * is never counted — grading Laya on its own picks would only ever agree.
 *
 * Read the numbers as a ceiling, not as Assist's. The shadow always offers Laya the agent's own element
 * among the candidates (`pickCandidates` with the choice in hand); Assist offers what the description
 * matches, which may leave the right element out.
 *
 * The threshold is fitted on the older half of a group's steps and measured on the newer half, so a
 * group is judged on steps its threshold never saw. Under `2 × MIN_THRESHOLD_SUPPORT` steps nothing is
 * fitted: a threshold from a handful of picks is luck.
 */

export type TargetCase = { at: string; confidence: number; right: boolean; ms: number };

export type LogScoreGroup = {
  surface: ShadowRow["surface"];
  /** The app or site; null for the surface as a whole, "unknown" for steps logged without one. */
  app: string | null;
  steps: number;
  target: { n: number; accuracy: number; p50Ms: number };
  assist: { threshold: number | null; precision: number; coverage: number; covered: number; measuredOn: number };
  ready: { yes: boolean; reason: string };
  /** Laya's say against the keyword rule, which is the sensitive truth the log holds. */
  sensitive: { n: number; flagged: number; recall: number; agreement: number };
  /** Laya and the screen-diff rule on the same steps, each against what the next step said. */
  verify: { n: number; accuracy: number; ruleAccuracy: number };
};

export type LogScore = {
  checkpoint: string | null;
  /** Every checkpoint the log holds rows from, newest last; only `checkpoint`'s are scored. */
  checkpoints: { name: string | null; rows: number }[];
  rows: number;
  from: string | null;
  to: string | null;
  bySurface: LogScoreGroup[];
  byApp: LogScoreGroup[];
};

export const UNKNOWN_APP = "unknown";

/** Score `log` (oldest first, as `readLog` returns it) for one checkpoint — by default the one the
 *  newest row was asked of: a mix of models is no model's number. */
export function scoreLog(log: readonly ShadowRow[], o: { checkpoint?: string | null } = {}): LogScore {
  const counts = new Map<string | null, number>();
  for (const r of log) counts.set(r.checkpoint, (counts.get(r.checkpoint) ?? 0) + 1);
  const checkpoint = o.checkpoint !== undefined ? o.checkpoint : log.at(-1)?.checkpoint ?? null;
  const rows = log.filter((r) => r.checkpoint === checkpoint);

  const groups = (key: (r: ShadowRow) => string): ShadowRow[][] => {
    const m = new Map<string, ShadowRow[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  };
  return {
    checkpoint,
    checkpoints: [...counts.entries()].map(([name, n]) => ({ name, rows: n })),
    rows: rows.length,
    from: rows[0]?.at ?? null,
    to: rows.at(-1)?.at ?? null,
    bySurface: groups((r) => r.surface).map((g) => groupOf(g, null)),
    byApp: groups((r) => `${r.surface}\0${r.app ?? UNKNOWN_APP}`).map((g) => groupOf(g, g[0]!.app ?? UNKNOWN_APP)),
  };
}

/** The steps whose `target` can be graded: Laya answered, and the agent — not Laya — chose. */
export function targetCases(rows: readonly ShadowRow[]): TargetCase[] {
  return rows.flatMap((r) => (r.laya.target && r.truth.target?.source === "agent"
    ? [{ at: r.at, confidence: r.laya.target.confidence, right: r.laya.target.choice === r.truth.target.id, ms: r.laya.target.ms }]
    : []));
}

/** Fit on the older half, measure on the newer: the threshold is judged on steps it never saw. */
export function assistOn(cases: readonly TargetCase[]): LogScoreGroup["assist"] {
  const half = Math.floor(cases.length / 2);
  const older = cases.slice(0, half);
  const newer = cases.slice(half);
  const threshold = cases.length >= 2 * MIN_THRESHOLD_SUPPORT ? fitThreshold(older) : null;
  const at = atThreshold(newer, threshold);
  return { threshold, precision: round(at.precision), coverage: round(at.coverage), covered: at.covered, measuredOn: threshold === null ? 0 : newer.length };
}

/** Whether these steps would earn Assist on their own: enough of them, right often enough overall,
 *  and precise above a threshold fitted without them. */
export function readiness(target: LogScoreGroup["target"], assist: LogScoreGroup["assist"]): LogScoreGroup["ready"] {
  if (target.n < 2 * MIN_THRESHOLD_SUPPORT) return { yes: false, reason: `${target.n} graded steps; needs ${2 * MIN_THRESHOLD_SUPPORT}` };
  if (target.accuracy < LAYA_ASSIST_MIN_ACCURACY) return { yes: false, reason: `right ${pct(target.accuracy)}; needs ${pct(LAYA_ASSIST_MIN_ACCURACY)}` };
  if (assist.threshold === null) return { yes: false, reason: `no confidence reached ${pct(ASSIST_PRECISION)} precision on the older half` };
  if (assist.precision < ASSIST_PRECISION) return { yes: false, reason: `${pct(assist.precision)} precise on newer steps; needs ${pct(ASSIST_PRECISION)}` };
  return { yes: true, reason: `${pct(assist.precision)} precise above ${assist.threshold}, covering ${pct(assist.coverage)} of newer steps` };
}

function groupOf(rows: readonly ShadowRow[], app: string | null): LogScoreGroup {
  const cases = targetCases(rows);
  const target = { n: cases.length, accuracy: round(share(cases, (c) => c.right)), p50Ms: percentile(cases.map((c) => c.ms), 0.5) };
  const assist = assistOn(cases);

  const sens = rows.filter((r) => r.laya.sensitive);
  const said = (r: ShadowRow) => r.laya.sensitive!.p >= 0.5;
  const flagged = sens.filter((r) => r.truth.sensitive.value);
  const ver = rows.filter((r) => r.truth.verify && r.laya.verify && r.baseline.verify);

  return {
    surface: rows[0]!.surface,
    app,
    steps: rows.length,
    target,
    assist,
    ready: readiness(target, assist),
    sensitive: { n: sens.length, flagged: flagged.length, recall: round(share(flagged, said)), agreement: round(share(sens, (r) => said(r) === r.truth.sensitive.value)) },
    verify: {
      n: ver.length,
      accuracy: round(share(ver, (r) => (r.laya.verify!.p >= 0.5) === r.truth.verify!.value)),
      ruleAccuracy: round(share(ver, (r) => r.baseline.verify!.value === r.truth.verify!.value)),
    },
  };
}

/** A share as a percentage to one place, the way every reader of a score shows it. */
export function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`;
}

function share<T>(rs: readonly T[], test: (r: T) => boolean): number {
  return rs.length ? rs.filter(test).length / rs.length : 0;
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
