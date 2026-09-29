import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tempDir } from "@realm/test-utils";
import { LAYA_REQUIREMENT, LayaStepError, realLayaRuntime, serveEnv, type InstallProgress, type LayaProcess } from "./runtime";
import { until } from "./test-fakes";

/**
 * The runtime at the process boundary, with a stand-in interpreter: a Node script where `python`
 * would be, which writes down every call and plays each part — `-m venv`, `-m pip`, the checkpoint
 * download, and `laya-serve` answering /health on whatever address it was told to bind. No Python
 * runs, nothing is downloaded. What must die: a bind to anything but 127.0.0.1, an install that runs
 * before it is asked, a pip call that could build from source or fill the user's cache, a failure
 * that loses the tool's own words, and a process left running after stop.
 */

const STUB = (log: string) => `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), http = require("http");
const LOG = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const pick = (k) => process.env[k];
fs.appendFileSync(LOG, JSON.stringify({ self: process.argv[1], args, env: Object.fromEntries(["LAYA_HOST", "LAYA_PORT", "LAYA_MODELS", "LAYA_REVISION", "LAYA_DEVICE", "LAYA_PRELOAD", "LAYA_API_KEY", "HF_HOME", "HF_HUB_OFFLINE", "HF_TOKEN", "PYTHONPATH"].map((k) => [k, pick(k) ?? null])) }) + "\\n");
if (args[0] === "-m" && args[1] === "venv") {
  const dir = args[args.length - 1];
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.copyFileSync(process.argv[1], path.join(dir, "bin", "python"));
  fs.chmodSync(path.join(dir, "bin", "python"), 0o755);
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "pip") {
  console.log("Collecting laya[serve]==0.3.21");
  console.log("  Downloading torch-2.14.0-cp313-cp313-macosx_14_0_arm64.whl (78.9 MB)");
  if (fs.existsSync(LOG + ".fail-pip")) { console.error("ERROR: No matching distribution found for laya[serve]==0.3.21"); process.exit(1); }
  console.log("Installing collected packages: torch, laya");
  process.exit(0);
}
if (args[0] === "-c" && args[1].includes("snapshot_download")) {
  const d = path.join(process.env.HF_HOME, "hub", "models--convaiinnovations--laya", "blobs");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "weights"), Buffer.alloc(1024));
  process.exit(0);
}
if (args[0] === "-c" && args[1].includes("laya.serve")) {
  const s = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "application/json" }); r.end("{}"); });
  s.listen(Number(process.env.LAYA_PORT), process.env.LAYA_HOST);
  if (fs.existsSync(LOG + ".ignore-term")) process.on("SIGTERM", () => {});
  else process.on("SIGTERM", () => { s.close(); process.exit(0); });
  return;
}
process.exit(2);
`;

type Call = { self: string; args: string[]; env: Record<string, string | null> };

function stubPython() {
  const dir = tempDir("realm-laya-rt-");
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "python3.13");
  writeFileSync(bin, STUB(log));
  chmodSync(bin, 0o755);
  return {
    bin, log,
    calls: (): Call[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : []),
    failPip: () => writeFileSync(`${log}.fail-pip`, ""),
    ignoreTerm: () => writeFileSync(`${log}.ignore-term`, ""),
  };
}

const procs: LayaProcess[] = [];
afterEach(async () => { for (const p of procs.splice(0)) await p.stop(); });

describe("building the runtime", () => {
  it("spawns nothing, and says nothing is installed, until it is asked to do something", () => {
    const spawned: string[] = [];
    const home = tempDir("realm-laya-rt-");
    const rt = realLayaRuntime({ home, env: { PATH: process.env.PATH }, spawnImpl: ((file: string) => { spawned.push(file); throw new Error("no"); }) as unknown as typeof spawn });
    expect(rt.installed()).toBe(false);
    expect(rt.dir).toBe(join(home, "laya"));
    expect(rt.logPath).toBe(join(home, "laya", "decisions.jsonl"));
    expect(spawned).toEqual([]);
  });

  it("is unavailable on an Intel Mac, with the reason", () => {
    expect(realLayaRuntime({ home: tempDir("realm-laya-rt-"), arch: "x64" }).unavailable).toMatch(/Apple silicon only/);
    expect(realLayaRuntime({ home: tempDir("realm-laya-rt-"), arch: "arm64" }).unavailable).toBeNull();
  });
});

