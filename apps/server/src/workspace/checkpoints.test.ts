import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { newId } from "@realm/contracts";
import { CHECKPOINT_REF_PREFIX, CheckpointGit, checkpointRef } from "./checkpoints";

/**
 * Real repositories in real scratch directories. Nothing here is mocked, because every failure mode
 * this file is about — what `add -A` does with an untracked symlink, what `read-tree --reset -u`
 * deletes, whether a ref gets a reflog — is git's behaviour and not ours.
 *
 * `makeRepo` asserts its own directory is under the OS temp dir before a single git command runs.
 * These tests delete working trees; one that picked up the wrong cwd would delete a real one.
 */
const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });
}
function makeRepo(): string {
  const dir = tempDir("realm-cp-");
  const scratch = resolve(tmpdir());
  if (!resolve(dir).startsWith(scratch)) throw new Error(`refusing to run against ${dir}: not a scratch directory`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
/** A repository that has been `git init`ed and nothing more: no HEAD, no index file. */
function makeEmptyRepo(): string {
  const dir = tempDir("realm-cp-empty-");
  if (!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${dir}`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
}
const cleanup = (...dirs: string[]) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };

const svc = () => new CheckpointGit();
const ids = () => ({ environmentId: newId(), checkpointId: newId() });
const status = (repo: string) => git(repo, "status", "--porcelain").trim();
const files = (repo: string) => {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel); else out.push(rel);
    }
  };
  walk(repo, "");
  return out.sort();
};

describe("checkpointRef", () => {
  it("names a ref under refs/realm, never under refs/heads", () => {
    const ref = checkpointRef("01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FAW");
    expect(ref.startsWith(`${CHECKPOINT_REF_PREFIX}/`)).toBe(true);
    expect(ref.startsWith("refs/heads/")).toBe(false);
  });

  it("refuses an id that is not a ULID, because a ref name is a path", () => {
    expect(() => checkpointRef("../../heads/main", "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(/ULID/);
    expect(() => checkpointRef("01ARZ3NDEKTSV4RRFFQ69G5FAV", "a/b")).toThrow(/ULID/);
  });
});

describe("capture", () => {
  it("hides the ref from git branch and git log while for-each-ref still finds it", async () => {
    const repo = makeRepo();
    try {
      const id = ids();
      const state = await svc().capture({ cwd: repo, ...id, message: "turn 1" });
      const ref = checkpointRef(id.environmentId, id.checkpointId);
      expect(git(repo, "branch", "-a")).not.toContain(id.checkpointId);
      expect(git(repo, "log", "--oneline")).not.toContain("turn 1");
      expect(git(repo, "tag", "-l").trim()).toBe("");
      expect(git(repo, "for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_PREFIX}/`).trim()).toBe(ref);
      expect(git(repo, "rev-parse", ref).trim()).toBe(state.commitSha);
    } finally { cleanup(repo); }
  });

  it("writes no reflog for the ref, so deleting it really unreferences the objects", async () => {
    const repo = makeRepo();
    try {
      const id = ids();
      // Even under `always`, which would otherwise create a reflog for any ref under refs/.
      git(repo, "config", "core.logAllRefUpdates", "always");
      await svc().capture({ cwd: repo, ...id, message: "turn 1" });
      expect(existsSync(join(repo, ".git", "logs", "refs", "realm"))).toBe(false);
    } finally { cleanup(repo); }
  });

  it("leaves the working tree, the index and HEAD exactly as they were", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\n");
      git(repo, "add", "tracked.txt");
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\nworktree\n");
      writeFileSync(join(repo, "new.txt"), "new\n");
      const before = { status: status(repo), head: git(repo, "rev-parse", "HEAD"), index: readFileSync(join(repo, ".git", "index")) };

      await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });

      expect(status(repo)).toBe(before.status);
      expect(git(repo, "rev-parse", "HEAD")).toBe(before.head);
      expect(readFileSync(join(repo, ".git", "index")).equals(before.index)).toBe(true);
    } finally { cleanup(repo); }
  });

  it("captures untracked files — the reason `git stash create` is not used", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "untracked.txt"), "agent wrote this\n");
      mkdirSync(join(repo, "deep"), { recursive: true });
      writeFileSync(join(repo, "deep", "nested.txt"), "deep\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      const tree = git(repo, "ls-tree", "-r", "--name-only", state.worktreeTree).split("\n").filter(Boolean).sort();
      expect(tree).toContain("untracked.txt");
      expect(tree).toContain("deep/nested.txt");
    } finally { cleanup(repo); }
  });

  it("never captures an ignored file", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "debug.log"), "secrets\n");
      mkdirSync(join(repo, "ignored"), { recursive: true });
      writeFileSync(join(repo, "ignored", "x"), "x\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      const tree = git(repo, "ls-tree", "-r", "--name-only", state.worktreeTree);
      expect(tree).not.toContain("debug.log");
      expect(tree).not.toContain("ignored/x");
    } finally { cleanup(repo); }
  });

  it("captures the executable bit and symlinks", async () => {
    const repo = makeRepo();
    try {
      const script = join(repo, "script.sh");
      writeFileSync(script, "#!/bin/sh\n");
      chmodSync(script, 0o755);
      symlinkSync("tracked.txt", join(repo, "link"));
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      const tree = git(repo, "ls-tree", "-r", state.worktreeTree);
      expect(tree).toMatch(/100755 blob \w+\tscript\.sh/);
      expect(tree).toMatch(/120000 blob \w+\tlink/);
    } finally { cleanup(repo); }
  });

  it("records the staged side separately from the working tree", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\n");
      git(repo, "add", "tracked.txt");
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\nworktree\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      expect(state.indexTree).not.toBe(state.worktreeTree);
      expect(git(repo, "show", `${state.indexTree}:tracked.txt`)).toBe("one\nstaged\n");
      expect(git(repo, "show", `${state.worktreeTree}:tracked.txt`)).toBe("one\nstaged\nworktree\n");
    } finally { cleanup(repo); }
  });

  it("keeps the staged tree reachable from the ref alone", async () => {
    const repo = makeRepo();
    try {
      const id = ids();
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\n");
      git(repo, "add", "tracked.txt");
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\nworktree\n");
      const state = await svc().capture({ cwd: repo, ...id, message: "turn 1" });
      // Nothing but the checkpoint ref names these objects; a prune must not be able to take them.
      git(repo, "reflog", "expire", "--expire=all", "--all");
      git(repo, "gc", "--prune=now", "-q");
      expect(git(repo, "rev-parse", `${checkpointRef(id.environmentId, id.checkpointId)}^{commit}`).trim()).toBe(state.commitSha);
      expect(git(repo, "show", `${state.indexTree}:tracked.txt`)).toBe("one\nstaged\n");
    } finally { cleanup(repo); }
  });

  it("captures the working tree mid-conflict, standing HEAD in for the unwritable index", async () => {
    const repo = makeRepo();
    try {
      git(repo, "checkout", "-q", "-b", "side");
      writeFileSync(join(repo, "tracked.txt"), "side\n");
      git(repo, "commit", "-qam", "side");
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, "tracked.txt"), "main\n");
      git(repo, "commit", "-qam", "main");
      // A conflicted merge leaves unmerged entries, which `git write-tree` refuses outright.
      expect(() => git(repo, "merge", "side")).toThrow();
      expect(git(repo, "status", "--porcelain")).toContain("UU tracked.txt");

      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      // The staged side fell back to HEAD's tree, and the file the user is looking at — conflict
      // markers and all — is what the working tree tree holds.
      expect(state.indexTree).toBe(git(repo, "rev-parse", "HEAD^{tree}").trim());
      expect(git(repo, "show", `${state.worktreeTree}:tracked.txt`)).toContain("<<<<<<<");
    } finally { cleanup(repo); }
  });

  it("works in a repository with no commits and no index file", async () => {
    const repo = makeEmptyRepo();
    try {
      writeFileSync(join(repo, "first.txt"), "hello\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      expect(state.headSha).toBeNull();
      expect(state.headRef).toBe("refs/heads/main");
      expect(git(repo, "ls-tree", "-r", "--name-only", state.worktreeTree).trim()).toBe("first.txt");
    } finally { cleanup(repo); }
  });
});

