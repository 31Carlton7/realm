import { describe, expect, it } from "vitest";
import { createReadStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { AGENT_MODELS } from "@realm/contracts";

/**
 * Every curated Claude model id must be one the bundled CLI can actually route.
 *
 * `AGENT_MODELS.claude` is hand-written (see the comment on it) because no channel Realm reads
 * carries a Claude catalog. The cost of that is a failure mode with no symptom: the API answers a
 * model the bundled binary predates with `400 Claude Code X does not support this model`, and the
 * session quietly runs something else. It has happened — `claude-fable-5-1` shipped needing a newer
 * SDK than the pin, and picking it fell back to another model with nothing said.
 *
 * The rule was written down in three comments and enforced by none of them, which is why adding
 * `claude-opus-5-5` against the old floor would have reproduced the same bug. This is the check:
 * the ids Realm offers, against the binary a packaged app actually spawns.
 *
 * Read from `apps/server` deliberately. Its copy of the SDK is the one that matters at runtime — a
 * packaged app resolves the platform binary from `Contents/Resources/server/node_modules`, not from
 * `packages/adapters` — and the two floors are meant to move together.
 */

/**
 * The platform binary the SDK spawns, resolved through the SDK's own entry point.
 *
 * Not through `<pkg>/package.json` — the SDK's `exports` map refuses that subpath — and not by
 * globbing `.pnpm`, which holds every version ever installed and would happily answer with the old
 * one this check exists to catch.
 *
 * `null` only when the SDK itself will not resolve. A resolvable SDK whose platform binary is
 * missing is a broken install, and the test says so rather than skipping.
 */
function sdkDir(): string | null {
  try {
    // `createRequire` because this file is ESM and the resolution has to follow pnpm's real layout
    // rather than a guessed path. A test, never bundled — server SOURCE must not import this.
    return dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
  } catch {
    return null;
  }
}

function platformBinary(dir: string): string {
  return join(dir, "..", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
}

/** Whether the binary contains this exact id, read in chunks — it is ~210 MB and must not be
 *  loaded whole. The overlap is one id's width, so a string straddling a chunk boundary is found. */
async function binaryKnows(path: string, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const overlap = Math.max(...ids.map((i) => i.length));
  let tail = "";
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      const text = tail + chunk.toString("latin1");
      for (const id of ids) if (!found.has(id) && text.includes(id)) found.add(id);
      if (found.size === ids.length) { stream.destroy(); resolve(); return; }
      tail = text.slice(-overlap);
    });
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
    stream.on("error", reject);
  });
  return found;
}

describe("the curated Claude models against the bundled CLI", () => {
  const dir = sdkDir();

  it.skipIf(dir === null)("offers no model the bundled binary cannot route", async () => {
    const ids = AGENT_MODELS.claude.map((m) => m.id);
    expect(ids.length, "the curated list is empty — this check would pass vacuously").toBeGreaterThan(0);

    const binary = platformBinary(dir!);
    // A silent skip here would be a check that never runs again, which is how the rule got lost the
    // first time. If the SDK resolved, its binary for this platform is supposed to be beside it.
    expect(existsSync(binary), `the SDK resolved but ${binary} is missing — broken install`).toBe(true);

    const known = await binaryKnows(binary, ids);
    const missing = ids.filter((id) => !known.has(id));
    expect(
      missing,
      `${missing.join(", ")} not found in the bundled claude binary. A model id the binary predates is ` +
      "answered with a 400 and falls back to another model silently — raise the " +
      "@anthropic-ai/claude-agent-sdk floor in BOTH apps/server and packages/adapters to a version " +
      "that knows it, or drop the row.",
    ).toEqual([]);
  });

  it("keeps the two floors in step, because only one of them is the one that ships", async () => {
    /* THE DRIFT MUTANT: bump `packages/adapters` alone. Types and tests resolve the new SDK, every
       check passes, and the packaged app still spawns the old binary from its own copy — so the
       model works everywhere except the build a user installs. */
    const read = async (p: string) =>
      JSON.parse(await (await import("node:fs/promises")).readFile(join(import.meta.dirname, "../../../..", p), "utf8"));
    const server = await read("apps/server/package.json");
    const adapters = await read("packages/adapters/package.json");
    expect(adapters.dependencies["@anthropic-ai/claude-agent-sdk"])
      .toBe(server.dependencies["@anthropic-ai/claude-agent-sdk"]);
  });
});
