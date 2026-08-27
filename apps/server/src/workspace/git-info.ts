import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { GitInfo } from "@realm/contracts";
import { RpcError } from "../store/rows";

const GIT_TIMEOUT_MS = 3000;
export const GIT_INFO_TTL_MS = 3000;

/** Run one git command in `cwd`; resolves stdout, rejects on any failure (missing git, not a repo,
 *  timeout). Always execFile — cwd is user data and must never reach a shell string. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => {
      // stderr is deliberately dropped: git failure details never leak into RPC results.
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * `workspace.gitInfo` backend: summarises a working tree by shelling out to git, with a small
 * per-cwd TTL cache so the renderer's event-driven refreshes (status transitions, space activation)
 * never stack redundant git invocations.
 */
export class GitInfoService {
  private cache = new Map<string, { at: number; value: GitInfo | null }>();
  private ttlMs: number;
  private now: () => number;
  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? GIT_INFO_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async get(cwd: string): Promise<GitInfo | null> {
    if (!isAbsolute(cwd)) throw new RpcError("INVALID_PARAMS", "cwd must be an absolute path");
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await this.compute(cwd);
    this.cache.set(cwd, { at: this.now(), value });
    return value;
  }

  /** Null when cwd is not a repo, git is missing, or the basic queries fail. The two optional
   *  queries (diff vs HEAD, upstream counts) degrade to zeros on their own instead of nulling the
   *  whole result — a repo with no upstream is still a repo. */
  private async compute(cwd: string): Promise<GitInfo | null> {
    try {
      const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const [status, shortstat, counts] = await Promise.all([
        git(cwd, ["status", "--porcelain"]),
        git(cwd, ["diff", "--shortstat", "HEAD"]).catch(() => ""), // e.g. an empty repo has no HEAD
        git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).catch(() => ""), // no upstream → 0/0
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
