import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { LayaStatus } from "@realm/contracts";
import type { LayaEvalReport } from "@realm/contracts";
import { DecisionLog } from "./log";
import { LAYA_CHECKPOINT_KEY, LAYA_MODE_KEY, LayaService, evaluationOf, p50Of, type LayaTiming } from "./service";
import type { TrainProgress, TrainResult } from "./training";
import { LayaStepError } from "./runtime";
import { fakeRuntime, until, type FakeRuntime } from "./test-fakes";
import { LayaRecorder } from "./recorder";
import { NotFoundError } from "../store/rows";
import type { SimulatorAxTree } from "@realm/contracts";

/**
 * The runtime's life as Settings sees it, over a fake runtime and a fake laya-serve on real HTTP.
 * What must die here: a download nobody asked for, Shadow before an install, a process left running
 * after Off or quit, a crash that is not restarted, a restart without backoff, and a failure reported
 * in anything but the process's own words.
 */

const FAST: Partial<LayaTiming> = {
  startupMs: 2_000, pollMs: 5, healthEveryMs: 60_000, healthMisses: 2,
  backoffMs: [30, 60, 120], requestTimeoutMs: 500, warmupTimeoutMs: 1_000,
};

const services: LayaService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.close(); });

type Train = (o: { name: string; signal: AbortSignal; onProgress: (p: TrainProgress) => void }) => Promise<TrainResult>;

function setup(o: { runtime?: FakeRuntime | null; mode?: "off" | "shadow" | "assist"; timing?: Partial<LayaTiming>; activeEval?: () => LayaEvalReport | null; baseEval?: () => LayaEvalReport | null; train?: Train; checkpoint?: string; screen?: () => SimulatorAxTree } = {}) {
  const dir = tempDir("realm-laya-svc-");
  const runtime = o.runtime === undefined ? fakeRuntime({ dir }) : o.runtime;
  const settings = new Map<string, unknown>([...(o.mode ? [[LAYA_MODE_KEY, o.mode] as const] : []), ...(o.checkpoint ? [[LAYA_CHECKPOINT_KEY, o.checkpoint] as const] : [])]);
  const published: LayaStatus[] = [];
  const log = new DecisionLog({ path: join(dir, "decisions.jsonl") });
  const screen = o.screen;
  const recorder = screen ? new LayaRecorder({
    dir: join(dir, "recordings"), read: async () => screen(), intervalMs: 2,
    deviceName: (id) => { if (id !== "sim1") throw new NotFoundError("simulator", id); return "Test iPhone"; },
    onChange: () => service.recordingChanged(),
  }) : undefined;
  const service: LayaService = new LayaService({
    runtime, log, timing: { ...FAST, ...o.timing },
    settings: { get: (k) => settings.get(k) ?? null, set: (k, v) => { settings.set(k, v); } },
    publish: (s) => { published.push(s); },
    activeEval: o.activeEval,
    baseEval: o.baseEval,
    ...(o.train ? { train: o.train } : {}),
    ...(recorder ? { recorder } : {}),
  });
  services.push(service);
  return { service, runtime, settings, published, log, dir, recorder };
}

const state = async (s: LayaService) => (await s.status()).runtime;

