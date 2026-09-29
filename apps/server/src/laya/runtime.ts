import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import type { LayaInstallStep } from "@realm/contracts";
import { findPython, type PythonChoice, type PythonSearch } from "./python";

/**
 * The machine half of Laya: a Python environment Realm owns, the `laya-serve` process it runs, and the
 * files on disk. `LayaService` decides WHEN any of this happens; this only knows HOW, which is why a
 * test can hand the service a fake and spawn nothing (`createApp`'s `laya` option — only `main.ts`
 * passes the real one).
 *
 * Everything lives under `<REALM_HOME>/laya`: `venv/` (created from the interpreter `findPython`
 * picked), `hf/` (the checkpoint cache, as `HF_HOME`), `installed.json` (written last, so a half
 * install is never mistaken for a whole one) and the decision log.
 *
 * Facts about `laya-serve` this rests on, read from `laya/serve.py` 0.3.21 and checked by running it:
 *
 *  - **It takes no flags.** `main()` reads only environment variables, so `laya-serve --help` does not
 *    print help — it starts a server. `LAYA_HOST` defaults to `0.0.0.0`, which is why it is always
 *    set here, to `127.0.0.1`.
 *  - **An empty `LAYA_MODELS` preloads every checkpoint** — English, multilingual and typed-decisions,
 *    about 2.5 GB. Realm asks for `english` only: the base checkpoint the design measured, and the
 *    ~0.8 GB the install promises.
 *  - **`LAYA_REVISION=reviewed` pins** each checkpoint to the SHA in `laya.revisions.PINNED_REVISIONS`
 *    (`convaiinnovations/laya` → 55cf4c4e…), so the weights cannot change under a log that names them.
 *  - It answers `GET /health` and `POST /v1/systemone`, and nothing else; there is no `/predict`.
 */

/** The one package Realm installs, exactly. */
export const LAYA_REQUIREMENT = "laya[serve]==0.3.21";
/** The pinned English checkpoint's files, summed: model.safetensors (842,609,210) + tokenizer.json
 *  (3,583,228) + three small JSON files. The only honest denominator an install has. */
export const LAYA_CHECKPOINT_BYTES = 846_195_574;

/** Running the checkpoint download through laya's own names, so the repo and the pinned SHA are the
 *  ones `laya-serve` will ask for. The patterns are `Agent.__init__`'s for a root checkpoint. */
const DOWNLOAD = [
  "from huggingface_hub import snapshot_download",
  "from laya.revisions import PINNED_REVISIONS",
  "from laya.router import BUNDLE_REPO",
  "print(snapshot_download(BUNDLE_REPO, revision=PINNED_REVISIONS[BUNDLE_REPO], allow_patterns=['rl_agent_config.json', 'model.safetensors', 'tokenizer/*', 'encoder/*']))",
].join("\n");

/**
 * `laya-serve`, started as the console script starts it, plus a watchdog: when Realm's server goes
 * away without stopping it — a crash, a SIGKILL — the process is reparented and exits within a second,
 * instead of holding a gigabyte of weights and a port for nobody.
 *
 * Given a directory as its one argument, it serves that checkpoint under the name `english` instead of
 * the pinned download. `laya-serve` has no setting for a local checkpoint — `build_router` always
 * builds the published three — so its `build_router` is swapped for one that maps `english` to the
 * directory, the way `Router(models=…)` takes a path. Everything else is laya-serve's own `main`:
 * the same routes, the same key, the same single worker.
 */
const LAUNCH = [
  "import os, sys, threading, time",
  "parent = os.getppid()",
  "def watch():",
  "    while os.getppid() == parent:",
  "        time.sleep(1)",
  "    os._exit(0)",
  "threading.Thread(target=watch, daemon=True).start()",
  "if len(sys.argv) > 1:",
  "    import laya.serve",
  "    from laya.mcp.device import env_device",
  "    from laya.router import Router",
  "    def local_router(path=sys.argv[1]):",
  "        laya.serve._apply_thread_limit()",
  "        router = Router(models={'english': path}, device=env_device(), max_loaded=1)",
  "        router.preload(['english'])",
  "        return router",
  "    laya.serve.build_router = local_router",
  "from laya.serve import main",
  "sys.exit(main())",
].join("\n");

export type InstallProgress = { step: LayaInstallStep; detail: string; fraction: number | null };

