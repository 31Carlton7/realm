import type { LayaEvalReport } from "@realm/contracts";
import type { ObservedElement } from "../mcp/act-observer";
import { offeredToLaya } from "../simulators/executor";
import type { BenchElement, BenchScreen, Benchmark, Split } from "./benchmark";
import type { LayaChoiceAnswer, LayaNoulAnswer, LayaQuestion } from "./client";
import { SHADOW_PROMPT_VERSION, describeTarget, pickCandidates, readSensitive, sensitiveQuestion, sensitiveRule, targetQuestion, verifyQuestion } from "./shadow";

/**
 * Scoring a checkpoint on the benchmark, the way Realm uses it.
 *
 * Every question is built by the shadow's own functions (`targetQuestion`, `sensitiveQuestion`,
 * `verifyQuestion`), so a number here is a number about the questions Realm really asks. `target` is
 * asked exactly as a walk's Assist asks it — `pickCandidates` over the whole screen with nothing chosen,
 * the case's words as the goal, as a tap — so a right element that the candidate rule leaves out is a
 * miss here as it would be in a walk, and the report says how often that was (`candidateRecall`).
 *
 * The Assist threshold is fitted on the `train` split and only measured on `heldout`: the lowest
 * confidence at which Laya's pick was right at least `precision` of the time on at least
 * `minSupport` train cases. Fewer than that and no threshold is claimed — two lucky picks are not a
 * precision.
 */

export type Ask = (state: string, questions: Record<string, LayaQuestion>) => Promise<{ answers: Record<string, LayaChoiceAnswer | LayaNoulAnswer>; ms: number }>;

/** A walk resolves a label for a tap; that is the tool every `target` case is asked as. */
export const WALK_TOOL = "simulator_tap";
/** The precision Assist's threshold is fitted for. */
export const ASSIST_PRECISION = 0.98;
/** At least this many train cases must clear a threshold for its precision to mean anything. */
export const MIN_THRESHOLD_SUPPORT = 20;

type Base = { id: string; split: Split; app: string; ms: number; error: string | null };
export type TargetResult = Base & { kind: "target"; copies: boolean; inCandidates: boolean; choice: string | null; confidence: number; right: boolean };
export type SensitiveResult = Base & { kind: "sensitive"; want: boolean; p: number; rule: boolean };
export type VerifyResult = Base & { kind: "verify"; want: boolean; p: number; rule: boolean; failure: string };
export type EvalResult = TargetResult | SensitiveResult | VerifyResult;

export type EvalSplits = { target: Split[]; sensitive: Split[]; verify: Split[] };
/** What a report needs: `target` on train (for the threshold) and held-out, the rest on held-out. */
export const REPORT_SPLITS: EvalSplits = { target: ["train", "heldout"], sensitive: ["heldout"], verify: ["heldout"] };

const observed = ({ frame: _frame, ...e }: BenchElement): ObservedElement => e;

/** What a walk offers Laya on this screen (`offeredToLaya`): all of it but the status bar. An element
 *  kept without a frame stays — there is no telling where it was drawn. */
export function walkOffers(screen: BenchScreen): BenchElement[] {
  const framed = screen.elements.flatMap((e) => (e.frame ? [{
    path: e.id, label: e.label, value: e.value ?? "", role: e.role, id: null, enabled: true, depth: e.id.split(".").length,
    frame: { x: e.frame[0]!, y: e.frame[1]!, width: e.frame[2]!, height: e.frame[3]! },
  }] : []));
  const kept = new Set(offeredToLaya({ screen: { width: 0, height: 0 }, units: "points", app: screen.app, elements: framed }).map((e) => e.path));
  return screen.elements.filter((e) => !e.frame || kept.has(e.id));
}

/** Asks every case of the chosen splits, one at a time, in benchmark order. A question that fails is
 *  scored as wrong, with the reason kept: Realm would have had no answer either. */
