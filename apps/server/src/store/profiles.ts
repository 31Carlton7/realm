import type { Db } from "../db/database";
import { newId, type Profile } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; name: string; icon: string; color: string; sort_order: number; created_at: number; updated_at: number };
const toProfile = (r: Row): Profile => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at });

export class ProfilesStore {
  constructor(private db: Db) {}
  list(): Profile[] {
    return (this.db.prepare("SELECT * FROM profiles ORDER BY sort_order, created_at").all() as Row[]).map(toProfile);
  }
  get(id: string): Profile | null {
    const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : null;
  }
  create(input: { name: string; icon: string; color: string }): Profile {
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM profiles").get() as { m: number }).m;
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.icon, input.color, max + 1, t, t);
    return this.get(id)!;
  }
  update(input: { id: string; name?: string; icon?: string; color?: string; sortOrder?: number }): Profile {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("profile", input.id);
    this.db.prepare("UPDATE profiles SET name = ?, icon = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(input.name ?? cur.name, input.icon ?? cur.icon, input.color ?? cur.color, input.sortOrder ?? cur.sortOrder, now(), input.id);
    return this.get(input.id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("profile", id);
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }
}
