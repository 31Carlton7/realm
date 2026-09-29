import type { ObservedElement } from "../mcp/act-observer";
import { contentWords, type BenchElement, type BenchPair, type BenchScreen, type Benchmark, type Split } from "./benchmark";
import type { LayaQuestion } from "./client";
import { walkOffers } from "./eval";
import { SENSITIVE_PARTS, pickCandidates, sensitiveQuestion, screenDiff, targetQuestion, verifyQuestion, verifyQuestionFor, type SensitivePart, type ShadowRow } from "./shadow";

/**
 * What a checkpoint is trained on: questions asked exactly as the shadow asks them, with the answer
 * each should get, generated from the benchmark's screens and a lexicon of what people call things.
 *
 * Only `train` apps' screens are used — no screen of a held-out or validation app, whole — and no
 * generated question is ever one of the benchmark's cases: an intent that is, or nearly is, any
 * case's intent (in any split) is dropped. The benchmark's own `train` `target` cases fit the Assist
 * threshold and the choice temperatures, so they stay unseen; its `train` `sensitive` and `verify`
 * cases may be taught as they are (`benchmarkTrain`), and nothing of `validation` or `heldout` is.
 *
 *  - `target`: every phrase the lexicon has for an element, on every screen the element is on, over
 *    the candidates the shadow would offer with that element chosen; plus the element's own label now
 *    and then, so a copy still reads as one.
 *  - `sensitive`: the four parts, each labelled, for taps on what deletes, sends, pays or subscribes
 *    and for typing secrets — and for the hard negatives, the steps whose words sound sensitive and
 *    are not (a Passwords pane, a search field's clear button, a keyboard's delete key).
 *  - `verify`: real steps from the benchmark's pairs — the goal the step met, goals it did not (another
 *    row on the same screen), and a screen that did not change at all.
 *  - the user's own decision log, when there is one: each step an agent chose (never one Laya chose)
 *    and each step whose next step said whether it worked.
 */

export type TrainRow = {
  kind: "target" | "sensitive" | "verify";
  source: "lexicon" | "copy" | "template" | "pair" | "log" | "benchmark";
  state: string;
  questions: Record<string, LayaQuestion>;
  /** Per question, the answer distribution in option order: a choice's options, or noul's [no, yes]. */
  targets: Record<string, number[]>;
};

export type Lexicon = { version: number; labels: Record<string, string[]> };

export type TrainSetOptions = {
  heldoutApps: readonly string[];
  validationApps: readonly string[];
  log?: readonly ShadowRow[];
  seed?: number;
  /** The benchmark's own `train` cases of these kinds, taught as labelled. Never `target`: its train
   *  split is what the Assist threshold and the choice temperatures are fitted on, unseen. */
  benchmarkTrain?: readonly ("sensitive" | "verify")[];
};

export type TrainSetStats = { rows: number; target: number; sensitive: number; verify: number; fromLog: number; dropped: number; screens: number };

const WALK_TOOL = "simulator_tap";
const TYPE_TOOL = "simulator_type";
const PARTS = Object.keys(SENSITIVE_PARTS) as SensitivePart[];
const FIELD = /text ?field|search ?field|text ?view|text ?area|secure/i;

export function trainingSet(b: Benchmark, lexicon: Lexicon, o: TrainSetOptions): { rows: TrainRow[]; stats: TrainSetStats } {
  const random = mulberry32(o.seed ?? 7);
  const outside = new Set([...o.heldoutApps, ...o.validationApps]);
  const screens = trainScreens(b, outside);
  const pairs = [...b.pairs.values()].filter((p) => !outside.has(p.app) && trainOnly(b, p.id) && !failedPair(b, p.id));
  const guard = new Guard([...b.target, ...b.sensitive, ...b.verify].map((c) => c.intent));
  const rows: TrainRow[] = [];

  for (const screen of screens) rows.push(...targetRows(screen, lexicon, guard, random));
  for (const screen of screens) rows.push(...sensitiveRows(screen, lexicon, guard, random));
  for (const pair of pairs) rows.push(...verifyRows(pair, lexicon, guard, random));
  for (const screen of screens) rows.push(...unchangedRows(screen, lexicon, guard, random));
  const fromLog = o.log ? logRows(o.log) : [];
  rows.push(...fromLog);
  const kinds = o.benchmarkTrain ?? [];
  if (kinds.length) rows.push(...benchmarkRows(b, ["train"]).filter((r) => (kinds as readonly string[]).includes(r.kind)).map((r) => ({ ...r, source: "benchmark" as const })));

  shuffle(rows, random);
  const count = (k: TrainRow["kind"]) => rows.filter((r) => r.kind === k).length;
  return { rows, stats: { rows: rows.length, target: count("target"), sensitive: count("sensitive"), verify: count("verify"), fromLog: fromLog.length, dropped: guard.dropped, screens: screens.length } };
}