export async function evaluate(b: Benchmark, ask: Ask, o: { splits?: EvalSplits; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<EvalResult[]> {
  const splits = o.splits ?? REPORT_SPLITS;
  const target = b.target.filter((c) => splits.target.includes(c.split));
  const sensitive = b.sensitive.filter((c) => splits.sensitive.includes(c.split));
  const verify = b.verify.filter((c) => splits.verify.includes(c.split));
  const total = target.length + sensitive.length + verify.length;
  const results: EvalResult[] = [];
  const done = () => o.onProgress?.(results.length, total);
  const stopped = () => { if (o.signal?.aborted) throw new Error("the evaluation was stopped"); };

  for (const c of target) {
    stopped();
    const elements = walkOffers(b.screens.get(c.screen)!).map(observed);
    const candidates = pickCandidates(elements, null, c.intent);
    const right = new Set([c.element, ...(c.alsoRight ?? [])]);
    const base = { kind: "target" as const, id: c.id, split: c.split, app: c.app, copies: c.copies, inCandidates: candidates.some((e) => right.has(e.id)) };
    if (candidates.length === 0) {
      results.push({ ...base, choice: null, confidence: 0, right: false, ms: 0, error: "no candidates" });
    } else {
      const q = targetQuestion(c.intent, candidates, WALK_TOOL);
      try {
        const { answers, ms } = await ask(q.state, q.questions);
        const a = answers.target;
        if (a?.type !== "choice") throw new Error("no choice in the answer");
        const choice = q.idOf.get(a.choice) ?? null;
        results.push({ ...base, choice, confidence: a.confidence, right: choice !== null && right.has(choice), ms, error: null });
      } catch (e) {
        results.push({ ...base, choice: null, confidence: 0, right: false, ms: 0, error: message(e) });
      }
    }
    done();
  }

  for (const c of sensitive) {
    stopped();
    const el = observed(b.screens.get(c.screen)!.elements.find((e) => e.id === c.element)!);
    const rule = sensitiveRule(`${c.intent} ${describeTarget(el)}`, c.app).value;
    const q = sensitiveQuestion(c.tool, { element: el }, c.intent);
    const base = { kind: "sensitive" as const, id: c.id, split: c.split, app: c.app, want: c.sensitive, rule };
    try {
      const { answers, ms } = await ask(q.state, q.questions);
      results.push({ ...base, p: readSensitive(answers).p, ms, error: null });
    } catch (e) {
      results.push({ ...base, p: 0, ms: 0, error: message(e) });
    }
    done();
  }

  for (const c of verify) {
    stopped();
    const pair = b.pairs.get(c.pair)!;
    const q = verifyQuestion(c.intent, pair.before.map(observed), pair.after.map(observed));
    const base = { kind: "verify" as const, id: c.id, split: c.split, app: c.app, want: c.achieved, rule: q.diff.changed && !q.diff.alert, failure: c.kind };
    try {
      const { answers, ms } = await ask(q.state, q.questions);
      const a = answers.verify;
      if (a?.type !== "noul") throw new Error("no noul in the answer");
      results.push({ ...base, p: a.noul, ms, error: null });
    } catch (e) {
      results.push({ ...base, p: 0, ms: 0, error: message(e) });
    }
    done();
  }
  return results;
}

/**
 * The lowest confidence at or above which the picks were right at least `precision` of the time, over
 * at least `minSupport` picks — or null when no confidence gets there.
 */
export function fitThreshold(points: readonly { confidence: number; right: boolean }[], precision = ASSIST_PRECISION, minSupport = MIN_THRESHOLD_SUPPORT): number | null {
  const sorted = [...points].sort((a, b) => b.confidence - a.confidence);
  let right = 0;
  let best: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.right) right++;
    // Only where the confidence changes: a threshold cannot split two picks that scored the same.
    if (i + 1 < sorted.length && sorted[i + 1]!.confidence === sorted[i]!.confidence) continue;
    const n = i + 1;
    if (n >= minSupport && right / n >= precision) best = sorted[i]!.confidence;
  }
  return best;
}

/** How the picks at or above `threshold` did: their precision, and the share of all picks they are. */
export function atThreshold(points: readonly { confidence: number; right: boolean }[], threshold: number | null): { precision: number; coverage: number; covered: number } {
  if (threshold === null || points.length === 0) return { precision: 0, coverage: 0, covered: 0 };
  const above = points.filter((p) => p.confidence >= threshold);
  return { precision: above.length ? above.filter((p) => p.right).length / above.length : 0, coverage: above.length / points.length, covered: above.length };
}

/** The report (`LayaEvalReportSchema`) for one checkpoint's results. Every headline number is on
 *  `heldout`; `train` only fits the threshold, and `validation`, when it was asked, is reported apart
 *  for choosing between training runs. */
