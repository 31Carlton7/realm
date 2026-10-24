import { WebSocketServer, WebSocket, type ServerOptions } from "ws";
import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import type { ZodTypeAny, z } from "zod";
import { parseWireMessage, type EventName, type EventPayload, type RpcResponse } from "@realm/contracts";
import type { HandshakeLimiter } from "../access/limiter";
import { RpcError } from "../store/rows";

/**
 * Who a call is from. `local` is everything on this Mac: every socket (the renderer, main's bridge,
 * the CLI) and every in-process call made on the Mac's own behalf. `phone:<id>` is a paired phone,
 * which reaches handlers only through the mobile API (`remote/api.ts`) — an allowlist by construction,
 * so a handler checking the principal is a second lock, never the first. `token:<id>` is the owner on
 * another machine, through the access token with that id (`listenRemote`): the whole RPC, as `local`
 * has it, except what only this machine's own app may do.
 */
export type Principal = "local" | `phone:${string}` | `token:${string}`;

/** What a handler knows about its caller. `client` is null for an in-process `call()`, so a handler
 *  that needs a socket to answer later (`browserHost.register`) must refuse a null, never adopt it. */
export type CallContext = { client: WebSocket | null; principal: Principal };

type Handler<S extends ZodTypeAny> = (params: z.infer<S>, ctx: CallContext) => Promise<unknown>;

type BroadcastListener = <E extends EventName>(event: E, payload: EventPayload<E>) => void;

const IN_PROCESS: CallContext = { client: null, principal: "local" };

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

/** What `listenRemote` needs besides an address: how to judge a token, and the refusals' budget. */
export type RemoteListenOptions = {
  host: string;
  port: number;
  /** PEM certificate chain and key; null for plain `ws://` (loopback, or a network the owner vouched
   *  for — `access/listen.ts` decides, before this is called). */
  tls: { cert: string | Buffer; key: string | Buffer } | null;
  /** Who an offered access token belongs to, or null. */
  authenticate: (token: string) => { id: string; name: string } | null;
  limiter: HandshakeLimiter;
  log?: (line: string) => void;
};

export type RemoteListener = {
  port: number;
  /** Closes every client whose token is not among `valid` (ids), and says how many went. */
  dropRevoked(valid: ReadonlySet<string>): number;
  /** A renewed certificate, for the handshakes from now on. */
  reloadTls(tls: { cert: string | Buffer; key: string | Buffer }): void;
  close(): Promise<void>;
};

/** How long a client gets to finish its TLS and HTTP handshakes before the socket is dropped. */
const HANDSHAKE_MS = 10_000;