describe("before anything is installed", () => {
  it("reports Laya unavailable, and looks for nothing, in an app built without a runtime", async () => {
    const { service } = setup({ runtime: null });
    expect(await state(service)).toEqual({ state: "unavailable", reason: "This build of Realm does not run Laya." });
    await expect(service.install()).rejects.toMatchObject({ code: "LAYA_UNAVAILABLE" });
    await expect(service.setMode("shadow")).rejects.toMatchObject({ code: "LAYA_NOT_INSTALLED" });
  });

  it("says a Mac that cannot run it at all is unavailable, in the runtime's own sentence", async () => {
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({ dir, unavailable: "Laya runs on Apple silicon only: PyTorch publishes no build for Intel Macs." });
    const { service } = setup({ runtime });
    expect(await state(service)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Apple silicon") });
    await expect(service.install()).rejects.toMatchObject({ code: "LAYA_UNAVAILABLE" });
    expect(runtime.pythonLooks).toBe(0);
  });

  it("names the Python it would install with", async () => {
    const { service } = setup();
    expect(await state(service)).toEqual({ state: "not-installed", python: { path: "/opt/homebrew/bin/python3.13", version: "3.13.12" } });
  });

  it("says it needs Python, listing what it turned down, rather than guessing one", async () => {
    const dir = tempDir("realm-laya-svc-");
    const rejected = [{ path: "/usr/local/bin/python3.12", why: "Python 3.12.8 for x86_64, which runs under Rosetta; PyTorch needs a native arm64 build" }];
    const runtime = fakeRuntime({ dir, python: { found: null, rejected } });
    const { service } = setup({ runtime });
    expect(await state(service)).toEqual({ state: "needs-python", rejected });
    await expect(service.install()).rejects.toMatchObject({ code: "LAYA_NEEDS_PYTHON" });
    expect(runtime.installs).toBe(0);
  });

  it("keeps a found Python for a while, but looks again for one it did not find", async () => {
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({ dir, python: { found: null, rejected: [] } });
    const { service } = setup({ runtime });
    await service.status();
    await service.status();
    expect(runtime.pythonLooks).toBe(2);
    const found = fakeRuntime({ dir });
    const other = setup({ runtime: found });
    await other.service.status();
    await other.service.status();
    expect(found.pythonLooks).toBe(1);
  });

  it("downloads nothing until it is asked to — not at boot, not on a status read, not on Off", async () => {
    // THE MUTANT: an install kicked off by boot or by the first status read. About two gigabytes of
    // PyTorch and weights would start downloading because someone opened Settings.
    const runtime = fakeRuntime({ dir: tempDir("realm-laya-svc-") });
    const { service } = setup({ runtime, mode: "shadow" });
    service.boot();
    await service.status();
    await service.status();
    await service.setMode("off");
    expect(runtime.installs).toBe(0);
    expect(runtime.starts).toEqual([]);
  });

  it("refuses Shadow before an install, and leaves the switch where it was", async () => {
    const { service, settings } = setup();
    await expect(service.setMode("shadow")).rejects.toMatchObject({ code: "LAYA_NOT_INSTALLED" });
    expect(settings.get(LAYA_MODE_KEY)).toBeUndefined();
    expect((await service.status()).mode).toBe("off");
  });
});

describe("installing", () => {
  it("runs only when asked, reports each step as it goes, and ends installed and off", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({
      dir,
      install: async (onProgress) => {
        onProgress({ step: "environment", detail: "Creating a Python 3.13.12 environment", fraction: null });
        onProgress({ step: "packages", detail: "Downloading torch-2.14.0-cp313-cp313-macosx_14_0_arm64.whl (78.9 MB)", fraction: null });
        onProgress({ step: "model", detail: "Downloading the checkpoint", fraction: 0.5 });
        await gate;
      },
    });
    const { service, published } = setup({ runtime });
    const first = await service.install();
    expect(runtime.installs).toBe(1);
    expect(first.runtime.state).toBe("installing");
    // Mid-install: the determinate step says how far, and a second click is refused rather than run twice.
    expect(await state(service)).toEqual({ state: "installing", step: "model", detail: "Downloading the checkpoint", fraction: 0.5 });
    await expect(service.install()).rejects.toMatchObject({ code: "LAYA_INSTALLING" });
    release();
    await until(async () => (await state(service)).state === "off");
    expect((await service.status()).installed).toBe(true);
    // An install does not switch Laya on: that is a separate decision.
    expect(runtime.starts).toEqual([]);
    await until(() => published.some((s) => s.runtime.state === "off"));
  });

  it("an install that fails says why in the installer's own words, and may be tried again", async () => {
    const dir = tempDir("realm-laya-svc-");
    let fail = true;
    const runtime = fakeRuntime({
      dir,
      install: async () => {
        if (fail) throw new LayaStepError("packages", "ERROR: No matching distribution found for laya[serve]==0.3.21", "Collecting laya[serve]==0.3.21\nERROR: No matching distribution found for laya[serve]==0.3.21\n");
      },
    });
    const { service } = setup({ runtime });
    await service.install();
    await until(async () => (await state(service)).state === "failed");
    expect(await state(service)).toEqual({
      state: "failed", during: "install",
      reason: "ERROR: No matching distribution found for laya[serve]==0.3.21",
      detail: expect.stringContaining("Collecting laya[serve]==0.3.21"),
    });
    fail = false;
    await service.install();
    await until(async () => (await state(service)).state === "off");
  });

  it("goes straight on to running when Laya was already switched to Shadow", async () => {
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({ dir });
    const { service } = setup({ runtime, mode: "shadow" });
    await service.install();
    await until(async () => (await state(service)).state === "ready");
  });
});

