import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { classifyAddress } from "../access/listen";
import { CtlError } from "./errors";

export { CtlError };

export type CtlClient = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Every broadcast the server sends this connection. Returns the unsubscribe. */
  onEvent(listener: (event: string, payload: unknown) => void): () => void;
  /** Called once if the connection drops before `close()`. */
  onClose(listener: () => void): void;
  close(): void;
};

/**
 * Which server a command talks to: the one on a home on this machine, found through that home's
 * `daemon.json`, or one on another machine, dialled at its remote listener with an access token
 * (`realm serve --listen`, `realm token create`).
 */
export type Target =
  | { kind: "home"; home: string }
  | { kind: "url"; url: string; token: string; ca: string | null; allowPlaintext: boolean };

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

/**
 * A server URL a token may be sent to. `wss://` anywhere; `ws://` only to this machine — an SSH
 * tunnel's local end, or a server on loopback — unless the person says the network between encrypts
 * on its own. The server makes the same rule from its side (`access/listen.ts`); a client keeps its
 * own token out of the clear whatever the server would have allowed.
 */
export function checkServerUrl(raw: string, allowPlaintext: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CtlError("USAGE", `--server takes a ws:// or wss:// URL, or the name of a saved remote (realm remote add), not ${raw}`); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new CtlError("USAGE", `--server takes a ws:// or wss:// URL, not ${url.protocol}//`);
  if (url.username || url.password) throw new CtlError("USAGE", "put the access token in --token or REALM_TOKEN, not in the URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || (/^[\d.]+$|:/.test(host) && classifyAddress(host) === "loopback");
  if (url.protocol === "ws:" && !loopback && !allowPlaintext) {
    throw new CtlError("PLAINTEXT_REFUSED", `refusing to send an access token to ${url.host} in the clear. Use wss://, an SSH tunnel to a port on this machine, or, on a network that encrypts on its own (a tailnet), --allow-plaintext`);
  }
  return url;
}

/** TLS failures that mean "this certificate is not one you trust", as Node names them. */
const UNTRUSTED = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"]);

function dialError(where: string, e: Error & { code?: string }): CtlError {
  const code = e.code ?? "";
  if (UNTRUSTED.has(code)) return new CtlError("TLS_UNTRUSTED", `${where} presented a certificate this machine does not trust (${code}). For a self-signed certificate, pass it with --ca <cert.pem>`);
  if (code === "ECONNREFUSED") return new CtlError("NOT_RUNNING", `nothing is listening at ${where}`);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new CtlError("UNREACHABLE", `${where} has a name this machine cannot resolve`);
  return new CtlError("NOT_RUNNING", `${where} did not answer: ${e.message}`);
}

function refusedError(where: string, status: number): CtlError {
  if (status === 401) return new CtlError("UNAUTHORIZED", `${where} refused the access token`);
  if (status === 403) return new CtlError("FORBIDDEN", `${where} refused this client`);
  if (status === 429) return new CtlError("RATE_LIMITED", `${where} is refusing this address for a minute after too many refused tokens`);
  return new CtlError("NOT_REALM", `${where} answered HTTP ${status}, not a Realm server's handshake`);
}

export async function connect(target: Target, opts: { timeoutMs?: number } = {}): Promise<CtlClient> {
  let url: string; let protocols: string[]; let options: WebSocket.ClientOptions; let where: string;
  if (target.kind === "home") {
    const { port, token } = daemonAddress(target.home);
    url = `ws://127.0.0.1:${port}`; protocols = [`realm.${token}`]; options = {};
    where = `the Realm server on ${target.home} (port ${port})`;
  } else {
    const checked = checkServerUrl(target.url, target.allowPlaintext);
    url = checked.href; protocols = [`realm.${target.token}`];
    options = { handshakeTimeout: 15_000, followRedirects: false, ...(target.ca ? { ca: target.ca } : {}) };
    where = checked.host;
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(url, protocols, options);
    w.once("open", () => resolve(w));
    w.once("unexpected-response", (_req, res) => { res.resume(); w.terminate(); reject(refusedError(where, res.statusCode ?? 0)); });
    w.once("error", (e) => reject(dialError(where, e)));
  });
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: string, payload: unknown) => void>();
  const closeListeners: (() => void)[] = [];
  let closing = false;
  ws.on("message", (data) => {
    let m: { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: string; payload?: unknown };
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (typeof m.event === "string") { for (const l of listeners) l(m.event, m.payload); return; }
    const p = typeof m.id === "string" ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id!); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new CtlError(m.error?.code ?? "ERROR", m.error?.message ?? "the server refused the call"));
  });
  ws.on("close", () => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new CtlError("DISCONNECTED", "the Realm server closed the connection")); pending.delete(id); }
    if (!closing) for (const l of closeListeners) l();
  });
  // After open, an error is followed by close, which is where pending calls are failed.
  ws.on("error", () => {});
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
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onClose(listener) { closeListeners.push(listener); },
    close() { closing = true; ws.close(); },
  };
}
