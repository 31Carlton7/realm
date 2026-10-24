import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync } from "node:fs";
import { request } from "node:http";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import { z } from "zod";
import { tempDir } from "@realm/test-utils";
import { RpcServer } from "../rpc/server";
import { hasOpenssl, selfSignedCert } from "./cert.test-fakes";
import { HandshakeLimiter } from "./limiter";
import { startAccess, type Access } from "./service";
import { createToken, revokeToken } from "./tokens";

const open: { rpc: RpcServer; access: Access | null }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) { await o.access?.close(); await o.rpc.close(); }
});

/** A server with one method that says who called it, behind a remote listener on loopback. */
async function rig(o: { tls?: { cert: string; key: string }; limiter?: HandshakeLimiter; sweepMs?: number; tlsCheckMs?: number } = {}) {
  const home = tempDir("realm-access-");
  const rpc = new RpcServer();
  rpc.register("whoami", z.object({}), async (_p, ctx) => ({ principal: ctx.principal }));
  const lines: string[] = [];
  const entry = { rpc, access: null as Access | null };
  open.push(entry);
  const localPort = await rpc.listen(0, "127.0.0.1", { token: "the-daemon-token" });
  entry.access = await startAccess({ rpc, home, log: (l) => lines.push(l), listen: { host: "127.0.0.1", port: 0, tls: o.tls ?? null, allowPlaintext: false }, limiter: o.limiter, sweepMs: o.sweepMs, tlsCheckMs: o.tlsCheckMs });
  return { home, rpc, access: entry.access, localPort, lines, url: entry.access.url };
}

type Dial = { ok: true; ws: WebSocket } | { ok: false; status: number | null; error: string };

function dial(url: string, protocols: string[], options: WebSocket.ClientOptions = {}): Promise<Dial> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, options);
    ws.once("open", () => resolve({ ok: true, ws }));
    ws.once("unexpected-response", (_req, res) => { resolve({ ok: false, status: res.statusCode ?? null, error: "" }); res.resume(); ws.terminate(); });
    ws.once("error", (e) => resolve({ ok: false, status: null, error: (e as NodeJS.ErrnoException).code ?? e.message }));
  });
}

function call(ws: WebSocket, method: string, params: unknown = {}): Promise<{ ok: boolean; result?: any; error?: { code: string } }> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const on = (data: WebSocket.RawData) => { const m = JSON.parse(data.toString()); if (m.id === id) { ws.off("message", on); resolve(m); } };
    ws.on("message", on);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