describe("running in Shadow", () => {
  function installed() {
    const dir = tempDir("realm-laya-svc-");
    return fakeRuntime({ dir, installed: true });
  }

  it("starts laya-serve on a loopback port with a fresh key, and is ready once the checkpoint is loaded", async () => {
    const runtime = installed();
    const { service, settings } = setup({ runtime });
    expect(await state(service)).toEqual({ state: "off" });
    await service.setMode("shadow");
    expect(settings.get(LAYA_MODE_KEY)).toBe("shadow");
    await until(async () => (await state(service)).state === "ready");
    expect(await state(service)).toEqual({ state: "ready", device: "mps", p50Ms: null, checkpoint: "english@55cf4c4" });
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]!.apiKey.length).toBeGreaterThanOrEqual(32);
    // The warm-up was asked — one question of each shape — and kept out of the latency.
    const warm = runtime.server()!.asked[0]!;
    expect(warm.auth).toBe(`Bearer ${runtime.starts[0]!.apiKey}`);
    expect(Object.values(warm.body.questions).map((q) => q.type).sort()).toEqual(["choice", "noul"]);
    expect(Object.keys(Object.values(warm.body.questions).find((q) => q.type === "choice")!.criteria!)).toHaveLength(20);
  });

  it("reports the median round trip of the questions actually asked", async () => {
    const runtime = installed();
    const { service } = setup({ runtime });
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    for (let i = 0; i < 3; i++) await service.client()!.ask("Goal: x.", { q: { type: "noul", instructions: "?" } }, 500);
    const s = await state(service);
    expect(s.state === "ready" && typeof s.p50Ms === "number").toBe(true);
  });

  it("hands out no client until it is warm, and none once it is off", async () => {
    const runtime = installed();
    const { service } = setup({ runtime });
    expect(service.client()).toBeNull();
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    expect(service.checkpoint()).toBe("english@55cf4c4");
    await service.setMode("off");
    expect(service.client()).toBeNull();
    expect(await state(service)).toEqual({ state: "off" });
  });

  it("hands out no client while the checkpoint is still loading", async () => {
    // THE MUTANT: a client as soon as a process exists. The shadow would then put its questions to a
    // server that is still reading 0.8 GB off disk, and log a timeout for every step of the wait.
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({ dir, installed: true, server: { health: () => ({ status: "ok", loaded: [], revisions: {}, device: "mps", checkpoint_devices: {} }) } });
    const { service } = setup({ runtime, timing: { startupMs: 10_000 } });
    await service.setMode("shadow");
    await until(() => runtime.server() !== null);
    await new Promise((r) => setTimeout(r, 50));
    expect(service.client()).toBeNull();
    expect(await state(service)).toEqual({ state: "starting" });
  });

  it("Off while Shadow is still starting leaves nothing running", async () => {
    // The start was already past its decision when the switch went back to Off — it is waiting on a
    // free port. It must look again before it spawns, or it leaves a laya-serve nobody asked for.
    const runtime = installed();
    let release!: () => void;
    const portFound = new Promise<void>((r) => { release = r; });
    const freePort = runtime.freePort.bind(runtime);
    runtime.freePort = async () => { await portFound; return freePort(); };
    const { service } = setup({ runtime });
    void service.setMode("shadow");
    await service.setMode("off");
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.starts).toEqual([]);
    expect(await state(service)).toEqual({ state: "off" });
  });

  it("Off stops the process", async () => {
    const runtime = installed();
    const { service } = setup({ runtime });
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    const { port } = runtime.starts[0]!;
    await service.setMode("off");
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("restarts a process that died, and comes back ready", async () => {
    const runtime = installed();
    const { service } = setup({ runtime });
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    await runtime.crash("Segmentation fault: 11");
    expect(service.client()).toBeNull();
    expect(await state(service)).toEqual({ state: "starting" });
    await until(() => service.client() !== null);
    expect(runtime.starts).toHaveLength(2);
    // A new start is a new key: the old one died with its process.
    expect(runtime.starts[1]!.apiKey).not.toBe(runtime.starts[0]!.apiKey);
  });

  it("waits longer before each restart, and after the last one says what the process last said", async () => {
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({ dir, installed: true, serve: false });
    const at: number[] = [];
    const start = runtime.start.bind(runtime);
    runtime.start = (o) => { at.push(Date.now()); return start(o); };
    const { service } = setup({ runtime });
    await service.setMode("shadow");
    await until(async () => (await state(service)).state === "failed", 3_000);
    // One start, then one restart per backoff step — and no more.
    expect(runtime.starts).toHaveLength(FAST.backoffMs!.length + 1);
    // THE MUTANT: restarting at once. Each wait is at least its step (a timer never fires early).
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    FAST.backoffMs!.forEach((ms, i) => expect(gaps[i]!).toBeGreaterThanOrEqual(ms - 2));
    expect(await state(service)).toEqual({
      state: "failed", during: "start",
      reason: "OSError: We couldn't connect to 'https://huggingface.co' to load the files, and couldn't find them in the cached files.",
      detail: expect.stringContaining("Traceback"),
    });
  });

  it("choosing Shadow again after a failure is the retry, with the count started over", async () => {
    const dir = tempDir("realm-laya-svc-");
    let serve = false;
    const runtime = fakeRuntime({ dir, installed: true, serve: () => serve });
    const { service } = setup({ runtime });
    await service.setMode("shadow");
    await until(async () => (await state(service)).state === "failed", 3_000);
    serve = true;
    await service.setMode("shadow");
    await until(() => service.client() !== null);
  });

  it("forgives the crashes before a start that reached ready", async () => {
    const runtime = installed();
    const { service } = setup({ runtime, timing: { backoffMs: [5] } });
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    // One restart allowed. Two crashes, each followed by a clean start, must not add up to a failure.
    await runtime.crash("killed");
    await until(() => service.client() !== null);
    await runtime.crash("killed again");
    await until(() => service.client() !== null);
    expect(runtime.starts).toHaveLength(3);
  });

  it("gives up on a start that never loads the checkpoint, rather than waiting forever", async () => {
    const dir = tempDir("realm-laya-svc-");
    const runtime = fakeRuntime({ dir, installed: true, server: { health: () => ({ status: "ok", loaded: [], revisions: {}, device: "mps", checkpoint_devices: {} }) } });
    const { service } = setup({ runtime, timing: { startupMs: 60 } });
    await service.setMode("shadow");
    await until(async () => (await state(service)).state === "failed");
    expect(await state(service)).toMatchObject({ state: "failed", during: "start", reason: expect.stringMatching(/did not answer on 127\.0\.0\.1:\d+ within/) });
  });

  it("restarts a process that stops answering /health", async () => {
    const runtime = installed();
    const { service } = setup({ runtime, timing: { healthEveryMs: 15, healthMisses: 2 } });
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    runtime.server()!.hang(true);
    await until(() => runtime.starts.length === 2, 8_000);
    await until(() => service.client() !== null, 8_000);
  });
});

