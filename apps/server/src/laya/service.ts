import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LAYA_ASSIST_MIN_ACCURACY, LayaModeSchema, type LayaAssistGate, type LayaEvalReport, type LayaEvaluation, type LayaInstallStep, type LayaMode, type LayaRuntimeState, type LayaStatus, type LayaTraining } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { LAYA_CHECKPOINT, LayaClient, type LayaHealth } from "./client";
import type { DecisionLog } from "./log";
import type { PythonSearch } from "./python";
import { LayaStepError, type LayaProcess, type LayaRuntime } from "./runtime";
import { beats, localCheckpointLabel, readEval, removeCheckpoint, type TrainProgress, type TrainResult } from "./training";

/** Where the Off/Shadow switch is kept. Absent reads as off: Laya is never on until someone says so. */
export const LAYA_MODE_KEY = "laya.mode";
/** The checkpoint trained on this Mac that Laya runs, by its directory's name under `checkpoints/`.
 *  Absent is the download. */
export const LAYA_CHECKPOINT_KEY = "laya.checkpoint";

export type LayaTiming = {
  /** How long a start may take to answer `/health`. Measured at 11 s from a warm disk; the first
   *  start after an install reads 0.8 GB cold and compiles its MPS kernels. */
  startupMs: number;
  /** `/health` while starting. The port only opens once the checkpoint is loaded. */
  pollMs: number;
  /** `/health` while ready, and how many misses in a row mean the process is wedged. */
  healthEveryMs: number;
  healthMisses: number;
  /** The wait before each restart of a process that died. Past the last, the state is `failed`. */
  backoffMs: number[];
  /** One question, or one `/health`. Off every act's path, so this bounds a queue rather than anyone's
   *  wait. */
  requestTimeoutMs: number;
  /** The warm-up. The first question after a load took 1.2 s here, against a 63 ms p50 after it. */
  warmupTimeoutMs: number;
};

export const LAYA_TIMING: LayaTiming = {
  startupMs: 180_000, pollMs: 500, healthEveryMs: 30_000, healthMisses: 3,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000], requestTimeoutMs: 2_000, warmupTimeoutMs: 20_000,
};

/** How many recent round trips the p50 is taken over. */
const LATENCY_WINDOW = 100;

/**
 * The local Laya runtime, as Settings and the shadow see it: whether it is installed, whether it is
 * running, and a client when it is ready.
 *
 * It never downloads on its own. `install` is the only path to the network, and it is reached only
 * from `laya.install`, which only the user's click sends. Boot starts the server only when the user
 * had switched Laya to Shadow and an install is already on disk.
 *
 * The process is supervised the way a daemon should be: started on a free loopback port with a
 * per-start key, polled until the checkpoint is loaded, warmed with one question the latency ignores,
 * watched every thirty seconds, restarted with backoff when it dies, and — after five restarts that
 * never reached ready — left stopped and reported as `failed` with what it last said, verbatim.
 */
export class LayaService {
  private mode: LayaMode;
  private installing: { step: LayaInstallStep; detail: string; fraction: number | null } | null = null;
  private installAbort: AbortController | null = null;
  private installFailure: { reason: string; detail: string } | null = null;
  private python: { at: number; search: PythonSearch } | null = null;
  private run: { proc: LayaProcess; client: LayaClient } | null = null;
  private ready: { device: string; checkpoint: string } | null = null;
  private startFailure: { reason: string; detail: string } | null = null;
  private restarts = 0;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** A start loop waiting between two polls. A stop wakes it rather than dropping it, so the loop sees
   *  it has been let go of and returns instead of waiting forever on a timer nobody will fire. */
  private readonly sleepers = new Map<NodeJS.Timeout, () => void>();
  private publishTimer: NodeJS.Timeout | null = null;
  /** The checkpoint the running process serves: a name under `checkpoints/`, or null for the download. */
  private serving: string | null = null;
  private training: LayaTraining = { state: "idle" };
  private trainAbort: AbortController | null = null;
  private latencies: number[] = [];
  private closed = false;
  private readonly t: LayaTiming;

