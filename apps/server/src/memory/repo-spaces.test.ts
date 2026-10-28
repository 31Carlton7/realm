import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { Environment } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryRepoService } from "./repo";
import { MemoryService } from "./service";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
const LONER = "01ARZ3NDEKTSV4RRFFQ69G5FS9";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const P = { scope: "profile", id: PROFILE } as const;

function harness(o: { toolsEnabled?: (spaceId: string) => boolean } = {}) {
  const home = tempDir("realm-memspaces-");
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const names: Record<string, string> = { [SPACE]: "Realm", [OTHER]: "realm!" };
  const repos = new MemoryRepoService({
    home, settings, toolsEnabled: o.toolsEnabled,
    scopes: {
      profileIdOf: (s) => (s === SPACE || s === OTHER ? PROFILE : null),
      spaceIdsOf: (p) => (p === PROFILE ? [SPACE, OTHER] : []),
      spaceNameOf: (s) => names[s] ?? null,
    },
    committerName: async () => "Tester",
  });
  return { home, settings, repos, names };
}

async function made(o: { toolsEnabled?: (spaceId: string) => boolean } = {}) {
  const h = harness(o);
  const { path } = await h.repos.create(P);
  return { ...h, repo: path };
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const commits = (repo: string): number => Number(git(repo, "rev-list", "--count", "HEAD").trim());
const status = (repo: string): string => git(repo, "status", "--porcelain", "--untracked-files=all");

describe("MemoryRepoService.spaceFolderFor", () => {
  it("names the folder after the space once, records it, and writes nothing yet", async () => {
    const { repos, repo, settings } = await made();
    const at = repos.spaceFolderFor(SPACE)!;
    expect(at).toEqual({ owner: P, repoPath: repo, folder: "realm", dir: join(repo, "spaces", "realm") });
    expect(settings.get(`memory.spaceFolder:${SPACE}`)).toEqual({ folder: "realm", profileId: PROFILE });
    expect(existsSync(at.dir)).toBe(false);
    expect(status(repo)).toBe("");
  });

  it("keeps the folder when the space is renamed", async () => {
    const { repos, names } = await made();
    expect(repos.spaceFolderFor(SPACE)!.folder).toBe("realm");
    names[SPACE] = "Realm Mobile";
    // THE MUTANT: derive the folder from the name on every call — a rename would orphan the memory.
    expect(repos.spaceFolderFor(SPACE)!.folder).toBe("realm");
  });

  it("numbers a name another space of the profile already has, or that is already a folder in the repo", async () => {
    const { repos, repo } = await made();
    expect(repos.spaceFolderFor(SPACE)!.folder).toBe("realm");
    // Recorded, not yet written: the folder is still taken.
    expect(repos.spaceFolderFor(OTHER)!.folder).toBe("realm-2");
    const h2 = await made();
    mkdirSync(join(h2.repo, "spaces", "realm"), { recursive: true });
    expect(h2.repos.spaceFolderFor(SPACE)!.folder).toBe("realm-2");
    expect(repo).not.toBe(h2.repo);
  });

  it("answers null where the space has no profile repo in use", async () => {
    let tools = true;
    const h = harness({ toolsEnabled: () => tools });
    expect(h.repos.spaceFolderFor(SPACE)).toBeNull();
    await h.repos.create(P);
    expect(h.repos.spaceFolderFor(LONER)).toBeNull();
    h.repos.setInherited(SPACE, false);
    expect(h.repos.spaceFolderFor(SPACE)).toBeNull();
    h.repos.setInherited(SPACE, true);
    tools = false;
    expect(h.repos.spaceFolderFor(SPACE)).toBeNull();
    tools = true;
    expect(h.repos.spaceFolderFor(SPACE)).not.toBeNull();
  });
});

describe("MemoryRepoService.writeBatch", () => {
  it("writes and deletes several files as one commit, staged by path only", async () => {
    const { repos, repo } = await made();
    await repos.writeBatch(P, new Map([["notes/a.md", "a\n"], ["notes/b.md", "b\n"], ["notes/keep.md", "k\n"]]), "Seed");
    const before = commits(repo);
    const r = await repos.writeBatch(P, new Map<string, string | null>([["notes/a.md", "a2\n"], ["notes/b.md", null], ["notes/c.md", "c\n"]]), "Rework notes", "Extractor");
    expect(r).toMatchObject({ changed: true, file: "notes/a.md" });
    expect(commits(repo)).toBe(before + 1);
    expect(git(repo, "show", "--name-status", "--format=%s|%an", "HEAD").split("\n").filter(Boolean)).toEqual(["Rework notes|Extractor", "M\tnotes/a.md", "D\tnotes/b.md", "A\tnotes/c.md"]);
    expect(status(repo)).toBe("");
  });

  it("commits nothing when every file is already as asked", async () => {
    const { repos, repo } = await made();
    await repos.writeBatch(P, new Map([["a.md", "a\n"]]), "Seed");
    const before = commits(repo);
    expect(await repos.writeBatch(P, new Map<string, string | null>([["a.md", "a\n"], ["gone.md", null]]), "Again")).toMatchObject({ changed: false, sha: null });
    expect(commits(repo)).toBe(before);
  });

  it("refuses a path out of the repo or into .git, by .., by an absolute path or by a symlink, and writes nothing", async () => {
    const { repos, repo, home } = await made();
    const outside = join(home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, "out"));
    git(repo, "add", "out");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "link");
    for (const bad of ["../escape.md", "spaces/../../escape.md", "/etc/escape.md", ".git/config", "spaces/.GIT/x", "out/escape.md"]) {
      await expect(repos.writeBatch(P, new Map([["fine.md", "fine\n"], [bad, "x\n"]]), "Escape"), bad).rejects.toMatchObject({ code: "MEMORY_PATH" });
    }
    expect(existsSync(join(repo, "fine.md"))).toBe(false);
    expect(existsSync(join(outside, "escape.md"))).toBe(false);
    expect(commits(repo)).toBe(2);
  });

  it("refuses a secret anywhere in the batch, and writes none of it", async () => {
    const { repos, repo } = await made();
    const key = `sk-${"a".repeat(30)}`;
    await expect(repos.writeBatch(P, new Map([["fine.md", "fine\n"], ["keys.md", `the key is ${key}\n`]]), "Leak")).rejects.toMatchObject({ code: "MEMORY_SECRET" });
    expect(existsSync(join(repo, "fine.md"))).toBe(false);
    expect(status(repo)).toBe("");
  });
});