describe("boot and quit", () => {
  it("boot brings the server back only when it was left on and is installed", async () => {
    const off = setup({ runtime: fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: true }), mode: "off" });
    off.service.boot();
    const bare = setup({ runtime: fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: false }), mode: "shadow" });
    bare.service.boot();
    const on = setup({ runtime: fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: true }), mode: "shadow" });
    on.service.boot();
    await until(() => on.service.client() !== null);
    expect(off.runtime!.starts).toEqual([]);
    expect(bare.runtime!.starts).toEqual([]);
  });

  it("close stops laya-serve", async () => {
    const runtime = fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: true });
    const { service } = setup({ runtime, mode: "shadow" });
    service.boot();
    await until(() => service.client() !== null);
    const { port } = runtime.starts[0]!;
    await service.close();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("close stops an install in flight", async () => {
    let aborted = false;
    const runtime = fakeRuntime({
      dir: tempDir("realm-laya-svc-"),
      install: (_p, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); })),
    });
    const { service } = setup({ runtime });
    await service.install();
    await service.close();
    expect(aborted).toBe(true);
  });
});

describe("the log", () => {
  it("counts the rows, and Delete log removes every file", async () => {
    const { service, log } = setup();
    log.append({ n: 1 });
    log.append({ n: 2 });
    expect((await service.status()).stepsLogged).toBe(2);
    const after = await service.deleteLog();
    expect(after.stepsLogged).toBe(0);
    expect(existsSync(log.path)).toBe(false);
  });
});

