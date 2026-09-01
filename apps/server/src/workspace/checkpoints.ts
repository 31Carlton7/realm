import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError } from "../store/rows";
import { gitCapture, gitReason, type GitRun } from "./git-exec";

/**
 * Checkpoints as hidden git refs (Plan 7 W4).
 *
 * ## Where they live
 *
 * `refs/realm/checkpoints/<environmentId>/<checkpointId>`. Verified against git 2.51: this namespace is
 * invisible to `git branch`, `git branch -a`, `git tag`, `git log`, `git status`, and to the default
 * push/fetch refspecs, and it gets no reflog (git only auto-creates reflogs under `refs/heads`,
 * `refs/remotes`, `refs/notes` and `HEAD`) — which matters, because a reflog entry would pin the
 * objects for `gc.reflogExpireUnreachable` (90 days) after the ref itself was deleted. `-c
 * core.logAllRefUpdates=false` on the write makes that true even in a repo configured with `always`.
 *
 * The one place they DO show is `git log --all` and `git for-each-ref`, which enumerate everything
 * under `refs/`. That is unavoidable for a real ref and is the honest limit of "invisible".
 *
 * Refs under `refs/` are shared across a repository's worktrees (only `refs/bisect`, `refs/worktree`
 * and `refs/rewritten` are per-worktree), so a worktree's checkpoints live in the main checkout's
 * ref store. That is why the namespace is keyed by environment id: two worktrees of one repository
 * share the ref store and must not share checkpoints.
 *
 * ## How a checkpoint is made, and why not `git stash create`
 *
 * `git stash create` is the obvious candidate — it writes a commit object without touching the index
 * or the working tree. It was measured and rejected: **it does not capture untracked files**. It takes
 * no options (`git stash create -u` treats `-u` as part of the message and silently produces the same
 * two-parent commit with no untracked content). An agent's first act is usually to create files, so a
 * checkpoint that skips untracked files would omit exactly the work most likely to need undoing.
 *
 * So: a temporary index. The real index is COPIED to a scratch file, `GIT_INDEX_FILE` points every
 * command at the copy, and nothing in `$GIT_DIR` is written except new objects:
 *
 *  1. `write-tree` on the copy            → `indexTree`    — what was staged.
 *  2. `add -A` on the copy, `write-tree`  → `worktreeTree` — what is on disk, untracked files included.
 *  3. `commit-tree worktreeTree -p HEAD -p indexCommit` → the checkpoint commit.
 *
 * The second parent is what keeps `indexTree` reachable from the ref, so the staged/unstaged split
 * survives a `git gc`. That is the same shape `git stash` uses, arrived at for the same reason.
 *
 * ## What is captured, precisely
 *
 * Captured: tracked modifications, staged content (separately), deletions, untracked files, the
 * executable bit, symlinks (mode 120000), and the commit HEAD pointed at.
 *
 * NOT captured: files matched by `.gitignore` (never read, never written, never deleted — `node_modules`
 * and `.env` are safe from both halves of this feature); empty directories (git has no representation
 * for them); a submodule's working tree (only its gitlink commit id); file permissions beyond the
 * executable bit; extended attributes; mtimes; anything outside the checkout.
 *
 * ## Hardening
 *
 * `add -A` runs `filter.<driver>.clean` if `.gitattributes` names one, and there is no flag that turns
 * that off. Unlike the read path (git-info/git-diff), which is deliberately defended against a hostile
 * checkout's own config, this is accepted here for one reason: capture only ever runs against an
 * environment's own path — a directory the user chose or a worktree Realm made from it — never against
 * a path an agent named. GIT_HARDENING still applies through `gitCapture`.
 */
export const CHECKPOINT_REF_PREFIX = "refs/realm/checkpoints";

/** Identity for the checkpoint commit object. Fixed rather than the user's, because these commits are
 *  never pushed and a repository with no `user.email` must still be able to checkpoint. Signing is
 *  disabled: a `commit.gpgsign = true` repository would otherwise block every turn on a passphrase. */
