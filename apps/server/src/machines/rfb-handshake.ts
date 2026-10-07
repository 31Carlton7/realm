import { createCipheriv, createHash } from "node:crypto";

/**
 * The RFB handshake, up to the point pixels start flowing — pure over bytes, so every branch a real
 * server can take is testable without one (Plan 25 W3).
 *
 * Realm performs this SERVER-SIDE, which is the whole reason it is written out rather than left to
 * noVNC. The renderer gets an already-authenticated socket and never holds the password: a VNC
 * password is frequently the user's login, and the place it least belongs is a renderer that also
 * runs page content. `MachineWsProxy` drives this state machine and then becomes a dumb pipe.
 *
 * Only what a real endpoint actually needs is implemented, and everything else is REFUSED BY NAME
 * rather than half-attempted:
 *
 *   - **None (1)** — an unauthenticated server, which is what a Realm-booted guest on loopback is.
 *   - **VNC Authentication (2)** — DES with a bit-reversed key, RFC 6143 §7.2.2. This is what macOS
 *     Screen Sharing offers when "VNC viewers may control screen with password" is on, and what
 *     every x11vnc/TigerVNC install offers by default.
 *
 * Not implemented, and each says so: Apple's own 30/33/35 (Screen Sharing's Diffie-Hellman variants,
 * used when a macOS account password is required rather than a VNC one), RA2 (18/19), TLS/VeNCrypt
 * (18–22, 258+). A server offering only those returns `auth_unsupported`, which the pane turns into
 * a sentence naming what to switch on — rather than a hang, which is what an unhandled type gives.
 */

export type HandshakeState =
  /** Waiting for the server's `RFB xxx.yyy\n` line. */
  | { phase: "version" }
  /** Waiting for the security-type list (3.7+) or the single u32 type (3.3). */
  | { phase: "security"; minor: number }
  /** Waiting for the 16-byte challenge. */
  | { phase: "challenge" }
  /** Waiting for the u32 auth result (and, on failure in 3.8+, the reason string). */
  | { phase: "result"; minor: number }
  /** Waiting for the ServerInit that carries the framebuffer's size. */
  | { phase: "init" }
  | { phase: "done" };

export type HandshakeStep =
  /** Nothing yet — the buffer holds a partial message. Keep reading. */
  | { kind: "wait" }
  /** Send these bytes to the server, then continue from `state`. */
  | { kind: "send"; bytes: Buffer; state: HandshakeState; consumed: number }
  /** The handshake succeeded. `consumed` bytes belong to it; everything after is the client's. */
  | { kind: "done"; consumed: number; width: number; height: number; name: string }
  | { kind: "fail"; error: "not_rfb" | "auth_failed" | "auth_unsupported"; detail: string };

/** Realm's own protocol version. 3.8 is what every server made this century speaks, and it is the
 *  one that reports an auth failure with a REASON rather than just a code. */
export const RFB_VERSION = "RFB 003.008\n";

const SEC_NONE = 1;
const SEC_VNC_AUTH = 2;
/** Named so a refusal can say which one it saw rather than printing a number at the user. */
const SEC_NAMES: Record<number, string> = {
  5: "RA2", 6: "RA2ne", 16: "Tight", 17: "Ultra", 18: "TLS", 19: "VeNCrypt",
  20: "SASL", 21: "MD5 hash authentication", 22: "Colin Dean xvp",
  30: "Apple Diffie-Hellman", 33: "Apple", 35: "Apple", 36: "Apple",
};
const nameOf = (t: number): string => SEC_NAMES[t] ?? `type ${t}`;

/**
 * VNC Authentication's key schedule, RFC 6143 §7.2.2.
 *
 * The password is truncated to 8 bytes, zero-padded, and EVERY BYTE'S BITS ARE REVERSED before it is
 * used as a DES key. That last step is the one everybody leaves out; it is not a quirk of any
 * implementation but the specification, and without it every password is silently wrong while the
 * code looks correct.
 */
export function vncAuthKey(password: string): Buffer {
  const key = Buffer.alloc(8);
  const raw = Buffer.from(password, "latin1");
  raw.copy(key, 0, 0, Math.min(8, raw.length));
  for (let i = 0; i < 8; i++) {
    let b = key[i]!, r = 0;
    for (let bit = 0; bit < 8; bit++) r = (r << 1) | ((b >> bit) & 1);
    key[i] = r;
  }
  return key;
}

