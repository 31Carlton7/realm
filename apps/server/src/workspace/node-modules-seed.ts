import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Runs one command in `cwd`, rejecting on a non-zero exit. Injectable so tests can fail it or race it. */
export type SeedRun = (cwd: string, cmd: string, args: string[]) => Promise<void>;

/** Cloning Realm's 1.8 GB node_modules takes about 9 s; the slack is for a Mac under load. */
const SEED_TIMEOUT_MS = 5 * 60_000;

const run: SeedRun = (cwd, cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: SEED_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });

export type SeedOutcome = "cloned" | "not-macos" | "nothing-to-clone" | "lockfiles-differ" | "other-volume" | "clone-failed" | "install-won";

/** The workspace package directories a pnpm lockfile has `node_modules` for: its `importers:` keys. */
export function lockfileImporters(lock: string): string[] {
  const block = /^importers:\n([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(lock)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([^\s'][^:]*|'[^']+'):(?: \{\})?$/gm)].map((m) => m[1].replace(/^'|'$/g, ""));
}

/**
 * Give a new worktree the source checkout's node_modules as APFS clones (`cp -c`), sharing their
 * blocks: the root one, with what install scripts left there (Electron's dist), and each workspace
 * package's, whose pnpm symlinks are relative and so resolve inside the worktree. No install runs,
 * so no project script runs and no pnpm can collide with one an agent starts.
 *
 * Only when the two `pnpm-lock.yaml`s are byte-identical, so the source's trees are what an install
 * would build. `cp -c` across volumes would be a full copy, so a source on another volume is skipped.
 *
 * Safe to race an install: every tree is cloned under `<dir>/.realm-seed-<rand>/node_modules`
 * (ignored wherever `node_modules/` is) and renamed into place only while `<dir>/node_modules` is
 * still missing. If the root one appeared first, an install owns the worktree and every clone is
 * discarded.
 */
export async function seedNodeModules(source: string, worktree: string, opts: { platform?: NodeJS.Platform; run?: SeedRun } = {}): Promise<SeedOutcome> {
  if ((opts.platform ?? process.platform) !== "darwin") return "not-macos";
  if (!existsSync(join(source, "node_modules")) || existsSync(join(worktree, "node_modules"))) return "nothing-to-clone";
  const sourceLock = join(source, "pnpm-lock.yaml");
  const worktreeLock = join(worktree, "pnpm-lock.yaml");
  if (!existsSync(sourceLock) || !existsSync(worktreeLock)) return "lockfiles-differ";
  const lock = readFileSync(sourceLock);
  if (!lock.equals(readFileSync(worktreeLock))) return "lockfiles-differ";
  if (statSync(source).dev !== statSync(worktree).dev) return "other-volume";

  const dirs = lockfileImporters(lock.toString()).filter((dir) => existsSync(join(source, dir, "node_modules")));
  const temp = `.realm-seed-${randomBytes(4).toString("hex")}`;
  const exec = opts.run ?? run;
  try {
    await Promise.all(dirs.map(async (dir) => {
      mkdirSync(join(worktree, dir, temp), { recursive: true });
      await exec(worktree, "cp", ["-c", "-R", join(source, dir, "node_modules"), join(worktree, dir, temp, "node_modules")]);
    }));
    // Root first: once an install has made it, the install owns the worktree's packages too.
    if (existsSync(join(worktree, "node_modules"))) return "install-won";
    for (const dir of dirs) {
      if (!existsSync(join(worktree, dir, "node_modules"))) renameSync(join(worktree, dir, temp, "node_modules"), join(worktree, dir, "node_modules"));
    }
    return "cloned";
  } catch (e) {
    console.warn(`[worktrees] node_modules clone into ${worktree} failed:`, (e as Error).message);
    return "clone-failed";
  } finally {
    for (const dir of dirs) rmSync(join(worktree, dir, temp), { recursive: true, force: true });
  }
}
