import { b64u, deviceId, ed25519Public, fromB64u, generateDeviceKeys, x25519Pair, type DeviceKeys } from "@realm/remote";
import type { SettingsStore } from "../store/settings";
import { remoteSecretBox, type RemoteKeySource } from "./secret";
import type { MacIdentity } from "./store";

/** The settings row holding this Mac's identity, sealed under the `remote` secret domain. */
export const REMOTE_IDENTITY_KEY = "remote.identity";
/** Which key sealed it (`RemoteKeySource`). Absent is `app`: every identity before headless servers
 *  could pair was sealed with the app's key. */
export const REMOTE_IDENTITY_SOURCE_KEY = "remote.identity.source";

/** What is sealed: the two private keys, and nothing derivable from them. The public halves are
 *  recomputed on open, so a stored pair can never disagree with itself. */
type Sealed = { v: 1; dh: string; sign: string };

/**
 * This Mac's two key pairs for Realm Mobile (PROTOCOL.md §1): X25519 for Noise, Ed25519 for the relay.
 * Every phone it pairs pins them, so they are made once and kept — sealed in a settings row, opened
 * with the key they were sealed with, and never written anywhere in the clear.
 */
export class MacKeys {
  constructor(private readonly settings: SettingsStore, private readonly box = remoteSecretBox) {}

  /** The key the stored identity was sealed with. */
  source(): RemoteKeySource {
    return this.settings.get(REMOTE_IDENTITY_SOURCE_KEY) === "home" ? "home" : "app";
  }

  /**
   * The stored identity, opened. `none` when nothing is stored yet; `locked` without the key it was
   * sealed with — whatever other key is here, which must never be taken for a reason to start over;
   * `unopenable` when its own key is here and does not open it: that keyring is gone, and so is the
   * identity.
   */
  load(): { kind: "ok"; identity: MacIdentity } | { kind: "none" | "unopenable" } | { kind: "locked"; source: RemoteKeySource } {
    const stored = this.settings.get(REMOTE_IDENTITY_KEY);
    if (typeof stored !== "string" || stored === "") return { kind: "none" };
    const source = this.source();
    if (!this.box.has(source)) return { kind: "locked", source };
    const text = this.box.open(stored, source);
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

  /** A new identity, sealed and stored in place of any old one, with the key it was sealed with. Null
   *  without a key: a private key is never stored unsealed. */
  mint(): MacIdentity | null {
    const source = this.box.preferred;
    if (source === null) return null;
    const keys = generateDeviceKeys();
    const sealed = this.box.seal(JSON.stringify({ v: 1, dh: b64u(keys.dh.priv), sign: b64u(keys.sign.priv) } satisfies Sealed), source);
    if (sealed === null) return null;
    this.settings.set(REMOTE_IDENTITY_KEY, sealed);
    this.settings.set(REMOTE_IDENTITY_SOURCE_KEY, source);
    return { keys, macId: deviceId(keys.sign.pub) };
  }
}