describe("recording", () => {
  const tree = (app: string, label: string): SimulatorAxTree => ({ screen: { width: 390, height: 844 }, units: "points", app, elements: [
    { path: "0.1", role: "Button", label, value: "", id: null, enabled: true, frame: { x: 0, y: 0, width: 10, height: 10 }, depth: 1 },
  ] });
  afterEach(() => { for (const s of services) void s.stopRecording(); });

  it("is refused by a Realm that cannot record", async () => {
    await expect(setup().service.record("sim1", [])).rejects.toMatchObject({ code: "LAYA_UNAVAILABLE" });
  });

  it("shows the recording under way, publishes each screen it keeps, and counts it for training once stopped", async () => {
    let reads = 0;
    const { service, published } = setup({ screen: () => tree("Instagram", reads++ === 0 ? "Reels" : "Search") });
    expect((await service.status()).recorded).toEqual({ recordings: 0, screens: 0, apps: [] });
    const started = await service.record("sim1", ["Instagram"]);
    expect(started.recording).toMatchObject({ device: "Test iPhone", apps: ["Instagram"], screens: 0, endedAt: null });
    // THE MUTANT: a recorder whose changes go nowhere. Settings shows 0 screens for the whole session.
    await until(() => published.some((p) => p.recording?.screens === 2));
    const stopped = await service.stopRecording();
    expect(stopped.recording).toBeNull();
    // Screens, not recordings: THE MUTANT counts one recording as one screen.
    expect(stopped.recorded).toEqual({ recordings: 1, screens: 2, apps: ["Instagram"] });
  });

  it("records the app in front when none is named, and refuses the home screen", async () => {
    let app = " ";
    const { service } = setup({ screen: () => tree(app, "Reels") });
    await expect(service.record("sim1", [])).rejects.toMatchObject({ code: "LAYA_NO_APP" });
    expect((await service.status()).recording).toBeNull();
    app = "Instagram";
    expect((await service.record("sim1", [])).recording).toMatchObject({ apps: ["Instagram"] });
  });

  it("refuses a device that is not a pane, and records nothing", async () => {
    const { service } = setup({ screen: () => tree("Instagram", "Reels") });
    await expect(service.record("gone", [])).rejects.toBeInstanceOf(NotFoundError);
    expect((await service.status()).recording).toBeNull();
  });

  it("ends a recording under way when Realm quits, and keeps what it recorded", async () => {
    const { service, recorder } = setup({ screen: () => tree("Instagram", "Reels") });
    await service.record("sim1", ["Instagram"]);
    await until(async () => (await service.status()).recording?.screens === 1);
    await service.close();
    // THE MUTANT: leave it reading. The phone is read by a Realm that has quit, and never says it ended.
    expect(recorder!.current()).toBeNull();
    expect(recorder!.list()[0]).toMatchObject({ screens: 1, endedAt: expect.any(String) });
  });

  it("deletes every recording, the one under way included", async () => {
    const { service, dir } = setup({ screen: () => tree("TikTok", "For You") });
    await service.record("sim1", ["TikTok"]);
    await until(async () => (await service.status()).recording?.screens === 1);
    const after = await service.deleteRecordings();
    expect(after.recording).toBeNull();
    expect(after.recorded).toEqual({ recordings: 0, screens: 0, apps: [] });
    expect(existsSync(join(dir, "recordings"))).toBe(false);
  });
});

describe("p50", () => {
  it("is the median of the round trips, so one cold question does not speak for the rest", () => {
    expect(p50Of([])).toBeNull();
    expect(p50Of([35])).toBe(35);
    expect(p50Of([30, 1_200, 40])).toBe(40);
    expect(p50Of([10, 20, 30, 41])).toBe(25);
  });
});