/** A step that failed, with what the tool itself said: `reason` is its last line, verbatim. */
export class LayaStepError extends Error {
  constructor(readonly step: LayaInstallStep | "start" | "train", readonly reason: string, readonly detail: string) { super(reason); }
}

/** The pinned English checkpoint's commit (`laya.revisions.PINNED_REVISIONS`), the one training starts from. */
const PINNED_BASE_REVISION = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851";

export type LayaProcess = {
  /** Settles once, when the process has gone, with the tail of what it printed. */
  exited: Promise<{ code: number | null; signal: string | null; output: string }>;
  stop(): Promise<void>;
};

export type LayaRuntime = {
  /** `<REALM_HOME>/laya`. */
  dir: string;
  logPath: string;
  /** A sentence when this machine cannot run Laya at all; null when it can. */
  unavailable: string | null;
  findPython(): Promise<PythonSearch>;
  installed(): boolean;
  install(python: PythonChoice, onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void>;
  freePort(): Promise<number>;
  /** `checkpoint`: a checkpoint directory to serve instead of the pinned download (`LAUNCH`). */
  start(o: { port: number; apiKey: string; checkpoint?: string }): LayaProcess;
  /** `<dir>/checkpoints`: one directory for each checkpoint trained on this Mac. */
  checkpointsDir: string;
  /** The pinned download's own directory in the checkpoint cache — what training starts from — or
   *  null when it is not on disk. */
  baseCheckpoint(): string | null;
  /** Runs a script under the venv's interpreter, offline, handing each line it prints to `onLine`.
   *  Rejects with its last line when it fails, and stops it when `signal` fires. */
  runScript(o: { script: string; args: string[]; onLine: (line: string) => void; signal: AbortSignal }): Promise<void>;
};

export type RealLayaRuntimeOptions = {
  home: string;
  env?: NodeJS.ProcessEnv;
  arch?: string;
  spawnImpl?: typeof spawn;
  /** How long `stop` waits after SIGTERM before SIGKILL. Five seconds; a test shortens it. */
  stopGraceMs?: number;
};

/**
 * The runtime `main.ts` builds. Three environment variables are the dev and test seam, so a developer
 * can point Realm at an install that already exists rather than download two gigabytes again:
 *
 *  - `REALM_LAYA_VENV` — a venv with `laya[serve]` in it. Counted as installed; never installed into.
 *  - `REALM_LAYA_HF_HOME` — a Hugging Face cache that already holds the pinned checkpoint.
 *  - `REALM_LAYA_PYTHON` — the one interpreter an install may be made from (see `python.ts`).
 *
 * The product path sets none of them and gets everything under `<REALM_HOME>/laya`.
 */
export function realLayaRuntime(o: RealLayaRuntimeOptions): LayaRuntime {
  const env = o.env ?? process.env;
  const spawnImpl = o.spawnImpl ?? spawn;
  const dir = join(o.home, "laya");
  const devVenv = env.REALM_LAYA_VENV?.trim() || null;
  const venv = devVenv ?? join(dir, "venv");
  const hf = env.REALM_LAYA_HF_HOME?.trim() || join(dir, "hf");
  const marker = join(dir, "installed.json");
  const python = join(venv, "bin", "python");
  const arch = o.arch ?? process.arch;

  return {
    dir,
    logPath: join(dir, "decisions.jsonl"),
    unavailable: arch === "arm64" ? null : "Laya runs on Apple silicon only: PyTorch publishes no build for Intel Macs.",
    findPython: () => findPython({ env }),
    installed: () => (devVenv ? existsSync(join(devVenv, "bin", "laya-serve")) : existsSync(marker) && existsSync(python)),

    async install(from, onProgress, signal) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      onProgress({ step: "environment", detail: `Creating a Python ${from.version} environment`, fraction: null });
      // `--clear`: a venv a failed install left behind is replaced, not added to.
      await run("environment", from.path, ["-m", "venv", "--clear", venv], installEnv(env), signal);

      onProgress({ step: "packages", detail: "Resolving laya 0.3.21 and PyTorch", fraction: null });
      await run("packages", python, [
        "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off",
        // No cache: pip's would keep a second copy of PyTorch in ~/Library/Caches. Wheels only: a
        // source build needs a compiler and fails an hour later instead of now.
        "--no-cache-dir", "--only-binary=:all:", LAYA_REQUIREMENT,
      ], installEnv(env), signal, (line) => {
        const m = /^\s*(Collecting|Downloading|Installing collected packages)\b(.*)$/.exec(line);
        if (m) onProgress({ step: "packages", detail: `${m[1]}${m[2]}`.slice(0, 160), fraction: null });
      });

      onProgress({ step: "model", detail: "Downloading the checkpoint", fraction: 0 });
      // The bytes on disk against the known total. `hub/` only: hf_xet's chunk cache sits beside it and
      // would count some bytes twice.
      const poll = setInterval(() => {
        const got = bytesUnder(join(hf, "hub"));
        onProgress({ step: "model", detail: "Downloading the checkpoint", fraction: Math.min(0.99, got / LAYA_CHECKPOINT_BYTES) });
      }, 1_000);
      try {
        await run("model", python, ["-c", DOWNLOAD], { ...installEnv(env), HF_HOME: hf, HF_HUB_DISABLE_TELEMETRY: "1" }, signal);
      } finally {
        clearInterval(poll);
      }
      writeFileSync(marker, JSON.stringify({ laya: LAYA_REQUIREMENT, checkpoint: "convaiinnovations/laya@reviewed", python: from.version, at: new Date().toISOString() }) + "\n");
    },

    freePort: () => new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    }),

    checkpointsDir: join(dir, "checkpoints"),

    baseCheckpoint() {
      const snapshots = join(hf, "hub", "models--convaiinnovations--laya", "snapshots");
      let names: string[];
      try { names = readdirSync(snapshots); } catch { return null; }
      const whole = names.map((n) => join(snapshots, n)).filter((d) => existsSync(join(d, "rl_agent_config.json")) && existsSync(join(d, "model.safetensors")));
      return whole.find((d) => basename(d) === PINNED_BASE_REVISION) ?? whole[0] ?? null;
    },

    runScript({ script, args, onLine, signal }) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new LayaStepError("train", "Stopped.", ""));
        let child: ChildProcess;
        try {
          child = spawnImpl(python, [script, ...args], { env: trainEnv(env, hf), stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
          return reject(new LayaStepError("train", e instanceof Error ? e.message : String(e), ""));
        }
        const tail = new Tail();
        let partial = "";
        child.stdout?.on("data", (b: Buffer) => {
          const text = b.toString();
          tail.push(text);
          const lines = (partial + text).split("\n");
          partial = lines.pop() ?? "";
          for (const l of lines) onLine(l);
        });
        child.stderr?.on("data", (b: Buffer) => tail.push(b.toString()));
        let hard: NodeJS.Timeout | null = null;
        const abort = () => {
          child.kill("SIGTERM");
          hard = setTimeout(() => child.kill("SIGKILL"), o.stopGraceMs ?? 5_000);
        };
        signal.addEventListener("abort", abort, { once: true });
        child.on("error", (e) => { signal.removeEventListener("abort", abort); reject(new LayaStepError("train", e.message, tail.text())); });
        child.on("close", (code, sig) => {
          signal.removeEventListener("abort", abort);
          if (hard) clearTimeout(hard);
          if (partial) onLine(partial);
          if (code === 0 && !signal.aborted) return resolve();
          reject(new LayaStepError("train", signal.aborted ? "Stopped." : tail.lastLine() || `exited with ${sig ?? `code ${code}`}`, tail.text()));
        });
      });
    },

    start({ port, apiKey, checkpoint }) {
      let child: ChildProcess;
      try {
        child = spawnImpl(python, ["-c", LAUNCH, ...(checkpoint ? [checkpoint] : [])], { env: serveEnv(env, { port, apiKey, hf }), stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        // A venv the dev seam points at can hold an interpreter this CPU cannot run, and spawn throws
        // for that rather than emitting — so it arrives as an exit, like every other way this dies.
        const output = e instanceof Error ? e.message : String(e);
        return { exited: Promise.resolve({ code: null, signal: null, output }), stop: async () => {} };
      }
      return supervise(child, o.stopGraceMs ?? 5_000);
    },
  };

  /** One install step as a child process; rejects with the step's own last line. */
  function run(step: LayaInstallStep, file: string, args: string[], childEnv: NodeJS.ProcessEnv, signal: AbortSignal, onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new LayaStepError(step, "Stopped because Realm is quitting.", ""));
      let child: ChildProcess;
      try {
        child = spawnImpl(file, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        // spawn throws, rather than emitting, for a binary the CPU cannot run.
        return reject(new LayaStepError(step, e instanceof Error ? e.message : String(e), ""));
      }
      const tail = new Tail();
      let partial = "";
      const take = (b: Buffer) => {
        const text = b.toString();
        tail.push(text);
        if (!onLine) return;
        const lines = (partial + text).split("\n");
        partial = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      const abort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", (e) => { signal.removeEventListener("abort", abort); reject(new LayaStepError(step, e.message, tail.text())); });
      child.on("close", (code, sig) => {
        signal.removeEventListener("abort", abort);
        if (code === 0) return resolve();
        const reason = signal.aborted ? "Stopped because Realm is quitting." : tail.lastLine() || `exited with ${sig ?? `code ${code}`}`;
        reject(new LayaStepError(step, reason, tail.text()));
      });
    });
  }
}

