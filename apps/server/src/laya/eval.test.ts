import { describe, expect, it } from "vitest";
import { LayaEvalReportSchema } from "@realm/contracts";
import type { Benchmark, BenchElement, SensitiveBenchCase, Split, TargetBenchCase, VerifyBenchCase } from "./benchmark";
import type { LayaChoiceAnswer, LayaNoulAnswer } from "./client";
import { atThreshold, evaluate, fitThreshold, percentile, reportOf, walkOffers, type Ask, type EvalResult, type TargetResult } from "./eval";
import { SHADOW_PROMPT_VERSION, pickCandidates, targetQuestion } from "./shadow";

/**
 * The scorer, with an answering function standing in for laya-serve. What must die: a question worded
 * differently from the shadow's, a candidate set Assist would not have offered, a threshold fitted on
 * the cases it is then measured on, a failure counted as anything but wrong, and any headline number
 * that is not held-out's.
 */

const el = (id: string, label: string, role = "Button", frame?: number[], value?: string): BenchElement =>
  ({ id, role, label, ...(value ? { value } : {}), ...(frame ? { frame } : {}) });

const SETTINGS = [
  el("0.0", "Settings", "Heading", [20, 120, 133, 41]),
  el("0.1", "General", "Button", [20, 290, 400, 52]),
  el("0.2", "Accessibility", "Button", [20, 345, 400, 52]),
  el("0.3", "Bluetooth", "Button", [20, 400, 400, 52]),
  el("0.4", "Privacy & Security", "Button", [20, 455, 400, 52]),
  el("0.9", "9:41 AM", "StaticText", [64, 22, 39, 22]),
];
const BEFORE = [el("0.0", "Settings", "Heading"), el("0.1", "General")];
const AFTER = [el("0.0", "General", "Heading"), el("0.1", "About")];

function bench(o: { target?: Partial<TargetBenchCase>[]; sensitive?: Partial<SensitiveBenchCase>[]; verify?: Partial<VerifyBenchCase>[] } = {}): Benchmark {
  const t = (c: Partial<TargetBenchCase>, i: number): TargetBenchCase => ({ id: `t${i}`, split: "heldout", app: "Settings", screen: "root", element: "0.3", intent: "pair my AirPods", copies: false, ...c });
  const s = (c: Partial<SensitiveBenchCase>, i: number): SensitiveBenchCase => ({ id: `s${i}`, split: "heldout", app: "Settings", screen: "root", element: "0.1", tool: "simulator_tap", intent: "open General", sensitive: false, part: null, ...c });
  const v = (c: Partial<VerifyBenchCase>, i: number): VerifyBenchCase => ({ id: `v${i}`, split: "heldout", app: "Settings", pair: "p", tool: "simulator_tap", intent: "open General", achieved: true, kind: "ok", ...c });
  return {
    version: "test-1", dir: "/nowhere", apps: ["Settings"],
    screens: new Map([["root", { id: "root", app: "Settings", from: "test", elements: SETTINGS }]]),
    pairs: new Map([
      ["p", { id: "p", app: "Settings", tool: "simulator_tap", action: "tap", before: BEFORE, after: AFTER }],
      ["same", { id: "same", app: "Settings", tool: "simulator_tap", action: "tap", before: BEFORE, after: BEFORE }],
      ["alert", { id: "alert", app: "Settings", tool: "simulator_tap", action: "tap", before: BEFORE, after: [...BEFORE, el("0.5", "Could Not Set Up Apple Pay", "Alert")] }],
    ]),
    target: (o.target ?? []).map(t), sensitive: (o.sensitive ?? []).map(s), verify: (o.verify ?? []).map(v),
  };
}

type Asked = { state: string; questions: Record<string, unknown> };
/** Answers `target` with the option labelled `pick`, at `confidence`; every noul with `noul`. */
function answering(o: { pick?: string; confidence?: number; noul?: number | ((qid: string, state: string) => number); fail?: RegExp } = {}): { ask: Ask; asked: Asked[] } {
  const asked: Asked[] = [];
  const ask: Ask = async (state, questions) => {
    asked.push({ state, questions });
    if (o.fail?.test(state)) throw new Error("laya-serve did not answer within 10000 ms");
    const answers: Record<string, LayaChoiceAnswer | LayaNoulAnswer> = {};
    for (const [qid, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const choice = o.pick && keys.includes(o.pick) ? o.pick : keys[0]!;
        answers[qid] = { type: "choice", choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0.1 / (keys.length - 1)])), confidence: o.confidence ?? 0.9 };
      } else {
        const p = typeof o.noul === "function" ? o.noul(qid, state) : o.noul ?? 0.1;
        answers[qid] = { type: "noul", noul: p, confidence: Math.max(p, 1 - p) };
      }
    }
    return { answers, ms: 40 };
  };
  return { ask, asked };
}

