import { randomBytes } from "node:crypto";
import { LayaModeSchema, type LayaInstallStep, type LayaMode, type LayaRuntimeState, type LayaStatus } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { LAYA_CHECKPOINT, LayaClient, type LayaHealth } from "./client";
import type { DecisionLog } from "./log";
import type { PythonSearch } from "./python";
import { LayaStepError, type LayaProcess, type LayaRuntime } from "./runtime";

/** Where the Off/Shadow switch is kept. Absent reads as off: Laya is never on until someone says so. */
export const LAYA_MODE_KEY = "laya.mode";

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
  }) {
    const stored = LayaModeSchema.safeParse(d.settings.get(LAYA_MODE_KEY));
    this.mode = stored.success ? stored.data : "off";
    this.t = { ...LAYA_TIMING, ...d.timing };
  }

  /** At boot: bring the server back if the user left Laya on. Starts nothing otherwise. */
  boot(): void {
    if (this.mode === "shadow" && this.d.runtime?.installed() && !this.d.runtime.unavailable) void this.start();
  }

  /** The client, only while the checkpoint is loaded and warm. The shadow asks nothing otherwise. */
  client(): LayaClient | null {
    return this.ready && this.run ? this.run.client : null;
  }

  /** e.g. `english@55cf4c4`, while ready. */
  checkpoint(): string | null {
    return this.ready?.checkpoint ?? null;
  }

  async status(): Promise<LayaStatus> {
    const rt = this.d.runtime;
    return {
      mode: this.mode,
      installed: Boolean(rt && !rt.unavailable && rt.installed()),
      runtime: await this.runtimeState(),
      stepsLogged: this.d.log.count(),
      dir: rt?.dir ?? "",
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
        if (this.mode === "shadow") void this.start();
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
    if (mode === "shadow" && !(rt && !rt.unavailable && rt.installed())) {
      throw new RpcError("LAYA_NOT_INSTALLED", "Install Laya before switching it on.");
    }
    this.mode = mode;
    this.d.settings.set(LAYA_MODE_KEY, mode);
    if (mode === "shadow") {
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
    if (this.publishTimer) clearTimeout(this.publishTimer);
    await this.stop();
  }

  /* ---------------------------------- the process ---------------------------------- */

  private async start(): Promise<void> {
    const rt = this.d.runtime;
    if (!rt || this.run || this.closed) return;
    this.ready = null;
    let port: number;
    try {
      port = await rt.freePort();
    } catch (e) {
      this.startFailure = { reason: `No free port on 127.0.0.1: ${e instanceof Error ? e.message : String(e)}`, detail: "" };
      this.changed();
      return;
    }
    if (this.closed || this.mode !== "shadow" || this.run) return;
    const apiKey = randomBytes(24).toString("base64url");
    const run = {
      proc: rt.start({ port, apiKey }),
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
      checkpoint: `${LAYA_CHECKPOINT}@${revision ? revision.slice(0, 7) : "unpinned"}`,
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
    if (this.closed || this.mode !== "shadow") return this.changed();
    const reason = lastLine(exit.output) || `laya-serve exited with ${exit.signal ?? `code ${exit.code}`}.`;
    if (this.restarts >= this.t.backoffMs.length) {
      this.startFailure = { reason, detail: exit.output };
      return this.changed();
    }
    const delay = this.t.backoffMs[this.restarts]!;
    this.restarts++;
    this.changed();
    this.later(() => { if (!this.run && !this.closed && this.mode === "shadow") void this.start(); }, delay);
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
    if (this.mode === "off") return { state: "off" };
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
    if (this.latencies.length === 0) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return Math.round(median);
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

function lastLine(output: string): string {
  return output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}
