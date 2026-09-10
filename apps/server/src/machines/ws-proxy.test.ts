import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CLIENT_HANDSHAKE_BYTES, MachineWsProxy, type MachineTarget } from "./ws-proxy";
import { RFB_VERSION, vncAuthResponse } from "./rfb-handshake";

/**
 * The relay, end to end: a real TCP server speaking real RFB on one side, a real WebSocket client on
 * the other, and Realm's proxy in the middle.
 *
 * Everything here is about the seam rather than the protocol — `rfb-handshake.test.ts` already owns
 * the bytes. What this can settle and that cannot: whether the password stays on this side of the
 * socket, whether a client that connects mid-handshake is told anything before there is a screen,
 * and whether the first frame survives arriving in the same read as the ServerInit.
 */

const CHALLENGE = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
const serverInit = (w: number, h: number, name: string) => {
  const n = Buffer.from(name, "utf8");
  const b = Buffer.alloc(24 + n.length);
  b.writeUInt16BE(w, 0); b.writeUInt16BE(h, 2); b.writeUInt32BE(n.length, 20); n.copy(b, 24);
  return b;
};

/** A VNC server, as much of one as a handshake needs. `script` decides what it offers. */
function fakeVnc(opts: {
  security?: number[];
  password?: string;
  /** Sent glued to the ServerInit, to prove the proxy does not eat it. */
  trailing?: Buffer;
  /** Answer nothing at all after accepting — a Mac that is asleep. */
  mute?: boolean;
} = {}) {
  const seen: Buffer[] = [];
  let sock: Socket | null = null;
  const server: Server = createServer((s) => {
    sock = s;
    if (opts.mute) return;
    let phase: "version" | "type" | "auth" | "init" = "version";
    s.write(Buffer.from(RFB_VERSION, "latin1"));
    s.on("data", (d) => {
      seen.push(Buffer.from(d));
      if (phase === "version") {
        s.write(Buffer.from([(opts.security ?? [1]).length, ...(opts.security ?? [1])]));
        phase = "type";
        return;
      }
      if (phase === "type") {
        if (d[0] === 2) { s.write(CHALLENGE); phase = "auth"; return; }
        s.write(Buffer.from([0, 0, 0, 0]));   // SecurityResult: ok
        phase = "init";
        return;
      }
      if (phase === "auth") {
        const want = vncAuthResponse(CHALLENGE, opts.password ?? "");
        if (!Buffer.from(d).equals(want)) {
          const why = Buffer.from("bad password", "utf8");
          const fail = Buffer.alloc(8 + why.length);
          fail.writeUInt32BE(1, 0); fail.writeUInt32BE(why.length, 4); why.copy(fail, 8);
          s.write(fail);
          return;
        }
        s.write(Buffer.from([0, 0, 0, 0]));
        phase = "init";
        return;
      }
      // ClientInit → ServerInit, with anything the test wants glued to it.
      s.write(Buffer.concat([serverInit(1712, 1069, "MacBook"), opts.trailing ?? Buffer.alloc(0)]));
    });
    s.on("error", () => { /* the proxy hanging up is normal here */ });
  });
  return {
    server, seen,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port))),
    close: () => { sock?.destroy(); server.close(); },
  };
}

/** Collect everything the client is sent, and settle on a predicate. */
function client(url: string) {
  const ws = new WebSocket(url);
  const chunks: Buffer[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.binaryType = "nodebuffer";
  ws.on("message", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)));
  ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
  ws.on("error", () => { /* a refused upgrade lands in `close` */ });
  const all = () => Buffer.concat(chunks);
  const until = async (p: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!p() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    return p();
  };
  return { ws, chunks, all, until, closedAs: () => closed, send: (b: Buffer) => ws.send(b) };
}

const proxies: MachineWsProxy[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.close();
  for (const s of servers.splice(0)) s.close();
});

async function bring(target: Partial<MachineTarget> & { port: number }, over: Partial<ConstructorParameters<typeof MachineWsProxy>[0]> = {}) {
  const events: string[] = [];
  const proxy = new MachineWsProxy({
    targetFor: () => ({ transport: "tcp" as const, host: "127.0.0.1", path: "/websockify", password: null, ...target }),
    onConnected: (id, s) => events.push(`connected ${id} ${s.width}x${s.height}`),
    onFailed: (id, e, detail) => events.push(`failed ${id} ${e} ${detail}`),
    onClosed: (id) => events.push(`closed ${id}`),
    ...over,
  });
  proxies.push(proxy);
  await proxy.listen();
  return { proxy, events };
}