describe("hazard", () => {
  it("reports nothing to lose when nothing has changed since the checkpoint", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "untracked.txt"), "u\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      const h = await svc().hazard({ cwd: repo, state });
      expect(h).toMatchObject({ filesChanged: 0, commitsRolledBack: 0, headMovable: true });
    } finally { cleanup(repo); }
  });

  it("counts edits, new untracked files and deletions once each", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "keep.txt"), "k\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      writeFileSync(join(repo, "tracked.txt"), "edited\n");   // tracked edit
      writeFileSync(join(repo, "after.txt"), "new\n");        // untracked, postdates the checkpoint
      rmSync(join(repo, "keep.txt"));                         // captured untracked file, now gone
      git(repo, "add", "tracked.txt");                        // also staged: still ONE changed path
      expect((await svc().hazard({ cwd: repo, state })).filesChanged).toBe(3);
    } finally { cleanup(repo); }
  });

  it("counts the commits a restore would roll back", async () => {
    const repo = makeRepo();
    try {
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "agent 1");
      writeFileSync(join(repo, "b.txt"), "b\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "agent 2");
      const h = await svc().hazard({ cwd: repo, state });
      expect(h.commitsRolledBack).toBe(2);
      expect(h.headMovable).toBe(true);
    } finally { cleanup(repo); }
  });

  it("will not move HEAD once the checkout has left the branch it was taken on", async () => {
    const repo = makeRepo();
    try {
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      git(repo, "checkout", "-q", "-b", "other");
      const h = await svc().hazard({ cwd: repo, state });
      expect(h.headMovable).toBe(false);
      expect(h.headReason).toContain("other");
      expect(h.commitsRolledBack).toBe(0);
    } finally { cleanup(repo); }
  });
});

