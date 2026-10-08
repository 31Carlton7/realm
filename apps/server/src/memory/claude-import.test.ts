import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryRepoService } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE_A = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SPACE_B = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
const P = { scope: "profile", id: PROFILE } as const;
const PROJECT = "Users-me-Projects-versed";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const commits = (repo: string): number => Number(git(repo, "rev-list", "--count", "HEAD").trim());

/** What `ImportService.importMemory` leaves under Realm's home: Claude's per-project memory folder,
 *  copied — the only place this import reads from. */
function importedCopy(home: string, spaceId: string, project: string): string {
  const dir = join(home, "memory", "imported", spaceId, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), [
    "- [Serve sim](serve-sim-workflow.md) — run the iOS app through serve-sim, not a screenshot server",
    "- [Build gotcha](build-gotcha.md) — clean DerivedData after a scheme change",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "serve-sim-workflow.md"), [
    "---", "name: serve-sim-workflow", "description: How the app is run", "metadata:", "  type: feedback", "  modified: 2026-08-02T08:59:07.042Z", "---",
    "", "Use `npx serve-sim`. Related: [[build-gotcha]] and [the gotcha](build-gotcha.md).", "",
  ].join("\n"));
  writeFileSync(join(dir, "build-gotcha.md"), "---\nname: build-gotcha\n---\n\nClean DerivedData.\n");
  writeFileSync(join(dir, "deploy-key.md"), "The deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n");
  return dir;
}

async function harness() {
  const home = tempDir("realm-memimport-");
  const repos = new MemoryRepoService({
    home, settings: new SettingsStore(openDatabase(join(home, "realm.db"))),
    scopes: { profileIdOf: () => PROFILE, spaceIdsOf: (p) => (p === PROFILE ? [SPACE_A, SPACE_B] : []) },
    committerName: async () => "Tester", today: () => "2026-10-08",
  });
  const repo = (await repos.create(P)).path;
  return { home, repos, repo };
}

describe("importing Claude's memory into a memory repo", () => {
  it("previews the count and writes nothing, then imports as one commit with each fact's source", async () => {
    const { home, repos, repo } = await harness();
    const dir = importedCopy(home, SPACE_A, PROJECT);
    const preview = await repos.importClaude(P, { dryRun: true });
    expect(preview).toEqual({
      projects: 1, files: 2, entries: 2, sha: null,
      skipped: [{ file: join(dir, "deploy-key.md"), reason: "it looks like it holds a GitHub token" }],
    });
    expect(commits(repo)).toBe(1);
    expect(existsSync(join(repo, "imported"))).toBe(false);

    const done = await repos.importClaude(P, { dryRun: false });
    expect(done).toMatchObject({ projects: 1, files: 2, entries: 2 });
    expect(done.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commits(repo)).toBe(2);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Import 2 memories from Claude\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "show", "--name-only", "--format=").split("\n").filter(Boolean).sort()).toEqual([
      "MEMORY.md", `imported/${PROJECT}.md`, `imported/${PROJECT}/build-gotcha.md`, `imported/${PROJECT}/serve-sim-workflow.md`,
    ]);
    const topic = readFileSync(join(repo, "imported", `${PROJECT}.md`), "utf8");
    expect(topic).toContain(`- Serve sim — run the iOS app through serve-sim, not a screenshot server ([[imported/${PROJECT}/serve-sim-workflow]]) [source: ${join(dir, "serve-sim-workflow.md")}; added: 2026-08-02]`);
    expect(topic).toContain(`- Build gotcha — clean DerivedData after a scheme change ([[imported/${PROJECT}/build-gotcha]]) [source: ${join(dir, "build-gotcha.md")}; added: 2026-10-08]`);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain(`- [[imported/${PROJECT}]]`);
    // A sibling link means nothing from the repo's root; it is rewritten to the spec's form.
    expect(readFileSync(join(repo, "imported", PROJECT, "serve-sim-workflow.md"), "utf8"))
      .toContain(`Related: [[imported/${PROJECT}/build-gotcha]] and the gotcha ([[imported/${PROJECT}/build-gotcha]]).`);
    expect(existsSync(join(repo, "imported", PROJECT, "deploy-key.md"))).toBe(false);
  });

  it("is idempotent: a second run adds nothing, and never overwrites a fact edited in the repo", async () => {
    const { home, repos, repo } = await harness();
    importedCopy(home, SPACE_A, PROJECT);
    await repos.importClaude(P, { dryRun: false });
    const fact = join(repo, "imported", PROJECT, "build-gotcha.md");
    writeFileSync(fact, "Clean DerivedData, then reset the simulator.\n");
    git(repo, "-c", "user.name=Me", "-c", "user.email=m@m", "commit", "-qam", "Edit by hand");
    const head = git(repo, "rev-parse", "HEAD");
    // THE MUTANT: write each fact file whether or not the repo has it — the hand edit is overwritten
    // and every run is a new commit.
    expect(await repos.importClaude(P, { dryRun: true })).toMatchObject({ projects: 0, files: 0, entries: 0 });
    expect(await repos.importClaude(P, { dryRun: false })).toMatchObject({ entries: 0, sha: null });
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(fact, "utf8")).toBe("Clean DerivedData, then reset the simulator.\n");
  });

  it("takes every space's imports into the profile repo, and only its own into a space repo", async () => {
    const { home, repos } = await harness();
    importedCopy(home, SPACE_A, PROJECT);
    importedCopy(home, SPACE_B, "Users-me-Projects-realm");
    expect((await repos.importClaude(P, { dryRun: true })).projects).toBe(2);
    const S = { scope: "space", id: SPACE_B } as const;
    await repos.create(S);
    const spaceOnly = await repos.importClaude(S, { dryRun: false });
    expect(spaceOnly).toMatchObject({ projects: 1, entries: 2 });
    expect(existsSync(join(repos.config(S)!.path, "imported", "Users-me-Projects-realm.md"))).toBe(true);
    expect(existsSync(join(repos.config(S)!.path, "imported", `${PROJECT}.md`))).toBe(false);
  });

  it("refuses to import into a dirty repo, like any other write", async () => {
    const { home, repos, repo } = await harness();
    importedCopy(home, SPACE_A, PROJECT);
    writeFileSync(join(repo, "scratch.md"), "wip");
    await expect(repos.importClaude(P, { dryRun: false })).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    expect(existsSync(join(repo, "imported"))).toBe(false);
  });
});
