import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { LayaEvalReportSchema, type LayaEvalReport, type LayaTrainStep } from "@realm/contracts";
import { loadBenchmark, type BenchScreen } from "./benchmark";
import { LAYA_CHECKPOINT, LayaClient } from "./client";
import { REPORT_SPLITS, evaluate, reportOf } from "./eval";
import type { LayaRuntime } from "./runtime";
import type { ShadowRow } from "./shadow";
import { benchmarkRows, trainingSet, type Lexicon } from "./trainset";

/**
 * One training run, start to finish: write what it learns from, run the shipped script in the user's
 * venv, then score what it wrote on the benchmark through laya-serve — the same server and the same
 * questions as any other evaluation — and put the report beside it as `eval.json`.
 *
 * Deciding whether the new checkpoint replaces the active one is not this module's business: it
 * hands back the report and the service compares (`beats`).
 */

export type TrainProgress = { step: LayaTrainStep; detail: string; fraction: number | null };

export type TrainerDeps = {
  runtime: LayaRuntime;
  /** `resources/laya` — `train.py`, `lexicon.json`, `benchmark/`. */
  resources: string;
  /** Screens kept while a person used an app (`LayaRecorder.screens`), learned from as training
   *  screens. Never scored on: the benchmark stays what every checkpoint is measured by. */
  recorded?: () => BenchScreen[];
  /** Every decision log file, newest first (`DecisionLog.files`). */
  logFiles: () => string[];
  fetchImpl?: typeof fetch;
  /** How long a freshly written checkpoint may take to answer `/health`. */
  startupMs?: number;
  /** This Mac's memory pressure and the disk's free space (`machineState`), read before a run and
   *  every `watchMs` during it. Absent, a run is not guarded — tests that are not about it. */
  machine?: () => Promise<MachineState>;
  watchMs?: number;
};

/** What a training run needs of the Mac it runs on, as the kernel and the disk report it. */
export type MachineState = { pressure: "normal" | "warn" | "critical"; freeDiskBytes: number };

/**
 * Room for macOS to swap. MEASURED: a run started with 3 GB free hung a 24 GB Mac 2½ minutes in — the
 * kernel's compressor at its segment limit "with LOW swap space", then a watchdog panic and a reboot.
 */
export const MIN_FREE_DISK = 8 * 1024 ** 3;
/**
 * The free space a run is stopped under once it is going: swap grows with the run, onto this disk.
 * MEASURED on 2026-10-01: a run's swap passed 20 GB and took this Mac's disk from 6 GB free to 4 GB in
 * two minutes; the hang the run before it came at about 3 GB.
 */
export const RUN_MIN_FREE_DISK = 4 * 1024 ** 3;
/** Critical readings in a row that stop a run: one is a spike, three are the start of a hang. */
const CRITICAL_READINGS = 3;
const WATCH_MS = 5_000;
/** A step's examples, and the steps whose gradients are summed: 4 × 4 is the 16 that 8 × 2 was, with
 *  half the memory held at once — the margin a Mac in use needs. */
const BATCH = ["--batch", "4", "--accum", "4"];

/** The kernel's own reading of memory pressure, and the free space on `dir`'s disk. */
export async function machineState(dir: string): Promise<MachineState> {
  const level = await new Promise<string>((resolve) => {
    execFile("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 5_000 }, (_e, out) => resolve(String(out ?? "").trim()));
  });
  const fs = await statfs(dir);
  // 1 normal, 2 warn, 4 critical (`sysctl kern.memorystatus_vm_pressure_level`).
  return { pressure: level === "4" ? "critical" : level === "2" ? "warn" : "normal", freeDiskBytes: Number(fs.bavail) * Number(fs.bsize) };
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export type TrainResult = { name: string; dir: string; report: LayaEvalReport };

/** `x` with every string's lone surrogates replaced: half an emoji from anywhere — an app's own label,
 *  a log row — is text train.py's tokenizer refuses, and it refuses the whole run for one. */
export function wellFormed<T>(x: T): T {
  if (typeof x === "string") return whole(x) as T;
  if (Array.isArray(x)) return x.map(wellFormed) as T;
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [whole(k), wellFormed(v)])) as T;
  return x;
}

/** Half an emoji: a high surrogate with no low after it, or a low with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const whole = (s: string): string => s.replace(LONE_SURROGATE, "�");

/** The label a checkpoint trained here is served and logged under. */
export const localCheckpointLabel = (name: string): string => `local:${name}`;