/** Refuse an upgrade with a bare status line and nothing else: no body, no hint at what was wrong. */
function refuseUpgrade(socket: Duplex, status: 401 | 403 | 429): void {
  const text = { 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests" }[status];
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private methods = new Map<string, { schema: ZodTypeAny; handler: Handler<ZodTypeAny> }>();
  private clients = new Set<WebSocket>();
  private listeners = new Set<BroadcastListener>();
  private remotes = new Set<RemoteListener>();

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
      wss.on("connection", (ws) => this.attach(ws, "local"));
    });
  }

  /**
   * A second listener, for clients on other machines (`realm serve --listen`).
   *
   * It shares nothing with the loopback one but the methods: its own address, its own credential and
   * its own principal. A handshake must offer an access token as the `realm.<token>` subprotocol — the
   * daemon's per-boot token is not one, so a `daemon.json` that leaked cannot open this door — and a
   * handshake that carries an Origin is refused whatever it offers: a browser stamps one on every
   * WebSocket, and no page anywhere is a client of this listener.
   *
   * The principal is `token:<id>` however the client arrived. Behind Tailscale Serve or an SSH tunnel
   * every client comes from 127.0.0.1, so the address could never be what decides who someone is.
   */
  listenRemote(o: RemoteListenOptions): Promise<RemoteListener> {
    const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    const server: HttpServer | HttpsServer = o.tls
      ? createHttpsServer({ cert: o.tls.cert, key: o.tls.key, minVersion: "TLSv1.2", handshakeTimeout: HANDSHAKE_MS })
      : createHttpServer();
    server.headersTimeout = HANDSHAKE_MS;
    server.requestTimeout = HANDSHAKE_MS;
    // The protocol each accepted handshake offered, echoed back so a client sees the one it sent.
    const accepted = new WeakMap<IncomingMessage, string>();
    const wss = new WebSocketServer({ noServer: true, handleProtocols: (_offered, req) => accepted.get(req) ?? false });
    const mine = new Map<WebSocket, string>();
    server.on("request", (_req, res) => { res.writeHead(426, { Connection: "close", "Content-Length": "0" }); res.end(); });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      const from = req.socket.remoteAddress ?? "unknown";
      if (o.limiter.blocked(from)) return refuseUpgrade(socket, 429);
      const refuse = (status: 401 | 403, why: string) => {
        if (o.limiter.fail(from)) log(`[realm-server] refusing ${from} for a while: too many refused handshakes`);
        else log(`[realm-server] refused a remote client from ${from}: ${why}`);
        refuseUpgrade(socket, status);
      };
      if (req.headers.origin !== undefined) return refuse(403, `a browser page (${req.headers.origin})`);
      let who: { id: string; name: string } | null = null;
      for (const p of offeredProtocols(req.headers["sec-websocket-protocol"])) {
        if (!p.startsWith("realm.")) continue;
        who = o.authenticate(p.slice("realm.".length));
        if (who) { accepted.set(req, p); break; }
      }
      if (!who) return refuse(401, "no valid access token");
      o.limiter.succeed(from);
      const id = who.id;
      const name = who.name;
      wss.handleUpgrade(req, socket, head, (ws) => {
        mine.set(ws, id);
        ws.on("close", () => mine.delete(ws));
        log(`[realm-server] remote client "${name}" (token ${id}) connected from ${from}`);
        this.attach(ws, `token:${id}`);
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(o.port, o.host, () => {
        server.off("error", reject);
        server.on("error", (err) => log(`[realm-server] remote listener error: ${err.message}`));
        const addr = server.address();
        const listener: RemoteListener = {
          port: typeof addr === "object" && addr ? addr.port : o.port,
          dropRevoked: (valid) => {
            let dropped = 0;
            for (const [ws, id] of mine) if (!valid.has(id)) { ws.terminate(); mine.delete(ws); dropped++; }
            if (dropped > 0) log(`[realm-server] closed ${dropped} remote client(s) whose access token was revoked`);
            return dropped;
          },
          reloadTls: (tls) => { if ("setSecureContext" in server) server.setSecureContext({ cert: tls.cert, key: tls.key }); },
          close: async () => {
            this.remotes.delete(listener);
            for (const ws of mine.keys()) ws.terminate();
            mine.clear();
            wss.close();
            await new Promise<void>((res) => { server.close(() => res()); server.closeAllConnections(); });
          },
        };
        this.remotes.add(listener);
        resolve(listener);
      });
    });
  }

  /** One accepted socket, on either listener: every call it makes is made as `principal`. */
  private attach(ws: WebSocket, principal: Principal): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", (err) => process.stderr.write(`[realm-server] client error: ${err.message}\n`));
    ws.on("message", (data) => void this.handle(ws, data.toString(), principal));
  }

  broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
    const msg = JSON.stringify({ event, payload });
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    // A listener runs inside whichever service broadcast, so its failure is caught here: the phone's
    // gateway tripping over one event must not throw into the session pump that raised it.
    for (const l of this.listeners) {
      try { l(event, payload); } catch (e) { process.stderr.write(`[realm-server] broadcast listener failed on ${event}: ${e instanceof Error ? e.message : String(e)}\n`); }
    }
  }

  /** Every broadcast, in process, as the sockets get it. The listener decides what reaches anyone
   *  else: the phone's gateway projects a few events into rows and drops the rest. */
  onBroadcast(listener: BroadcastListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * One call in process, down exactly the socket's path: the method's schema parses the params, the
   * handler runs, and its result comes back — with no socket, so the handler sees `client: null`.
   * Failures reject with the RpcError a socket would have been sent: the handler's own code kept,
   * METHOD_NOT_FOUND and INVALID_PARAMS as the socket words them, anything else INTERNAL.
   */
  async call(method: string, params: unknown, ctx: CallContext = IN_PROCESS): Promise<unknown> {
    try {
      return await this.dispatch(method, params, ctx);
    } catch (e) {
      if (e instanceof RpcError) throw e;
      const { code, message } = toRpcError(e);
      throw new RpcError(code, message);
    }
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
    await Promise.all([...this.remotes].map((r) => r.close()));
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    await new Promise<void>((res) => (this.wss ? this.wss.close(() => res()) : res()));
  }

  private async handle(ws: WebSocket, raw: string, principal: Principal): Promise<void> {
    let id = "?";
    const send = (r: RpcResponse): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r)); };
    try {
      const wire = parseWireMessage(raw);
      if (wire.kind !== "request") return;
      id = wire.msg.id;
      const result = await this.dispatch(wire.msg.method, wire.msg.params, { client: ws, principal });
      send({ id, ok: true, result });
    } catch (e) {
      send({ id, ok: false, error: toRpcError(e) });
    }
  }

  /** The one path from a method name to its result, shared by the socket and `call()` so the two
   *  cannot drift: the same lookup, the same parse, the same handler. */
  private async dispatch(method: string, params: unknown, ctx: CallContext): Promise<unknown> {
    const m = this.methods.get(method);
    if (!m) throw new RpcError("METHOD_NOT_FOUND", method);
    const parsed = m.schema.safeParse(params);
    if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
    return m.handler(parsed.data, ctx);
  }
}

/** Only RpcError codes cross the wire; everything else is INTERNAL. */
function toRpcError(e: unknown): { code: string; message: string } {
  if (e instanceof RpcError) return { code: e.code, message: e.message };
  const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return { code: "INTERNAL", message };
}
