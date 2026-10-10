import { describe, expect, it } from "vitest";
import { ClaudeDirSchema, claudeLoginHint, claudeLoginLine, tildePath } from "./claude-home";
import { AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS } from "./presets";

describe("the line that signs Claude Code in to a folder", () => {
  it("is the table's own command for the default folder, so nothing changes where no folder is named", () => {
    expect(claudeLoginLine(null)).toBe(AGENT_CLI_COMMANDS.claude.login);
  });

  it("sets a named folder through env, a program, which a shell function called claude cannot overwrite", () => {
    expect(claudeLoginLine("/Users/mara/.claude-work")).toBe("env CLAUDE_CONFIG_DIR='/Users/mara/.claude-work' claude auth login");
  });

  it("keeps a folder with a space and a quote in its name one shell word", () => {
    expect(claudeLoginLine("/Users/mara/Claude's work")).toBe(`env CLAUDE_CONFIG_DIR='/Users/mara/Claude'\\''s work' claude auth login`);
  });

  it("runs the copy Realm carries by its quoted path, with a folder and without one", () => {
    expect(claudeLoginLine(null, "/opt/my tools/claude")).toBe("'/opt/my tools/claude' auth login");
    expect(claudeLoginLine("/Users/mara/.claude-work", "/opt/my tools/claude")).toBe("env CLAUDE_CONFIG_DIR='/Users/mara/.claude-work' '/opt/my tools/claude' auth login");
  });
});

describe("the sentence beside that line", () => {
  it("is the table's own for the default folder, and says where the login is kept for a named one", () => {
    expect(claudeLoginHint(null)).toBe(AGENT_LOGIN_HINTS.claude);
    expect(claudeLoginHint("/Users/mara/.claude-work")).toBe("Uses the `claude` login kept in /Users/mara/.claude-work. Sign in there if sessions fail to authenticate.");
  });
});

describe("a profile's Claude config folder on the wire", () => {
  it("carries the named folder, the one in force, whether the named one is gone, what overrides it, and whether any folder is named", () => {
    const answer = { dir: "/Users/mara/.claude-work", inForce: "/Users/mara/.claude-work", missing: false, override: null, anyNamed: true };
    expect(ClaudeDirSchema.parse(answer)).toEqual(answer);
    expect(ClaudeDirSchema.parse({ dir: null, inForce: "/Users/mara/.claude", missing: false, override: "ANTHROPIC_API_KEY", anyNamed: false }).override).toBe("ANTHROPIC_API_KEY");
    expect(ClaudeDirSchema.safeParse({ dir: null, inForce: "/Users/mara/.claude", missing: false, anyNamed: false }).success).toBe(false);
    expect(ClaudeDirSchema.safeParse({ dir: null, inForce: "/Users/mara/.claude", missing: false, override: null }).success).toBe(false);
  });
});

describe("a path as a person writes it", () => {
  it("writes the home folder as ~, and a folder under it from there", () => {
    expect(tildePath("/Users/mara", "/Users/mara")).toBe("~");
    expect(tildePath("/Users/mara/.claude-work", "/Users/mara")).toBe("~/.claude-work");
  });

  it("leaves a path outside the home folder as it is, a neighbour with the same start included", () => {
    expect(tildePath("/opt/claude", "/Users/mara")).toBe("/opt/claude");
    expect(tildePath("/Users/mara-work/.claude", "/Users/mara")).toBe("/Users/mara-work/.claude");
  });

  it("leaves every path as it is where the home folder is not known", () => {
    for (const home of [null, undefined, ""]) expect(tildePath("/Users/mara/.claude-work", home)).toBe("/Users/mara/.claude-work");
  });
});