export async function trainCheckpoint(d: TrainerDeps, o: { name: string; signal: AbortSignal; onProgress: (p: TrainProgress) => void }): Promise<TrainResult> {
  const rt = d.runtime;
  const base = rt.baseCheckpoint();
  if (!base) throw new Error("The downloaded checkpoint is not on disk to train from. Install Laya again.");
  const bench = loadBenchmark(join(d.resources, "benchmark"));
  const manifest = JSON.parse(readFileSync(join(d.resources, "benchmark", "benchmark.json"), "utf8")) as { split: { heldoutApps: string[]; validationApps: string[] } };
  const lexicon = JSON.parse(readFileSync(join(d.resources, "lexicon.json"), "utf8")) as Lexicon;

  // Before anything is written: a run that would hang the Mac is not started.
  const m = await d.machine?.();
  if (m?.pressure === "critical") throw new Error("This Mac is short of memory right now, and training needs several gigabytes of it. Close what you can and train again.");
  if (m && m.freeDiskBytes < MIN_FREE_DISK) throw new Error(`Training needs ${gb(MIN_FREE_DISK)} free on this disk, so macOS has room to swap while it runs, and there is ${gb(m.freeDiskBytes)}.`);

  o.onProgress({ step: "preparing", detail: "Writing the training set", fraction: null });
  const work = join(rt.dir, "train", o.name);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const { rows, stats } = trainingSet(bench, lexicon, { heldoutApps: manifest.split.heldoutApps, validationApps: manifest.split.validationApps, log: readLog(d.logFiles()), recorded: d.recorded?.() ?? [] });
  const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(wellFormed(x))).join("\n") + "\n";
  writeFileSync(join(work, "train.jsonl"), jsonl(rows));
  writeFileSync(join(work, "calib.jsonl"), jsonl(benchmarkRows(bench, ["train"])));
  writeFileSync(join(work, "valid.jsonl"), jsonl(benchmarkRows(bench, ["validation"])));

  const dir = join(rt.checkpointsDir, o.name);
  mkdirSync(rt.checkpointsDir, { recursive: true, mode: 0o700 });
  o.onProgress({ step: "training", detail: `Training on ${stats.rows.toLocaleString()} questions${stats.fromLog ? `, ${stats.fromLog.toLocaleString()} of them from your log` : ""}`, fraction: 0 });
  // Watched while it runs: pressure that stays critical, or a disk swap is filling, stops the run before
  // the Mac hangs. What stopped it is what the person is told.
  const run = new AbortController();
  const stopWith = () => run.abort();
  o.signal.addEventListener("abort", stopWith);
  let critical = 0;
  let starved = null as string | null;
  const watch = d.machine ? setInterval(() => {
    void d.machine!().then((now) => {
      if (run.signal.aborted) return;
      critical = now.pressure === "critical" ? critical + 1 : 0;
      if (critical >= CRITICAL_READINGS) starved = "Stopped: this Mac ran short of memory while training, so the run was ended before it could hang. Nothing it made was kept. Close what you can and train again.";
      else if (now.freeDiskBytes < RUN_MIN_FREE_DISK) starved = `Stopped: this Mac's disk was down to ${gb(now.freeDiskBytes)} free while training, and macOS swaps onto it, so the run was ended before it could hang. Nothing it made was kept. Free up some space and train again.`;
      if (starved) run.abort();
    }, () => {});
  }, d.watchMs ?? WATCH_MS) : null;
  try {
    await rt.runScript({
      script: join(d.resources, "train.py"),
      args: ["--base", base, "--train", join(work, "train.jsonl"), "--calib", join(work, "calib.jsonl"), "--valid", join(work, "valid.jsonl"), "--out", dir, ...BATCH],
      signal: run.signal,
      onLine: (line) => {
        const p = progressOf(line);
        if (p) o.onProgress(p);
      },
    });
  } catch (e) {
    if (starved) throw new Error(starved);
    throw e;
  } finally {
    if (watch) clearInterval(watch);
    o.signal.removeEventListener("abort", stopWith);
  }
  if (starved) throw new Error(starved);

  o.onProgress({ step: "evaluating", detail: "Loading the new checkpoint", fraction: null });
  const report = await evaluateCheckpoint(d, { dir, checkpoint: localCheckpointLabel(o.name), signal: o.signal, onProgress: o.onProgress });
  writeFileSync(join(dir, "eval.json"), JSON.stringify(report, null, 2) + "\n");
  return { name: o.name, dir, report };
}

