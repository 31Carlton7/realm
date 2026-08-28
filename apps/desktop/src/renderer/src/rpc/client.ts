import { parseWireMessage, type MethodName, type MethodParams, type MethodResult, type EventName, type EventPayload } from "@realm/contracts";

type Listener = (payload: unknown) => void;
export type ConnectionStatus = "connected" | "reconnecting";
export class RpcError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "RpcError"; }
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_CAP_MS = 15_000;

/** One client for the app's lifetime. The socket underneath is disposable: on close the client marks
 *  itself reconnecting and redials with capped exponential backoff, forever. Event handlers and the
 *  pending-call plumbing live on the client (not the socket), so subscriptions survive reconnection;
 *  calls in flight when the socket drops reject with DISCONNECTED and the store's refresh-on-reconnect
 *  repairs state. */
export class RpcClient {
  private ws!: WebSocket;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private seq = 0;
  private opened!: Promise<void>;
  /** Optimistic until the first close: the boot connection shows no banner while dialing. */
  private status: ConnectionStatus = "connected";
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private url: string, private Impl: typeof WebSocket = WebSocket) {
    this.connect();
  }
  private connect() {
    if (this.disposed) return;
    const ws = new this.Impl(this.url);
    this.ws = ws;
    this.opened = new Promise((res) => {
      ws.onopen = () => {
        if (this.ws !== ws) return; // superseded dial
        this.attempt = 0;
        res();
        this.setStatus("connected");
      };
    });
    ws.onmessage = (e) => { if (this.ws === ws) this.onMessage(String(e.data)); };
    // onerror is deliberately unattached: every socket error is followed by close, so onclose is the single reconnect path.
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const p of this.pending.values()) p.reject(new RpcError("DISCONNECTED", "socket closed"));
      this.pending.clear();
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    };
  }
  private scheduleReconnect() {
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 10));
    this.attempt++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }
  /** The banner's Retry. Waiting out a backoff: dial immediately. Dial already in flight: abort it and
   *  dial fresh — the alternative (a silent no-op) makes the button dishonest, and a browser dial can
   *  hang far longer than any backoff. Calls queued on the aborted dial reject with DISCONNECTED,
   *  exactly as a socket drop would. No-op while connected or after dispose(). */
  retryNow(): void {
    if (this.disposed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer); this.retryTimer = null;
      this.connect();
      return;
    }
    const stale = this.ws;
    if (stale.readyState !== WS_CONNECTING) return; // connected: nothing to retry
    for (const p of this.pending.values()) p.reject(new RpcError("DISCONNECTED", "dial aborted by retry"));
    this.pending.clear();
    this.connect(); // reassigns this.ws first, so the stale socket's own onclose is ignored as superseded
    try { stale.close(); } catch { /* already closing */ }
  }
  /** Permanent teardown (window unload, tests): close the socket, reject pending calls, stop
   *  reconnecting for good. A disposed client never dials again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const p of this.pending.values()) p.reject(new RpcError("DISCONNECTED", "client disposed"));
    this.pending.clear();
    this.ws.onclose = null; // a deliberate close: no reconnect, no "reconnecting" status flip
    try { this.ws.close(); } catch { /* already closed */ }
  }
  onStatusChange(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }
  ready(): Promise<void> { return this.opened; }
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (this.ws.readyState >= WS_CLOSING) {
      // Between a drop and the next dial the old socket is still current; reject rather than queue
      // into a socket that will never send. Once a redial starts, calls queue on its `opened`.
      return Promise.reject(new RpcError("DISCONNECTED", "socket is closed"));
    }
    const id = String(++this.seq);
    const frame = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const send = () => {
        if (!this.pending.has(id)) return; // already rejected (e.g. socket closed while queued)
        try { this.ws.send(frame); }
        catch (e) { this.pending.delete(id); reject(e instanceof Error ? e : new RpcError("SEND_FAILED", String(e))); }
      };
      // Send synchronously when already open; otherwise wait for onopen.
      if (this.ws.readyState === WS_OPEN) send();
      else void this.opened.then(send);
    });
  }
  on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void): () => void {
    const set = this.listeners.get(event) ?? new Set(); set.add(fn as Listener); this.listeners.set(event, set);
    return () => set.delete(fn as Listener);
  }
  private onMessage(raw: string) {
    let m: ReturnType<typeof parseWireMessage>;
    try { m = parseWireMessage(raw); }
    catch (e) { console.warn("[rpc] ignoring malformed frame", e); return; }
    if (m.kind === "response") {
      const p = this.pending.get(m.msg.id); if (!p) return; this.pending.delete(m.msg.id);
      m.msg.ok ? p.resolve(m.msg.result) : p.reject(new RpcError(m.msg.error.code, m.msg.error.message));
    } else if (m.kind === "event") {
      for (const fn of this.listeners.get(m.msg.event) ?? []) fn(m.msg.payload);
    }
  }
}

let singleton: RpcClient | null = null;
export function rpc(): RpcClient {
  if (!singleton) {
    const port = window.realm?.port;
    if (!Number.isFinite(port)) throw new Error("Realm: server port not provided to renderer (preload missing --realm-port)");
    singleton = new RpcClient(`ws://127.0.0.1:${port}`);
  }
  return singleton;
}