describe("restore", () => {
  it("brings back a captured untracked file the agent deleted", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "notes.md"), "important\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      rmSync(join(repo, "notes.md"));
      await svc().restore({ cwd: repo, state });
      expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("important\n");
    } finally { cleanup(repo); }
  });

  it("removes an untracked file the agent created after the checkpoint", async () => {
    const repo = makeRepo();
    try {
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      writeFileSync(join(repo, "junk.tmp"), "junk\n");
      const outcome = await svc().restore({ cwd: repo, state });
      expect(existsSync(join(repo, "junk.tmp"))).toBe(false);
      expect(outcome.filesRemoved).toBe(1);
    } finally { cleanup(repo); }
  });

  it("leaves ignored files alone in both directions", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "before.log"), "kept\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      writeFileSync(join(repo, "after.log"), "also kept\n");
      await svc().restore({ cwd: repo, state });
      expect(existsSync(join(repo, "before.log"))).toBe(true);
      expect(existsSync(join(repo, "after.log"))).toBe(true);
    } finally { cleanup(repo); }
  });

  it("rolls the branch back over commits the agent made", async () => {
    const repo = makeRepo();
    try {
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "agent 1");
      const outcome = await svc().restore({ cwd: repo, state });
      expect(outcome.headMoved).toBe(true);
      expect(git(repo, "rev-parse", "HEAD").trim()).toBe(state.headSha);
      expect(git(repo, "log", "--oneline")).not.toContain("agent 1");
      expect(existsSync(join(repo, "a.txt"))).toBe(false);
      expect(status(repo)).toBe("");
    } finally { cleanup(repo); }
  });

  it("restores files but not HEAD when the checkout is on another branch", async () => {
    const repo = makeRepo();
    try {
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      git(repo, "checkout", "-q", "-b", "other");
      writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "on other");
      const outcome = await svc().restore({ cwd: repo, state });
      expect(outcome.headMoved).toBe(false);
      // `other` still points at its own commit — restoring must never rewind a branch it never saw.
      expect(git(repo, "log", "--oneline", "other")).toContain("on other");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("other");
      expect(existsSync(join(repo, "a.txt"))).toBe(false); // the files still came back
    } finally { cleanup(repo); }
  });

  it("puts the staged and unstaged halves back where they were", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\n");
      git(repo, "add", "tracked.txt");
      writeFileSync(join(repo, "tracked.txt"), "one\nstaged\nworktree\n");
      writeFileSync(join(repo, "loose.txt"), "untracked\n");
      const before = status(repo);
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });

      git(repo, "add", "-A");
      writeFileSync(join(repo, "tracked.txt"), "destroyed\n");
      rmSync(join(repo, "loose.txt"));

      await svc().restore({ cwd: repo, state });
      expect(status(repo)).toBe(before);
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("one\nstaged\nworktree\n");
      expect(git(repo, "show", ":tracked.txt")).toBe("one\nstaged\n");
      expect(readFileSync(join(repo, "loose.txt"), "utf8")).toBe("untracked\n");
    } finally { cleanup(repo); }
  });

  it("restores the exact file set, exec bit and symlink included", async () => {
    const repo = makeRepo();
    try {
      const script = join(repo, "script.sh");
      writeFileSync(script, "#!/bin/sh\necho hi\n"); chmodSync(script, 0o755);
      symlinkSync("tracked.txt", join(repo, "link"));
      const before = files(repo);
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });

      rmSync(join(repo, "link")); rmSync(script);
      writeFileSync(join(repo, "extra.txt"), "extra\n");

      await svc().restore({ cwd: repo, state });
      expect(files(repo)).toEqual(before);
      expect(statSync(join(repo, "script.sh")).mode & 0o111).toBeTruthy();
      // Restored as a real symlink, not as a file containing the target's name.
      expect(lstatSync(join(repo, "link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repo, "link"))).toBe("tracked.txt");
    } finally { cleanup(repo); }
  });

  it("restores a repository that had no commits when the checkpoint was taken", async () => {
    const repo = makeEmptyRepo();
    try {
      writeFileSync(join(repo, "first.txt"), "hello\n");
      const state = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      rmSync(join(repo, "first.txt"));
      writeFileSync(join(repo, "wrong.txt"), "no\n");
      const outcome = await svc().restore({ cwd: repo, state });
      expect(outcome.headMoved).toBe(false);
      expect(readFileSync(join(repo, "first.txt"), "utf8")).toBe("hello\n");
      expect(existsSync(join(repo, "wrong.txt"))).toBe(false);
    } finally { cleanup(repo); }
  });

  it("is itself undoable when the caller captured the state it overwrote", async () => {
    const repo = makeRepo();
    try {
      const first = await svc().capture({ cwd: repo, ...ids(), message: "turn 1" });
      writeFileSync(join(repo, "work.txt"), "hours of work\n");
      const before = await svc().capture({ cwd: repo, ...ids(), message: "pre-restore" });

      await svc().restore({ cwd: repo, state: first });
      expect(existsSync(join(repo, "work.txt"))).toBe(false);

      await svc().restore({ cwd: repo, state: before });
      expect(readFileSync(join(repo, "work.txt"), "utf8")).toBe("hours of work\n");
    } finally { cleanup(repo); }
  });
});

