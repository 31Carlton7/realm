import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The structural half of W2's "computed in exactly one place" rule (the plan's rule 4): the raw state
 * every effective set derives from — the per-space settings keys and the scope map — is readable by
 * exactly ONE source file per system, its service. A second reader would be a second place the
 * profile/space math could be (re)implemented, which is exactly how a panel and the wire start
 * disagreeing. Same for the computation's entry point: one definition, so a "convenience" copy of the
 * merge can't grow next to it.
 *
 * A grep, on purpose (the plan blesses it): the type system cannot see string keys, and an import
 * graph can't stop someone re-deriving `mcp.enabled:${spaceId}` by hand.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

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

describe("scoping state has exactly one reader per system (W2 rule 4)", () => {
  // The template-literal key builders — matching the backtick form, not the bare prefix, so doc
  // comments that MENTION a key (migrations.ts explains them) don't count as readers.
  it.each([
    ["skills disabled-set", "`skills.disabled:${", "skills/service.ts"],
    ["skills scope map", '"skills.scope"', "skills/service.ts"],
    ["mcp enabled-set", "`mcp.enabled:${", "mcp/service.ts"],
    ["mcp inherited-disable overrides", "`mcp.profileDisabled:${", "mcp/service.ts"],
    ["mcp provider disables", "`mcp.providersDisabled:${", "mcp/service.ts"],
    ["memory profile-doc toggle", "`memory.profileDocDisabled:${", "memory/service.ts"],
  ])("%s: only its service touches the key", (_what, needle, owner) => {
    expect(filesMentioning(needle)).toEqual([owner]);
  });

  it.each([
    ["MCP effective set", "effectiveServerIds(spaceId: string): string[]", "mcp/service.ts"],
    ["memory effective docs", "effective(spaceId: string): { profile:", "memory/service.ts"],
    // Skills' effective set IS `list()` — its key check above pins the state; this pins the scope map
    // resolution (the only other ingredient) to the same file via `scopeMap`.
    ["skills scope resolution", "private scopeMap()", "skills/service.ts"],
  ])("%s: exactly one definition site", (_what, needle, owner) => {
    expect(filesMentioning(needle)).toEqual([owner]);
  });
});
