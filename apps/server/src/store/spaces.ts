import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/database";
import { activeLayout, groupsFromLayout, newId, pickSpaceColor, LayoutSchema, setActiveLayout,
  SpaceGroupsSchema, type Layout, type Space, type SpaceGroups } from "@realm/contracts";
import { NotFoundError, now, slugify } from "./rows";

type Row = { id: string; profile_id: string; name: string; icon: string; color: string; sort_order: number; folder_path: string;
  layout_json: string | null; groups_json: string | null; active_item_id: string | null; created_at: number; updated_at: number };
/** Corrupt or outdated layout JSON degrades to null rather than breaking the whole space. */
function parseLayout(json: string | null): Layout | null {
  if (!json) return null;
  try { const p = LayoutSchema.safeParse(JSON.parse(json)); return p.success ? p.data : null; } catch { return null; }
}
/**
 * The group set for a row, migrating on read rather than in SQL (see migration v17): `groups_json` when
 * it parses, otherwise a single "Main" group wrapping whatever `layout_json` holds — which is the shape
 * every space had before groups existed, and the shape a space still has until something writes groups.
 * Corrupt group JSON degrades the same way a corrupt layout does: to the layout-derived default rather
 * than to a broken space.
 */
function parseGroups(groupsJson: string | null): SpaceGroups | null {
  if (!groupsJson) return null;
  try {
    const raw: unknown = JSON.parse(groupsJson);
    // `SpaceGroupsSchema` repairs rather than rejects, which is right for a group list that has real
    // groups in it but wrong here: a blob with no group list at all would "repair" to one EMPTY group
    // and silently outrank the arrangement `layout_json` still holds. Corruption at this level is
    // indistinguishable from unparseable JSON, so it degrades the same way — to the layout.
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { groups?: unknown }).groups)
      || (raw as { groups: unknown[] }).groups.length === 0) return null;
    const p = SpaceGroupsSchema.safeParse(raw);
    return p.success ? p.data : null;
  } catch { return null; }
}

const toSpace = (r: Row): Space => {
  const stored = parseLayout(r.layout_json);
  const parsed = parseGroups(r.groups_json);
  // No `groups_json` yet (see migration v17): derive the pre-groups shape — a single "Main" group
  // holding whatever `layout_json` had. Keyed on the SPACE id so a read is deterministic; a fresh
  // ULID per read would give two `spaces.list()` calls two different ids for the same group.
  const groups = parsed ?? groupsFromLayout(stored, r.id);
  return {
    id: r.id, profileId: r.profile_id, name: r.name, icon: r.icon, color: r.color, sortOrder: r.sort_order, folderPath: r.folder_path,
    groups,
    // Derived from the groups once they exist — the active group IS what is on screen, and two
    // independently-read sources for that would drift the moment a group switch was persisted. Before
    // then it keeps its old meaning exactly, including `null` for a space that has never had a layout
    // written: an empty derived tree is not the same claim as "nothing has ever been arranged here".
    layout: parsed ? activeLayout(parsed) : stored,
    activeItemId: r.active_item_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
};

export class SpacesStore {
  constructor(private db: Db, private home: string) {}
  list(profileId: string): Space[] {
    return (this.db.prepare("SELECT * FROM spaces WHERE profile_id = ? ORDER BY sort_order, created_at").all(profileId) as Row[]).map(toSpace);
  }
  listAll(): Space[] {
    return (this.db.prepare("SELECT * FROM spaces ORDER BY sort_order, created_at").all() as Row[]).map(toSpace);
  }
  get(id: string): Space | null {
    const r = this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as Row | undefined;
    return r ? toSpace(r) : null;
  }
  create(input: { profileId: string; name: string; icon: string; color?: string }): Space {
    const prof = this.db.prepare("SELECT name FROM profiles WHERE id = ?").get(input.profileId) as { name: string } | undefined;
    if (!prof) throw new NotFoundError("profile", input.profileId);
    const folder = this.allocateFolder(slugify(prof.name), slugify(input.name));
    mkdirSync(folder, { recursive: true });
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM spaces").get() as { m: number }).m;
    const countAll = (this.db.prepare("SELECT COUNT(*) AS c FROM spaces").get() as { c: number }).c;
    const color = input.color ?? pickSpaceColor(countAll);
    const id = newId(); const t = now();
    this.db.prepare(`INSERT INTO spaces (id, profile_id, name, icon, color, sort_order, folder_path, layout_json, active_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`).run(id, input.profileId, input.name, input.icon, color, max + 1, folder, t, t);
    return this.get(id)!;
  }
  update(input: { id: string; name?: string; icon?: string; color?: string; profileId?: string; sortOrder?: number; activeItemId?: string | null }): Space {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("space", input.id);
    if (input.profileId !== undefined && input.profileId !== cur.profileId
      && !this.db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(input.profileId)) throw new NotFoundError("profile", input.profileId);
    this.db.prepare("UPDATE spaces SET name = ?, icon = ?, color = ?, profile_id = ?, sort_order = ?, active_item_id = ?, updated_at = ? WHERE id = ?")
      .run(input.name ?? cur.name, input.icon ?? cur.icon, input.color ?? cur.color, input.profileId ?? cur.profileId, input.sortOrder ?? cur.sortOrder,
        input.activeItemId === undefined ? cur.activeItemId : input.activeItemId, now(), input.id);
    return this.get(input.id)!;
  }
  /** Global ordering: sort_order = index in `ids`. Ids not listed keep their old sort_order. */
  reorder(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE spaces SET sort_order = ?, updated_at = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try { ids.forEach((id, i) => stmt.run(i, now(), id)); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  /** Layout-only write: replaces the ACTIVE group's layout, leaving group membership, names and the
   *  active pointer alone. The pre-groups method, kept because a resize or a split is exactly that. */
  setLayout(id: string, layout: Layout): Space {
    const cur = this.get(id); if (!cur) throw new NotFoundError("space", id);
    return this.setGroups(id, setActiveLayout(cur.groups ?? groupsFromLayout(null, id), layout));
  }
  /** The whole group set in one write. `layout_json` is kept in step with the active group's layout so
   *  it never becomes a stale second answer to "what is on screen" (see migration v17). */
  setGroups(id: string, groups: SpaceGroups): Space {
    if (!this.get(id)) throw new NotFoundError("space", id);
    this.db.prepare("UPDATE spaces SET groups_json = ?, layout_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(groups), JSON.stringify(activeLayout(groups)), now(), id);
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
