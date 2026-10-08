import type { EventName, EventPayload, MethodName, MethodParams, MethodResult } from "@realm/contracts";
import WebSocket from "ws";
import type { Principal, RpcServer } from "../rpc/server";
import { RpcError } from "../store/rows";

/**
 * How the gateway reaches Realm's own RPC. An interface rather than the RpcServer, so the mobile API
 * runs the same in both places it lives: inside realm-server, through `RpcServer.call()` and
 * `onBroadcast()` (`inProcessRpc`), and beside a built server in the live scripts, dialling it over
 * loopback like any other client (`loopbackRpc`).
 */
export interface RpcPort {
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** Every broadcast the server sends. The gateway decides what, if anything, reaches a phone. */
  onEvent(listener: <E extends EventName>(event: E, payload: EventPayload<E>) => void): () => void;
  close(): void;
}

/** An RPC error with the server's code, kept so the mobile API can map it rather than flatten it. */
export class RpcCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * The server's own RPC, in process, as `principal`: every call runs the desktop's handler down the
 * socket's path (`RpcServer.call`), and every broadcast reaches `onEvent`. A phone's calls are made
 * as `phone:<id>`, so a handler can tell them from the Mac's own.
 */
export function inProcessRpc(rpc: RpcServer, principal: Principal): RpcPort {
  return {
    call: async <M extends MethodName>(method: M, params: MethodParams<M>) => {
      try {
        return await rpc.call(method, params, { client: null, principal }) as MethodResult<M>;
      } catch (e) {
        throw e instanceof RpcError ? new RpcCallError(e.code, e.message) : e;
      }
    },
    onEvent: (listener) => rpc.onBroadcast(listener),
    // Nothing to hang up: the listeners are removed by the functions `onEvent` returned.
    close: () => {},
  };
}

/** Dials realm-server on loopback with its daemon token (the `realm.<token>` subprotocol), exactly as
 *  the renderer does. A `ws` client sends no Origin header, so the server judges it on the token alone. */
export function loopbackRpc(o: { port: number; token: string }): Promise<RpcPort> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${o.port}`, [`realm.${o.token}`]);
    // The desktop RPC's request ids are strings (RpcRequestSchema); a numeric id is not a request at
    // all to the server, which ignores it without a reply.
    let next = 1;
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const listeners = new Set<(event: EventName, payload: never) => void>();
    ws.on("message", (raw) => {
      let m: { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: string; payload?: unknown };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m.event === "string") {
        for (const l of listeners) l(m.event as EventName, m.payload as never);
        return;
      }
      if (typeof m.id !== "string") return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new RpcCallError(m.error?.code ?? "INTERNAL", m.error?.message ?? "rpc error"));
    });
    ws.on("close", () => {
      for (const p of pending.values()) p.reject(new RpcCallError("INTERNAL", "realm-server closed the connection"));
      pending.clear();
    });
    ws.once("error", reject);
    ws.once("open", () => {
      ws.off("error", reject);
      resolve({
        call: (method, params) => new Promise((res, rej) => {
          const id = String(next++);
          pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        }),
        onEvent: (l) => { listeners.add(l as never); return () => { listeners.delete(l as never); }; },
        close: () => ws.close(),
      });
    });
  });
}
