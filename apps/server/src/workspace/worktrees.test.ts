import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { BRANCH_PREFIX, NAME_ATTEMPTS, SLUG_MAX, UNNAMED_BRANCH, WorktreeService, slugifyBranch } from "./worktrees";

/**
 * Real repositories throughout. Every failure mode this service exists to handle — an empty repo, a
 * taken branch, a dirty tree refusing removal, `branch -d` refusing an unmerged branch — is a
 * behaviour of the git binary, and a fake `git worktree` would agree with whatever we wrote.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

let home: string;
beforeEach(() => { home = tempDir("realm-wt-home-"); });

function makeRepo(name = "repo"): string {
  const dir = tempDir(`realm-wt-${name}-`);
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}
const svc = () => new WorktreeService(home);
const SPACE = "01HZZZZZZZZZZZZZZZZZZZZZZZ";

describe("slugifyBranch", () => {
  // git-check-ref-format(1) is the authority, so the assertion is git itself: a mutation that
  // weakens the allowlist produces a name real git rejects, and this fails.
  const gitAccepts = (branch: string) => {
    try { execFileSync("git", ["check-ref-format", "--branch", branch], { encoding: "utf8", stdio: "pipe" }); return true; }
    catch { return false; }
  };

  const nasty = [
    "Fix the login flow", "feat/thing", "a..b", "  ", "@", "@{upstream}", ".hidden", "trailing.",
    "wip.lock", "emoji 🚀 title", "back\\slash", "colon:name", "star*", "question?", "brackets[x]",
    "tilde~1", "caret^2", "quote'\"", "tab\there", "-leading", "trailing-", "---", "...",
    "a".repeat(200), "Ünïcodé Ñame", "café/naïve", "CON", "/", "//", "..", ".", "#hash", "%percent",
  ];

  it("produces a branch name real git accepts, for every hostile title", () => {
    for (const title of nasty) {
      const branch = BRANCH_PREFIX + slugifyBranch(title);
      expect(gitAccepts(branch), `git rejected ${JSON.stringify(branch)} from ${JSON.stringify(title)}`).toBe(true);
    }
  });

  it("keeps a readable slug for an ordinary title", () => {
    expect(slugifyBranch("Fix the login flow")).toBe("fix-the-login-flow");
  });

  it("has no path separator, so realm/<slug> can never collide with realm/<slug>/<more>", () => {
    for (const title of nasty) expect(slugifyBranch(title)).not.toContain("/");
  });

  it("never returns empty — a title of only punctuation still names a branch", () => {
    for (const title of ["  ", "@", "...", "---", "///", "🚀"]) expect(slugifyBranch(title)).toBe("session");
  });

  it("clips long titles to SLUG_MAX and never ends on a separator", () => {
    const s = slugifyBranch("a very long session title ".repeat(10));
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s).not.toMatch(/[-._]$/);
  });
});

describe("WorktreeService.create", () => {
  it("adds a worktree on a realm/ branch under <home>/worktrees/<spaceId>/", async () => {
    const repo = makeRepo();
    const { path, branch } = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "Fix the login flow" });
    expect(path).toBe(join(home, "worktrees", SPACE, "fix-the-login-flow"));
    expect(branch).toBe("realm/fix-the-login-flow");
    expect(existsSync(join(path, "a.txt"))).toBe(true);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("realm/fix-the-login-flow");
    // It is a real linked worktree of the source, not a copy.
    expect(git(repo, "worktree", "list")).toContain(path);
  });

  it("refuses a directory that is not a git repository — a plain space must not break", async () => {
    const plain = tempDir("realm-wt-plain-");
    await expect(svc().create({ spaceId: SPACE, sourcePath: plain, title: "x" }))
      .rejects.toMatchObject({ code: "NOT_A_REPOSITORY" });
    expect(existsSync(join(home, "worktrees", SPACE, "x"))).toBe(false);
  });

  it("refuses a directory that does not exist", async () => {
    await expect(svc().create({ spaceId: SPACE, sourcePath: join(tmpdir(), "realm-definitely-missing-wt"), title: "x" }))
      .rejects.toMatchObject({ code: "NOT_A_REPOSITORY" });
  });

  it("refuses a repository with no commits, naming what to do about it", async () => {
    const empty = tempDir("realm-wt-empty-");
    git(empty, "init", "-b", "main");
    await expect(svc().create({ spaceId: SPACE, sourcePath: empty, title: "x" }))
      .rejects.toMatchObject({ code: "WORKTREE_NO_COMMITS", message: expect.stringContaining("no commits") });
  });

  it("suffixes rather than collides when the same title is used twice", async () => {
    const repo = makeRepo();
    const a = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "same title" });
    const b = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "same title" });
    expect(a.branch).toBe("realm/same-title");
    expect(b.branch).toBe("realm/same-title-2");
    expect(b.path).toBe(join(home, "worktrees", SPACE, "same-title-2"));
    expect(existsSync(b.path)).toBe(true);
  });

  it("skips a name whose BRANCH exists even though its directory does not", async () => {
    const repo = makeRepo();
    git(repo, "branch", "realm/taken");
    const made = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "taken" });
    expect(made.branch).toBe("realm/taken-2");
  });

  it("skips a name whose DIRECTORY exists even though its branch does not", async () => {
    const repo = makeRepo();
    mkdirSync(join(home, "worktrees", SPACE, "occupied"), { recursive: true });
    writeFileSync(join(home, "worktrees", SPACE, "occupied", "someones-file"), "x");
    const made = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "occupied" });
    expect(made.branch).toBe("realm/occupied-2");
    // The pre-existing directory is untouched.
    expect(existsSync(join(home, "worktrees", SPACE, "occupied", "someones-file"))).toBe(true);
  });

  it("gives up with WORKTREE_NAME_TAKEN rather than looping forever", async () => {
    const repo = makeRepo();
    const root = join(home, "worktrees", SPACE);
    mkdirSync(root, { recursive: true });
    for (let n = 1; n <= NAME_ATTEMPTS; n++) mkdirSync(join(root, n === 1 ? "busy" : `busy-${n}`), { recursive: true });
    await expect(svc().create({ spaceId: SPACE, sourcePath: repo, title: "busy" }))
      .rejects.toMatchObject({ code: "WORKTREE_NAME_TAKEN" });
  });

  it("branches from a worktree as happily as from the main checkout", async () => {
    const repo = makeRepo();
    const first = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "first" });
    const second = await svc().create({ spaceId: SPACE, sourcePath: first.path, title: "second" });
    expect(existsSync(second.path)).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(second.path);
  });
});

describe("WorktreeService.hazard", () => {
  it("counts modified and untracked files, and commits no remote has", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "h" });
    expect(await svc().hazard({ ...wt, fallbackRepo: repo })).toMatchObject({ present: true, dirtyFiles: 0, unpushedCommits: 1 });

    writeFileSync(join(wt.path, "b.txt"), "new\n");
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    const h = await svc().hazard({ ...wt, fallbackRepo: repo });
    expect(h.dirtyFiles).toBe(2);
  });

  it("counts only commits absent from every remote", async () => {
    const origin = makeRepo("origin");
    const clone = tempDir("realm-wt-clone-");
    rmSync(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
    const wt = await svc().create({ spaceId: SPACE, sourcePath: clone, title: "pushed" });
    // Branched from a HEAD the remote already has: nothing would be lost yet.
    expect((await svc().hazard({ ...wt, fallbackRepo: clone })).unpushedCommits).toBe(0);
    writeFileSync(join(wt.path, "c.txt"), "x\n");
    git(wt.path, "add", "."); git(wt.path, "commit", "-m", "local only");
    expect((await svc().hazard({ ...wt, fallbackRepo: clone })).unpushedCommits).toBe(1);
  });

  it("reports a directory removed by hand as absent, with nothing left to lose on disk", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "gone" });
    writeFileSync(join(wt.path, "dirty.txt"), "x");
    rmSync(wt.path, { recursive: true, force: true });
    const h = await svc().hazard({ ...wt, fallbackRepo: repo });
    expect(h.present).toBe(false);
    expect(h.dirtyFiles).toBe(0);
    // The branch still exists in the source repo, so its commits are still countable — and losable.
    expect(h.unpushedCommits).toBe(1);
  });
});

describe("WorktreeService.remove", () => {
  it("removes a clean worktree and deletes its branch", async () => {
    const origin = makeRepo("origin2");
    const clone = tempDir("realm-wt-clone2-");
    rmSync(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
    const wt = await svc().create({ spaceId: SPACE, sourcePath: clone, title: "clean" });
    await svc().remove({ ...wt, fallbackRepo: clone, acknowledge: null });
    expect(existsSync(wt.path)).toBe(false);
    expect(git(clone, "branch", "--list", "realm/clean").trim()).toBe("");
    expect(git(clone, "worktree", "list")).not.toContain(wt.path);
  });

  // MUTANT: drop the dirty-tree check (or make `acknowledge` optional) and this passes silently.
  it("refuses a dirty tree with no acknowledgement, and destroys nothing", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "dirty" });
    writeFileSync(join(wt.path, "work.txt"), "hours of work\n");
    await expect(svc().remove({ ...wt, fallbackRepo: repo, acknowledge: null }))
      .rejects.toMatchObject({ code: "WORKTREE_UNSAFE", message: expect.stringContaining("1 uncommitted file") });
    expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
  });

  // MUTANT (isolating): the test above is also satisfied by an unpushed-commits check alone, because
  // a repo with no remote has both hazards at once. Here the branch is fully pushed, so ONLY the
  // dirty-tree check stands between `--force` and an hour of uncommitted work.
  it("refuses a dirty tree even when nothing is unpushed", async () => {
    const origin = makeRepo("origin4");
    const clone = tempDir("realm-wt-clone4-");
    rmSync(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
    const wt = await svc().create({ spaceId: SPACE, sourcePath: clone, title: "onlydirty" });
    writeFileSync(join(wt.path, "work.txt"), "hours of work\n");

    const h = await svc().hazard({ ...wt, fallbackRepo: clone });
    expect(h).toMatchObject({ dirtyFiles: 1, unpushedCommits: 0 });
    await expect(svc().remove({ ...wt, fallbackRepo: clone, acknowledge: null }))
      .rejects.toMatchObject({ code: "WORKTREE_UNSAFE", message: expect.stringContaining("1 uncommitted file") });
    expect(existsSync(join(wt.path, "work.txt"))).toBe(true);

    // …and it goes ahead once that one number is acknowledged, with -d rather than -D on the branch.
    await svc().remove({ ...wt, fallbackRepo: clone, acknowledge: { dirtyFiles: 1, unpushedCommits: 0 } });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("refuses an acknowledgement whose counts do not match what git reports now", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "stale" });
    writeFileSync(join(wt.path, "one.txt"), "x");
    writeFileSync(join(wt.path, "two.txt"), "y");
    // The user was shown "1 file" and said yes; a second file arrived in between.
    await expect(svc().remove({ ...wt, fallbackRepo: repo, acknowledge: { dirtyFiles: 1, unpushedCommits: 1 } }))
      .rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect(existsSync(wt.path)).toBe(true);
  });

  it("refuses an all-zero acknowledgement over a dirty tree — the shape a buggy caller sends", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "zeros" });
    writeFileSync(join(wt.path, "work.txt"), "x");
    await expect(svc().remove({ ...wt, fallbackRepo: repo, acknowledge: { dirtyFiles: 0, unpushedCommits: 0 } }))
      .rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect(existsSync(wt.path)).toBe(true);
  });

  it("proceeds when the acknowledgement matches exactly", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "acked" });
    writeFileSync(join(wt.path, "work.txt"), "x");
    await svc().remove({ ...wt, fallbackRepo: repo, acknowledge: { dirtyFiles: 1, unpushedCommits: 1 } });
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", "realm/acked").trim()).toBe("");
  });

  // MUTANT: drop the unpushed-commits check. A clean tree whose branch holds work no remote has is
  // exactly the case `git worktree remove` alone permits and `branch -d` alone would refuse — the
  // service must ask first, not lean on git's refusal after the directory is already gone.
  it("refuses a clean worktree whose branch holds unpushed commits", async () => {
    const origin = makeRepo("origin3");
    const clone = tempDir("realm-wt-clone3-");
    rmSync(clone, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
    const wt = await svc().create({ spaceId: SPACE, sourcePath: clone, title: "unpushed" });
    writeFileSync(join(wt.path, "c.txt"), "x\n");
    git(wt.path, "add", "."); git(wt.path, "commit", "-m", "local only");
    await expect(svc().remove({ ...wt, fallbackRepo: clone, acknowledge: null }))
      .rejects.toMatchObject({ code: "WORKTREE_UNSAFE", message: expect.stringContaining("1 unpushed commit") });
    expect(existsSync(wt.path)).toBe(true);
    expect(git(clone, "branch", "--list", "realm/unpushed").trim()).not.toBe("");
  });

  it("names both hazards in one refusal", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "both" });
    writeFileSync(join(wt.path, "d.txt"), "x");
    await expect(svc().remove({ ...wt, fallbackRepo: repo, acknowledge: null }))
      .rejects.toMatchObject({ message: expect.stringMatching(/1 uncommitted file and 1 unpushed commit/) });
  });

  // MUTANT: drop assertManaged (or let a `worktree` row name any path) and this destroys a real repo.
  it("refuses any path outside <home>/worktrees, whatever the row says", async () => {
    const repo = makeRepo();
    await expect(svc().remove({ path: repo, branch: "main", fallbackRepo: repo, acknowledge: { dirtyFiles: 0, unpushedCommits: 0 } }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_MANAGED" });
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
    expect(git(repo, "branch", "--list", "main").trim()).not.toBe("");
  });

  it("refuses a path that merely looks like the managed root by prefix", async () => {
    const sneaky = `${join(home, "worktrees")}-not-ours`;
    mkdirSync(sneaky, { recursive: true });
    await expect(svc().remove({ path: sneaky, branch: null, fallbackRepo: home, acknowledge: null }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_MANAGED" });
    expect(existsSync(sneaky)).toBe(true);
  });

  it("cleans up after a directory that was already deleted by hand", async () => {
    const repo = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: repo, title: "vanished" });
    rmSync(wt.path, { recursive: true, force: true });
    await svc().remove({ ...wt, fallbackRepo: repo, acknowledge: { dirtyFiles: 0, unpushedCommits: 1 } });
    expect(git(repo, "worktree", "list")).not.toContain(wt.path);
    expect(git(repo, "branch", "--list", "realm/vanished").trim()).toBe("");
  });
});

describe("WorktreeService.isManaged", () => {
  it("accepts only paths under <home>/worktrees/", () => {
    const s = svc();
    expect(s.isManaged(join(home, "worktrees", SPACE, "x"))).toBe(true);
    expect(s.isManaged(join(home, "worktrees"))).toBe(false); // the root itself is not a worktree
    expect(s.isManaged(home)).toBe(false);
    expect(s.isManaged("/Users/someone/code/realm")).toBe(false);
    expect(s.isManaged(join(home, "worktrees", "..", "..", "etc"))).toBe(false);
  });
});

/**
 * W2 handed this over as a known weakness: sessions are created untitled, so their worktree branches
 * read `realm/session`, `realm/session-2`. The first message names the session; this is the branch
 * catching up. Real repositories throughout — including a real bare remote for the "already pushed"
 * refusal, which is the only condition here whose whole point is not renaming.
 */
