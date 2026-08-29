import { execFile } from "node:child_process";
import type { CommitOutcome, PrOutcome, PushOutcome, ShipResult } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { assertRepoRelative, parseStatus } from "./git-diff";
import { gitCapture, gitReason, GIT_NETWORK_TIMEOUT_MS, type GitResult, type GitRun } from "./git-exec";

/** Running a program that is not git — `gh`, and only `gh`. Injectable so tests point at a stub
 *  script rather than the real CLI: nothing in this repository's test suite may reach GitHub. */
export type RunCommand = (cmd: string, args: string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<GitResult>;

/** ENOENT resolves as exit 127 rather than rejecting: "gh is not installed" is a state this service
 *  reports and degrades from, not a failure of the operation. */
export const runCommand: RunCommand = (cmd, args, cwd, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: opts.timeoutMs ?? GIT_NETWORK_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        if (e?.code === "ENOENT") { resolve({ code: 127, stdout, stderr: `${cmd} is not installed` }); return; }
        if (e?.killed) { reject(e); return; }
        resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout, stderr });
      });
  });

export type ShipInput = {
  cwd: string;
  /** False for a push-only or PR-only retry — the flow the "no upstream" and "no remote" states lead
   *  back into, where the commit has already happened and must not happen twice. */
  commit: boolean;
  message: string;
  push: boolean;
  /** Only ever true because the user was shown "this branch has no upstream" and said yes. */
  setUpstream: boolean;
  openPr: boolean;
};

/**
 * The git write path (Plan 7 W3): staging, and commit → push → open PR as one action.
 *
 * Two rules hold this whole file together:
 *
 *  1. **Every failure is an explained state, not stderr.** `no-remote`, `no-upstream`, `rejected`,
 *     `no-identity` each name a situation the user can act on, and the UI has a sentence and a next
 *     step for each. `failed` is the honest catch-all and is the only state carrying git's own words.
 *  2. **Nothing here can lose committed work.** There is no force-push, no `--force-with-lease`, no
 *     reset, no checkout. `rejected` — the remote moved — therefore has no "fix it" button, because
 *     the fix is a rebase the user should watch happen.
 *
 * On hardening, and where it stops: the READ side (git-info, git-diff) is defended against a hostile
 * checkout's own config, because merely looking at a directory must not execute anything from it.
 * This file is the write side, and `git add` runs `filter.<driver>.clean`, `git commit` runs
 * pre-commit hooks. Those are what committing to a repository MEANS; a user pressing "Commit" has
 * asked for exactly the thing `git commit` does. Realm does not disable them, and must not: a
 * `--no-verify` the user did not ask for is a worse failure than a slow hook.
 */
export class GitWriteService {
  private git: GitRun;
  private run: RunCommand;
  private gh: string;
  constructor(opts: { git?: GitRun; run?: RunCommand; ghCommand?: string } = {}) {
    this.git = opts.git ?? gitCapture;
    this.run = opts.run ?? runCommand;
    this.gh = opts.ghCommand ?? "gh";
  }

  /** The checkout root, so a path from the diff list means the same thing here as it did there. */
  private async root(cwd: string): Promise<string> {
    const r = await this.git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const top = r.stdout.trim();
    if (r.code !== 0 || top === "") throw new RpcError("NOT_A_REPOSITORY", `${cwd} is not a git repository`);
    return top;
  }

  /** Paths arrive over RPC, so they are user input even though the pane got them from `git status`.
   *  `--` stops a path being read as an option; `assertRepoRelative` stops it leaving the checkout. */
  private checkPaths(paths: string[]): void {
    if (paths.length === 0) throw new RpcError("INVALID_PARAMS", "no paths given");
    for (const p of paths) assertRepoRelative(p);
  }

  /** `git add` on exactly these paths. Deletions included: `add` has staged those since git 2.0, so a
   *  file the agent removed is staged by naming it, like every other change. */
  async stage(cwd: string, paths: string[]): Promise<void> {
    this.checkPaths(paths);
    const root = await this.root(cwd);
    const r = await this.git(root, ["add", "--", ...paths]);
    if (r.code !== 0) throw new RpcError("GIT_STAGE_FAILED", gitReason(r));
  }

  /**
   * Take these paths back out of the index, leaving the working tree exactly as it is.
   *
   * `git restore --staged` restores the index entry from HEAD — which a repository with no commits
   * does not have ("fatal: could not resolve HEAD"). There, the only way out of the index is
   * `rm --cached`, which for a never-committed file is the same thing: the file returns to untracked.
   *
   * Neither form touches the file on disk. That is the whole point, and it is why unstaging is safe
   * to offer next to staging while `git checkout --` is nowhere in this service.
   */
  async unstage(cwd: string, paths: string[]): Promise<void> {
    this.checkPaths(paths);
    const root = await this.root(cwd);
    if (await this.hasHead(root)) {
      const r = await this.git(root, ["restore", "--staged", "--", ...paths]);
      if (r.code !== 0) throw new RpcError("GIT_UNSTAGE_FAILED", gitReason(r));
      return;
    }
    const r = await this.git(root, ["rm", "--cached", "-q", "-r", "--", ...paths]);
    if (r.code !== 0) throw new RpcError("GIT_UNSTAGE_FAILED", gitReason(r));
  }

