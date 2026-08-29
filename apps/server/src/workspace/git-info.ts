import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { GitInfo } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { GIT_HARDENING } from "./git-exec";

const GIT_TIMEOUT_MS = 3000;
export const GIT_INFO_TTL_MS = 3000;

/** How the service invokes git — injectable so tests can assert the exact argv (hardening flags)
 *  and count spawns without real repositories. */
export type RunGit = (cwd: string, args: string[]) => Promise<string>;

/** Run one git command in `cwd`; resolves stdout, rejects on any failure (missing git, not a repo,
 *  timeout). Always execFile — cwd is user data and must never reach a shell string. */
const execGit: RunGit = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => {
      // stderr is deliberately dropped: git failure details never leak into RPC results.
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/**
 * `workspace.gitInfo` backend: summarises a working tree by shelling out to git, with a small
 * per-cwd TTL cache plus in-flight dedup, so the renderer's event-driven refreshes (status
 * transitions, space activation) share one probe instead of stacking git spawns.
 */
export class GitInfoService {
  private cache = new Map<string, { at: number; value: GitInfo | null }>();
  /** One compute per cwd at a time: concurrent gets await the same promise (4 spawns, not 4×N). */
  private inflight = new Map<string, Promise<GitInfo | null>>();
  private ttlMs: number;
  private now: () => number;
  private runGit: RunGit;
  constructor(opts: { ttlMs?: number; now?: () => number; runGit?: RunGit } = {}) {
    this.ttlMs = opts.ttlMs ?? GIT_INFO_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.runGit = opts.runGit ?? execGit;
  }

  async get(cwd: string): Promise<GitInfo | null> {
    if (!isAbsolute(cwd)) throw new RpcError("INVALID_PARAMS", "cwd must be an absolute path");
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const pending = this.inflight.get(cwd);
    if (pending) return pending;
    const p = this.compute(cwd)
      .then((value) => { this.cache.set(cwd, { at: this.now(), value }); return value; })
      .finally(() => this.inflight.delete(cwd));
    this.inflight.set(cwd, p);
    return p;
  }

  /** Every invocation carries GIT_HARDENING (`core.fsmonitor` off — see git-exec.ts for why).
   *  Defence-in-depth: this probe must stay a pure reader of untrusted directories. */
  private git(cwd: string, args: string[]): Promise<string> {
    return this.runGit(cwd, [...GIT_HARDENING, ...args]);
  }

  /** Null when cwd is not a repo, git is missing, or the basic queries fail. The two optional
   *  queries (diff vs HEAD, upstream counts) degrade to zeros on their own instead of nulling the
   *  whole result — a repo with no upstream is still a repo. */
  private async compute(cwd: string): Promise<GitInfo | null> {
    try {
      const branch = (await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const [status, shortstat, counts] = await Promise.all([
        // --no-optional-locks is a GLOBAL git option (it precedes the subcommand): a read-only
        // probe must never take the index lock and contend with the user's own git commands.
        this.git(cwd, ["--no-optional-locks", "status", "--porcelain"]),
        this.git(cwd, ["diff", "--shortstat", "HEAD"]).catch(() => ""), // e.g. an empty repo has no HEAD
        this.git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => ""), // no upstream → 0/0
      ]);
      const dirty = status.split("\n").filter((l) => l.trim() !== "").length;
      // " 2 files changed, 2 insertions(+), 1 deletion(-)" — either clause may be absent; empty output = clean.
      const additions = Number(/(\d+) insertion/.exec(shortstat)?.[1] ?? 0);
      const deletions = Number(/(\d+) deletion/.exec(shortstat)?.[1] ?? 0);
      // "--left-right --count upstream...HEAD" prints "<only-in-upstream>\t<only-in-HEAD>" = behind, ahead.
      const [behind = 0, ahead = 0] = counts.trim().split(/\s+/).map(Number);
      return { branch, additions, deletions, dirty, ahead: ahead || 0, behind: behind || 0 };
    } catch {
      return null;
    }
  }
}