describe("asking the benchmark", () => {
  it("asks target exactly as a walk's Assist does: the words as the goal, as a tap, over the screen less its status bar", async () => {
    const b = bench({ target: [{}] });
    const { ask, asked } = answering({ pick: "Bluetooth" });
    const [r] = await evaluate(b, ask, { splits: { target: ["heldout"], sensitive: [], verify: [] } });
    const offered = SETTINGS.filter((e) => e.id !== "0.9").map(({ frame: _f, ...e }) => e);
    const q = targetQuestion("pair my AirPods", pickCandidates(offered, null, "pair my AirPods"), "simulator_tap");
    expect(asked[0]).toEqual({ state: q.state, questions: q.questions });
    expect(JSON.stringify(asked[0]!.questions)).not.toContain("9:41");
    expect(r).toMatchObject({ kind: "target", right: true, choice: "0.3", inCandidates: true, confidence: 0.9 });
  });

  it("counts a pick of a second drawing of the same thing as right, and any other pick as wrong", async () => {
    const b = bench({ target: [{ element: "0.2", alsoRight: ["0.3"] }, { element: "0.2" }] });
    const results = await evaluate(b, answering({ pick: "Bluetooth" }).ask, { splits: { target: ["heldout"], sensitive: [], verify: [] } });
    expect(results.map((r) => (r as TargetResult).right)).toEqual([true, false]);
  });

  it("scores a question that got no answer as wrong, and says why", async () => {
    const b = bench({ target: [{}], sensitive: [{ sensitive: true, part: "delete" }], verify: [{}] });
    const results = await evaluate(b, answering({ pick: "Bluetooth", fail: /./ }).ask, { splits: { target: ["heldout"], sensitive: ["heldout"], verify: ["heldout"] } });
    expect(results.map((r) => r.error)).toEqual(Array(3).fill("laya-serve did not answer within 10000 ms"));
    expect(results[0]).toMatchObject({ right: false, confidence: 0 });
    expect(results[1]).toMatchObject({ p: 0, want: true });
  });

  it("does not ask at all when the screen offers nothing to choose from", async () => {
    const b = bench({ target: [{}] });
    b.screens.set("root", { id: "root", app: "Settings", from: "test", elements: [el("0.9", "9:41 AM", "StaticText", [64, 22, 39, 22]), el("0.3", "", "Button")] });
    const { ask, asked } = answering();
    const [r] = await evaluate(b, ask, { splits: { target: ["heldout"], sensitive: [], verify: [] } });
    expect(asked).toHaveLength(0);
    expect(r).toMatchObject({ right: false, error: "no candidates", inCandidates: false });
  });

  it("reads sensitive as the highest of its four parts, and verify as its one noul, each against 0.5", async () => {
    const b = bench({ sensitive: [{ sensitive: true, part: "delete", intent: "delete it" }, { intent: "open General" }], verify: [{ achieved: true }, { pair: "same", achieved: false, kind: "no-change" }, { pair: "alert", achieved: false, kind: "alert" }] });
    const noul = (qid: string, state: string) => (qid === "delete" && state.includes("delete it") ? 0.8 : qid === "verify" ? (state.includes("No change") ? 0.3 : 0.7) : 0.2);
    const results = await evaluate(b, answering({ noul }).ask, { splits: { target: [], sensitive: ["heldout"], verify: ["heldout"] } });
    expect(results.map((r) => ("p" in r ? r.p : null))).toEqual([0.8, 0.2, 0.7, 0.3, 0.7]);
    // The rules are what Laya has to beat: the keyword rule, and "the screen changed and no alert came up".
    expect(results.map((r) => ("rule" in r ? r.rule : null))).toEqual([true, false, true, false, false]);
  });

  it("judges the rule baseline in the case's own app, as the shadow judges a step", async () => {
    const b = bench({ sensitive: [{ app: "Instagram", intent: "like it", sensitive: true, part: "send" }, { app: "Settings", intent: "like it" }] });
    const results = await evaluate(b, answering().ask, { splits: { target: [], sensitive: ["heldout"], verify: [] } });
    // THE MUTANT: judge without the app. Laya's score on a like in Instagram is set against a rule that misses it.
    expect(results.map((r) => ("rule" in r ? r.rule : null))).toEqual([true, false]);
  });

  it("asks only the splits it is given, in benchmark order, and reports progress", async () => {
    const b = bench({ target: [{ split: "train" }, { split: "validation" }, { split: "heldout" }] });
    const seen: number[] = [];
    const results = await evaluate(b, answering().ask, { splits: { target: ["train", "heldout"], sensitive: [], verify: [] }, onProgress: (done) => seen.push(done) });
    expect(results.map((r) => r.split)).toEqual(["train", "heldout"]);
    expect(seen).toEqual([1, 2]);
  });

  it("stops between questions when told to", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(evaluate(bench({ target: [{}] }), answering().ask, { signal: stop.signal })).rejects.toThrow(/stopped/);
  });
});