  constructor(private readonly d: {
    /** Null in any app that was not built by `main.ts`: the suite, scripts. Nothing is spawned then. */
    runtime: LayaRuntime | null;
    settings: { get(key: string): unknown; set(key: string, value: unknown): void };
    log: DecisionLog;
    /** `rpc.broadcast("laya.changed", …)`. */
    publish: (status: LayaStatus) => void;
    fetchImpl?: typeof fetch;
    timing?: Partial<LayaTiming>;
    now?: () => number;
    /** Replaces the ACTIVE checkpoint's evaluation — for a harness only (`harnessEvalOverride`).
     *  Otherwise it is the active checkpoint's `eval.json`, or `baseEval` for the download. The Assist
     *  gate reads nothing else. */
    activeEval?: () => LayaEvalReport | null;
    /** The download's evaluation, when no checkpoint trained here is active. */
    baseEval?: () => LayaEvalReport | null;
    /** Trains and scores a checkpoint (`training.ts`); absent in a build that cannot train. */
    train?: (o: { name: string; signal: AbortSignal; onProgress: (p: TrainProgress) => void }) => Promise<TrainResult>;
  }) {
    const stored = LayaModeSchema.safeParse(d.settings.get(LAYA_MODE_KEY));
    this.mode = stored.success ? stored.data : "off";
    this.t = { ...LAYA_TIMING, ...d.timing };
  }

  /** At boot: bring the server back if the user left Laya on. Starts nothing otherwise. */
  boot(): void {
    if (this.mode !== "off" && this.d.runtime?.installed() && !this.d.runtime.unavailable) void this.start();
  }

  /** The client, only while the checkpoint is loaded and warm. The shadow asks nothing otherwise. */
  client(): LayaClient | null {
    return this.ready && this.run ? this.run.client : null;
  }

  /** e.g. `english@55cf4c4`, while ready. */
  checkpoint(): string | null {
    return this.ready?.checkpoint ?? null;
  }

  /** Which position the user put Laya in — Off, Shadow or Assist. */
  currentMode(): LayaMode {
    return this.mode;
  }

  /** The active checkpoint's evaluation, or null. */
  activeEval(): LayaEvalReport | null {
    try {
      if (this.d.activeEval) return this.d.activeEval();
      const name = this.activeCheckpoint();
      if (name) return readEval(join(this.d.runtime!.checkpointsDir, name, "eval.json"));
      return this.d.baseEval?.() ?? null;
    } catch {
      return null;
    }
  }

  /** The checkpoint trained here that is active, when its weights are still on disk; else null. */
  activeCheckpoint(): string | null {
    const name = this.d.settings.get(LAYA_CHECKPOINT_KEY);
    const rt = this.d.runtime;
    if (typeof name !== "string" || !name || !rt) return null;
    return existsSync(join(rt.checkpointsDir, name, "model.safetensors")) ? name : null;
  }

  /**
   * Whether Laya may act on its own pick, and in words why not.
   *
   * Three conditions, each a sentence a person can act on: an evaluation exists; its held-out `target`
   * accuracy clears `LAYA_ASSIST_MIN_ACCURACY`; and it fitted a confidence threshold for high
   * precision. A fourth holds while the server runs: the checkpoint it is SERVING is the one that was
   * evaluated — a threshold fitted for one model means nothing for another.
   */
  assistGate(): LayaAssistGate {
    const r = this.activeEval();
    const locked = (reason: string): LayaAssistGate => ({ available: false, reason, threshold: null, accuracy: r?.target.accuracy ?? null });
    if (!r) return locked("No checkpoint has been evaluated yet. Train Laya on this Mac first; Assist unlocks when one scores 95% on held-out steps.");
    const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
    if (r.target.accuracy < LAYA_ASSIST_MIN_ACCURACY) {
      return locked(`The active checkpoint picks the right element ${pct(r.target.accuracy)} of the time on held-out steps. Assist needs ${pct(LAYA_ASSIST_MIN_ACCURACY)}.`);
    }
    if (r.target.assist.threshold === null) return locked("No confidence level reached the precision Assist needs on held-out steps.");
    const serving = this.checkpoint();
    if (serving !== null && serving !== r.checkpoint) return locked(`Laya is serving ${serving}, but the evaluation is of ${r.checkpoint}.`);
    return { available: true, reason: null, threshold: r.target.assist.threshold, accuracy: r.target.accuracy };
  }

  async status(): Promise<LayaStatus> {
    const rt = this.d.runtime;
    return {
      mode: this.mode,
      installed: Boolean(rt && !rt.unavailable && rt.installed()),
      runtime: await this.runtimeState(),
      stepsLogged: this.d.log.count(),
      dir: rt?.dir ?? "",
      assist: this.assistGate(),
      evaluation: evaluationOf(this.activeEval()),
      training: this.training,
    };
  }

