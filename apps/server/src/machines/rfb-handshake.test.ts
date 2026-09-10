import { describe, expect, it } from "vitest";
import { RFB_VERSION, handshakeStep, replayForClient, vncAuthKey, vncAuthResponse, type HandshakeState } from "./rfb-handshake";

/** Feed a whole conversation through the state machine, one chunk at a time, and collect what it
 *  wanted to send. `chunkSize` is the point of the whole helper — see the partial-read test. */
function run(script: Buffer, password: string | null, chunkSize = Infinity) {
  let state: HandshakeState = { phase: "version" };
  let buf = Buffer.alloc(0);
  const sent: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const step = handshakeStep(state, buf, password);
    if (step.kind === "wait") {
      if (cursor >= script.length) return { outcome: "starved" as const, sent };
      const take = Math.min(chunkSize, script.length - cursor);
      buf = Buffer.concat([buf, script.subarray(cursor, cursor + take)]);
      cursor += take;
      continue;
    }
    if (step.kind === "fail") return { outcome: step, sent };
    if (step.kind === "done") return { outcome: step, sent };
    sent.push(step.bytes);
    buf = buf.subarray(step.consumed);
    state = step.state;
  }
}

const version = (v = "003.008") => Buffer.from(`RFB ${v}\n`, "latin1");
const secList = (...types: number[]) => Buffer.from([types.length, ...types]);
const serverInit = (w: number, h: number, name: string) => {
  const n = Buffer.from(name, "utf8");
  const b = Buffer.alloc(24 + n.length);
  b.writeUInt16BE(w, 0); b.writeUInt16BE(h, 2);
  b.writeUInt32BE(n.length, 20); n.copy(b, 24);
  return b;
};
const ok32 = Buffer.from([0, 0, 0, 0]);

describe("VNC authentication", () => {
  /**
   * Known-answer vectors, minted from BoringSSL's own `des-ecb` (Electron's crypto) and pinned here.
   *
   * They exist to hold two things that are otherwise invisible. The first is the BIT REVERSAL — RFC
   * 6143 §7.2.2 reverses every byte of the password before using it as a DES key, and an
   * implementation that skips it looks completely correct and gets every password wrong. The second
   * is the cipher: this file spells single DES as `des-ede3` with the key three times, because
   * `des-ecb` is in OpenSSL 3's legacy provider and simply does not exist in the Node this suite runs
   * on, while it does exist in the Electron the app ships. Anyone "simplifying" that back to
   * `des-ecb` gets a green app and a red suite; anyone dropping the triple-key trick gets different
   * bytes, and these vectors are what says so.
   */
  it.each([
    ["password", "0e86ceceeef64e26", "00".repeat(16), "ff97502e9422f089ff97502e9422f089"],
    ["hunter2", "16ae762ea64e4c00", "0102030405060708090a0b0c0d0e0f10", "1a642601360e5298e1402ebb083b9ac6"],
    // Truncated at 8 bytes, which is the protocol's own limit and not a Realm decision.
    ["a-very-long-password-truncated", "86b46ea64e9eb436", "ffeeddccbbaa99887766554433221100", "7dd17a5edd0f43818ef8b1b24c8a05da"],
    ["", "0000000000000000", "00112233445566778899aabbccddeeff", "74f4ae777aa431e89ca4757b2414f4d7"],
  ])("%s → the key and the response the spec says", (password, key, challenge, expected) => {
    expect(vncAuthKey(password).toString("hex")).toBe(key);
    expect(vncAuthResponse(Buffer.from(challenge, "hex"), password).toString("hex")).toBe(expected);
  });

  it("truncates at eight bytes rather than hashing or refusing", () => {
    expect(vncAuthResponse(Buffer.alloc(16), "12345678").equals(vncAuthResponse(Buffer.alloc(16), "12345678ignored"))).toBe(true);
  });

  it("answers a 16-byte challenge with exactly 16 bytes — padding off", () => {
    expect(vncAuthResponse(Buffer.alloc(16), "pw")).toHaveLength(16);
  });
});

