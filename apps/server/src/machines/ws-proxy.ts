import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { MachineTransport } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { dial, describeDialError, type ByteChannel } from "./dial";
import { endpointTag, handshakeStep, replayForClient, type HandshakeState } from "./rfb-handshake";

/**
 * The pixel relay (Plan 25 W3): a loopback WebSocket the renderer's RFB client connects to, with a
 * plain TCP socket to the real machine on the other side.
 *
 * Three reasons this exists rather than pointing noVNC straight at the endpoint, in the order they
 * matter:
 *
 *   1. **A browser cannot open a TCP socket.** Every RFB endpoint worth connecting to — a Mac with
 *      Screen Sharing on, a container, a guest — speaks raw RFB on a TCP port and knows nothing about
 *      WebSockets. Something has to be the adapter, and it has to be outside the renderer.
 *   2. **The renderer never holds the credential.** The handshake, including the password, happens
 *      HERE; the renderer is handed a socket that is already past it. A VNC password is frequently
 *      the user's login, and the renderer is the process that also runs page content.
 *   3. **The URL is unguessable and dies with the boot.** A per-boot token as a PATH segment, compared
 *      with `timingSafeEqual`, bound to `127.0.0.1` — `documents/preview.ts`'s exact shape, and for
 *      the same reason: anything on this Mac can reach a loopback port, so the port is not the guard.
 *
 * One listener for every machine rather than one per machine, with the machine id in the path. A
 * port per machine would burn a port on each and would need the UNIQUE index to arbitrate; the
 * `ws_port` column records THIS listener's port so a `machine.status` event can carry a URL the
 * renderer can use without a second round trip.
 */

/** Where a machine's pixels actually are, resolved at connect time rather than held here — a machine
 *  whose address or password was edited between panes must not reconnect to the old one. */
export type MachineTarget = {
  transport: MachineTransport;
  host: string;
  port: number;
  /** WebSocket transports only — where websockify serves the upgrade. */
  path: string;
  /** Plaintext, for the length of one handshake. Null where the server needs none. */
  password: string | null;
  /** Sent on the upgrade request, WebSocket transports only. A sandbox behind an authenticating
   *  proxy — Namespace's `x-nsc-ingress-auth` is the named case — needs one, and a browser cannot
   *  set a header on a WebSocket at all. Unsealed here for the length of one dial. */
  headers?: Record<string, string>;
  /** Test seam, threaded through from the service so a local TLS server nothing signed can be
   *  reached. Production never sets it. */
  rejectUnauthorized?: boolean;
};

export type WsProxyDeps = {
  /** Null when there is no such machine, it is not a `vnc` source, or its password cannot be
   *  unsealed. Every one of those is a refused upgrade rather than a socket that hangs. */
  targetFor(machineId: string): MachineTarget | null;
  /** The framebuffer's real size, once the far end has stated it. Drives `machine.status`. */
  onConnected?(machineId: string, size: { width: number; height: number; name: string }): void;
  onFailed?(machineId: string, error: "unreachable" | "not_rfb" | "auth_failed" | "auth_unsupported" | "disconnected", detail: string): void;
  onClosed?(machineId: string): void;
  log?(line: string): void;
};

/** How long the far end has to complete a handshake before Realm gives up on it. A Mac that is
 *  asleep accepts the TCP connection and then says nothing, which is indistinguishable from a
 *  healthy server until a deadline says otherwise. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The TCP connect itself. Shorter, because a refused or filtered port is the common failure and
 *  fifteen seconds of a blank pane is a worse answer than "unreachable" in three. */
const CONNECT_TIMEOUT_MS = 5_000;

export class MachineWsProxy {
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private port: number | null = null;
  /** Minted per boot. Every URL handed out before a restart is dead after it, with nothing to
   *  persist and nothing to invalidate by hand. */
  readonly token = randomBytes(18).toString("base64url");
  private readonly live = new Set<{ ws: WebSocket; tcp: ByteChannel }>();

  constructor(private readonly d: WsProxyDeps) {}