  async install(): Promise<LayaStatus> {
    const rt = this.d.runtime;
    if (!rt || rt.unavailable) throw new RpcError("LAYA_UNAVAILABLE", rt?.unavailable ?? UNAVAILABLE);
    if (this.installing) throw new RpcError("LAYA_INSTALLING", "Laya is already being installed.");
    if (rt.installed()) throw new RpcError("LAYA_INSTALLED", "Laya is already installed.");
    // Asked fresh: a Python installed since the last look is exactly why someone clicks again.
    const search = await this.findPython(true);
    if (!search.found) throw new RpcError("LAYA_NEEDS_PYTHON", "There is no Python 3.10 to 3.14 for Apple silicon on this Mac to install Laya with.");
    this.installFailure = null;
    this.installing = { step: "environment", detail: "Starting", fraction: null };
    const abort = new AbortController();
    this.installAbort = abort;
    void rt.install(search.found, (p) => { if (this.installing) { this.installing = p; this.changed(); } }, abort.signal)
      .then(() => {
        this.installing = null;
        this.changed();
        if (this.mode !== "off") void this.start();
      }, (e: unknown) => {
        this.installing = null;
        this.installFailure = e instanceof LayaStepError
          ? { reason: e.reason, detail: e.detail }
          : { reason: e instanceof Error ? e.message : String(e), detail: "" };
        this.changed();
      })
      .finally(() => { if (this.installAbort === abort) this.installAbort = null; });
    return this.status();
  }

  async setMode(mode: LayaMode): Promise<LayaStatus> {
    const rt = this.d.runtime;
    if (mode !== "off" && !(rt && !rt.unavailable && rt.installed())) {
      throw new RpcError("LAYA_NOT_INSTALLED", "Install Laya before switching it on.");
    }
    // Assist is earned by the active checkpoint's evaluation, not chosen — the switch refuses it
    // with the same sentence Settings shows beside the locked option.
    if (mode === "assist") {
      const gate = this.assistGate();
      if (!gate.available) throw new RpcError("LAYA_ASSIST_LOCKED", gate.reason ?? "Assist is not available yet.");
    }
    this.mode = mode;
    this.d.settings.set(LAYA_MODE_KEY, mode);
    if (mode !== "off") {
      // Choosing Shadow again after a failure is the retry: the count starts over.
      this.startFailure = null;
      this.restarts = 0;
      if (!this.run) void this.start();
    } else {
      await this.stop();
    }
    this.changed();
    return this.status();
  }

  /**
   * A training run, in the background: the training set and the user's log, the shipped script in
   * the venv, a score on the benchmark's held-out split — and the new checkpoint made active only when
   * that score beats the active one's. The server is stopped for the run and brought back after on
   * whichever checkpoint is active then: training and serving one model at once is more memory than
   * many Macs have to spare.
   */
  async train(): Promise<LayaStatus> {
    const rt = this.d.runtime;
    if (!rt || rt.unavailable) throw new RpcError("LAYA_UNAVAILABLE", rt?.unavailable ?? UNAVAILABLE);
    if (!this.d.train) throw new RpcError("LAYA_UNAVAILABLE", "This build of Realm cannot train Laya.");
    if (!rt.installed()) throw new RpcError("LAYA_NOT_INSTALLED", "Install Laya before training it.");
    if (this.installing) throw new RpcError("LAYA_INSTALLING", "Laya is being installed.");
    if (this.trainAbort) throw new RpcError("LAYA_TRAINING", "Laya is already training.");
    const abort = new AbortController();
    this.trainAbort = abort;
    const startedAt = new Date(this.now()).toISOString();
    this.training = { state: "running", step: "preparing", detail: "Starting", fraction: null, startedAt };
    this.changed();
    void this.runTraining(this.checkpointName(), abort, startedAt);
    return this.status();
  }

  async cancelTraining(): Promise<LayaStatus> {
    this.trainAbort?.abort();
    return this.status();
  }

  private async runTraining(name: string, abort: AbortController, startedAt: string): Promise<void> {
    const rt = this.d.runtime!;
    await this.stop();
    const at = () => new Date(this.now()).toISOString();
    try {
      const result = await this.d.train!({
        name, signal: abort.signal,
        onProgress: (p) => {
          if (this.trainAbort !== abort) return;
          this.training = { state: "running", ...p, startedAt };
          this.changed();
        },
      });
      if (abort.signal.aborted) throw new Error("Stopped.");
      const verdict = beats(result.report, this.activeEval());
      if (verdict.yes) {
        const previous = this.activeCheckpoint();
        this.d.settings.set(LAYA_CHECKPOINT_KEY, name);
        if (previous && previous !== name) removeCheckpoint(join(rt.checkpointsDir, previous));
      } else {
        // The report is kept as the run's record; the weights of a checkpoint nobody will run are not.
        mkdirSync(join(rt.dir, "train", name), { recursive: true });
        copyFileSync(join(result.dir, "eval.json"), join(rt.dir, "train", name, "eval.json"));
        removeCheckpoint(result.dir);
      }
      this.training = { state: "done", at: at(), checkpoint: localCheckpointLabel(name), activated: verdict.yes, reason: verdict.reason, targetAccuracy: result.report.target.accuracy };
    } catch (e) {
      removeCheckpoint(join(rt.checkpointsDir, name));
      this.training = abort.signal.aborted
        ? { state: "cancelled", at: at() }
        : { state: "failed", at: at(), reason: e instanceof LayaStepError ? e.reason : e instanceof Error ? e.message : String(e), detail: e instanceof LayaStepError ? e.detail : "" };
    } finally {
      this.trainAbort = null;
      if (!this.closed && this.mode !== "off") {
        this.startFailure = null;
        this.restarts = 0;
        void this.start();
      }
      this.changed();
    }
  }

