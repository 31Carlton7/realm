import type { Db } from "../db/database";
import { newId, type Project } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; space_id: string; name: string; root_path: string; default_branch: string; created_at: number; updated_at: number };
const toProject = (r: Row): Project => ({ id: r.id, spaceId: r.space_id, name: r.name, rootPath: r.root_path, defaultBranch: r.default_branch, createdAt: r.created_at, updatedAt: r.updated_at });

export class ProjectsStore {
  constructor(private db: Db) {}
  list(spaceId: string): Project[] {
    return (this.db.prepare("SELECT * FROM projects WHERE space_id = ? ORDER BY created_at").all(spaceId) as Row[]).map(toProject);
  }
  get(id: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined; return r ? toProject(r) : null;
  }
  create(input: { spaceId: string; name: string; rootPath: string; defaultBranch: string }): Project {
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO projects (id, space_id, name, root_path, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.spaceId, input.name, input.rootPath, input.defaultBranch, t, t);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("project", id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}
