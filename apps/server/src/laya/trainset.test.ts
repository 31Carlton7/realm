import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledLayaDir, contentWords, loadBenchmark, type Benchmark, type BenchElement } from "./benchmark";
import { SENSITIVE_PARTS, type ShadowRow } from "./shadow";
import { benchmarkRows, logRows, phrasesFor, trainingSet, type Lexicon, type TrainRow } from "./trainset";

/**
 * What a checkpoint learns from. What must die: a held-out app's screen or a benchmark case's intent
 * in the training set, an answer that is not the element it was generated for, a sensitive label on
 * the wrong part, and a step Laya chose taught back to it as the agent's.
 */

const dir = bundledLayaDir()!;
const bench = loadBenchmark(join(dir, "benchmark"));
const lexicon = JSON.parse(readFileSync(join(dir, "lexicon.json"), "utf8")) as Lexicon;
const manifest = JSON.parse(readFileSync(join(dir, "benchmark", "benchmark.json"), "utf8")) as { split: { heldoutApps: string[]; validationApps: string[] } };
const shipped = trainingSet(bench, lexicon, { heldoutApps: manifest.split.heldoutApps, validationApps: manifest.split.validationApps });

const goalOf = (r: TrainRow) => /^(?:Goal: )?(.*?)\.(?: What changed on screen:.*)?$/s.exec(r.state)?.[1] ?? r.state;

describe("the shipped training set", () => {
  it("has every kind of question in it", () => {
    expect(shipped.stats.target).toBeGreaterThan(1_000);
    expect(shipped.stats.sensitive).toBeGreaterThan(300);
    expect(shipped.stats.verify).toBeGreaterThan(100);
  });

  it("never shows a screen of a held-out or validation app", () => {
    const apps = new Set([...manifest.split.heldoutApps, ...manifest.split.validationApps]);
    const outside = new Set([...bench.screens.values()].filter((s) => apps.has(s.app)).flatMap((s) => s.elements.map((e) => e.label)).filter((l) => l.length > 12));
    // Labels only those apps have — a place on the map, a health measure, a contact.
    for (const label of ["Grace Cathedral", "Cardio Fitness", "Hank M. Zakroff, Financial Services Inc.", "Connect to Server", "Café Wi-Fi, WPA3 Personal"]) expect(outside.has(label)).toBe(true);
    const text = shipped.rows.map((r) => r.state + JSON.stringify(r.questions)).join("\n");
    for (const label of ["Grace Cathedral", "Cardio Fitness", "Hank M. Zakroff", "Connect to Server", "Café Wi-Fi"]) expect(text).not.toContain(label);
  });

  it("never asks a benchmark case's question, or one that nearly is", () => {
    const cases = [...bench.target, ...bench.sensitive, ...bench.verify].map((c) => new Set(contentWords(c.intent)));
    // Only a case sharing a word can be near a phrase: index the cases by word.
    const byWord = new Map<string, number[]>();
    cases.forEach((c, i) => { for (const w of c) byWord.set(w, [...(byWord.get(w) ?? []), i]); });
    let worst = 0;
    for (const r of shipped.rows) {
      const w = new Set(contentWords(goalOf(r)));
      for (const i of new Set([...w].flatMap((x) => byWord.get(x) ?? []))) {
        const c = cases[i]!;
        let both = 0;
        for (const x of w) if (c.has(x)) both++;
        worst = Math.max(worst, both / (w.size + c.size - both));
      }
    }
    expect(worst).toBeLessThan(0.75);
  });

  it("answers every target question with exactly one option", () => {
    for (const r of shipped.rows.filter((x) => x.kind === "target")) {
      expect(r.targets.target!.filter((t) => t === 1)).toHaveLength(1);
      expect(r.targets.target).toHaveLength(Object.keys((r.questions.target as { criteria: object }).criteria).length);
    }
  });
});