describe("the Assist threshold", () => {
  const pts = (spec: [number, boolean][]) => spec.map(([confidence, right]) => ({ confidence, right }));

  it("is the lowest confidence whose picks at or above it are right at least 98% of the time", () => {
    const points = pts([...Array.from({ length: 49 }, (_, i): [number, boolean] => [0.99 - i * 0.001, true]), [0.5, false], [0.4, true], [0.3, false]]);
    // At 0.5 the 50 picks are 49 right: 98%. At 0.4, 50 of 51 are right (98.04%) — lower and still enough.
    expect(fitThreshold(points, 0.98, 20)).toBe(0.4);
    expect(fitThreshold(points, 0.99, 20)).toBe(0.99 - 48 * 0.001);
  });

  it("takes a precision of exactly 98% as reaching 98%", () => {
    // 49 right and then one wrong, all at their own confidence: at the last, 49 of 50 — 98% on the nose.
    const points = pts([...Array.from({ length: 49 }, (_, i): [number, boolean] => [0.99 - i * 0.001, true]), [0.3, false]]);
    expect(fitThreshold(points, 0.98, 20)).toBe(0.3);
  });

  it("claims none on fewer picks than the support it needs, or when no confidence reaches the precision", () => {
    expect(fitThreshold(pts(Array.from({ length: 19 }, (): [number, boolean] => [0.9, true])), 0.98, 20)).toBeNull();
    expect(fitThreshold(pts(Array.from({ length: 40 }, (_, i): [number, boolean] => [1 - i / 100, i % 2 === 0])), 0.98, 20)).toBeNull();
    expect(fitThreshold([], 0.98, 20)).toBeNull();
  });

  it("never splits picks that scored the same", () => {
    // 20 right picks at 0.9, then three at 0.8 of which two are wrong: 0.8 cannot be chosen by
    // pretending only the right one of them is above it.
    const points = pts([...Array.from({ length: 20 }, (): [number, boolean] => [0.9, true]), [0.8, true], [0.8, false], [0.8, false]]);
    expect(fitThreshold(points, 0.98, 20)).toBe(0.9);
  });

  it("is measured, not assumed, where it is applied", () => {
    const held = pts([[0.95, true], [0.9, false], [0.5, true], [0.2, false]]);
    expect(atThreshold(held, 0.9)).toEqual({ precision: 0.5, coverage: 0.5, covered: 2 });
    expect(atThreshold(held, null)).toEqual({ precision: 0, coverage: 0, covered: 0 });
    expect(atThreshold(held, 0.99)).toEqual({ precision: 0, coverage: 0, covered: 0 });
  });
});

