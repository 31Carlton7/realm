import type { Db } from "../db/database";
import { newId, type Environment, type EnvironmentKind } from "@realm/contracts";
import { NotFoundError, RpcError, now } from "./rows";

type Row = { id: string; space_id: string; path: string; branch: string | null; kind: EnvironmentKind;
  port_block_start: number | null; created_at: number; updated_at: number };
const toEnvironment = (r: Row): Environment => ({
  id: r.id, spaceId: r.space_id, path: r.path, branch: r.branch, kind: r.kind,
  portBlockStart: r.port_block_start, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Environments are owned by the space, not by the sessions that run in them (Plan 7 W1).
 *
 * Lifecycle policy: nothing removes an environment implicitly. Deleting the last session that
 * references one leaves it standing — it is a checkout on disk, and a session is a task that happened
 * to use it. Removal is the explicit `environments.delete`, which refuses while a session still points
 * at the row and refuses outright for a space's primary checkout. The `sessions.environment_id`
 * foreign key (NO ACTION) enforces the first of those in the database as well.
 */
export class EnvironmentsStore {
  constructor(private db: Db) {}

  list(spaceId: string): Environment[] {
    // `rowid` breaks created_at ties by insertion order: two environments made in the same millisecond
    // must still come back in a stable order, or every caller that lists them is subtly flaky.
    return (this.db.prepare("SELECT * FROM environments WHERE space_id = ? ORDER BY created_at, rowid").all(spaceId) as Row[]).map(toEnvironment);
  }
  get(id: string): Environment | null {
    const r = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as Row | undefined;
    return r ? toEnvironment(r) : null;
  }
  findByPath(spaceId: string, path: string): Environment | null {
    const r = this.db.prepare("SELECT * FROM environments WHERE space_id = ? AND path = ?").get(spaceId, path) as Row | undefined;
    return r ? toEnvironment(r) : null;
  }
  /** Every environment at this checkout path, ACROSS spaces (Plan 13 W3: `workspace.ship` knows only
   *  a cwd, and a shipped tree stales every space's review of it — cross-space rows at one path are
   *  rare but possible via linked checkouts). */
  findAllByPath(path: string): Environment[] {
    return (this.db.prepare("SELECT * FROM environments WHERE path = ? ORDER BY created_at, rowid").all(path) as Row[]).map(toEnvironment);
  }

  /**
   * The space's own checkout, created on first use. One per space: `environments_one_primary` makes a
   * second one impossible, so two sessions in a space can never disagree about where "the checkout" is.
   */
  ensurePrimary(spaceId: string): Environment {
    const space = this.db.prepare("SELECT folder_path FROM spaces WHERE id = ?").get(spaceId) as { folder_path: string } | undefined;
    if (!space) throw new NotFoundError("space", spaceId);
    const existing = this.db.prepare("SELECT * FROM environments WHERE space_id = ? AND kind = 'primary'").get(spaceId) as Row | undefined;
    if (existing) return toEnvironment(existing);
    return this.create({ spaceId, path: space.folder_path, kind: "primary" });
  }

  /** Get-or-create the environment for an existing checkout in the space (e.g. a project root). */
  ensureAt(spaceId: string, path: string, kind: EnvironmentKind): Environment {
    return this.findByPath(spaceId, path) ?? this.create({ spaceId, path, kind });
  }

  create(input: { spaceId: string; path: string; kind: EnvironmentKind; branch?: string | null; portBlockStart?: number | null }): Environment {
    if (!this.db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(input.spaceId)) throw new NotFoundError("space", input.spaceId);
    const id = newId(); const t = now();
    this.db.prepare("INSERT INTO environments (id, space_id, path, branch, kind, port_block_start, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.spaceId, input.path, input.branch ?? null, input.kind, input.portBlockStart ?? null, t, t);
    return this.get(id)!;
  }

  /** Record a branch rename (W3: a worktree's branch catching up with its session's first message).
   *  The row's `path` never changes with it — see `WorktreeService.renameBranch` for why. */
  setBranch(id: string, branch: string): Environment {
    if (!this.get(id)) throw new NotFoundError("environment", id);
    this.db.prepare("UPDATE environments SET branch = ?, updated_at = ? WHERE id = ?").run(branch, now(), id);
    return this.get(id)!;
  }

  /** Sessions currently running in this environment — the reason `delete` may refuse. */
  sessionCount(id: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE environment_id = ?").get(id) as { n: number }).n;
  }

  delete(id: string): void {
    const env = this.get(id); if (!env) throw new NotFoundError("environment", id);
    if (env.kind === "primary") throw new RpcError("ENVIRONMENT_PRIMARY", "a space's primary checkout cannot be removed");
    const n = this.sessionCount(id);
    if (n > 0) throw new RpcError("ENVIRONMENT_IN_USE", n === 1 ? "1 session still runs here" : `${n} sessions still run here`);
    this.db.prepare("DELETE FROM environments WHERE id = ?").run(id);
    // The directory is left on disk: W1 owns the record, not the checkout.
  }
}