describe("the remote listener", () => {
  it("refuses a handshake with no token, a wrong one, or the daemon's own", async () => {
    const r = await rig();
    createToken(r.home, "laptop");
    expect(await dial(r.url, [])).toMatchObject({ ok: false, status: 401 });
    expect(await dial(r.url, [`realm.rlm_${"A".repeat(43)}`])).toMatchObject({ ok: false, status: 401 });
    expect(await dial(r.url, ["realm.the-daemon-token"])).toMatchObject({ ok: false, status: 401 });
    // The daemon token still opens the loopback socket it belongs to.
    expect((await dial(`ws://127.0.0.1:${r.localPort}`, ["realm.the-daemon-token"])).ok).toBe(true);
  });

  it("lets an access token in, as the owner on another machine, never as `local`", async () => {
    const r = await rig();
    const t = createToken(r.home, "laptop");
    const d = await dial(r.url, [`realm.${t.token}`]);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.ws.protocol).toBe(`realm.${t.token}`);
    expect((await call(d.ws, "whoami")).result).toEqual({ principal: `token:${t.id}` });
    expect(r.lines.some((l) => l.includes(`remote client "laptop" (token ${t.id}) connected from 127.0.0.1`))).toBe(true);
    d.ws.close();
  });

  it("refuses a browser page even when it holds a valid token", async () => {
    const r = await rig();
    const t = createToken(r.home, "laptop");
    expect(await dial(r.url, [`realm.${t.token}`], { origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 });
    expect(await dial(r.url, [`realm.${t.token}`], { origin: "file://" })).toMatchObject({ ok: false, status: 403 });
  });

  it("blocks an address after ten refusals, valid token or not, and lets it back in after the block", async () => {
    let now = 1_000_000;
    const r = await rig({ limiter: new HandshakeLimiter({ now: () => now }) });
    const t = createToken(r.home, "laptop");
    for (let i = 0; i < 10; i++) expect(await dial(r.url, ["realm.wrong"])).toMatchObject({ ok: false, status: 401 });
    expect(await dial(r.url, [`realm.${t.token}`])).toMatchObject({ ok: false, status: 429 });
    expect(r.lines.filter((l) => l.includes("too many refused handshakes"))).toHaveLength(1);
    now += 61_000;
    const d = await dial(r.url, [`realm.${t.token}`]);
    expect(d.ok).toBe(true);
    if (d.ok) d.ws.close();
  });

  it("closes a client whose token is revoked, and refuses that token from then on", async () => {
    const r = await rig({ sweepMs: 50 });
    const keep = createToken(r.home, "desktop");
    const gone = createToken(r.home, "laptop");
    const a = await dial(r.url, [`realm.${gone.token}`]);
    const b = await dial(r.url, [`realm.${keep.token}`]);
    if (!a.ok || !b.ok) throw new Error("both should connect");
    const closed = new Promise<number>((res) => a.ws.once("close", (code) => res(code)));
    revokeToken(r.home, "laptop");
    await closed;
    expect(b.ws.readyState).toBe(WebSocket.OPEN); // only the revoked token's client went
    expect(await dial(r.url, [`realm.${gone.token}`])).toMatchObject({ ok: false, status: 401 });
    b.ws.close();
  });

  it("answers a plain HTTP request with nothing but 426", async () => {
    const r = await rig();
    const status = await new Promise<number>((res, rej) => {
      const req = request(r.url.replace("ws://", "http://"), (resp) => { resp.resume(); res(resp.statusCode ?? 0); });
      req.once("error", rej); req.end();
    });
    expect(status).toBe(426);
  });

  it("binds nothing on an address the rules refuse", async () => {
    const rpc = new RpcServer();
    await expect(startAccess({ rpc, home: tempDir("realm-access-"), log: () => {}, listen: { host: "0.0.0.0", port: 0, tls: null, allowPlaintext: true } }))
      .rejects.toMatchObject({ code: "LISTEN_REFUSED" });
    await rpc.close();
  });
});

describe.skipIf(!hasOpenssl)("the remote listener over TLS", () => {
  it("speaks wss:// to a client that trusts its certificate, and nothing to one that does not", async () => {
    const c = selfSignedCert();
    const r = await rig({ tls: c });
    const t = createToken(r.home, "laptop");
    expect(r.url.startsWith("wss://")).toBe(true);
    const d = await dial(r.url, [`realm.${t.token}`], { ca: c.ca });
    expect(d.ok).toBe(true);
    if (d.ok) { expect((await call(d.ws, "whoami")).result.principal).toBe(`token:${t.id}`); d.ws.close(); }
    // No `ca`: the self-signed certificate is not trusted, and no token was ever sent.
    expect(await dial(r.url, [`realm.${t.token}`])).toMatchObject({ ok: false, error: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    // Plain ws:// to the TLS port gets no WebSocket either.
    expect((await dial(r.url.replace("wss://", "ws://"), [`realm.${t.token}`])).ok).toBe(false);
  });

  it("serves a certificate renewed on disk without a restart", async () => {
    const first = selfSignedCert("first");
    const second = selfSignedCert("second");
    const dir = tempDir("realm-cert-live-");
    const cert = `${dir}/cert.pem`, key = `${dir}/key.pem`;
    copyFileSync(first.cert, cert); copyFileSync(first.key, key);
    const r = await rig({ tls: { cert, key }, tlsCheckMs: 50 });
    const t = createToken(r.home, "laptop");
    const servedCn = async (ca: string): Promise<string | null> => {
      const d = await dial(r.url, [`realm.${t.token}`], { ca });
      if (!d.ok) return null;
      const cn = ((d.ws as unknown as { _socket: TLSSocket })._socket.getPeerCertificate().subject as { CN?: string }).CN ?? null;
      d.ws.close();
      return cn;
    };
    expect(await servedCn(first.ca)).toBe("first");
    copyFileSync(second.cert, cert); copyFileSync(second.key, key);
    await new Promise((res) => setTimeout(res, 300));
    expect(await servedCn(second.ca)).toBe("second");
    expect(r.lines.some((l) => l.includes("loaded the renewed TLS certificate"))).toBe(true);
  });
});
