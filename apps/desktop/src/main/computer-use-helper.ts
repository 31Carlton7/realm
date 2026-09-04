import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Electron main's client for the native accessibility helper (`native/AxHelper.swift`).
 *
 * Newline-delimited JSON over the child's stdio, request/response by id. This is a purpose-built
 * client rather than `@realm/adapters`' `StdioJsonRpc` for two reasons: that package is not a
 * dependency of the desktop app and pulling it in would drag the Claude Agent SDK into the Electron
 * main bundle, and its whole reason for existing — bidirectional traffic, where the peer raises
 * requests of its own — is the half this protocol deliberately does not have. The helper only ever
 * answers.
 *
 * The child is spawned LAZILY, on the first op, and not at launch. It is a process that can read
 * other applications' windows and post synthetic input; it should exist while an agent is actually
 * driving something and not a moment before, and most sessions never touch these tools at all.
 */

/** One in-flight request. */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * How long one helper call may take. A tree walk on a large app is the slow case and runs in
 * hundreds of milliseconds; the activation wait plus a screenshot is the other. Thirty seconds means
 * the helper is wedged against an app that stopped answering, and the agent deserves an answer.
 */
const CALL_TIMEOUT_MS = 30_000;

/** Where the compiled helper lives — dev tree first, then the packaged Resources directory, mirroring
 *  every other native helper. `null` means this build has none (non-mac, or swiftc was unavailable at
 *  build time), which is a supported state: the tools report themselves unavailable. */
export function axHelperPath(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.REALM_AXHELPER_BIN) return process.env.REALM_AXHELPER_BIN;
  const dev = join(app.getAppPath(), "native", "bin", "axhelper");
  if (existsSync(dev)) return dev;
  const packaged = join(process.resourcesPath, "axhelper");
  return existsSync(packaged) ? packaged : null;
}

export class ComputerUseHelper {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  /** Last line the helper wrote to stderr, surfaced in the error when it dies during a call. */
  private lastStderr = "";

  constructor(private readonly d: { helperPath: () => string | null; onLog?: (line: string) => void }) {}

  get available(): boolean {
    return this.d.helperPath() !== null;
  }

  /**
   * One request. Spawns the helper if it is not running.
   *
   * Errors carry the helper's own `code` on `.cause` so the executor can turn them into the
   * `refused` tags the agent branches on, rather than re-deriving intent from message text.
   */
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const child = this.ensure();
    if (!child) return Promise.reject(new Error("computer control is unavailable in this build — the native accessibility helper was not compiled"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`the accessibility helper did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (e) {
        this.settle(id, () => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
  }

  /** Stop the helper. Closing stdin is the documented exit path; the kill is for one that ignores it. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.failAll("the accessibility helper was shut down");
    if (!child) return;
    try { child.stdin?.end(); child.kill(); } catch { /* already gone */ }
  }

  private ensure(): ChildProcess | null {
    if (this.child) return this.child;
    const bin = this.d.helperPath();
    if (!bin) return null;
    let child: ChildProcess;
    try {
      child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.d.onLog?.(`[computer-use] could not spawn the accessibility helper: ${(e as Error).message}`);
      return null;
    }
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr!.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (!line) return;
      this.lastStderr = line;
      this.d.onLog?.(`[computer-use] ${line}`);
    });
    // Stream errors (EPIPE against a child that just died) are otherwise unhandled and take the
    // whole main process down with them. 'exit' is what actually ends the session.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => {});
    child.on("error", (e) => {
      if (this.child === child) this.child = null;
      this.failAll(`the accessibility helper failed to start: ${e.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // already replaced; its callers were failed at stop()
      this.child = null;
      // The next request respawns. A helper that died mid-call is reported to that call rather than
      // retried: the app it was driving has moved on, and a silent retry could click twice.
      this.failAll(`the accessibility helper exited (code ${code ?? "null"}, signal ${signal ?? "null"})${this.lastStderr ? `: ${this.lastStderr}` : ""}`);
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: string; code?: string }; ready?: boolean };
    try { message = JSON.parse(line); } catch { this.d.onLog?.(`[computer-use] unparseable line: ${line.slice(0, 200)}`); return; }
    // The banner the helper writes on startup, before any request exists to answer.
    if (message.ready) return;
    if (typeof message.id !== "number") return;
    const id = message.id;
    if (message.error) {
      const error = new Error(message.error.message || "the accessibility helper refused without saying why");
      // The helper's tag, carried through so the executor can map it to a `refused` code.
      error.cause = message.error.code;
      this.settle(id, (entry) => entry.reject(error));
      return;
    }
    this.settle(id, (entry) => entry.resolve(message.result));
  }

  private settle(id: number, use: (entry: Pending) => void): void {
    const entry = this.pending.get(id);
    if (!entry) return; // a late answer to a call that already timed out
    this.pending.delete(id);
    clearTimeout(entry.timer);
    use(entry);
  }

  private failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
