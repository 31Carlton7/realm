import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";
import type { MachineTransport } from "@realm/contracts";

/**
 * One outbound connection to a machine, as a stream of bytes — whichever of the four ways it was
 * actually made (Plan 25 W3).
 *
 * The RFB handshake is a byte protocol and does not care how the bytes arrived, so the state machine
 * in `rfb-handshake.ts` is written against a buffer and this is what feeds it. Four transports and
 * one interface, rather than four copies of the bridge:
 *
 *   - `tcp`  — a Mac with Screen Sharing on, a published container port, Modal's unencrypted tunnel.
 *   - `tls`  — Modal's `tls_socket`, and anything behind a TLS TCP proxy.
 *   - `ws`/`wss` — websockify, which is the only shape a sandbox behind an HTTP reverse proxy can
 *     take. E2B Desktop, Vercel Sandbox and Namespace's HTTP ingress all reduce to this.
 *
 * Note what the WebSocket case makes possible and the others do not: HEADERS. A sandbox behind an
 * authenticating proxy — Namespace's `x-nsc-ingress-auth` is the named example — needs a bearer on
 * the upgrade request, and a browser cannot set one on a WebSocket at all. That is not a detail; it
 * is a second reason the relay has to be here rather than in the renderer.
 */
export type ByteChannel = {
  write(b: Buffer): void;
  onData(fn: (b: Buffer) => void): void;
  /** Fires once, whichever way the connection ended. */
  onClose(fn: () => void): void;
  onError(fn: (e: Error) => void): void;
  /** Fires when the far end is reachable — TCP connected, TLS negotiated, upgrade accepted. */
  onOpen(fn: () => void): void;
  close(): void;
};

export type DialTarget = {
  transport: MachineTransport;
  host: string;
  port: number;
  path: string;
  /** Sent on the upgrade request, `ws`/`wss` only. A secret; see `machineSecretBox`. */
  headers?: Record<string, string>;
  /** Test seam. Production leaves this alone; the live-ish tests point it at a local server whose
   *  certificate nothing has signed, and a suite that needed a real CA would not have one. */
  rejectUnauthorized?: boolean;
};

/** An IPv4 or IPv6 literal, which may not carry an SNI name. Deliberately crude: anything that is
 *  not obviously an address is treated as a hostname, which is the safe direction — a hostname
 *  wrongly sent as SNI is what every TLS client does anyway. */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export function dial(t: DialTarget): ByteChannel {
  return t.transport === "ws" || t.transport === "wss" ? dialWebSocket(t) : dialSocket(t);
}

/** `tcp` and `tls` differ by one function and one option, so they are one implementation. */
function dialSocket(t: DialTarget): ByteChannel {
  const socket = t.transport === "tls"
    /* `servername` is not optional in practice: every TLS tunnel worth reaching multiplexes on SNI,
       and a connection without it is answered by whatever the front end serves by default — which
       for Modal means somebody else's tunnel, or a 404 page.
       Omitted for an IP literal, and that is not a nicety: RFC 6066 forbids SNI for one, Node warns
       today and says it will ignore it in a future version. Sending it there is a deprecation
       warning now and a silently different connection later. */
    ? tlsConnect({ host: t.host, port: t.port, servername: isIpLiteral(t.host) ? undefined : t.host, rejectUnauthorized: t.rejectUnauthorized })
    : tcpConnect({ host: t.host, port: t.port });
  // Nagle off: RFB is request/response during the handshake and latency-sensitive after it, and
  // 40ms of coalescing is visible as a laggy pointer.
  socket.on("connect", () => socket.setNoDelay(true));
  return {
    write: (b) => { if (!socket.destroyed) socket.write(b); },
    onData: (fn) => socket.on("data", (d: Buffer) => fn(d)),
    onClose: (fn) => socket.once("close", fn),
    onError: (fn) => socket.on("error", fn),
    // `secureConnect` rather than `connect` for TLS: the socket is reachable when the handshake has
    // finished, not when the TCP connection has. Waiting on the wrong one writes an RFB version line
    // into a TLS negotiation.
    onOpen: (fn) => socket.once(t.transport === "tls" ? "secureConnect" : "connect", fn),
    close: () => socket.destroy(),
  };
}

function dialWebSocket(t: DialTarget): ByteChannel {
  const url = `${t.transport}://${t.host}:${t.port}${t.path.startsWith("/") ? t.path : `/${t.path}`}`;
  /* `binary` is websockify's own subprotocol, and the second argument is where `ws` takes one — an
     `options.protocol` is silently nothing, which is how the first version of this offered no
     subprotocol at all while claiming to.
     Offered rather than omitted, and measured rather than assumed: older websockify builds REQUIRE
     it and refuse an upgrade without it, while a server that does not care answers with no
     `Sec-WebSocket-Protocol` at all — and `ws` accepts that reply rather than failing the connection
     the way RFC 6455 permits. So offering it is a free gain in compatibility, which is the only
     reason it is worth sending something modern noVNC stopped sending years ago. */
  const ws = new WebSocket(url, ["binary"], {
    headers: t.headers,
    rejectUnauthorized: t.rejectUnauthorized,
  });
  ws.binaryType = "nodebuffer";
  return {
    write: (b) => { if (ws.readyState === ws.OPEN) ws.send(b); },
    onData: (fn) => ws.on("message", (d) => {
      // `ws` hands back a Buffer, an array of them, or an ArrayBuffer depending on how the frame
      // arrived. All three are the same bytes, and the handshake cannot tell them apart.
      if (Buffer.isBuffer(d)) fn(d);
      else if (Array.isArray(d)) fn(Buffer.concat(d));
      else fn(Buffer.from(d as ArrayBuffer));
    }),
    onClose: (fn) => ws.once("close", fn),
    onError: (fn) => ws.on("error", fn),
    onOpen: (fn) => ws.once("open", fn),
    close: () => { try { ws.terminate(); } catch { /* already gone */ } },
  };
}

/** What a dial failure is called, when the transport itself can say. `ECONNREFUSED` is the same
 *  answer whichever way it was reached; a TLS or upgrade failure is a different thing entirely and
 *  says so, because "unreachable" against a host that is plainly up sends someone hunting the wrong
 *  problem. */
export function describeDialError(t: DialTarget, e: Error): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return `nothing is listening on port ${t.port} at that address`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `no host called ${t.host}`;
  if (code === "ETIMEDOUT") return "the connection timed out";
  if (t.transport === "tls" && /certificate|ssl|tls|alert/i.test(e.message)) {
    return `the TLS handshake failed: ${e.message}. If that endpoint is plaintext, switch the transport to TCP.`;
  }
  if ((t.transport === "ws" || t.transport === "wss") && /unexpected server response|redirect|invalid/i.test(e.message)) {
    return `${e.message} — that URL answered, but not with a WebSocket. Check that websockify is running and that the path is right.`;
  }
  return e.message;
}
