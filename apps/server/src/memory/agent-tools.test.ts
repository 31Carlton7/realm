import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MEMORY_PROVIDER_NAME, createMemoryAgentProvider } from "./agent-tools";
import { INDEX_LINE_MAX, INDEX_WARN_CHARS, INDEX_WARN_LINES } from "./context-budget";
import { MemoryRepoService } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const ctx = { sessionId: SESSION, spaceId: SPACE };
const P = { scope: "profile", id: PROFILE } as const;

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
  const provider = createMemoryAgentProvider({ repos, mcp: { providerEnabled: enabled }, onChanged: (o) => changed.push(o.id) });
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
    await repos.create(P);
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual(
      ["memory_index", "memory_read", "memory_search", "memory_save", "memory_remove", "memory_write_file"]);
  });

  it("hides the tools in a space that turned the provider off", async () => {
    const { repos, provider, disabled } = harness();
    await repos.create(P);
    disabled.add(`${SPACE}:${MEMORY_PROVIDER_NAME}`);
    expect(await provider.tools(ctx)).toEqual([]);
    expect(text(await provider.call(ctx, "memory_save", { entry: "x" }))).toMatch(/disabled for this space/);
  });

  it("saves with the calling session as the source, then recalls it", async () => {
    const { repos, provider, changed } = harness();
    const { path } = await repos.create(P);
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
    const { path } = await repos.create(P);
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
    const { path } = await repos.create(P);
    writeFileSync(join(path, "draft.md"), "unfinished");
    const r = await provider.call(ctx, "memory_save", { entry: "Prefers tabs" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/uncommitted changes.*draft\.md/);
    expect(readFileSync(join(path, "MEMORY.md"), "utf8")).not.toContain("Prefers tabs");
  });

  it("refuses arguments it does not know rather than ignoring them", async () => {
    const { repos, provider } = harness();
    await repos.create(P);
    expect(text(await provider.call(ctx, "memory_save", { entry: "x", force: true }))).toMatch(/invalid arguments/);
  });

  it("lifts the calling space's own folder above the same fact in another space's", async () => {
    const { repos, provider } = harness();
    await repos.create(P);
    const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
    const fact = { name: "deploy-day", description: "Deploys go out on Fridays", type: "project", body: "Deploys go out on Fridays." } as const;
    await repos.saveSpaceMemory(SPACE, fact);
    await repos.saveSpaceMemory(OTHER, fact);
    const mine = repos.spaceFolderFor(SPACE)!.folder;
    const theirs = repos.spaceFolderFor(OTHER)!.folder;
    expect(mine).not.toBe(theirs);
    // THE MUTANT: pass no preference — the two folders tie and either may lead.
    const here = text(await provider.call(ctx, "memory_search", { query: "deploys fridays" })).split("\n");
    expect(here[0]).toMatch(new RegExp(`^spaces/${mine}/`));
    expect(here.some((l) => l.startsWith(`spaces/${theirs}/`))).toBe(true);
    const there = text(await provider.call({ ...ctx, spaceId: OTHER }, "memory_search", { query: "deploys fridays" })).split("\n");
    expect(there[0]).toMatch(new RegExp(`^spaces/${theirs}/`));
  });

  it("with a space repo beside the profile's: writes go to the space's unless told, reads find either", async () => {
    const { repos, provider, changed } = harness();
    const prof = (await repos.create(P)).path;
    const S = { scope: "space", id: SPACE } as const;
    const team = (await repos.create(S)).path;
    // THE MUTANT: order `activeFor` profile-first — a team fact lands in the user's private memory.
    expect(text(await provider.call(ctx, "memory_save", { entry: "Deploys go through the release train" })))
      .toMatch(/^Saved MEMORY\.md in the space memory repo: /);
    expect(readFileSync(join(team, "MEMORY.md"), "utf8")).toContain("Deploys go through the release train");
    expect(readFileSync(join(prof, "MEMORY.md"), "utf8")).not.toContain("release train");
    await provider.call(ctx, "memory_save", { entry: "Prefers tabs", file: "prefs", repo: "profile" });
    expect(readFileSync(join(prof, "prefs.md"), "utf8")).toContain("Prefers tabs");
    expect(changed).toEqual([SPACE, PROFILE]);
    // A link from the profile's index resolves without naming the repo: the space's is tried first.
    expect(text(await provider.call(ctx, "memory_read", { path: "[[prefs]]" }))).toContain("Prefers tabs");
    expect(text(await provider.call(ctx, "memory_search", { query: "tabs" }))).toMatch(/^\[profile\] prefs\.md:3: - Prefers tabs/);
    // One ranking across both repos: the better hit leads whichever repo it is in — here the
    // profile's, though the space's repo is searched first. THE MUTANT: concatenate per repo.
    await provider.call(ctx, "memory_save", { entry: "The release train leaves on Mondays" });
    const ranked = text(await provider.call(ctx, "memory_search", { query: "prefers tabs release" })).split("\n");
    expect(ranked[0]).toMatch(/^\[profile\] prefs\.md:3: - Prefers tabs/);
    expect(ranked.filter((l) => /^\[space\] MEMORY\.md:\d+: - .*release train/.test(l))).toHaveLength(2);
    expect(text(await provider.call(ctx, "memory_search", { query: "release", repo: "space" }))).not.toContain("[profile]");
    const both = text(await provider.call(ctx, "memory_index", {}));
    expect(both).toContain(`The space memory repo at ${team}`);
    expect(both).toContain(`The profile memory repo at ${prof}`);
    // The space opting out of the profile's repo leaves its own.
    repos.setInherited(SPACE, false);
    expect(text(await provider.call(ctx, "memory_save", { entry: "x", repo: "profile" }))).toMatch(/no profile memory repo in use/);
    expect((await provider.tools(ctx)).length).toBe(6);
  });
});

