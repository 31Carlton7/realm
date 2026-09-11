import { WebSocketServer, WebSocket, type ServerOptions } from "ws";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ZodTypeAny, z } from "zod";
import { parseWireMessage, type EventName, type EventPayload, type RpcResponse } from "@realm/contracts";
import { RpcError } from "../store/rows";

type Handler<S extends ZodTypeAny> = (params: z.infer<S>, ctx: { client: WebSocket }) => Promise<unknown>;

/**
 * Who is allowed onto the socket.
 *
 * This listener binds loopback, which is not a boundary: a WebSocket dial is not subject to CORS, so
 * before this any page in any browser could open `ws://127.0.0.1:<port>` and call `sessions.create`.
 * That was survivable only because the port was ephemeral and died with the app. A daemon holds one
 * for days, so the token is not optional.
 *
 * `token` travels as the WebSocket subprotocol `realm.<token>` — the one channel both `ws` and the
 * renderer's browser `WebSocket` can set, since neither can add a header to a handshake. It is read
 * from the 0600 state file, so a web page cannot learn it.
 *
 * `allowedOrigins` is the second lock, for a token that leaked into a log or a screenshot. A browser
 * stamps `Origin` from the document and a page cannot forge it, so an allowlist of the origins Realm
 * actually loads its own renderer from keeps `https://evil.com` out even holding the token. Clients
 * that send no Origin at all (`ws` from Node: main's bridge, the CLI, the live checks) are judged on
 * the token alone. Neither lock stops local malware running as this user — nothing here could.
 */
export type ListenOptions = {
  token?: string;
  allowedOrigins?: readonly string[];
};

export const tokenProtocol = (token: string): string => `realm.${token}`;

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The handshake decision, pure over the two headers it reads so every branch is testable without a
 *  socket. Offered protocols are compared constant-time; length alone leaks nothing useful here. */
export function acceptsHandshake(
  offer: { origin?: string; protocols: readonly string[] },
  opts: ListenOptions,
): boolean {
  if (offer.origin !== undefined && !(opts.allowedOrigins ?? []).includes(offer.origin)) return false;
  if (opts.token === undefined) return true;
  const want = tokenProtocol(opts.token);
  return offer.protocols.some((p) => sameSecret(p, want));
}

/** `Sec-WebSocket-Protocol` is a comma-separated list; `ws` hands `handleProtocols` a Set but
 *  `verifyClient` only the raw header, and the token check has to happen there — see `listen`. */
const offeredProtocols = (header: string | undefined): string[] =>
  header === undefined ? [] : header.split(",").map((p) => p.trim()).filter(Boolean);

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private methods = new Map<string, { schema: ZodTypeAny; handler: Handler<ZodTypeAny> }>();
  private clients = new Set<WebSocket>();

  register<S extends ZodTypeAny>(name: string, schema: S, handler: Handler<S>): void {
    this.methods.set(name, { schema, handler: handler as Handler<ZodTypeAny> });
  }

  listen(port: number, host = "127.0.0.1", opts: ListenOptions = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      // Both checks live in `verifyClient` because `handleProtocols` is not called at all when the
      // client offers no subprotocol — a tokenless dial would sail straight past it. `handleProtocols`
      // is then only there to echo the accepted value back, which a browser needs to see.
      const options: ServerOptions = {
        port, host,
        verifyClient: ({ req }: { req: IncomingMessage }) => acceptsHandshake(
          { origin: req.headers.origin, protocols: offeredProtocols(req.headers["sec-websocket-protocol"]) },
          opts,
        ),
      };
      const token = opts.token;
      if (token !== undefined) options.handleProtocols = () => tokenProtocol(token);
      const wss = new WebSocketServer(options);
      this.wss = wss;
      wss.once("error", reject);
      wss.on("listening", () => {
        // After listen, errors are no longer fatal to the caller; log them instead of crashing on an unhandled 'error'.
        wss.on("error", (err) => process.stderr.write(`[realm-server] ws error: ${err.message}\n`));
        const addr = wss.address(); resolve(typeof addr === "object" && addr ? addr.port : port);
      });
      wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", (err) => process.stderr.write(`[realm-server] client error: ${err.message}\n`));
        ws.on("message", (data) => void this.handle(ws, data.toString()));
      });
    });
  }

  broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
    const msg = JSON.stringify({ event, payload });
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  /** Send one event to ONE client (the `ctx.client` a handler captured) — the browser host bridge's op
   *  channel (Plan 11 W3), where a broadcast would spray CDP work at every connected renderer. Returns
   *  false when the socket is no longer open, so the caller can fail its op instead of waiting on a
   *  message nobody received. */
  sendTo<E extends EventName>(client: WebSocket, event: E, payload: EventPayload<E>): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    client.send(JSON.stringify({ event, payload }));
    return true;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    await new Promise<void>((res) => (this.wss ? this.wss.close(() => res()) : res()));
  }

  private async handle(ws: WebSocket, raw: string): Promise<void> {
    let id = "?";
    const send = (r: RpcResponse): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r)); };
    try {
      const wire = parseWireMessage(raw);
      if (wire.kind !== "request") return;
      id = wire.msg.id;
      const m = this.methods.get(wire.msg.method);
      if (!m) return send({ id, ok: false, error: { code: "METHOD_NOT_FOUND", message: wire.msg.method } });
      const parsed = m.schema.safeParse(wire.msg.params);
      if (!parsed.success) return send({ id, ok: false, error: { code: "INVALID_PARAMS", message: parsed.error.message } });
      const result = await m.handler(parsed.data, { client: ws });
      send({ id, ok: true, result });
    } catch (e) {
      send({ id, ok: false, error: toRpcError(e) });
    }
  }
}

/** Only RpcError codes cross the wire; everything else is INTERNAL. */
function toRpcError(e: unknown): { code: string; message: string } {
  if (e instanceof RpcError) return { code: e.code, message: e.message };
  const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return { code: "INTERNAL", message };
}
