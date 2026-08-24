import { StdioJsonRpc, withTimeout, type JsonRpcId } from "../jsonrpc/stdio";

export type ThreadListener = {
  onNotification: (method: string, params: unknown) => void;
  /** MUST answer via connection.respond()/respondError(). If this throws, the connection answers -32603 for you. */
  onServerRequest: (id: JsonRpcId, method: string, params: unknown) => void;
  /** `disposed` is true when Realm shut the process down on purpose — only `disposed: false` is an error. */
  onGone: (reason: string, disposed: boolean) => void;
};

export type CodexConnectionOptions = {
  bin: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  onLog?: (line: string) => void;
  /** Overridable for tests. A spawned-but-mute `codex app-server` must not hang session creation forever. */
  initializeTimeoutMs?: number;
};

type Buffered = { kind: "note"; method: string; params: unknown } | { kind: "req"; id: JsonRpcId; method: string; params: unknown };

const MAX_BUFFERED_PER_THREAD = 200;
const INITIALIZE_TIMEOUT_MS = 10_000;

const threadIdOf = (params: unknown): string | null => {
  const t = (params as { threadId?: unknown } | null)?.threadId;
  return typeof t === "string" ? t : null;
};

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One `codex app-server` process, shared by every Codex session and fanned out by `threadId`.
 *
 * Notifications for a thread with no listener yet are buffered (bounded) and flushed on `attach`, because
 * they can beat the `thread/start` response that tells us the id.
 *
 * Server requests are only buffered while NO thread is attached at all — that is the one window where an
 * unknown thread id really means "the startup race, our `thread/start` has not returned yet". Once any
 * thread is attached, a request for an unknown thread is a genuine orphan and is answered -32601 rather
 * than queued: an unanswered server request stalls that turn forever, whereas a rejected one fails it
 * cleanly. Do not widen this to "always buffer".
 *
 * That invariant holds through every exit: a listener that throws, a thread that detaches with an approval
 * still queued, and a full buffer all answer the request rather than dropping it. One session's bug must
 * never wedge a turn or take down its neighbours, so listener callbacks are never trusted to not throw.
 */
export class CodexConnection {
  private readonly threads = new Map<string, ThreadListener>();
  private readonly buffer = new Map<string, Buffered[]>();
  private readonly rpc: StdioJsonRpc;
  private readonly onLog?: (line: string) => void;
  private gone: { reason: string; disposed: boolean } | null = null;

  /** Visible for tests: fires whenever the connection itself answers a server request instead of a listener. */
  onUnroutedReply?: (id: JsonRpcId, code: number) => void;

  private constructor(opts: CodexConnectionOptions) {
    this.onLog = opts.onLog;
    // `this` is fully initialized here (field initializers run first) and StdioJsonRpc never invokes a
    // callback synchronously from its constructor, but binding through `this` rather than a `let` declared
    // after the call keeps that from mattering.
    this.rpc = new StdioJsonRpc({
      command: opts.bin,
      args: opts.args ?? ["app-server"],
      cwd: opts.cwd,
      env: opts.env,
      onNotification: (n) => this.routeNotification(n.method, n.params),
      onServerRequest: (r) => this.routeServerRequest(r.id, r.method, r.params),
      onStderr: (l) => this.onLog?.(l),
      onExit: ({ reason: why, disposed }) => this.fanOutGone(why, disposed),
    });
  }

