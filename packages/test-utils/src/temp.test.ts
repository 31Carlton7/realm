import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The structural half of `tempDir` — the same grep discipline delegation/structure.test.ts uses, for
 * the same reason: nothing in the type system stops the next test file reaching for `mkdtemp` again,
 * and one that does leaks silently. A green suite is not evidence of cleanup, so the enforcement has
 * to be on the call site rather than on the outcome.
 *
 * The scan deliberately covers test files only. Production code (workspace/checkpoints.ts) and the
 * hand-run live scripts create scratch directories outside any vitest lifecycle and remove them on
 * their own exit paths; they have no `afterAll` to hang cleanup on.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = "packages/test-utils/src/temp.test.ts";
const SKIP = new Set(["node_modules", "dist", "out", ".git", "fixtures"]);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...testFiles(p)); continue; }
    if (/\.test\.(ts|tsx|mts|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

const suite = ["apps", "packages", "scripts"]
  .flatMap((d) => testFiles(join(ROOT, d)))
  .map((p) => relative(ROOT, p))
  .filter((p) => p !== SELF)
  .sort();

describe("temp directories go through tempDir", () => {
  it("finds the suite it is meant to police", () => {
    // A scan that silently matched nothing would pass forever, and a path shape that stopped lining
    // up with what the filter reads would matter just as much as the count.
    expect(suite.length).toBeGreaterThan(200);
    expect(suite).toContain("apps/server/src/sessions/fork.test.ts");
  });

  it("no test file calls mkdtemp itself", () => {
    const offenders = suite.filter((p) => readFileSync(join(ROOT, p), "utf8").includes("mkdtemp"));
    expect(offenders).toEqual([]);
  });

  it("tempDir has exactly one implementation", () => {
    const defined = suite
      .concat("packages/test-utils/src/temp.ts")
      .filter((p) => /function tempDir\b/.test(readFileSync(join(ROOT, p), "utf8")));
    expect(defined).toEqual(["packages/test-utils/src/temp.ts"]);
  });
});
