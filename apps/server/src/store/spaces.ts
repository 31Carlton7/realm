import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/database";
import { newId, LayoutSchema, type Layout, type Space } from "@realm/contracts";
import { NotFoundError, now, slugify } from "./rows";

type Row = { id: string; profile_id: string; name: string; icon: string; sort_order: number; folder_path: string;
  layout_json: string | null; active_item_id: string | null; created_at: number; updated_at: number };
/** Corrupt or outdated layout JSON degrades to null rather than breaking the whole space. */
function parseLayout(json: string | null): Layout | null {
  if (!json) return null;
  try { const p = LayoutSchema.safeParse(JSON.parse(json)); return p.success ? p.data : null; } catch { return null; }
}
const toSpace = (r: Row): Space => ({
  id: r.id, profileId: r.profile_id, name: r.name, icon: r.icon, sortOrder: r.sort_order, folderPath: r.folder_path,
  layout: parseLayout(r.layout_json),
  activeItemId: r.active_item_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class SpacesStore {
  constructor(private db: Db, private home: string) {}
  list(profileId: string): Space[] {
    return (this.db.prepare("SELECT * FROM spaces WHERE profile_id = ? ORDER BY sort_order, created_at").all(profileId) as Row[]).map(toSpace);
  }
  get(id: string): Space | null {
    const r = this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as Row | undefined;
    return r ? toSpace(r) : null;
  }
  create(input: { profileId: string; name: string; icon: string }): Space {
    const prof = this.db.prepare("SELECT name FROM profiles WHERE id = ?").get(input.profileId) as { name: string } | undefined;
    if (!prof) throw new NotFoundError("profile", input.profileId);
    const folder = this.allocateFolder(slugify(prof.name), slugify(input.name));
    mkdirSync(folder, { recursive: true });
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM spaces WHERE profile_id = ?").get(input.profileId) as { m: number }).m;
    const id = newId(); const t = now();
    this.db.prepare(`INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, layout_json, active_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`).run(id, input.profileId, input.name, input.icon, max + 1, folder, t, t);
    return this.get(id)!;
  }
  update(input: { id: string; name?: string; icon?: string; sortOrder?: number; activeItemId?: string | null }): Space {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("space", input.id);
    this.db.prepare("UPDATE spaces SET name = ?, icon = ?, sort_order = ?, active_item_id = ?, updated_at = ? WHERE id = ?")
      .run(input.name ?? cur.name, input.icon ?? cur.icon, input.sortOrder ?? cur.sortOrder,
        input.activeItemId === undefined ? cur.activeItemId : input.activeItemId, now(), input.id);
    return this.get(input.id)!;
  }
  setLayout(id: string, layout: Layout): Space {
    if (!this.get(id)) throw new NotFoundError("space", id);
    this.db.prepare("UPDATE spaces SET layout_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(layout), now(), id);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("space", id);
    this.db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
    // Folder is intentionally left on disk (user data).
  }
  private allocateFolder(profileSlug: string, spaceSlug: string): string {
    const base = join(this.home, profileSlug, spaceSlug);
    if (!existsSync(base) && !this.folderInUse(base)) return base;
    for (let n = 2; ; n++) { const p = `${base}-${n}`; if (!existsSync(p) && !this.folderInUse(p)) return p; }
  }
  private folderInUse(p: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM spaces WHERE folder_path = ?").get(p);
  }
}