  static async open(opts: CodexConnectionOptions): Promise<CodexConnection> {
    const conn = new CodexConnection(opts);
    const ms = opts.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    try {
      // A child that spawns but never answers would otherwise leave this promise pending forever, hanging
      // session creation with nothing to show the user.
      await withTimeout(
        conn.rpc.request("initialize", {
          clientInfo: { name: "realm", title: "Realm", version: "0.0.1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
        ms,
        `${opts.bin} did not answer initialize within ${ms}ms`,
      );
    } catch (e) {
      await conn.dispose(); // never leave a half-spawned child behind
      throw e;
    }
    conn.rpc.notify("initialized");
    return conn;
  }

  get threadCount(): number { return this.threads.size; }
  get alive(): boolean { return this.rpc.alive; }
  get stderrTail(): readonly string[] { return this.rpc.stderrTail; }

  /** Visible for tests: frames queued for a thread that has not attached yet. */
  bufferedCount(threadId: string): number { return this.buffer.get(threadId)?.length ?? 0; }

  /** `timeoutMs` bounds the wait; without it the call is only settled by an answer or the process dying. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const p = this.rpc.request<T>(method, params);
    return timeoutMs === undefined ? p : withTimeout(p, timeoutMs, `codex app-server did not answer ${method} within ${timeoutMs}ms`);
  }
  respond(id: JsonRpcId, result: unknown): void { this.rpc.respond(id, result); }
  respondError(id: JsonRpcId, code: number, message: string): void { this.rpc.respondError(id, code, message); }

  attach(threadId: string, listener: ThreadListener): void {
    if (this.gone) { this.deliverGone(listener, this.gone.reason, this.gone.disposed); return; }
    this.threads.set(threadId, listener);
    const queued = this.buffer.get(threadId);
    this.buffer.delete(threadId); // before the flush, so re-entrant pushes are not replayed or lost
    for (const f of queued ?? []) {
      if (f.kind === "note") this.deliverNotification(listener, f.method, f.params);
      else this.deliverServerRequest(listener, f.id, f.method, f.params);
    }
  }

  detach(threadId: string): void {
    this.threads.delete(threadId);
    // Anything still queued for this thread will never be delivered, and the child is still alive waiting
    // on it — so answer the requests before dropping them.
    this.drainBuffer(threadId, "thread detached");
  }

  async dispose(): Promise<void> { await this.rpc.dispose(); }

  private routeNotification(method: string, params: unknown): void {
    const threadId = threadIdOf(params);
    if (!threadId) { this.onLog?.(`[codex] ${method}`); return; } // global advisory: rate limits, config warnings
    const l = this.threads.get(threadId);
    if (l) { this.deliverNotification(l, method, params); return; }
    this.push(threadId, { kind: "note", method, params });
  }

  private routeServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const threadId = threadIdOf(params);
    const l = threadId ? this.threads.get(threadId) : undefined;
    if (l) { this.deliverServerRequest(l, id, method, params); return; }
    if (threadId && this.threads.size === 0) { this.push(threadId, { kind: "req", id, method, params }); return; }
    this.onLog?.(`[codex] unroutable server request ${method} (thread ${threadId ?? "none"})`);
    this.refuse(id, -32601, "no client for this thread");
  }

  /** A listener throwing is a bug in one session; it must not escape into the stdout handler and crash the app. */
  private deliverNotification(l: ThreadListener, method: string, params: unknown): void {
    try { l.onNotification(method, params); }
    catch (e) { this.onLog?.(`[codex] listener threw on ${method}: ${reason(e)}`); }
  }

  private deliverServerRequest(l: ThreadListener, id: JsonRpcId, method: string, params: unknown): void {
    try { l.onServerRequest(id, method, params); }
    catch (e) {
      // If the listener already answered before throwing, the child ignores this second frame; a duplicate
      // reply is strictly better than a turn wedged forever on a half-handled request.
      this.onLog?.(`[codex] listener threw on ${method}: ${reason(e)}`);
      this.refuse(id, -32603, "client failed to handle this request");
    }
  }

  private deliverGone(l: ThreadListener, why: string, disposed: boolean): void {
    try { l.onGone(why, disposed); }
    catch (e) { this.onLog?.(`[codex] listener threw on gone: ${reason(e)}`); }
  }

  private refuse(id: JsonRpcId, code: number, message: string): void {
    this.rpc.respondError(id, code, message);
    this.onUnroutedReply?.(id, code);
  }

  private push(threadId: string, f: Buffered): void {
    const q = this.buffer.get(threadId) ?? [];
    if (q.length >= MAX_BUFFERED_PER_THREAD) {
      if (f.kind === "req") this.refuse(f.id, -32601, "buffer overflow");
      return;
    }
    q.push(f);
    this.buffer.set(threadId, q);
  }

  private drainBuffer(threadId: string, why: string): void {
    const q = this.buffer.get(threadId);
    this.buffer.delete(threadId);
    for (const f of q ?? []) if (f.kind === "req") this.refuse(f.id, -32601, why);
  }

  private fanOutGone(why: string, disposed: boolean): void {
    this.gone = { reason: why, disposed };
    const listeners = [...this.threads.values()];
    // Cleared before the fan-out so a listener that calls detach() (or re-enters routing) from onGone sees
    // an already-empty connection instead of resurrecting state. Map.delete on a missing key is a no-op.
    this.threads.clear();
    // Not drained: the peer is gone, so there is nothing left to answer (respondError is a no-op once dead).
    this.buffer.clear();
    for (const l of listeners) this.deliverGone(l, why, disposed);
  }
}
