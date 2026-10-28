import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryRepoService } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const P = { scope: "profile", id: PROFILE } as const;
const KEY = `sk-${"a".repeat(30)}`;

async function made() {
  const home = tempDir("realm-memclaude-");
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const names: Record<string, string> = { [SPACE]: "Realm", [OTHER]: "Stora" };
  const repos = new MemoryRepoService({
    home, settings,
    scopes: { profileIdOf: (s) => (s in names ? PROFILE : null), spaceIdsOf: () => [SPACE, OTHER], spaceNameOf: (s) => names[s] ?? null },
    committerName: async () => "Tester",
  });
  const { path: repo } = await repos.create(P);
  const dir = repos.spaceFolderFor(SPACE)!.dir;
  /** What Claude does with its memory directory: plain file writes, never a commit. */
  const claudeWrites = (file: string, text: string, at = dir): void => { mkdirSync(at, { recursive: true }); writeFileSync(join(at, file), text); };
  return { home, settings, repos, repo, dir, claudeWrites };
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const status = (repo: string): string => git(repo, "status", "--porcelain", "--untracked-files=all");
const subjects = (repo: string, n: number): string[] => git(repo, "log", "--format=%s", `-${n}`).split("\n").filter(Boolean);

describe("committing what Claude wrote in a space folder", () => {
  it("commits the folder's changes as one commit, with the folder's link in the root index, and only those paths", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("uses-pnpm.md", "---\nname: uses-pnpm\n---\n\nThe repo uses pnpm.\n");
    claudeWrites("MEMORY.md", "- [uses-pnpm](uses-pnpm.md) — the repo uses pnpm\n");
    writeFileSync(join(repo, "draft.md"), "the person's own, uncommitted");
    const r = await repos.commitSpaceFolder(SPACE, `Save what Claude remembered in “Fix the build”\n\nSession: realm:session/${SESSION}`);
    expect(r).toMatchObject({ committed: ["spaces/realm/MEMORY.md", "spaces/realm/uses-pnpm.md"], held: [] });
    expect(git(repo, "log", "-1", "--format=%B").trim()).toBe(`Save what Claude remembered in “Fix the build”\n\nSession: realm:session/${SESSION}`);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual(["MEMORY.md", "spaces/realm/MEMORY.md", "spaces/realm/uses-pnpm.md"]);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain("- [[spaces/realm/MEMORY]]");
    // THE MUTANT: `git add -A` / an unlimited commit — the person's draft rides along.
    expect(status(repo)).toBe("?? draft.md\n");
    expect((await repos.commitSpaceFolder(SPACE, "again"))!.sha).toBeNull();
  });

  it("commits a fact Claude deleted, and leaves the root index alone while it has changes of someone's own", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("a.md", "a\n");
    claudeWrites("MEMORY.md", "- [a](a.md) — a\n");
    await repos.commitSpaceFolder(SPACE, "first");
    rmSync(join(repos.spaceFolderFor(SPACE)!.dir, "a.md"));
    claudeWrites("MEMORY.md", "");
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n\nmine, mid-edit\n");
    await repos.commitSpaceFolder(SPACE, "second");
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n").filter(Boolean)).toEqual(["M\tspaces/realm/MEMORY.md", "D\tspaces/realm/a.md"]);
    expect(status(repo)).toBe(" M MEMORY.md\n");
  });

  it("leaves a file shaped like a credential uncommitted, names it, and commits the rest", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("deploy.md", "Deploys go out on Fridays.\n");
    claudeWrites("keys.md", `The staging key is ${KEY}\n`);
    const r = (await repos.commitSpaceFolder(SPACE, "Save"))!;
    // THE MUTANT: no scan — the key is committed, and with sync on, pushed.
    expect(r.committed).toEqual(["spaces/realm/deploy.md"]);
    expect(r.held).toEqual([{ path: "spaces/realm/keys.md", reason: "it looks like it holds an API key, and memory never holds credentials" }]);
    expect(git(repo, "ls-files")).not.toContain("keys.md");
    const st = (await repos.state(P))!;
    expect(st.clean).toBe(true);
    expect(st.reason).toBe("spaces/realm/keys.md stays uncommitted: it looks like it holds an API key, and memory never holds credentials. Edit or delete it");
  });

  it("sweeps every space folder of the repo at once", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("a.md", "a\n");
    claudeWrites("b.md", "b\n", repos.spaceFolderFor(OTHER)!.dir);
    const r = (await repos.commitSpaceFolders(P))!;
    expect(r.committed.sort()).toEqual(["spaces/realm/a.md", "spaces/stora/b.md"]);
    expect(subjects(repo, 1)).toEqual(["Save memory Claude left uncommitted"]);
    expect(status(repo)).toBe("");
  });
});

