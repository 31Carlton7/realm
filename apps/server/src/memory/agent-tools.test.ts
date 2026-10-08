import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MEMORY_PROVIDER_NAME, createMemoryAgentProvider } from "./agent-tools";
import { MemoryRepoService } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const ctx = { sessionId: SESSION, spaceId: SPACE };

function harness() {
  const home = tempDir("realm-memtools-");
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const disabled = new Set<string>();
  const enabled = (spaceId: string, name: string) => !disabled.has(`${spaceId}:${name}`);
  const repos = new MemoryRepoService({
    home, settings, scopes: { profileIdOf: () => PROFILE }, committerName: async () => "T", today: () => "2026-10-08",
    toolsEnabled: (spaceId) => enabled(spaceId, MEMORY_PROVIDER_NAME),
  });
  const changed: string[] = [];
  const provider = createMemoryAgentProvider({ repos, mcp: { providerEnabled: enabled }, onChanged: (p) => changed.push(p) });
  return { repos, provider, disabled, changed };
}

const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

describe("realm-memory provider", () => {
  it("lists no tools until the profile has a repo", async () => {
    const { repos, provider } = harness();
    // THE MUTANT: list the tools unconditionally — every session in every space is handed six tools
    // for a repo that does not exist, and its tool list changes for a user who never asked.
    expect(await provider.tools(ctx)).toEqual([]);
    expect((await provider.call(ctx, "memory_index", {})).isError).toBe(true);
    await repos.create(PROFILE);
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual(
      ["memory_index", "memory_read", "memory_search", "memory_save", "memory_remove", "memory_write_file"]);
  });

  it("hides the tools in a space that turned the provider off", async () => {
    const { repos, provider, disabled } = harness();
    await repos.create(PROFILE);
    disabled.add(`${SPACE}:${MEMORY_PROVIDER_NAME}`);
    expect(await provider.tools(ctx)).toEqual([]);
    expect(text(await provider.call(ctx, "memory_save", { entry: "x" }))).toMatch(/disabled for this space/);
  });

  it("saves with the calling session as the source, then recalls it", async () => {
    const { repos, provider, changed } = harness();
    const { path } = await repos.create(PROFILE);
    const saved = await provider.call(ctx, "memory_save", { entry: "Prefers tabs" });
    expect(saved.isError).toBe(false);
    expect(text(saved)).toMatch(/^Saved MEMORY\.md: - Prefers tabs \(commit [0-9a-f]{7}\)\.$/);
    expect(readFileSync(join(path, "MEMORY.md"), "utf8")).toContain(`- Prefers tabs [source: realm:session/${SESSION}; added: 2026-10-08]`);
    expect(changed).toEqual([PROFILE]);
    expect(text(await provider.call(ctx, "memory_index", {}))).toContain("Prefers tabs");
    expect(text(await provider.call(ctx, "memory_search", { query: "tabs" }))).toMatch(/^MEMORY\.md:3: - Prefers tabs/);
    // Saying it twice changes nothing and makes no commit.
    expect(text(await provider.call(ctx, "memory_save", { entry: "Prefers tabs" }))).toMatch(/Already in MEMORY\.md/);
    expect(changed).toEqual([PROFILE]);
  });

  it("updates in place, writes topic files, and removes", async () => {
    const { repos, provider } = harness();
    const { path } = await repos.create(PROFILE);
    await provider.call(ctx, "memory_save", { entry: "Deploys on Friday", file: "[[ops/deploys]]" });
    expect(text(await provider.call(ctx, "memory_save", { entry: "Deploys on Thursday", file: "ops/deploys", replaces: "Deploys on Friday" }))).toMatch(/^Updated ops\/deploys\.md/);
    expect(text(await provider.call(ctx, "memory_read", { path: "[[ops/deploys]]" }))).toContain("Deploys on Thursday");
    await provider.call(ctx, "memory_write_file", { path: "ops/rollback.sh", content: "git revert HEAD\n" });
    expect(readFileSync(join(path, "MEMORY.md"), "utf8")).toContain("- [[ops/rollback.sh]]");
    expect(text(await provider.call(ctx, "memory_remove", { entry: "Thursday", file: "ops/deploys" }))).toMatch(/^Removed ops\/deploys\.md/);
    expect(readFileSync(join(path, "ops", "deploys.md"), "utf8")).not.toContain("Thursday");
  });

  it("hands a dirty repo back as an error the agent can act on", async () => {
    const { repos, provider } = harness();
    const { path } = await repos.create(PROFILE);
    writeFileSync(join(path, "draft.md"), "unfinished");
    const r = await provider.call(ctx, "memory_save", { entry: "Prefers tabs" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/uncommitted changes.*draft\.md/);
    expect(readFileSync(join(path, "MEMORY.md"), "utf8")).not.toContain("Prefers tabs");
  });

  it("refuses arguments it does not know rather than ignoring them", async () => {
    const { repos, provider } = harness();
    await repos.create(PROFILE);
    expect(text(await provider.call(ctx, "memory_save", { entry: "x", force: true }))).toMatch(/invalid arguments/);
  });
});
