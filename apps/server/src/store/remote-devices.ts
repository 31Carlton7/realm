import { b64u, fromB64u } from "@realm/remote";
import type { Db } from "../db/database";
import type { PairedPhone, PhoneStore } from "../remote/store";

type Row = { phone_id: string; name: string; model: string; dh_pub: string; sign_pub: string; added_at: number; last_seen: number | null; relay: string | null };

const toPhone = (r: Row): PairedPhone => ({
  phoneId: r.phone_id, name: r.name, model: r.model, dh: fromB64u(r.dh_pub), sign: fromB64u(r.sign_pub), addedAt: r.added_at, lastSeen: r.last_seen,
  relay: r.relay,
});

/**
 * The phones paired with this Mac (migration v42), oldest first — the order Settings ▸ Devices lists
 * them in and the relay is sent them in. Public keys only.
 */
export class RemoteDevicesStore implements PhoneStore {
  constructor(private db: Db) {}

  list(): PairedPhone[] {
    return (this.db.prepare("SELECT * FROM remote_devices ORDER BY added_at, phone_id").all() as Row[]).map(toPhone);
  }

  get(phoneId: string): PairedPhone | undefined {
    const r = this.db.prepare("SELECT * FROM remote_devices WHERE phone_id = ?").get(phoneId) as Row | undefined;
    return r ? toPhone(r) : undefined;
  }

  /** Pairing the same phone again (the same signing key, so the same id) replaces its row, keys and all. */
  add(p: PairedPhone): void {
    this.db.prepare(`INSERT INTO remote_devices (phone_id, name, model, dh_pub, sign_pub, added_at, last_seen, relay) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (phone_id) DO UPDATE SET name = excluded.name, model = excluded.model, dh_pub = excluded.dh_pub,
        sign_pub = excluded.sign_pub, added_at = excluded.added_at, last_seen = excluded.last_seen, relay = excluded.relay`)
      .run(p.phoneId, p.name, p.model, b64u(p.dh), b64u(p.sign), p.addedAt, p.lastSeen, p.relay);
  }

  setRelay(phoneId: string, relay: string): void {
    this.db.prepare("UPDATE remote_devices SET relay = ? WHERE phone_id = ?").run(relay, phoneId);
  }

  /** Writes `relay` in for every phone paired before the Mac recorded one, and says how many there were. */
  adoptRelay(relay: string): number {
    return Number(this.db.prepare("UPDATE remote_devices SET relay = ? WHERE relay IS NULL").run(relay).changes);
  }

  remove(phoneId: string): boolean {
    return Number(this.db.prepare("DELETE FROM remote_devices WHERE phone_id = ?").run(phoneId).changes) > 0;
  }

  /** Every phone at once: they were paired to an identity this Mac no longer has (`RemoteService`). */
  clear(): void {
    this.db.prepare("DELETE FROM remote_devices").run();
  }

  /** Never moves backwards, so a late write from a closing channel cannot undo a fresher one. */
  touch(phoneId: string, at: number): void {
    this.db.prepare("UPDATE remote_devices SET last_seen = ? WHERE phone_id = ? AND (last_seen IS NULL OR last_seen < ?)").run(at, phoneId, at);
  }
}