  /** `2026-09-29T07-12`, and `-2`, `-3` for a second run in the same minute. */
  private checkpointName(): string {
    const stem = new Date(this.now()).toISOString().slice(0, 16).replace(":", "-");
    const taken = (n: string) => existsSync(join(this.d.runtime!.checkpointsDir, n));
    let name = stem;
    for (let i = 2; taken(name); i++) name = `${stem}-${i}`;
    return name;
  }

  async deleteLog(): Promise<LayaStatus> {
    this.d.log.delete();
    this.changed();
    return this.status();
  }

  /** A row was written: Settings' count moves. Coalesced with every other change. */
  logged(): void {
    this.changed();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.installAbort?.abort();
    this.trainAbort?.abort();
    if (this.publishTimer) clearTimeout(this.publishTimer);
    await this.stop();
  }

  /* ---------------------------------- the process ---------------------------------- */

  private async start(): Promise<void> {
    const rt = this.d.runtime;
    // A training run has the memory; the run brings the server back when it is done.
    if (!rt || this.run || this.closed || this.trainAbort) return;
    this.ready = null;
    let port: number;
    try {
      port = await rt.freePort();
    } catch (e) {
      this.startFailure = { reason: `No free port on 127.0.0.1: ${e instanceof Error ? e.message : String(e)}`, detail: "" };
      this.changed();
      return;
    }
    if (this.closed || this.mode === "off" || this.run) return;
    const apiKey = randomBytes(24).toString("base64url");
    const local = this.activeCheckpoint();
    this.serving = local;
    const run = {
      proc: rt.start({ port, apiKey, ...(local ? { checkpoint: join(rt.checkpointsDir, local) } : {}) }),
      client: new LayaClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey, fetchImpl: this.d.fetchImpl, onLatency: (ms) => this.recordLatency(ms) }),
    };
    this.run = run;
    this.changed();
    void run.proc.exited.then((exit) => this.exited(run, exit));

    const deadline = this.now() + this.t.startupMs;
    while (this.run === run) {
      let health: LayaHealth | null = null;
      try { health = await run.client.health(this.t.requestTimeoutMs); } catch { /* the port opens once the model has loaded */ }
      if (this.run !== run) return;
      if (health?.loaded.includes(LAYA_CHECKPOINT)) return this.warm(run, health);
      if (this.now() >= deadline) {
        this.startFailure = { reason: `laya-serve did not answer on 127.0.0.1:${port} within ${Math.round(this.t.startupMs / 1000)} s.`, detail: "" };
        this.run = null;
        await run.proc.stop();
        this.changed();
        return;
      }
      await this.sleep(this.t.pollMs);
    }
  }

  /** One throwaway question of each shape Realm asks, so the first real step is not the one that pays
   *  for the kernels — and so the latency Settings shows is the latency a step sees. */
  private async warm(run: NonNullable<LayaService["run"]>, health: LayaHealth): Promise<void> {
    const criteria = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Option ${i + 1}`, "button"]));
    try {
      await run.client.ask("Goal: warm up. The screen shows: button 'Option 1'.", {
        target: { type: "choice", instructions: "Which on-screen element should be used to: warm up?", criteria },
        check: { type: "noul", instructions: "Is this a test?" },
      }, this.t.warmupTimeoutMs, false);
    } catch { /* a slow warm-up is not a failed start; the watch below decides that */ }
    if (this.run !== run) return;
    const revision = health.revisions[LAYA_CHECKPOINT];
    this.ready = {
      device: health.checkpoint_devices[LAYA_CHECKPOINT] ?? health.device,
      checkpoint: this.serving ? localCheckpointLabel(this.serving) : `${LAYA_CHECKPOINT}@${revision ? revision.slice(0, 7) : "unpinned"}`,
    };
    this.restarts = 0;
    this.startFailure = null;
    this.watch(run);
    this.changed();
  }

  /** `/health` on a slow clock. A process that stops answering is stopped, and `exited` restarts it. */
  private watch(run: NonNullable<LayaService["run"]>): void {
    let misses = 0;
    const tick = async (): Promise<void> => {
      if (this.run !== run) return;
      try { await run.client.health(this.t.requestTimeoutMs); misses = 0; } catch { misses++; }
      if (this.run !== run) return;
      if (misses >= this.t.healthMisses) { void run.proc.stop(); return; }
      this.later(() => void tick(), this.t.healthEveryMs);
    };
    this.later(() => void tick(), this.t.healthEveryMs);
  }

  private exited(run: NonNullable<LayaService["run"]>, exit: { code: number | null; signal: string | null; output: string }): void {
    // A stop Realm asked for has already let go of the run; only an exit nobody asked for gets here.
    if (this.run !== run) return;
    this.run = null;
    this.ready = null;
    if (this.closed || this.mode === "off") return this.changed();
    const reason = lastLine(exit.output) || `laya-serve exited with ${exit.signal ?? `code ${exit.code}`}.`;
    if (this.restarts >= this.t.backoffMs.length) {
      this.startFailure = { reason, detail: exit.output };
      return this.changed();
    }
    const delay = this.t.backoffMs[this.restarts]!;
    this.restarts++;
    this.changed();
    this.later(() => { if (!this.run && !this.closed && this.mode !== "off") void this.start(); }, delay);
  }

  private async stop(): Promise<void> {
    const run = this.run;
    this.run = null;
    this.ready = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const [t, wake] of this.sleepers) { clearTimeout(t); wake(); }
    this.sleepers.clear();
    if (run) await run.proc.stop();
  }

  /* ---------------------------------- state ---------------------------------- */

  private async runtimeState(): Promise<LayaRuntimeState> {
    const rt = this.d.runtime;
    if (!rt) return { state: "unavailable", reason: UNAVAILABLE };
    if (rt.unavailable) return { state: "unavailable", reason: rt.unavailable };
    if (this.installing) return { state: "installing", ...this.installing };
    if (!rt.installed()) {
      if (this.installFailure) return { state: "failed", during: "install", ...this.installFailure };
      const search = await this.findPython(false);
      return search.found ? { state: "not-installed", python: search.found } : { state: "needs-python", rejected: search.rejected };
    }
    // A training run stopped the server, and says so on its own row.
    if (this.mode === "off" || this.trainAbort) return { state: "off" };
    if (this.startFailure) return { state: "failed", during: "start", ...this.startFailure };
    if (this.ready) return { state: "ready", device: this.ready.device, p50Ms: this.p50(), checkpoint: this.ready.checkpoint };
    return { state: "starting" };
  }

  /** A find is kept for thirty seconds: Settings asks on every visit, and each look runs every Python
   *  on the machine once. "None" is never kept — the next look is the one after `brew install`. */
  private async findPython(fresh: boolean): Promise<PythonSearch> {
    if (!fresh && this.python?.search.found && this.now() - this.python.at < 30_000) return this.python.search;
    const search = await this.d.runtime!.findPython();
    this.python = { at: this.now(), search };
    return search;
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  private p50(): number | null {
    return p50Of(this.latencies);
  }

  /** Coalesced: an install's progress and a busy agent's steps would otherwise be a broadcast each. */
  private changed(): void {
    if (this.publishTimer || this.closed) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.status().then((s) => this.d.publish(s), () => {});
    }, 100);
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.sleepers.delete(t); resolve(); }, ms);
      this.sleepers.set(t, resolve);
    });
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
}

const UNAVAILABLE = "This build of Realm does not run Laya.";

/** A report's three numbers for Settings, or null for no report. */
export function evaluationOf(r: LayaEvalReport | null): LayaEvaluation | null {
  if (!r) return null;
  return {
    checkpoint: r.checkpoint, createdAt: r.createdAt, benchmark: r.benchmark.version,
    targetAccuracy: r.target.accuracy, targetNotCopying: r.target.notCopying?.accuracy ?? null,
    sensitiveRecall: r.sensitive.recall, verifyAccuracy: r.verify.accuracy,
  };
}

/** The median, in whole milliseconds; null for no samples. A median rather than a mean, because one
 *  question that met a cold kernel would otherwise speak for a hundred that did not. */
export function p50Of(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function lastLine(output: string): string {
  return output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}