/** Scores a checkpoint directory on the benchmark through its own laya-serve, then stops it. */
export async function evaluateCheckpoint(d: TrainerDeps, o: { dir: string; checkpoint: string; signal: AbortSignal; onProgress: (p: TrainProgress) => void }): Promise<LayaEvalReport> {
  const rt = d.runtime;
  const bench = loadBenchmark(join(d.resources, "benchmark"));
  const port = await rt.freePort();
  const apiKey = randomBytes(24).toString("base64url");
  const proc = rt.start({ port, apiKey, checkpoint: o.dir });
  let gone: string | null = null;
  void proc.exited.then((e) => { gone = e.output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? `laya-serve exited with ${e.signal ?? `code ${e.code}`}`; });
  const client = new LayaClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey, fetchImpl: d.fetchImpl });
  try {
    const deadline = Date.now() + (d.startupMs ?? 180_000);
    for (;;) {
      if (o.signal.aborted) throw new Error("Stopped.");
      if (gone) throw new Error(`The new checkpoint did not load: ${gone}`);
      if (Date.now() > deadline) throw new Error("The new checkpoint did not load within three minutes.");
      try {
        if ((await client.health(2_000)).loaded.includes(LAYA_CHECKPOINT)) break;
      } catch { /* still loading */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const results = await evaluate(bench, (state, questions) => client.ask(state, questions, 10_000), {
      splits: REPORT_SPLITS,
      signal: o.signal,
      onProgress: (done, total) => o.onProgress({ step: "evaluating", detail: `Scoring it on the benchmark: ${done} of ${total}`, fraction: done / total }),
    });
    return LayaEvalReportSchema.parse(reportOf(results, { checkpoint: o.checkpoint, benchmark: bench }));
  } finally {
    await proc.stop();
  }
}

/**
 * Whether a candidate's held-out evaluation beats the active one's. `target` decides — it is what
 * gates Assist — and must be strictly better; an active evaluation on another benchmark version is no
 * measure at all, so any candidate beats it.
 */
export function beats(candidate: LayaEvalReport, active: LayaEvalReport | null): { yes: boolean; reason: string } {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  if (!active) return { yes: true, reason: `It picks the right element ${pct(candidate.target.accuracy)} of the time on held-out steps, and the active checkpoint has no evaluation.` };
  if (active.benchmark.version !== candidate.benchmark.version) {
    return { yes: true, reason: `The active checkpoint was scored on another benchmark (${active.benchmark.version}); this one picks the right element ${pct(candidate.target.accuracy)} of the time on this one.` };
  }
  if (candidate.target.accuracy > active.target.accuracy) {
    return { yes: true, reason: `It picks the right element ${pct(candidate.target.accuracy)} of the time on held-out steps, against ${pct(active.target.accuracy)}.` };
  }
  return { yes: false, reason: `It picks the right element ${pct(candidate.target.accuracy)} of the time on held-out steps, and the active checkpoint ${pct(active.target.accuracy)}.` };
}

/** One JSON line of `train.py`'s, as the progress Settings shows; anything else is not progress. */
export function progressOf(line: string): TrainProgress | null {
  let e: { event?: string; step?: number; steps?: number; epoch?: number; eta?: number };
  try { e = JSON.parse(line) as typeof e; } catch { return null; }
  if (e.event === "progress" && typeof e.step === "number" && typeof e.steps === "number" && e.steps > 0) {
    const minutes = typeof e.eta === "number" ? Math.max(1, Math.round(e.eta / 60)) : null;
    return { step: "training", detail: `Epoch ${e.epoch ?? 1}, step ${e.step} of ${e.steps}${minutes ? `, about ${minutes} min left` : ""}`, fraction: Math.min(1, e.step / e.steps) };
  }
  if (e.event === "done") return { step: "training", detail: "Fitting its confidence", fraction: 1 };
  return null;
}

/** The decision log's rows, oldest first; a line that does not parse is skipped. */
function readLog(files: string[]): ShadowRow[] {
  const rows: ShadowRow[] = [];
  for (const f of [...files].reverse()) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ShadowRow;
        if (r.v === 1) rows.push(r);
      } catch { /* a torn last line */ }
    }
  }
  return rows;
}

/** A checkpoint's report, or null when it has none that reads. */
export function readEval(path: string): LayaEvalReport | null {
  try {
    const r = LayaEvalReportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Removes a checkpoint directory; a missing one is already gone. */
export function removeCheckpoint(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.partial`, { recursive: true, force: true });
}
