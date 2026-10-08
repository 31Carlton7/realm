import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { MEMORY_REPO_INITIAL_INDEX } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { gitCapture, type GitRun } from "../workspace/git-exec";
import { MemoryRepoService, secretShapeIn } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const P = { scope: "profile", id: PROFILE } as const;

function harness(o: { git?: GitRun; toolsEnabled?: (spaceId: string) => boolean } = {}) {
  const home = tempDir("realm-memrepo-");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const repos = new MemoryRepoService({
    home, settings, git: o.git, toolsEnabled: o.toolsEnabled,
    scopes: { profileIdOf: (s) => (s === SPACE ? PROFILE : null) },
    forbiddenRoots: () => [project],
    committerName: async () => "Tester",
    today: () => "2026-10-08",
  });
  return { home, project, settings, repos };
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const commits = (repo: string): number => Number(git(repo, "rev-list", "--count", "HEAD").trim());
const tracked = (repo: string): string[] => git(repo, "ls-files").split("\n").filter(Boolean);

async function made() {
  const h = harness();
  const state = await h.repos.create(P);
  return { ...h, repo: state.path };
}

describe("MemoryRepoService create / attach", () => {
  it("creates the spec's repo under Realm's home, and a second create reuses it", async () => {
    const { home, repos } = harness();
    const a = await repos.create(P);
    expect(a.path).toBe(join(home, "memory", "repos", `profile-${PROFILE}`));
    expect(a).toMatchObject({ valid: true, clean: true, scope: "profile", ownerId: PROFILE, reason: null, lastCommitSubject: "Create memory repo" });
    expect(readFileSync(join(a.path, "MEMORY.md"), "utf8")).toBe(MEMORY_REPO_INITIAL_INDEX);
    // THE MUTANT: init again on an existing folder — a second commit, or a refusal, either way not idempotent.
    const b = await repos.create(P);
    expect(b.head).toBe(a.head);
    expect(commits(a.path)).toBe(1);
  });

  it("refuses a folder that holds something else, and leaves it untouched", async () => {
    const { home, repos } = harness();
    const dir = join(home, "stuff");
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.txt"), "mine");
    await expect(repos.create(P, dir)).rejects.toMatchObject({ code: "MEMORY_REPO_NOT_EMPTY" });
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(repos.config(P)).toBeNull();
  });

  it("attaches only a repo of its own with MEMORY.md at the top", async () => {
    const { home, repos } = harness();
    const plain = join(home, "plain");
    mkdirSync(plain);
    await expect(repos.attach(P, plain)).rejects.toMatchObject({ code: "MEMORY_REPO_INVALID" });
    const outer = join(home, "outer");
    mkdirSync(join(outer, "inner"), { recursive: true });
    git(outer, "init", "-q");
    writeFileSync(join(outer, "inner", "MEMORY.md"), "# Memory\n");
    // A folder INSIDE some other repository is not a memory repo, even with a MEMORY.md in it.
    await expect(repos.attach(P, join(outer, "inner"))).rejects.toThrow(/inside the git repository/);
    writeFileSync(join(outer, "MEMORY.md"), "# Memory\n");
    const s = await repos.attach(P, outer);
    expect(s.valid).toBe(true);
    // Attaching writes nothing: the files are still untracked, so the repo reads as not clean.
    expect(s.clean).toBe(false);
    expect(s.reason).toMatch(/uncommitted/);
  });

  it("refuses a repo inside a space's checkout", async () => {
    const { project, repos } = harness();
    // THE MUTANT: skip the guard — memory lands in the project, which the spec forbids first of all.
    await expect(repos.create(P, join(project, "memory"))).rejects.toMatchObject({ code: "MEMORY_REPO_FORBIDDEN" });
    expect(existsSync(join(project, "memory"))).toBe(false);
  });

  it("puts a repo in the fallback root when Realm's own home is inside a space's folder, and says it moved", async () => {
    const outer = tempDir("realm-memrepo-projects-");
    const home = join(outer, "preview", "home");
    mkdirSync(home, { recursive: true });
    const fallback = join(tempDir("realm-memrepo-fallback-"), "memory-repos");
    const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
    const repos = new MemoryRepoService({ home, settings, forbiddenRoots: () => [outer], fallbackRoot: fallback, committerName: async () => "Tester" });
    // THE MUTANT: no second place — the default under the home is refused, and making a team dead-ends.
    expect(repos.placeFor(P)).toEqual({ path: join(fallback, `profile-${PROFILE}`), moved: true });
    const made = await repos.create(P);
    expect(made.valid).toBe(true);
    expect(realpathSync(made.path)).toBe(realpathSync(join(fallback, `profile-${PROFILE}`)));
    expect(existsSync(join(home, "memory"))).toBe(false);
  });

  it("with nowhere allowed, refuses in words that say why and what to do", async () => {
    const outer = tempDir("realm-memrepo-projects-");
    const home = join(outer, "home");
    mkdirSync(home, { recursive: true });
    const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
    const repos = new MemoryRepoService({ home, settings, forbiddenRoots: () => [outer], fallbackRoot: join(outer, "elsewhere") });
    expect(repos.placeFor(P)).toBeNull();
    const err = await repos.create(P).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "MEMORY_REPO_FORBIDDEN" });
    expect((err as Error).message).toMatch(/one of your spaces works in/);
    expect((err as Error).message).toMatch(/Its second place, .*elsewhere, is inside one of them too/);
    expect((err as Error).message).toMatch(/Choose a folder outside your projects/);
    // A folder the person chose outside every project is taken.
    const chosen = join(tempDir("realm-memrepo-chosen-"), "versed-memory");
    expect((await repos.create(P, chosen)).valid).toBe(true);
  });

  it("keeps the default under Realm's home when it is allowed", () => {
    const { home, repos } = harness();
    expect(repos.placeFor(P)).toEqual({ path: join(home, "memory", "repos", `profile-${PROFILE}`), moved: false });
  });

  it("detaches without touching the folder", async () => {
    const { repos, repo } = await made();
    repos.detach(P);
    expect(repos.config(P)).toBeNull();
    expect(existsSync(join(repo, "MEMORY.md"))).toBe(true);
    expect(await repos.state(P)).toBeNull();
  });
});