describe("realm-memory provider — the index budget, kept where entries are written", () => {
  // A fact the way the profile root's longest entries read when they were saved whole.
  const LONG = `Carlton keeps his product ideas in the Ideas folder in Apple Notes, about 21 notes as of Nov 2026. ${"He wants each new idea saved there in his usual format, a title then a dash list, as its own note. ".repeat(6)}`.trim();
  const lines = (path: string) => readFileSync(join(path, "MEMORY.md"), "utf8").replace(/\n$/, "").split("\n");

  /** MEMORY.md as given, committed, so the next save starts from it. */
  function seed(path: string, index: string): void {
    writeFileSync(join(path, "MEMORY.md"), index);
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "fixture"], { cwd: path });
  }

  it("saves a 700-character fact as a hook of at most 200 characters in MEMORY.md and the whole of it in its own file", async () => {
    const { repos, provider } = harness();
    const { path } = await repos.create(P);
    expect(LONG.length).toBeGreaterThan(650);
    const saved = text(await provider.call(ctx, "memory_save", { entry: LONG }));

    const hook = lines(path).find((l) => l.startsWith("- Carlton keeps"))!;
    expect(hook.length).toBeLessThanOrEqual(INDEX_LINE_MAX);
    expect(hook).toMatch(/^- Carlton keeps his product ideas in the Ideas folder .*… \(\[\[facts\/carlton-keeps-his-product-ideas-in\]\]\)$/);
    expect(lines(path).every((l) => l.length <= INDEX_LINE_MAX)).toBe(true);
    const fact = readFileSync(join(path, "facts", "carlton-keeps-his-product-ideas-in.md"), "utf8");
    expect(fact).toContain(`- ${LONG} [source: realm:session/${SESSION}; added: 2026-10-08]`);
    expect(saved).toContain("the whole entry is in facts/carlton-keeps-his-product-ideas-in.md");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" })).toBe("");
    expect(text(await provider.call(ctx, "memory_search", { query: "dash list" }))).toContain("facts/carlton-keeps");

    // Saying it again adds nothing; a short fact still goes in whole, as before.
    expect(text(await provider.call(ctx, "memory_save", { entry: LONG }))).toMatch(/^Already in MEMORY\.md/);
    await provider.call(ctx, "memory_save", { entry: "Prefers tabs" });
    expect(lines(path)).toContain(`- Prefers tabs [source: realm:session/${SESSION}; added: 2026-10-08]`);
    expect(existsSync(join(path, "facts", "prefers-tabs.md"))).toBe(false);
  });

  it("updates a hooked fact in its own file, and removes the file with its hook", async () => {
    const { repos, provider } = harness();
    const { path } = await repos.create(P);
    await provider.call(ctx, "memory_save", { entry: LONG });
    const file = join(path, "facts", "carlton-keeps-his-product-ideas-in.md");
    const changed = `${LONG} He also tags each with the project.`;
    await provider.call(ctx, "memory_save", { entry: changed, replaces: "Carlton keeps his product ideas" });
    expect(readFileSync(file, "utf8")).toContain(`- ${changed} [`);
    expect(lines(path).filter((l) => l.includes("[[facts/"))).toHaveLength(1);

    await provider.call(ctx, "memory_remove", { entry: "Carlton keeps his product ideas" });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(path, "MEMORY.md"), "utf8")).not.toContain("Carlton keeps");
  });

  it(`warns once a save leaves MEMORY.md at ${INDEX_WARN_LINES} lines, and saves all the same`, async () => {
    const { repos, provider } = harness();
    const { path } = await repos.create(P);
    // "# Memory", a blank, the facts, a blank, "## Index": a save takes it to one line short of the warning.
    seed(path, `# Memory\n\n${Array.from({ length: INDEX_WARN_LINES - 6 }, (_, i) => `- Fact ${i}`).join("\n")}\n\n## Index\n`);
    const under = await provider.call(ctx, "memory_save", { entry: "Prefers tabs" });
    expect(lines(path)).toHaveLength(INDEX_WARN_LINES - 1);
    expect(text(under)).not.toMatch(/MEMORY\.md is now/);

    const at = await provider.call(ctx, "memory_save", { entry: "Uses pnpm" });
    expect(at.isError).toBe(false);
    expect(lines(path)).toHaveLength(INDEX_WARN_LINES);
    expect(text(at)).toMatch(/^Saved MEMORY\.md: - Uses pnpm/);
    expect(text(at)).toContain(`MEMORY.md is now ${INDEX_WARN_LINES} lines (the warning is at ${INDEX_WARN_LINES}; Claude loads the first 200)`);
    expect(text(at)).not.toMatch(/characters \(the warning/);
  });

  it(`warns once a save leaves MEMORY.md at ${INDEX_WARN_CHARS.toLocaleString("en-US")} characters`, async () => {
    const { repos, provider } = harness();
    const { path } = await repos.create(P);
    const pad = INDEX_WARN_CHARS - 200 - "# Memory\n\n\n\n## Index\n".length;
    seed(path, `# Memory\n\n${Array.from({ length: 10 }, (_, i) => `- Fact ${i} ${"x".repeat(pad / 10 - 10)}`).join("\n")}\n\n## Index\n`);
    expect(text(await provider.call(ctx, "memory_save", { entry: "Prefers tabs" }))).not.toMatch(/MEMORY\.md is now/);
    const at = text(await provider.call(ctx, "memory_save", { entry: LONG }));
    const chars = readFileSync(join(path, "MEMORY.md"), "utf8").length;
    expect(chars).toBeGreaterThanOrEqual(INDEX_WARN_CHARS);
    expect(at).toContain(`MEMORY.md is now ${chars.toLocaleString("en-US")} characters (the warning is at 18,000)`);
  });
});