describe("Assist", () => {
  /** A report as the eval harness writes one — the fields the gate reads, and the rest plausible. */
  const report = (over: { accuracy?: number; threshold?: number | null; checkpoint?: string } = {}): LayaEvalReport => ({
    v: 1, checkpoint: over.checkpoint ?? "english@55cf4c4", createdAt: "2026-09-29T07:00:00Z", prompt: 2,
    benchmark: { version: "1", split: "heldout", cases: 400, apps: ["Maps", "Clock", "Weather", "Files"] },
    target: { accuracy: over.accuracy ?? 0.96, n: 120, byApp: {}, assist: { threshold: over.threshold === undefined ? 0.82 : over.threshold, precision: 0.98, coverage: 0.7 } },
    sensitive: { accuracy: 0.95, recall: 0.99, precision: 0.9, n: 60 },
    verify: { accuracy: 0.9, n: 40 },
    baseline: { sensitiveRule: { accuracy: 0.97, recall: 1 }, verifyRule: { accuracy: 0.93 } },
    latencyMs: { p50: 40, p90: 90 },
  });
  const installedRuntime = () => fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: true });

  it("is locked, with the reason in words, until a checkpoint has been evaluated", async () => {
    const { service } = setup({ runtime: installedRuntime() });
    expect((await service.status()).assist).toMatchObject({ available: false, threshold: null, accuracy: null });
    expect((await service.status()).assist.reason).toContain("No checkpoint has been evaluated yet");
  });

  it("stays locked for a checkpoint below 95% on held-out steps, and says what it scored", async () => {
    // THE MUTANT: compare with the wrong bar, or none. A 79% checkpoint then taps on its own.
    const { service } = setup({ runtime: installedRuntime(), activeEval: () => report({ accuracy: 0.79 }) });
    const gate = service.assistGate();
    expect(gate).toMatchObject({ available: false, accuracy: 0.79 });
    expect(gate.reason).toBe("The active checkpoint picks the right element 79% of the time on held-out steps. Assist needs 95%.");
  });

  it("stays locked when no confidence level reached the precision it needs", () => {
    const { service } = setup({ runtime: installedRuntime(), activeEval: () => report({ threshold: null }) });
    expect(service.assistGate()).toMatchObject({ available: false, reason: "No confidence level reached the precision Assist needs on held-out steps." });
  });

  it("opens for a checkpoint that earned it, with the threshold its evaluation fitted", () => {
    const { service } = setup({ runtime: installedRuntime(), activeEval: () => report() });
    expect(service.assistGate()).toEqual({ available: true, reason: null, threshold: 0.82, accuracy: 0.96 });
  });

  it("stays locked while the server serves a checkpoint other than the one evaluated", async () => {
    const { service } = setup({ runtime: installedRuntime(), activeEval: () => report({ checkpoint: "local:2026-09-29" }) });
    await service.setMode("shadow");
    await until(() => service.checkpoint() !== null);
    expect(service.assistGate()).toMatchObject({ available: false, reason: "Laya is serving english@55cf4c4, but the evaluation is of local:2026-09-29." });
  });

  it("refuses the switch to Assist while it is locked, with the same sentence, and keeps the mode", async () => {
    const { service, settings } = setup({ runtime: installedRuntime(), activeEval: () => report({ accuracy: 0.8 }) });
    await expect(service.setMode("assist")).rejects.toThrow("Assist needs 95%");
    expect(settings.get(LAYA_MODE_KEY)).toBeUndefined();
    expect(service.currentMode()).toBe("off");
  });

  it("takes the switch to Assist once earned, and runs Laya the way Shadow does", async () => {
    const { service, settings, runtime } = setup({ runtime: installedRuntime(), activeEval: () => report() });
    await service.setMode("assist");
    expect(settings.get(LAYA_MODE_KEY)).toBe("assist");
    expect(service.currentMode()).toBe("assist");
    // Assist is Shadow plus: the server starts, and the shadow keeps asking and logging.
    await until(() => service.client() !== null);
    expect(runtime!.starts).toHaveLength(1);
  });
});

/** A report as the eval harness writes one, with the numbers a test cares about. */
function evalReport(over: { accuracy?: number; checkpoint?: string; version?: string; threshold?: number | null } = {}): LayaEvalReport {
  return {
    v: 1, checkpoint: over.checkpoint ?? "english@55cf4c4", createdAt: "2026-09-29T07:00:00Z", prompt: 2,
    benchmark: { version: over.version ?? "b-1", split: "heldout", cases: 338, apps: ["Health", "Maps"] },
    target: { accuracy: over.accuracy ?? 0.42, n: 207, byApp: {}, assist: { threshold: over.threshold === undefined ? null : over.threshold, precision: 0, coverage: 0 }, notCopying: { accuracy: 0.4, n: 180, byApp: {} } },
    sensitive: { accuracy: 0.63, recall: 0.81, precision: 0.54, n: 65 },
    verify: { accuracy: 0.45, n: 66 },
    baseline: { sensitiveRule: { accuracy: 0.82, recall: 0.85 }, verifyRule: { accuracy: 0.8 } },
    latencyMs: { p50: 44, p90: 54 },
  };
}

