import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { b64u, fromHex, hex } from "../src/bytes";
import { FrameReader, sealMessage } from "../src/frames";
import { ed25519Public, x25519Pair } from "../src/keys";
import { deviceId } from "../src/keys";
import { encodeLink, LinkError, parseLink } from "../src/link";
import { CipherState, HandshakeState, type PatternName } from "../src/noise";
import { PROLOGUE } from "../src/protocol";
import { runVector, type Vector } from "./vectors";

/**
 * The cross-implementation fixtures of PROTOCOL.md §9. TypeScript writes them from fixed keys; Swift's
 * suite must open every one, and this suite opens Swift's. They are generated, not hand-written, so
 * this test also proves the committed files are exactly what the code produces today:
 * `REALM_WRITE_FIXTURES=1 pnpm vitest run --project remote test/fixtures.test.ts` rewrites them.
 */

const dir = new URL("./fixtures/", import.meta.url);
const swiftVectors = new URL("../../../apps/ios/RealmKit/Tests/Fixtures/swift-vectors.json", import.meta.url);
const WRITE = process.env.REALM_WRITE_FIXTURES === "1";

/** A fixed 32-byte value from a label, so every key in the fixtures is reproducible. */
const fixed = (label: string): Buffer => createHash("sha256").update(`realm fixture: ${label}`).digest();

const macDh = x25519Pair(fixed("mac dh"));
const phoneDh = x25519Pair(fixed("phone dh"));
const macId = deviceId(ed25519Public(fixed("mac sign")));
const phoneSign = ed25519Public(fixed("phone sign"));
const phoneId = deviceId(phoneSign);
const windowId = b64u(fixed("window").subarray(0, 16));
const secret = fixed("pairing secret");
const AT = 1_790_000_000_000;

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), "utf8");
/** A transport plaintext as §5 frames it: the final-fragment flag, then the message. */
const frame = (v: unknown): Buffer => Buffer.concat([Buffer.from([0]), json(v)]);

function vector(name: string, pattern: PatternName, prologue: Buffer, init: { s: ReturnType<typeof x25519Pair>; rs?: Buffer }, resp: { s: ReturnType<typeof x25519Pair>; rs?: Buffer }, payloads: Buffer[], psk?: Buffer): Vector {
  const ie = x25519Pair(fixed(`${name} initiator ephemeral`));
  const re = x25519Pair(fixed(`${name} responder ephemeral`));
  const i = new HandshakeState({ pattern, initiator: true, prologue, s: init.s, rs: init.rs, e: ie, psk });
  const r = new HandshakeState({ pattern, initiator: false, prologue, s: resp.s, rs: resp.rs, e: re, psk });
  const messages: Vector["messages"] = [];
  const oneWay = pattern === "K";
  const handshakeLength = oneWay ? 1 : 2;
  for (const [n, p] of payloads.entries()) {
    const fromInit = oneWay || n % 2 === 0;
    let ct: Buffer;
    if (n < handshakeLength) {
      const [w, rd] = fromInit ? [i, r] : [r, i];
      ct = w.writeMessage(p);
      rd.readMessage(ct);
    } else {
      const [w, rd] = fromInit ? [i.transport!, r.transport!] : [r.transport!, i.transport!];
      ct = w.send.encryptWithAd(Buffer.alloc(0), p);
      rd.receive.decryptWithAd(Buffer.alloc(0), ct);
    }
    messages.push({ payload: hex(p), ciphertext: hex(ct) });
  }
  return {
    protocol_name: `Noise_${pattern}_25519_AESGCM_SHA256`,
    init_prologue: hex(prologue), init_static: hex(init.s.priv), init_ephemeral: hex(ie.priv), ...(init.rs ? { init_remote_static: hex(init.rs) } : {}), ...(psk ? { init_psks: [hex(psk)] } : {}),
    resp_prologue: hex(prologue), resp_static: hex(resp.s.priv), resp_ephemeral: hex(re.priv), ...(resp.rs ? { resp_remote_static: hex(resp.rs) } : {}), ...(psk ? { resp_psks: [hex(psk)] } : {}),
    handshake_hash: hex(i.handshakeHash),
    messages,
  };
}