const COMMIT_IDENT = [
  "-c", "user.name=Realm", "-c", "user.email=checkpoints@realm.invalid",
  "-c", "commit.gpgsign=false",
];
/** Refs under `refs/realm` get no reflog by default; this holds even under `core.logAllRefUpdates=always`. */
const NO_REFLOG = ["-c", "core.logAllRefUpdates=false"];

/** Ids are ULIDs and cannot contain a path separator, but a ref name IS a filesystem path, so the shape
 *  is asserted rather than assumed: one bad id would write a ref outside the namespace. */
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function checkpointRef(environmentId: string, checkpointId: string): string {
  if (!ID.test(environmentId) || !ID.test(checkpointId)) {
    throw new RpcError("INVALID_PARAMS", "checkpoint refs are named by ULID only");
  }
  return `${CHECKPOINT_REF_PREFIX}/${environmentId}/${checkpointId}`;
}

/** The git facts a checkpoint row stores. Everything here is a sha or null. */
export type CapturedState = {
  /** The checkpoint commit the ref points at. */
  commitSha: string;
  /** Tree of the working tree, untracked files folded in. */
  worktreeTree: string;
  /** Tree of the index — what was staged. Equal to `worktreeTree` when nothing was staged. */
  indexTree: string;
  /** Commit HEAD was on, or null in a repository with no commits yet. */
  headSha: string | null;
  /** `refs/heads/<branch>` HEAD pointed at, or null when detached. Restore refuses to move a HEAD that
   *  is no longer on this ref — moving it would rewrite a branch the user switched to since. */
  headRef: string | null;
};

/** What restoring a checkpoint would cost, asked of git right now. */
export type RestoreHazard = {
  /** Paths whose content or existence differs between the checkpoint and the working tree now. */
  filesChanged: number;
  /** Commits on HEAD that the checkpoint predates — rolled back if HEAD can be moved. */
  commitsRolledBack: number;
  /** False when HEAD has left the branch the checkpoint was taken on: files still restore, HEAD does not. */
  headMovable: boolean;
  /** Why HEAD will not move, when it will not. */
  headReason: string | null;
};

/** The caller's consent, naming exactly the numbers it was shown. */
export type RestoreAck = { filesChanged: number; commitsRolledBack: number };

export type RestoreOutcome = {
  headMoved: boolean;
  /** Why HEAD stayed where it was, when it did. */
  headReason: string | null;
  /** Untracked, non-ignored paths deleted because they postdate the checkpoint. */
  filesRemoved: number;
};

/**
 * The git half of checkpoints: capture, restore, prune. Knows nothing about sessions, environments or
 * the database — it is given a checkout path and a pair of ids.
 */
export class CheckpointGit {
  private git: GitRun;
  constructor(opts: { git?: GitRun } = {}) { this.git = opts.git ?? gitCapture; }

  /** The checkout root. Every command below runs there, so a path from one means the same in all. */
  private async root(cwd: string): Promise<string> {
    const r = await this.git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const top = r.stdout.trim();
    if (r.code !== 0 || top === "") throw new RpcError("NOT_A_REPOSITORY", `${cwd} is not a git repository`);
    return top;
  }

  /** True when `cwd` is inside a git checkout at all. Callers skip checkpointing rather than fail:
   *  a plain directory is a perfectly ordinary Realm space. */
  async isRepository(cwd: string): Promise<boolean> {
    if (!existsSync(cwd)) return false;
    try { return (await this.git(cwd, ["rev-parse", "--git-dir"])).code === 0; }
    catch { return false; }
  }

