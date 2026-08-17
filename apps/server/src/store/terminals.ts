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
  listBySpace(spaceId: string): TerminalRow[] {
    return (this.db.prepare("SELECT * FROM terminals WHERE space_id = ? ORDER BY created_at").all(spaceId) as Row[]).map(toRow);
  }
  /** Idempotent: a row may already be gone (e.g. removed on pty exit). */
  delete(id: string): void {
    this.db.prepare("DELETE FROM terminals WHERE id = ?").run(id);
  }
}
