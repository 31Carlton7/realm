import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { EMPTY } from "./bytes";
import { x25519, x25519Generate, type KeyPair } from "./keys";

/**
 * The Noise Protocol Framework, revision 34, for exactly the three protocols Realm Mobile uses
 * (PROTOCOL.md §4): IK, IKpsk1 and K, each with 25519, AES-GCM and SHA-256.
 *
 * AES-GCM rather than ChaCha20-Poly1305 because realm-server runs on Electron's Node, whose BoringSSL
 * has no `chacha20-poly1305` cipher (measured on Electron 37.10.3), while the suite's Node does — a
 * ChaCha build would pass every test here and fail in the shipped app.
 *
 * Checked against the published cacophony and snow vectors (test/noise-vectors.json) and against the
 * Swift implementation through the fixtures in PROTOCOL.md §9.
 */

export const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;
/** Noise reserves n = 2^64 - 1, so a cipher may use every nonce below it and no more. */
const NONCE_LIMIT = 2n ** 64n - 1n;

export class NoiseError extends Error {}

/** AES-GCM's Noise nonce: four zero bytes, then the counter big-endian (the spec's AESGCM rule; ChaChaPoly
 *  would be little-endian, which is the mistake a byte-order mutant in the tests stands for). */
function nonceBytes(n: bigint): Buffer {
  const b = Buffer.alloc(12);
  b.writeBigUInt64BE(n, 4);
  return b;
}

function encrypt(k: Buffer, n: bigint, ad: Buffer, plaintext: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", k, nonceBytes(n), { authTagLength: TAGLEN });
  c.setAAD(ad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function decrypt(k: Buffer, n: bigint, ad: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < TAGLEN) throw new NoiseError("ciphertext shorter than its tag");
  const d = createDecipheriv("aes-256-gcm", k, nonceBytes(n), { authTagLength: TAGLEN });
  d.setAAD(ad);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  try {
    return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), d.final()]);
  } catch {
    throw new NoiseError("decryption failed");
  }
}

const hash = (data: Buffer): Buffer => createHash("sha256").update(data).digest();
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

/** Noise's HKDF (§4.3): HMAC-SHA256 extract, then two or three chained expands. */
function hkdf(ck: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  const o2 = hmac(temp, Buffer.concat([o1, Buffer.from([2])]));
  if (outputs === 2) return [o1, o2];
  return [o1, o2, hmac(temp, Buffer.concat([o2, Buffer.from([3])]))];
}

export class CipherState {
  private n = 0n;
  constructor(private k: Buffer | null = null) {}

  hasKey(): boolean { return this.k !== null; }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) return Buffer.from(plaintext);
    if (this.n >= NONCE_LIMIT) throw new NoiseError("nonce exhausted");
    const out = encrypt(this.k, this.n, ad, plaintext);
    this.n += 1n;
    return out;
  }

  /** The nonce only advances on success, so a forged frame cannot desynchronise the two ends. */
  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.k) return Buffer.from(ciphertext);
    if (this.n >= NONCE_LIMIT) throw new NoiseError("nonce exhausted");
    const out = decrypt(this.k, this.n, ad, ciphertext);
    this.n += 1n;
    return out;
  }
}

class SymmetricState {
  ck: Buffer;
  h: Buffer;
  cs = new CipherState();

  constructor(protocolName: string) {
    const name = Buffer.from(protocolName, "utf8");
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : hash(name);
    this.ck = Buffer.from(this.h);
  }

  mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf(this.ck, ikm, 2) as [Buffer, Buffer];
    this.ck = ck;
    this.cs = new CipherState(k);
  }

  mixHash(data: Buffer): void { this.h = hash(Buffer.concat([this.h, data])); }

  mixKeyAndHash(ikm: Buffer): void {
    const [ck, h, k] = hkdf(this.ck, ikm, 3) as [Buffer, Buffer, Buffer];
    this.ck = ck;
    this.mixHash(h);
    this.cs = new CipherState(k);
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2) as [Buffer, Buffer];
    return [new CipherState(k1), new CipherState(k2)];
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";
type Pattern = { pre: { initiator: "s"[]; responder: "s"[] }; messages: Token[][] };

const PATTERNS = {
  IK: { pre: { initiator: [], responder: ["s"] }, messages: [["e", "es", "s", "ss"], ["e", "ee", "se"]] },
  IKpsk1: { pre: { initiator: [], responder: ["s"] }, messages: [["e", "es", "s", "ss", "psk"], ["e", "ee", "se"]] },
  K: { pre: { initiator: ["s"], responder: ["s"] }, messages: [["e", "es", "ss"]] },
} satisfies Record<string, Pattern>;

export type PatternName = keyof typeof PATTERNS;

export const protocolName = (pattern: PatternName): string => `Noise_${pattern}_25519_AESGCM_SHA256`;

export type HandshakeOptions = {
  pattern: PatternName;
  initiator: boolean;
  prologue: Buffer;
  /** This side's static key pair, where the pattern has one. */
  s?: KeyPair;
  /** The other side's static public key, where the pattern requires knowing it in advance. */
  rs?: Buffer;
  psk?: Buffer;
  /** Tests only: a fixed ephemeral key, which is how the published vectors are reproduced. */
  e?: KeyPair;
};

