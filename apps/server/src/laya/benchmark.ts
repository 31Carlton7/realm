import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObservedElement } from "../mcp/act-observer";

/**
 * Laya's benchmark: real iOS screens read off a simulator, and labelled steps on them — what an agent
 * wanted and which element does it (`target`), whether a step is sensitive (`sensitive`), and whether
 * a step that was really taken did what it was for (`verify`). `resources/laya/benchmark/README.md`
 * says how it was made; `scripts/laya/bench-build.ts` builds it.
 *
 * Every evaluation of every checkpoint is scored on its `heldout` split, so two reports are comparable
 * only when they name the same `version`. Whole apps are held out as well as a share of every other
 * app's cases: a checkpoint trained on Settings is measured on apps it never saw.
 */
export const BENCHMARK_VERSION = "2026-09-29.1";

export type Split = "train" | "validation" | "heldout";
/** An element as the benchmark keeps it: what the shadow sees, and its frame for anyone who needs one. */
export type BenchElement = ObservedElement & { frame?: number[] };
export type BenchScreen = { id: string; app: string; from: string; elements: BenchElement[] };
export type BenchPair = { id: string; app: string; tool: string; action: string; target?: ObservedElement; before: BenchElement[]; after: BenchElement[] };

type CaseBase = { id: string; split: Split; app: string; intent: string };
/** `element` is right; so is any of `alsoRight` (one thing drawn twice). `copies`: the intent repeats a
 *  word of the element's label — the cases a walk resolves without asking Laya at all. */
export type TargetBenchCase = CaseBase & { screen: string; element: string; alsoRight?: string[]; copies: boolean };
export type SensitiveBenchCase = CaseBase & { screen: string; element: string; tool: string; sensitive: boolean; part: "money" | "delete" | "send" | "secret" | null };
export type VerifyBenchCase = CaseBase & { pair: string; tool: string; achieved: boolean; kind: string };

export type Benchmark = {
  version: string;
  dir: string;
  apps: string[];
  screens: Map<string, BenchScreen>;
  pairs: Map<string, BenchPair>;
  target: TargetBenchCase[];
  sensitive: SensitiveBenchCase[];
  verify: VerifyBenchCase[];
};

/** Reads a benchmark directory. Throws with the file it could not read: a benchmark with a hole in it
 *  would score a checkpoint on fewer cases than its report says. */
export function loadBenchmark(dir: string): Benchmark {
  const manifest = JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")) as { version: string; apps: string[] };
  const readDir = <T extends { id: string }>(sub: string): Map<string, T> =>
    new Map(readdirSync(join(dir, sub)).filter((f) => f.endsWith(".json")).map((f) => {
      const row = JSON.parse(readFileSync(join(dir, sub, f), "utf8")) as T;
      return [row.id, row];
    }));
  const readCases = <T>(name: string): T[] =>
    readFileSync(join(dir, "cases", `${name}.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
  const b: Benchmark = {
    version: manifest.version, dir, apps: manifest.apps,
    screens: readDir<BenchScreen>("screens"), pairs: readDir<BenchPair>("pairs"),
    target: readCases<TargetBenchCase>("target"), sensitive: readCases<SensitiveBenchCase>("sensitive"), verify: readCases<VerifyBenchCase>("verify"),
  };
  for (const c of [...b.target, ...b.sensitive]) if (!b.screens.has(c.screen)) throw new Error(`benchmark case ${c.id} names screen ${c.screen}, which is not in ${dir}`);
  for (const c of b.verify) if (!b.pairs.has(c.pair)) throw new Error(`benchmark case ${c.id} names pair ${c.pair}, which is not in ${dir}`);
  return b;
}

/**
 * Where Realm's Laya resources are: `REALM_LAYA_RESOURCES` (tests and scripts), then the repo's
 * `resources/laya` found by walking up from this module — `src/` under vitest and the one bundled
 * `dist/main.js` alike — then `<Resources>/laya` in a packaged app. Null when there are none.
 */
export function bundledLayaDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.REALM_LAYA_RESOURCES?.trim();
  if (override) return existsSync(override) ? override : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "resources", "laya"))) return join(dir, "resources", "laya");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? join(resources, "laya") : null;
  return packaged && existsSync(packaged) ? packaged : null;
}

const STOP = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "or", "my", "me", "this", "that", "it", "its", "is", "be",
  "with", "into", "from", "by", "as", "your", "i", "what", "how", "when", "where", "which", "who", "do", "does", "can", "all",
  "any", "so", "her", "his", "him", "she", "he", "they", "them", "their", "our", "we", "you", "up", "out", "off", "about", "only",
]);

function wordsOf(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Two words are the same word when one is the other with an inflection on: "share" and "sharing",
 *  "photo" and "photos", "rest" and "resting" — a shared start that leaves at most three letters over. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const one = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  if (one(a) === one(b)) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  let n = 0;
  while (n < shorter && a[n] === b[n]) n++;
  return n >= Math.max(4, shorter - 3);
}

/** Whether an intent repeats a word of a label (see `TargetBenchCase.copies`). */
export function labelCopies(intent: string, label: string): boolean {
  const have = wordsOf(label);
  return wordsOf(intent).some((w) => have.some((h) => sameWord(w, h)));
}

/** A case's split: its app's, when the app is held out or kept for validation whole; otherwise a
 *  stable draw on the case's key, so rebuilding the benchmark never moves a case between splits. */
export function splitOf(app: string, key: string, o: { heldoutApps: string[]; validationApps: string[]; heldoutShare: number; validationShare: number }): Split {
  if (o.heldoutApps.includes(app)) return "heldout";
  if (o.validationApps.includes(app)) return "validation";
  const u = fnv1a(key) / 2 ** 32;
  return u < o.heldoutShare ? "heldout" : u < o.heldoutShare + o.validationShare ? "validation" : "train";
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(s, "utf8")) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
