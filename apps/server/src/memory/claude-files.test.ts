import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { claudeMemoryFiles, parseImports } from "./claude-files";

const scratch = () => tempDir("realm-claude-files-");
const write = (dir: string, name: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
};

describe("parseImports", () => {
  it("finds @path tokens at line start and after whitespace", () => {
    expect(parseImports("@docs/a.md then see @./b.md\nplain line\n @~/c.md")).toEqual(["docs/a.md", "./b.md", "~/c.md"]);
  });

  it("does not mistake an email or scoped package for an import", () => {
    // No whitespace before the @: the CLI does not treat these as imports and neither may the model.
    expect(parseImports("mail carlton@charmtechnologies.co about @anthropic-ai/sdk")).toEqual(["anthropic-ai/sdk"]);
    expect(parseImports("carlton@charmtechnologies.co")).toEqual([]);
  });

  it("skips fenced code blocks, matching the CLI", () => {
    const text = "@real.md\n```\n@fenced.md\n```\n@after.md\n~~~\n@tilde-fenced.md\n~~~\n";
    expect(parseImports(text)).toEqual(["real.md", "after.md"]);
  });
});

describe("claudeMemoryFiles", () => {
  it("models the hierarchy in the CLI's order: user file, then ancestors root-first, then cwd", () => {
    const root = scratch();
    const userDir = join(root, "claude-home");
    const repo = join(root, "repo");
    const sub = join(repo, "sub");
    write(userDir, "CLAUDE.md", "user memory");
    write(repo, "CLAUDE.md", "repo memory");
    write(sub, "CLAUDE.md", "sub memory");

    const files = claudeMemoryFiles(sub, userDir);
    // The walk legitimately passes through the scratch dir's own ancestors; only ours are asserted on.
    const existing = files.filter((f) => f.exists && f.path.startsWith(root)).map((f) => [f.path, f.origin]);
    expect(existing).toEqual([
      [join(userDir, "CLAUDE.md"), "user"],
      [join(repo, "CLAUDE.md"), "project"],
      [join(sub, "CLAUDE.md"), "project"],
    ]);
  });

  it("lists the two well-known locations even when absent, and no other absent candidates", () => {
    const root = scratch();
    const userDir = join(root, "claude-home");
    const cwd = join(root, "empty");
    mkdirSync(cwd, { recursive: true });
    const files = claudeMemoryFiles(cwd, userDir).filter((f) => f.path.startsWith(root));
    expect(files.map((f) => [f.path, f.exists])).toEqual([
      [join(userDir, "CLAUDE.md"), false],
      [join(cwd, "CLAUDE.md"), false],
    ]);
  });

  it("reads .claude/CLAUDE.md and CLAUDE.local.md variants when they exist", () => {
    const root = scratch();
    const cwd = join(root, "repo");
    write(join(cwd, ".claude"), "CLAUDE.md", "dot memory");
    write(cwd, "CLAUDE.local.md", "local memory");
    const files = claudeMemoryFiles(cwd, join(root, "claude-home"));
    const existing = files.filter((f) => f.exists && f.path.startsWith(root)).map((f) => f.path);
    expect(existing).toEqual([join(cwd, ".claude", "CLAUDE.md"), join(cwd, "CLAUDE.local.md")]);
  });

  it("follows @imports relative to the importing file, tagging them as imports", () => {
    const root = scratch();
    const cwd = join(root, "repo");
    write(cwd, "CLAUDE.md", "see @docs/extra.md");
    write(join(cwd, "docs"), "extra.md", "imported memory");
    const files = claudeMemoryFiles(cwd, join(root, "claude-home"));
    const imported = files.find((f) => f.origin === "import");
    expect(imported).toMatchObject({ path: join(cwd, "docs", "extra.md"), exists: true, content: "imported memory" });
    // Listed right after its importer, mirroring read order.
    expect(files.findIndex((f) => f.path === join(cwd, "CLAUDE.md"))).toBeLessThan(files.indexOf(imported!));
  });

  it("drops import mentions that do not resolve to a file (prose @words)", () => {
    const root = scratch();
    const cwd = join(root, "repo");
    write(cwd, "CLAUDE.md", "ping @alice about @missing/file.md");
    const files = claudeMemoryFiles(cwd, join(root, "claude-home"));
    expect(files.filter((f) => f.origin === "import")).toEqual([]);
  });

  it("stops at 4 hops and survives an import cycle", () => {
    const root = scratch();
    const cwd = join(root, "repo");
    // CLAUDE.md -> a -> b -> c -> d -> e ; e is hop 5 and must not be read. b also re-imports a (cycle).
    write(cwd, "CLAUDE.md", "@a.md");
    write(cwd, "a.md", "@b.md");
    write(cwd, "b.md", "@c.md and back @a.md");
    write(cwd, "c.md", "@d.md");
    write(cwd, "d.md", "@e.md");
    write(cwd, "e.md", "too deep");
    const paths = claudeMemoryFiles(cwd, join(root, "claude-home")).map((f) => f.path);
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) expect(paths).toContain(join(cwd, name));
    expect(paths).not.toContain(join(cwd, "e.md"));
    expect(paths.filter((p) => p === join(cwd, "a.md"))).toHaveLength(1);
  });

  it("resolves @~/ imports against the home directory shape (never listing a miss)", () => {
    const root = scratch();
    const cwd = join(root, "repo");
    write(cwd, "CLAUDE.md", "@~/definitely-not-a-real-realm-test-file.md");
    const files = claudeMemoryFiles(cwd, join(root, "claude-home"));
    expect(files.filter((f) => f.origin === "import")).toEqual([]);
  });
});
