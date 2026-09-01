import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The structural half of Plan 13 W1's "extract, don't fork" rule — the same grep discipline
 * scoping.test.ts uses, for the same reason: the type system cannot stop someone pasting a second
 * copy of the settle loop into one tool "for now". The cancelled-wins ordering in that loop was a
 * live-found bug once; a fork is how it comes back in exactly one of the two tools.
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

describe("one settle/drain implementation (Plan 13 W1)", () => {
  // The drain loop's two distinctive lines: the settle condition and the cancelled-wins return.
  // Either one appearing in a second source file means the engine was forked.
  it.each([
    ["the settle condition", 'lastStatus === "idle" && finalText !== null'],
    ["the cancelled-wins return", 'if (run.cancelled) return { outcome: "interrupted"'],
    ["the run registry", "new Map<string, ActiveRun>"],
  ])("%s lives only in the engine", (_what, needle) => {
    expect(filesMentioning(needle)).toEqual(["delegation/engine.ts"]);
  });

  it("both delegation tools consume the ONE engine rather than rolling their own wait", () => {
    for (const tool of ["browsers/browser-agent.ts", "delegation/agent-run.ts"]) {
      const text = readFileSync(join(SRC, tool), "utf8");
      expect(text).toMatch(/from "\.\.?\/(delegation\/)?engine"/);
      expect(text).toContain("engine.drain(");
      // No private polling loop: the tools never sleep-and-re-read session events themselves.
      expect(text).not.toContain("setTimeout");
    }
  });
});
