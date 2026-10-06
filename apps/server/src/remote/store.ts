import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, deviceId, fromB64u, generateDeviceKeys, type DeviceKeys } from "@realm/remote";

/**
 * The Mac's identity and its paired phones, on disk under `<home>/remote/`.
 *
 * Phase 1 only: the private keys sit in a 0600 file. Phase 2 seals them under the `remote` secret-box
 * domain that Electron main hands over (Plan 28, "The Mac side"), and the device list becomes a table
 * behind a migration. Neither is worth building before the spike has measured the pipe.
 */

export type PairedPhone = {
  phoneId: string;
  name: string;
  model: string;
  /** X25519 public key, learned in the pairing handshake — what IK must see again on every connect. */
  dh: Buffer;
  /** Ed25519 public key — what the relay checks the phone's signature against. */
  sign: Buffer;
  addedAt: number;
  lastSeen: number | null;
};

const writeSecret = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

export class RemoteStore {
  readonly dir: string;
  private phones: PairedPhone[] = [];

  constructor(home: string) {
    this.dir = join(home, "remote");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const devices = join(this.dir, "devices.json");
    if (existsSync(devices)) {
      const raw = JSON.parse(readFileSync(devices, "utf8")) as { phones: (Omit<PairedPhone, "dh" | "sign"> & { dh: string; sign: string })[] };
      this.phones = raw.phones.map((p) => ({ ...p, dh: fromB64u(p.dh), sign: fromB64u(p.sign) }));
    }
  }

  /** This Mac's keys, made on first use. */
  identity(): { keys: DeviceKeys; macId: string } {
    const path = join(this.dir, "identity.json");
    if (!existsSync(path)) {
      const k = generateDeviceKeys();
      writeSecret(path, JSON.stringify({ v: 1, dh: { priv: b64u(k.dh.priv), pub: b64u(k.dh.pub) }, sign: { priv: b64u(k.sign.priv), pub: b64u(k.sign.pub) } }));
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as { dh: { priv: string; pub: string }; sign: { priv: string; pub: string } };
    const keys: DeviceKeys = {
      dh: { priv: fromB64u(raw.dh.priv), pub: fromB64u(raw.dh.pub) },
      sign: { priv: fromB64u(raw.sign.priv), pub: fromB64u(raw.sign.pub) },
    };
    return { keys, macId: deviceId(keys.sign.pub) };
  }

  list(): PairedPhone[] { return this.phones.map((p) => ({ ...p })); }

  get(phoneId: string): PairedPhone | undefined { return this.phones.find((p) => p.phoneId === phoneId); }

  /** Pairing again replaces the old keys for that phone. */
  add(p: PairedPhone): void {
    this.phones = [...this.phones.filter((x) => x.phoneId !== p.phoneId), p];
    this.save();
  }

  remove(phoneId: string): boolean {
    const before = this.phones.length;
    this.phones = this.phones.filter((p) => p.phoneId !== phoneId);
    if (this.phones.length === before) return false;
    this.save();
    return true;
  }

  touch(phoneId: string, at: number): void {
    const p = this.phones.find((x) => x.phoneId === phoneId);
    if (!p) return;
    p.lastSeen = at;
    this.save();
  }

  private save(): void {
    writeSecret(join(this.dir, "devices.json"), JSON.stringify({ v: 1, phones: this.phones.map((p) => ({ ...p, dh: b64u(p.dh), sign: b64u(p.sign) })) }, null, 1));
  }
}
