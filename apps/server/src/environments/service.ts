import type { Environment, WorktreeAck, WorktreeStatus } from "@realm/contracts";
import type { EnvironmentsStore } from "../store/environments";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import type { PortAllocator } from "../workspace/ports";
import type { WorktreeService } from "../workspace/worktrees";

/**
 * The environment lifecycle (Plan 7 W2): making a worktree, pricing its removal, and removing it.
 *
 * The one structural decision worth stating: there is no `environments.create`. A row that merely
 * *claims* `kind: "worktree"` while pointing at a directory Realm never made would make
 * `git worktree remove --force` reachable for the user's own repository — so the only path to a
 * `worktree` row is `createWorktree`, which does `git worktree add` and the insert together and
 * unwinds the directory if the insert fails. A half-made environment cannot exist.
 */
export class EnvironmentService {
  constructor(private d: { environments: EnvironmentsStore; spaces: SpacesStore; worktrees: WorktreeService; ports: PortAllocator }) {}

  list(spaceId: string): Environment[] { return this.d.environments.list(spaceId); }
  get(id: string): Environment {
    const e = this.d.environments.get(id); if (!e) throw new NotFoundError("environment", id);
    return e;
  }

  /** The environment `createWorktree` branches off: the caller's, or the space's own checkout. */
  private source(spaceId: string, from: string | null): Environment {
    if (!from) return this.d.environments.ensurePrimary(spaceId);
    const env = this.get(from);
    if (env.spaceId !== spaceId) throw new RpcError("ENVIRONMENT_WRONG_SPACE", "that environment belongs to another space");
    return env;
  }

  async createWorktree(input: { spaceId: string; title: string | null; from: string | null }): Promise<Environment> {
    if (!this.d.spaces.get(input.spaceId)) throw new NotFoundError("space", input.spaceId);
    const src = this.source(input.spaceId, input.from);
    const { path, branch } = await this.d.worktrees.create({ spaceId: input.spaceId, sourcePath: src.path, title: input.title });
    let env: Environment;
    try {
      env = this.d.environments.create({ spaceId: input.spaceId, path, kind: "worktree", branch });
    } catch (e) {
      // The directory exists and the row does not: leaving it would be an unreachable worktree that
      // only `git worktree list` remembers. Take it back off disk before reporting the failure.
      await this.d.worktrees.discard(src.path, path, branch);
      throw e;
    }
    // A worktree with no port block is the collision this workstream exists to prevent, so the block
    // is claimed at creation rather than at first spawn. Exhaustion leaves it null; see PortAllocator.
    await this.d.ports.ensureBlock(env.id);
    return this.get(env.id);
  }

  /** Why removal is refused, or null when it is allowed. Shared by `worktreeStatus` (which reports
   *  it) and `removeWorktree` (which throws it) so the two can never disagree. */
  private blocker(env: Environment): RpcError | null {
    if (env.kind === "primary") return new RpcError("ENVIRONMENT_PRIMARY", "a space's primary checkout cannot be removed");
    if (env.kind !== "worktree") return new RpcError("ENVIRONMENT_NOT_WORKTREE", "Realm did not create this checkout, so it will not remove it");
    const n = this.d.environments.sessionCount(env.id);
    if (n > 0) return new RpcError("ENVIRONMENT_IN_USE", n === 1 ? "1 session still runs here" : `${n} sessions still run here`);
    return null;
  }

  async worktreeStatus(id: string): Promise<WorktreeStatus> {
    const env = this.get(id);
    const blocked = this.blocker(env);
    // Only ask git about worktrees. A `primary`/`checkout` row is someone else's working copy and a
    // dirty-file count for it would read as an invitation to clear it.
    const hazard = env.kind === "worktree"
      ? await this.d.worktrees.hazard({ path: env.path, branch: env.branch, fallbackRepo: this.fallbackRepo(env) })
      : { present: true, dirtyFiles: 0, unpushedCommits: 0 };
    return {
      environmentId: env.id, path: env.path, branch: env.branch,
      present: hazard.present, dirtyFiles: hazard.dirtyFiles, unpushedCommits: hazard.unpushedCommits,
      removable: blocked === null, blockedBy: blocked?.code ?? null,
    };
  }

  async removeWorktree(id: string, acknowledge: WorktreeAck | null): Promise<void> {
    const env = this.get(id);
    const blocked = this.blocker(env);
    if (blocked) throw blocked;
    await this.d.worktrees.remove({ path: env.path, branch: env.branch, fallbackRepo: this.fallbackRepo(env), acknowledge });
    // Only after git succeeded: a row deleted first would strand the directory with nothing pointing
    // at it. `delete` re-checks primary/in-use, which is fine — it has been true throughout.
    this.d.environments.delete(id);
  }

  /** Where to run git when the worktree's own directory is gone: the space's primary checkout, which
   *  is what it was branched from and where its branch ref still lives. */
  private fallbackRepo(env: Environment): string {
    return this.d.environments.ensurePrimary(env.spaceId).path;
  }
}