describe("generating from a screen", () => {
  const el = (id: string, label: string, role = "Button"): BenchElement => ({ id, role, label });
  function tiny(elements: BenchElement[], pairs: Benchmark["pairs"] = new Map()): Benchmark {
    return { version: "t", dir: "", apps: ["Settings"], screens: new Map([["s", { id: "s", app: "Settings", from: "t", elements }]]), pairs, target: [], sensitive: [], verify: [] };
  }
  const lex: Lexicon = { version: 1, labels: { General: ["check for a software update"], "Record Video": ["shoot in 4K"], Delete: ["trash it"] } };
  const rows = (b: Benchmark) => trainingSet(b, lex, { heldoutApps: [], validationApps: [] }).rows;

  it("asks each lexicon phrase over the shadow's candidates, the element it names the answer", () => {
    const r = rows(tiny([el("1", "Accessibility"), el("2", "General"), el("3", "Privacy")])).find((x) => x.state === "Goal: check for a software update.")!;
    const keys = Object.keys((r.questions.target as { criteria: object }).criteria);
    expect(keys).toEqual(["Accessibility", "General", "Privacy"]);
    expect(r.targets.target).toEqual([0, 1, 0]);
  });

  it("finds a label's phrases under its first part, and an app's own sense of it before the rest", () => {
    expect(phrasesFor(lex, "Record Video, 1080p at 30 fps")).toEqual(["shoot in 4K"]);
    expect(phrasesFor(lex, "Unknown")).toEqual([]);
    const scoped: Lexicon = { version: 1, labels: { Camera: ["video resolution"], "Messages:Camera": ["take a photo"] } };
    expect(phrasesFor(scoped, "Camera", "Messages")).toEqual(["take a photo"]);
    expect(phrasesFor(scoped, "Camera, 1", "Settings")).toEqual(["video resolution"]);
    expect(phrasesFor(scoped, "Camera")).toEqual(["video resolution"]);
  });

  it("labels a deletion on the delete part only, a typed secret on the secret part, and a keyboard's delete key on none", () => {
    const all = rows(tiny([el("1", "Delete"), el("2", "Message", "TextField"), el("k", "delete"), el("s", "shift")]));
    const sens = all.filter((r) => r.kind === "sensitive");
    const on = (r: TrainRow) => (Object.keys(SENSITIVE_PARTS) as (keyof typeof SENSITIVE_PARTS)[]).filter((p) => r.targets[p]![1] === 1);
    const deletes = sens.filter((r) => r.state.includes("button 'Delete'"));
    expect(deletes.length).toBeGreaterThan(3);
    for (const r of deletes) expect(on(r)).toEqual(["delete"]);
    const typed = sens.filter((r) => r.state.startsWith("An agent is about to: type into text field 'Message'"));
    expect(typed.some((r) => on(r).join() === "secret")).toBe(true);
    expect(typed.some((r) => on(r).length === 0)).toBe(true);
    const key = sens.filter((r) => r.state.includes("button 'delete'"));
    expect(key).toHaveLength(1);
    expect(on(key[0]!)).toEqual([]);
  });

  it("teaches a real step as done for its own goal and not for its neighbour's, and a screen that did not change as nothing done", () => {
    const before = [el("1", "General"), el("2", "Accessibility")];
    const after = [el("1", "About", "Button"), el("2", "Keyboard")];
    const b = tiny(before, new Map([["p", { id: "p", app: "Settings", tool: "simulator_tap", action: "tap", target: { id: "1", role: "Button", label: "General" }, before, after }]]));
    const v = rows(b).filter((r) => r.kind === "verify");
    const said = (goal: string) => v.filter((r) => r.state.startsWith(`Goal: ${goal}.`)).map((r) => r.targets.verify![1]);
    expect(said("check for a software update")).toContain(1);
    expect(v.filter((r) => r.state.includes("What changed on screen: No change on screen.")).every((r) => r.targets.verify![1] === 0)).toBe(true);
    expect(v.some((r) => r.targets.verify![1] === 0 && !r.state.includes("No change"))).toBe(true);
  });

  it("leaves out a step any split but train asks about", () => {
    const before = [el("1", "General")];
    const pair = { id: "p", app: "Settings", tool: "simulator_tap", action: "tap", target: { id: "1", role: "Button", label: "General" }, before, after: [el("1", "About")] };
    const b = tiny(before, new Map([["p", pair]]));
    b.verify.push({ id: "v", split: "heldout", app: "Settings", pair: "p", tool: "simulator_tap", intent: "open General", achieved: true, kind: "ok" });
    expect(rows(b).filter((r) => r.kind === "verify" && !r.state.includes("No change"))).toHaveLength(0);
  });
});

describe("the user's log", () => {
  const row = (over: Partial<ShadowRow> & { truth: ShadowRow["truth"] }): ShadowRow => ({
    v: 1, prompt: 2, id: "r", at: "2026-09-29T00:00:00Z", surface: "simulator", tool: "simulator_tap", spaceId: "s", sessionId: "x",
    intent: "open Wi-Fi", candidates: [{ id: "1", role: "Button", label: "Wi-Fi" }, { id: "2", role: "Button", label: "General" }],
    chosen: { id: "1" }, checkpoint: "english@55cf4c4", laya: { target: null, sensitive: null, verify: null, errors: [] }, baseline: { verify: null }, ...over,
  });
  const truth = (target: { id: string; source: "agent" | "laya" } | null, verify: ShadowRow["truth"]["verify"] = null): ShadowRow["truth"] =>
    ({ target, sensitive: { value: false, source: "rule", matched: null }, permission: null, verify });

  it("teaches a target the agent chose, never one Laya chose", () => {
    const rows = logRows([row({ truth: truth({ id: "1", source: "agent" }) }), row({ truth: truth({ id: "1", source: "laya" }) })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "target", source: "log", state: "Goal: open Wi-Fi.", targets: { target: [1, 0] } });
  });

  it("teaches verify from the next step's verdict, on the diff the shadow asked about", () => {
    const rows = logRows([row({
      truth: truth(null, { value: false, source: "heuristic", why: "the next step repeated it" }),
      laya: { target: null, sensitive: null, verify: { p: 0.9, confidence: 0.9, ms: 40, before: "", after: "", diff: "No change on screen." }, errors: [] },
    })]);
    expect(rows).toEqual([expect.objectContaining({ kind: "verify", state: "Goal: open Wi-Fi. What changed on screen: No change on screen.", targets: { verify: [1, 0] } })]);
  });
});

describe("the benchmark's own rows", () => {
  it("asks each split's cases as the evaluation does, and leaves out a target the candidates cannot answer", () => {
    const train = benchmarkRows(bench, ["train"]);
    const nTrain = bench.target.filter((c) => c.split === "train").length + bench.sensitive.filter((c) => c.split === "train").length + bench.verify.filter((c) => c.split === "train").length;
    expect(train.length).toBeLessThanOrEqual(nTrain);
    expect(train.length).toBeGreaterThan(nTrain * 0.9);
    const heldoutIntents = new Set(bench.target.filter((c) => c.split === "heldout").map((c) => `Goal: ${c.intent}.`));
    expect(train.some((r) => heldoutIntents.has(r.state))).toBe(false);
    for (const r of train.filter((x) => x.kind === "target")) expect(r.targets.target!.some((t) => t === 1)).toBe(true);
  });
});
