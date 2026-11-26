import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Runs one command in `cwd`, rejecting on a non-zero exit. Injectable so tests can fail either step. */
export type SeedRun = (cwd: string, cmd: string, args: string[]) => Promise<void>;

/** Cloning Realm's 1.8 GB node_modules takes about 9 s; the slack is for a Mac under load. */
const SEED_TIMEOUT_MS = 5 * 60_000;

const run: SeedRun = (cwd, cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: SEED_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });

export type SeedOutcome = "cloned" | "not-macos" | "nothing-to-clone" | "lockfiles-differ" | "other-volume" | "clone-failed" | "install-failed";

/**
 * Give a new worktree the source checkout's node_modules as an APFS clone, sharing its blocks,
 * including what install scripts left there (Electron's dist) that a fresh install would not.
 *
 * Only when the two `pnpm-lock.yaml`s are byte-identical, so the source's tree is what an install
 * would build; `pnpm install --offline` then only relinks the workspace packages' own
 * node_modules. Anything else leaves the worktree as `git worktree add` made it, with no
 * node_modules, which is why a failed clone or install is removed. `cp -c` across volumes would
 * be a full copy, so a source on another volume is skipped.
 */
export async function seedNodeModules(source: string, worktree: string, opts: { platform?: NodeJS.Platform; run?: SeedRun } = {}): Promise<SeedOutcome> {
  if ((opts.platform ?? process.platform) !== "darwin") return "not-macos";
  const sourceModules = join(source, "node_modules");
  const worktreeModules = join(worktree, "node_modules");
  if (!existsSync(sourceModules) || existsSync(worktreeModules)) return "nothing-to-clone";
  const sourceLock = join(source, "pnpm-lock.yaml");
  const worktreeLock = join(worktree, "pnpm-lock.yaml");
  if (!existsSync(sourceLock) || !existsSync(worktreeLock)) return "lockfiles-differ";
  if (!readFileSync(sourceLock).equals(readFileSync(worktreeLock))) return "lockfiles-differ";
  if (statSync(sourceModules).dev !== statSync(worktree).dev) return "other-volume";

  const exec = opts.run ?? run;
  try {
    await exec(worktree, "cp", ["-c", "-R", sourceModules, worktreeModules]);
  } catch (e) {
    rmSync(worktreeModules, { recursive: true, force: true });
    console.warn(`[worktrees] node_modules clone into ${worktree} failed:`, (e as Error).message);
    return "clone-failed";
  }
  try {
    await exec(worktree, "pnpm", ["install", "--offline", "--frozen-lockfile"]);
  } catch (e) {
    rmSync(worktreeModules, { recursive: true, force: true });
    console.warn(`[worktrees] pnpm install --offline in ${worktree} failed:`, (e as Error).message);
    return "install-failed";
  }
  return "cloned";
}
