import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { LayaStatus } from "@realm/contracts";
import { DecisionLog } from "./log";
import { LAYA_MODE_KEY, LayaService, p50Of, type LayaTiming } from "./service";
import { LayaStepError } from "./runtime";
import { fakeRuntime, until, type FakeRuntime } from "./test-fakes";

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

function setup(o: { runtime?: FakeRuntime | null; mode?: "off" | "shadow"; timing?: Partial<LayaTiming> } = {}) {
  const dir = tempDir("realm-laya-svc-");
  const runtime = o.runtime === undefined ? fakeRuntime({ dir }) : o.runtime;
  const settings = new Map<string, unknown>(o.mode ? [[LAYA_MODE_KEY, o.mode]] : []);
  const published: LayaStatus[] = [];
  const log = new DecisionLog({ path: join(dir, "decisions.jsonl") });
  const service = new LayaService({
    runtime, log, timing: { ...FAST, ...o.timing },
    settings: { get: (k) => settings.get(k) ?? null, set: (k, v) => { settings.set(k, v); } },
    publish: (s) => { published.push(s); },
  });
  services.push(service);
  return { service, runtime, settings, published, log, dir };
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

describe("p50", () => {
  it("is the median of the round trips, so one cold question does not speak for the rest", () => {
    expect(p50Of([])).toBeNull();
    expect(p50Of([35])).toBe(35);
    expect(p50Of([30, 1_200, 40])).toBe(40);
    expect(p50Of([10, 20, 30, 41])).toBe(25);
  });
});