  private async hasHead(root: string): Promise<boolean> {
    return (await this.git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  }

  /** Anything in the index that differs from HEAD. Read from `status` rather than
   *  `diff --cached`, which has no HEAD to compare against in a repository with no commits.
   *  `-uno`, unlike the diff listing's `-uall`: untracked files are by definition not staged, and
   *  enumerating a large ignored-but-unlisted tree to learn that would be work for nothing. */
  private async hasStaged(root: string): Promise<boolean> {
    const r = await this.git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uno"]);
    if (r.code !== 0) return false;
    return parseStatus(r.stdout, new Map()).some((f) => f.staged);
  }

  /**
   * Commit, push, open a PR — as one call, so the user presses one button, and with each step's
   * outcome reported separately, so they can see which one stopped.
   *
   * A step that cannot run is `skipped`, never silently absent: a push with nothing to push and a PR
   * for a branch that never reached the remote are different situations and say so.
   */
  async ship(input: ShipInput): Promise<ShipResult> {
    // Checked before anything runs, and before the root is even resolved: a commit with an empty
    // message is a mistake the user cannot undo from this UI, and git would happily open an editor.
    if (input.commit && input.message.trim() === "") {
      throw new RpcError("COMMIT_EMPTY_MESSAGE", "a commit needs a message");
    }
    const root = await this.root(input.cwd);
    const commit = input.commit ? await this.doCommit(root, input.message) : skipped("commit");
    // A failed commit means the tree is not what the user meant to publish. Pushing anyway would send
    // the previous commit under the impression that this one went out.
    const canPush = input.push && commit.state !== "failed" && commit.state !== "no-identity";
    const push = canPush ? await this.doPush(root, input.setUpstream) : pushOutcome("skipped", { reason: input.push ? "the commit did not happen" : null });
    const onRemote = push.state === "pushed" || push.state === "up-to-date";
    const pr = input.openPr
      ? onRemote ? await this.doPr(root, push.remote, push.branch, input.message) : prOutcome("skipped", { reason: "the branch is not on the remote yet" })
      : prOutcome("skipped", {});
    return { commit, push, pr };
  }

  private async doCommit(root: string, message: string): Promise<CommitOutcome> {
    if (!await this.hasStaged(root)) {
      return { state: "nothing-to-commit", sha: null, subject: null, reason: "nothing is staged" };
    }
    // -m, never an editor: git with no tty and no -m fails in a way nobody can act on. Hooks DO run
    // — a repository's pre-commit hook is part of what committing means — which is why this gets the
    // long timeout: a lint-staged run is routinely slower than the 20s a read is allowed.
    const r = await this.git(root, ["commit", "-m", message], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
    if (r.code !== 0) {
      const text = `${r.stdout}\n${r.stderr}`;
      // git's own words here are four paragraphs of `git config` instructions. The state is the answer.
      if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(text)) {
        return { state: "no-identity", sha: null, subject: null, reason: "git has no user.name / user.email configured for this repository" };
      }
      return { state: "failed", sha: null, subject: null, reason: gitReason(r) };
    }
    const sha = (await this.git(root, ["rev-parse", "HEAD"])).stdout.trim();
    return { state: "committed", sha: sha || null, subject: firstLine(message), reason: null };
  }

  /**
   * Push the current branch, or explain why not.
   *
   * The three states the brief named, in the order they are checked: no remote at all, a branch git
   * has never been told where to send (offer `--set-upstream`, but only when the caller says so), and
   * a remote that has moved ahead.
   */
  private async doPush(root: string, setUpstream: boolean): Promise<PushOutcome> {
    const branch = (await this.git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (branch === "" || branch === "HEAD") {
      return pushOutcome("detached", { branch: null, reason: "HEAD is detached, so there is no branch to push" });
    }
    const remote = await this.preferredRemote(root);
    if (!remote) return pushOutcome("no-remote", { branch, reason: "this repository has no remote configured" });

    const upstream = await this.git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (upstream.code !== 0) {
      if (!setUpstream) {
        return pushOutcome("no-upstream", { remote, branch, reason: `${branch} has never been pushed; ${remote} does not know about it yet` });
      }
      // The explicit form, with the branch named on both sides: `push -u <remote> <branch>` cannot be
      // widened by a push.default the user set to `matching`.
      return this.classifyPush(await this.git(root, ["push", "--set-upstream", remote, `${branch}:${branch}`], { timeoutMs: GIT_NETWORK_TIMEOUT_MS }), remote, branch);
    }
    return this.classifyPush(await this.git(root, ["push", remote, `${branch}:${branch}`], { timeoutMs: GIT_NETWORK_TIMEOUT_MS }), remote, branch);
  }

  /** `origin` when it exists — it is what a PR compare URL and `gh` both assume — else the first. */
  private async preferredRemote(root: string): Promise<string | null> {
    const r = await this.git(root, ["remote"]);
    const names = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (names.length === 0) return null;
    return names.includes("origin") ? "origin" : names[0]!;
  }

  private classifyPush(r: GitResult, remote: string, branch: string): PushOutcome {
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) {
      return pushOutcome(/Everything up-to-date/i.test(text) ? "up-to-date" : "pushed", { remote, branch });
    }
    // git says "[rejected]" for both non-fast-forward and fetch-first. Both mean the same thing to a
    // person: someone else pushed. Deliberately no fix offered — see the class comment.
    if (/\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(text)) {
      return pushOutcome("rejected", { remote, branch, reason: `${remote} has commits ${branch} does not — pull or rebase, then ship again` });
    }
    return pushOutcome("failed", { remote, branch, reason: gitReason(r) });
  }

  /**
   * Open a pull request with `gh`, or hand back a compare URL.
   *
   * The degraded path is the normal path for most machines, so it is not an error: no `gh`, a `gh`
   * that is not signed in, a remote that is not GitHub — each returns a URL the user can open. The
   * only state with no URL is a remote whose address we cannot turn into one, and it says so.
   */
  private async doPr(root: string, remote: string | null, branch: string | null, message: string): Promise<PrOutcome> {
    if (!remote || !branch) return prOutcome("unavailable", { reason: "no remote branch to open a request for" });
    const url = (await this.git(root, ["remote", "get-url", remote])).stdout.trim();
    const repo = parseGitHubRemote(url);
    const base = await this.defaultBase(root, remote);

    const existing = await this.run(this.gh, ["pr", "view", branch, "--json", "url"], root);
    if (existing.code === 0) {
      const found = /"url"\s*:\s*"([^"]+)"/.exec(existing.stdout)?.[1];
      if (found) return prOutcome("existing", { url: found });
    }
    if (existing.code !== 127) {
      const created = await this.run(this.gh, ["pr", "create", "--head", branch, "--base", base, "--title", firstLine(message) || branch, "--body", bodyOf(message)], root);
      const link = /https:\/\/\S+/.exec(created.stdout)?.[0];
      if (created.code === 0 && link) return prOutcome("created", { url: link });
      // gh failed (not signed in, no push access, base branch missing). The compare URL still works.
      if (repo) return prOutcome("compare", { url: compareUrl(repo, base, branch), reason: firstLine(created.stderr) || "gh could not create the request" });
      return prOutcome("unavailable", { reason: firstLine(created.stderr) || "gh could not create the request" });
    }
    if (repo) return prOutcome("compare", { url: compareUrl(repo, base, branch), reason: "gh is not installed — open this link to create the request" });
    return prOutcome("unavailable", { reason: `${remote} is not a GitHub remote, so Realm cannot address a pull request for it` });
  }

  /** The remote's own default branch, from the ref git already has. No network call: `remote show`
   *  would contact the server, and this runs on a button press. */
  private async defaultBase(root: string, remote: string): Promise<string> {
    const r = await this.git(root, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    const ref = r.stdout.trim();
    if (r.code === 0 && ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
    return "main";
  }
}

/** `owner/repo` from the four address forms GitHub hands out. Null for anything else — GitLab,
 *  Bitbucket, a bare path — which is a `compare` we must not fabricate. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Branch names may contain `/`, `#` and worse; `#` in particular would truncate the URL. Each path
 *  segment is encoded, and the separators are put back. */
const encodeRef = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
export function compareUrl(repo: { owner: string; repo: string }, base: string, head: string): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/compare/${encodeRef(base)}...${encodeRef(head)}?expand=1`;
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
/** Everything after the subject line, as a PR body. Empty when the message is one line. */
const bodyOf = (s: string) => s.split("\n").slice(1).join("\n").trim();

const skipped = (_step: "commit"): CommitOutcome => ({ state: "skipped", sha: null, subject: null, reason: null });
const pushOutcome = (state: PushOutcome["state"], o: Partial<PushOutcome> = {}): PushOutcome =>
  ({ state, remote: o.remote ?? null, branch: o.branch ?? null, reason: o.reason ?? null });
const prOutcome = (state: PrOutcome["state"], o: Partial<PrOutcome> = {}): PrOutcome =>
  ({ state, url: o.url ?? null, reason: o.reason ?? null });
