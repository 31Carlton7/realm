import { parseWireMessage, type MethodName, type MethodParams, type MethodResult, type EventName, type EventPayload } from "@realm/contracts";

type Listener = (payload: unknown) => void;
export class RpcError extends Error { constructor(public code: string, message: string) { super(message); } }

export class RpcClient {
  private ws: WebSocket;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private seq = 0;
  private opened: Promise<void>;
  constructor(url: string, Impl: typeof WebSocket = WebSocket) {
    this.ws = new Impl(url);
    this.opened = new Promise((res) => { this.ws.onopen = () => res(); });
    this.ws.onmessage = (e) => this.onMessage(String(e.data));
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new RpcError("DISCONNECTED", "socket closed")); this.pending.clear(); };
  }
  ready(): Promise<void> { return this.opened; }
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const id = String(++this.seq);
    const frame = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // Send synchronously when already open (readyState 1 = OPEN); otherwise wait for onopen.
      if (this.ws.readyState === 1) this.ws.send(frame);
      else void this.opened.then(() => this.ws.send(frame));
    });
  }
  on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void): () => void {
    const set = this.listeners.get(event) ?? new Set(); set.add(fn as Listener); this.listeners.set(event, set);
    return () => set.delete(fn as Listener);
  }
  private onMessage(raw: string) {
    const m = parseWireMessage(raw);
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
  if (!singleton) singleton = new RpcClient(`ws://127.0.0.1:${window.realm.port}`);
  return singleton;
}