describe("Claude's uncommitted memory never wedges a save", () => {
  it("commits what Claude left before an agent's save, then saves", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("uses-pnpm.md", "The repo uses pnpm.\n");
    // THE MUTANT: the clean check before the sweep — this save is refused as MEMORY_REPO_DIRTY.
    expect((await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION })).changed).toBe(true);
    expect(subjects(repo, 2)).toEqual(["Remember Prefers tabs", "Save memory Claude left uncommitted"]);
    expect(status(repo)).toBe("");
  });

  it("saves past a file that had to stay out, unless the save would write over it", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("keys.md", `The staging key is ${KEY}\n`);
    expect((await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION })).changed).toBe(true);
    expect((await repos.saveSpaceMemory(SPACE, { name: "uses-pnpm", description: "The repo uses pnpm", type: "project", body: "" })).changed).toBe(true);
    await expect(repos.writeBatch(P, new Map([["spaces/realm/keys.md", "rotated\n"]]), "Overwrite")).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    expect(status(repo)).toBe("?? spaces/realm/keys.md\n");
  });

  it("does nothing with nothing to write: a file Claude is still writing waits for its turn, and a dirty repo is no error", async () => {
    const { repos, repo, claudeWrites } = await made();
    await repos.writeBatch(P, new Map([["notes.md", "n\n"]]), "Seed");
    const before = git(repo, "rev-list", "--count", "HEAD").trim();
    claudeWrites("half-written.md", "Half a thought.\n");
    writeFileSync(join(repo, "draft.md"), "the person's own, uncommitted");
    // THE MUTANT: the clean check — with the commit of Claude's leftovers in it — ahead of the empty check.
    expect(await repos.writeBatch(P, new Map([["notes.md", "n\n"]]), "Again")).toMatchObject({ changed: false, sha: null });
    expect(git(repo, "rev-list", "--count", "HEAD").trim()).toBe(before);
    expect(status(repo)).toBe("?? draft.md\n?? spaces/realm/half-written.md\n");
  });

  it("plans a save on top of what Claude left, so the root link that commit adds stays", async () => {
    const { repos, repo, claudeWrites } = await made();
    claudeWrites("uses-pnpm.md", "The repo uses pnpm.\n");
    claudeWrites("MEMORY.md", "- [uses-pnpm](uses-pnpm.md) — the repo uses pnpm\n");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).not.toContain("spaces/realm");
    await repos.saveSpaceMemory(OTHER, { name: "deploys", description: "Deploys go out on Fridays", type: "project", body: "" });
    const root = readFileSync(join(repo, "MEMORY.md"), "utf8");
    // THE MUTANT: plan first, then commit what Claude left — the link that commit adds is written over.
    expect(root).toContain("- [[spaces/realm/MEMORY]]");
    expect(root).toContain("- [[spaces/stora/MEMORY]]");
    expect(subjects(repo, 2)).toEqual(["Remember deploys", "Save memory Claude left uncommitted"]);
    expect(status(repo)).toBe("");
  });

  it("keeps the rule whole for anything else, and in a team's repo", async () => {
    const { repos, repo, settings } = await made();
    writeFileSync(join(repo, "draft.md"), "mine");
    await expect(repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION })).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    rmSync(join(repo, "draft.md"));
    const team = { scope: "space", id: SPACE } as const;
    const { path: teamRepo } = await repos.create(team, join(repo, "..", "team"));
    mkdirSync(join(teamRepo, "spaces"), { recursive: true });
    writeFileSync(join(teamRepo, "spaces", "notes.md"), "a teammate's, uncommitted");
    // A team repo is written only through the tools: nothing of anyone's is committed on their behalf.
    await expect(repos.edit(team, { op: "add", entry: "Ships Fridays", sessionId: SESSION })).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    expect(settings.get(`memory.spaceFolder:${SPACE}`)).toBe("realm");
  });
});
