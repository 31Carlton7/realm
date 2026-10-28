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
const SCHOOL = "01ARZ3NDEKTSV4RRFFQ69G5FP2";
const REALM = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const STORA = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
const HOMEWORK = "01ARZ3NDEKTSV4RRFFQ69G5FS3";
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
      scopes: {
        profileIdOf: (s) => spaces.find((x) => x.id === s)?.profileId ?? null,
        spaceIdsOf: (p) => spaces.filter((x) => x.profileId === p).map((x) => x.id),
        spaceNameOf: (s) => spaces.find((x) => x.id === s)?.name ?? null,
      },
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
    /** A run, and what it did — as the server holds it, not yet shown on any page. */
    const run = async () => { await backfill.run(); return backfill.result(PROFILE); };
    return { home, settings, repos, repo, claudeDir, scratch, realmDir, storaDir, spaces, claudeKept, run, backfill };
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
    expect(r.unmatched).toEqual([{ project: projectOf(lost), path: lost, files: 1, reason: "no space works in that folder" }]);
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

  it("touches nothing on a check with nothing to bring in: a file Claude is writing waits, and someone's changes are no error", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "a.md", "a\n");
    await h.run();
    const before = commits(h.repo);
    writeFileSync(join(h.repo, "spaces", "realm", "half-written.md"), "Claude, mid-turn.\n");
    writeFileSync(join(h.repo, "draft.md"), "the person's own");
    // THE MUTANT: the clean check ahead of the empty check — every five minutes, an error on the row,
    // or Claude's half-written file committed under somebody else's message.
    expect(await h.run()).toMatchObject({ imported: 0, updated: 0, error: null });
    expect(commits(h.repo)).toBe(before);
    expect(git(h.repo, "status", "--porcelain")).toBe("?? draft.md\n?? spaces/realm/half-written.md\n");
  });

  it("lists a file left out once per version of it: once the page has shown it, not again until it changes", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "keys.md", `staging key ${KEY}\n`);
    const keys = join(h.claudeDir, "projects", projectOf(h.realmDir), "memory", "keys.md");
    expect((await h.run()).skipped.map((s) => s.file)).toEqual([keys]);
    // Nobody has looked yet: a file left out overnight is still listed in the morning.
    expect((await h.run()).skipped.map((s) => s.file)).toEqual([keys]);
    expect(h.backfill.seen(PROFILE).skipped.map((s) => s.file)).toEqual([keys]);
    // THE MUTANT: list everything left out on every run — the same line every five minutes.
    expect((await h.run()).skipped).toEqual([]);
    expect((await h.run()).skipped).toEqual([]);
    // Changed in Claude's folder: a new version, listed once more.
    h.claudeKept(h.realmDir, "keys.md", `rotated key ${KEY}9\n`);
    expect((await h.run()).skipped.map((s) => s.file)).toEqual([keys]);
    h.backfill.seen(PROFILE);
    expect((await h.run()).skipped).toEqual([]);
  });

  it("forgets a file once it is no longer left out, so the same file left out again is listed again", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, "keys.md", `staging key ${KEY}\n`);
    await h.run();
    h.backfill.seen(PROFILE);
    rmSync(join(h.claudeDir, "projects", projectOf(h.realmDir), "memory", "keys.md"));
    expect((await h.run()).skipped).toEqual([]);
    h.claudeKept(h.realmDir, "keys.md", `staging key ${KEY}\n`);
    expect((await h.run()).skipped).toHaveLength(1);
  });

  it("lists a temporary project once too", async () => {
    const h = await harness();
    mkdirSync(join(h.scratch, "realm-live-x"), { recursive: true });
    h.claudeKept(join(h.scratch, "realm-live-x"), "b.md", "b\n");
    expect((await h.run()).skipped).toHaveLength(1);
    h.backfill.seen(PROFILE);
    expect((await h.run()).skipped).toEqual([]);
  });
});

