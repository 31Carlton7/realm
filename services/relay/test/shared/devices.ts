/**
 * Devices for the tests: real Ed25519 keys, with ids and challenge answers built straight from
 * PROTOCOL.md rather than borrowed from the relay, so the relay cannot pass by agreeing with itself.
 */

export type Device = {
  id: string;
  /** `b64u` of the raw public signing key. */
  key: string;
  /** `b64u` of an Ed25519 signature. */
  sign(message: Uint8Array): Promise<string>;
};

const text = new TextEncoder();

export const utf8 = (s: string): Uint8Array => text.encode(s);

export function b64u(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function fromB64u(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function makeDevice(): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  // §1: id(signPub) = b64u(SHA-256(signPub)[0..16])
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  return {
    id: b64u(hash.slice(0, 16)),
    key: b64u(publicKey),
    sign: async (message) => b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new Uint8Array(message)))),
  };
}

/** §3.1: what a client signs to answer the challenge. */
export const challengeAnswer = (role: "mac" | "phone", macId: string, phoneId: string, nonce: string): Uint8Array =>
  utf8(`realm-relay/1\n${role}\n${macId}\n${phoneId}\n${nonce}`);

export const randomId = (): string => b64u(crypto.getRandomValues(new Uint8Array(16)));

/** A random APNs device token, hex, optionally starting with `prefix` (which the fake APNs reads). */
export function randomToken(prefix = ""): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + hex.slice(prefix.length);
}