/** What a finished training run leaves: weights, and its report beside them. */
function writeCheckpoint(checkpointsDir: string, name: string, report: LayaEvalReport): string {
  const dir = join(checkpointsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model.safetensors"), "weights");
  writeFileSync(join(dir, "eval.json"), JSON.stringify(report));
  return dir;
}

/** A trainer that writes a checkpoint scoring `accuracy`, reporting a step of progress on the way. */
function trainer(runtime: FakeRuntime, accuracy: number): Train & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async ({ name, onProgress }) => {
    calls.push(name);
    onProgress({ step: "training", detail: "Epoch 1, step 50 of 100", fraction: 0.5 });
    const report = evalReport({ accuracy, checkpoint: `local:${name}` });
    return { name, dir: writeCheckpoint(runtime.checkpointsDir, name, report), report };
  }) as Train & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("a checkpoint trained on this Mac", () => {
  const installedRuntime = () => fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: true });

  it("is served from its folder when it is the active one, and named local:<name> — the name every logged row carries", async () => {
    const runtime = installedRuntime();
    const dir = writeCheckpoint(runtime.checkpointsDir, "2026-09-29T07-12", evalReport({ accuracy: 0.61, checkpoint: "local:2026-09-29T07-12" }));
    const { service } = setup({ runtime, checkpoint: "2026-09-29T07-12" });
    await service.setMode("shadow");
    await until(() => service.checkpoint() !== null);
    expect(runtime.starts.at(-1)!.checkpoint).toBe(dir);
    expect(service.checkpoint()).toBe("local:2026-09-29T07-12");
    // Its own report is the one the gate and Settings read.
    expect(service.activeEval()!.target.accuracy).toBe(0.61);
    expect((await service.status()).evaluation).toMatchObject({ checkpoint: "local:2026-09-29T07-12", targetAccuracy: 0.61, targetNotCopying: 0.4, sensitiveRecall: 0.81, verifyAccuracy: 0.45 });
  });

  it("falls back to the download when the active checkpoint's weights are gone, with the download's report", async () => {
    const runtime = installedRuntime();
    const { service } = setup({ runtime, checkpoint: "gone", baseEval: () => evalReport({ accuracy: 0.42 }) });
    expect(service.activeCheckpoint()).toBeNull();
    await service.setMode("shadow");
    await until(() => service.checkpoint() !== null);
    expect(runtime.starts.at(-1)!.checkpoint).toBeUndefined();
    expect(service.checkpoint()).toBe("english@55cf4c4");
    expect(service.activeEval()!.target.accuracy).toBe(0.42);
  });

  it("puts a report's three numbers in the status, and nothing without a report", () => {
    expect(evaluationOf(null)).toBeNull();
    expect(evaluationOf(evalReport({ accuracy: 0.5 }))).toEqual({ checkpoint: "english@55cf4c4", createdAt: "2026-09-29T07:00:00Z", benchmark: "b-1", targetAccuracy: 0.5, targetNotCopying: 0.4, sensitiveRecall: 0.81, verifyAccuracy: 0.45 });
  });
});

