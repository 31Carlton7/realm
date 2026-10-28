import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
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
    expect(settings.get(`memory.spaceFolder:${SPACE}`)).toBe("realm");
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
