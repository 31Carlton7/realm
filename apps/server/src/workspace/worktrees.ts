import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { RpcError } from "../store/rows";
import { gitCapture, gitReason, type GitRun } from "./git-exec";

/** Worktrees live under `<realmHome>/worktrees/<spaceId>/<name>` (WORKTREES_DIRNAME).
 *
 *  Under Realm's home rather than beside the repo, so the user's `git status` never sees them and
 *  removing Realm's data removes them; namespaced per space, so two spaces can hold same-named
 *  worktrees of different repositories without either knowing about the other. The leaf is the
 *  branch's own slug, because it is what a shell prompt shows the user. */
export const WORKTREES_DIRNAME = "worktrees";
/** Every branch Realm creates is `realm/<slug>`. The prefix makes Realm's branches obvious in
 *  `git branch`, and puts them in a namespace the user's own `main`/`feat/...` can never collide
 *  with. The slug contains no `/`, so `realm/a` and `realm/a/b` can never both exist (git stores
 *  refs as files and would refuse the second). */
export const BRANCH_PREFIX = "realm/";
export const SLUG_MAX = 40;
/** How many `-2`, `-3`… suffixes to try before giving up on a base name. */
export const NAME_ATTEMPTS = 200;
/** A branch `create` produced for a session that had no title yet — the only shape `renameBranch`
 *  will touch. Anchored on both ends: `realm/session-notes` is a real name and must survive. */
export const UNNAMED_BRANCH = /^realm\/session(-\d+)?$/;

/**
 * A branch/directory name derived from a session title. Titles are free text: spaces, slashes,
 * emoji, `..`, control characters, a leading dot, a trailing `.lock` — every one of which git
 * refuses in a ref name (git-check-ref-format(1)) or a filesystem dislikes in a path component.
 *
 * The rule is an allowlist, not a blocklist: anything outside `[a-z0-9._-]` becomes `-`. A
 * blocklist of git's forbidden characters would be one release behind git and would still let
 * emoji, RTL overrides and path separators through.
 */
export function slugifyBranch(title: string): string {
  const slug = title
    .normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // `..` and `@{` are illegal in refs; runs of separators are merely ugly. Collapse both.
    .replace(/\.+/g, ".").replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, SLUG_MAX)
    // The slice can leave a fresh trailing separator, and `.lock` is illegal at the end of any
    // ref component however it got there.
    .replace(/[-._]+$/, "").replace(/\.lock$/, "").replace(/[-._]+$/, "");
  return slug || "session";
}

/** What `environments.removeWorktree` would destroy, and therefore what the user must acknowledge. */
export type WorktreeHazard = {
  path: string;
  branch: string | null;
  /** False when the directory is already gone (removed by hand): removal then only prunes. */
  present: boolean;
  /** Lines of `git status --porcelain`: uncommitted edits plus untracked files. */
  dirtyFiles: number;
  /** Commits on the branch that no remote ref contains — work that deleting the branch loses. */
  unpushedCommits: number;
};

/** The caller's informed consent, naming exactly what it was told would be lost. */
export type WorktreeAck = { dirtyFiles: number; unpushedCommits: number };

/**
 * Creates and removes `git worktree`s for `worktree`-kind environments.
 *
 * Every destructive verb in here is guarded twice, because this is the most destructive surface in
 * Plan 7 and a UI bug must not be able to reach it:
 *
 *  1. `assertManaged` — the path must sit under `<home>/worktrees/`. A row that somehow named the
 *     user's own repository (hand-edited database, a future bug in `create`) is refused before git
 *     is invoked at all. The `kind` check in EnvironmentService is the first gate; this is the one
 *     that does not depend on a column being right.
 *  2. `--force` and `-D` are unreachable without an acknowledgement whose numbers MATCH what git
 *     reports right now. A stale confirmation — the user said yes to "3 files", then the agent
 *     wrote a fourth — fails closed and re-prompts rather than forcing.
 */
export class WorktreeService {
  private git: GitRun;
  constructor(private home: string, opts: { git?: GitRun } = {}) {
    this.git = opts.git ?? gitCapture;
  }

  /** Root of every worktree this space owns. Absolute, and the only place `create` will write. */
  spaceRoot(spaceId: string): string {
    return join(this.home, WORKTREES_DIRNAME, spaceId);
  }

  /** True when `path` is inside a directory Realm manages — the check that makes pointing removal at
   *  a user's own repository impossible even if the environment row lies about its kind. */
  isManaged(path: string): boolean {
    const root = resolve(this.home, WORKTREES_DIRNAME) + sep;
    return resolve(path).startsWith(root);
  }
  private assertManaged(path: string): void {
    if (!this.isManaged(path)) {
      throw new RpcError("WORKTREE_NOT_MANAGED", `${path} is not a worktree Realm created; Realm will not remove it`);
    }
  }

