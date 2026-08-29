import { execFile } from "node:child_process";

/**
 * Prepended to EVERY git invocation Realm makes. `core.fsmonitor` is repo-LOCAL config naming an
 * arbitrary command git runs for status/diff, so a hostile checkout (a tarball an agent extracted
 * with a crafted .git/config) would otherwise get code execution the moment Realm looked at it.
 * One definition, shared by every caller — a second copy is a second place to forget it.
 */
export const GIT_HARDENING = ["-c", "core.fsmonitor=", "-c", "diff.external="];

/**
 * Flags for every `git diff` Realm runs. `diff.external` is neutralised by GIT_HARDENING above, but
 * `.gitattributes` can also name a per-path diff driver (`diff=foo` + `diff.foo.textconv`), which is
 * a second command git would run while merely *displaying* a file. `--no-ext-diff` and
 * `--no-textconv` refuse both, so reading a diff stays reading.
 *
 * `--no-color` because a config-set `color.diff = always` would otherwise put ANSI escapes into
 * output the parser reads as content.
 */
export const GIT_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

export type GitResult = {
  code: number; stdout: string; stderr: string;
  /** True when `maxBytes` cut the output off. `stdout` then holds a prefix, not the whole answer —
   *  the diff reader's ceiling for a generated-file diff nobody could read anyway. */
  truncated?: boolean;
};
/** How a service invokes git — injectable so tests can assert the exact argv without a real repo.
 *  `env` is MERGED over the inherited environment, for the one caller that needs it: checkpoint capture
 *  sets `GIT_INDEX_FILE` to a scratch copy so `git add` cannot touch the user's index. */
export type GitRun = (cwd: string, args: string[], opts?: { timeoutMs?: number; maxBytes?: number; env?: Record<string, string> }) => Promise<GitResult>;

export const GIT_EXEC_TIMEOUT_MS = 20_000;
/** Push and PR creation talk to a network. Their own timeout, or a slow remote reads as a crash. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;
export const GIT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Run one git command in `cwd` and report its exit code, stdout and stderr. Unlike the probe in
 * git-info, this never rejects on a non-zero exit: worktree work has to *read* git's refusal
 * ("contains modified or untracked files") to tell the user what happened, so the caller decides
 * what a failure means. Only a failure to spawn git at all rejects.
 *
 * Always execFile — paths are user data and must never reach a shell string.
 */
export const gitCapture: GitRun = (cwd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile("git", [...GIT_HARDENING, ...args],
      {
        cwd, timeout: opts.timeoutMs ?? GIT_EXEC_TIMEOUT_MS, encoding: "utf8", maxBuffer: opts.maxBytes ?? GIT_MAX_BYTES,
        // A push to a remote that wants credentials would otherwise block on a terminal prompt no
        // one can see, until the timeout kills it. Failing immediately is an error we can explain.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        // Output past maxBuffer: node kills the child, but the prefix it did capture is exactly what
        // the diff reader wants. Checked BEFORE `killed`, which is also set here.
        if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { resolve({ code: 0, stdout, stderr, truncated: true }); return; }
        // ENOENT (no git on PATH) and a timeout kill are not "git said no" — they are unusable tooling.
        if (e && (e.code === "ENOENT" || e.killed)) { reject(e); return; }
        resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout, stderr });
      });
  });

/** First non-empty line of git's stderr, for an error message a person can act on. */
export function gitReason(r: GitResult): string {
  return r.stderr.split("\n").map((l) => l.replace(/^fatal:\s*/, "").trim()).find((l) => l !== "") ?? `git exited ${r.code}`;
}