/** Every screen of the apps training may see: the benchmark's screens, and both sides of its pairs,
 *  each distinct set of labels once. */
function trainScreens(b: Benchmark, outside: ReadonlySet<string>): BenchScreen[] {
  const seen = new Set<string>();
  const out: BenchScreen[] = [];
  const take = (s: BenchScreen) => {
    if (outside.has(s.app)) return;
    const sig = s.elements.map((e) => `${e.role}|${e.label}`).join("\n");
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push(s);
  };
  for (const s of b.screens.values()) take(s);
  for (const p of b.pairs.values()) {
    take({ id: `${p.id}#before`, app: p.app, from: p.id, elements: p.before });
    take({ id: `${p.id}#after`, app: p.app, from: p.id, elements: p.after });
  }
  return out;
}

/** A step whose every case is a `train` case: a step any other split asks about is not trained on. */
function trainOnly(b: Benchmark, pairId: string): boolean {
  return b.verify.every((c) => c.pair !== pairId || c.split === "train");
}

/** A step the benchmark says went wrong: its target's own goal did not happen, so the pair cannot
 *  vouch for what tapping that element does. */
function failedPair(b: Benchmark, pairId: string): boolean {
  return b.verify.some((c) => c.pair === pairId && !c.achieved && c.kind !== "wrong-screen");
}

/* ---------------------------------- target ---------------------------------- */

function targetRows(screen: BenchScreen, lexicon: Lexicon, guard: Guard, random: () => number): TrainRow[] {
  const offered = walkOffers(screen).map(observed);
  const rows: TrainRow[] = [];
  for (const e of offered) {
    if (!e.label.trim()) continue;
    for (const phrase of phrasesFor(lexicon, e.label, screen.app)) {
      if (!guard.allows(phrase)) continue;
      rows.push(targetRow(offered, e, phrase, "lexicon"));
    }
    // The label itself, now and then: a goal that names the element is still a goal.
    if (random() < 0.25) {
      const copy = pick(random, [primary(e.label), `open ${primary(e.label)}`, `tap ${primary(e.label)}`, `go to ${primary(e.label)}`]);
      if (guard.allows(copy)) rows.push(targetRow(offered, e, copy, "copy"));
    }
  }
  return rows;
}

function targetRow(elements: readonly ObservedElement[], chosen: ObservedElement, goal: string, source: TrainRow["source"]): TrainRow {
  const candidates = pickCandidates(elements, chosen, goal);
  const q = targetQuestion(goal, candidates, WALK_TOOL);
  const keys = Object.keys(q.questions.target.criteria);
  return { kind: "target", source, state: q.state, questions: q.questions, targets: { target: keys.map((k) => (q.idOf.get(k) === chosen.id ? 1 : 0)) } };
}

/* ---------------------------------- sensitive ---------------------------------- */

type Act = { test: RegExp; parts: SensitivePart[]; intents: string[] };

/** Taps that do one of the four things when that is what they are for. */
const SENSITIVE_TAPS: Act[] = [
  { test: /^(delete( photo| contact| list)?|remove\b.*|discard changes|clear history( and website data)?)$/i, parts: ["delete"], intents: ["delete it for good", "erase this", "get rid of it", "confirm the deletion", "throw it away", "wipe it out", "permanently remove the item", "trash the whole thing", "yes, remove everything"] },
  { test: /^send$/i, parts: ["send"], intents: ["send what I wrote", "reply to them", "text them back", "deliver the note", "send my answer", "fire off the message", "let my boss know I'm sick", "answer the group chat", "send the directions to Sam"] },
  { test: /^share$/i, parts: ["send"], intents: ["send this to my brother", "post it to my feed", "email it to a coworker", "AirDrop it to the laptop next to me", "share it on social media", "text the link to my wife"] },
  { test: /^apple cash$/i, parts: ["money", "send"], intents: ["send $25 to them", "pay them back for lunch", "transfer money to a friend", "chip in for the gift", "pay my half of the taxi"] },
  { test: /^(try news\+ free|try 1 month free|get)$/i, parts: ["money"], intents: ["start the paid subscription", "sign up for the trial that renews monthly", "subscribe to the premium plan", "buy the upgrade", "confirm the monthly plan"] },
];

/** Labels that sound like one of the four and, opened or looked at, are not. */
const LOOKALIKE = /password|passkey|deleted|share sheet|sharing|shared|blocked|clear text|delete after use|payment|purchase|send|remove|erase|reset/i;

