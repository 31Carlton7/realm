import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, deviceId, fromB64u, generateDeviceKeys, type DeviceKeys } from "@realm/remote";

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

/** Where the gateway keeps the phones it has paired: the `remote_devices` table inside realm-server
 *  (`store/remote-devices.ts`), a scratch file in the live scripts (`FileRemoteStore`). */
export interface PhoneStore {
  list(): PairedPhone[];
  get(phoneId: string): PairedPhone | undefined;
  /** Pairing again replaces the old keys for that phone. */
  add(p: PairedPhone): void;
  remove(phoneId: string): boolean;
  touch(phoneId: string, at: number): void;
}

/** This Mac's identity at the relay and in every handshake. */
export type MacIdentity = { keys: DeviceKeys; macId: string };

const writeSecret = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * Phase 1's store, kept for the live scripts only: a gateway they run beside a built server, on a
 * scratch home, with its identity and phones in 0600 files under `<home>/remote/`. realm-server itself
 * keeps phones in `remote_devices` and its identity sealed under the `remote` secret domain
 * (`remote/keys.ts`); nothing it builds reads these files.
 */
export class FileRemoteStore implements PhoneStore {
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
  identity(): MacIdentity {
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