  /**
   * Write the checkout's current state as a commit object and point a hidden ref at it.
   *
   * Nothing in the working tree, the index or HEAD is touched. The only writes are loose objects and
   * one ref — which is what makes this safe to run on every turn, in front of an agent that is about
   * to start editing.
   */
  async capture(input: { cwd: string; environmentId: string; checkpointId: string; message: string }): Promise<CapturedState> {
    const root = await this.root(input.cwd);
    const ref = checkpointRef(input.environmentId, input.checkpointId);

    const head = await this.git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const headSha = head.code === 0 ? head.stdout.trim() || null : null;
    const symbolic = await this.git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    const headRef = symbolic.code === 0 ? symbolic.stdout.trim() || null : null;

    const { indexTree, worktreeTree } = await this.snapshot(root, headSha);

    // The index commit exists only to keep `indexTree` reachable from the ref. Its parent is HEAD so
    // it is a well-formed commit; nothing ever reads its history.
    const parents: string[] = [];
    if (headSha) parents.push("-p", headSha);
    const indexCommit = await this.commitTree(root, indexTree, parents, "realm checkpoint index");
    const commitSha = await this.commitTree(root, worktreeTree, [...parents, "-p", indexCommit], input.message);

    const set = await this.git(root, [...NO_REFLOG, "update-ref", ref, commitSha]);
    if (set.code !== 0) throw new RpcError("CHECKPOINT_FAILED", gitReason(set));
    return { commitSha, worktreeTree, indexTree, headSha, headRef };
  }

