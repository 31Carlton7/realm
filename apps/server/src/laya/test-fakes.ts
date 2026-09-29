import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { PythonSearch } from "./python";
import type { InstallProgress, LayaProcess, LayaRuntime } from "./runtime";

/**
 * Stand-ins for the two things a suite must never run: Python, and a real `laya-serve`.
 *
 * The fake server speaks the real wire (`GET /health`, `POST /v1/systemone`, the bearer check, the
 * Jev answer shapes), so the client, the service and the shadow are exercised against HTTP rather
 * than against a mocked method.
 */

export type Asked = { path: string; auth: string | undefined; body: { state: string; questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>; model?: string } };

export type FakeLaya = {
  port: number;
  asked: Asked[];
  /** Stop answering altogether (requests hang), or answer again. */
  hang(on: boolean): void;
  close(): Promise<void>;
};

export async function fakeLayaServer(o: {
  port?: number;
  apiKey?: string;
  /** Pick the answer for a choice; the default is the LAST option, so a test can tell it from order. */
  choose?: (criteria: Record<string, string>, state: string) => string;
  noul?: (state: string, qid: string) => number;
  health?: () => Record<string, unknown>;
  status?: number;
  /** Milliseconds to sit on a question before answering it, by its state. */
  delay?: (state: string) => number;
} = {}): Promise<FakeLaya> {
  const asked: Asked[] = [];
  let hanging = false;
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    if (req.url === "/health" && req.method === "GET") {
      if (hanging) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o.health?.() ?? {
        status: "ok", loaded: ["english"], revisions: { english: "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851" },
        device: "mps", device_is_preference: false, checkpoint_devices: { english: "mps" },
      }));
      return;
    }
    if (req.url === "/v1/systemone" && req.method === "POST") {
      const parsed = JSON.parse(body) as Asked["body"];
      asked.push({ path: req.url, auth: req.headers.authorization, body: parsed });
      if (hanging) return;
      const wait = o.delay?.(parsed.state) ?? 0;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (o.apiKey && req.headers.authorization !== `Bearer ${o.apiKey}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "invalid or missing bearer token" }));
        return;
      }
      if (o.status && o.status !== 200) {
        res.writeHead(o.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "question 'target': a choice question needs at least one criterion" }));
        return;
      }
      const answers: Record<string, unknown> = {};
      for (const [qid, q] of Object.entries(parsed.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria ?? {});
          const choice = o.choose?.(q.criteria ?? {}, parsed.state) ?? keys[keys.length - 1]!;
          answers[qid] = {
            type: "choice", choice,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])),
            confidence: 0.42, answer_confidence: 0.9, action: { act_probability: 1 },
          };
        } else {
          const p = o.noul?.(parsed.state, qid) ?? 0.25;
          answers[qid] = { type: "noul", noul: p, confidence: Math.max(p, 1 - p), answer_confidence: Math.max(p, 1 - p), action: { act_probability: 1 } };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "laya-rl-agent", answers, usage: { input_tokens: 10, output_tokens: 0 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    asked,
    hang: (on) => { hanging = on; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => resolve(body));
  });
}

export type FakeRuntime = LayaRuntime & {
  starts: { port: number; apiKey: string }[];
  installs: number;
  pythonLooks: number;
  /** The fake server behind the current start, once it is up. */
  server(): FakeLaya | null;
  /** The running process dies, printing `output`. */
  crash(output: string, code?: number): Promise<void>;
  setInstalled(v: boolean): void;
};

/**
 * A runtime that runs no Python. `start` brings up a fake `laya-serve` on the port the service chose,
 * holding the service's key; `crash` is the process dying under it. `serve: false` makes every start
 * die at once, the way a checkpoint that will not load does.
 */
export function fakeRuntime(o: {
  dir: string;
  installed?: boolean;
  python?: PythonSearch;
  install?: (onProgress: (p: InstallProgress) => void, signal: AbortSignal) => Promise<void>;
  serve?: boolean | (() => boolean);
  server?: Omit<Parameters<typeof fakeLayaServer>[0] & object, "port" | "apiKey">;
  unavailable?: string | null;
}): FakeRuntime {
  let installed = o.installed ?? false;
  let current: { server: FakeLaya | null; die: (e: { code: number | null; signal: string | null; output: string }) => void } | null = null;
  const rt: FakeRuntime = {
    dir: o.dir,
    logPath: join(o.dir, "decisions.jsonl"),
    unavailable: o.unavailable ?? null,
    starts: [],
    installs: 0,
    pythonLooks: 0,
    async findPython() {
      rt.pythonLooks++;
      return o.python ?? { found: { path: "/opt/homebrew/bin/python3.13", version: "3.13.12" }, rejected: [] };
    },
    installed: () => installed,
    async install(_python, onProgress, signal) {
      rt.installs++;
      if (o.install) await o.install(onProgress, signal);
      installed = true;
    },
    async freePort() {
      const s = createServer();
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
      const port = (s.address() as { port: number }).port;
      await new Promise<void>((resolve) => s.close(() => resolve()));
      return port;
    },
    start({ port, apiKey }): LayaProcess {
      rt.starts.push({ port, apiKey });
      let die!: (e: { code: number | null; signal: string | null; output: string }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve) => { die = resolve; });
      const run: { server: FakeLaya | null; die: typeof die } = { server: null, die };
      current = run;
      const serve = typeof o.serve === "function" ? o.serve() : o.serve ?? true;
      if (!serve) {
        setTimeout(() => die({ code: 1, signal: null, output: "Traceback (most recent call last):\nOSError: We couldn't connect to 'https://huggingface.co' to load the files, and couldn't find them in the cached files.\n" }), 5);
      } else {
        void fakeLayaServer({ ...o.server, port, apiKey }).then((s) => { run.server = s; });
      }
      return {
        exited,
        async stop() {
          await run.server?.close();
          die({ code: null, signal: "SIGTERM", output: "" });
        },
      };
    },
    server: () => current?.server ?? null,
    async crash(output, code = 1) {
      const run = current;
      if (!run) return;
      await run.server?.close();
      run.die({ code, signal: null, output });
    },
    setInstalled: (v) => { installed = v; },
  };
  return rt;
}

/** Poll until `fn` holds; a suite never sleeps a guessed amount. */
export async function until(fn: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