  /**
   * `git worktree add -b realm/<slug> <path> HEAD`, plus the row's worth of facts back.
   *
   * Refuses rather than improvises for the three states a real space is actually in:
   *  - not a git repository at all (a plain directory is a perfectly ordinary Realm space),
   *  - a repository with no commits yet (git: "invalid reference: HEAD"),
   *  - every candidate name taken.
   */
  async create(input: { spaceId: string; sourcePath: string; title?: string | null }): Promise<{ path: string; branch: string }> {
    const src = input.sourcePath;
    if (!existsSync(src)) throw new RpcError("NOT_A_REPOSITORY", `${src} does not exist`);
    if ((await this.git(src, ["rev-parse", "--git-dir"])).code !== 0) {
      throw new RpcError("NOT_A_REPOSITORY", `${src} is not a git repository, so it has no worktrees`);
    }
    // An empty repository has no HEAD to branch from. git's own message ("invalid reference: HEAD")
    // does not tell the user what to do about it, so we say it.
    if ((await this.git(src, ["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0) {
      throw new RpcError("WORKTREE_NO_COMMITS", "this repository has no commits yet — make one before opening a worktree");
    }

    const root = this.spaceRoot(input.spaceId);
    mkdirSync(root, { recursive: true });
    const { path, branch } = await this.pickName(src, root, slugifyBranch(input.title?.trim() || "session"));

    const added = await this.git(src, ["worktree", "add", "-b", branch, path, "HEAD"]);
    if (added.code !== 0) throw new RpcError("WORKTREE_ADD_FAILED", gitReason(added));
    return { path, branch };
  }

  /**
   * The first `<root>/<slug>[-n]` whose directory does not exist AND whose branch does not exist.
   *
   * Both halves matter: the directory may be free while the branch is taken (a worktree removed by
   * hand leaves its branch) and the branch may be free while the directory is taken. `git worktree
   * add` would fail on either, and it fails *after* creating nothing useful, so the loop is how a
   * second worktree of the same title gets `-2` rather than an error.
   */
  private async pickName(src: string, root: string, base: string): Promise<{ path: string; branch: string }> {
    for (let n = 1; n <= NAME_ATTEMPTS; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      const branch = BRANCH_PREFIX + name;
      const path = join(root, name);
      if (existsSync(path)) continue;
      if ((await this.git(src, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) continue;
      return { path, branch };
    }
    throw new RpcError("WORKTREE_NAME_TAKEN", `no free name near "${base}" after ${NAME_ATTEMPTS} tries`);
  }

  /**
   * Give a worktree's branch the name it should have had.
   *
   * Sessions are created untitled, so a worktree opened from "+" gets `realm/session`, `realm/session-2`
   * — W2's own handover note. The first message names the session; this is where the branch catches up.
   *
   * Four conditions, and all four matter:
   *  - the branch is still an UNNAMED one (`realm/session`, `realm/session-7`). A branch the user
   *    named, or one from a titled session, is theirs and is never touched.
   *  - no remote-tracking ref carries it. Renaming a pushed branch orphans what is on the remote and
   *    leaves the user with two branches; the local check (`refs/remotes/<any>/<branch>`) is the
   *    honest one available without a network call.
   *  - the new name is free, by the same search `create` uses.
   *  - `git branch -m` succeeds. It updates the worktree's own HEAD, so the checkout stays on it.
   *
   * The DIRECTORY keeps its old leaf name. `git worktree move` while an agent is running in that
   * directory would pull the cwd out from under a live process; a shell prompt showing `session` next
   * to a branch called `realm/fix-login` is the smaller of those two problems.
   *
   * Returns the new branch, or null when any condition said no — never throws. A title is a nicety,
   * and it must not be able to fail the message that carried it.
   */
  async renameBranch(input: { path: string; branch: string; title: string }): Promise<string | null> {
    if (!UNNAMED_BRANCH.test(input.branch)) return null;
    const slug = slugifyBranch(input.title);
    if (slug === "session") return null; // the title produced the same weak name
    try {
      if (!existsSync(input.path)) return null;
      if ((await this.git(input.path, ["rev-parse", "--git-dir"])).code !== 0) return null;
      const pushed = await this.git(input.path, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${input.branch}`]);
      if (pushed.code !== 0 || pushed.stdout.trim() !== "") return null;
      for (let n = 1; n <= NAME_ATTEMPTS; n++) {
        const candidate = BRANCH_PREFIX + (n === 1 ? slug : `${slug}-${n}`);
        if ((await this.git(input.path, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`])).code === 0) continue;
        const moved = await this.git(input.path, ["branch", "-m", input.branch, candidate]);
        return moved.code === 0 ? candidate : null;
      }
      return null;
    } catch { return null; }
  }

  /**
   * What removing this worktree would cost, asked of git right now.
   *
   * `--not --remotes` is the honest definition of "unpushed": commits on the branch that no remote
   * ref contains. It counts every commit in a repo with no remote at all, which is correct — none
   * of that work exists anywhere else.
   */
  async hazard(input: { path: string; branch: string | null; fallbackRepo: string }): Promise<WorktreeHazard> {
    const present = existsSync(input.path);
    const repo = present ? input.path : input.fallbackRepo;
    const base = { path: input.path, branch: input.branch, present };
    if (!existsSync(repo) || (await this.git(repo, ["rev-parse", "--git-dir"])).code !== 0) {
      // Nothing left to ask. Removal still has to prune the stale registration.
      return { ...base, dirtyFiles: 0, unpushedCommits: 0 };
    }
    const status = present ? await this.git(repo, ["--no-optional-locks", "status", "--porcelain"]) : null;
    const dirtyFiles = status?.code === 0 ? status.stdout.split("\n").filter((l) => l.trim() !== "").length : 0;
    let unpushedCommits = 0;
    if (input.branch) {
      const counted = await this.git(repo, ["rev-list", "--count", input.branch, "--not", "--remotes"]);
      if (counted.code === 0) unpushedCommits = Number(counted.stdout.trim()) || 0;
    }
    return { ...base, dirtyFiles, unpushedCommits };
  }

  /**
   * Take the worktree off disk and delete its branch.
   *
   * `--force` is used only when git itself reports a dirty tree AND the caller acknowledged exactly
   * that many files; `-D` only when git reports unpushed commits AND the caller acknowledged
   * exactly that many. A clean worktree is removed with the plain, refusing forms — so a bug that
   * fabricates an acknowledgement of `{0, 0}` cannot destroy anything, and one that fabricates
   * `{99, 99}` is rejected for not matching.
   */
  async remove(input: { path: string; branch: string | null; fallbackRepo: string; acknowledge: WorktreeAck | null }): Promise<WorktreeHazard> {
    this.assertManaged(input.path);
    const hazard = await this.hazard(input);
    const risky = hazard.dirtyFiles > 0 || hazard.unpushedCommits > 0;
    const ack = input.acknowledge;
    if (risky && !(ack && ack.dirtyFiles === hazard.dirtyFiles && ack.unpushedCommits === hazard.unpushedCommits)) {
      throw new RpcError("WORKTREE_UNSAFE", describeHazard(hazard));
    }

    // Run git from the main checkout, not from inside the worktree that is about to disappear.
    const repo = await this.mainRepo(input.path, input.fallbackRepo);
    if (repo) {
      const removed = await this.git(repo, hazard.dirtyFiles > 0
        ? ["worktree", "remove", "--force", input.path]
        : ["worktree", "remove", input.path]);
      if (removed.code !== 0) throw new RpcError("WORKTREE_REMOVE_FAILED", gitReason(removed));
      if (input.branch) {
        // -d refuses an unmerged branch. That refusal is the safety net under the acknowledgement,
        // so it stays the default and -D is only reached with matching consent above.
        const deleted = await this.git(repo, ["branch", hazard.unpushedCommits > 0 ? "-D" : "-d", input.branch]);
        // A branch that is already gone, or was never created, is not a failure of removal.
        if (deleted.code !== 0 && !/not found|Cannot delete/i.test(deleted.stderr)) {
          throw new RpcError("WORKTREE_REMOVE_FAILED", gitReason(deleted));
        }
      }
    }
    return hazard;
  }

  /**
   * The checkout that owns this worktree's refs: `--git-common-dir` resolved from inside it, or the
   * fallback (the space's primary) when the directory is already gone.
   */
  private async mainRepo(path: string, fallbackRepo: string): Promise<string | null> {
    if (existsSync(path)) {
      const common = await this.git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (common.code === 0 && common.stdout.trim()) return dirname(common.stdout.trim());
    }
    if (existsSync(fallbackRepo) && (await this.git(fallbackRepo, ["rev-parse", "--git-dir"])).code === 0) return fallbackRepo;
    return null;
  }

  /** Undo a half-made worktree when the database write after `create` fails. Best effort by design:
   *  the directory is one we made moments ago under our own root and has never been handed out. */
  async discard(sourcePath: string, path: string, branch: string): Promise<void> {
    if (!this.isManaged(path)) return;
    try {
      await this.git(sourcePath, ["worktree", "remove", "--force", path]);
      await this.git(sourcePath, ["branch", "-D", branch]);
    } catch { /* the row failure is the error worth reporting */ }
  }
}

/** The refusal message, which must name what would be lost — a bare "unsafe" teaches nothing. */
export function describeHazard(h: WorktreeHazard): string {
  const parts: string[] = [];
  if (h.dirtyFiles > 0) parts.push(h.dirtyFiles === 1 ? "1 uncommitted file" : `${h.dirtyFiles} uncommitted files`);
  if (h.unpushedCommits > 0) parts.push(h.unpushedCommits === 1 ? "1 unpushed commit" : `${h.unpushedCommits} unpushed commits`);
  return `${h.branch ?? h.path} has ${parts.join(" and ")}; removing it destroys that work — confirm those exact counts to proceed`;
}
