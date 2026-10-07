/**
 * Scores one Laya checkpoint on the benchmark, through a real laya-serve started the way Realm starts
 * it (`realLayaRuntime`, 127.0.0.1, a per-start key), and writes its report.
 *
 *   REALM_LAYA_VENV=<venv with laya[serve]> REALM_LAYA_HF_HOME=<HF cache> \
 *     pnpm --filter @realm/server exec tsx scripts/laya/eval.ts --checkpoint base|typed|<dir> --out <eval.json> [--name <label>] [--results <cases.jsonl>] [--bench <dir>]
 *
 * `base` is the pinned download Realm installs; `typed` is convaiinnovations/laya-typed-decisions from
 * the same cache; a directory is a checkpoint a training run wrote. Every question is asked as the
 * shadow asks it (`src/laya/eval.ts`). Nothing is downloaded: the server runs with HF_HUB_OFFLINE=1.
 * `--bench` scores a benchmark directory of the same shape other than the one Realm ships — one built
 * on this Mac from its own recordings, say, which never leaves it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LayaEvalReportSchema } from "@realm/contracts";
import { bundledLayaDir, loadBenchmark } from "../../src/laya/benchmark";
import { LAYA_CHECKPOINT, LayaClient } from "../../src/laya/client";
import { evaluate, reportOf } from "../../src/laya/eval";
import { realLayaRuntime } from "../../src/laya/runtime";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const which = args.get("checkpoint") ?? "base";
const out = args.get("out");
if (!out) throw new Error("--out <file> is required");
const hf = process.env.REALM_LAYA_HF_HOME;
if (!process.env.REALM_LAYA_VENV || !hf) throw new Error("set REALM_LAYA_VENV and REALM_LAYA_HF_HOME: this never installs or downloads");

function snapshot(repo: string): string {
  const root = join(hf!, "hub", `models--${repo.replace("/", "--")}`, "snapshots");
  const [sha] = readdirSync(root);
  if (!sha) throw new Error(`${repo} is not in ${hf}`);
  return join(root, sha);
}
const checkpoint = which === "base" ? undefined : which === "typed" ? snapshot("convaiinnovations/laya-typed-decisions") : which;

const dir = bundledLayaDir();
if (!dir) throw new Error("no resources/laya found");
const bench = loadBenchmark(args.get("bench") || join(dir, "benchmark"));
const home = mkdtempSync("/tmp/laya-train/home/eval-");
const rt = realLayaRuntime({ home, env: process.env });
const port = await rt.freePort();
const apiKey = randomBytes(24).toString("base64url");
const proc = rt.start({ port, apiKey, ...(checkpoint ? { checkpoint } : {}) });
let exited = false;
void proc.exited.then((e) => { exited = true; if (e.code) console.error(e.output.slice(-2000)); });
const client = new LayaClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey });

try {
  const t0 = Date.now();
  let revision: string | null = null;
  for (;;) {
    if (exited) throw new Error("laya-serve exited before it was ready");
    if (Date.now() - t0 > 240_000) throw new Error("laya-serve was not ready within 4 minutes");
    try {
      const h = await client.health(2_000);
      if (h.loaded.includes(LAYA_CHECKPOINT)) { revision = h.revisions[LAYA_CHECKPOINT] ?? null; console.log(`ready in ${Math.round((Date.now() - t0) / 1000)} s on ${h.checkpoint_devices[LAYA_CHECKPOINT] ?? h.device}`); break; }
    } catch { /* still loading */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const name = args.get("name") ?? (checkpoint ? `local:${basename(checkpoint)}` : `${LAYA_CHECKPOINT}@${revision ? revision.slice(0, 7) : "unpinned"}`);
  // One throwaway question of each shape, as the service warms up, so no case pays for the kernels.
  const warm = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Option ${i + 1}`, "button"]));
  await client.ask("Goal: warm up.", { target: { type: "choice", instructions: "Which on-screen element should be used to: warm up?", criteria: warm }, check: { type: "noul", instructions: "Is this a test?" } }, 30_000, false);

  let last = 0;
  const results = await evaluate(bench, (state, questions) => client.ask(state, questions, 10_000), {
    splits: { target: ["train", "validation", "heldout"], sensitive: ["train", "validation", "heldout"], verify: ["train", "validation", "heldout"] },
    onProgress: (done, total) => { if (done - last >= 100 || done === total) { last = done; console.log(`${done}/${total}`); } },
  });
  const report = LayaEvalReportSchema.parse(reportOf(results, { checkpoint: name, benchmark: bench }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  const resultsOut = args.get("results");
  if (resultsOut) writeFileSync(resultsOut, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`${name}: target ${pct(report.target.accuracy)} (n ${report.target.n}), not copying ${pct(report.target.notCopying!.accuracy)}, candidates ${pct(report.target.candidateRecall!)}, assist threshold ${report.target.assist.threshold} → ${pct(report.target.assist.precision)} precision at ${pct(report.target.assist.coverage)} coverage`);
  console.log(`sensitive ${pct(report.sensitive.accuracy)} recall ${pct(report.sensitive.recall)} (rule ${pct(report.baseline.sensitiveRule.accuracy)}/${pct(report.baseline.sensitiveRule.recall)}); verify ${pct(report.verify.accuracy)} (rule ${pct(report.baseline.verifyRule.accuracy)}); p50 ${report.latencyMs.p50} ms`);
  console.log(`wrote ${out}`);
} finally {
  await proc.stop();
}