/** A running `laya-serve`. `stop` asks with SIGTERM — uvicorn drains in well under a second — and
 *  insists after five. */
function supervise(child: ChildProcess, graceMs: number): LayaProcess {
  const tail = new Tail();
  child.stdout?.on("data", (b: Buffer) => tail.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => tail.push(b.toString()));
  const exited = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve) => {
    child.once("error", (e) => { tail.push(`${e.message}\n`); resolve({ code: null, signal: null, output: tail.text() }); });
    child.once("close", (code, signal) => resolve({ code, signal, output: tail.text() }));
  });
  return {
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), graceMs);
      await exited;
      clearTimeout(hard);
    },
  };
}

/** What `laya-serve` runs with — built from a short list rather than inherited whole, so a `LAYA_*` or
 *  `HF_*` variable in the user's shell cannot quietly change what Realm runs or where it listens. */
export function serveEnv(env: NodeJS.ProcessEnv, o: { port: number; apiKey: string; hf: string }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) if (env[k] !== undefined) out[k] = env[k];
  return {
    ...out,
    LAYA_HOST: "127.0.0.1",
    LAYA_PORT: String(o.port),
    // MPS where the Mac has it. Laya falls back to CPU on its own when it does not, and /health says
    // which it got — that is the device Settings shows, not this request.
    LAYA_DEVICE: "mps",
    LAYA_PRELOAD: "1",
    LAYA_MODELS: "english",
    LAYA_REVISION: "reviewed",
    // Loopback is not the same as private: any process on the Mac can reach 127.0.0.1. The key is
    // minted per start and only Realm's client holds it.
    LAYA_API_KEY: o.apiKey,
    LAYA_MAX_CONCURRENT: "4",
    LAYA_LOG_LEVEL: "warning",
    HF_HOME: o.hf,
    // The checkpoint was fetched by the install. From here on nothing reaches the network: a request
    // that routed to a checkpoint that is not on disk fails instead of downloading it.
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TOKENIZERS_PARALLELISM: "false",
    PYTHONUNBUFFERED: "1",
  };
}

