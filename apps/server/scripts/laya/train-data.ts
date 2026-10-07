/**
 * Writes the rows a training run reads: the generated training set, and the benchmark's `train` and
 * `validation` cases (calibration and epoch choice), each as JSONL of `{ kind, state, questions, targets }`.
 *
 *   pnpm --filter @realm/server exec tsx scripts/laya/train-data.ts <out dir> [seed]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundledLayaDir, loadBenchmark } from "../../src/laya/benchmark";
import { benchmarkRows, trainingSet, type Lexicon } from "../../src/laya/trainset";
import { HELDOUT_APPS, VALIDATION_APPS } from "./bench/screens";

const out = process.argv[2] ?? "/tmp/laya-train/data";
const dir = bundledLayaDir()!;
const b = loadBenchmark(join(dir, "benchmark"));
const lexicon = JSON.parse(readFileSync(join(dir, "lexicon.json"), "utf8")) as Lexicon;
const withBench = process.argv.includes("--with-benchmark-train");
const { rows, stats } = trainingSet(b, lexicon, { heldoutApps: HELDOUT_APPS, validationApps: VALIDATION_APPS, seed: Number(process.argv[3] ?? 7), ...(withBench ? { benchmarkTrain: ["sensitive", "verify"] as const } : {}) });
mkdirSync(out, { recursive: true });
const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
writeFileSync(join(out, "train.jsonl"), jsonl(rows));
const calib = benchmarkRows(b, ["train"]);
const valid = benchmarkRows(b, ["validation"]);
writeFileSync(join(out, "calib.jsonl"), jsonl(calib));
writeFileSync(join(out, "valid.jsonl"), jsonl(valid));
console.log(JSON.stringify({ ...stats, bySource: Object.fromEntries(["lexicon", "copy", "template", "pair", "log", "benchmark"].map((s) => [s, rows.filter((r) => r.source === s).length])), calib: calib.length, valid: valid.length }));