export function reportOf(results: readonly EvalResult[], o: { checkpoint: string; benchmark: { version: string }; createdAt?: string }): LayaEvalReport {
  const held = results.filter((r) => r.split === "heldout");
  const targets = (rs: readonly EvalResult[]) => rs.filter((r): r is TargetResult => r.kind === "target");
  const sens = held.filter((r): r is SensitiveResult => r.kind === "sensitive");
  const ver = held.filter((r): r is VerifyResult => r.kind === "verify");
  const heldTarget = targets(held);

  const threshold = fitThreshold(targets(results.filter((r) => r.split === "train")));
  const assist = atThreshold(heldTarget, threshold);
  const trainAt = atThreshold(targets(results.filter((r) => r.split === "train")), threshold);
  const said = (r: SensitiveResult | VerifyResult) => r.p >= 0.5;
  const positives = sens.filter((r) => r.want);
  const flagged = sens.filter(said);
  const ms = held.filter((r) => r.error === null && r.ms > 0).map((r) => r.ms);
  const validation = results.filter((r) => r.split === "validation");

  return {
    v: 1,
    checkpoint: o.checkpoint,
    createdAt: o.createdAt ?? new Date().toISOString(),
    prompt: SHADOW_PROMPT_VERSION,
    benchmark: { version: o.benchmark.version, split: "heldout", cases: held.length, apps: [...new Set(held.map((r) => r.app))].sort() },
    target: {
      ...accuracyOf(heldTarget),
      byApp: byApp(heldTarget),
      assist: { threshold, precision: round(assist.precision), coverage: round(assist.coverage), covered: assist.covered, fittedOn: "train", trainPrecision: round(trainAt.precision), trainCoverage: round(trainAt.coverage) },
      notCopying: { ...accuracyOf(heldTarget.filter((r) => !r.copies)), byApp: byApp(heldTarget.filter((r) => !r.copies)) },
      candidateRecall: round(share(heldTarget, (r) => r.inCandidates)),
    },
    sensitive: {
      accuracy: round(share(sens, (r) => said(r) === r.want)),
      recall: round(share(positives, said)),
      precision: round(share(flagged, (r) => r.want)),
      n: sens.length,
    },
    verify: { ...accuracyOf(ver.map((r) => ({ right: said(r) === r.want }))), byKind: byKey(ver, (r) => r.failure, (r) => said(r) === r.want) },
    baseline: {
      sensitiveRule: { accuracy: round(share(sens, (r) => r.rule === r.want)), recall: round(share(positives, (r) => r.rule)) },
      verifyRule: { accuracy: round(share(ver, (r) => r.rule === r.want)) },
    },
    latencyMs: { p50: percentile(ms, 0.5), p90: percentile(ms, 0.9) },
    errors: held.filter((r) => r.error !== null).length,
    ...(validation.length ? { validation: summaryOf(validation) } : {}),
  };
}

/** The same three numbers on another split — how training runs are compared without touching held-out. */
export function summaryOf(rs: readonly EvalResult[]): { target: { accuracy: number; n: number }; targetNotCopying: { accuracy: number; n: number }; sensitive: { accuracy: number; n: number }; verify: { accuracy: number; n: number } } {
  const t = rs.filter((r): r is TargetResult => r.kind === "target");
  const s = rs.filter((r): r is SensitiveResult => r.kind === "sensitive");
  const v = rs.filter((r): r is VerifyResult => r.kind === "verify");
  return {
    target: accuracyOf(t),
    targetNotCopying: accuracyOf(t.filter((r) => !r.copies)),
    sensitive: accuracyOf(s.map((r) => ({ right: (r.p >= 0.5) === r.want }))),
    verify: accuracyOf(v.map((r) => ({ right: (r.p >= 0.5) === r.want }))),
  };
}

function accuracyOf(rs: readonly { right: boolean }[]): { accuracy: number; n: number } {
  return { accuracy: round(share(rs, (r) => r.right)), n: rs.length };
}

function byApp(rs: readonly TargetResult[]): Record<string, { accuracy: number; n: number }> {
  return byKey(rs, (r) => r.app, (r) => r.right);
}

function byKey<T>(rs: readonly T[], key: (r: T) => string, right: (r: T) => boolean): Record<string, { accuracy: number; n: number }> {
  const groups = new Map<string, T[]>();
  for (const r of rs) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => [k, { accuracy: round(share(g, right)), n: g.length }]));
}

function share<T>(rs: readonly T[], test: (r: T) => boolean): number {
  return rs.length ? rs.filter(test).length / rs.length : 0;
}

/** Nearest-rank percentile, in whole milliseconds; 0 for no samples. */
export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!);
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
