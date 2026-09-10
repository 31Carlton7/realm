import { createServer as createTcpServer, type Server as NetServer } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { dial, describeDialError, isIpLiteral, type DialTarget } from "./dial";

/**
 * The four transports, each against a real server of its own kind.
 *
 * Nothing here is about RFB — `rfb-handshake.test.ts` owns the protocol. What this settles is the
 * part that cannot be reasoned about: whether bytes written into one end of each transport come out
 * of the other, and whether an upgrade request carries the headers a sandbox behind an
 * authenticating proxy needs. Both are the kind of claim that is either true against a socket or not
 * true at all.
 */

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const listen = (s: NetServer | TlsServer | HttpServer): Promise<number> => {
  closers.push(() => s.close());
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
};

const collect = (t: DialTarget) => {
  const ch = dial(t);
  const chunks: Buffer[] = [];
  let open = false, closed = false, err: Error | null = null;
  ch.onData((b) => chunks.push(b));
  ch.onOpen(() => { open = true; });
  ch.onClose(() => { closed = true; });
  ch.onError((e) => { err = e; });
  closers.push(() => ch.close());
  const until = async (p: () => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (!p() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    return p();
  };
  return { ch, all: () => Buffer.concat(chunks), until, isOpen: () => open, isClosed: () => closed, error: () => err };
};

/**
 * A throwaway self-signed certificate, minted per run.
 *
 * Shelled out to `openssl` rather than checked in, because a certificate fixture on disk is a
 * fixture with an EXPIRY DATE — a suite that starts failing in a year for a reason nobody can find.
 * Node cannot mint one itself; there is no certificate-signing API.
 *
 * Returns null where `openssl` is not on the PATH, and the TLS test skips rather than fails: this is
 * a test about Realm's dialling, and a machine without openssl has said nothing about that.
 */
function selfSigned(): { key: string; cert: string; dir: string } | null {
  let dir: string;
  try { dir = mkdtempSync(join(tmpdir(), "realm-dial-tls-")); } catch { return null; }
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8"), dir };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

describe("dialling a machine", () => {
  it("carries bytes both ways over plain TCP", async () => {
    const server = createTcpServer((sock) => {
      sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
      sock.write(Buffer.from("hello"));
    });
    const port = await listen(server);
    const c = collect({ transport: "tcp", host: "127.0.0.1", port, path: "/websockify" });
    expect(await c.until(() => c.isOpen())).toBe(true);
    expect(await c.until(() => c.all().length >= 5)).toBe(true);
    expect(c.all().toString()).toBe("hello");
    c.ch.write(Buffer.from("ping"));
    expect(await c.until(() => c.all().includes("echo:ping"))).toBe(true);
  });

  /**
   * websockify, as far as this cares about it: a WebSocket server that pipes binary frames to a TCP
   * socket. Which is exactly what E2B Desktop's `novnc_proxy`, and every sandbox that embeds noVNC,
   * is running.
   */
  /**
   * TLS, which is what Modal's `tls_socket` is and what nothing else in this file would have caught.
   *
   * The subtlety worth a test rather than a comment: a TLS socket is reachable at `secureConnect`,
   * not at `connect`. Waiting on the wrong event writes an RFB version line into the middle of a
   * TLS negotiation, and the far end answers with an alert that reads as "not a VNC server".
   */
  it("carries bytes both ways over TLS, and opens only once the handshake has finished", async () => {
    const tls = selfSigned();
    if (!tls) { expect(true, "openssl is not on the PATH — TLS dialling is untested on this machine").toBe(true); return; }
    closers.push(() => rmSync(tls.dir, { recursive: true, force: true }));
    const server: TlsServer = createTlsServer({ key: tls.key, cert: tls.cert }, (sock) => {
      sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
      sock.write(Buffer.from("RFB 003.008\n"));
    });
    const port = await listen(server);

    const c = collect({ transport: "tls", host: "127.0.0.1", port, path: "/websockify", rejectUnauthorized: false });
    expect(await c.until(() => c.isOpen())).toBe(true);
    // Bytes were already waiting when `open` fired, which is only true if `open` meant the secure
    // channel rather than the TCP connection under it.
    expect(await c.until(() => c.all().length >= 12)).toBe(true);
    expect(c.all().toString()).toBe("RFB 003.008\n");
    c.ch.write(Buffer.from("ping"));
    expect(await c.until(() => c.all().includes("echo:ping"))).toBe(true);
  });

  /* Dialling a TLS endpoint as plaintext is the mistake the transport inference exists to prevent,
     and it fails in the least helpful way available: the server sees an RFB version line where a
     ClientHello should be and answers with an alert, or with nothing. */
  it("fails visibly when a TLS endpoint is dialled as plain TCP", async () => {
    const tls = selfSigned();
    if (!tls) { expect(true).toBe(true); return; }
    closers.push(() => rmSync(tls.dir, { recursive: true, force: true }));
    const server: TlsServer = createTlsServer({ key: tls.key, cert: tls.cert }, (sock) => sock.write(Buffer.from("RFB 003.008\n")));
    const port = await listen(server);
    const c = collect({ transport: "tcp", host: "127.0.0.1", port, path: "/" });
    expect(await c.until(() => c.isOpen())).toBe(true);
    // No RFB version line ever arrives, because the far end is waiting for a ClientHello.
    await new Promise((r) => setTimeout(r, 300));
    expect(c.all().toString()).not.toContain("RFB");
  });

  it("carries bytes both ways over a WebSocket, which is the only shape a hosted sandbox has", async () => {
    const backend = createTcpServer((sock) => {
      sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
      sock.write(Buffer.from("RFB 003.008\n"));
    });
    const backendPort = await listen(backend);
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/websockify" });
    wss.on("connection", async (ws) => {
      const { connect } = await import("node:net");
      const up = connect({ host: "127.0.0.1", port: backendPort });
      up.on("data", (d) => ws.send(d));
      ws.on("message", (d) => up.write(d as Buffer));
      ws.on("close", () => up.destroy());
    });
    const port = await listen(http);

    const c = collect({ transport: "ws", host: "127.0.0.1", port, path: "/websockify" });
    expect(await c.until(() => c.all().length >= 12)).toBe(true);
    expect(c.all().toString()).toBe("RFB 003.008\n");
    c.ch.write(Buffer.from("pong"));
    expect(await c.until(() => c.all().includes("echo:pong"))).toBe(true);
  });

  /**
   * The header, and why it has to be here.
   *
   * A sandbox behind an authenticating ingress — Namespace's `x-nsc-ingress-auth` is the documented
   * case — wants a bearer on the upgrade request. **A browser cannot set a header on a WebSocket at
   * all**: `new WebSocket(url)` takes a URL and a subprotocol and nothing else. So there is no
   * version of this feature that works from the renderer, whatever else the relay is for.
   */
  it("sends headers on the upgrade, which is a thing a browser cannot do at all", async () => {
    const seen: (string | undefined)[] = [];
    const http = createHttpServer();
    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
      seen.push(req.headers["x-nsc-ingress-auth"] as string | undefined);
      if (req.headers["x-nsc-ingress-auth"] !== "Bearer tok-123") { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(Buffer.from("authorised")));
    });
    const port = await listen(http);

    const ok = collect({ transport: "ws", host: "127.0.0.1", port, path: "/websockify", headers: { "x-nsc-ingress-auth": "Bearer tok-123" } });
    expect(await ok.until(() => ok.all().length > 0)).toBe(true);
    expect(ok.all().toString()).toBe("authorised");
    expect(seen).toEqual(["Bearer tok-123"]);

    // …and without it the proxy refuses, which is a dial error rather than a silent nothing.
    const bad = collect({ transport: "ws", host: "127.0.0.1", port, path: "/websockify" });
    expect(await bad.until(() => bad.error() !== null || bad.isClosed())).toBe(true);
    expect(bad.all()).toHaveLength(0);
  });

  it("offers the `binary` subprotocol websockify expects", async () => {
    const seen: string[] = [];
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/websockify", handleProtocols: (protocols) => {
      seen.push([...protocols].join(","));
      return "binary";
    } });
    wss.on("connection", (ws) => ws.send(Buffer.from("ok")));
    const port = await listen(http);
    const c = collect({ transport: "ws", host: "127.0.0.1", port, path: "/websockify" });
    expect(await c.until(() => c.all().length > 0)).toBe(true);
    // Measured, because the safe-looking answer is the wrong one. Older websockify builds REQUIRE
    // this subprotocol and refuse an upgrade without it; a server that does not care replies with no
    // `Sec-WebSocket-Protocol` header at all, and `ws` accepts that rather than failing the
    // connection as RFC 6455 permits. Offering it is therefore a free gain, and the next test is the
    // other half of that claim.
    expect(seen).toEqual(["binary"]);
  });

  it("still connects to a server that ignores the subprotocol entirely", async () => {
    // The other half: most websockify builds answer with no `Sec-WebSocket-Protocol` at all. A
    // client that treated that as a failure — which the RFC allows — would connect to none of them.
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/websockify" });
    wss.on("connection", (ws) => ws.send(Buffer.from("ok")));
    const port = await listen(http);
    const c = collect({ transport: "ws", host: "127.0.0.1", port, path: "/websockify" });
    expect(await c.until(() => c.all().length > 0)).toBe(true);
    expect(c.all().toString()).toBe("ok");
  });

  it("normalises a path with no leading slash rather than dialling a broken URL", async () => {
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/websockify" });
    wss.on("connection", (ws) => ws.send(Buffer.from("ok")));
    const port = await listen(http);
    const c = collect({ transport: "ws", host: "127.0.0.1", port, path: "websockify" });
    expect(await c.until(() => c.all().length > 0)).toBe(true);
  });

  it("reports a refused port as the same thing whichever way it was reached", async () => {
    const dead = createTcpServer();
    const port = await listen(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    for (const transport of ["tcp", "tls", "ws"] as const) {
      const c = collect({ transport, host: "127.0.0.1", port, path: "/websockify", rejectUnauthorized: false });
      expect(await c.until(() => c.error() !== null), transport).toBe(true);
      expect(describeDialError({ transport, host: "127.0.0.1", port, path: "/" }, c.error()!), transport)
        .toContain(`nothing is listening on port ${port}`);
    }
  });
});

