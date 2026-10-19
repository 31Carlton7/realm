import type { RelayCrypto } from "./core";

/** The relay's three primitives from WebCrypto, which workerd and Node 22 both provide as the
 *  global `crypto`, so the Worker and the local relay verify with the same code. */
export const webCrypto: RelayCrypto = {
  async verifyEd25519(publicKey, signature, message) {
    try {
      const key = await crypto.subtle.importKey("raw", copy(publicKey), { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, key, copy(signature), copy(message));
    } catch {
      // A key that is not a curve point fails to import. That is a failed proof, not a relay fault.
      return false;
    }
  },
  async sha256(data) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", copy(data)));
  },
  randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  },
};

/** WebCrypto's types want bytes backed by a plain ArrayBuffer; views into anything else are copied. */
const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);