/** One handshake, run by one side. `writeMessage` and `readMessage` alternate as the pattern says; when the
 *  last message has passed, `transport` holds the two ciphers (`send`, `receive`) for this side. */
export class HandshakeState {
  private readonly pattern: Pattern;
  private readonly ss: SymmetricState;
  private readonly isPsk: boolean;
  private readonly initiator: boolean;
  private s?: KeyPair;
  private e?: KeyPair;
  private rs?: Buffer;
  private re?: Buffer;
  private psk?: Buffer;
  private index = 0;
  transport: { send: CipherState; receive: CipherState } | null = null;

  constructor(o: HandshakeOptions) {
    this.pattern = PATTERNS[o.pattern];
    this.initiator = o.initiator;
    this.s = o.s;
    this.e = o.e;
    this.rs = o.rs ? Buffer.from(o.rs) : undefined;
    this.psk = o.psk;
    this.isPsk = o.pattern.includes("psk");
    if (this.isPsk && (!this.psk || this.psk.length !== 32)) throw new NoiseError("a psk pattern needs a 32-byte psk");
    this.ss = new SymmetricState(protocolName(o.pattern));
    this.ss.mixHash(o.prologue);
    // Pre-messages: the initiator's keys first, then the responder's (§7.1).
    for (const _ of this.pattern.pre.initiator) this.ss.mixHash(this.requireKey(o.initiator ? this.s?.pub : this.rs, "initiator static"));
    for (const _ of this.pattern.pre.responder) this.ss.mixHash(this.requireKey(o.initiator ? this.rs : this.s?.pub, "responder static"));
  }

  /** The handshake hash: a value both sides agree on once the handshake is done, usable to bind it. */
  get handshakeHash(): Buffer { return Buffer.from(this.ss.h); }

  /** The remote static key, learned during the handshake (IK's responder learns the phone's here). */
  get remoteStatic(): Buffer | undefined { return this.rs ? Buffer.from(this.rs) : undefined; }

  get done(): boolean { return this.index >= this.pattern.messages.length; }

  private requireKey(k: Buffer | undefined, what: string): Buffer {
    if (!k) throw new NoiseError(`missing ${what} key`);
    return k;
  }

  private myTurn(): boolean { return (this.index % 2 === 0) === this.initiator; }

  private dh(token: "ee" | "es" | "se" | "ss"): Buffer {
    const s = () => this.requireKey(this.s?.priv, "local static");
    const e = () => this.requireKey(this.e?.priv, "local ephemeral");
    const rs = () => this.requireKey(this.rs, "remote static");
    const re = () => this.requireKey(this.re, "remote ephemeral");
    switch (token) {
      case "ee": return x25519(e(), re());
      case "ss": return x25519(s(), rs());
      // es: the initiator's ephemeral with the responder's static, seen from each side.
      case "es": return this.initiator ? x25519(e(), rs()) : x25519(s(), re());
      case "se": return this.initiator ? x25519(s(), re()) : x25519(e(), rs());
    }
  }

  writeMessage(payload: Buffer): Buffer {
    if (this.done) throw new NoiseError("handshake already complete");
    if (!this.myTurn()) throw new NoiseError("not this side's turn to write");
    const out: Buffer[] = [];
    for (const token of this.pattern.messages[this.index]!) {
      if (token === "e") {
        this.e ??= x25519Generate();
        out.push(this.e.pub);
        this.ss.mixHash(this.e.pub);
        if (this.isPsk) this.ss.mixKey(this.e.pub);
      } else if (token === "s") {
        out.push(this.ss.encryptAndHash(this.requireKey(this.s?.pub, "local static")));
      } else if (token === "psk") {
        this.ss.mixKeyAndHash(this.psk!);
      } else {
        this.ss.mixKey(this.dh(token));
      }
    }
    out.push(this.ss.encryptAndHash(payload));
    this.advance();
    return Buffer.concat(out);
  }

  readMessage(message: Buffer): Buffer {
    if (this.done) throw new NoiseError("handshake already complete");
    if (this.myTurn()) throw new NoiseError("not this side's turn to read");
    let off = 0;
    const take = (n: number): Buffer => {
      if (off + n > message.length) throw new NoiseError("handshake message too short");
      const b = message.subarray(off, off + n);
      off += n;
      return b;
    };
    for (const token of this.pattern.messages[this.index]!) {
      if (token === "e") {
        this.re = Buffer.from(take(DHLEN));
        this.ss.mixHash(this.re);
        if (this.isPsk) this.ss.mixKey(this.re);
      } else if (token === "s") {
        this.rs = this.ss.decryptAndHash(take(this.ss.cs.hasKey() ? DHLEN + TAGLEN : DHLEN));
      } else if (token === "psk") {
        this.ss.mixKeyAndHash(this.psk!);
      } else {
        this.ss.mixKey(this.dh(token));
      }
    }
    const payload = this.ss.decryptAndHash(message.subarray(off));
    this.advance();
    return payload;
  }

  private advance(): void {
    this.index += 1;
    if (!this.done) return;
    const [c1, c2] = this.ss.split();
    // The initiator sends with the first cipher; one-way patterns only ever use that one.
    this.transport = this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }
}
