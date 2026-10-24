import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

/** A failure the CLI reports as one line and an exit code, never as a stack trace. `code` is the
 *  server's own error code when the server refused, so a script can branch on it. */
export class CtlError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export type CtlClient = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
};

/**
 * Where the server on `home` listens, from the state file it writes once its port is bound
 * (`daemon/state.ts`). The token is in the same 0600 file and nowhere else, which is what keeps a web
 * page that can dial loopback out.
 */
export function daemonAddress(home: string): { port: number; token: string } {
  let raw: string;
  try { raw = readFileSync(join(home, "daemon.json"), "utf8"); } catch {
    throw new CtlError("NOT_RUNNING", `no Realm server is running on ${home} (start one with \`realm serve\`, or open Realm)`);
  }
  const s = JSON.parse(raw) as { port?: unknown; token?: unknown };
  if (typeof s.port !== "number" || typeof s.token !== "string") throw new CtlError("BAD_STATE", `${join(home, "daemon.json")} names no port and token`);
  return { port: s.port, token: s.token };
}

export async function connect(home: string, opts: { timeoutMs?: number } = {}): Promise<CtlClient> {
  const { port, token } = daemonAddress(home);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`, [`realm.${token}`]);
    w.once("open", () => resolve(w));
    w.once("error", (e) => reject(new CtlError("NOT_RUNNING", `the Realm server on ${home} did not answer on port ${port}: ${e.message}`)));
  });
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  ws.on("message", (data) => {
    let m: { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
    try { m = JSON.parse(data.toString()); } catch { return; }
    // Broadcasts carry no id; this client only ever waits on its own calls.
    const p = typeof m.id === "string" ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id!); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new CtlError(m.error?.code ?? "ERROR", m.error?.message ?? "the server refused the call"));
  });
  ws.on("close", () => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new CtlError("DISCONNECTED", "the Realm server closed the connection")); pending.delete(id); }
  });
  let n = 0;
  return {
    call<T>(method: string, params: unknown = {}): Promise<T> {
      const id = String(++n);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new CtlError("TIMEOUT", `${method} did not answer within ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}