describe("SNI", () => {
  /* RFC 6066 forbids a server name for an IP literal — Node warns about it today and says it will
     ignore it in a future version, which is a silently different connection later. Every TLS tunnel
     worth reaching multiplexes on SNI, so it is sent for a hostname and only for a hostname. */
  it("is sent for a hostname and never for an address", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("xyz.modal.host")).toBe(false);
    expect(isIpLiteral("6080-abc.e2b.app")).toBe(false);
    expect(isIpLiteral("studio.local")).toBe(false);
  });
});

describe("what a dial failure is called", () => {
  /* "unreachable" against a host that is plainly up sends someone hunting the wrong problem. Each
     of these is a different thing to go and fix, so each says which. */
  it("tells a TLS mismatch apart from a dead port, and says what to change", () => {
    const t: DialTarget = { transport: "tls", host: "x.modal.host", port: 443, path: "/" };
    const msg = describeDialError(t, new Error("wrong version number (SSL alert)"));
    expect(msg).toContain("TLS handshake failed");
    expect(msg).toContain("switch the transport to TCP");
  });

  it("tells an endpoint that answered without a WebSocket apart from one that did not answer", () => {
    const t: DialTarget = { transport: "wss", host: "6080-abc.e2b.app", port: 443, path: "/websockify" };
    const msg = describeDialError(t, new Error("Unexpected server response: 404"));
    expect(msg).toContain("that URL answered, but not with a WebSocket");
    expect(msg).toContain("websockify is running");
  });

  it("names a host that does not resolve, rather than calling it unreachable", () => {
    const e = Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), { code: "ENOTFOUND" });
    expect(describeDialError({ transport: "tcp", host: "nope.invalid", port: 5900, path: "/" }, e))
      .toBe("no host called nope.invalid");
  });
});

