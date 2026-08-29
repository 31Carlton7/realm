import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_MAX_FILES, FILE_DIFF_MAX_LINES, GitDiffService, parseNumstat, parseStatus, parsePatch, statusOf } from "./git-diff";

/**
 * Real repositories throughout. Porcelain's `-z` framing, rename detection, `--numstat`'s empty path
 * field for renames and "Binary files … differ" are all behaviours of the git binary; a fake would
 * agree with whatever this parser happens to do, which is the failure this suite exists to prevent.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "realm-diff-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "b.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const svc = () => new GitDiffService();
const byPath = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe("statusOf", () => {
  it("reads the worktree letter over the index letter when both changed", () => {
    // "MD" is staged-modified then deleted on disk. Calling it "modified" would offer to open a file
    // that is not there.
    expect(statusOf("M", "D")).toBe("deleted");
    expect(statusOf("M", " ")).toBe("modified");
    expect(statusOf("A", " ")).toBe("added");
  });
  it("names every unmerged combination git defines as conflicted", () => {
    for (const [x, y] of [["D", "D"], ["A", "U"], ["U", "D"], ["U", "A"], ["D", "U"], ["A", "A"], ["U", "U"]]) {
      expect(statusOf(x!, y!), `${x}${y}`).toBe("conflicted");
    }
  });
});

describe("parseNumstat", () => {
  it("takes the NEW path of a rename, not the old one and not the empty field", () => {
    // The exact bytes git emits: counts, an EMPTY path, then old and new.
    expect(parseNumstat("1\t1\t\0old.txt\0new.txt\0")).toEqual([["new.txt", { additions: 1, deletions: 1, binary: false }]]);
  });
  it("reports a binary file as binary with zero counts, not NaN", () => {
    expect(parseNumstat("-\t-\tbin.dat\0")).toEqual([["bin.dat", { additions: 0, deletions: 0, binary: true }]]);
  });
  it("keeps a path containing a tab intact", () => {
    expect(parseNumstat("2\t0\tweird\tname.txt\0")).toEqual([["weird\tname.txt", { additions: 2, deletions: 0, binary: false }]]);
  });
});

describe("parseStatus", () => {
  it("consumes the rename's origin field instead of reading it as another file", () => {
    // Two records: a rename (which carries an extra NUL field) and an ordinary modification. A parser
    // that forgets to skip the origin invents a third file called "a.txt".
    const files = parseStatus("R  new.txt\0a.txt\0 M b.txt\0", new Map());
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "new.txt", oldPath: "a.txt", status: "renamed", staged: true, unstaged: false });
    expect(files[1]).toMatchObject({ path: "b.txt", oldPath: null, staged: false, unstaged: true });
  });
  it("marks a file that is both staged and edited again as both", () => {
    const [f] = parseStatus("MM a.txt\0", new Map());
    expect(f).toMatchObject({ staged: true, unstaged: true });
  });
  it("never calls an untracked file staged", () => {
    const [f] = parseStatus("?? new.txt\0", new Map());
    expect(f).toMatchObject({ status: "untracked", staged: false, unstaged: true });
  });
});

describe("summary", () => {
  it("returns null outside a repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-nodiff-"));
    try { expect(await svc().summary(dir)).toBeNull(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports each file's side of the index separately", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "one\ntwo\nCHANGED\n");
      git(dir, "add", "a.txt");
      writeFileSync(join(dir, "b.txt"), "x\ny\n");
      writeFileSync(join(dir, "c.txt"), "fresh\n");
      const s = (await svc().summary(dir))!;
      expect(byPath(s.files)).toEqual(["a.txt", "b.txt", "c.txt"]);
      expect(s.files.find((f) => f.path === "a.txt")).toMatchObject({ staged: true, unstaged: false, status: "modified" });
      expect(s.files.find((f) => f.path === "b.txt")).toMatchObject({ staged: false, unstaged: true });
      expect(s.files.find((f) => f.path === "c.txt")).toMatchObject({ staged: false, unstaged: true, status: "untracked" });
      expect(s.branch).toBe("main");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sums a file's staged and unstaged counts rather than reporting one side", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n"); // +1 staged
      git(dir, "add", "a.txt");
      writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n"); // +1 more, unstaged
      const s = (await svc().summary(dir))!;
      expect(s.files.find((f) => f.path === "a.txt")).toMatchObject({ additions: 2, deletions: 0, staged: true, unstaged: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("lists the files inside an untracked directory, not the directory", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "sub", "deep"), { recursive: true });
      writeFileSync(join(dir, "sub", "one.txt"), "1\n");
      writeFileSync(join(dir, "sub", "deep", "two.txt"), "2\n");
      const s = (await svc().summary(dir))!;
      expect(byPath(s.files)).toEqual(["sub/deep/two.txt", "sub/one.txt"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("marks a binary file binary and gives it no line counts", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]));
      git(dir, "add", "bin.dat");
      const s = (await svc().summary(dir))!;
      expect(s.files.find((f) => f.path === "bin.dat")).toMatchObject({ binary: true, additions: 0, deletions: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("answers about the CHECKOUT, not the subdirectory it was asked from", async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "s.txt"), "s\n");
      writeFileSync(join(dir, "b.txt"), "x\ny\n");
      const s = (await svc().summary(join(dir, "sub")))!;
      // Both files, both named from the root — a session whose cwd is a subdirectory must not see a
      // half tree, and must not get paths that only resolve relative to that subdirectory.
      expect(byPath(s.files)).toEqual(["b.txt", "sub/s.txt"]);
      expect(s.root).toBe(git(dir, "rev-parse", "--show-toplevel").trim());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("caps the file list but still reports the true total", async () => {
    const dir = makeRepo();
    try {
      for (let i = 0; i < DIFF_MAX_FILES + 5; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
      const s = (await svc().summary(dir))!;
      expect(s.files).toHaveLength(DIFF_MAX_FILES);
      expect(s.totalFiles).toBe(DIFF_MAX_FILES + 5 + 0);
      expect(s.truncated).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("survives a repository with no commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-empty-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "first.txt"), "hello\n");
      const s = (await svc().summary(dir))!;
      expect(byPath(s.files)).toEqual(["first.txt"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("file", () => {
  it("gives the staged and unstaged sides of one file DIFFERENT patches", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "one\ntwo\nSTAGED\n");
      git(dir, "add", "a.txt");
      writeFileSync(join(dir, "a.txt"), "one\ntwo\nWORKING\n");
      const staged = await svc().file(dir, "a.txt", true);
      const unstaged = await svc().file(dir, "a.txt", false);
      const added = (d: { hunks: { lines: { kind: string; text: string }[] }[] }) =>
        d.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").map((l) => l.text);
      expect(added(staged)).toEqual(["STAGED"]);
      expect(added(unstaged)).toEqual(["WORKING"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads an untracked file as its whole content added", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "new.txt"), "alpha\nbeta\n");
      const d = await svc().file(dir, "new.txt", false);
      expect(d.binary).toBe(false);
      expect(d.hunks.flatMap((h) => h.lines).map((l) => [l.kind, l.text])).toEqual([["add", "alpha"], ["add", "beta"]]);
      expect(d.additions).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("numbers lines so a hunk starting mid-file is not renumbered from 1", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "long.txt"), Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
      git(dir, "add", "-A"); git(dir, "commit", "-qm", "long");
      const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
      lines[19] = "CHANGED";
      writeFileSync(join(dir, "long.txt"), lines.join("\n") + "\n");
      const d = await svc().file(dir, "long.txt", false);
      const del = d.hunks.flatMap((h) => h.lines).find((l) => l.kind === "del")!;
      const add = d.hunks.flatMap((h) => h.lines).find((l) => l.kind === "add")!;
      expect(del).toMatchObject({ text: "line20", oldLine: 20, newLine: null });
      expect(add).toMatchObject({ text: "CHANGED", oldLine: null, newLine: 20 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns a binary file with no hunks rather than its bytes", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
      git(dir, "add", "bin.dat");
      const d = await svc().file(dir, "bin.dat", true);
      expect(d).toMatchObject({ binary: true, hunks: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("truncates a huge patch instead of returning it whole", async () => {
    const dir = makeRepo();
    try {
      const huge = Array.from({ length: FILE_DIFF_MAX_LINES + 500 }, (_, i) => `row ${i}`).join("\n") + "\n";
      writeFileSync(join(dir, "huge.txt"), huge);
      const d = await svc().file(dir, "huge.txt", false);
      expect(d.truncated).toBe(true);
      expect(d.truncatedReason).toBeTruthy();
      expect(d.hunks.flatMap((h) => h.lines).length).toBeLessThanOrEqual(FILE_DIFF_MAX_LINES);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a path that leaves the checkout", async () => {
    const dir = makeRepo();
    try {
      await expect(svc().file(dir, "../outside.txt", false)).rejects.toThrow(/leaves the checkout/);
      await expect(svc().file(dir, "/etc/hosts", false)).rejects.toThrow(/not a path inside/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("never runs a .gitattributes textconv driver while showing a file", async () => {
    // A hostile checkout's own config naming a command git would run to *display* a file. The proof
    // is negative and has to be: the command writes a file, and that file must not exist.
    const dir = makeRepo();
    const canary = join(dir, "PWNED");
    try {
      writeFileSync(join(dir, ".gitattributes"), "*.secret diff=eviltextconv\n");
      git(dir, "config", "diff.eviltextconv.textconv", `sh -c 'touch ${canary}; cat'`);
      writeFileSync(join(dir, "x.secret"), "before\n");
      git(dir, "add", "-A"); git(dir, "commit", "-qm", "attrs");
      writeFileSync(join(dir, "x.secret"), "after\n");
      const d = await svc().file(dir, "x.secret", false);
      expect(d.hunks.flatMap((h) => h.lines).some((l) => l.kind === "add")).toBe(true);
      expect(existsSync(canary)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("parsePatch", () => {
  it("keeps `\\ No newline at end of file` out of the line numbering", async () => {
    const patch = [
      "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt",
      "@@ -1,2 +1,2 @@", " one", "-two", "\\ No newline at end of file", "+TWO", "",
    ].join("\n");
    const d = parsePatch("a.txt", false, patch, false);
    const kinds = d.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "del", "meta", "add"]);
    // The meta line must not have advanced either counter: the addition is still new line 2.
    expect(d.hunks[0]!.lines.at(-1)).toMatchObject({ newLine: 2 });
  });

  it("drops the ---/+++ header so a rename is not read as a whole-file rewrite", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt", "similarity index 90%", "rename from old.txt", "rename to new.txt",
      "--- a/old.txt", "+++ b/new.txt", "@@ -1 +1 @@", "-a", "+b", "",
    ].join("\n");
    const d = parsePatch("new.txt", true, patch, false);
    expect(d.oldPath).toBe("old.txt");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
  });

  it("treats a one-line hunk header without a count as one line", () => {
    const d = parsePatch("a", false, ["@@ -3 +3 @@", "-x", "+y", ""].join("\n"), false);
    expect(d.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
  });
});