describe("MemoryRepoService writes", () => {
  it("refuses to write into a dirty repo and changes nothing", async () => {
    const { repos, repo } = await made();
    writeFileSync(join(repo, "scratch.md"), "half-done");
    // THE MUTANT: drop the porcelain check — the save commits on top of the user's unfinished work.
    await expect(repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION })).rejects.toMatchObject({ code: "MEMORY_REPO_DIRTY" });
    await expect(repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION })).rejects.toThrow(/scratch\.md/);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(MEMORY_REPO_INITIAL_INDEX);
    expect(commits(repo)).toBe(1);
  });

  it("makes one commit per add, replace and remove, staged by path only", async () => {
    let racing = false;
    // Files that change while the save is in flight — another process writing into the repo: a new
    // one, and one git already tracks. Both pass the clean check, then must stay out of the commit.
    const git_: GitRun = async (cwd, args, opts) => {
      const r = await gitCapture(cwd, args, opts);
      if (racing && args.includes("status")) {
        writeFileSync(join(cwd, "stray.md"), "someone else's");
        writeFileSync(join(cwd, "notes.md"), "edited by someone else\n");
      }
      return r;
    };
    const { repos, repo } = await (async () => { const h = harness({ git: git_ }); const s = await h.repos.create(P); return { ...h, repo: s.path }; })();
    await repos.writeFile(P, "notes.md", "mine\n");
    racing = true;
    const added = await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION });
    expect(added).toMatchObject({ changed: true, file: "MEMORY.md" });
    // THE MUTANTS: `git add -A`, or `commit -a` with no pathspec — someone else's edit rides into the
    // memory commit under the agent's name.
    expect(git(repo, "show", "--name-only", "--format=").split("\n").filter(Boolean)).toEqual(["MEMORY.md"]);
    expect(tracked(repo)).toEqual(["MEMORY.md", "notes.md"]);
    expect(git(repo, "status", "--porcelain")).toBe(" M notes.md\n?? stray.md\n");
    racing = false;
    git(repo, "checkout", "--", "notes.md");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(`# Memory\n\n- Prefers tabs [source: realm:session/${SESSION}; added: 2026-10-08]\n\n## Index\n- [[notes]]\n`);
    expect(git(repo, "log", "-1", "--format=%s|%an|%ae")).toBe("Remember Prefers tabs|Tester|realm@localhost\n");

    execFileSync("rm", [join(repo, "stray.md")]);
    await repos.edit(P, { op: "replace", match: "Prefers tabs", entry: "Prefers two-space indents", sessionId: SESSION });
    await repos.edit(P, { op: "remove", match: "two-space", sessionId: SESSION });
    expect(commits(repo)).toBe(5);
    expect(git(repo, "log", "--format=%s", "-3").split("\n").filter(Boolean)).toEqual(["Forget two-space", "Update Prefers two-space indents", "Remember Prefers tabs"]);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(`${MEMORY_REPO_INITIAL_INDEX}- [[notes]]\n`);
  });

  it("stamps the calling session as the source, whatever the caller wrote", async () => {
    const { repos, repo } = await made();
    await repos.edit(P, { op: "add", entry: "Ships on Fridays [source: realm:session/SOMEONE-ELSE; added: 2025-01-01]", sessionId: SESSION });
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain(`- Ships on Fridays [source: realm:session/${SESSION}; added: 2025-01-01]`);
  });

  it("links a new topic file from the index in the same commit", async () => {
    const { repos, repo } = await made();
    await repos.edit(P, { file: "[[projects/payments]]", op: "add", entry: "Launch is 2026-10-15", sessionId: SESSION });
    expect(readFileSync(join(repo, "projects", "payments.md"), "utf8")).toBe(`# payments\n\n- Launch is 2026-10-15 [source: realm:session/${SESSION}; added: 2026-10-08]\n`);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe("# Memory\n\n## Index\n- [[projects/payments]]\n");
    expect(commits(repo)).toBe(2);
    expect(git(repo, "show", "--name-only", "--format=").split("\n").filter(Boolean).sort()).toEqual(["MEMORY.md", "projects/payments.md"]);
    await repos.writeFile(P, "metrics/keep_rate.sql", "select 1;\n");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain("- [[metrics/keep_rate.sql]]");
  });

  it("refuses paths that leave the repo, by .. or by symlink", async () => {
    const { home, repos, repo } = await made();
    const outside = join(home, "secret.txt");
    writeFileSync(outside, "do not read");
    for (const p of ["../secret.txt", "a/../../secret.txt", ".git/config"]) {
      expect(() => repos.read(repo, p)).toThrow(/outside the memory repo/);
      await expect(repos.writeFile(P, p, "x")).rejects.toMatchObject({ code: "MEMORY_PATH" });
    }
    symlinkSync(outside, join(repo, "link.md"));
    git(repo, "add", "link.md");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "link");
    // THE MUTANT: check only the joined path, not where it really lands — the read follows the link out.
    expect(() => repos.read(repo, "link")).toThrow(/leads outside/);
    await expect(repos.edit(P, { file: "link.md", op: "add", entry: "x", sessionId: SESSION })).rejects.toMatchObject({ code: "MEMORY_PATH" });
    expect(readFileSync(outside, "utf8")).toBe("do not read");
  });

  it("refuses a secret, and saves nothing", async () => {
    const { repos, repo } = await made();
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    await expect(repos.edit(P, { op: "add", entry: `The API key is ${key}`, sessionId: SESSION })).rejects.toMatchObject({ code: "MEMORY_SECRET" });
    await expect(repos.writeFile(P, "env.md", `KEY=${key}\n`)).rejects.toMatchObject({ code: "MEMORY_SECRET" });
    expect(commits(repo)).toBe(1);
    expect(secretShapeIn("ghp_" + "x".repeat(36))).toBe("a GitHub token");
    expect(secretShapeIn("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("a private key");
    expect(secretShapeIn("the deploy key lives in 1Password under Deploy")).toBeNull();
  });

  it("serializes two concurrent saves into two commits", async () => {
    const { repos, repo } = await made();
    // THE MUTANT: drop the lock — the second save sees the first one's unstaged file as dirty, or both
    // read the same MEMORY.md and the later write erases the earlier fact.
    await Promise.all([
      repos.edit(P, { op: "add", entry: "Uses pnpm", sessionId: SESSION }),
      repos.edit(P, { op: "add", entry: "Deploys on Fridays", sessionId: SESSION }),
    ]);
    expect(commits(repo)).toBe(3);
    const index = readFileSync(join(repo, "MEMORY.md"), "utf8");
    expect(index).toContain("Uses pnpm");
    expect(index).toContain("Deploys on Fridays");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("puts everything back when the commit itself fails", async () => {
    const failing: GitRun = async (cwd, args, opts) => (args.includes("commit") && !args.includes("Create memory repo")
      ? { code: 1, stdout: "", stderr: "fatal: no space left on device" } : gitCapture(cwd, args, opts));
    const h = harness({ git: failing });
    const repo = (await h.repos.create(P)).path;
    await expect(h.repos.edit(P, { file: "topic", op: "add", entry: "x", sessionId: SESSION })).rejects.toThrow(/no space left/);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, "topic.md"))).toBe(false);
  });
});