/**
 * Encrypt the 16-byte challenge with single DES under the bit-reversed key.
 *
 * Spelled `des-ede3` with the key repeated three times, and the reason is worth the two lines it
 * costs: **`des-ecb` does not exist in this suite's Node.** OpenSSL 3 moved single DES to the legacy
 * provider, which Node 22 does not load, so `createCipheriv("des-ecb", …)` throws
 * `ERR_OSSL_EVP_UNSUPPORTED` — while Electron, whose BoringSSL still has it, works fine. That split
 * is the worst possible shape for a bug: green in the app, red only in the test run, or the reverse
 * once the server's runtime changes.
 *
 * Three-key EDE with K1 = K2 = K3 is single DES by construction — E(D(E(m))) collapses to E(m) — and
 * `des-ede3` is in the default provider everywhere. Verified byte-identical to BoringSSL's own
 * `des-ecb` on the same inputs; `rfb-handshake.test.ts` pins that output as a known-answer vector, so
 * a "simplification" back to `des-ecb` fails rather than silently changing what a password hashes to.
 *
 * Padding is off: the challenge is already two whole blocks, and an appended third would leave the
 * server waiting for 16 bytes while 24 arrive.
 */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = vncAuthKey(password);
  const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/**
 * One step of the handshake against whatever has arrived so far.
 *
 * Written as a pure function of `(state, buffer)` rather than as callbacks on a socket for one
 * reason: TCP delivers the handshake in whatever chunking it feels like, and the bugs in every
 * hand-rolled client are in the partial reads. Here a short buffer is `wait`, always, and the tests
 * feed the same conversation one byte at a time to prove it.
 */
