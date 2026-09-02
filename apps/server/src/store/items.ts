import type { Db } from "../db/database";
import { newId, type Item, type ItemKind } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; space_id: string; kind: ItemKind; title: string; sort_order: number; pinned: number; archived: number; ref_id: string; created_at: number; updated_at: number };
const toItem = (r: Row): Item => ({ id: r.id, spaceId: r.space_id, kind: r.kind, title: r.title, sortOrder: r.sort_order, pinned: r.pinned === 1, archived: r.archived === 1, refId: r.ref_id, createdAt: r.created_at, updatedAt: r.updated_at });

/**
 * A session's terminal panel is an item like any other — it needs a row so the terminal trio (row +
 * item + pty) stays one shape — but it belongs to its session, not to the space. Both LISTING methods
 * exclude it, which is what keeps it out of the sidebar, the command palette, the open/space groups and
 * the layout (reconcileLayout prunes what listItems does not return, so it can never be opened as a
 * standalone pane either). `get`/`findByRefId` are deliberately unfiltered: the services that own the
 * terminal still have to find it.
 */
const NOT_SESSION_OWNED = "id NOT IN (SELECT terminal_item_id FROM sessions WHERE terminal_item_id IS NOT NULL)";

export class ItemsStore {
  constructor(private db: Db) {}
  /** Archived rows are INCLUDED and carry the flag: the sidebar draws its "Archived" section from
   *  this same list, so a filter here would leave the user no way back. */
  list(spaceId: string): Item[] {
    return (this.db.prepare(`SELECT * FROM items WHERE space_id = ? AND ${NOT_SESSION_OWNED} ORDER BY pinned DESC, sort_order, created_at`).all(spaceId) as Row[]).map(toItem);
  }
  /** Every item across every space, newest-updated first (command palette search) — archived ones
   *  excluded, because "what can I jump to" is the one question archiving is an answer to. */
  listAll(): Item[] {
    return (this.db.prepare(`SELECT * FROM items WHERE archived = 0 AND ${NOT_SESSION_OWNED} ORDER BY updated_at DESC, created_at DESC`).all() as Row[]).map(toItem);
  }
  /** Unfiltered: every item in the space, session-owned terminals included (space teardown). */
  listIncludingHidden(spaceId: string): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE space_id = ? ORDER BY pinned DESC, sort_order, created_at").all(spaceId) as Row[]).map(toItem);
  }
  findByRefId(refId: string): Item | null {
    const r = this.db.prepare("SELECT * FROM items WHERE ref_id = ?").get(refId) as Row | undefined; return r ? toItem(r) : null;
  }
  get(id: string): Item | null {
    const r = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined; return r ? toItem(r) : null;
  }
  create(input: { spaceId: string; kind: ItemKind; title: string; refId: string }): Item {
    if (!this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(input.spaceId)) throw new NotFoundError("space", input.spaceId);
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE space_id = ?").get(input.spaceId) as { m: number }).m;
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO items (id, space_id, kind, title, sort_order, pinned, ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)")
      .run(id, input.spaceId, input.kind, input.title, max + 1, input.refId, t, t);
    // The search index's item-title source (Plan 16 W1), written at the same choke point every item
    // creation passes through. Session-owned terminal items land here too and are filtered out at
    // QUERY time (the same NOT_SESSION_OWNED rule the listings use), because ownership is decided
    // after this insert.
    this.db.prepare("INSERT INTO search_index (text, kind, ref, seq) VALUES (?, 'item', ?, NULL)").run(input.title, id);
    return this.get(id)!;
  }
  update(input: { id: string; title?: string; pinned?: boolean; archived?: boolean; sortOrder?: number }): Item {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("item", input.id);
    this.db.prepare("UPDATE items SET title = ?, pinned = ?, archived = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(input.title ?? cur.title, (input.pinned ?? cur.pinned) ? 1 : 0, (input.archived ?? cur.archived) ? 1 : 0, input.sortOrder ?? cur.sortOrder, now(), input.id);
    // A rename must move the index row, or search keeps finding the old name and never the new one.
    if (input.title !== undefined && input.title !== cur.title) {
      this.db.prepare("DELETE FROM search_index WHERE kind = 'item' AND ref = ?").run(input.id);
      this.db.prepare("INSERT INTO search_index (text, kind, ref, seq) VALUES (?, 'item', ?, NULL)").run(input.title, input.id);
    }
    return this.get(input.id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("item", id);
    this.db.prepare("DELETE FROM search_index WHERE kind = 'item' AND ref = ?").run(id);
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }
  /** Re-home the item in another space, appended after its existing items (same placement rule as
   *  `create`). The search_index row needs no touch: it carries no space_id, scoping is a query-time
   *  join, so a moved item's title is still found from either space's search. */
  moveToSpace(id: string, spaceId: string): Item {
    const cur = this.get(id); if (!cur) throw new NotFoundError("item", id);
    if (!this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(spaceId)) throw new NotFoundError("space", spaceId);
    const max = (this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE space_id = ?").get(spaceId) as { m: number }).m;
    this.db.prepare("UPDATE items SET space_id = ?, sort_order = ?, updated_at = ? WHERE id = ?").run(spaceId, max + 1, now(), id);
    return this.get(id)!;
  }
}
