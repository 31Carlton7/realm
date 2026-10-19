import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { x25519Generate } from "../src/keys";
import { HandshakeState, NoiseError } from "../src/noise";
import { PROLOGUE } from "../src/protocol";
import { runVector, type Vector } from "./vectors";

const published = JSON.parse(readFileSync(new URL("./noise-vectors.json", import.meta.url), "utf8")) as { vectors: (Vector & { source: string })[] };

describe("the published Noise vectors", () => {
  it("covers all three protocols Realm uses, from both suites", () => {
    const names = new Set(published.vectors.map((v) => v.protocol_name));
    expect([...names].sort()).toEqual(["Noise_IK_25519_AESGCM_SHA256", "Noise_IKpsk1_25519_AESGCM_SHA256", "Noise_K_25519_AESGCM_SHA256"]);
    expect(new Set(published.vectors.map((v) => v.source.includes("snow") ? "snow" : "cacophony")).size).toBe(2);
  });

  for (const v of published.vectors) {
    it(`${v.protocol_name} (${v.source.includes("snow") ? "snow" : "cacophony"}) reproduces byte for byte`, () => {
      expect(runVector(v)).toBeNull();
    });
  }
});

describe("handshakes", () => {
  const mac = x25519Generate();
  const phone = x25519Generate();
  const prologue = PROLOGUE.ik("mac-id", "phone-id");

  it("IK authenticates both sides and gives each the other's static key", () => {
    const i = new HandshakeState({ pattern: "IK", initiator: true, prologue, s: phone, rs: mac.pub });
    const r = new HandshakeState({ pattern: "IK", initiator: false, prologue, s: mac });
    expect(r.readMessage(i.writeMessage(Buffer.from("hello"))).toString()).toBe("hello");
    expect(r.remoteStatic?.equals(phone.pub)).toBe(true);
    expect(i.readMessage(r.writeMessage(Buffer.from("welcome"))).toString()).toBe("welcome");
    expect(i.handshakeHash.equals(r.handshakeHash)).toBe(true);
    const ct = i.transport!.send.encryptWithAd(Buffer.alloc(0), Buffer.from("over the wire"));
    expect(r.transport!.receive.decryptWithAd(Buffer.alloc(0), ct).toString()).toBe("over the wire");
  });

  it("IK fails when the two sides were told different ids", () => {
    const i = new HandshakeState({ pattern: "IK", initiator: true, prologue: PROLOGUE.ik("mac-id", "phone-a"), s: phone, rs: mac.pub });
    const r = new HandshakeState({ pattern: "IK", initiator: false, prologue: PROLOGUE.ik("mac-id", "phone-b"), s: mac });
    expect(() => r.readMessage(i.writeMessage(Buffer.from("hello")))).toThrow(NoiseError);
  });

  it("IK fails against a Mac that is not the one the phone paired with", () => {
    const impostor = x25519Generate();
    const i = new HandshakeState({ pattern: "IK", initiator: true, prologue, s: phone, rs: mac.pub });
    const r = new HandshakeState({ pattern: "IK", initiator: false, prologue, s: impostor });
    expect(() => r.readMessage(i.writeMessage(Buffer.from("hello")))).toThrow(NoiseError);
  });

  it("IKpsk1 refuses a phone that does not hold the QR code's secret, at the first message", () => {
    const secret = Buffer.alloc(32, 7);
    const pairPrologue = PROLOGUE.pair("mac-id", "window");
    const i = new HandshakeState({ pattern: "IKpsk1", initiator: true, prologue: pairPrologue, s: phone, rs: mac.pub, psk: Buffer.alloc(32, 8) });
    const r = new HandshakeState({ pattern: "IKpsk1", initiator: false, prologue: pairPrologue, s: mac, psk: secret });
    expect(() => r.readMessage(i.writeMessage(Buffer.from("{}")))).toThrow(NoiseError);
  });

  it("K opens only with the right sender, recipient and prologue", () => {
    const seal = (sender = mac, recipient = phone.pub, p = PROLOGUE.push("m", "p")) =>
      new HandshakeState({ pattern: "K", initiator: true, prologue: p, s: sender, rs: recipient }).writeMessage(Buffer.from("payload"));
    const open = (blob: Buffer, p = PROLOGUE.push("m", "p")) =>
      new HandshakeState({ pattern: "K", initiator: false, prologue: p, s: phone, rs: mac.pub }).readMessage(blob);
    expect(open(seal()).toString()).toBe("payload");
    expect(() => open(seal(x25519Generate()))).toThrow(NoiseError);
    expect(() => open(seal(), PROLOGUE.push("m", "another-phone"))).toThrow(NoiseError);
    const tampered = seal();
    tampered[tampered.length - 1]! ^= 1;
    expect(() => open(tampered)).toThrow(NoiseError);
  });

  it("refuses to write out of turn or past the end", () => {
    const i = new HandshakeState({ pattern: "IK", initiator: true, prologue, s: phone, rs: mac.pub });
    expect(() => i.readMessage(Buffer.alloc(64))).toThrow(/turn/);
    const k = new HandshakeState({ pattern: "K", initiator: true, prologue, s: mac, rs: phone.pub });
    k.writeMessage(Buffer.alloc(0));
    expect(() => k.writeMessage(Buffer.alloc(0))).toThrow(/complete/);
  });

  it("a forged transport frame does not advance the nonce, so the next real one still opens", () => {
    const i = new HandshakeState({ pattern: "IK", initiator: true, prologue, s: phone, rs: mac.pub });
    const r = new HandshakeState({ pattern: "IK", initiator: false, prologue, s: mac });
    r.readMessage(i.writeMessage(Buffer.alloc(0)));
    i.readMessage(r.writeMessage(Buffer.alloc(0)));
    const real = i.transport!.send.encryptWithAd(Buffer.alloc(0), Buffer.from("real"));
    expect(() => r.transport!.receive.decryptWithAd(Buffer.alloc(0), Buffer.alloc(40, 1))).toThrow(NoiseError);
    expect(r.transport!.receive.decryptWithAd(Buffer.alloc(0), real).toString()).toBe("real");
  });
});
