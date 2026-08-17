import { parseWireMessage, type MethodName, type MethodParams, type MethodResult, type EventName, type EventPayload } from "@realm/contracts";

type Listener = (payload: unknown) => void;
export class RpcError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "RpcError"; }
}

const WS_OPEN = 1;
const WS_CLOSING = 2;

export class RpcClient {
  private ws: WebSocket;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private seq = 0;
  private opened: Promise<void>;
  private closed = false;
  constructor(url: string, Impl: typeof WebSocket = WebSocket) {
    this.ws = new Impl(url);
    this.opened = new Promise((res) => { this.ws.onopen = () => res(); });
    this.ws.onmessage = (e) => this.onMessage(String(e.data));
    this.ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new RpcError("DISCONNECTED", "socket closed"));
      this.pending.clear();
    };
  }
  ready(): Promise<void> { return this.opened; }
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (this.closed || this.ws.readyState >= WS_CLOSING) {
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
