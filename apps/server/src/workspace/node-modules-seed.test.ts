import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { lockfileImporters, seedNodeModules, type SeedRun } from "./node-modules-seed";

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.6.0
        version: 5.9.3

  packages/ui:
    dependencies:
      react:
        specifier: 19.0.0
        version: 19.0.0

  packages/empty: {}

packages:

  react@19.0.0:
    resolution: {integrity: sha512-x}
`;

/**
 * A source checkout with node_modules at the root and in packages/ui, and a worktree beside it.
 * `installedLock` is what pnpm recorded in the source's `node_modules/.pnpm/lock.yaml`; by default the
 * source's own lockfile, as after an install.
 */
function checkouts(sourceLock: string | null, worktreeLock: string | null, installedLock: string | null = sourceLock): { source: string; worktree: string } {
  const source = tempDir("realm-seed-src-");
  const worktree = tempDir("realm-seed-wt-");
  mkdirSync(join(source, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(source, "packages", "ui", "node_modules", "react"), { recursive: true });
  mkdirSync(join(worktree, "packages", "ui"), { recursive: true });
  if (sourceLock !== null) writeFileSync(join(source, "pnpm-lock.yaml"), sourceLock);
  if (worktreeLock !== null) writeFileSync(join(worktree, "pnpm-lock.yaml"), worktreeLock);
  if (installedLock !== null) {
    mkdirSync(join(source, "node_modules", ".pnpm"), { recursive: true });
    writeFileSync(join(source, "node_modules", ".pnpm", "lock.yaml"), installedLock);
  }
  return { source, worktree };
}

/** Plays `cp -c -R <from> <to>` by making `<to>`, after `during` (an install racing it) has run. */
function recorder(opts: { fail?: boolean; during?: () => void } = {}): { run: SeedRun; calls: string[] } {
  const calls: string[] = [];
  const run: SeedRun = async (_cwd, cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    opts.during?.();
    if (opts.fail) throw new Error(`${cmd} exited 1`);
    mkdirSync(join(args.at(-1)!, "cloned"), { recursive: true });
  };
  return { run, calls };
}

/** What an install would leave: a node_modules holding a file the clone never has. */
function install(dir: string): void {
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".modules.yaml"), "installed\n");
}

const seedTemps = (worktree: string) =>
  [worktree, join(worktree, "packages", "ui")].flatMap((dir) => readdirSync(dir).filter((name) => name.startsWith(".realm-seed-")));

describe("lockfileImporters", () => {
  it("lists the importers block's keys and nothing from the packages block", () => {
    expect(lockfileImporters(LOCK)).toEqual([".", "packages/ui", "packages/empty"]);
  });
});

describe("seedNodeModules", () => {
  it("clones the root and every workspace package's node_modules, and runs no install", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("cloned");
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith(`cp -c -R ${source}`))).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "cloned"))).toBe(true);
    expect(existsSync(join(worktree, "packages", "ui", "node_modules", "cloned"))).toBe(true);
    expect(seedTemps(worktree)).toEqual([]);
  });

  it.runIf(process.platform === "darwin")("with the real cp, a package's pnpm symlinks resolve inside the worktree", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    mkdirSync(join(source, "node_modules", ".pnpm", "react@19.0.0", "node_modules", "react"), { recursive: true });
    writeFileSync(join(source, "node_modules", ".pnpm", "react@19.0.0", "node_modules", "react", "index.js"), "");
    rmSync(join(source, "packages", "ui", "node_modules", "react"), { recursive: true });
    symlinkSync("../../../node_modules/.pnpm/react@19.0.0/node_modules/react", join(source, "packages", "ui", "node_modules", "react"));
    expect(await seedNodeModules(source, worktree)).toBe("cloned");
    expect(realpathSync(join(worktree, "packages", "ui", "node_modules", "react", "index.js")))
      .toBe(realpathSync(join(worktree, "node_modules", ".pnpm", "react@19.0.0", "node_modules", "react", "index.js")));
    expect(seedTemps(worktree)).toEqual([]);
  });

  it("clones under a temp name and renames it into place, so node_modules never holds a partial tree", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const seen: boolean[] = [];
    const { run, calls } = recorder({ during: () => seen.push(existsSync(join(worktree, "node_modules"))) });
    await seedNodeModules(source, worktree, { platform: "darwin", run });
    expect(seen).toEqual([false, false]);
    expect(calls[0]).toMatch(/ \S+\/\.realm-seed-[0-9a-f]+\/node_modules$/);
  });

  it("leaves an install's node_modules alone and discards every clone when the install got there first", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run } = recorder({ during: () => install(worktree) });
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("install-won");
    expect(readFileSync(join(worktree, "node_modules", ".modules.yaml"), "utf8")).toBe("installed\n");
    expect(existsSync(join(worktree, "node_modules", "cloned"))).toBe(false);
    expect(existsSync(join(worktree, "packages", "ui", "node_modules"))).toBe(false);
    expect(seedTemps(worktree)).toEqual([]);
  });

  it("keeps a package's node_modules an install already made, and still places the others", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run } = recorder({ during: () => install(join(worktree, "packages", "ui")) });
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("cloned");
    expect(existsSync(join(worktree, "node_modules", "cloned"))).toBe(true);
    expect(readdirSync(join(worktree, "packages", "ui", "node_modules"))).toEqual([".modules.yaml"]);
    expect(seedTemps(worktree)).toEqual([]);
  });

  it("does nothing when the lockfiles differ, even by a trailing newline", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK + "\n");
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("lockfiles-differ");
    expect(calls).toEqual([]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("does nothing when the source's node_modules was installed from another lockfile, as after a pull with no install", async () => {
    const pulled = LOCK.replace("version: 5.9.3", "version: 5.9.4");
    const { source, worktree } = checkouts(pulled, pulled, LOCK);
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("source-stale");
    expect(calls).toEqual([]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("does nothing when the source's node_modules has no record of the lockfile it was installed from", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK, null);
    const { run, calls } = recorder();
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("source-stale");
    expect(calls).toEqual([]);
  });

  it("does nothing when either side has no lockfile", async () => {
    const { run, calls } = recorder();
    const noWorktreeLock = checkouts(LOCK, null);
    const noSourceLock = checkouts(null, LOCK);
    expect(await seedNodeModules(noWorktreeLock.source, noWorktreeLock.worktree, { platform: "darwin", run })).toBe("lockfiles-differ");
    expect(await seedNodeModules(noSourceLock.source, noSourceLock.worktree, { platform: "darwin", run })).toBe("lockfiles-differ");
    expect(calls).toEqual([]);
  });

  it("removes the temp clones and places nothing when cp fails", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    const { run } = recorder({ fail: true });
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("clone-failed");
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(seedTemps(worktree)).toEqual([]);
  });

  it("waits for every cp before removing the temp clones when one fails early", async () => {
    const { source, worktree } = checkouts(LOCK, LOCK);
    let slowCp: Promise<void> | null = null;
    const run: SeedRun = async (_cwd, _cmd, args) => {
      if (args.at(-1)!.startsWith(join(worktree, "packages"))) {
        slowCp = new Promise((resolve) => setTimeout(resolve, 50)).then(() => { mkdirSync(join(args.at(-1)!, "cloned"), { recursive: true }); });
        return slowCp;
      }
      throw new Error("cp exited 1");
    };
    expect(await seedNodeModules(source, worktree, { platform: "darwin", run })).toBe("clone-failed");
    await slowCp;
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(seedTemps(worktree)).toEqual([]);
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
