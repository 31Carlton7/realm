import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { ClaudeMemoryBackfill, claudeProjectName, claudeProjectRoot, matchClaudeProjects, type BackfillSpace } from "./claude-backfill";
import { MemoryRepoService } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const REALM = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const STORA = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
const P = { scope: "profile", id: PROFILE } as const;
const KEY = `sk-${"a".repeat(30)}`;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const gitInit = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
};
/** The folder Claude would keep a project's memory in, for a session started in `cwd`. */
const projectOf = (cwd: string): string => claudeProjectName(claudeProjectRoot(realpathSync(cwd)));

/** Every file under a folder with its hash and mtime — what "read only" is checked against. */
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p} ${statSync(p).mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

describe("which space a Claude project belongs to", () => {
  it("names a folder the way the CLI does", () => {
    expect(claudeProjectName("/Users/me/my.app/x_y z")).toBe("-Users-me-my-app-x-y-z");
  });

  it("keys a folder in a repository by the repository, and a linked worktree by its main checkout", () => {
    const home = realpathSync(tempDir("realm-claudeproj-"));
    const main = join(home, "realm");
    gitInit(main);
    mkdirSync(join(main, "apps", "server"), { recursive: true });
    git(main, "worktree", "add", "-q", join(home, "realm-worktrees", "feature"));
    mkdirSync(join(home, "plain"));
    expect(claudeProjectRoot(join(main, "apps", "server"))).toBe(main);
    // THE MUTANT: stop at the worktree's own `.git` file — its memory folder would be a project of its own.
    expect(claudeProjectRoot(join(home, "realm-worktrees", "feature"))).toBe(main);
    expect(claudeProjectRoot(join(home, "plain"))).toBe(join(home, "plain"));
  });

  it("matches the folder a space works in, or its repository, and refuses to guess between two spaces", () => {
    const home = realpathSync(tempDir("realm-claudeproj-"));
    const main = join(home, "realm");
    gitInit(main);
    git(main, "worktree", "add", "-q", join(home, "wt", "feature"));
    for (const d of ["stora", "shared", "elsewhere"]) mkdirSync(join(home, d));
    const spaces: BackfillSpace[] = [
      { id: "A", profileId: PROFILE, name: "Realm", paths: [join(home, "space-a"), main] },
      { id: "B", profileId: PROFILE, name: "Realm Mobile", paths: [join(home, "wt", "feature")] },
      { id: "C", profileId: PROFILE, name: "Stora", paths: [join(home, "stora"), join(home, "shared")] },
      { id: "D", profileId: PROFILE, name: "Versed", paths: [join(home, "shared")] },
    ];
    const names = [main, join(home, "stora"), join(home, "shared"), join(home, "elsewhere")].map(claudeProjectName);
    const m = matchClaudeProjects([...names, claudeProjectName(join(home, "wt", "feature"))], spaces);
    // The checkout itself outranks a worktree whose repository it is.
    expect(m.get(names[0]!)).toEqual({ spaceId: "A" });
    expect(m.get(names[1]!)).toEqual({ spaceId: "C" });
    expect(m.get(names[2]!)).toEqual({ reason: "Stora and Versed both work there" });
    expect(m.get(names[3]!)).toEqual({ reason: "no space works in that folder" });
    // A memory folder from before Claude keyed worktrees by their repository is still the worktree's space's.
    expect(m.get(claudeProjectName(join(home, "wt", "feature")))).toEqual({ spaceId: "B" });
  });

  it("finds a space that only has a worktree of the repository Claude named", () => {
    const home = realpathSync(tempDir("realm-claudeproj-"));
    const main = join(home, "realm");
    gitInit(main);
    git(main, "worktree", "add", "-q", join(home, "wt", "feature"));
    const m = matchClaudeProjects([claudeProjectName(main)], [{ id: "B", profileId: PROFILE, name: "Realm Mobile", paths: [join(home, "wt", "feature")] }]);
    expect(m.get(claudeProjectName(main))).toEqual({ spaceId: "B" });
  });
});

describe("bringing in Claude's own memory", () => {
  async function harness() {
    const home = realpathSync(tempDir("realm-backfill-"));
    const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
    const realmDir = join(home, "code", "realm");
    const storaDir = join(home, "code", "stora");
    mkdirSync(realmDir, { recursive: true });
    mkdirSync(storaDir, { recursive: true });
    const spaces: BackfillSpace[] = [
      { id: REALM, profileId: PROFILE, name: "Realm", paths: [join(home, "spaces", "realm"), realmDir] },
      { id: STORA, profileId: PROFILE, name: "Stora", paths: [storaDir] },
    ];
    const repos = new MemoryRepoService({
      home, settings,
      scopes: { profileIdOf: () => PROFILE, spaceIdsOf: () => [REALM, STORA], spaceNameOf: (s) => spaces.find((x) => x.id === s)?.name ?? null },
      committerName: async () => "Tester",
    });
    const { path: repo } = await repos.create(P);
    const claudeDir = join(home, "fake-claude");
    const scratch = join(home, "scratch");
    const backfill = new ClaudeMemoryBackfill({ claudeDir, repos, settings, spaces: () => spaces, profileIds: () => [PROFILE], temporaryRoots: [scratch] });
    /** A file Claude wrote in a project's memory folder, outside Realm. */
    const claudeKept = (cwd: string, file: string, text: string): void => {
      const dir = join(claudeDir, "projects", projectOf(cwd), "memory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    const run = async () => { await backfill.run(); return backfill.result(PROFILE); };
    return { home, settings, repos, repo, claudeDir, scratch, realmDir, storaDir, claudeKept, run, backfill };
  }
  const commits = (repo: string): number => Number(git(repo, "rev-list", "--count", "HEAD").trim());

  it("copies each project's files as they are into its space's folder, merges the index, and links the folder", async () => {
    const h = await harness();
    const fact = "---\nname: uses-pnpm\ndescription: The repo uses pnpm\nmetadata:\n  type: project\n---\n\npnpm, never npm.\n";
    h.claudeKept(h.realmDir, "uses-pnpm.md", fact);
    h.claudeKept(h.realmDir, "MEMORY.md", "- [uses-pnpm](uses-pnpm.md) — the repo uses pnpm\n");
    h.claudeKept(h.storaDir, "deploys.md", "Deploys on Fridays.\n");
    h.claudeKept(h.storaDir, "MEMORY.md", "- [deploys](deploys.md) — Fridays\n");
    const r = await h.run();
    expect(r).toMatchObject({ imported: 2, updated: 0, total: 2, unmatched: [], skipped: [], error: null });
    expect(readFileSync(join(h.repo, "spaces", "realm", "uses-pnpm.md"), "utf8")).toBe(fact);
    expect(readFileSync(join(h.repo, "spaces", "realm", "MEMORY.md"), "utf8")).toBe("- [uses-pnpm](uses-pnpm.md) — the repo uses pnpm\n");
    expect(readFileSync(join(h.repo, "spaces", "stora", "deploys.md"), "utf8")).toBe("Deploys on Fridays.\n");
    expect(readFileSync(join(h.repo, "MEMORY.md"), "utf8")).toBe("# Memory\n\n## Index\n- [[spaces/realm/MEMORY]]\n- [[spaces/stora/MEMORY]]\n");
    expect(git(h.repo, "log", "-1", "--format=%s").trim()).toBe("Bring in memory Claude kept outside Realm");
    expect(git(h.repo, "status", "--porcelain")).toBe("");
  });

  it("does nothing the second time, and never writes to Claude's folder", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "a.md", "a\n");
    h.claudeKept(h.realmDir, "MEMORY.md", "- [a](a.md) — a\n");
    await h.run();
    const before = commits(h.repo);
    const claude = fingerprint(h.claudeDir);
    // THE MUTANT: no manifest — every run rewrites (or re-adds) what it already copied.
    expect(await h.run()).toMatchObject({ imported: 0, updated: 0, total: 1 });
    expect(commits(h.repo)).toBe(before);
    expect(fingerprint(h.claudeDir)).toBe(claude);
  });

  it("updates a copy whose file changed only in Claude's folder, and never one changed in the repo", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "a.md", "a v1\n");
    h.claudeKept(h.realmDir, "b.md", "b v1\n");
    await h.run();
    h.claudeKept(h.realmDir, "a.md", "a v2\n");
    // Claude in Realm edits b in the repo; Claude in a terminal edits it too.
    writeFileSync(join(h.repo, "spaces", "realm", "b.md"), "b edited in Realm\n");
    h.claudeKept(h.realmDir, "b.md", "b v2\n");
    const r = await h.run();
    expect(r).toMatchObject({ imported: 0, updated: 1 });
    expect(readFileSync(join(h.repo, "spaces", "realm", "a.md"), "utf8")).toBe("a v2\n");
    // THE MUTANT: compare with the source only — Realm's edit is overwritten by the terminal's.
    expect(readFileSync(join(h.repo, "spaces", "realm", "b.md"), "utf8")).toBe("b edited in Realm\n");
    expect(r.skipped).toEqual([{ file: join(h.claudeDir, "projects", projectOf(h.realmDir), "memory", "b.md"), reason: "spaces/realm/b.md has changed in the repo since it was copied" }]);
  });

  it("leaves a copy removed from the repo removed, until its file changes again", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "a.md", "a\n");
    await h.run();
    await h.repos.writeBatch(P, new Map([["spaces/realm/a.md", null]]), "Forget a");
    expect(await h.run()).toMatchObject({ imported: 0, total: 0 });
    expect(existsSync(join(h.repo, "spaces", "realm", "a.md"))).toBe(false);
    h.claudeKept(h.realmDir, "a.md", "a, learned again\n");
    expect(await h.run()).toMatchObject({ imported: 1 });
  });

  it("leaves out a file shaped like a credential, and its index line with it", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "ok.md", "fine\n");
    h.claudeKept(h.realmDir, "keys.md", `staging key ${KEY}\n`);
    h.claudeKept(h.realmDir, "MEMORY.md", "- [ok](ok.md) — fine\n- [keys](keys.md) — the staging key\n");
    const r = await h.run();
    expect(r.imported).toBe(1);
    expect(r.skipped).toEqual([{ file: join(h.claudeDir, "projects", projectOf(h.realmDir), "memory", "keys.md"), reason: "it looks like it holds an API key, and memory never holds credentials" }]);
    expect(existsSync(join(h.repo, "spaces", "realm", "keys.md"))).toBe(false);
    expect(readFileSync(join(h.repo, "spaces", "realm", "MEMORY.md"), "utf8")).toBe("- [ok](ok.md) — fine\n");
  });

  it("keeps the first of two projects' files of one name in one folder, and says so", async () => {
    const h = await harness();
    // The space's own folder and its checkout are two Claude projects that both land in its folder.
    mkdirSync(join(h.home, "spaces", "realm"), { recursive: true });
    h.claudeKept(h.realmDir, "notes.md", "from the checkout\n");
    h.claudeKept(join(h.home, "spaces", "realm"), "notes.md", "from the space folder\n");
    const r = await h.run();
    const kept = readFileSync(join(h.repo, "spaces", "realm", "notes.md"), "utf8");
    expect(r.imported).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toBe("spaces/realm/notes.md holds another Claude project's file of that name");
    // Stable: the next run keeps the same one and says the same thing.
    expect((await h.run()).skipped).toEqual(r.skipped);
    expect(readFileSync(join(h.repo, "spaces", "realm", "notes.md"), "utf8")).toBe(kept);
  });

  it("reports a project no space works in, and passes over a temporary one", async () => {
    const h = await harness();
    const lost = join(h.home, "code", "lost");
    const scratchProject = join(h.scratch, "realm-live-x");
    mkdirSync(lost, { recursive: true });
    mkdirSync(scratchProject, { recursive: true });
    h.claudeKept(lost, "a.md", "a\n");
    h.claudeKept(scratchProject, "b.md", "b\n");
    const r = await h.run();
    expect(r.unmatched).toEqual([{ project: projectOf(lost), reason: "no space works in that folder" }]);
    expect(r.skipped).toEqual([{ file: join(h.claudeDir, "projects", projectOf(scratchProject)), reason: "it is a temporary folder, not a project" }]);
    expect(readdirSync(join(h.repo))).not.toContain("spaces");
  });

  it("brings nothing into a space that turned the profile's repo off", async () => {
    const h = await harness();
    h.repos.setInherited(STORA, false);
    h.claudeKept(h.storaDir, "a.md", "a\n");
    const r = await h.run();
    expect(r).toMatchObject({ imported: 0, skipped: [{ file: join(h.claudeDir, "projects", projectOf(h.storaDir), "memory"), reason: "Stora keeps no memory in Realm" }] });
    expect(existsSync(join(h.repo, "spaces", "stora"))).toBe(false);
  });

  it("says why when the repo has changes of someone's own, and catches up once it is clean", async () => {
    const h = await harness();
    writeFileSync(join(h.repo, "draft.md"), "mine");
    h.claudeKept(h.realmDir, "a.md", "a\n");
    const r = await h.run();
    expect(r.error).toMatch(/uncommitted changes/);
    expect(existsSync(join(h.repo, "spaces", "realm", "a.md"))).toBe(false);
    rmSync(join(h.repo, "draft.md"));
    expect(await h.run()).toMatchObject({ imported: 1, error: null });
  });
});
