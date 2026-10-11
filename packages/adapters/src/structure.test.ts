import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where an adapter may tell its harness that a person sent a message, held to by reading the source
 * as text, the way `apps/server/src/delegation/structure.test.ts` holds its own rules.
 *
 * Claude Code acts on a message marked as a person's own input in ways it acts on no other message,
 * and the mark is one object literal. Nothing in the types stops a second place writing it: a helper
 * that builds a message, another adapter that learns the same wire. The Claude adapter writes it in
 * one function, under the three conditions that function states, and a copy anywhere else would
 * carry none of them.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "fixtures") out.push(...sourceFiles(p)); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Files (relative to src/) whose text holds `needle`, comments included. */
function filesMentioning(needle: string): string[] {
  return sourceFiles(SRC)
    .filter((p) => readFileSync(p, "utf8").includes(needle))
    .map((p) => relative(SRC, p))
    .sort();
}

describe("the mark of a person's own input", () => {
  it("reads the source of every adapter, so that a rule about all of them is a rule about all of them", () => {
    expect(sourceFiles(SRC).map((p) => relative(SRC, p))).toEqual(expect.arrayContaining(["acp/acp-adapter.ts", "claude/claude-adapter.ts", "codex/codex-adapter.ts", "fake/fake-adapter.ts", "types.ts"]));
  });

  it("is written in the Claude adapter and in no other source file", () => {
    expect(filesMentioning('kind: "human"')).toEqual(["claude/claude-adapter.ts"]);
  });
});
