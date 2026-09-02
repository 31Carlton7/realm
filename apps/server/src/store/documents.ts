import type { Db } from "../db/database";
import type { DocumentWorkspace } from "@realm/contracts";
import { now } from "./rows";

type Row = {
  id: string; space_id: string; environment_id: string;
  open_paths_json: string; active_path: string | null;
  created_at: number; updated_at: number;
};

/** A corrupt `open_paths_json` must not take the pane down with it — a workspace with no tabs is a
 *  recoverable empty state, a throwing parse in a list query is not. */
function parsePaths(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  } catch { return []; }
}

const toWorkspace = (r: Row): DocumentWorkspace => ({
  id: r.id, spaceId: r.space_id, environmentId: r.environment_id,
  openPaths: parsePaths(r.open_paths_json), activePath: r.active_path,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export class DocumentsStore {
  constructor(private db: Db) {}

  insert(input: { id: string; spaceId: string; environmentId: string }): DocumentWorkspace {
    const t = now();
    this.db.prepare("INSERT INTO document_workspaces (id, space_id, environment_id, open_paths_json, active_path, created_at, updated_at) VALUES (?, ?, ?, '[]', NULL, ?, ?)")
      .run(input.id, input.spaceId, input.environmentId, t, t);
    return { ...input, openPaths: [], activePath: null, createdAt: t, updatedAt: t };
  }

  get(id: string): DocumentWorkspace | null {
    const r = this.db.prepare("SELECT * FROM document_workspaces WHERE id = ?").get(id) as Row | undefined;
    return r ? toWorkspace(r) : null;
  }

  /** Every workspace rooted at an environment — the watcher's view: one file change may have to reach
   *  several panes, and only the environment ties them together. */
  listByEnvironment(environmentId: string): DocumentWorkspace[] {
    return (this.db.prepare("SELECT * FROM document_workspaces WHERE environment_id = ? ORDER BY created_at").all(environmentId) as Row[]).map(toWorkspace);
  }

  /** Every workspace, for the watcher's rebuild on boot. */
  listAll(): DocumentWorkspace[] {
    return (this.db.prepare("SELECT * FROM document_workspaces ORDER BY created_at").all() as Row[]).map(toWorkspace);
  }

  /**
   * Replace the tab strip. `activePath` is CORRECTED to a member of `openPaths` (or null) rather than
   * stored as given — a client racing its own tab close would otherwise strand the pane on a tab that
   * no longer exists, which renders as an empty editor with no way back.
   */
  setTabs(id: string, openPaths: string[], activePath: string | null): DocumentWorkspace | null {
    const cur = this.get(id); if (!cur) return null;
    const paths = [...new Set(openPaths)];
    const active = activePath !== null && paths.includes(activePath) ? activePath : (paths[0] ?? null);
    this.db.prepare("UPDATE document_workspaces SET open_paths_json = ?, active_path = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(paths), active, now(), id);
    return this.get(id);
  }

  /** Idempotent, like BrowsersStore.delete. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM document_workspaces WHERE id = ?").run(id);
  }
}
