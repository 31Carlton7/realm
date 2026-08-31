import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore } from "../store/sessions";
import { PortAllocator } from "../workspace/ports";
import { WorktreeService } from "../workspace/worktrees";
import { EnvironmentService } from "./service";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
/** Turn a space's folder — a plain directory, as Realm makes it — into a real repository. */
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init");
}

let db: Db; let home: string; let spaces: SpacesStore; let envs: EnvironmentsStore; let sessions: SessionsStore;
let svc: EnvironmentService; let spaceId: string; let folder: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "realm-envsvc-"));
  db = openDatabase(join(home, "realm.db"));
  const p = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  spaces = new SpacesStore(db, home);
  envs = new EnvironmentsStore(db);
  sessions = new SessionsStore(db);
  const space = spaces.create({ profileId: p.id, name: "Work", icon: "folder" });
  spaceId = space.id; folder = space.folderPath;
  svc = new EnvironmentService({
    environments: envs, spaces,
    worktrees: new WorktreeService(home),
    ports: new PortAllocator(db, { probe: async () => true }),
  });
});

describe("EnvironmentService.createWorktree", () => {
  it("creates the directory AND the row together, with a branch and a port block", async () => {
    initRepo(folder);
    const env = await svc.createWorktree({ spaceId, title: "Fix the login flow", from: null });
    expect(env.kind).toBe("worktree");
    expect(env.branch).toBe("realm/fix-the-login-flow");
    expect(env.path).toBe(join(home, "worktrees", spaceId, "fix-the-login-flow"));
    expect(existsSync(env.path)).toBe(true);
    expect(env.portBlockStart).not.toBeNull();
    expect(envs.get(env.id)!.portBlockStart).toBe(env.portBlockStart);
  });

  it("leaves nothing behind when the row cannot be written", async () => {
    initRepo(folder);
    // A row already claims the path the name loop is about to choose (nothing on disk, no such
    // branch), so `git worktree add` succeeds and the (space_id, path) unique index then rejects the
    // insert. This is the only window in which a half-made environment could exist.
    const doomed = join(home, "worktrees", spaceId, "unwind");
    envs.create({ spaceId, path: doomed, kind: "checkout" });
    await expect(svc.createWorktree({ spaceId, title: "unwind", from: null })).rejects.toThrow();
    expect(existsSync(doomed)).toBe(false);                       // the half-made directory is gone
    expect(git(folder, "worktree", "list")).not.toContain(doomed); // and so is its registration
    expect(git(folder, "branch", "--list", "realm/unwind").trim()).toBe(""); // and its branch
    expect(envs.list(spaceId).some((e) => e.kind === "worktree")).toBe(false);
  });

  it("refuses when the space folder is a plain directory", async () => {
    await expect(svc.createWorktree({ spaceId, title: "x", from: null }))
      .rejects.toMatchObject({ code: "NOT_A_REPOSITORY" });
    expect(envs.list(spaceId).some((e) => e.kind === "worktree")).toBe(false);
  });

  it("refuses an unknown space", async () => {
    await expect(svc.createWorktree({ spaceId: "01HZZZZZZZZZZZZZZZZZZZZZZZ", title: "x", from: null }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to branch off another space's checkout", async () => {
    initRepo(folder);
    const p2 = new ProfilesStore(db).create({ name: "Q", icon: "x", color: "#000" });
    const other = spaces.create({ profileId: p2.id, name: "Other", icon: "folder" });
    const otherEnv = envs.ensurePrimary(other.id);
    await expect(svc.createWorktree({ spaceId, title: "x", from: otherEnv.id }))
      .rejects.toMatchObject({ code: "ENVIRONMENT_WRONG_SPACE" });
  });

  it("gives each worktree its own port block", async () => {
    initRepo(folder);
    const a = await svc.createWorktree({ spaceId, title: "a", from: null });
    const b = await svc.createWorktree({ spaceId, title: "b", from: null });
    expect(a.portBlockStart).not.toBe(b.portBlockStart);
  });
});

describe("EnvironmentService.removeWorktree", () => {
  const primary = () => envs.ensurePrimary(spaceId);

  // MUTANT: removal reachable for `primary`. Pointing `git worktree remove` at a space's own folder
  // is the destructive bug the `kind` column exists to make unreachable.
  it("refuses a space's primary checkout, and touches nothing on disk", async () => {
    initRepo(folder);
    const env = primary();
    await expect(svc.removeWorktree(env.id, null)).rejects.toMatchObject({ code: "ENVIRONMENT_PRIMARY" });
    await expect(svc.removeWorktree(env.id, { dirtyFiles: 0, unpushedCommits: 0 })).rejects.toMatchObject({ code: "ENVIRONMENT_PRIMARY" });
    expect(existsSync(join(folder, "a.txt"))).toBe(true);
    expect(envs.get(env.id)).not.toBeNull();
  });

  // MUTANT: removal reachable for `checkout` — a working copy the user made and Realm merely noticed.
  it("refuses a checkout Realm did not create, and touches nothing on disk", async () => {
    const userRepo = mkdtempSync(join(tmpdir(), "realm-user-repo-"));
    initRepo(userRepo);
    const env = envs.ensureAt(spaceId, userRepo, "checkout");
    await expect(svc.removeWorktree(env.id, null)).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_WORKTREE" });
    await expect(svc.removeWorktree(env.id, { dirtyFiles: 99, unpushedCommits: 99 })).rejects.toMatchObject({ code: "ENVIRONMENT_NOT_WORKTREE" });
    expect(existsSync(join(userRepo, "a.txt"))).toBe(true);
    expect(git(userRepo, "branch", "--list", "main").trim()).not.toBe("");
  });

  it("refuses while a session still runs there", async () => {
    initRepo(folder);
    const env = await svc.createWorktree({ spaceId, title: "busy", from: null });
    sessions.create({ spaceId, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: env.id, title: "t" });
    await expect(svc.removeWorktree(env.id, null)).rejects.toMatchObject({ code: "ENVIRONMENT_IN_USE" });
    expect(existsSync(env.path)).toBe(true);
  });

  it("removes a clean worktree and its row", async () => {
    // Cloned so HEAD is on a remote and there are no unpushed commits.
    const origin = mkdtempSync(join(tmpdir(), "realm-origin-"));
    initRepo(origin);
    execFileSync("git", ["clone", "-q", origin, folder + "-clone"], { encoding: "utf8" });
    const src = envs.ensureAt(spaceId, folder + "-clone", "checkout");
    const env = await svc.createWorktree({ spaceId, title: "clean", from: src.id });
    await svc.removeWorktree(env.id, null);
    expect(existsSync(env.path)).toBe(false);
    expect(envs.get(env.id)).toBeNull();
  });

  it("keeps the row when git refuses, so a worktree is never orphaned", async () => {
    initRepo(folder);
    const env = await svc.createWorktree({ spaceId, title: "dirty", from: null });
    writeFileSync(join(env.path, "work.txt"), "hours of work\n");
    await expect(svc.removeWorktree(env.id, null)).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect(envs.get(env.id)).not.toBeNull();
    expect(existsSync(join(env.path, "work.txt"))).toBe(true);
  });

  it("frees the port block for reuse once the row is gone", async () => {
    const origin = mkdtempSync(join(tmpdir(), "realm-origin2-"));
    initRepo(origin);
    execFileSync("git", ["clone", "-q", origin, folder + "-clone2"], { encoding: "utf8" });
    const src = envs.ensureAt(spaceId, folder + "-clone2", "checkout");
    const env = await svc.createWorktree({ spaceId, title: "recycle", from: src.id });
    const block = env.portBlockStart;
    await svc.removeWorktree(env.id, null);
    const next = await svc.createWorktree({ spaceId, title: "after", from: src.id });
    expect(next.portBlockStart).toBe(block);
  });
});

describe("EnvironmentService.worktreeStatus", () => {
  it("reports the hazard and that removal is allowed", async () => {
    initRepo(folder);
    const env = await svc.createWorktree({ spaceId, title: "s", from: null });
    writeFileSync(join(env.path, "b.txt"), "x");
    const st = await svc.worktreeStatus(env.id);
    expect(st).toMatchObject({ environmentId: env.id, branch: "realm/s", present: true, dirtyFiles: 1, unpushedCommits: 1, removable: true, blockedBy: null });
  });

  it("reports primary and checkout as not removable, and never prices them", async () => {
    initRepo(folder);
    writeFileSync(join(folder, "uncommitted.txt"), "x");
    const st = await svc.worktreeStatus(primaryId());
    expect(st.removable).toBe(false);
    expect(st.blockedBy).toBe("ENVIRONMENT_PRIMARY");
    // A dirty-file count for someone else's working copy would read as an offer to clear it.
    expect(st.dirtyFiles).toBe(0);
  });

  it("reports a worktree with a live session as blocked but still priced", async () => {
    initRepo(folder);
    const env = await svc.createWorktree({ spaceId, title: "held", from: null });
    sessions.create({ spaceId, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: env.id, title: "t" });
    const st = await svc.worktreeStatus(env.id);
    expect(st.removable).toBe(false);
    expect(st.blockedBy).toBe("ENVIRONMENT_IN_USE");
    expect(st.unpushedCommits).toBe(1);
  });

  function primaryId(): string { return envs.ensurePrimary(spaceId).id; }
});
