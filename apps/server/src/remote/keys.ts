import { b64u, deviceId, ed25519Public, fromB64u, generateDeviceKeys, x25519Pair, type DeviceKeys } from "@realm/remote";
import type { SettingsStore } from "../store/settings";
import { remoteSecretBox } from "./secret";
import type { MacIdentity } from "./store";

/** The settings row holding this Mac's identity, sealed under the `remote` secret domain. */
export const REMOTE_IDENTITY_KEY = "remote.identity";

/** What is sealed: the two private keys, and nothing derivable from them. The public halves are
 *  recomputed on open, so a stored pair can never disagree with itself. */
type Sealed = { v: 1; dh: string; sign: string };

/**
 * This Mac's two key pairs for Realm Mobile (PROTOCOL.md §1): X25519 for Noise, Ed25519 for the relay.
 * Every phone it pairs pins them, so they are made once and kept — sealed in a settings row, opened
 * with the key Electron main hands over, and never written anywhere in the clear.
 */
export class MacKeys {
  constructor(private readonly settings: SettingsStore, private readonly box = remoteSecretBox) {}

  /**
   * The stored identity, opened. `none` when nothing is stored yet; `locked` without a key to open
   * it; `unopenable` when one is stored that this key does not open — the keyring it was sealed under
   * is gone, and so is the identity.
   */
  load(): { kind: "ok"; identity: MacIdentity } | { kind: "none" | "locked" | "unopenable" } {
    const stored = this.settings.get(REMOTE_IDENTITY_KEY);
    if (typeof stored !== "string" || stored === "") return { kind: "none" };
    if (!this.box.available) return { kind: "locked" };
    const text = this.box.open(stored);
    if (text === null) return { kind: "unopenable" };
    try {
      const s = JSON.parse(text) as Partial<Sealed>;
      if (s.v !== 1 || typeof s.dh !== "string" || typeof s.sign !== "string") return { kind: "unopenable" };
      const seed = fromB64u(s.sign);
      const keys: DeviceKeys = { dh: x25519Pair(fromB64u(s.dh)), sign: { priv: seed, pub: ed25519Public(seed) } };
      return { kind: "ok", identity: { keys, macId: deviceId(keys.sign.pub) } };
    } catch {
      return { kind: "unopenable" };
    }
  }

  /** A new identity, sealed and stored in place of any old one. Null without a key: a private key is
   *  never stored unsealed. */
  mint(): MacIdentity | null {
    const keys = generateDeviceKeys();
    const sealed = this.box.seal(JSON.stringify({ v: 1, dh: b64u(keys.dh.priv), sign: b64u(keys.sign.priv) } satisfies Sealed));
    if (sealed === null) return null;
    this.settings.set(REMOTE_IDENTITY_KEY, sealed);
    return { keys, macId: deviceId(keys.sign.pub) };
  }
}
