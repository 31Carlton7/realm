import { fromHex, hex } from "../src/bytes";
import { x25519Pair } from "../src/keys";
import { HandshakeState, type CipherState, type PatternName } from "../src/noise";

/** One vector in the cacophony/snow format (PROTOCOL.md §9) — the same shape Realm's own cross fixtures use. */
export type Vector = {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static?: string;
  resp_ephemeral?: string;
  resp_remote_static?: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
};

const PATTERN_OF: Record<string, PatternName> = {
  Noise_IK_25519_AESGCM_SHA256: "IK",
  Noise_IKpsk1_25519_AESGCM_SHA256: "IKpsk1",
  Noise_K_25519_AESGCM_SHA256: "K",
};

export const patternOf = (name: string): PatternName => {
  const p = PATTERN_OF[name];
  if (!p) throw new Error(`no pattern for ${name}`);
  return p;
};

const pair = (h?: string) => (h ? x25519Pair(fromHex(h)) : undefined);

/** Plays a vector through both sides: every message written by one side must equal the vector's
 *  ciphertext byte for byte, and read back to its payload by the other. Returns what went wrong, or
 *  null — so a test can report every failing vector rather than the first. */
export function runVector(v: Vector): string | null {
  const pattern = patternOf(v.protocol_name);
  const oneWay = pattern === "K";
  const handshakeLength = oneWay ? 1 : 2;
  const init = new HandshakeState({
    pattern, initiator: true, prologue: fromHex(v.init_prologue), s: pair(v.init_static), e: pair(v.init_ephemeral),
    rs: v.init_remote_static ? fromHex(v.init_remote_static) : undefined, psk: v.init_psks?.[0] ? fromHex(v.init_psks[0]) : undefined,
  });
  const resp = new HandshakeState({
    pattern, initiator: false, prologue: fromHex(v.resp_prologue), s: pair(v.resp_static), e: pair(v.resp_ephemeral),
    rs: v.resp_remote_static ? fromHex(v.resp_remote_static) : undefined, psk: v.resp_psks?.[0] ? fromHex(v.resp_psks[0]) : undefined,
  });
  let initT: { send: CipherState; receive: CipherState } | null = null;
  let respT: { send: CipherState; receive: CipherState } | null = null;
  for (const [i, m] of v.messages.entries()) {
    const fromInitiator = oneWay || i % 2 === 0;
    const payload = fromHex(m.payload);
    let ct: Buffer;
    let back: Buffer;
    try {
      if (i < handshakeLength) {
        const [w, r] = fromInitiator ? [init, resp] : [resp, init];
        ct = w.writeMessage(payload);
        back = r.readMessage(ct);
        if (i === handshakeLength - 1) {
          initT = init.transport;
          respT = resp.transport;
          if (v.handshake_hash && hex(init.handshakeHash) !== v.handshake_hash) return `handshake hash differs (initiator)`;
          if (v.handshake_hash && hex(resp.handshakeHash) !== v.handshake_hash) return `handshake hash differs (responder)`;
        }
      } else {
        if (!initT || !respT) return "no transport after the handshake";
        const [w, r] = fromInitiator ? [initT, respT] : [respT, initT];
        ct = w.send.encryptWithAd(Buffer.alloc(0), payload);
        back = r.receive.decryptWithAd(Buffer.alloc(0), ct);
      }
    } catch (e) {
      return `message ${i}: ${(e as Error).message}`;
    }
    if (hex(ct) !== m.ciphertext) return `message ${i}: ciphertext differs`;
    if (!back.equals(payload)) return `message ${i}: payload did not round-trip`;
  }
  return null;
}
