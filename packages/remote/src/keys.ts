import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { b64u } from "./bytes";

/** A raw 32-byte key pair. Raw rather than KeyObjects because the same bytes cross to Swift (CryptoKit's
 *  `rawRepresentation`) and into the Noise vectors, and both speak raw keys. */
export type KeyPair = { priv: Buffer; pub: Buffer };

/** A device's two identities (PROTOCOL.md §1): `dh` for Noise, `sign` for the relay. */
export type DeviceKeys = { dh: KeyPair; sign: KeyPair };

// node:crypto imports raw X25519/Ed25519 keys only through DER, so each raw key is wrapped in the
// fixed ASN.1 header for its algorithm (RFC 8410). These prefixes are the whole of that header.
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

const exact = (b: Buffer, what: string): Buffer => {
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes, got ${b.length}`);
  return b;
};

const x25519PrivObj = (priv: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([X25519_PKCS8, exact(priv, "X25519 private key")]), format: "der", type: "pkcs8" });
const x25519PubObj = (pub: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI, exact(pub, "X25519 public key")]), format: "der", type: "spki" });
const ed25519PrivObj = (seed: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, exact(seed, "Ed25519 seed")]), format: "der", type: "pkcs8" });
const ed25519PubObj = (pub: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([ED25519_SPKI, exact(pub, "Ed25519 public key")]), format: "der", type: "spki" });

/** The last 32 bytes of an SPKI export are the raw public key, for both curves. */
const rawPublic = (k: KeyObject): Buffer => k.export({ format: "der", type: "spki" }).subarray(-32);

export const x25519Public = (priv: Buffer): Buffer => rawPublic(createPublicKey(x25519PrivObj(priv)));

export const x25519Pair = (priv: Buffer): KeyPair => ({ priv: Buffer.from(priv), pub: x25519Public(priv) });

export function x25519Generate(): KeyPair {
  const { privateKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return x25519Pair(priv);
}

/** X25519 DH. Throws on a low-order public key, whose shared secret would be all zeros. */
export const x25519 = (priv: Buffer, pub: Buffer): Buffer =>
  diffieHellman({ privateKey: x25519PrivObj(priv), publicKey: x25519PubObj(pub) });

export const ed25519Public = (seed: Buffer): Buffer => rawPublic(createPublicKey(ed25519PrivObj(seed)));

export function ed25519Generate(): KeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return { priv: seed, pub: ed25519Public(seed) };
}

export const ed25519Sign = (seed: Buffer, msg: Buffer): Buffer => sign(null, msg, ed25519PrivObj(seed));

export function ed25519Verify(pub: Buffer, msg: Buffer, sig: Buffer): boolean {
  try { return verify(null, msg, ed25519PubObj(pub), sig); } catch { return false; }
}

export const generateDeviceKeys = (): DeviceKeys => ({ dh: x25519Generate(), sign: ed25519Generate() });

/** PROTOCOL.md §1: a device's id is the first 16 bytes of the SHA-256 of its signing key. The relay
 *  recomputes it from the key a client signs with, so an id needs no registration to be trusted. */
export const deviceId = (signPub: Buffer): string => b64u(createHash("sha256").update(exact(signPub, "Ed25519 public key")).digest().subarray(0, 16));