/** A secret typed into any field is sensitive; ordinary text is not. The values are made up. */
const SECRET_TYPING = ["enter the password Tr0ub4dor&3", "type my PIN 4921", "paste the one-time code 830142", "type my social security number 078-05-1120", "enter the card number 4000 0566 5566 5556", "put in the API key sk-test-51Hx", "type the Wi-Fi password correcthorse", "enter my bank password"];
const PLAIN_TYPING = ["type coffee shops near me", "enter the name Jordan", "write buy milk", "search for weather tomorrow", "type the address jordan@example.com", "enter the title Team sync", "type hello there"];

function sensitiveRows(screen: BenchScreen, lexicon: Lexicon, guard: Guard, random: () => number): TrainRow[] {
  const rows: TrainRow[] = [];
  const els = screen.elements.map(observed);
  const keyboard = els.some((e) => e.label === "shift");
  for (const e of els) {
    const label = e.label.trim();
    if (FIELD.test(e.role)) {
      for (const intent of sample(random, SECRET_TYPING, 2)) rows.push(sensitiveRow(TYPE_TOOL, e, intent, ["secret"]));
      for (const intent of sample(random, PLAIN_TYPING, 1)) rows.push(sensitiveRow(TYPE_TOOL, e, intent, []));
    }
    if (!label) continue;
    // A keyboard's delete key takes back one letter.
    if (keyboard && label === "delete") {
      rows.push(sensitiveRow(WALK_TOOL, e, "delete the letter I just typed", []));
      continue;
    }
    const act = SENSITIVE_TAPS.find((a) => a.test.test(label));
    if (act) {
      // Every phrasing: these elements are few, and a sensitive step is the one not to miss.
      for (const intent of act.intents) if (guard.allows(intent)) rows.push(sensitiveRow(WALK_TOOL, e, intent, act.parts));
      continue;
    }
    if (LOOKALIKE.test(label)) {
      for (const intent of [`open ${primary(label)}`, `look at ${primary(label)}`]) if (guard.allows(intent)) rows.push(sensitiveRow(WALK_TOOL, e, intent, []));
      continue;
    }
    const phrases = phrasesFor(lexicon, label, screen.app).filter((p) => guard.allows(p));
    if (phrases.length && random() < 0.5) rows.push(sensitiveRow(WALK_TOOL, e, pick(random, phrases), []));
  }
  return rows;
}

function sensitiveRow(tool: string, e: ObservedElement, intent: string, parts: SensitivePart[]): TrainRow {
  const q = sensitiveQuestion(tool, { element: e }, intent);
  return { kind: "sensitive", source: "template", state: q.state, questions: q.questions, targets: Object.fromEntries(PARTS.map((p) => [p, parts.includes(p) ? [0, 1] : [1, 0]])) };
}

/* ---------------------------------- verify ---------------------------------- */

function verifyRows(pair: BenchPair, lexicon: Lexicon, guard: Guard, random: () => number): TrainRow[] {
  const target = pair.target;
  if (!target?.label.trim()) return [];
  const before = pair.before.map(observed);
  const after = pair.after.map(observed);
  const diff = screenDiff(before, after);
  const goals = (label: string) => [...phrasesFor(lexicon, label, pair.app), `tap ${primary(label)}`].filter((g) => guard.allows(g));
  const rows: TrainRow[] = [];
  const own = sample(random, goals(target.label), 4);
  if (!diff.changed || diff.alert) {
    for (const g of own) rows.push(verifyRow(g, before, after, false));
    return rows;
  }
  for (const g of own) rows.push(verifyRow(g, before, after, true));
  // What the same step did not do: another row that was on the screen when it was taken.
  const others = before.filter((e) => e.label.trim() && e.label !== target.label && /button|cell|link|tab|radio|check ?box|switch/i.test(e.role));
  for (const other of sample(random, others, 3)) {
    const g = sample(random, goals(other.label), 1)[0];
    if (g) rows.push(verifyRow(g, before, after, false));
  }
  return rows;
}

/** A screen that did not change is a step that did nothing, whatever it was for. */
function unchangedRows(screen: BenchScreen, lexicon: Lexicon, guard: Guard, random: () => number): TrainRow[] {
  const els = screen.elements.map(observed);
  const named = els.filter((e) => e.label.trim() && phrasesFor(lexicon, e.label, screen.app).length);
  const e = named.length ? pick(random, named) : null;
  if (!e) return [];
  const g = pick(random, phrasesFor(lexicon, e.label, screen.app));
  return guard.allows(g) ? [verifyRow(g, els, els, false)] : [];
}

function verifyRow(goal: string, before: readonly ObservedElement[], after: readonly ObservedElement[], achieved: boolean): TrainRow {
  const q = verifyQuestion(goal, before, after);
  return { kind: "verify", source: "pair", state: q.state, questions: q.questions, targets: { verify: achieved ? [0, 1] : [1, 0] } };
}

/* ---------------------------------- the benchmark, as rows ---------------------------------- */