  async listen(): Promise<number> {
    if (this.port !== null) return this.port;
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    // `noServer`, so the upgrade is authorised BEFORE a WebSocket exists. An unauthorised request
    // is destroyed at the socket rather than accepted and then closed, which is the difference
    // between a probe learning nothing and a probe learning that the path shape was right.
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const machineId = this.machineIdFor(req.url ?? "");
      if (!machineId) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => this.bridge(machineId, ws));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : null;
    if (this.port === null) throw new Error("machine proxy: the listener bound without a usable TCP port");
    this.server = server;
    this.wss = wss;
    return this.port;
  }

  /** The URL that goes on a `machine.status` event. No password, by construction: there is nowhere
   *  in this string for one, and the renderer has no code that could use one if there were. */
  urlFor(machineId: string): string {
    if (this.port === null) throw new RpcError("UNAVAILABLE", "the machine relay is not listening");
    return `ws://127.0.0.1:${this.port}/vnc/${this.token}/${encodeURIComponent(machineId)}`;
  }

  info(): { port: number; token: string } {
    if (this.port === null) throw new RpcError("UNAVAILABLE", "the machine relay is not listening");
    return { port: this.port, token: this.token };
  }

  /** Drop every live bridge for one machine — a stop, a delete, or an edit that moved the address. */
  disconnect(machineId: string): void {
    for (const pair of [...this.live]) {
      if ((pair.ws as WebSocket & { machineId?: string }).machineId !== machineId) continue;
      this.live.delete(pair);
      pair.tcp.close();
      pair.ws.close();
    }
  }

  async close(): Promise<void> {
    for (const { ws, tcp } of [...this.live]) { tcp.close(); ws.terminate(); }
    this.live.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null; this.wss = null; this.port = null;
  }

  /** `/vnc/<token>/<machineId>` → the id, or null for anything else. */
  private machineIdFor(url: string): string | null {
    const parts = new URL(url, "http://127.0.0.1").pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "vnc" || !this.tokenMatches(parts[1]!)) return null;
    return decodeURIComponent(parts[2]!);
  }

  private tokenMatches(t: string): boolean {
    const a = Buffer.from(t), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * One client, one machine: connect, handshake, replay, then pipe.
   *
   * The client is deliberately kept WAITING through the handshake — no bytes go to it until the far
   * end has stated its framebuffer size, and then the whole synthetic negotiation and the real
   * ServerInit arrive together. A client that saw our version line and then a failure would show a
   * connected pane that goes blank; a client that sees nothing until there is a screen shows the
   * `booting` body until there is one, which is what the pane is written to do.
   */
  private bridge(machineId: string, ws: WebSocket): void {
    const target = this.d.targetFor(machineId);
    if (!target) { ws.close(1011, "no such machine"); return; }
    (ws as WebSocket & { machineId?: string }).machineId = machineId;

    const tcp: ByteChannel = dial(target);
    const pair = { ws, tcp };
    this.live.add(pair);
    const tag = endpointTag(target.host, target.port);

    let state: HandshakeState = { phase: "version" };
    let buf = Buffer.alloc(0);
    let piping = false;
    let settled = false;

    const fail = (error: Parameters<NonNullable<WsProxyDeps["onFailed"]>>[1], detail: string): void => {
      if (settled) return;
      settled = true;
      this.d.log?.(`[machine ${machineId}] ${tag} ${error}: ${detail}`);
      this.d.onFailed?.(machineId, error, detail);
      this.live.delete(pair);
      tcp.close();
      // 1011 rather than a clean 1000: the renderer distinguishes "the server hung up" from "Realm
      // could not get there", and only the code tells them apart once the socket is gone.
      try { ws.close(1011, error); } catch { /* already gone */ }
    };

    /* Two deadlines, and they catch different failures.

       The socket's own IDLE timeout stays armed until the handshake FINISHES, not until the TCP
       connect does — which is the whole point, and was wrong the first time. A Mac that is asleep
       accepts the connection and then says nothing at all, so clearing this on `connect` leaves the
       commonest real failure to the ten-second deadline below. Cleared once pixels start flowing,
       because a VNC stream is legitimately idle whenever nothing on the screen moves.

       The wall deadline catches what an idle timeout structurally cannot: a server that dribbles a
       byte every few seconds and never finishes negotiating. */
    const deadline = setTimeout(() => fail("unreachable", `the machine did not finish an RFB handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s`), HANDSHAKE_TIMEOUT_MS);
    /* The silent-far-end deadline. Armed from the dial and cleared only once pixels flow, not once
       the connection opens — a Mac that is asleep accepts the connection and then says nothing at
       all, and clearing this at `open` (the obvious place) leaves the commonest real failure to the
       ten-second wall deadline above. A connected screen with nothing moving on it is legitimately
       silent, which is why it goes away rather than staying on. */
    let quiet: NodeJS.Timeout | null = setTimeout(() => {
      if (!piping) fail("unreachable", `the machine accepted the connection and then said nothing for ${CONNECT_TIMEOUT_MS / 1000}s — it may be asleep`);
    }, CONNECT_TIMEOUT_MS);

    tcp.onError((e) => fail("unreachable", describeDialError(target, e)));

    tcp.onClose(() => {
      clearTimeout(deadline);
      if (quiet) { clearTimeout(quiet); quiet = null; }
      if (piping) { this.live.delete(pair); this.d.onClosed?.(machineId); try { ws.close(1000); } catch { /* gone */ } }
      else fail("disconnected", "the machine closed the connection during the handshake");
    });

    tcp.onData((chunk: Buffer) => {
      if (piping) { if (ws.readyState === ws.OPEN) ws.send(chunk); return; }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const step = handshakeStep(state, buf, target.password);
        if (step.kind === "wait") return;
        if (step.kind === "fail") { clearTimeout(deadline); fail(step.error, step.detail); return; }
        if (step.kind === "done") {
          clearTimeout(deadline);
          settled = true;
          const init = buf.subarray(0, step.consumed);
          buf = buf.subarray(step.consumed);
          const replay = replayForClient(init);
          for (const part of [replay.version, replay.security, replay.result, replay.serverInit]) ws.send(part);
          // Anything the server sent AFTER its ServerInit in the same read belongs to the client and
          // must not be dropped: a server that ships a framebuffer update immediately would lose its
          // first frame, and the pane would sit on a blank screen until something moved.
          if (buf.length) ws.send(buf);
          buf = Buffer.alloc(0);
          piping = true;
          // The quiet deadline has done its job.
          if (quiet) { clearTimeout(quiet); quiet = null; }
          this.d.onConnected?.(machineId, { width: step.width, height: step.height, name: step.name });
          return;
        }
        if (step.bytes.length) tcp.write(step.bytes);
        buf = buf.subarray(step.consumed);
        state = step.state;
      }
    });

    ws.on("message", (data) => {
      // Before the handshake finishes the client has been told nothing, so it has nothing to say —
      // and anything it does say would be injected into the middle of OUR negotiation. Dropped.
      if (!piping) return;
      if (Buffer.isBuffer(data)) tcp.write(data);
      else if (Array.isArray(data)) tcp.write(Buffer.concat(data));
      else if (data instanceof ArrayBuffer) tcp.write(Buffer.from(data));
    });

    const drop = () => { clearTimeout(deadline); if (quiet) { clearTimeout(quiet); quiet = null; } this.live.delete(pair); tcp.close(); };
    ws.on("close", drop);
    ws.on("error", drop);
  }
}
