import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWriteService, compareUrl, parseGitHubRemote } from "./git-write";

/**
 * Real repositories and real BARE repositories acting as remotes. No test in this file may reach a
 * network: a remote is a directory, and `gh` is a shell script written into a temp dir and passed to
 * the service by absolute path — the production default ("gh" on PATH) is never used here.
 */
const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "realm-write-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
/** A bare repository on disk, wired up as `origin`. Push works; nothing leaves the machine. */
function attachRemote(repo: string, name = "origin"): string {
  const bare = mkdtempSync(join(tmpdir(), "realm-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(repo, "remote", "add", name, bare);
  return bare;
}
/** A `gh` that is not gh: a script that prints what the test wants and exits how the test says. */
function stubGh(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "realm-gh-"));
  const path = join(dir, "gh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const staged = (repo: string) => git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
const unstagedNames = (repo: string) => git(repo, "diff", "--name-only").split("\n").filter(Boolean).sort();
const log = (repo: string) => git(repo, "log", "--oneline", "--format=%s").split("\n").filter(Boolean);
/** No gh anywhere: an absolute path to nothing, so the ENOENT branch is what runs. */
const svc = (gh?: string) => new GitWriteService({ ghCommand: gh ?? join(tmpdir(), "realm-no-such-gh") });

describe("stage / unstage", () => {
  it("stages exactly the named file and leaves the other alone", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "one\nA\n");
      writeFileSync(join(repo, "b.txt"), "two\nB\n");
      await svc().stage(repo, ["a.txt"]);
      expect(staged(repo)).toEqual(["a.txt"]);
      expect(unstagedNames(repo)).toEqual(["b.txt"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("stages a file whose name looks like an option", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "--force"), "hi\n");
      await svc().stage(repo, ["--force"]);
      expect(staged(repo)).toEqual(["--force"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("stages a deletion, not just an edit", async () => {
    const repo = makeRepo();
    try {
      rmSync(join(repo, "a.txt"));
      await svc().stage(repo, ["a.txt"]);
      expect(git(repo, "diff", "--cached", "--name-status").trim()).toBe("D\ta.txt");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("unstages one file and leaves the working tree untouched", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "one\nEDIT\n");
      writeFileSync(join(repo, "b.txt"), "two\nEDIT\n");
      git(repo, "add", "-A");
      await svc().unstage(repo, ["a.txt"]);
      expect(staged(repo)).toEqual(["b.txt"]);
      // The whole safety claim of unstage: the edit is still on disk.
      expect(git(repo, "show", ":0:b.txt")).toContain("EDIT");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\nEDIT\n");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("unstages in a repository that has no commits yet", async () => {
    const repo = mkdtempSync(join(tmpdir(), "realm-unborn-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "one\n");
      writeFileSync(join(repo, "b.txt"), "two\n");
      git(repo, "add", "-A");
      // `restore --staged` cannot run here (no HEAD). The file must still come back out of the index,
      // and must still be on disk.
      await svc().unstage(repo, ["a.txt"]);
      expect(git(repo, "status", "--porcelain").trim().split("\n").sort()).toEqual(["?? a.txt", "A  b.txt"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("refuses a path outside the checkout and stages nothing", async () => {
    const repo = makeRepo();
    try {
      await expect(svc().stage(repo, ["../../etc/hosts"])).rejects.toThrow(/leaves the checkout/);
      await expect(svc().stage(repo, ["/etc/hosts"])).rejects.toThrow(/not a path inside/);
      await expect(svc().stage(repo, [])).rejects.toThrow(/no paths/);
      expect(staged(repo)).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("ship — commit", () => {
  it("refuses a whitespace-only message and creates no commit", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "changed\n");
      git(repo, "add", "-A");
      const before = log(repo);
      await expect(svc().ship({ cwd: repo, commit: true, message: "   \n\t ", push: false, setUpstream: false, openPr: false }))
        .rejects.toThrow(/needs a message/);
      expect(log(repo)).toEqual(before);
      expect(staged(repo)).toEqual(["a.txt"]); // and the staging survived the refusal
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("commits the staged file only", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "A\n");
      writeFileSync(join(repo, "b.txt"), "B\n");
      git(repo, "add", "a.txt");
      const r = await svc().ship({ cwd: repo, commit: true, message: "just a", push: false, setUpstream: false, openPr: false });
      expect(r.commit.state).toBe("committed");
      expect(r.commit.subject).toBe("just a");
      expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
      expect(unstagedNames(repo)).toEqual(["b.txt"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("says nothing-to-commit rather than making an empty commit", async () => {
    const repo = makeRepo();
    try {
      const before = log(repo);
      const r = await svc().ship({ cwd: repo, commit: true, message: "nothing here", push: false, setUpstream: false, openPr: false });
      expect(r.commit.state).toBe("nothing-to-commit");
      expect(log(repo)).toEqual(before);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("explains a missing git identity instead of returning git's four paragraphs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "realm-noident-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      // Local config that BLANKS the identity: set to empty, which git treats as absent even when a
      // global identity exists on the machine running the suite.
      execFileSync("git", ["config", "user.email", ""], { cwd: repo });
      execFileSync("git", ["config", "user.name", ""], { cwd: repo });
      writeFileSync(join(repo, "a.txt"), "one\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      const r = await svc().ship({ cwd: repo, commit: true, message: "who am i", push: false, setUpstream: false, openPr: false });
      expect(r.commit.state).toBe("no-identity");
      expect(r.commit.reason).toMatch(/user\.name/);
      expect(r.push.state).toBe("skipped"); // and the failure stopped the chain
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("does not commit at all when commit is false", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "A\n");
      git(repo, "add", "-A");
      const before = log(repo);
      const r = await svc().ship({ cwd: repo, commit: false, message: "", push: false, setUpstream: false, openPr: false });
      expect(r.commit.state).toBe("skipped");
      expect(log(repo)).toEqual(before);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("ship — push", () => {
  it("reports no-remote and does not pretend to have pushed", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "A\n"); git(repo, "add", "-A");
      const r = await svc().ship({ cwd: repo, commit: true, message: "m", push: true, setUpstream: false, openPr: true });
      expect(r.commit.state).toBe("committed");
      expect(r.push.state).toBe("no-remote");
      expect(r.pr).toMatchObject({ state: "skipped", reason: "the branch is not on the remote yet" });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("reports no-upstream and pushes NOTHING until asked again", async () => {
    const repo = makeRepo(); const bare = attachRemote(repo);
    try {
      writeFileSync(join(repo, "a.txt"), "A\n"); git(repo, "add", "-A");
      const r = await svc().ship({ cwd: repo, commit: true, message: "m", push: true, setUpstream: false, openPr: false });
      expect(r.push).toMatchObject({ state: "no-upstream", remote: "origin", branch: "main" });
      // The mutant this kills: a push that "silently does nothing" would look identical from the
      // outcome alone. The remote is the witness — it must still be empty.
      expect(execFileSync("git", ["branch", "--list"], { cwd: bare, encoding: "utf8" }).trim()).toBe("");
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("sets the upstream and pushes when the user says so", async () => {
    const repo = makeRepo(); const bare = attachRemote(repo);
    try {
      writeFileSync(join(repo, "a.txt"), "A\n"); git(repo, "add", "-A");
      const r = await svc().ship({ cwd: repo, commit: true, message: "m", push: true, setUpstream: true, openPr: false });
      expect(r.push).toMatchObject({ state: "pushed", remote: "origin", branch: "main" });
      expect(execFileSync("git", ["log", "--oneline", "--format=%s", "main"], { cwd: bare, encoding: "utf8" }).trim().split("\n")[0]).toBe("m");
      expect(git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").trim()).toBe("origin/main");
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("explains a rejected push instead of forcing it", async () => {
    const repo = makeRepo(); const bare = attachRemote(repo);
    const other = mkdtempSync(join(tmpdir(), "realm-other-"));
    try {
      git(repo, "push", "-u", "origin", "main");
      // Someone else moves the remote on.
      execFileSync("git", [...IDENT, "clone", "-q", bare, other]);
      writeFileSync(join(other, "theirs.txt"), "theirs\n");
      execFileSync("git", [...IDENT, "add", "-A"], { cwd: other });
      execFileSync("git", [...IDENT, "commit", "-qm", "theirs"], { cwd: other });
      execFileSync("git", [...IDENT, "push", "-q"], { cwd: other });

      writeFileSync(join(repo, "mine.txt"), "mine\n"); git(repo, "add", "-A");
      const r = await svc().ship({ cwd: repo, commit: true, message: "mine", push: true, setUpstream: false, openPr: false });
      expect(r.commit.state).toBe("committed");
      expect(r.push.state).toBe("rejected");
      expect(r.push.reason).toMatch(/pull or rebase/);
      // Nothing was forced: their commit is still the remote's tip.
      expect(execFileSync("git", ["log", "--oneline", "--format=%s", "main"], { cwd: bare, encoding: "utf8" }).trim().split("\n")[0]).toBe("theirs");
    } finally { for (const d of [repo, bare, other]) rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses to push a detached HEAD", async () => {
    const repo = makeRepo(); const bare = attachRemote(repo);
    try {
      git(repo, "checkout", "-q", "--detach", "HEAD");
      const r = await svc().ship({ cwd: repo, commit: false, message: "", push: true, setUpstream: true, openPr: false });
      expect(r.push.state).toBe("detached");
      expect(execFileSync("git", ["branch", "--list"], { cwd: bare, encoding: "utf8" }).trim()).toBe("");
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("reports up-to-date rather than pushed when there was nothing new", async () => {
    const repo = makeRepo(); const bare = attachRemote(repo);
    try {
      git(repo, "push", "-u", "origin", "main");
      const r = await svc().ship({ cwd: repo, commit: false, message: "", push: true, setUpstream: false, openPr: false });
      expect(r.push.state).toBe("up-to-date");
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });
});

/**
 * The PR path needs a remote whose ADDRESS is a GitHub URL (so the compare URL is real) but whose
 * pushes land in a directory. `remote set-url --push` gives exactly that: `git push` uses the push
 * URL, `git remote get-url` still reports the fetch URL, and github.com is never contacted.
 */
function attachGitHubLookalike(repo: string, address = "https://github.com/acme/widgets.git"): string {
  const bare = mkdtempSync(join(tmpdir(), "realm-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(repo, "remote", "add", "origin", address);
  git(repo, "remote", "set-url", "--push", "origin", bare);
  return bare;
}

describe("ship — pull request", () => {
  it("creates a request through gh and returns its URL", async () => {
    const repo = makeRepo(); const bare = attachGitHubLookalike(repo);
    const gh = stubGh(`case "$1 $2" in
  "pr view") exit 1 ;;
  "pr create") echo "https://github.com/acme/widgets/pull/7"; exit 0 ;;
esac
exit 1`);
    try {
      writeFileSync(join(repo, "a.txt"), "A\n"); git(repo, "add", "-A");
      const r = await svc(gh).ship({ cwd: repo, commit: true, message: "Add a thing\n\nwhy", push: true, setUpstream: true, openPr: true });
      expect(r.push.state).toBe("pushed");
      expect(r.pr).toMatchObject({ state: "created", url: "https://github.com/acme/widgets/pull/7" });
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("reports an existing request instead of opening a second one", async () => {
    const repo = makeRepo(); const bare = attachGitHubLookalike(repo);
    const marker = join(bare, "gh-create-ran");
    const gh = stubGh(`case "$1 $2" in
  "pr view") echo '{"url":"https://github.com/acme/widgets/pull/3"}'; exit 0 ;;
  "pr create") touch ${marker}; exit 0 ;;
esac`);
    try {
      git(repo, "push", "-u", "origin", "main:main");
      const r = await svc(gh).ship({ cwd: repo, commit: false, message: "", push: true, setUpstream: false, openPr: true });
      expect(r.pr).toMatchObject({ state: "existing", url: "https://github.com/acme/widgets/pull/3" });
      expect(existsSync(marker), "gh pr create must not run when one already exists").toBe(false);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("degrades to a compare URL when gh is not installed", async () => {
    const repo = makeRepo(); const bare = attachGitHubLookalike(repo);
    try {
      git(repo, "push", "-u", "origin", "main:main");
      const r = await svc().ship({ cwd: repo, commit: false, message: "", push: true, setUpstream: false, openPr: true });
      expect(r.push.state).toBe("up-to-date");
      expect(r.pr.state).toBe("compare");
      expect(r.pr.url).toBe("https://github.com/acme/widgets/compare/main...main?expand=1");
      expect(r.pr.reason).toMatch(/gh is not installed/);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("falls back to a compare URL when gh is present but refuses", async () => {
    const repo = makeRepo(); const bare = attachGitHubLookalike(repo, "git@github.com:acme/widgets.git");
    const gh = stubGh(`echo "gh: not logged in" >&2; exit 4`);
    try {
      git(repo, "push", "-u", "origin", "main:main");
      const r = await svc(gh).ship({ cwd: repo, commit: false, message: "", push: true, setUpstream: false, openPr: true });
      expect(r.pr.state).toBe("compare");
      expect(r.pr.url).toBe("https://github.com/acme/widgets/compare/main...main?expand=1");
      expect(r.pr.reason).toMatch(/not logged in/);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });

  it("says so, with no URL, when the remote is not GitHub", async () => {
    const repo = makeRepo(); const bare = attachRemote(repo);
    try {
      git(repo, "push", "-u", "origin", "main:main");
      const r = await svc().ship({ cwd: repo, commit: false, message: "", push: true, setUpstream: false, openPr: true });
      expect(r.pr).toMatchObject({ state: "unavailable", url: null });
      expect(r.pr.reason).toMatch(/not a GitHub remote/);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });
});

describe("parseGitHubRemote", () => {
  it("reads every address form GitHub hands out", () => {
    for (const url of [
      "https://github.com/acme/widgets.git", "https://github.com/acme/widgets",
      "git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git",
      "https://token@github.com/acme/widgets.git", "https://github.com/acme/widgets/",
    ]) expect(parseGitHubRemote(url), url).toEqual({ owner: "acme", repo: "widgets" });
  });
  it("refuses a host that merely contains github.com", () => {
    expect(parseGitHubRemote("https://github.com.evil.example/acme/widgets.git")).toBeNull();
    expect(parseGitHubRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(parseGitHubRemote("/srv/git/widgets.git")).toBeNull();
  });
});

describe("compareUrl", () => {
  it("encodes a branch name that would otherwise truncate the URL", () => {
    expect(compareUrl({ owner: "acme", repo: "widgets" }, "main", "feat/a#b"))
      .toBe("https://github.com/acme/widgets/compare/main...feat/a%23b?expand=1");
  });
});
