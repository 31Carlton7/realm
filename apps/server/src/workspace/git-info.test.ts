import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { GitInfoService } from "./git-info";

/** Run git in `cwd` with identity/config pinned so the host machine's config never leaks in. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const dir = tempDir("realm-git-");
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

describe("GitInfoService", () => {
  // A repo per suite is enough — tests that mutate state make their own.
  let repo: string;
  beforeAll(() => { repo = makeRepo(); });

  it("rejects a non-absolute cwd", async () => {
    const svc = new GitInfoService();
    await expect(svc.get("relative/path")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("returns null for a directory that is not a git repo", async () => {
    const dir = tempDir("realm-notgit-");
    expect(await new GitInfoService().get(dir)).toBeNull();
  });

  it("returns null for a cwd that does not exist at all", async () => {
    expect(await new GitInfoService().get(join(tmpdir(), "realm-definitely-missing-xyz"))).toBeNull();
  });

  it("clean repo with no upstream: branch name, all counters zero", async () => {
    const info = await new GitInfoService().get(repo);
    expect(info).toEqual({ branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 });
  });

  it("dirty repo: +N −M from the diff, dirty counts untracked files too", async () => {
    const dir = makeRepo();
    // "two" -> "TWO" (1 del + 1 ins) and a trailing new line (1 ins) => +2 −1.
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    const info = await new GitInfoService().get(dir);
    expect(info).toMatchObject({ branch: "main", additions: 2, deletions: 1, dirty: 2 });
  });

  it("ahead/behind come from the upstream in the right order", async () => {
    const upstream = makeRepo();
    const dir = tempDir("realm-clone-");
    git(dir, "clone", upstream, "clone");
    const clone = join(dir, "clone");
    writeFileSync(join(clone, "b.txt"), "local\n");
    git(clone, "add", ".");
    git(clone, "commit", "-m", "local work");
    const info = await new GitInfoService().get(clone);
    expect(info).toMatchObject({ ahead: 1, behind: 0, dirty: 0 });
  });

  it("caches per cwd for the TTL, then recomputes", async () => {
    const dir = makeRepo();
    let now = 0;
    const svc = new GitInfoService({ ttlMs: 3000, now: () => now });
    expect((await svc.get(dir))?.dirty).toBe(0);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    now = 2999;
    expect((await svc.get(dir))?.dirty).toBe(0); // still cached — the change is invisible
    now = 3001;
    expect((await svc.get(dir))?.dirty).toBe(1); // TTL expired: recomputed
  });

  /** Scripted runner: answers like a clean repo, records every argv, counts probe passes. */
  function fakeRunner(delayMs = 0) {
    const calls: string[][] = [];
    let computes = 0;
    const runGit = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const cmd = args.filter((a) => a !== "-c" && !a.startsWith("core.") && !a.startsWith("diff.") && a !== "--no-optional-locks")[0];
      if (cmd === "rev-parse") computes++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (cmd === "rev-parse") return "main\n";
      if (cmd === "rev-list") return "0\t0\n";
      return "";
    };
    return { calls, runGit, computeCount: () => computes };
  }

  it("hardening: every git invocation forces core.fsmonitor off; status never takes optional locks", async () => {
    const { calls, runGit } = fakeRunner();
    const svc = new GitInfoService({ runGit });
    expect(await svc.get("/some/abs/cwd")).toEqual({ branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 });
    expect(calls).toHaveLength(4); // rev-parse, status, diff, rev-list
    // A hostile repo-local .git/config can point core.fsmonitor OR diff.external at an arbitrary
    // executable — every single argv must neutralise both before anything else.
    for (const args of calls) expect(args.slice(0, 4)).toEqual(["-c", "core.fsmonitor=", "-c", "diff.external="]);
    const status = calls.find((a) => a.includes("status"))!;
    // --no-optional-locks is a global option and must precede the subcommand.
    expect(status.indexOf("--no-optional-locks")).toBeGreaterThanOrEqual(0);
    expect(status.indexOf("--no-optional-locks")).toBeLessThan(status.indexOf("status"));
  });

  it("concurrent gets for one cwd share a single in-flight compute (no stacked git spawns)", async () => {
    const { runGit, computeCount, calls } = fakeRunner(10);
    const svc = new GitInfoService({ runGit });
    const [a, b, c] = await Promise.all([svc.get("/abs"), svc.get("/abs"), svc.get("/abs")]);
    expect(computeCount()).toBe(1);
    expect(calls).toHaveLength(4); // one probe, not 3×4
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("hardening flags survive against a real git binary (repo behaviour unchanged)", async () => {
    // The suite's other tests also run through execGit; this one pins the pairing explicitly.
    const info = await new GitInfoService().get(repo);
    expect(info).toMatchObject({ branch: "main" });
  });

  it("cache entries are keyed by cwd — one repo's info never answers for another", async () => {
    const clean = makeRepo();
    const dirty = makeRepo();
    writeFileSync(join(dirty, "a.txt"), "changed\n");
    const svc = new GitInfoService();
    expect((await svc.get(clean))?.dirty).toBe(0);
    expect((await svc.get(dirty))?.dirty).toBe(1);
  });
});
