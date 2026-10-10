import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The adapters' half of "one place says which Claude config folder". The server's resolver is that
 * place (`ClaudeHomes`), and `claude-homes.source.test.ts` beside it holds the server to it with
 * this same grep.
 *
 * Nothing in this package decides a folder. A process runs under the folder in the environment it
 * is handed, and Realm's own one-shot calls take theirs as an argument. A line here that read the
 * server's own `CLAUDE_CONFIG_DIR`, or joined the home folder with `.claude`, would answer for the
 * default account whichever profile asked.
 *
 * `claude/probe.ts` is the one file that names `.claude`. Where the CLI is too old to say whether
 * it is signed in, the probe looks for a credentials file, and it looks in the folder of the
 * environment it was given before it falls back to the home folder's.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "fixtures") out.push(...sourceFiles(p)); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Files (relative to src/) whose text mentions `needle`. */
function filesMentioning(needle: string): string[] {
  return sourceFiles(SRC)
    .filter((p) => readFileSync(p, "utf8").includes(needle))
    .map((p) => relative(SRC, p))
    .sort();
}

describe("no adapter works out a Claude config folder for itself", () => {
  it.each([
    ["the server's own variable", "process.env.CLAUDE_CONFIG_DIR", []],
    ["the home folder's .claude", '".claude"', ["claude/probe.ts"]],
  ])("%s is spelled only where it is meant to be", (_what, needle, owners) => {
    expect(filesMentioning(needle)).toEqual(owners);
  });

  it("reads the folder of a probe from the environment the probe was given", () => {
    const text = readFileSync(join(SRC, "claude/probe.ts"), "utf8");
    expect(text).toContain('env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")');
  });
});