describe("the handshake", () => {
  it("takes None over VNC auth when both are offered, and never sends a password it did not need", () => {
    const script = Buffer.concat([version(), secList(2, 1), ok32, serverInit(1440, 900, "iMac")]);
    const r = run(script, "the-password");
    expect(r.outcome).toMatchObject({ kind: "done", width: 1440, height: 900, name: "iMac" });
    // Our version, then the chosen type, then ClientInit. The chosen type is 1 — a server that will
    // take us without a password must not be handed one.
    expect(r.sent.map((b) => b.toString("hex"))).toEqual([
      Buffer.from(RFB_VERSION, "latin1").toString("hex"), "01", "01",
    ]);
  });

  it("does VNC auth when that is all there is, and answers the challenge", () => {
    const challenge = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const script = Buffer.concat([version(), secList(2), challenge, ok32, serverInit(800, 600, "vnc")]);
    const r = run(script, "hunter2");
    expect(r.outcome).toMatchObject({ kind: "done", width: 800, height: 600 });
    expect(r.sent[1]!.toString("hex")).toBe("02");
    expect(r.sent[2]!.toString("hex")).toBe("1a642601360e5298e1402ebb083b9ac6");
  });

  /* TCP does not deliver messages, it delivers bytes. Every hand-rolled protocol client's bugs are
     in the partial reads, and this is the one test that can find them: the same conversation, one
     byte at a time, has to reach the same answer. */
  it("reaches the same answer when every message arrives one byte at a time", () => {
    const script = Buffer.concat([version(), secList(2), Buffer.alloc(16, 7), ok32, serverInit(1280, 800, "a name long enough to straddle a read")]);
    const whole = run(script, "pw");
    const dribbled = run(script, "pw", 1);
    expect(dribbled.outcome).toEqual(whole.outcome);
    expect(dribbled.sent.map((b) => b.toString("hex"))).toEqual(whole.sent.map((b) => b.toString("hex")));
  });

  it("names something that is not a VNC server at all, rather than waiting on it", () => {
    const r = run(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), null);
    expect(r.outcome).toMatchObject({ kind: "fail", error: "not_rfb" });
  });

  /* The refusal that matters most in practice: macOS Screen Sharing set to require a MACOS ACCOUNT
     password offers only Apple's Diffie-Hellman types, and Realm speaks none of them. Saying which
     ones it saw is what lets the pane tell someone to switch on the VNC password instead — where a
     silent hang, which is what an unhandled type gives, tells them nothing. */
  it("refuses Apple's own security types by name instead of hanging", () => {
    const r = run(Buffer.concat([version(), secList(30, 33, 35)]), "pw");
    expect(r.outcome).toMatchObject({ kind: "fail", error: "auth_unsupported" });
    expect((r.outcome as { detail: string }).detail).toContain("Apple");
  });

  it("refuses VNC auth with no password saved, rather than sending an empty one", () => {
    const r = run(Buffer.concat([version(), secList(2)]), null);
    expect(r.outcome).toMatchObject({ kind: "fail", error: "auth_failed" });
    expect((r.outcome as { detail: string }).detail).toContain("none is saved");
  });

  it("reads the server's own reason out of a failed result", () => {
    const reason = Buffer.from("Too many authentication failures", "utf8");
    const fail = Buffer.alloc(8 + reason.length);
    fail.writeUInt32BE(1, 0); fail.writeUInt32BE(reason.length, 4); reason.copy(fail, 8);
    const r = run(Buffer.concat([version(), secList(2), Buffer.alloc(16), fail]), "pw");
    expect(r.outcome).toMatchObject({ kind: "fail", error: "auth_failed", detail: "Too many authentication failures" });
  });

  it("reads a zero-length security list as the refusal it is", () => {
    const reason = Buffer.from("Your connection has been rejected", "utf8");
    const empty = Buffer.alloc(5 + reason.length);
    empty.writeUInt8(0, 0); empty.writeUInt32BE(reason.length, 1); reason.copy(empty, 5);
    const r = run(Buffer.concat([version(), empty]), "pw");
    expect(r.outcome).toMatchObject({ kind: "fail", error: "auth_failed", detail: "Your connection has been rejected" });
  });

  /* 3.3 states one type and takes no answer, and sends no SecurityResult after `None`. Waiting for
     four bytes that never arrive is a hang against exactly the old embedded servers this supports. */
  it("speaks to a 3.3 server, which negotiates nothing and sends no result", () => {
    const type = Buffer.alloc(4); type.writeUInt32BE(1, 0);
    const r = run(Buffer.concat([version("003.003"), type, serverInit(640, 480, "old")]), null);
    expect(r.outcome).toMatchObject({ kind: "done", width: 640, height: 480 });
  });

  /* ClientInit's byte is 1 — SHARED. A 0 asks the server to disconnect every other viewer, and doing
     that to somebody's own session on their own Mac is the one thing this must never do. */
  it("always asks to share the screen, never to take it", () => {
    for (const script of [
      Buffer.concat([version(), secList(1), ok32, serverInit(10, 10, "")]),
      Buffer.concat([version(), secList(2), Buffer.alloc(16), ok32, serverInit(10, 10, "")]),
    ]) {
      const r = run(script, "pw");
      expect(r.sent.at(-1)!.toString("hex")).toBe("01");
    }
  });
});

describe("what the renderer's client is replayed", () => {
  /* The renderer's RFB client starts at the beginning of the protocol, and by the time it connects
     the real handshake is long over. So it is handed a synthetic one — and the ONE thing that must
     not be synthetic is the ServerInit, which is where the framebuffer's real size lives. A replay
     that manufactured that too would give the pane a screen of the wrong shape and every click would
     land somewhere else. */
  it("manufactures the negotiation and passes the framebuffer's own description through verbatim", () => {
    const real = serverInit(1712, 1069, "Carlton's MacBook Pro");
    const r = replayForClient(real);
    expect(r.version.toString("latin1")).toBe(RFB_VERSION);
    expect(r.security.toString("hex")).toBe("0101");   // one type on offer, and it is None
    expect(r.result.readUInt32BE(0)).toBe(0);
    expect(r.serverInit).toBe(real);                   // the same buffer, not a rebuilt one
  });
});
