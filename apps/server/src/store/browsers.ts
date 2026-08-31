import type { Db } from "../db/database";
import type { Browser } from "@realm/contracts";
import { now } from "./rows";

type Row = { id: string; space_id: string; url: string; title: string; created_at: number; updated_at: number };
const toBrowser = (r: Row): Browser => ({ id: r.id, spaceId: r.space_id, url: r.url, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });

export class BrowsersStore {
  constructor(private db: Db) {}
  insert(input: { id: string; spaceId: string; url: string; title: string }): Browser {
    const t = now();
    this.db.prepare("INSERT INTO browsers (id, space_id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.spaceId, input.url, input.title, t, t);
    return { ...input, createdAt: t, updatedAt: t };
  }
  get(id: string): Browser | null {
    const r = this.db.prepare("SELECT * FROM browsers WHERE id = ?").get(id) as Row | undefined; return r ? toBrowser(r) : null;
  }
  update(id: string, patch: { url?: string; title?: string }): Browser | null {
    const cur = this.get(id); if (!cur) return null;
    this.db.prepare("UPDATE browsers SET url = ?, title = ?, updated_at = ? WHERE id = ?")
      .run(patch.url ?? cur.url, patch.title ?? cur.title, now(), id);
    return this.get(id);
  }
  /** Idempotent, like TerminalsStore.delete. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM browsers WHERE id = ?").run(id);
  }
}