describe("MemoryRepoService reading", () => {
  it("reads by link, lists a folder, and searches every word case-insensitively", async () => {
    const { repos, repo } = await made();
    await repos.edit(P, { file: "projects/payments", op: "add", entry: "Stripe webhooks retry for 3 days", sessionId: SESSION });
    expect(repos.read(repo, "[[projects/payments]]")).toContain("Stripe webhooks");
    expect(repos.read(repo, "projects")).toBe("payments.md");
    expect(repos.search(repo, "WEBHOOKS stripe")).toEqual([{ path: "projects/payments.md", line: 3, text: expect.stringContaining("Stripe webhooks retry") }]);
    expect(repos.search(repo, "webhooks paypal")).toEqual([]);
    // Reading works on a dirty repo; only writes wait for it to be clean.
    writeFileSync(join(repo, "wip.md"), "- wip");
    expect(repos.read(repo, "MEMORY")).toContain("[[projects/payments]]");
  });
});

describe("MemoryRepoService.activeFor", () => {
  it("follows the profile's repo into a space, unless the space opted out or has the tools off", async () => {
    let tools = true;
    const h = harness({ toolsEnabled: () => tools });
    expect(h.repos.activeFor(SPACE)).toEqual([]);
    const { path } = await h.repos.create(P);
    expect(h.repos.activeFor(SPACE)).toEqual([{ scope: "profile", ownerId: PROFILE, path }]);
    h.repos.setInherited(SPACE, false);
    expect(h.repos.activeFor(SPACE)).toEqual([]);
    h.repos.setInherited(SPACE, true);
    tools = false;
    expect(h.repos.activeFor(SPACE)).toEqual([]);
  });

  it("cuts a long MEMORY.md at the cap", async () => {
    const { repos, repo } = await made();
    writeFileSync(join(repo, "MEMORY.md"), "x".repeat(25_000));
    const [r] = repos.indexesFor(SPACE);
    expect(r!.truncated).toBe(true);
    expect(r!.index.length).toBe(20_000);
  });
});
