import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { seedNodeModules, type SeedRun } from "./node-modules-seed";

const LOCK = "lockfileVersion: '9.0'\n";

/** A source checkout with node_modules and a worktree beside it, each with its own lockfile. */
function checkouts(sourceLock: string | null, worktreeLock: string | null): { source: string; worktree: string } {
  const source = tempDir("realm-seed-src-");
  const worktree = tempDir("realm-seed-wt-");
  mkdirSync(join(source, "node_modules", "left-pad"), { recursive: true });
  if (sourceLock !== null) writeFileSync(join(source, "pnpm-lock.yaml"), sourceLock);
  if (worktreeLock !== null) writeFileSync(join(worktree, "pnpm-lock.yaml"), worktreeLock);
  return { source, worktree };
}

/** Records each command; `fail` names the one that exits non-zero. `cp` leaves a partial tree. */
function recorder(fail?: "cp" | "pnpm"): { run: SeedRun; calls: string[] } {
  const calls: string[] = [];
  const run: SeedRun = async (cwd, cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "cp") mkdirSync(join(cwd, "node_modules"), { recursive: true });
    if (cmd === fail) throw new Error(`${cmd} exited 1`);
  };
  return { run, calls };
}

describe("seedNodeModules", () => {
  it("clones node_modules and relinks offline when the lockfiles match byte for byte", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("cloned");
    expect(calls).toEqual([
      `cp -c -R ${join(source, "node_modules")} ${join(worktree, "node_modules")}`,
      "pnpm install --offline --frozen-lockfile",
    ]);
  });

  it("does nothing when the lockfiles differ, even by a trailing newline", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK + "\n");
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("lockfiles-differ");
    expect(calls).toEqual([]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("does nothing when either side has no lockfile", async () => {
    const { run, calls } = recorder();
    const noWorktreeLock = checkouts(LOCK, null);
    const noSourceLock = checkouts(null, LOCK);
    expect(await seedNodeModules(noWorktreeLock.source, noWorktreeLock.worktree, { platform: "darwin", run })).toBe("lockfiles-differ");
    expect(await seedNodeModules(noSourceLock.source, noSourceLock.worktree, { platform: "darwin", run })).toBe("lockfiles-differ");
    expect(calls).toEqual([]);
  });

  it("removes a partial clone and skips the install when cp fails", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run, calls } = recorder("cp");
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("clone-failed");
    expect(calls).toHaveLength(1);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("removes the clone when the offline install fails", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run } = recorder("pnpm");
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("install-failed");
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("does nothing off macOS, where cp has no -c", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "linux", run })).toBe("not-macos");
    expect(calls).toEqual([]);
  });

  it("leaves a worktree that already has node_modules alone", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    mkdirSync(join(worktree, "node_modules"));
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("nothing-to-clone");
    expect(calls).toEqual([]);
  });
});
