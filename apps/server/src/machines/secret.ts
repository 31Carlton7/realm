// Reached through the module path rather than the barrel, exactly as `mcp/oauth.ts` does: these
// are crypto primitives, and importing them by name from `@realm/contracts` would put `seal` and
// `open` into the namespace every other file gets from that barrel.
import { isSealed, open as openSealed, seal, SECRET_KEY_BYTES } from "@realm/contracts/src/secret-box";

/**
 * The `machine` domain key, and the seal/open pair every VNC password goes through (Plan 25 W3).
 *
 * Module-scoped for the same reason `oauthSecretBox` is: it holds one process-wide fact — did the
 * desktop app hand us a key — and threading it through the store, the service and the proxy would be
 * ceremony without a second implementation to justify it.
 *
 * **The deliberate divergence from oauth: with no key, this refuses.** `oauthSecretBox.seal` falls
 * back to writing plaintext, which is right for a token that is Realm's own and whose worst case is
 * a re-authorisation. A VNC password is frequently the user's login to a machine they own, and
 * writing one into `realm.db` in the clear is not a degradation to choose on somebody's behalf. So
 * `seal` returns null and the caller — `MachineService.create` — refuses to store a password at all
 * and says so, which is recoverable: the machine still connects to servers that need none, and the
 * user can add the password once encryption is available.
 *
 * Because `secret-box` mixes the domain byte in as AAD, this box cannot open an oauth blob or a
 * credential blob even if one were handed to it.
 */
export const machineSecretBox = {
  key: null as Buffer | null,

  /** Called when Electron main registers on the browser-host bridge, like the oauth key beside it.
   *  A null or malformed key leaves the box refusing rather than half-configured. */
  setKey(base64: string | null): void {
    if (!base64) { this.key = null; return; }
    let buf: Buffer;
    try { buf = Buffer.from(base64, "base64"); } catch { this.key = null; return; }
    this.key = buf.length === SECRET_KEY_BYTES ? buf : null;
  },

  get available(): boolean { return this.key !== null; },

  /** Ciphertext, or NULL when there is no key — never the plaintext. */
  seal(password: string): string | null {
    return this.key ? seal(this.key, "machine", password) : null;
  },

  /**
   * The stored column back to a password, or null when it cannot be recovered.
   *
   * Unlike oauth's, this refuses to read a stored value that is NOT sealed. There is no older
   * plaintext shape to be compatible with — this domain has never written one — so a bare string in
   * that column did not come from Realm, and treating it as a password would be treating whatever
   * put it there as trusted.
   */
  open(stored: string): string | null {
    if (!isSealed(stored)) return null;
    return this.key ? openSealed(this.key, "machine", stored) : null;
  },
};
