import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The structural half of "one place says which Claude config folder" — the grep discipline
 * `scoping.test.ts` uses, for its reason: the type system cannot see a string, and nothing else
 * stops the next reader of `~/.claude` from working the folder out for itself.
 *
 * That is how every profile came to run on one account. Each place that started Claude, read its
 * files or asked whether it was signed in resolved the folder from the server's own environment,
 * and each was right on its own. A profile can now name its folder (`ClaudeHomes`), and a new
 * reader that skips the resolver would quietly put that profile back on the default account.
 *
 * So each spelling of "the Claude folder" may appear only in the files listed beside it. A file is
 * listed because it is the resolver, or because it reads the default folder on purpose:
 *
 *  - `memory/claude-files.ts` defines the default folder for a service built without the resolver,
 *    and names a project's own `.claude` folder, which is no config folder.
 *  - `memory/service.ts` and `commands/service.ts` fall back to that default; a session's folder
 *    reaches both as an argument.
 *  - `import/sources.ts` scans the default folder only. Conversations kept under a named folder
 *    are not offered for import.
 *  - `skills/discovery.ts` finds skills and plugins under the home folder's `.claude`, the same
 *    set for every profile.
 *
 * A failure here is a question, not a typo to allow: does the new line need the session's folder?
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "fixtures") out.push(...sourceFiles(p)); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("test-utils.ts")) out.push(p);
  }
  return out;
}

/** Files (relative to src/) whose CODE mentions `needle`. */
function filesMentioning(needle: string): string[] {
  return sourceFiles(SRC)
    .filter((p) => readFileSync(p, "utf8").includes(needle))
    .map((p) => relative(SRC, p))
    .sort();
}

describe("one place says which Claude config folder", () => {
  it.each([
    ["the server's own variable", "process.env.CLAUDE_CONFIG_DIR", ["import/sources.ts", "memory/claude-files.ts"]],
    ["an import of the default folder's helper", "claudeUserDir }", ["commands/service.ts", "memory/service.ts"]],
    ["the home folder's .claude", '".claude"', ["agents/claude-homes.ts", "import/sources.ts", "memory/claude-files.ts", "skills/discovery.ts"]],
    ["the variable a process is handed", "CLAUDE_CONFIG_DIR:", ["agents/claude-homes.ts"]],
  ])("%s is spelled only where it is meant to be", (_what, needle, owners) => {
    expect(filesMentioning(needle)).toEqual(owners);
  });

  it("the session service asks the resolver for the variable, and for the folder, once per start", () => {
    const text = readFileSync(join(SRC, "sessions/service.ts"), "utf8");
    expect(text).toContain("...this.d.claudeHomes?.envFor(home)");
    expect(text.split("this.startHome(s)").length - 1).toBe(1);
    expect(text.split("homes.ofSession(s)").length - 1).toBe(1);
  });
});