describe("the laya-serve environment", () => {
  const env = serveEnv({ PATH: "/bin", HOME: "/Users/u", LAYA_HOST: "0.0.0.0", LAYA_MODELS: "", HF_TOKEN: "hf_secret", HF_HUB_OFFLINE: "0", PYTHONPATH: "/elsewhere" }, { port: 4321, apiKey: "key", hf: "/h/laya/hf" });

  it("binds to 127.0.0.1 — laya-serve's own default is 0.0.0.0 — whatever the user's shell says", () => {
    expect(env.LAYA_HOST).toBe("127.0.0.1");
    expect(env.LAYA_PORT).toBe("4321");
  });

  it("loads the English checkpoint alone, at the reviewed revision, and never reaches the network", () => {
    expect(env).toMatchObject({ LAYA_MODELS: "english", LAYA_REVISION: "reviewed", LAYA_PRELOAD: "1", LAYA_DEVICE: "mps", HF_HOME: "/h/laya/hf", HF_HUB_OFFLINE: "1", LAYA_API_KEY: "key" });
  });

  it("carries none of the user's HF_ or PYTHON variables", () => {
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

describe("running laya-serve", () => {
  it("starts the venv's interpreter on 127.0.0.1 and the port it was given, and stop ends it", async () => {
    const py = stubPython();
    const venv = join(tempDir("realm-laya-rt-"), "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "bin", "python"), readFileSync(py.bin));
    chmodSync(join(venv, "bin", "python"), 0o755);
    writeFileSync(join(venv, "bin", "laya-serve"), "");
    const rt = realLayaRuntime({ home: tempDir("realm-laya-rt-"), env: { PATH: process.env.PATH, REALM_LAYA_VENV: venv, REALM_LAYA_HF_HOME: "/cache/hf" } });
    expect(rt.installed()).toBe(true);
    const port = await rt.freePort();
    const proc = rt.start({ port, apiKey: "k" });
    procs.push(proc);
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
    const call = py.calls().find((c) => c.args[0] === "-c")!;
    expect(call.self).toBe(join(venv, "bin", "python"));
    // Run as the console script runs it, under a watchdog that ends it if Realm's server disappears.
    // The watchdog thread is STARTED, and before laya.serve takes the main thread for good.
    expect(call.args[1]).toMatch(/threading\.Thread\(target=watch, daemon=True\)\.start\(\)\nfrom laya\.serve import main\nsys\.exit\(main\(\)\)$/);
    expect(call.args[1]).toContain("while os.getppid() == parent:");
    expect(call.env).toMatchObject({ LAYA_HOST: "127.0.0.1", LAYA_PORT: String(port), HF_HOME: "/cache/hf", HF_HUB_OFFLINE: "1" });
    await proc.stop();
    expect((await proc.exited).signal ?? (await proc.exited).code).toBeDefined();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("kills a process that will not stop when asked", async () => {
    const py = stubPython();
    py.ignoreTerm();
    const venv = join(tempDir("realm-laya-rt-"), "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "bin", "python"), readFileSync(py.bin));
    chmodSync(join(venv, "bin", "python"), 0o755);
    writeFileSync(join(venv, "bin", "laya-serve"), "");
    const rt = realLayaRuntime({ home: tempDir("realm-laya-rt-"), env: { PATH: process.env.PATH, REALM_LAYA_VENV: venv }, stopGraceMs: 100 });
    const port = await rt.freePort();
    const proc = rt.start({ port, apiKey: "k" });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
    // THE MUTANT: SIGTERM alone. A laya-serve wedged in a forward pass would outlive the app holding
    // a gigabyte of weights and a port.
    const stopped = await Promise.race([proc.stop().then(() => "stopped"), new Promise((r) => setTimeout(() => r("still running"), 2_000))]);
    expect(stopped).toBe("stopped");
    expect((await proc.exited).signal).toBe("SIGKILL");
  });

  it("reports an interpreter the CPU cannot run as an exit, not a crash of the server", async () => {
    const rt = realLayaRuntime({ home: tempDir("realm-laya-rt-"), spawnImpl: (() => { throw Object.assign(new Error("spawn Unknown system error -86"), { errno: -86 }); }) as unknown as typeof spawn });
    const exit = await rt.start({ port: 1, apiKey: "k" }).exited;
    expect(exit.output).toBe("spawn Unknown system error -86");
  });
});

describe("installing", () => {
  it("makes a venv, installs exactly laya[serve]==0.3.21 from wheels without a cache, fetches the checkpoint, then marks it done", async () => {
    const py = stubPython();
    const home = tempDir("realm-laya-rt-");
    const rt = realLayaRuntime({ home, env: { PATH: process.env.PATH, PYTHONPATH: "/elsewhere" } });
    const progress: InstallProgress[] = [];
    await rt.install({ path: py.bin, version: "3.13.12" }, (p) => progress.push(p), new AbortController().signal);

    const [venv, pip, model] = py.calls();
    expect(venv!.self).toBe(py.bin);
    expect(venv!.args).toEqual(["-m", "venv", "--clear", join(home, "laya", "venv")]);
    expect(pip!.self).toBe(join(home, "laya", "venv", "bin", "python"));
    expect(pip!.args).toEqual(expect.arrayContaining(["-m", "pip", "install", "--only-binary=:all:", "--no-cache-dir", LAYA_REQUIREMENT]));
    expect(LAYA_REQUIREMENT).toBe("laya[serve]==0.3.21");
    // A PYTHONPATH in the user's shell would point the new venv at somebody else's packages.
    expect(pip!.env.PYTHONPATH).toBeNull();
    expect(model!.args[1]).toContain("PINNED_REVISIONS[BUNDLE_REPO]");
    expect(model!.env.HF_HOME).toBe(join(home, "laya", "hf"));

    expect(progress.map((p) => p.step)).toEqual(expect.arrayContaining(["environment", "packages", "model"]));
    expect(progress.map((p) => p.detail)).toContain("Downloading torch-2.14.0-cp313-cp313-macosx_14_0_arm64.whl (78.9 MB)");
    expect(existsSync(join(home, "laya", "installed.json"))).toBe(true);
    expect(rt.installed()).toBe(true);
  });

  it("fails with the installer's last line, verbatim, and is not marked installed", async () => {
    const py = stubPython();
    py.failPip();
    const home = tempDir("realm-laya-rt-");
    const rt = realLayaRuntime({ home, env: { PATH: process.env.PATH } });
    const failure = await rt.install({ path: py.bin, version: "3.13.12" }, () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LayaStepError);
    expect(failure).toMatchObject({ step: "packages", reason: "ERROR: No matching distribution found for laya[serve]==0.3.21" });
    expect((failure as LayaStepError).detail).toContain("Collecting laya[serve]==0.3.21");
    expect(rt.installed()).toBe(false);
  });

  it("stops at once when Realm quits mid-install", async () => {
    const py = stubPython();
    const abort = new AbortController();
    abort.abort();
    const rt = realLayaRuntime({ home: tempDir("realm-laya-rt-"), env: { PATH: process.env.PATH } });
    await expect(rt.install({ path: py.bin, version: "3.13.12" }, () => {}, abort.signal)).rejects.toMatchObject({ reason: "Stopped because Realm is quitting." });
    expect(py.calls()).toEqual([]);
  });
});
