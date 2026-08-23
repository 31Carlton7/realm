import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type JsonRpcId = number | string;
export type JsonRpcNotification = { method: string; params: unknown };
export type JsonRpcServerRequest = { id: JsonRpcId; method: string; params: unknown };

/** A JSON-RPC `error` response. `data` is preserved verbatim — Codex hides `{action:"relogin"}` there. */
export class JsonRpcCallError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown) {
    super(message);
    this.name = "JsonRpcCallError";
  }
}

/**
 * Rejects with `message` if `p` has not settled within `ms`.
 *
 * The underlying request is NOT cancelled — JSON-RPC has no cancel — it is simply abandoned; the peer's late
 * answer lands on an already-settled promise. Every unbounded call into a child process goes through this:
 * a child that spawns and then answers nothing must never leave a promise pending forever.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const STDERR_TAIL_LINES = 50;
const DISPOSE_KILL_TIMEOUT_MS = 2000;

export type StdioJsonRpcOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onNotification: (n: JsonRpcNotification) => void;
  /** MUST be answered with respond()/respondError() — an unanswered server request stalls the agent's turn forever. */
  onServerRequest: (r: JsonRpcServerRequest) => void;
  onStderr?: (line: string) => void;
  /** `disposed` is the reliable signal for "we caused this shutdown" vs "the child actually died" —
   *  branch on it, not on parsing `reason`, which is a free-form string for logs only. */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; reason: string; disposed: boolean }) => void;
};

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, shared by the Codex and ACP adapters.
 *
 * Inbound frames are dispatched by SHAPE, never by id lookup: the peer numbers its own requests from 0 in an
 * INDEPENDENT id space that overlaps ours (verified on both protocols). `{id, method}` is a server request;
 * `{id, result|error}` is a response to us; `{method}` without an id is a notification.
 *
 * Codex responses additionally omit the `jsonrpc` field, so nothing here validates it.
 */
export class StdioJsonRpc {
  private child: ChildProcess;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private outBuf = "";
  private errBuf = "";
  private dead: Error | null = null;
  private childExited = false;
  private _stderrTail: string[] = [];

  constructor(private o: StdioJsonRpcOptions, deps: { spawn?: typeof nodeSpawn } = {}) {
    const spawnFn = deps.spawn ?? nodeSpawn;
    this.child = spawnFn(o.command, o.args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...o.env } });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (c: string) => this.onStdout(c));
    this.child.stderr?.on("data", (c: string) => this.onStderrChunk(c));
    // Stream 'error' (EPIPE, ERR_STREAM_WRITE_AFTER_END, ...) is otherwise unhandled and crashes the whole
    // process with an uncaughtException. It isn't fatal to the RPC session by itself — 'exit' is what ends
    // that — so just surface it as a diagnostic.
    this.child.stdin?.on("error", (e: Error) => this.o.onStderr?.(`stdin error: ${e.message}`));
    this.child.stdout?.on("error", (e: Error) => this.o.onStderr?.(`stdout error: ${e.message}`));
    this.child.stderr?.on("error", (e: Error) => this.o.onStderr?.(`stderr error: ${e.message}`));
    this.child.on("error", (e: Error) => {
      this.childExited = true; // never actually started; nothing left to reap
      this.die(`failed to start ${o.command}: ${e.message}`, null, null, false);
    });
    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      this.die(`${o.command} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`, code, signal, false);
    });
  }

  get alive(): boolean { return this.dead === null; }
  get stderrTail(): readonly string[] { return [...this._stderrTail]; }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * Sends EOF — most CLI agents exit cleanly on stdin close — then waits briefly for the real process to
   * go away, escalating to SIGKILL if it hasn't. The child is not spawned detached, so a hard crash of
   * this process still orphans it; this only covers the graceful path.
   */
  async dispose(): Promise<void> {
    if (!this.dead) this.die("disposed", null, null, true);
    this.child.stdin?.end();
    await this.reap();
  }

  private reap(): Promise<void> {
    if (this.childExited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(killTimer); resolve(); };
      this.child.once("exit", finish);
      this.child.once("error", finish); // spawn never actually started; nothing more to wait for
      const killTimer = setTimeout(() => this.child.kill("SIGKILL"), DISPOSE_KILL_TIMEOUT_MS);
    });
  }

  private write(msg: unknown): void {
    // Guards synchronous throws only (e.g. writing after the stream is already destroyed); async write
    // failures surface via the stdin 'error' listener registered in the constructor instead.
    try { this.child.stdin?.write(JSON.stringify(msg) + "\n"); }
    catch { /* swallow: the 'error'/'exit' handlers already reject everything in flight */ }
  }

  private onStdout(chunk: string): void {
    this.outBuf += chunk;
    let i: number;
    while ((i = this.outBuf.indexOf("\n")) >= 0) {
      const line = this.outBuf.slice(0, i);
      this.outBuf = this.outBuf.slice(i + 1);
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; }
    catch { this.o.onStderr?.(`unparseable frame: ${line.slice(0, 200)}`); return; }

    const hasId = msg.id !== undefined && msg.id !== null;
    const id = msg.id as JsonRpcId;

    if (hasId && typeof msg.method === "string") { this.o.onServerRequest({ id, method: msg.method, params: msg.params }); return; }
    if (hasId && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(id);
      if (!p) { this.o.onStderr?.(`response for unknown request id ${String(id)}: ${line.slice(0, 200)}`); return; }
      this.pending.delete(id);
      if ("error" in msg) {
        const e = (msg.error ?? {}) as { code?: number; message?: string; data?: unknown };
        p.reject(new JsonRpcCallError(e.code ?? -32603, e.message ?? "request failed", e.data));
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") { this.o.onNotification({ method: msg.method, params: msg.params }); return; }
    this.o.onStderr?.(`unroutable frame: ${line.slice(0, 200)}`);
  }

  private onStderrChunk(chunk: string): void {
    this.errBuf += chunk;
    let i: number;
    while ((i = this.errBuf.indexOf("\n")) >= 0) {
      const line = this.errBuf.slice(0, i);
      this.errBuf = this.errBuf.slice(i + 1);
      if (!line.trim()) continue;
      this.o.onStderr?.(line);
      this._stderrTail.push(line);
      if (this._stderrTail.length > STDERR_TAIL_LINES) this._stderrTail.shift();
    }
  }

  private die(reason: string, code: number | null, signal: NodeJS.Signals | null, disposed: boolean): void {
    if (this.dead) return;
    this.dead = new Error(reason);
    for (const [, p] of this.pending) p.reject(this.dead);
    this.pending.clear();
    this.o.onExit({ code, signal, reason, disposed });
  }
}
