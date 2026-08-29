import { execFile } from "node:child_process";

/**
 * Prepended to EVERY git invocation Realm makes. `core.fsmonitor` is repo-LOCAL config naming an
 * arbitrary command git runs for status/diff, so a hostile checkout (a tarball an agent extracted
 * with a crafted .git/config) would otherwise get code execution the moment Realm looked at it.
 * One definition, shared by every caller — a second copy is a second place to forget it.
 */
export const GIT_HARDENING = ["-c", "core.fsmonitor="];

export type GitResult = { code: number; stdout: string; stderr: string };
/** How a service invokes git — injectable so tests can assert the exact argv without a real repo. */
export type GitRun = (cwd: string, args: string[]) => Promise<GitResult>;

export const GIT_EXEC_TIMEOUT_MS = 20_000;

/**
 * Run one git command in `cwd` and report its exit code, stdout and stderr. Unlike the probe in
 * git-info, this never rejects on a non-zero exit: worktree work has to *read* git's refusal
 * ("contains modified or untracked files") to tell the user what happened, so the caller decides
 * what a failure means. Only a failure to spawn git at all rejects.
 *
 * Always execFile — paths are user data and must never reach a shell string.
 */
export const gitCapture: GitRun = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile("git", [...GIT_HARDENING, ...args], { cwd, timeout: GIT_EXEC_TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        // ENOENT (no git on PATH) and a timeout kill are not "git said no" — they are unusable tooling.
        if (e && (e.code === "ENOENT" || e.killed)) { reject(e); return; }
        resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout, stderr });
      });
  });

/** First non-empty line of git's stderr, for an error message a person can act on. */
export function gitReason(r: GitResult): string {
  return r.stderr.split("\n").map((l) => l.replace(/^fatal:\s*/, "").trim()).find((l) => l !== "") ?? `git exited ${r.code}`;
}