describe("the report", () => {
  const target = (split: Split, right: boolean, o: Partial<TargetResult> = {}): EvalResult =>
    ({ kind: "target", id: `${split}-${Math.random()}`, split, app: "Settings", copies: false, inCandidates: true, choice: right ? "a" : "b", confidence: 0.9, right, ms: 40, error: null, ...o });

  it("puts only held-out results in its headline numbers, and fits the threshold on train alone", () => {
    const results: EvalResult[] = [
      ...Array.from({ length: 30 }, () => target("train", true, { confidence: 0.95 })),
      ...Array.from({ length: 10 }, () => target("train", false, { confidence: 0.3 })),
      target("heldout", true, { confidence: 0.97, app: "Maps" }), target("heldout", false, { confidence: 0.96, app: "Maps" }),
      target("heldout", true, { confidence: 0.2, app: "Health", copies: true, inCandidates: true }), target("heldout", false, { confidence: 0.1, app: "Health", inCandidates: false }),
      ...Array.from({ length: 5 }, () => target("validation", false)),
    ];
    const r = LayaEvalReportSchema.parse(reportOf(results, { checkpoint: "local:test", benchmark: { version: "test-1" }, createdAt: "2026-09-29T00:00:00.000Z" }));
    expect(r).toMatchObject({ v: 1, checkpoint: "local:test", prompt: SHADOW_PROMPT_VERSION, benchmark: { version: "test-1", split: "heldout", cases: 4, apps: ["Health", "Maps"] } });
    expect(r.target).toMatchObject({ accuracy: 0.5, n: 4, byApp: { Maps: { accuracy: 0.5, n: 2 }, Health: { accuracy: 0.5, n: 2 } }, candidateRecall: 0.75 });
    // Fitted on train's 30 right picks at 0.95; on held-out that threshold lets through a right and a wrong one.
    expect(r.target.assist).toMatchObject({ threshold: 0.95, precision: 0.5, coverage: 0.5, covered: 2, fittedOn: "train", trainPrecision: 1, trainCoverage: 0.75 });
    expect(r.target.notCopying).toMatchObject({ accuracy: 0.3333, n: 3 });
    expect(r.validation).toMatchObject({ target: { accuracy: 0, n: 5 } });
  });

  it("scores sensitive and verify against 0.5, next to the rules, with their recall and precision", () => {
    const s = (want: boolean, p: number, rule: boolean): EvalResult => ({ kind: "sensitive", id: String(Math.random()), split: "heldout", app: "Settings", want, p, rule, ms: 30, error: null });
    const v = (want: boolean, p: number, rule: boolean, failure = "ok"): EvalResult => ({ kind: "verify", id: String(Math.random()), split: "heldout", app: "Settings", want, p, rule, failure, ms: 50, error: null });
    const r = reportOf([s(true, 0.9, true), s(true, 0.4, true), s(false, 0.6, true), s(false, 0.1, false), s(false, 0.2, false), v(true, 0.8, true), v(false, 0.7, true, "wrong-screen"), v(false, 0.2, false, "no-change")], { checkpoint: "c", benchmark: { version: "t" } });
    // Recall is over the sensitive steps only: one of the two was flagged — not two of the five.
    expect(r.sensitive).toEqual({ accuracy: 0.6, recall: 0.5, precision: 0.5, n: 5 });
    expect(r.baseline).toEqual({ sensitiveRule: { accuracy: 0.8, recall: 1 }, verifyRule: { accuracy: 0.6667 } });
    expect(r.verify).toMatchObject({ accuracy: 0.6667, n: 3, byKind: { ok: { accuracy: 1, n: 1 }, "wrong-screen": { accuracy: 0, n: 1 }, "no-change": { accuracy: 1, n: 1 } } });
    expect(r.latencyMs).toEqual({ p50: 30, p90: 50 });
  });

  it("takes 0.5 as a yes", () => {
    const r = reportOf([{ kind: "sensitive", id: "s", split: "heldout", app: "Settings", want: true, p: 0.5, rule: false, ms: 30, error: null }], { checkpoint: "c", benchmark: { version: "t" } });
    expect(r.sensitive.recall).toBe(1);
  });

  it("leaves a question that got no answer out of the latency, and counts it", () => {
    const results: EvalResult[] = [target("heldout", true, { ms: 40 }), target("heldout", false, { ms: 0, error: "timed out" })];
    const r = reportOf(results, { checkpoint: "c", benchmark: { version: "t" } });
    expect(r.latencyMs).toEqual({ p50: 40, p90: 40 });
    expect(r.errors).toBe(1);
  });

  it("takes percentiles by nearest rank", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(90);
  });
});

describe("what a walk offers", () => {
  it("keeps everything but the status bar, and an element whose place is not known", () => {
    const screen = { id: "s", app: "Settings", from: "t", elements: [...SETTINGS, el("0.8", "Cellular", "GenericElement", [312, 25, 22, 14]), el("0.7", "Return to Maps", "Button", [12, 37, 43, 13]), el("x", "No frame", "StaticText")] };
    expect(walkOffers(screen).map((e) => e.id)).toEqual(["0.0", "0.1", "0.2", "0.3", "0.4", "0.7", "x"]);
  });
});