function tsVectors(): { note: string; ids: Record<string, string>; vectors: Vector[] } {
  return {
    note: "Written by packages/remote/test/fixtures.test.ts from fixed keys: Realm's prologues and payloads, in the Noise vector format. RealmKit must reproduce every message.",
    ids: { macId, phoneId, windowId },
    vectors: [
      vector("pairing", "IKpsk1", PROLOGUE.pair(macId, windowId), { s: phoneDh, rs: macDh.pub }, { s: macDh }, [
        json({ v: 1, name: "Carlton’s iPhone", model: "iPhone18,1", sign: b64u(phoneSign) }),
        json({ v: 1, mac: "MacBook Pro" }),
        frame({ id: 0, method: "ping", params: {} }),
        frame({ event: "pair.result", payload: { ok: true, phoneId } }),
      ], secret),
      vector("connection", "IK", PROLOGUE.ik(macId, phoneId), { s: phoneDh, rs: macDh.pub }, { s: macDh }, [
        json({ v: 1, app: "0.1 (1)", os: "iOS 27.0" }),
        json({ v: 1, mac: "MacBook Pro", server: "1.6.0" }),
        frame({ id: 1, method: "ping", params: {} }),
        frame({ id: 1, ok: true, result: { at: AT } }),
        frame({ id: 2, method: "session.open", params: { id: "01JSESSION", limit: 200 } }),
        frame({ event: "session.status", payload: { id: "01JSESSION", status: "running" } }),
      ]),
      vector("push", "K", PROLOGUE.push(macId, phoneId), { s: macDh, rs: phoneDh.pub }, { s: phoneDh, rs: macDh.pub }, [
        json({ v: 1, id: "01JPUSH", at: AT, kind: "permission", title: "Fix the flaky test", body: "Wants to run `pnpm test`", session: "01JSESSION" }),
      ]),
    ],
  };
}

function tsFrames(): { key: string; messages: { json: string; frames: string[] }[] } {
  const key = fixed("frames key");
  const cs = new CipherState(key);
  const big = JSON.stringify({ event: "session.rows", payload: { id: "01JSESSION", rows: Array.from({ length: 680 }, (_, n) => ({ key: `e:${n}`, seq: n, kind: "notice", text: `Row ${n} — ${"ä".repeat(80)}` })) } });
  const pad = (target: number): string => { const base = JSON.stringify({ pad: "" }); return JSON.stringify({ pad: "x".repeat(target - base.length) }); };
  const messages = [JSON.stringify({ id: 1, method: "ping", params: {} }), big, pad(65_518), pad(65_519), JSON.stringify({ event: "home.changed", payload: {} })];
  return { key: hex(key), messages: messages.map((m) => ({ json: m, frames: sealMessage(cs, m).map(hex) })) };
}

function tsLinks(): { now: number; url: string; fields: Record<string, unknown> | null; error: string | null }[] {
  const link = { relay: "wss://relay.example", macId, macKey: macDh.pub, secret, windowId, macName: "MacBook Pro", expiresAt: AT + 300_000 };
  const fields = { relay: link.relay, macId, macKey: b64u(macDh.pub), secret: b64u(secret), windowId, macName: link.macName, expiresAt: link.expiresAt };
  const good = encodeLink(link);
  return [
    { now: AT, url: good, fields, error: null },
    { now: AT, url: encodeLink(link, "realm-mobile://pair"), fields, error: null },
    { now: AT + 300_000, url: good, fields: null, error: "expired" },
    { now: AT, url: good.replace("#1.", "#2."), fields: null, error: "version" },
    { now: AT, url: "https://realm.computer/pair#1.not-json", fields: null, error: "malformed" },
  ];
}

const files = { "ts-vectors.json": tsVectors, "ts-frames.json": tsFrames, "ts-links.json": tsLinks } as const;

describe("cross-implementation fixtures", () => {
  for (const [name, make] of Object.entries(files)) {
    it(`${name} is exactly what the code writes today`, () => {
      const text = `${JSON.stringify(make(), null, 1)}\n`;
      const path = new URL(name, dir);
      if (WRITE) writeFileSync(path, text);
      expect(readFileSync(path, "utf8")).toBe(text);
    });
  }

  it("every TypeScript vector replays through both sides", () => {
    for (const v of tsVectors().vectors) expect(runVector(v), v.protocol_name).toBeNull();
  });

  it("every frame fixture opens back to its message, fragment boundaries included", () => {
    const f = tsFrames();
    const reader = new FrameReader(new CipherState(fromHex(f.key)));
    const counts = f.messages.map((m) => {
      const out = m.frames.map((x) => reader.push(fromHex(x)));
      expect(out.at(-1)).toBe(m.json);
      expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
      return m.frames.length;
    });
    expect(counts).toEqual([1, 3, 1, 2, 1]);
    expect(Buffer.byteLength(f.messages[1]!.json)).toBeGreaterThan(150_000);
  });

  it("every link fixture parses to its fields, or fails for its reason", () => {
    for (const l of tsLinks()) {
      if (l.error) {
        expect(() => parseLink(l.url, l.now)).toThrow(LinkError);
        try { parseLink(l.url, l.now); } catch (e) { expect((e as LinkError).reason).toBe(l.error); }
      } else {
        const p = parseLink(l.url, l.now);
        expect({ relay: p.relay, macId: p.macId, macKey: b64u(p.macKey), secret: b64u(p.secret), windowId: p.windowId, macName: p.macName, expiresAt: p.expiresAt }).toEqual(l.fields);
      }
    }
  });

  it.skipIf(!existsSync(swiftVectors))("Swift's vectors replay through this implementation", () => {
    const s = JSON.parse(readFileSync(swiftVectors, "utf8")) as { vectors: Vector[] };
    expect(s.vectors.length).toBeGreaterThan(0);
    for (const v of s.vectors) expect(runVector(v), v.protocol_name).toBeNull();
  });
});
