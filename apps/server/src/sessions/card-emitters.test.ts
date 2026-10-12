import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "fixtures") out.push(...sourceFiles(p)); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("test-utils.ts")) out.push(p);
  }
  return out;
}

const read = (file: string): string => readFileSync(join(REPO, file), "utf8");

/**
 * Every source file that builds a `permission_request`, which is every place a card is born.
 * `reviewerAsksNobody` is enforced where a card is born and nowhere else, so a file that starts to
 * build one is a place a reviewer could wait on a person. The list fails then, until its author has
 * decided how the rule applies there and has added the file.
 */
const CARD_EMITTERS = ["packages/adapters/src", "apps/server/src"]
  .flatMap((root) => sourceFiles(join(REPO, root)))
  .filter((p) => readFileSync(p, "utf8").includes('sessionEvent("permission_request"'))
  .map((p) => relative(REPO, p))
  .sort();

describe("the places a card is born", () => {
  it("are the Claude and Codex adapters and the broker, which ask the reviewer rule, and the ACP and scripted adapters, which do not", () => {
    expect(CARD_EMITTERS).toEqual([
      "apps/server/src/browsers/permissions.ts",
      "packages/adapters/src/acp/acp-adapter.ts",
      "packages/adapters/src/claude/claude-adapter.ts",
      "packages/adapters/src/codex/codex-adapter.ts",
      "packages/adapters/src/fake/fake-adapter.ts",
    ]);
  });

  it.each([
    ["the Claude adapter", "packages/adapters/src/claude/claude-adapter.ts", "reviewerAsksNobody(opts.reviewer === true, this.kind, permissionMode)"],
    ["the Codex adapter", "packages/adapters/src/codex/codex-adapter.ts", "reviewerAsksNobody(opts.reviewer === true, this.kind, permissionMode)"],
    ["the broker", "apps/server/src/browsers/permissions.ts", "this.d.asksNobody?.(sessionId)"],
    ["the broker's wiring", "apps/server/src/app.ts", "asksNobody: (sessionId) => asksNobody(sessionsStore, sessionId)"],
  ])("%s asks the one rule, with the mode the session is in when the card would go up", (_what, file, call) => {
    expect(read(file)).toContain(call);
  });
});
