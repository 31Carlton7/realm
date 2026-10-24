// By module path, as `machines/secret.ts` does: crypto primitives stay out of the barrel every other
// file imports.
import { isSealed, open as openSealed, seal, SECRET_KEY_BYTES } from "@realm/contracts/src/secret-box";

/**
 * Where a `remote` key came from.
 * - `app`: Electron main's, anchored in this Mac's Keychain and handed over on the host bridge.
 * - `home`: a key file in Realm's home (`remote/home-key.ts`), for a server that has no Realm window to
 *   ask — a Linux box, a Mac running `realm serve` with the app closed.
 */
export type RemoteKeySource = "app" | "home";

/**
 * The `remote` domain keys (Plan 28), and the seal/open pair this Mac's Realm Mobile identity goes
 * through: the X25519 and Ed25519 private keys every paired phone has pinned.
 *
 * Module-scoped like `machineSecretBox`, for the same reason: it holds one process-wide fact — did
 * Electron main hand us a key — and the daemon keeps it for its whole life, so a window closing costs
 * nothing.
 *
 * **With no key it refuses, as machine's does.** A private key in `realm.db` in the clear is not a
 * degradation to choose on the owner's behalf, so `seal` answers null and the remote service reports
 * itself locked until a key arrives. `secret-box` mixes the domain in as AAD, so this box cannot open a
 * machine password or an oauth blob even if one were handed to it.
 *
 * It holds the app's key and the home's side by side, and an identity is opened with the one it was
 * sealed with (`MacKeys` records which): a headless server never takes the app's identity for one it
 * cannot open, and the app never forgets the phones a headless server paired.
 */
export const remoteSecretBox = {
  key: null as Buffer | null,
  homeKey: null as Buffer | null,

  /** Set when Electron main registers on the browser-host bridge, beside the other keys. A null or
   *  malformed key leaves the box refusing rather than half-configured. */
  setKey(base64: string | null): void {
    if (!base64) { this.key = null; return; }
    let buf: Buffer;
    try { buf = Buffer.from(base64, "base64"); } catch { this.key = null; return; }
    this.key = buf.length === SECRET_KEY_BYTES ? buf : null;
  },

  /** The home's key file, read (or made) by the remote service. */
  setHomeKey(key: Buffer | null): void {
    this.homeKey = key && key.length === SECRET_KEY_BYTES ? key : null;
  },

  get available(): boolean { return this.key !== null || this.homeKey !== null; },

  has(source: RemoteKeySource): boolean { return (source === "app" ? this.key : this.homeKey) !== null; },

  /** The key a new identity is sealed with: the app's when there is one — the Keychain is the better
   *  place for it — and otherwise the home's. */
  get preferred(): RemoteKeySource | null { return this.key ? "app" : this.homeKey ? "home" : null; },

  /** Ciphertext, or NULL when there is no such key — never the plaintext. */
  seal(plaintext: string, source?: RemoteKeySource): string | null {
    const which = source ?? this.preferred;
    const key = which === null ? null : which === "app" ? this.key : this.homeKey;
    return key ? seal(key, "remote", plaintext) : null;
  },

  /** The stored blob opened with `source`'s key, or null when it cannot be. A value that is not sealed
   *  is refused rather than read: this domain has never written one, so whatever put it there is not
   *  Realm. */
  open(stored: string, source: RemoteKeySource = "app"): string | null {
    if (!isSealed(stored)) return null;
    const key = source === "app" ? this.key : this.homeKey;
    return key ? openSealed(key, "remote", stored) : null;
  },
};
