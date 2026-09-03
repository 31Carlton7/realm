import { describe, it, expect } from "vitest";
import { decodeClaudeProjectSlug, defaultRoots, isScratchPath } from "./sources";

describe("isScratchPath", () => {
  it("catches both the /var and /private/var spellings macOS hands out", () => {
    expect(isScratchPath("/var/folders/14/x/T/realm-live-workspace")).toBe(true);
    expect(isScratchPath("/private/var/folders/14/x/T/realm-live-workspace")).toBe(true);
    expect(isScratchPath("/tmp/scratch")).toBe(true);
    expect(isScratchPath("/private/tmp/scratch")).toBe(true);
  });

  it("leaves real working directories alone", () => {
    expect(isScratchPath("/Users/me/Projects/realm")).toBe(false);
    expect(isScratchPath("/Users/me/Realm/work/versed")).toBe(false);
  });

  it("does not mistake a same-prefixed name for a temp directory", () => {
    // `/tmpfiles` is not under `/tmp`; a plain `startsWith` would say it was.
    expect(isScratchPath("/tmpfiles/work")).toBe(false);
    expect(isScratchPath("/var/folders-of-mine")).toBe(false);
  });

  it("treats an absent or relative cwd as scratch — there is nothing to match a space on", () => {
    expect(isScratchPath("")).toBe(true);
    expect(isScratchPath("relative/path")).toBe(true);
  });
});

describe("decodeClaudeProjectSlug", () => {
  // The slug is lossy: `/` and `-` both encode as `-`. The decode resolves it against a real tree,
  // longest-run-first, which is the only way to tell the two apart.
  const tree: Record<string, string[]> = {
    "/": ["Users"],
    "/Users": ["me"],
    "/Users/me": ["Desktop", "Realm"],
    "/Users/me/Desktop": ["Home"],
    "/Users/me/Desktop/Home": ["School", "Work"],
    "/Users/me/Desktop/Home/School": ["SP26-EE-451"],
    "/Users/me/Desktop/Home/Work": ["Projects"],
    "/Users/me/Desktop/Home/Work/Projects": ["realm", "realm-worktrees", "personal-website"],
    "/Users/me/Desktop/Home/Work/Projects/realm-worktrees": ["durable-runs"],
  };
  const childrenOf = (dir: string): string[] => tree[dir] ?? [];

  it("recovers a path whose own segment contains dashes", () => {
    // The failing case from real data: a shortest-first walk commits to `School/SP26`, which does
    // not exist, and can never recover to find the real child `SP26-EE-451`.
    expect(decodeClaudeProjectSlug("-Users-me-Desktop-Home-School-SP26-EE-451", childrenOf))
      .toBe("/Users/me/Desktop/Home/School/SP26-EE-451");
  });

  it("prefers the longest real child, so a dashed directory beats a nested reading", () => {
    expect(decodeClaudeProjectSlug("-Users-me-Desktop-Home-Work-Projects-personal-website", childrenOf))
      .toBe("/Users/me/Desktop/Home/Work/Projects/personal-website");
  });

  it("still descends when a dashed name is a real directory with real children", () => {
    expect(decodeClaudeProjectSlug("-Users-me-Desktop-Home-Work-Projects-realm-worktrees-durable-runs", childrenOf))
      .toBe("/Users/me/Desktop/Home/Work/Projects/realm-worktrees/durable-runs");
  });

  it("resolves the plain case with no ambiguity at all", () => {
    expect(decodeClaudeProjectSlug("-Users-me-Desktop-Home-Work-Projects-realm", childrenOf))
      .toBe("/Users/me/Desktop/Home/Work/Projects/realm");
  });

  it("returns null for a directory that is gone rather than inventing a path", () => {
    expect(decodeClaudeProjectSlug("-Users-me-Desktop-Home-Work-Projects-deleted", childrenOf)).toBeNull();
    expect(decodeClaudeProjectSlug("not-a-slug", childrenOf)).toBeNull();
  });
});

describe("defaultRoots", () => {
  it("honours the CLIs' own config-directory overrides", () => {
    const before = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
    try {
      process.env.CLAUDE_CONFIG_DIR = "/elsewhere/claude";
      process.env.CODEX_HOME = "/elsewhere/codex";
      const r = defaultRoots("/Users/me");
      expect(r.claude).toBe("/elsewhere/claude");
      expect(r.codex).toBe("/elsewhere/codex");
      expect(r.cursor).toBe("/Users/me/.cursor");
    } finally {
      if (before.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before.c;
      if (before.x === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before.x;
    }
  });

  it("looks for cross-agent skill folders as well as the per-CLI ones", () => {
    const before = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
    try {
      delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
      const r = defaultRoots("/Users/me");
      expect(r.extraSkillDirs).toContain("/Users/me/.agents/skills");
      expect(r.extraSkillDirs).toContain("/Users/me/.gemini/skills");
    } finally {
      if (before.c !== undefined) process.env.CLAUDE_CONFIG_DIR = before.c;
      if (before.x !== undefined) process.env.CODEX_HOME = before.x;
    }
  });
});