/**
 * The benchmark's own cases of the given splits as rows — `train` to fit temperatures on, `validation`
 * to choose between epochs by. Never trained on. `target` is asked as Assist asks it, nothing chosen; a
 * case whose right element the candidate rule leaves out has no right option, and is left out.
 */
export function benchmarkRows(b: Benchmark, splits: readonly Split[]): TrainRow[] {
  const rows: TrainRow[] = [];
  for (const c of b.target) {
    if (!splits.includes(c.split)) continue;
    const elements = walkOffers(b.screens.get(c.screen)!).map(observed);
    const q = targetQuestion(c.intent, pickCandidates(elements, null, c.intent), WALK_TOOL);
    const right = new Set([c.element, ...(c.alsoRight ?? [])]);
    const target = Object.keys(q.questions.target.criteria).map((k) => (right.has(q.idOf.get(k) ?? "") ? 1 : 0));
    if (target.some((t) => t > 0)) rows.push({ kind: "target", source: "template", state: q.state, questions: q.questions, targets: { target } });
  }
  for (const c of b.sensitive) {
    if (!splits.includes(c.split)) continue;
    const e = observed(b.screens.get(c.screen)!.elements.find((x) => x.id === c.element)!);
    rows.push(sensitiveRow(c.tool, e, c.intent, c.part ? [c.part] : []));
  }
  for (const c of b.verify) {
    if (!splits.includes(c.split)) continue;
    const p = b.pairs.get(c.pair)!;
    rows.push(verifyRow(c.intent, p.before.map(observed), p.after.map(observed), c.achieved));
  }
  return rows;
}

/* ---------------------------------- the user's log ---------------------------------- */

/**
 * The user's own steps, asked again exactly as they were logged. A target the agent chose is taught
 * as right; one Laya chose never is (it would teach Laya its own guesses). `verify` is taught only when
 * the next step said whether this one worked, and only on the diff the shadow asked about.
 */
export function logRows(log: readonly ShadowRow[]): TrainRow[] {
  const rows: TrainRow[] = [];
  for (const r of log) {
    if (r.truth.target?.source === "agent" && r.intent && r.candidates.some((c) => c.id === r.truth.target!.id)) {
      const q = targetQuestion(r.intent, r.candidates, r.tool);
      const keys = Object.keys(q.questions.target.criteria);
      rows.push({ kind: "target", source: "log", state: q.state, questions: q.questions, targets: { target: keys.map((k) => (q.idOf.get(k) === r.truth.target!.id ? 1 : 0)) } });
    }
    if (r.truth.verify && r.laya.verify?.diff && r.intent) {
      const q = verifyQuestionFor(r.intent, r.laya.verify.diff);
      rows.push({ kind: "verify", source: "log", state: q.state, questions: q.questions, targets: { verify: r.truth.verify.value ? [0, 1] : [1, 0] } });
    }
  }
  return rows;
}

/* ---------------------------------- helpers ---------------------------------- */

/** Keeps the benchmark out of training: a phrase is refused when its words are, or nearly are, the
 *  words of any case's intent — the same set, or three quarters of the two together. */
class Guard {
  private readonly cases: Set<string>[];
  dropped = 0;
  constructor(intents: readonly string[]) {
    this.cases = intents.map((i) => new Set(contentWords(i)));
  }
  allows(phrase: string): boolean {
    const w = new Set(contentWords(phrase));
    if (w.size === 0) return false;
    for (const c of this.cases) {
      let both = 0;
      for (const x of w) if (c.has(x)) both++;
      const either = w.size + c.size - both;
      if (either > 0 && both / either >= 0.75) { this.dropped++; return false; }
    }
    return true;
  }
}

/** The lexicon's phrases for a label: under the label itself, and under its first part — "Record
 *  Video, 1080p at 30 fps" is "Record Video". An entry for `App:Label` is that app's own sense of the
 *  label and stands instead: Messages' Camera takes a photo, Settings' Camera is its settings. */
export function phrasesFor(lexicon: Lexicon, label: string, app?: string): string[] {
  const tidy = label.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim();
  const scoped = app ? lexicon.labels[`${app}:${tidy}`] ?? lexicon.labels[`${app}:${primary(tidy)}`] : undefined;
  return scoped ?? lexicon.labels[tidy] ?? lexicon.labels[primary(tidy)] ?? [];
}

function primary(label: string): string {
  return label.replace(/\uFFFC/g, "").split(", ")[0]!.trim();
}

const observed = ({ frame: _frame, ...e }: BenchElement): ObservedElement => e;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, xs: readonly T[]): T {
  return xs[Math.floor(random() * xs.length)]!;
}

function sample<T>(random: () => number, xs: readonly T[], n: number): T[] {
  const copy = [...xs];
  shuffle(copy, random);
  return copy.slice(0, n);
}

function shuffle<T>(xs: T[], random: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
}