describe("refs", () => {
  it("lists only this environment's refs and deletes exactly those", async () => {
    const repo = makeRepo();
    try {
      const mine = newId(); const theirs = newId();
      const a = newId(); const b = newId(); const c = newId();
      for (const [env, cp] of [[mine, a], [mine, b], [theirs, c]] as const) {
        await svc().capture({ cwd: repo, environmentId: env, checkpointId: cp, message: "x" });
      }
      expect((await svc().listRefs(repo, mine)).sort()).toEqual([checkpointRef(mine, a), checkpointRef(mine, b)].sort());

      await svc().deleteRefs(repo, await svc().listRefs(repo, mine));
      expect(await svc().listRefs(repo, mine)).toEqual([]);
      expect(await svc().listRefs(repo, theirs)).toEqual([checkpointRef(theirs, c)]);
    } finally { cleanup(repo); }
  });

  it("reports a ref that no longer points at its recorded commit", async () => {
    const repo = makeRepo();
    try {
      const id = ids();
      const state = await svc().capture({ cwd: repo, ...id, message: "turn 1" });
      const ref = checkpointRef(id.environmentId, id.checkpointId);
      expect(await svc().refIntact(repo, ref, state.commitSha)).toBe(true);
      await svc().deleteRefs(repo, [ref]);
      expect(await svc().refIntact(repo, ref, state.commitSha)).toBe(false);
    } finally { cleanup(repo); }
  });

  it("lets git collect the objects once the ref is gone", async () => {
    const repo = makeRepo();
    try {
      const id = ids();
      writeFileSync(join(repo, "only-here.txt"), "unique-checkpoint-content\n");
      const state = await svc().capture({ cwd: repo, ...id, message: "turn 1" });
      rmSync(join(repo, "only-here.txt"));
      await svc().deleteRefs(repo, [checkpointRef(id.environmentId, id.checkpointId)]);

      git(repo, "reflog", "expire", "--expire=all", "--all");
      git(repo, "gc", "--prune=now", "-q");
      expect(() => git(repo, "cat-file", "-e", `${state.commitSha}^{commit}`)).toThrow();
    } finally { cleanup(repo); }
  });
});

describe("worktrees", () => {
  it("checkpoints a worktree without touching its sibling's tree", async () => {
    const repo = makeRepo();
    const wt = tempDir("realm-cp-wt-");
    try {
      rmSync(wt, { recursive: true, force: true }); // git worktree add wants a path that does not exist
      git(repo, "worktree", "add", "-q", "-b", "realm/side", wt, "HEAD");
      writeFileSync(join(wt, "side.txt"), "side\n");
      const state = await svc().capture({ cwd: wt, ...ids(), message: "turn 1" });
      expect(state.headRef).toBe("refs/heads/realm/side");
      expect(git(repo, "ls-tree", "-r", "--name-only", state.worktreeTree)).toContain("side.txt");
      // The ref store is shared, so the main checkout can see the ref — and its own tree is untouched.
      expect(git(repo, "for-each-ref", "--format=%(refname)", `${CHECKPOINT_REF_PREFIX}/`).trim()).not.toBe("");
      expect(existsSync(join(repo, "side.txt"))).toBe(false);
      expect(status(repo)).toBe("");
    } finally { git(repo, "worktree", "remove", "--force", wt); cleanup(repo, wt); }
  });
});
