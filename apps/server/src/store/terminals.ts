import type { Db } from "../db/database";
import { now } from "./rows";

export type TerminalRow = { id: string; spaceId: string; cwd: string; shell: string; createdAt: number; updatedAt: number };
type Row = { id: string; space_id: string; cwd: string; shell: string; created_at: number; updated_at: number };
const toRow = (r: Row): TerminalRow => ({ id: r.id, spaceId: r.space_id, cwd: r.cwd, shell: r.shell, createdAt: r.created_at, updatedAt: r.updated_at });

export class TerminalsStore {
  constructor(private db: Db) {}
  insert(input: { id: string; spaceId: string; cwd: string; shell: string }): TerminalRow {
    const t = now();
    this.db.prepare("INSERT INTO terminals (id, space_id, cwd, shell, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.spaceId, input.cwd, input.shell, t, t);
    return { ...input, createdAt: t, updatedAt: t };
  }
  get(id: string): TerminalRow | null {
    const r = this.db.prepare("SELECT * FROM terminals WHERE id = ?").get(id) as Row | undefined; return r ? toRow(r) : null;
  }
  listAll(): TerminalRow[] {
    return (this.db.prepare("SELECT * FROM terminals ORDER BY created_at").all() as Row[]).map(toRow);
  }
  listBySpace(spaceId: string): TerminalRow[] {
    return (this.db.prepare("SELECT * FROM terminals WHERE space_id = ? ORDER BY created_at").all(spaceId) as Row[]).map(toRow);
  }
  /** Re-home the row in another space, for a session terminal riding along with `sessions.moveToSpace`.
   *  The pty is untouched — only the row's space changes, and the cwd it was spawned at is the same
   *  checkout the session carried across. Ownership matters beyond bookkeeping: `closeAllInSpace`
   *  reaches terminals through `listBySpace`, so a row left behind would be killed with the old space. */
  moveToSpace(id: string, spaceId: string): void {
    this.db.prepare("UPDATE terminals SET space_id = ?, updated_at = ? WHERE id = ?").run(spaceId, now(), id);
  }
  /** Idempotent: a row may already be gone (e.g. removed on pty exit). */
  delete(id: string): void {
    this.db.prepare("DELETE FROM terminals WHERE id = ?").run(id);
  }
}
