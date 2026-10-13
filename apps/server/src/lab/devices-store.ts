import { newId, type LabAccount, type LabDeviceKind } from "@realm/contracts";
import type { Db } from "../db/database";

/** A `lab_devices` row (v48), as the service reads it. */
export type LabDeviceRow = {
  id: string; kind: LabDeviceKind; udid: string | null; name: string; spaceId: string | null;
  accounts: LabAccount[]; lastSeenAt: number | null; createdAt: number; updatedAt: number;
};

type Row = {
  id: string; kind: string; udid: string | null; name: string; space_id: string | null;
  accounts_json: string; last_seen_at: number | null; created_at: number; updated_at: number;
};

const accountsOf = (json: string): LabAccount[] => {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((a): a is LabAccount => typeof a?.service === "string" && typeof a?.handle === "string") : [];
  } catch { return []; }
};

const toRow = (r: Row): LabDeviceRow => ({
  id: r.id, kind: r.kind as LabDeviceKind, udid: r.udid, name: r.name, spaceId: r.space_id,
  accounts: accountsOf(r.accounts_json), lastSeenAt: r.last_seen_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class LabDevicesStore {
  constructor(private readonly db: Db) {}

  list(): LabDeviceRow[] {
    return (this.db.prepare("SELECT * FROM lab_devices ORDER BY created_at ASC, id ASC").all() as Row[]).map(toRow);
  }

  get(id: string): LabDeviceRow | null {
    const r = this.db.prepare("SELECT * FROM lab_devices WHERE id = ?").get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  byUdid(udid: string): LabDeviceRow | null {
    const r = this.db.prepare("SELECT * FROM lab_devices WHERE udid = ?").get(udid) as Row | undefined;
    return r ? toRow(r) : null;
  }

  add(input: { kind: LabDeviceKind; udid: string | null; name: string; spaceId: string | null; accounts: LabAccount[]; lastSeenAt: number | null }, now: number): LabDeviceRow {
    const id = newId();
    this.db.prepare(`INSERT INTO lab_devices (id, kind, udid, name, space_id, accounts_json, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.kind, input.udid, input.name, input.spaceId, JSON.stringify(input.accounts), input.lastSeenAt, now, now);
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string; spaceId?: string | null; accounts?: LabAccount[] }, now: number): LabDeviceRow | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.db.prepare("UPDATE lab_devices SET name = ?, space_id = ?, accounts_json = ?, updated_at = ? WHERE id = ?").run(
      patch.name ?? cur.name, patch.spaceId === undefined ? cur.spaceId : patch.spaceId,
      JSON.stringify(patch.accounts ?? cur.accounts), now, id);
    return this.get(id);
  }

  /** Stamp the devices a scan found. Only `last_seen_at`: being seen is not an edit. */
  seen(ids: string[], at: number): void {
    const stmt = this.db.prepare("UPDATE lab_devices SET last_seen_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(at, id);
  }

  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM lab_devices WHERE id = ?").run(id).changes) > 0;
  }
}