describe("training", () => {
  const installedRuntime = () => fakeRuntime({ dir: tempDir("realm-laya-svc-"), installed: true });
  const trainingDone = (service: LayaService) => until(async () => ["done", "failed", "cancelled"].includes((await service.status()).training!.state));

  it("activates a checkpoint whose held-out score beats the active one's, and brings the server back on it", async () => {
    const runtime = installedRuntime();
    const train = trainer(runtime, 0.71);
    const { service, settings } = setup({ runtime, train, baseEval: () => evalReport({ accuracy: 0.42 }) });
    await service.setMode("shadow");
    await until(() => service.checkpoint() === "english@55cf4c4");
    const started = await service.train();
    expect(started.training).toMatchObject({ state: "running" });
    await trainingDone(service);
    const name = train.calls[0]!;
    expect((await service.status()).training).toMatchObject({ state: "done", checkpoint: `local:${name}`, activated: true, targetAccuracy: 0.71 });
    expect((await service.status()).training).toMatchObject({ reason: "It picks the right element 71% of the time on held-out steps, against 42%." });
    expect(settings.get(LAYA_CHECKPOINT_KEY)).toBe(name);
    // THE MUTANT: forget to restart, or restart on the old weights. The shadow would log the new name for the old model.
    await until(() => service.checkpoint() === `local:${name}`);
    expect(runtime.starts.at(-1)!.checkpoint).toBe(join(runtime.checkpointsDir, name));
    expect(service.activeEval()!.target.accuracy).toBe(0.71);
  });

  it("keeps the active checkpoint when the new one does not beat it, and deletes the new weights but not their report", async () => {
    const runtime = installedRuntime();
    writeCheckpoint(runtime.checkpointsDir, "old", evalReport({ accuracy: 0.8, checkpoint: "local:old" }));
    const train = trainer(runtime, 0.8);
    const { service, settings } = setup({ runtime, train, checkpoint: "old" });
    await service.train();
    await trainingDone(service);
    const name = train.calls[0]!;
    expect((await service.status()).training).toMatchObject({ state: "done", activated: false, reason: "It picks the right element 80% of the time on held-out steps, and the active checkpoint 80%." });
    expect(settings.get(LAYA_CHECKPOINT_KEY)).toBe("old");
    expect(existsSync(join(runtime.checkpointsDir, name))).toBe(false);
    expect(JSON.parse(readFileSync(join(runtime.dir, "train", name, "eval.json"), "utf8")).target.accuracy).toBe(0.8);
    expect(existsSync(join(runtime.checkpointsDir, "old", "model.safetensors"))).toBe(true);
  });

  it("replaces the old checkpoint's weights once a new one is active, keeping one on disk", async () => {
    const runtime = installedRuntime();
    writeCheckpoint(runtime.checkpointsDir, "old", evalReport({ accuracy: 0.5, checkpoint: "local:old" }));
    const { service } = setup({ runtime, train: trainer(runtime, 0.6), checkpoint: "old" });
    await service.train();
    await trainingDone(service);
    expect(existsSync(join(runtime.checkpointsDir, "old"))).toBe(false);
  });

  it("reports its progress as it goes, and the server stays down while it runs", async () => {
    const runtime = installedRuntime();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = trainer(runtime, 0.6);
    const { service } = setup({ runtime, train: async (o) => { o.onProgress({ step: "training", detail: "Epoch 1, step 50 of 100", fraction: 0.5 }); await gate; return inner(o); } });
    await service.setMode("shadow");
    await until(() => service.client() !== null);
    await service.train();
    await until(async () => { const t = (await service.status()).training!; return t.state === "running" && t.fraction === 0.5; });
    expect((await service.status()).training).toMatchObject({ step: "training", detail: "Epoch 1, step 50 of 100" });
    expect(service.client()).toBeNull();
    expect(await state(service)).toEqual({ state: "off" });
    await expect(service.train()).rejects.toMatchObject({ code: "LAYA_TRAINING" });
    // Switching Shadow on again mid-run does not start a second model beside the one training.
    const starts = runtime.starts.length;
    await service.setMode("shadow");
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.starts).toHaveLength(starts);
    release();
    await trainingDone(service);
    await until(() => service.client() !== null);
  });

  it("a failed run says why in the trainer's words, and leaves no weights behind", async () => {
    const runtime = installedRuntime();
    let name = "";
    const { service, settings } = setup({ runtime, train: async (o) => {
      name = o.name;
      writeCheckpoint(runtime.checkpointsDir, o.name, evalReport());
      throw new LayaStepError("train", "RuntimeError: MPS backend out of memory", "Traceback …\nRuntimeError: MPS backend out of memory");
    } });
    await service.train();
    await trainingDone(service);
    expect((await service.status()).training).toMatchObject({ state: "failed", reason: "RuntimeError: MPS backend out of memory", detail: "Traceback …\nRuntimeError: MPS backend out of memory" });
    expect(existsSync(join(runtime.checkpointsDir, name))).toBe(false);
    expect(settings.get(LAYA_CHECKPOINT_KEY)).toBeUndefined();
  });

  it("cancel stops the run; nothing it made is kept and the active checkpoint stays", async () => {
    const runtime = installedRuntime();
    const { service, settings } = setup({ runtime, train: (o) => new Promise((_, reject) => {
      writeCheckpoint(runtime.checkpointsDir, o.name, evalReport({ accuracy: 0.99 }));
      o.signal.addEventListener("abort", () => reject(new LayaStepError("train", "Stopped.", "")));
    }) });
    await service.train();
    await until(async () => existsSync(runtime.checkpointsDir));
    await service.cancelTraining();
    await trainingDone(service);
    expect((await service.status()).training).toMatchObject({ state: "cancelled" });
    expect(settings.get(LAYA_CHECKPOINT_KEY)).toBeUndefined();
  });

  it("refuses to train before an install, or in a build that cannot", async () => {
    const notInstalled = fakeRuntime({ dir: tempDir("realm-laya-svc-") });
    await expect(setup({ runtime: notInstalled, train: trainer(notInstalled, 0.9) }).service.train()).rejects.toMatchObject({ code: "LAYA_NOT_INSTALLED" });
    await expect(setup({ runtime: installedRuntime() }).service.train()).rejects.toMatchObject({ code: "LAYA_UNAVAILABLE" });
    await expect(setup({ runtime: null }).service.train()).rejects.toMatchObject({ code: "LAYA_UNAVAILABLE" });
  });

  it("names a second run in the same minute apart from the first", async () => {
    const runtime = installedRuntime();
    const train = trainer(runtime, 0.3);
    const { service } = setup({ runtime, train, baseEval: () => evalReport({ accuracy: 0.9 }) });
    await service.train();
    await trainingDone(service);
    // The first run lost, so only its report is kept; a folder of the same name still in the way
    // must not be written over.
    mkdirSync(join(runtime.checkpointsDir, train.calls[0]!), { recursive: true });
    await service.train();
    await until(() => train.calls.length === 2);
    expect(train.calls[1]).toBe(`${train.calls[0]}-2`);
  });
});