describe("MemoryRepoService.saveSpaceMemory", () => {
  it("writes one fact in Claude's format, its index line, and the root link once", async () => {
    const { repos, repo } = await made();
    await repos.saveSpaceMemory(SPACE, { name: "deploy-steps", description: "How a release ships: tag, build, notarize", type: "project", body: "Tag on main, then `pnpm release`.", sessionId: SESSION });
    expect(readFileSync(join(repo, "spaces", "realm", "deploy-steps.md"), "utf8")).toBe(
      `---\nname: deploy-steps\ndescription: "How a release ships: tag, build, notarize"\nmetadata:\n  type: project\n  source: "realm:session/${SESSION}"\n---\n\nTag on main, then \`pnpm release\`.\n`);
    expect(readFileSync(join(repo, "spaces", "realm", "MEMORY.md"), "utf8")).toBe("- [deploy-steps](deploy-steps.md) — How a release ships: tag, build, notarize\n");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe("# Memory\n\n## Index\n- [[spaces/realm/MEMORY]]\n");
    // Saved again under the same name: the file and its line are rewritten, never duplicated.
    await repos.saveSpaceMemory(SPACE, { name: "deploy-steps", description: "How a release ships", type: "project", body: "Tag, then `pnpm release`." });
    expect(readFileSync(join(repo, "spaces", "realm", "MEMORY.md"), "utf8")).toBe("- [deploy-steps](deploy-steps.md) — How a release ships\n");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8").match(/spaces\/realm\/MEMORY/g)).toHaveLength(1);
    expect(git(repo, "log", "--format=%s", "-2").split("\n").filter(Boolean)).toEqual(["Remember deploy-steps", "Remember deploy-steps"]);
    expect(status(repo)).toBe("");
  });

  it("keeps both of two facts saved at once", async () => {
    const { repos, repo } = await made();
    await Promise.all([
      repos.saveSpaceMemory(SPACE, { name: "uses-pnpm", description: "The repo uses pnpm", type: "project", body: "" }),
      repos.saveSpaceMemory(SPACE, { name: "terse-replies", description: "The user wants short answers", type: "feedback", body: "" }),
    ]);
    // THE MUTANT: read the index before taking the lock — the second save writes over the first's line.
    expect(readFileSync(join(repo, "spaces", "realm", "MEMORY.md"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("refuses a space with no profile repo in use", async () => {
    const { repos } = await made();
    await expect(repos.saveSpaceMemory(LONER, { name: "x", description: "y", type: "user", body: "" })).rejects.toMatchObject({ code: "MEMORY_REPO_NONE" });
  });
});

describe("the index a session reads, by agent", () => {
  async function withFolder() {
    const h = await made();
    await h.repos.saveSpaceMemory(SPACE, { name: "uses-pnpm", description: "FOLDER-FACT the repo uses pnpm", type: "project", body: "" });
    await h.repos.edit(P, { op: "add", entry: "ROOT-FACT the user is Carlton", sessionId: SESSION });
    return h;
  }

  it("gives Codex the root and the space folder, and Claude only the root", async () => {
    const { repos, repo } = await withFolder();
    expect(repos.indexesFor(SPACE, { forAgent: "codex" }).map((r) => [r.scope, r.kind, r.path])).toEqual([
      ["profile", "root", repo], ["profile", "spaceFolder", join(repo, "spaces", "realm")],
    ]);
    // THE MUTANT: ignore `forAgent` — Claude reads its folder's index twice, once from Realm.
    expect(repos.indexesFor(SPACE, { forAgent: "claude" }).map((r) => r.kind)).toEqual(["root"]);
    expect(repos.indexesFor(SPACE).map((r) => r.kind)).toEqual(["root", "spaceFolder"]);
  });

  it("puts the folder's index in Codex's context and not in Claude's, and tells Claude where its memory goes", async () => {
    const { repos, home, settings, repo } = await withFolder();
    const environments = { ensurePrimary: (spaceId: string): Environment => ({ id: "e", spaceId, path: home, branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }) };
    const memory = new MemoryService({ home, settings, environments, claudeDir: join(home, "claude-home"), repos });
    const codex = memory.systemContextFor({ spaceId: SPACE, kind: "codex", cwd: home, skillsInjected: false })!;
    expect(codex).toContain("ROOT-FACT");
    expect(codex).toContain("FOLDER-FACT");
    expect(codex).toContain("rather than in any memory file of your own");
    const claude = memory.systemContextFor({ spaceId: SPACE, kind: "claude", cwd: home, skillsInjected: false })!;
    expect(claude).toContain("ROOT-FACT");
    expect(claude).not.toContain("FOLDER-FACT");
    expect(claude).toContain(`Your own memory directory in this workspace is ${join(repo, "spaces", "realm")}`);
    expect(claude).not.toContain("rather than in any memory file of your own");
  });
});

describe("a space moved to another profile", () => {
  const WORK = "01ARZ3NDEKTSV4RRFFQ69G5FPW";
  const SCHOOL = "01ARZ3NDEKTSV4RRFFQ69G5FPS";
  const HOME = "01ARZ3NDEKTSV4RRFFQ69G5FPH";
  const WORK_GENERAL = "01ARZ3NDEKTSV4RRFFQ69G5FWG";
  const SCHOOL_GENERAL = "01ARZ3NDEKTSV4RRFFQ69G5FSG";
  const SCHOOL_OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FSO";
  /** Three profiles with a repo each, and a space called General in Work and in School — the owner's
   *  own case — plus a second School space of that name made later in a test. */
  async function twoProfiles() {
    const home = tempDir("realm-memmove-");
    const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
    const profileOf: Record<string, string> = { [WORK_GENERAL]: WORK, [SCHOOL_GENERAL]: SCHOOL };
    const repos = new MemoryRepoService({
      home, settings,
      scopes: {
        profileIdOf: (s) => profileOf[s] ?? null,
        spaceIdsOf: (p) => Object.keys(profileOf).filter((s) => profileOf[s] === p),
        spaceNameOf: () => "General",
      },
      committerName: async () => "Tester",
    });
    const work = (await repos.create({ scope: "profile", id: WORK })).path;
    const school = (await repos.create({ scope: "profile", id: SCHOOL })).path;
    const homeRepo = (await repos.create({ scope: "profile", id: HOME })).path;
    const move = (spaceId: string, profileId: string) => { profileOf[spaceId] = profileId; };
    return { settings, repos, work, school, homeRepo, move, moveToWork: () => move(SCHOOL_GENERAL, WORK) };
  }

  it("takes a folder of its own in the new profile's repo, with its memory, and leaves the old repo as it was", async () => {
    const h = await twoProfiles();
    await h.repos.saveSpaceMemory(WORK_GENERAL, { name: "ports", description: "The port map", type: "project", body: "From 8790." });
    await h.repos.saveSpaceMemory(SCHOOL_GENERAL, { name: "deadlines", description: "When the essays are due", type: "project", body: "Fridays." });
    const schoolHead = git(h.school, "rev-parse", "HEAD");
    h.moveToWork();
    // THE MUTANT: reuse the recorded name — both Generals in spaces/general, one memory directory for two spaces.
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)).toMatchObject({ folder: "general-2", dir: join(h.work, "spaces", "general-2") });
    expect(h.repos.spaceFolderFor(WORK_GENERAL)!.folder).toBe("general");
    const carried = await h.repos.followSpace(SCHOOL_GENERAL);
    expect(carried).toMatchObject({ folder: "general-2", copied: ["deadlines.md"], left: [] });
    expect(readFileSync(join(h.work, "spaces", "general-2", "deadlines.md"), "utf8")).toBe(readFileSync(join(h.school, "spaces", "general", "deadlines.md"), "utf8"));
    expect(readFileSync(join(h.work, "spaces", "general-2", "MEMORY.md"), "utf8")).toBe("- [deadlines](deadlines.md) — When the essays are due\n");
    expect(readFileSync(join(h.work, "MEMORY.md"), "utf8")).toContain("- [[spaces/general-2/MEMORY]]");
    // One commit in the new repo; the other General's folder and the repo the space left are untouched.
    expect(git(h.work, "log", "-1", "--format=%s").trim()).toBe("Carry the memory of General over from the profile it left");
    expect(git(h.work, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual(["MEMORY.md", "spaces/general-2/MEMORY.md", "spaces/general-2/deadlines.md"]);
    expect(readdirSync(join(h.work, "spaces", "general")).sort()).toEqual(["MEMORY.md", "ports.md"]);
    expect(git(h.school, "rev-parse", "HEAD")).toBe(schoolHead);
    expect(git(h.school, "status", "--porcelain")).toBe("");
    // Carried once: the record waits for nothing — it keeps the folder the space had in School — and a
    // second follow does nothing.
    expect(h.settings.get(`memory.spaceFolder:${SCHOOL_GENERAL}`)).toEqual({ folder: "general-2", profileId: WORK, earlier: { [SCHOOL]: "general" } });
    expect(h.repos.carryPending(SCHOOL_GENERAL)).toBe(false);
    expect(await h.repos.followSpace(SCHOOL_GENERAL)).toBeNull();
  });

  it("does not hand out a name another space of the new profile has recorded but not written yet", async () => {
    const h = await twoProfiles();
    expect(h.repos.spaceFolderFor(WORK_GENERAL)!.folder).toBe("general");
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general");
    h.moveToWork();
    // THE MUTANT: read only the old bare-name records — Work's General, recorded as { folder, profileId }, is not counted.
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general-2");
  });

  it("reads a folder recorded before the profile was kept with it, and keeps the profile with it from then on", async () => {
    const h = await twoProfiles();
    h.settings.set(`memory.spaceFolder:${WORK_GENERAL}`, "general-notes");
    // THE MUTANT: a bare name read as no record — the space would take a new folder and lose sight of its memory.
    expect(h.repos.spaceFolderFor(WORK_GENERAL)!.folder).toBe("general-notes");
    expect(h.settings.get(`memory.spaceFolder:${WORK_GENERAL}`)).toEqual({ folder: "general-notes", profileId: WORK });
    expect(h.repos.hasSpaceFolder(WORK_GENERAL)).toBe(true);
    expect(h.repos.carryPending(WORK_GENERAL)).toBe(false);
  });

  it("reads a carry left waiting in the shape a record had when only one folder could wait", async () => {
    const h = await twoProfiles();
    await h.repos.saveSpaceMemory(SCHOOL_GENERAL, { name: "deadlines", description: "When the essays are due", type: "project", body: "" });
    h.moveToWork();
    h.settings.set(`memory.spaceFolder:${SCHOOL_GENERAL}`, { folder: "general", profileId: WORK, carryFrom: { folder: "general", profileId: SCHOOL } });
    expect(h.repos.carryPending(SCHOOL_GENERAL)).toBe(true);
    expect(await h.repos.followSpace(SCHOOL_GENERAL)).toMatchObject({ folder: "general", copied: ["deadlines.md"] });
  });

  it("lets the tidy pass see only a folder recorded in the space's own profile", async () => {
    const h = await twoProfiles();
    expect(h.repos.hasSpaceFolder(SCHOOL_GENERAL)).toBe(false);
    h.repos.spaceFolderFor(SCHOOL_GENERAL);
    expect(h.repos.hasSpaceFolder(SCHOOL_GENERAL)).toBe(true);
    h.moveToWork();
    // THE MUTANT: any record counts — the pass would ask for a moved space's folder and allocate it one.
    expect(h.repos.hasSpaceFolder(SCHOOL_GENERAL)).toBe(false);
    expect(h.repos.carryPending(SCHOOL_GENERAL)).toBe(true);
    await h.repos.followSpace(SCHOOL_GENERAL);
    expect(h.repos.hasSpaceFolder(SCHOOL_GENERAL)).toBe(true);
  });

  it("waits to carry a moved space's memory while the new repo has someone's changes, and carries it once it is clean", async () => {
    const h = await twoProfiles();
    await h.repos.saveSpaceMemory(SCHOOL_GENERAL, { name: "deadlines", description: "When the essays are due", type: "project", body: "" });
    h.moveToWork();
    writeFileSync(join(h.work, "draft.md"), "the person's own");
    await expect(h.repos.followSpace(SCHOOL_GENERAL)).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    // The new folder is the space's already; only the copy waits.
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general");
    expect(h.repos.carryPending(SCHOOL_GENERAL)).toBe(true);
    rmSync(join(h.work, "draft.md"));
    expect(await h.repos.followSpace(SCHOOL_GENERAL)).toMatchObject({ copied: ["deadlines.md"] });
    expect(h.repos.carryPending(SCHOOL_GENERAL)).toBe(false);
  });

  it("comes back to its own folder when it moves away and back, and brings what it learned away", async () => {
    const h = await twoProfiles();
    await h.repos.saveSpaceMemory(WORK_GENERAL, { name: "ports", description: "The port map", type: "project", body: "" });
    await h.repos.saveSpaceMemory(SCHOOL_GENERAL, { name: "deadlines", description: "When the essays are due", type: "project", body: "Fridays." });
    h.move(SCHOOL_GENERAL, WORK);
    await h.repos.followSpace(SCHOOL_GENERAL);
    await h.repos.saveSpaceMemory(SCHOOL_GENERAL, { name: "essay-topics", description: "What the essays are about", type: "project", body: "" });
    h.move(SCHOOL_GENERAL, SCHOOL);
    // THE MUTANT: a fresh folder — spaces/general-2 beside the space's own spaces/general, its memory twice.
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general");
    expect(await h.repos.followSpace(SCHOOL_GENERAL)).toMatchObject({ folder: "general", copied: ["essay-topics.md"], left: [] });
    expect(readdirSync(join(h.school, "spaces"))).toEqual(["general"]);
    expect(readdirSync(join(h.school, "spaces", "general")).sort()).toEqual(["MEMORY.md", "deadlines.md", "essay-topics.md"]);
    expect(readFileSync(join(h.school, "spaces", "general", "MEMORY.md"), "utf8")).toBe(
      "- [deadlines](deadlines.md) — When the essays are due\n- [essay-topics](essay-topics.md) — What the essays are about\n");
    expect(readFileSync(join(h.school, "MEMORY.md"), "utf8").match(/spaces\/general\/MEMORY/g)).toHaveLength(1);
    expect(git(h.school, "status", "--porcelain")).toBe("");
    // And away again: Work's folder is its own there too.
    h.move(SCHOOL_GENERAL, WORK);
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general-2");
  });

  it("takes a fresh folder where another space has taken its old name since", async () => {
    const h = await twoProfiles();
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general");
    h.move(SCHOOL_GENERAL, WORK);
    await h.repos.followSpace(SCHOOL_GENERAL);
    // A new School space called General takes the name nothing in School held any more.
    h.move(SCHOOL_OTHER, SCHOOL);
    expect(h.repos.spaceFolderFor(SCHOOL_OTHER)!.folder).toBe("general");
    h.move(SCHOOL_GENERAL, SCHOOL);
    // THE MUTANT: take the old name back whoever holds it — two spaces, one memory directory.
    expect(h.repos.spaceFolderFor(SCHOOL_GENERAL)!.folder).toBe("general-2");
    expect(h.repos.spaceFolderFor(SCHOOL_OTHER)!.folder).toBe("general");
  });

  it("still carries the first folder's memory when the space moves on before a refused carry lands", async () => {
    const h = await twoProfiles();
    await h.repos.saveSpaceMemory(SCHOOL_GENERAL, { name: "deadlines", description: "When the essays are due", type: "project", body: "Fridays." });
    h.move(SCHOOL_GENERAL, WORK);
    writeFileSync(join(h.work, "draft.md"), "the person's own");
    await expect(h.repos.followSpace(SCHOOL_GENERAL)).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    h.move(SCHOOL_GENERAL, HOME);
    // THE MUTANT: the second move writes over what was waiting — School's folder never comes over.
    expect(await h.repos.followSpace(SCHOOL_GENERAL)).toMatchObject({ folder: "general", copied: ["deadlines.md"] });
    expect(readFileSync(join(h.homeRepo, "spaces", "general", "deadlines.md"), "utf8")).toBe(readFileSync(join(h.school, "spaces", "general", "deadlines.md"), "utf8"));
    expect(h.repos.carryPending(SCHOOL_GENERAL)).toBe(false);
  });
});