describe("the machine relay", () => {
  it("authenticates on this side and hands the client a screen it never had to log into", async () => {
    const vnc = fakeVnc({ security: [2], password: "hunter2" });
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy, events } = await bring({ port, password: "hunter2" });

    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => c.all().length >= 24 + 7)).toBe(true);

    const got = c.all();
    // The synthetic negotiation: our version, one security type (None), a success result…
    expect(got.subarray(0, 12).toString("latin1")).toBe(RFB_VERSION);
    expect(got.subarray(12, 14).toString("hex")).toBe("0101");
    expect(got.readUInt32BE(14)).toBe(0);
    // …and the REAL ServerInit, which is the one thing that must not be manufactured.
    expect(got.readUInt16BE(18)).toBe(1712);
    expect(got.readUInt16BE(20)).toBe(1069);
    expect(events).toContain("connected m1 1712x1069");

    /* The property the whole design exists for. The password authenticated the far end and the
       client was never told a password was involved: it saw a security list offering None, so there
       is no code path in the renderer that could have one, and nothing in these bytes carries it. */
    expect(got.toString("latin1")).not.toContain("hunter2");
    expect(got.toString("hex")).not.toContain(vncAuthResponse(CHALLENGE, "hunter2").toString("hex"));
    expect(got.toString("hex")).not.toContain(CHALLENGE.toString("hex"));
    c.ws.close();
  });

  /* A server that ships a framebuffer update in the same write as its ServerInit is not exotic —
     it is what an already-running screen does. The proxy consumes exactly the ServerInit's bytes and
     forwards the remainder; dropping it would leave the pane on a blank canvas until something in
     the guest happened to move, which reads as a broken connection. */
  it("forwards bytes that arrived glued to the ServerInit rather than eating them", async () => {
    const trailing = Buffer.from("deadbeefcafe", "hex");
    const vnc = fakeVnc({ trailing });
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy } = await bring({ port });

    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => c.all().includes(trailing))).toBe(true);
    expect(c.all().subarray(-trailing.length).toString("hex")).toBe(trailing.toString("hex"));
    c.ws.close();
  });

  it("tells the client NOTHING until there is a screen — a failure is a closed socket, not a blank one", async () => {
    const vnc = fakeVnc({ security: [2], password: "correct" });
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy, events } = await bring({ port, password: "wrong" });

    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => c.closedAs() !== null)).toBe(true);
    // Not one byte of a half-negotiated protocol: a client that had seen a version line and then a
    // hangup would have shown a connected pane going blank, where this shows the failure body.
    expect(c.all()).toHaveLength(0);
    expect(c.closedAs()!.code).toBe(1011);
    expect(events.join(" ")).toContain("failed m1 auth_failed");
    expect(events.join(" ")).toContain("bad password");
  });

  it("names a port with nothing behind it instead of hanging on it", async () => {
    // Bound and immediately closed, so the port is real and certainly refuses.
    const dead = createServer();
    const port = await new Promise<number>((r) => dead.listen(0, "127.0.0.1", () => r((dead.address() as { port: number }).port)));
    await new Promise<void>((r) => dead.close(() => r()));
    const { proxy, events } = await bring({ port });

    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => events.length > 0)).toBe(true);
    expect(events[0]).toContain("failed m1 unreachable");
    expect(events[0]).toContain(`nothing is listening on port ${port}`);
  });

  /* The token is the guard, not the port: anything on this Mac can reach a loopback listener. An
     unauthorised upgrade is destroyed at the socket rather than accepted and closed, so a probe
     cannot even learn that it had the path shape right. */
  it("refuses an upgrade whose token is wrong, without opening a WebSocket at all", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy } = await bring({ port });
    const { port: proxyPort } = proxy.info();

    for (const path of [`/vnc/not-the-token/m1`, `/vnc/m1`, `/`, `/vnc/${proxy.info().token}/m1/extra`]) {
      const c = client(`ws://127.0.0.1:${proxyPort}${path}`);
      expect(await c.until(() => c.closedAs() !== null), path).toBe(true);
      expect(c.all(), path).toHaveLength(0);
    }
    // …and the correct one still works, so the refusals above are about the token and not about the
    // listener being broken.
    const good = client(proxy.urlFor("m1"));
    expect(await good.until(() => good.all().length > 0)).toBe(true);
    good.ws.close();
  });

  it("refuses a machine the service will not name a target for", async () => {
    const { proxy } = await bring({ port: 1 }, { targetFor: () => null });
    const c = client(proxy.urlFor("gone"));
    expect(await c.until(() => c.closedAs() !== null)).toBe(true);
    expect(c.closedAs()!.reason).toBe("no such machine");
  });

  /* Input only flows once the client has been told there is a screen. Before that it has been told
     nothing, so it has nothing to say — and anything it did say would be injected into the middle of
     Realm's own negotiation, arriving as the first byte of a challenge or a ClientInit. */
  /**
   * The bug a live check found and every test here missed, and the reason it missed it.
   *
   * The replay hands the client a synthetic negotiation, and a real RFB client ANSWERS it: 12 bytes
   * of version line, one byte choosing a security type, one byte of ClientInit. Those 14 bytes are a
   * reply to Realm. Forwarded to the machine — which finished its own handshake a moment earlier and
   * is now reading messages — they arrive as message type 0x52, "R" of "RFB", and the far end stops
   * answering for good.
   *
   * What shipped: a correctly-sized, permanently black canvas, not one FramebufferUpdateRequest in
   * the server's log, and a green suite. Green because every test client here was a raw WebSocket
   * that never answered the replay, so none of them ever sent the bytes that break it. This one
   * answers.
   */
  it("swallows the client's OWN handshake instead of forwarding it into the machine's message stream", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy } = await bring({ port });

    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => c.all().length >= 24)).toBe(true);
    const beforeReply = vnc.seen.length;

    // Exactly what a real client says back, and then a real message after it.
    c.send(Buffer.from("RFB 003.008\n", "latin1"));
    c.send(Buffer.from([1]));                       // security type: None, the only one offered
    c.send(Buffer.from([1]));                       // ClientInit: shared
    const request = Buffer.from([3, 0, 0, 0, 0, 0, 5, 160, 3, 132]);   // FramebufferUpdateRequest
    c.send(request);
    await c.until(() => vnc.seen.length > beforeReply, 2000);

    const forwarded = Buffer.concat(vnc.seen.slice(beforeReply));
    // Not one byte of the client's handshake reached the machine…
    expect(forwarded.toString("latin1")).not.toContain("RFB 003.008");
    // …and the real message behind it did, or the screen would never be asked for.
    expect(forwarded.toString("hex")).toContain(request.toString("hex"));
  });

  it("keeps a real message that arrived in the SAME frame as the client's handshake", async () => {
    // noVNC packs SetPixelFormat and SetEncodings in immediately behind ClientInit. Dropping the
    // whole frame instead of just its handshake prefix leaves the screen never asked for — the same
    // black canvas by a different route.
    const vnc = fakeVnc();
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy } = await bring({ port });
    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => c.all().length >= 24)).toBe(true);
    const before = vnc.seen.length;

    const request = Buffer.from([3, 0, 0, 0, 0, 0, 5, 160, 3, 132]);
    c.send(Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([1, 1]), request]));
    await c.until(() => vnc.seen.length > before, 2000);
    const forwarded = Buffer.concat(vnc.seen.slice(before));
    expect(forwarded.toString("hex")).toBe(request.toString("hex"));
  });

  it("counts the client's handshake rather than parsing it, because both ends of it are ours", () => {
    // `replayForClient` offers exactly one security type, so there is exactly one legal reply and
    // its length is a constant: version + chosen type + ClientInit.
    expect(CLIENT_HANDSHAKE_BYTES).toBe(14);
  });

  it("drops anything the client sends before the handshake finishes", async () => {
    const vnc = fakeVnc({ security: [2], password: "pw" });
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy } = await bring({ port, password: "pw" });

    const c = client(proxy.urlFor("m1"));
    await c.until(() => c.ws.readyState === c.ws.OPEN);
    c.send(Buffer.from("ffffffffffffffff", "hex"));   // straight into the negotiation, if it got through
    expect(await c.until(() => c.all().length >= 24)).toBe(true);
    expect(vnc.seen.map((b) => b.toString("hex")).join(" ")).not.toContain("ffffffffffffffff");
    c.ws.close();
  });

  it("gives up on a machine that accepts the connection and then says nothing", async () => {
    const vnc = fakeVnc({ mute: true });
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy, events } = await bring({ port });
    const c = client(proxy.urlFor("m1"));
    /* The idle timeout is the shorter of the two deadlines and this is exactly what it is for. It
       has to stay armed past the TCP connect to catch this at all — clearing it on `connect`, which
       is the obvious place, leaves the commonest real failure to the ten-second wall deadline. */
    expect(await c.until(() => events.length > 0, 8000)).toBe(true);
    expect(events[0]).toContain("failed m1 unreachable");
    expect(events[0]).toContain("said nothing");
  }, 12_000);

  it("drops every live bridge for one machine on disconnect, and leaves the listener up", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const port = await vnc.listen();
    const { proxy } = await bring({ port });

    const c = client(proxy.urlFor("m1"));
    expect(await c.until(() => c.all().length > 0)).toBe(true);
    proxy.disconnect("m1");
    expect(await c.until(() => c.closedAs() !== null)).toBe(true);
    // The relay is still serving: a stop is one machine's connection, not the whole surface.
    const again = client(proxy.urlFor("m1"));
    expect(await again.until(() => again.all().length > 0)).toBe(true);
    again.ws.close();
  });

  it("mints a URL with the token in the path and no room for a secret in it", async () => {
    const { proxy } = await bring({ port: 1 });
    const url = proxy.urlFor("m1");
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[A-Za-z0-9_-]+\/m1$/);
    expect(new URL(url).search).toBe("");
    // Bound to loopback, so the guard is the token AND the interface rather than either alone.
    expect(url).toContain("127.0.0.1");
  });
});