/** What a training run runs with: `serveEnv`'s short list, the same cache, offline — and MPS allowed
 *  to hand an operation it lacks to the CPU rather than fail the run an hour in. */
export function trainEnv(env: NodeJS.ProcessEnv, hf: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"]) if (env[k] !== undefined) out[k] = env[k];
  return {
    ...out,
    HF_HOME: hf,
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TOKENIZERS_PARALLELISM: "false",
    PYTHONUNBUFFERED: "1",
    PYTORCH_ENABLE_MPS_FALLBACK: "1",
  };
}

/** The installer runs with the user's environment — a pip index or a proxy set there is meant — minus
 *  the variables that point a Python at somebody else's packages. */
function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "PYTHONUSERBASE", "PIP_USER", "PIP_REQUIRE_VIRTUALENV"]) delete out[k];
  return out;
}

function bytesUnder(root: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      // Symlinks are the snapshot's pointers into blobs/: counting them would count every file twice.
      else if (e.isFile()) { try { total += statSync(p).size; } catch { /* went away mid-walk */ } }
    }
  };
  walk(root);
  return total;
}

/** The last 16 KB a process printed: enough for a traceback, bounded however long it runs. */
class Tail {
  private buf = "";
  push(text: string): void {
    this.buf = (this.buf + text).slice(-16_384);
  }
  text(): string {
    return this.buf;
  }
  /** The last line with anything on it — where Python puts the exception and pip its ERROR. */
  lastLine(): string {
    return this.buf.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  }
}