  /**
   * The two trees describing the checkout right now, written against a scratch index.
   *
   * Used by `capture` (which commits them) and by `hazard` (which only diffs against them). It writes
   * blob objects for anything git has not hashed yet; a preview that is never restored therefore leaves
   * a few unreferenced blobs behind, which `git gc` collects — the same blobs the next capture would
   * have written anyway.
   */
  private async snapshot(root: string, headSha: string | null): Promise<{ indexTree: string; worktreeTree: string }> {
    const scratch = mkdtempSync(join(tmpdir(), "realm-checkpoint-"));
    const index = join(scratch, "index");
    try {
      // The real index is copied, never used in place: `add -A` against it would stage the agent's
      // work into the user's index, which is precisely the disturbance a checkpoint must not cause.
      // A repository that has never had an index has no file to copy; git creates the scratch one.
      const realIndex = (await this.git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
      if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, index);

      const indexTree = await this.writeTree(root, index, headSha);
      const added = await this.git(root, ["add", "-A", "--", "."], { env: { GIT_INDEX_FILE: index } });
      if (added.code !== 0) throw new RpcError("CHECKPOINT_FAILED", gitReason(added));
      const worktreeTree = await this.writeTree(root, index, headSha);
      return { indexTree, worktreeTree };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** `write-tree` against the scratch index. An index left unmerged by a conflict cannot be written at
   *  all, so the HEAD tree stands in for the staged side — the working tree, which is what the user is
   *  actually looking at mid-conflict, is captured either way. */
  private async writeTree(root: string, index: string, headSha: string | null): Promise<string> {
    const r = await this.git(root, ["write-tree"], { env: { GIT_INDEX_FILE: index } });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    if (headSha) {
      const fallback = await this.git(root, ["rev-parse", `${headSha}^{tree}`]);
      if (fallback.code === 0 && fallback.stdout.trim()) return fallback.stdout.trim();
    }
    throw new RpcError("CHECKPOINT_FAILED", gitReason(r));
  }

  private async commitTree(root: string, tree: string, parents: string[], message: string): Promise<string> {
    const r = await this.git(root, [...COMMIT_IDENT, "commit-tree", tree, ...parents, "-m", message]);
    const sha = r.stdout.trim();
    if (r.code !== 0 || !sha) throw new RpcError("CHECKPOINT_FAILED", gitReason(r));
    return sha;
  }

  /**
   * What `restore` would change, counted against the checkout as it is right now.
   *
   * The count is a tree-to-tree diff, not `git diff <tree>`. That distinction is load-bearing:
   * `git diff <tree>` compares the tree against the INDEX plus the working tree, so every untracked
   * file the checkpoint captured reads as a deletion and an unchanged checkout reports work to lose.
   * Snapshotting the checkout into a second tree and diffing the two counts exactly the paths that
   * differ — untracked additions, untracked deletions, mode flips and all — and reports zero when
   * nothing has moved.
   */
  async hazard(input: { cwd: string; state: CapturedState }): Promise<RestoreHazard> {
    const root = await this.root(input.cwd);
    const head = await this.git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const current = await this.snapshot(root, head.code === 0 ? head.stdout.trim() || null : null);
    const changed = await this.git(root, ["diff-tree", "-r", "--name-only", "-z", input.state.worktreeTree, current.worktreeTree]);
    const filesChanged = changed.code === 0 ? nulPaths(changed.stdout).length : 0;

    const { movable, reason } = await this.headMovable(root, input.state);
    let commitsRolledBack = 0;
    if (movable && input.state.headSha) {
      const counted = await this.git(root, ["rev-list", "--count", `${input.state.headSha}..HEAD`]);
      if (counted.code === 0) commitsRolledBack = Number(counted.stdout.trim()) || 0;
    }
    return { filesChanged, commitsRolledBack, headMovable: movable, headReason: reason };
  }

  /** Untracked, non-ignored paths. `--exclude-standard` is what keeps `.gitignore`d files out of both
   *  the count and the deletion sweep. */
  private async untracked(root: string): Promise<string[]> {
    const r = await this.git(root, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
    return r.code === 0 ? nulPaths(r.stdout) : [];
  }

  /**
   * Whether restore may move HEAD.
   *
   * It may only when HEAD is still the same ref the checkpoint was taken on. `reset --soft` moves
   * whatever branch HEAD currently points at, so restoring a checkpoint taken on `realm/foo` while the
   * checkout sits on `main` would silently rewind `main` — a branch the checkpoint knows nothing about.
   * Files are still restored in that case; HEAD is left alone and the caller is told why.
   */
  private async headMovable(root: string, state: CapturedState): Promise<{ movable: boolean; reason: string | null }> {
    if (!state.headSha) return { movable: false, reason: "the checkpoint predates this repository's first commit" };
    const symbolic = await this.git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    const current = symbolic.code === 0 ? symbolic.stdout.trim() || null : null;
    if (current !== state.headRef) {
      return { movable: false, reason: `the checkout is on ${current ? shortRef(current) : "a detached HEAD"} now, not ${state.headRef ? shortRef(state.headRef) : "a detached HEAD"}` };
    }
    if ((await this.git(root, ["cat-file", "-e", `${state.headSha}^{commit}`])).code !== 0) {
      return { movable: false, reason: "the commit the checkpoint was taken on is gone" };
    }
    return { movable: true, reason: null };
  }

  /**
   * Put the checkout back the way the checkpoint found it.
   *
   * Four steps, in this order, each of which matters:
   *
   *  1. `reset --soft <headSha>` — moves the branch tip only. `--soft` and not `--hard`: the index and
   *     the working tree are set from the captured trees below, and a `--hard` here would do the same
   *     job worse (it restores HEAD's tree, not the checkpoint's).
   *  2. `read-tree --reset -u <worktreeTree>` — the one command that both writes every captured file
   *     (content, mode, symlinks) and deletes tracked files the checkpoint did not have.
   *  3. Delete what is untracked afterwards. Step 2 put every captured path into the index, so anything
   *     `ls-files --others --exclude-standard` still reports postdates the checkpoint. Ignored files
   *     are excluded and therefore never deleted.
   *  4. `read-tree <indexTree>` — index only, no `-u`, so the staged/unstaged split comes back without
   *     touching the files step 2 just wrote.
   *
   * The caller is responsible for having captured the CURRENT state first. This method will not do it,
   * because a service that owns the row is the only thing that can make that capture durable.
   */
  async restore(input: { cwd: string; state: CapturedState }): Promise<RestoreOutcome> {
    const root = await this.root(input.cwd);
    // Only the HEAD question is asked again here, not the whole hazard: the caller has already
    // computed and confirmed the counts, and re-deriving them would mean snapshotting the working tree
    // into a second tree for a number nobody reads.
    const { movable, reason } = await this.headMovable(root, input.state);

    let headMoved = false;
    if (movable && input.state.headSha) {
      const reset = await this.git(root, ["reset", "--soft", input.state.headSha]);
      if (reset.code !== 0) throw new RpcError("RESTORE_FAILED", gitReason(reset));
      headMoved = true;
    }

    const filesRemoved = await this.applyTrees(root, input.state, "RESTORE_FAILED");
    return { headMoved, headReason: headMoved ? null : reason, filesRemoved };
  }

  /**
   * Write this checkpoint's captured trees into a DIFFERENT, freshly created worktree — Plan 16 W3's
   * fork. The tree steps are `restore`'s exactly (`applyTrees`); the HEAD rule is deliberately NOT:
   * the target's branch is one the caller minted for the fork moments ago, so HEAD is moved to the
   * checkpoint's own commit whenever that commit still exists — there is no user branch to protect,
   * and a fork left ahead of its own files would show phantom "uncommitted deletions".
   *
   * NEVER point this at the checkpoint's own environment. Restoring in place is `restore`'s job, and
   * only it carries the acknowledgement flow that makes in-place rewriting survivable. ForkService is
   * the one caller, and it only ever passes the worktree it just created.
   */
  async extract(input: { cwd: string; state: CapturedState }): Promise<{ headMoved: boolean; filesRemoved: number }> {
    const root = await this.root(input.cwd);
    let headMoved = false;
    if (input.state.headSha && (await this.git(root, ["cat-file", "-e", `${input.state.headSha}^{commit}`])).code === 0) {
      const reset = await this.git(root, ["reset", "--soft", input.state.headSha]);
      if (reset.code !== 0) throw new RpcError("FORK_FAILED", gitReason(reset));
      headMoved = true;
    }
    const filesRemoved = await this.applyTrees(root, input.state, "FORK_FAILED");
    return { headMoved, filesRemoved };
  }

  /** Steps 2–4 of the restore recipe (see `restore`'s doc comment): working tree from
   *  `worktreeTree`, untracked survivors deleted, index from `indexTree`. */
  private async applyTrees(root: string, state: CapturedState, errorCode: string): Promise<number> {
    const applied = await this.git(root, ["read-tree", "--reset", "-u", state.worktreeTree]);
    if (applied.code !== 0) throw new RpcError(errorCode, gitReason(applied));

    let filesRemoved = 0;
    for (const path of await this.untracked(root)) {
      try { unlinkSync(join(root, path)); filesRemoved += 1; }
      catch { /* a directory, a race, a permission — the tree is already correct for everything else */ }
    }

    const index = await this.git(root, ["read-tree", state.indexTree]);
    if (index.code !== 0) throw new RpcError(errorCode, gitReason(index));
    return filesRemoved;
  }

  /** Drop the hidden refs for these checkpoints. The objects become unreachable and are collected by
   *  the repository's own `git gc` (after `gc.pruneExpire`, two weeks by default) — Realm never runs
   *  gc in a user's repository itself. Missing refs are not an error: the point is that they are gone. */
  async deleteRefs(cwd: string, refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    if (!await this.isRepository(cwd)) return;
    const root = await this.root(cwd);
    for (const ref of refs) await this.git(root, [...NO_REFLOG, "update-ref", "-d", ref]);
  }

  /** Every checkpoint ref this environment owns, as git has them. The reconciliation source for
   *  `deleteEnvironment`: a row that was lost still leaves a ref, and a ref nothing points at is the
   *  disk leak retention exists to prevent. */
  async listRefs(cwd: string, environmentId: string): Promise<string[]> {
    if (!ID.test(environmentId)) throw new RpcError("INVALID_PARAMS", "checkpoint refs are named by ULID only");
    if (!await this.isRepository(cwd)) return [];
    const root = await this.root(cwd);
    const r = await this.git(root, ["for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_PREFIX}/${environmentId}/`]);
    return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "") : [];
  }

  /** True when the ref still exists and still points at the recorded commit — the check that stops a
   *  restore reading a row whose objects a `git gc` or a hand-run `update-ref` has taken away. */
  async refIntact(cwd: string, ref: string, commitSha: string): Promise<boolean> {
    if (!await this.isRepository(cwd)) return false;
    const root = await this.root(cwd);
    const r = await this.git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 && r.stdout.trim() === commitSha;
  }
}

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");
/** NUL-separated paths, dropping the empty tail after the final NUL. */
function nulPaths(out: string): string[] {
  return out.split("\0").filter((p) => p !== "");
}