describe("placing a Claude project by hand", () => {
  async function harness() {
    const home = realpathSync(tempDir("realm-backfill-choice-"));
    const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
    const dir = (...p: string[]): string => { const d = join(home, ...p); mkdirSync(d, { recursive: true }); return d; };
    const realmDir = dir("code", "realm");
    const shared = dir("code", "shared");
    const spaces: BackfillSpace[] = [
      { id: REALM, profileId: PROFILE, name: "Realm", paths: [realmDir, shared] },
      { id: STORA, profileId: PROFILE, name: "Stora", paths: [dir("code", "stora"), shared] },
      { id: HOMEWORK, profileId: SCHOOL, name: "Homework", paths: [dir("school")] },
    ];
    const repos = new MemoryRepoService({
      home, settings,
      scopes: {
        profileIdOf: (s) => spaces.find((x) => x.id === s)?.profileId ?? null,
        spaceIdsOf: (p) => spaces.filter((x) => x.profileId === p).map((x) => x.id),
        spaceNameOf: (s) => spaces.find((x) => x.id === s)?.name ?? null,
      },
      committerName: async () => "Tester",
    });
    const { path: repo } = await repos.create(P);
    const claudeDir = join(home, "fake-claude");
    /** Holds the next write back until `release` — a run caught mid-way. */
    const hold: { gate: Promise<void> | null } = { gate: null };
    const held: typeof repos.writeBatch = async (...a) => { const g = hold.gate; hold.gate = null; await g; return repos.writeBatch(...a); };
    const backfill = new ClaudeMemoryBackfill({ claudeDir, repos: { spaceFolderFor: (s) => repos.spaceFolderFor(s), config: (o) => repos.config(o), writeBatch: held }, settings, spaces: () => spaces, profileIds: () => [PROFILE, SCHOOL], temporaryRoots: [] });
    /** Files Claude kept for a session in `cwd` (made if need be), outside Realm; its project's name. */
    const claudeKept = (cwd: string, files: Record<string, string>): string => {
      mkdirSync(cwd, { recursive: true });
      const at = join(claudeDir, "projects", projectOf(cwd), "memory");
      mkdirSync(at, { recursive: true });
      for (const [f, text] of Object.entries(files)) writeFileSync(join(at, f), text);
      return projectOf(cwd);
    };
    const run = async () => { await backfill.run(); return backfill.result(PROFILE); };
    return { home, settings, repo, realmDir, shared, spaces, claudeKept, run, backfill, hold };
  }
  const has = (repo: string, rel: string): boolean => existsSync(join(repo, rel));

  it("brings a project two spaces share into the one chosen for it, over the tie", async () => {
    const h = await harness();
    const project = h.claudeKept(h.shared, { "a.md": "a\n", "b.md": "b\n" });
    expect((await h.run()).unmatched).toEqual([{ project, path: h.shared, files: 2, reason: "Realm and Stora both work there" }]);
    const r = await h.backfill.choose(PROFILE, project, STORA);
    expect(r).toMatchObject({ imported: 2, unmatched: [], chosen: [{ project, path: h.shared, files: 2, spaceId: STORA }], error: null });
    expect(readFileSync(join(h.repo, "spaces", "stora", "a.md"), "utf8")).toBe("a\n");
    expect(has(h.repo, "spaces/realm")).toBe(false);
    expect(h.settings.get(`memory.claudeProjectSpace:${project}`)).toBe(STORA);
  });

  it("puts the choice over a space that matches by itself", async () => {
    const h = await harness();
    const project = h.claudeKept(h.realmDir, { "a.md": "a\n" });
    // THE MUTANT: match first, and ask the choice only when matching has no answer.
    const r = await h.backfill.choose(PROFILE, project, STORA);
    expect(has(h.repo, "spaces/stora/a.md")).toBe(true);
    expect(has(h.repo, "spaces/realm/a.md")).toBe(false);
    expect(r.chosen).toEqual([{ project, path: h.realmDir, files: 1, spaceId: STORA }]);
  });

  it("leaves a project left out in Claude's folder, and says it was left out", async () => {
    const h = await harness();
    const project = h.claudeKept(h.shared, { "a.md": "a\n" });
    const r = await h.backfill.choose(PROFILE, project, "skip");
    expect(r).toMatchObject({ imported: 0, unmatched: [], chosen: [{ project, path: h.shared, files: 1, spaceId: null }], skipped: [] });
    expect(has(h.repo, "spaces")).toBe(false);
  });

  it("asks again about a project whose chosen space is gone, and never guesses another", async () => {
    const h = await harness();
    const project = h.claudeKept(h.realmDir, { "a.md": "a\n" });
    await h.backfill.choose(PROFILE, project, STORA);
    h.spaces.splice(h.spaces.findIndex((s) => s.id === STORA), 1);
    h.claudeKept(h.realmDir, { "b.md": "b\n" });
    const r = await h.run();
    // The folder still matches Realm by itself; a choice that can no longer be honoured is no licence to guess.
    expect(r.unmatched).toEqual([{ project, path: h.realmDir, files: 2, reason: "the space it was brought into is gone" }]);
    expect(r.chosen).toEqual([]);
    expect(has(h.repo, "spaces/realm")).toBe(false);
  });

  it("only places a project in a space of the profile asking", async () => {
    const h = await harness();
    const project = h.claudeKept(h.shared, { "a.md": "a\n" });
    await expect(h.backfill.choose(PROFILE, project, HOMEWORK)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.backfill.choose(PROFILE, project, "01ARZ3NDEKTSV4RRFFQ69G5FZZ")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.settings.get(`memory.claudeProjectSpace:${project}`)).toBeNull();
  });

  it("shows each profile the projects placed in its own spaces, and every profile the ones left out", async () => {
    const h = await harness();
    const placed = h.claudeKept(h.shared, { "a.md": "a\n" });
    const left = h.claudeKept(join(h.home, "elsewhere", "left"), { "c.md": "c\n" });
    await h.backfill.choose(PROFILE, placed, REALM);
    await h.backfill.choose(PROFILE, left, "skip");
    expect(h.backfill.result(PROFILE).chosen.map((c) => c.project).sort()).toEqual([left, placed].sort());
    expect(h.backfill.result(SCHOOL).chosen.map((c) => c.project)).toEqual([left]);
  });

  it("counts each waiting project's files and lists the biggest first", async () => {
    const h = await harness();
    const one = h.claudeKept(join(h.home, "elsewhere", "one"), { "a.md": "a\n" });
    const three = h.claudeKept(join(h.home, "elsewhere", "three"), { "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
    expect((await h.run()).unmatched.map((u) => [u.project, u.files])).toEqual([[three, 3], [one, 1]]);
  });

  it("runs again after a run already going, so a choice made during it is honoured at once", async () => {
    const h = await harness();
    h.claudeKept(h.realmDir, { "r.md": "r\n" });
    const project = h.claudeKept(h.shared, { "a.md": "a\n" });
    let release!: () => void;
    h.hold.gate = new Promise<void>((r) => { release = r; });
    // A run that matched before the choice existed, held mid-way at its write.
    const first = h.backfill.run();
    const chosen = h.backfill.choose(PROFILE, project, STORA);
    release();
    await first;
    // THE MUTANT: join the run already going — its plan never heard of the choice.
    expect(await chosen).toMatchObject({ unmatched: [], chosen: [{ project, spaceId: STORA }] });
    expect(has(h.repo, "spaces/stora/a.md")).toBe(true);
  });
});