export function handshakeStep(state: HandshakeState, buf: Buffer, password: string | null): HandshakeStep {
  switch (state.phase) {
    case "version": {
      if (buf.length < 12) return { kind: "wait" };
      const line = buf.subarray(0, 12).toString("latin1");
      const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(line);
      // The single most common misconfiguration this catches: a port that is serving something else
      // entirely. Twelve bytes of HTTP look nothing like a version line, and saying so beats timing
      // out on a socket that is perfectly happy.
      if (!m) return { kind: "fail", error: "not_rfb", detail: `the server's first bytes were not an RFB version line (${JSON.stringify(line.slice(0, 12))})` };
      const minor = Number(m[2]);
      return { kind: "send", bytes: Buffer.from(RFB_VERSION, "latin1"), state: { phase: "security", minor }, consumed: 12 };
    }
    case "security": {
      // 3.3 is the one version that does not negotiate: the server states a single type as a u32 and
      // the client has no say. Old, but still what some embedded servers speak.
      if (state.minor < 7) {
        if (buf.length < 4) return { kind: "wait" };
        const type = buf.readUInt32BE(0);
        // No reply at all: 3.3 states the type, it does not offer it. Sending one would put a byte
        // into the stream the server is not reading, and it would arrive as the first byte of the
        // challenge or of ClientInit — which is a corruption with no error message at either end.
        if (type === SEC_NONE) return { kind: "send", bytes: Buffer.alloc(0), state: { phase: "result", minor: state.minor }, consumed: 4 };
        if (type === SEC_VNC_AUTH) {
          if (!password) return { kind: "fail", error: "auth_failed", detail: "the server wants a password and none is saved for this machine" };
          return { kind: "send", bytes: Buffer.alloc(0), state: { phase: "challenge" }, consumed: 4 };
        }
        // 0 is 3.3's own refusal, with no reason string behind it.
        if (type === 0) return { kind: "fail", error: "auth_failed", detail: "the server refused the connection" };
        return { kind: "fail", error: "auth_unsupported", detail: `the server requires ${nameOf(type)}. Realm speaks None and VNC password authentication.` };
      }
      if (buf.length < 1) return { kind: "wait" };
      const count = buf.readUInt8(0);
      // A zero-length list is the protocol's own way of saying "I am refusing you", followed by a
      // reason string. Treated as an auth failure rather than a parse error, because that is what it
      // is — a blocked host, usually, or too many failed attempts.
      if (count === 0) {
        if (buf.length < 5) return { kind: "wait" };
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return { kind: "wait" };
        return { kind: "fail", error: "auth_failed", detail: buf.subarray(5, 5 + len).toString("utf8") || "the server refused the connection" };
      }
      if (buf.length < 1 + count) return { kind: "wait" };
      const offered = [...buf.subarray(1, 1 + count)];
      // None before VNC auth: a server that will take us without a password should not be handed
      // one. This is also what makes a Realm-booted loopback guest connect with no secret at all.
      const chosen = offered.includes(SEC_NONE) ? SEC_NONE : offered.includes(SEC_VNC_AUTH) ? SEC_VNC_AUTH : null;
      if (chosen === null) {
        return {
          kind: "fail", error: "auth_unsupported",
          detail: `the server offers only ${offered.map(nameOf).join(", ")}. Realm speaks None and VNC password authentication.`,
        };
      }
      if (chosen === SEC_VNC_AUTH && !password) {
        return { kind: "fail", error: "auth_failed", detail: "the server wants a password and none is saved for this machine" };
      }
      return { kind: "send", bytes: Buffer.from([chosen]), state: chosen === SEC_NONE ? { phase: "result", minor: state.minor } : { phase: "challenge" }, consumed: 1 + count };
    }
    case "challenge": {
      if (buf.length < 16) return { kind: "wait" };
      if (!password) return { kind: "fail", error: "auth_failed", detail: "the server wants a password and none is saved for this machine" };
      return { kind: "send", bytes: vncAuthResponse(buf.subarray(0, 16), password), state: { phase: "result", minor: 8 }, consumed: 16 };
    }
    case "result": {
      // 3.3 and 3.7 send no SecurityResult after a `None` handshake; 3.8 does. Reading four bytes
      // that will never arrive is a hang, so the older versions skip straight to ClientInit.
      if (state.minor < 8) return { kind: "send", bytes: Buffer.from([1]), state: { phase: "init" }, consumed: 0 };
      if (buf.length < 4) return { kind: "wait" };
      const result = buf.readUInt32BE(0);
      if (result !== 0) {
        // 3.8 follows a failure with a length-prefixed reason. Waited for, because a server's own
        // words ("too many authentication failures") are better than anything invented here.
        if (buf.length >= 8) {
          const len = buf.readUInt32BE(4);
          if (buf.length >= 8 + len) {
            return { kind: "fail", error: "auth_failed", detail: buf.subarray(8, 8 + len).toString("utf8") || "the password was refused" };
          }
          return { kind: "wait" };
        }
        return { kind: "wait" };
      }
      // ClientInit: one byte, and it is `1` — shared. A `0` asks the server to disconnect every
      // other viewer, which is precisely what Realm must never do to somebody's other session.
      return { kind: "send", bytes: Buffer.from([1]), state: { phase: "init" }, consumed: 4 };
    }
    case "init": {
      if (buf.length < 24) return { kind: "wait" };
      const nameLen = buf.readUInt32BE(20);
      if (buf.length < 24 + nameLen) return { kind: "wait" };
      return {
        kind: "done", consumed: 24 + nameLen,
        width: buf.readUInt16BE(0), height: buf.readUInt16BE(2),
        name: buf.subarray(24, 24 + nameLen).toString("utf8"),
      };
    }
    case "done":
      return { kind: "done", consumed: 0, width: 0, height: 0, name: "" };
  }
}

/**
 * The bytes a client would have to be handed to believe the handshake it never took part in.
 *
 * The renderer's RFB client starts from the beginning of the protocol, and by the time it connects
 * the real handshake is long finished — so the proxy REPLAYS a synthetic one: our version line, a
 * one-item security list offering None, a success result, and the server's own ServerInit verbatim.
 * From that point the two speak directly and the proxy is a pipe.
 *
 * Everything except the framebuffer's own description is manufactured, and that is the honest shape:
 * the client is being told the truth about the screen and a fiction about the security negotiation,
 * because the security negotiation was somebody else's — the server's.
 */
export function replayForClient(serverInit: Buffer): { version: Buffer; security: Buffer; result: Buffer; serverInit: Buffer } {
  return {
    version: Buffer.from(RFB_VERSION, "latin1"),
    security: Buffer.from([1, SEC_NONE]),
    result: Buffer.from([0, 0, 0, 0]),
    serverInit,
  };
}

/** A stable fingerprint of an endpoint, for log lines that must not carry a password or a host the
 *  user did not choose to see written down. */
export const endpointTag = (host: string, port: number): string =>
  createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 8);
