import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import {
  GREP_MAX_LINE, GREP_MAX_PER_FILE, ProjectSearchService,
  isCaseSensitive, lineSegments, parseGrepOutput,
} from "./grep";
import type { GitResult, GitRun } from "./git-exec";

/**
 * Real repositories throughout. `--untracked` honouring `.gitignore`, `-I` refusing a binary, `-F`
 * taking a regex metacharacter literally and `--max-count` capping per file are all behaviours of
 * the git binary — a fake would agree with whatever this service happened to do, which is the
 * failure these tests exist to prevent. The one fake is the argv assertion at the bottom, which is
 * about the flags we send and nothing else.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const dir = tempDir("realm-grep-");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "src", "deep"));
  writeFileSync(join(dir, "src", "a.ts"), "const alpha = 1;\nexport function beta() {}\n// BETA in a comment\n");
  writeFileSync(join(dir, "src", "deep", "b.ts"), "import { beta } from '../a';\n");
  writeFileSync(join(dir, "README.md"), "# Project\n\nNothing matching here.\n");
  // Two lines that a literal search tells apart and a regex search does not: in git's default basic
  // regular expressions, `.` matches any character.
  writeFileSync(join(dir, "dots.txt"), "a.b is literal\naxb is not\n");
  writeFileSync(join(dir, "bundle.min.js"), `${"x".repeat(5000)}beta${"y".repeat(5000)}\n`);
  writeFileSync(join(dir, "noisy.log"), "beta\n".repeat(20));
  writeFileSync(join(dir, "logo.bin"), Buffer.from([0x00, 0x01, 0x62, 0x65, 0x74, 0x61, 0x00]));
  writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
  writeFileSync(join(dir, "secret.txt"), "beta lives here too\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "src", "fresh.ts"), "// beta, written by an agent and never committed\n");
  return dir;
}

const svc = () => new ProjectSearchService();
const paths = (hits: { path: string }[]) => [...new Set(hits.map((h) => h.path))].sort();
const plain = (segments: { text: string }[]) => segments.map((s) => s.text).join("");
const marked = (segments: { text: string; match: boolean }[]) => segments.filter((s) => s.match).map((s) => s.text);

describe("parseGrepOutput", () => {
  it("reads path, 1-based line and text out of the NUL framing", () => {
    expect(parseGrepOutput("src/a.ts\u00002\u0000export function beta() {}\n")).toEqual([
      { path: "src/a.ts", line: 2, text: "export function beta() {}" },
    ]);
  });
  it("keeps a path containing a colon intact", () => {
    // The reason for `-z` at all: `path:line:text` is ambiguous the moment a path has a colon in it.
    expect(parseGrepOutput("we:ird/b.txt\u00001\u0000beta\n")[0]!.path).toBe("we:ird/b.txt");
  });
  it("keeps a path containing a NEWLINE intact", () => {
    // `-z` does not quote, so splitting the stream into lines first breaks this record in half.
    expect(parseGrepOutput("we\nird.txt\u00007\u0000beta\n")).toEqual([{ path: "we\nird.txt", line: 7, text: "beta" }]);
  });
  it("drops git's own prose about a binary file rather than reading it as a hit", () => {
    // Without `-I` git prints this line instead of a NUL-framed record. It has no line number and no
    // content, so a parser that accepted anything would invent a hit at line NaN in a PNG.
    expect(parseGrepOutput("Binary file logo.bin matches\n")).toEqual([]);
  });
  it("drops a record whose line number is not a line number", () => {
    expect(parseGrepOutput("a.ts\u0000zero\u0000text\n")).toEqual([]);
  });
  it("drops a record the byte cap cut in half", () => {
    const cut = "a.ts\u00001\u0000fine\nb.ts\u00002\u0000truncated mid-";
    expect(parseGrepOutput(cut)).toEqual([{ path: "a.ts", line: 1, text: "fine" }]);
  });
  it("returns nothing for empty output", () => {
    expect(parseGrepOutput("")).toEqual([]);
  });
});

describe("isCaseSensitive", () => {
  it("is smart case: a capital in the query means that capital", () => {
    expect(isCaseSensitive("beta")).toBe(false);
    expect(isCaseSensitive("Beta")).toBe(true);
    expect(isCaseSensitive("beta()")).toBe(false);
  });
});

describe("lineSegments", () => {
  it("marks every occurrence and reconstructs the line exactly", () => {
    const s = lineSegments("beta and beta again", "beta", false);
    expect(plain(s)).toBe("beta and beta again");
    expect(marked(s)).toEqual(["beta", "beta"]);
  });
  it("marks case-insensitively when the query is lowercase", () => {
    expect(marked(lineSegments("// BETA in a comment", "beta", false))).toEqual(["BETA"]);
  });
  it("marks nothing that disagrees in case when the query has a capital", () => {
    expect(marked(lineSegments("beta", "Beta", true))).toEqual([]);
  });
  it("clips a minified line to a window around the match", () => {
    // The 40 MB bundle, in miniature: one line, the match in the middle. Nothing near the width of
    // the original may reach the wire.
    const line = `${"x".repeat(5000)}beta${"y".repeat(5000)}`;
    const s = lineSegments(line, "beta", false);
    expect(plain(s).length).toBeLessThanOrEqual(GREP_MAX_LINE + 2); // + the two ellipses
    expect(marked(s)).toEqual(["beta"]);
    expect(s[0]).toEqual({ text: "…", match: false });
    expect(s.at(-1)).toEqual({ text: "…", match: false });
  });
  it("keeps a match near the end of a long line visible", () => {
    const line = `${"x".repeat(5000)}beta`;
    expect(marked(lineSegments(line, "beta", false))).toEqual(["beta"]);
  });
  it("adds no ellipsis to a line that already fits", () => {
    expect(lineSegments("short beta line", "beta", false).map((s) => s.text)).not.toContain("…");
  });
});

describe("ProjectSearchService.grep", () => {
  it("finds matches in tracked files with cwd-relative paths and 1-based lines", async () => {
    const hits = (await svc().grep(makeRepo(), "alpha")).hits;
    expect(hits).toEqual([{ path: "src/a.ts", line: 1, segments: [{ text: "const ", match: false }, { text: "alpha", match: true }, { text: " = 1;", match: false }] }]);
  });
  it("finds a file an agent wrote and never committed", async () => {
    // The whole reason for `--untracked`: the file you are looking for is usually the newest one.
    expect(paths((await svc().grep(makeRepo(), "written by an agent")).hits)).toEqual(["src/fresh.ts"]);
  });
  it("never returns an ignored file", async () => {
    // `.gitignore` is the reason to shell out to git rather than walk. A mutant that drops
    // `--exclude-standard`/`--untracked` semantics shows `secret.txt` here.
    expect(paths((await svc().grep(makeRepo(), "beta")).hits)).not.toContain("secret.txt");
  });
  it("never returns a binary file", async () => {
    expect(paths((await svc().grep(makeRepo(), "beta")).hits)).not.toContain("logo.bin");
  });
  it("caps the matches taken from any one file and says it did", async () => {
    const res = await svc().grep(makeRepo(), "beta");
    expect(res.hits.filter((h) => h.path === "noisy.log")).toHaveLength(GREP_MAX_PER_FILE);
    expect(res.truncated).toBe(true);
  });
  it("honours a total limit and reports the truncation", async () => {
    const res = await svc().grep(makeRepo(), "beta", { limit: 2 });
    expect(res.hits).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });
  it("is smart case", async () => {
    const repo = makeRepo();
    const loose = await svc().grep(repo, "beta");
    const strict = await svc().grep(repo, "BETA");
    expect(loose.hits.some((h) => plain(h.segments).includes("BETA"))).toBe(true);
    expect(strict.hits.every((h) => marked(h.segments).every((m) => m === "BETA"))).toBe(true);
    expect(strict.hits.length).toBeLessThan(loose.hits.length);
  });
  it("treats a regex metacharacter as text", async () => {
    // `-F`. Git's default is basic regular expressions, where `.` is any character — so without the
    // flag this query also matches "axb", and a palette search starts returning lines the user
    // cannot see their query in.
    const hits = (await svc().grep(makeRepo(), "a.b")).hits;
    expect(hits.map((h) => h.line)).toEqual([1]);
    expect(hits[0]!.segments.filter((s) => s.match).map((s) => s.text)).toEqual(["a.b"]);
  });
  it("does not let a query that looks like a bracket expression match anything else", async () => {
    expect((await svc().grep(makeRepo(), "[ab]")).hits).toEqual([]);
  });
  it("scopes to the directory it was given, not to the repository root", async () => {
    const repo = makeRepo();
    expect(paths((await svc().grep(join(repo, "src", "deep"), "beta")).hits)).toEqual(["b.ts"]);
  });
  it("answers an empty query with nothing rather than with everything", async () => {
    expect(await svc().grep(makeRepo(), "   ")).toEqual({ hits: [], truncated: false, source: "git" });
  });
  it("says nothing matched without claiming truncation", async () => {
    expect(await svc().grep(makeRepo(), "nosuchstringanywhere")).toEqual({ hits: [], truncated: false, source: "git" });
  });
  it("refuses a relative cwd", async () => {
    await expect(svc().grep("src", "beta")).rejects.toThrow(/absolute/);
  });
});

describe("ProjectSearchService.listFiles", () => {
  it("lists tracked and untracked files, and no ignored or git-internal ones", async () => {
    const res = await svc().listFiles(makeRepo());
    expect(res.source).toBe("git");
    expect(res.truncated).toBe(false);
    expect([...res.paths].sort()).toEqual([
      ".gitignore", "README.md", "bundle.min.js", "dots.txt", "logo.bin", "noisy.log",
      "src/a.ts", "src/deep/b.ts", "src/fresh.ts",
    ]);
  });
  it("scopes to the directory it was given", async () => {
    expect((await svc().listFiles(join(makeRepo(), "src"))).paths.sort()).toEqual(["a.ts", "deep/b.ts", "fresh.ts"]);
  });
});

describe("ProjectSearchService.files", () => {
  it("ranks the checkout's file names against the fragment", async () => {
    const res = await svc().files(makeRepo(), "fresh");
    expect(res.source).toBe("git");
    expect(res.hits[0]!.path).toBe("src/fresh.ts");
    expect(res.hits[0]!.segments.filter((s) => s.match).map((s) => s.text).join("")).toBe("fresh");
  });
  it("returns nothing for a fragment no path contains", async () => {
    expect((await svc().files(makeRepo(), "zzzznope")).hits).toEqual([]);
  });
  it("honours the limit", async () => {
    expect((await svc().files(makeRepo(), "s", 2)).hits).toHaveLength(2);
  });
  it("ranks the walk's list the same way when there is no repository", async () => {
    const dir = tempDir("realm-grep-files-plain-");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "handler.ts"), "x");
    const res = await svc().files(dir, "handler");
    expect(res.source).toBe("walk");
    expect(res.hits.map((h) => h.path)).toEqual(["src/handler.ts"]);
  });
});

describe("the not-a-repository fallback", () => {
  function makePlainDir(): string {
    const dir = tempDir("realm-grep-plain-");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "const alpha = 1;\nbeta\n");
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "beta everywhere\n");
    writeFileSync(join(dir, "logo.bin"), Buffer.from([0x00, 0x62, 0x65, 0x74, 0x61]));
    writeFileSync(join(dir, ".hidden"), "beta\n");
    return dir;
  }

  it("says which search ran rather than passing a walk off as a git search", async () => {
    const res = await svc().grep(makePlainDir(), "beta");
    expect(res.source).toBe("walk");
    expect(paths(res.hits)).toEqual(["src/a.ts"]);
    expect(res.hits[0]!.line).toBe(2);
  });
  it("skips build directories, dotfiles and binaries it cannot gitignore its way out of", async () => {
    const res = await svc().grep(makePlainDir(), "beta");
    expect(paths(res.hits)).not.toContain("node_modules/dep/index.js");
    expect(paths(res.hits)).not.toContain("logo.bin");
  });
  it("lists files the same way", async () => {
    const res = await svc().listFiles(makePlainDir());
    expect(res.source).toBe("walk");
    expect(res.paths.sort()).toEqual(["logo.bin", "src/a.ts"]);
  });
});

describe("the argv Realm actually sends", () => {
  function capture(): { calls: string[][]; git: GitRun } {
    const calls: string[][] = [];
    const git: GitRun = async (_cwd, args): Promise<GitResult> => {
      calls.push(args);
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    return { calls, git };
  }

  it("passes the bounds and the literal-text flags, with the query behind -e", async () => {
    const { calls, git } = capture();
    await new ProjectSearchService({ git }).grep("/tmp/x", "-oh no");
    const argv = calls.at(-1)!;
    expect(argv).toContain("-F");        // a palette query is text, not a regex
    expect(argv).toContain("-I");        // never a binary file
    expect(argv).toContain("-z");        // paths may contain colons and newlines
    expect(argv).toContain("--untracked");
    expect(argv).toContain(`--max-count=${GREP_MAX_PER_FILE}`);
    // The query must arrive as a query even when it looks exactly like an option.
    expect(argv[argv.indexOf("-e") + 1]).toBe("-oh no");
    expect(argv.at(-1)).toBe("--");
  });
  it("drops -i only when the query carries a capital", async () => {
    const { calls, git } = capture();
    const s = new ProjectSearchService({ git });
    await s.grep("/tmp/x", "beta");
    expect(calls.at(-1)).toContain("-i");
    await s.grep("/tmp/x", "Beta");
    expect(calls.at(-1)).not.toContain("-i");
  });
  it("reports a git failure instead of an empty result", async () => {
    const git: GitRun = async (_cwd, args) => args.includes("--is-inside-work-tree")
      ? { code: 0, stdout: "true\n", stderr: "" }
      : { code: 128, stdout: "", stderr: "fatal: bad object\n" };
    // Exit 1 means "no matches" and is an answer; anything else is not, and returning [] for it
    // would claim the checkout does not contain the word.
    await expect(new ProjectSearchService({ git }).grep("/tmp/x", "beta")).rejects.toThrow(/128/);
  });
});
