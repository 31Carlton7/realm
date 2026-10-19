// By module path, as `machines/secret.ts` does: crypto primitives stay out of the barrel every other
// file imports.
import { isSealed, open as openSealed, seal, SECRET_KEY_BYTES } from "@realm/contracts/src/secret-box";

/**
 * The `remote` domain key (Plan 28), and the seal/open pair this Mac's Realm Mobile identity goes
 * through: the X25519 and Ed25519 private keys every paired phone has pinned.
 *
 * Module-scoped like `machineSecretBox`, for the same reason: it holds one process-wide fact — did
 * Electron main hand us a key — and the daemon keeps it for its whole life, so a window closing costs
 * nothing.
 *
 * **With no key it refuses, as machine's does.** A private key in `realm.db` in the clear is not a
 * degradation to choose on the owner's behalf, so `seal` answers null and the remote service reports
 * itself locked until a Realm that can unlock the keyring attaches. `secret-box` mixes the domain in as
 * AAD, so this box cannot open a machine password or an oauth blob even if one were handed to it.
 */
export const remoteSecretBox = {
  key: null as Buffer | null,

  /** Set when Electron main registers on the browser-host bridge, beside the other keys. A null or
   *  malformed key leaves the box refusing rather than half-configured. */
  setKey(base64: string | null): void {
    if (!base64) { this.key = null; return; }
    let buf: Buffer;
    try { buf = Buffer.from(base64, "base64"); } catch { this.key = null; return; }
    this.key = buf.length === SECRET_KEY_BYTES ? buf : null;
  },

  get available(): boolean { return this.key !== null; },

  /** Ciphertext, or NULL when there is no key — never the plaintext. */
  seal(plaintext: string): string | null {
    return this.key ? seal(this.key, "remote", plaintext) : null;
  },

  /** The stored blob opened, or null when it cannot be. A value that is not sealed is refused rather
   *  than read: this domain has never written one, so whatever put it there is not Realm. */
  open(stored: string): string | null {
    if (!isSealed(stored)) return null;
    return this.key ? openSealed(this.key, "remote", stored) : null;
  },
};