describe("renameBranch", () => {
  it("only ever matches a branch Realm named for an untitled session", () => {
    for (const yes of ["realm/session", "realm/session-2", "realm/session-137"]) expect(UNNAMED_BRANCH.test(yes), yes).toBe(true);
    for (const no of ["realm/session-notes", "realm/fix-login", "main", "feat/realm/session", "realm/sessions"]) {
      expect(UNNAMED_BRANCH.test(no), no).toBe(false);
    }
  });

  it("renames the unnamed branch and leaves the worktree checked out on it", async () => {
    const src = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: src, title: null });
    expect(wt.branch).toBe("realm/session");
    const renamed = await svc().renameBranch({ path: wt.path, branch: wt.branch, title: "Fix the login flow" });
    expect(renamed).toBe("realm/fix-the-login-flow");
    // The worktree is still usable and still on the branch — `branch -m` moves HEAD with it.
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("realm/fix-the-login-flow");
    expect(git(src, "branch", "--list", "realm/session").trim()).toBe("");
  });

  it("refuses to rename a branch the user (or a titled session) already named", async () => {
    const src = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: src, title: "Already named" });
    expect(await svc().renameBranch({ path: wt.path, branch: wt.branch, title: "Something else" })).toBeNull();
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("realm/already-named");
  });

  it("refuses to rename a branch a remote already carries", async () => {
    const src = makeRepo();
    const bare = tempDir("realm-wt-bare-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const wt = await svc().create({ spaceId: SPACE, sourcePath: src, title: null });
    git(wt.path, "remote", "add", "origin", bare);
    git(wt.path, "push", "-u", "origin", "realm/session");
    // Renaming here would orphan what is on the remote and leave the user with two branches.
    expect(await svc().renameBranch({ path: wt.path, branch: wt.branch, title: "Fix the login flow" })).toBeNull();
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("realm/session");
    rmSync(bare, { recursive: true, force: true });
  });

  it("steps around a name that is already taken", async () => {
    const src = makeRepo();
    git(src, "branch", "realm/fix-the-login-flow");
    const wt = await svc().create({ spaceId: SPACE, sourcePath: src, title: null });
    expect(await svc().renameBranch({ path: wt.path, branch: wt.branch, title: "Fix the login flow" })).toBe("realm/fix-the-login-flow-2");
  });

  it("does nothing when the title slugs to the same weak name", async () => {
    const src = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: src, title: null });
    expect(await svc().renameBranch({ path: wt.path, branch: wt.branch, title: "  session  " })).toBeNull();
  });

  it("returns null rather than throwing when the worktree is gone", async () => {
    const src = makeRepo();
    const wt = await svc().create({ spaceId: SPACE, sourcePath: src, title: null });
    rmSync(wt.path, { recursive: true, force: true });
    expect(await svc().renameBranch({ path: wt.path, branch: wt.branch, title: "Fix it" })).toBeNull();
  });
});
