import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import type { Environment, MethodName, PrDetail, PrFiles } from "@realm/contracts";
import { MobileCalls } from "@realm/remote";
import { RpcError } from "../store/rows";
import { GitDiffService } from "../workspace/git-diff";
import { GitInfoService } from "../workspace/git-info";
import { GitWriteService } from "../workspace/git-write";
import { MobileApi, MobileError } from "./api";
import { channel, fakeRpc, session } from "./api.test-fakes";
import { RpcCallError, type RpcPort } from "./rpc-port";

/**
 * The phone's diff pane and PR view (`session.checkout` … `session.pr`) against real repositories: the
 * desktop's own git services stand behind the fake RPC, a bare repository is the remote, and `gh` is a
 * shell script. Nothing here reaches a network.
 */

const IDENT = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8" });

function makeRepo(): string {
  const dir = tempDir("realm-phone-diff-");
  git(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "b.txt"), "keep\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const ENV = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const env = (path: string): Environment => ({ id: ENV, spaceId: "s1", path } as Environment);

/** The desktop's handlers for the calls these phone calls make, over real services, with their errors
 *  carried as the real port carries them. */
function rig(cwd: string, o: { gh?: string; more?: Partial<Record<MethodName, (p: never) => unknown>> } = {}) {
  const diff = new GitDiffService();
  const info = new GitInfoService({ ttlMs: 0 });
  const write = new GitWriteService({ ghCommand: o.gh ?? join(cwd, ".no-such-gh") });
  const asked: string[] = [];
  const handlers: Partial<Record<MethodName, (p: never) => unknown>> = {
    "environments.get": () => env(cwd),
    "workspace.diff": (p: { cwd: string }) => diff.summary(p.cwd),
    "workspace.gitInfo": (p: { cwd: string }) => info.get(p.cwd),
    "workspace.fileDiff": (p: { cwd: string; path: string; staged: boolean }) => { asked.push(`fileDiff ${p.path}`); return diff.file(p.cwd, p.path, p.staged); },
    "workspace.stage": async (p: { cwd: string; paths: string[] }) => { asked.push(`stage ${p.paths.join(",")}`); await write.stage(p.cwd, p.paths); return { ok: true }; },
    "workspace.unstage": async (p: { cwd: string; paths: string[] }) => { await write.unstage(p.cwd, p.paths); return { ok: true }; },
    "workspace.ship": (p: never) => { asked.push(`ship ${JSON.stringify(p)}`); return write.ship(p); },
    "workspace.pullRequest": async (p: { cwd: string }) => ({ url: await write.pullRequestUrl(p.cwd) }),
    ...o.more,
  };
  const wrapped = Object.fromEntries(Object.entries(handlers).map(([m, h]) => [m, async (p: never) => {
    try { return await h!(p); } catch (e) { throw e instanceof RpcError ? new RpcCallError(e.code, e.message) : e; }
  }]));
  const rpc = fakeRpc({ sessions: [session("s", "s1", { cwd })], items: [] }, wrapped as never);
  return { rpc, asked };
}

const api = () => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: "/nonexistent", dev: false });
async function attempt(rpc: RpcPort, method: string, params: unknown): Promise<{ ok: true; result: any } | { ok: false; code: string; message: string }> {
  try { return { ok: true, result: await api().handle(channel(rpc), method, params) }; }
  catch (e) { if (e instanceof MobileError) return { ok: false, code: e.code, message: e.message }; throw e; }
}
const parses = (method: keyof typeof MobileCalls, result: unknown) => expect(MobileCalls[method].result.safeParse(result).success).toBe(true);

describe("session.checkout", () => {
  it("lists the session's checkout as the diff pane does: each side of the index, and the branch", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
    git(repo, "add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(repo, "new.md"), "# new\n");
    const got = await attempt(rig(repo).rpc, "session.checkout", { id: "s" });
    if (!got.ok) throw new Error(got.message);
    parses("session.checkout", got.result);
    expect(got.result.checkout).toMatchObject({ branch: "main", ahead: 0, behind: 0, totalFiles: 2, truncated: false });
    expect(got.result.checkout.files).toEqual([
      { path: "a.txt", oldPath: null, status: "modified", staged: true, unstaged: true, binary: false, additions: 3, deletions: 1 },
      { path: "new.md", oldPath: null, status: "untracked", staged: false, unstaged: true, binary: false, additions: 0, deletions: 0 },
    ]);
  });

  it("answers null for a folder that is not a repository", async () => {
    const got = await attempt(rig(tempDir("realm-phone-plain-")).rpc, "session.checkout", { id: "s" });
    expect(got).toEqual({ ok: true, result: { checkout: null } });
  });
});

describe("session.checkoutDiff", () => {
  it("pages one side of a listed file's patch, and heads a new file's from /dev/null", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "one\n2\n");
    writeFileSync(join(repo, "new.md"), "# new\n");
    const { rpc } = rig(repo);
    const changed = await attempt(rpc, "session.checkoutDiff", { id: "s", path: "a.txt" });
    if (!changed.ok) throw new Error(changed.message);
    parses("session.checkoutDiff", changed.result);
    expect(changed.result).toMatchObject({ status: "modified", staged: false, next: null, lines: ["--- a/a.txt", "+++ b/a.txt", "@@ -1,2 +1,2 @@", " one", "-two", "+2"] });
    const untracked = await attempt(rpc, "session.checkoutDiff", { id: "s", path: "new.md" });
    expect(untracked).toMatchObject({ ok: true, result: { status: "untracked", lines: ["--- /dev/null", "+++ b/new.md", "@@ -0,0 +1,1 @@", "+# new"] } });
  });

  it("says a patch past the desktop's ceiling was cut, with the ceiling's own words", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "big.txt"), Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n"));
    const got = await attempt(rig(repo).rpc, "session.checkoutDiff", { id: "s", path: "big.txt" });
    expect(got).toMatchObject({ ok: true, result: { truncated: true, truncatedReason: "over 4000 lines" } });
  });

  it("refuses a path the checkout does not list, and never asks git about it", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const { rpc, asked } = rig(repo);
    // THE MUTANT: diff whatever path the phone names — then a phone reads any file on the Mac.
    for (const path of ["b.txt", "../a.txt", "/etc/passwd", ".env"]) {
      expect(await attempt(rpc, "session.checkoutDiff", { id: "s", path }), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(asked).toEqual([]);
  });
});

describe("session.stage and session.unstage", () => {
  it("stages and unstages listed files, answering the checkout as it is after", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new.md"), "# new\n");
    const { rpc } = rig(repo);
    const staged = await attempt(rpc, "session.stage", { id: "s", paths: ["a.txt", "new.md"] });
    if (!staged.ok) throw new Error(staged.message);
    parses("session.stage", staged.result);
    expect(staged.result.checkout.files.map((f: { path: string; staged: boolean; unstaged: boolean }) => [f.path, f.staged, f.unstaged])).toEqual([["a.txt", true, false], ["new.md", true, false]]);
    const back = await attempt(rpc, "session.unstage", { id: "s", paths: ["new.md"] });
    if (!back.ok) throw new Error(back.message);
    expect(back.result.checkout.files.find((f: { path: string }) => f.path === "new.md")).toMatchObject({ status: "untracked", staged: false });
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("a.txt");
  });

  it("refuses a path the checkout does not list, and stages nothing of the rest", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const { rpc, asked } = rig(repo);
    expect(await attempt(rpc, "session.stage", { id: "s", paths: ["a.txt", "../outside"] })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await attempt(rpc, "session.stage", { id: "s", paths: [] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(asked).toEqual([]);
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("");
  });
});

describe("session.ship", () => {
  it("commits, says the branch has no upstream, then pushes and sets one when asked", async () => {
    const repo = makeRepo();
    const bare = tempDir("realm-phone-remote-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(repo, "remote", "add", "origin", bare);
    git(repo, "checkout", "-qb", "feat/phone");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const { rpc, asked } = rig(repo);
    await attempt(rpc, "session.stage", { id: "s", paths: ["a.txt"] });

    const first = await attempt(rpc, "session.ship", { id: "s", message: "Change a from the phone", push: true, openPr: true });
    if (!first.ok) throw new Error(first.message);
    parses("session.ship", first.result);
    expect(first.result).toMatchObject({ commit: { state: "committed", subject: "Change a from the phone" }, push: { state: "no-upstream", remote: "origin", branch: "feat/phone" }, pr: { state: "skipped" } });
    // The ship is logged against the session's own checkout, by its environment.
    expect(asked.find((a) => a.startsWith("ship"))).toContain(`"environmentId":"${ENV}"`);

    const retry = await attempt(rpc, "session.ship", { id: "s", commit: false, push: true, setUpstream: true, openPr: false });
    expect(retry).toMatchObject({ ok: true, result: { commit: { state: "skipped" }, push: { state: "pushed" } } });
    expect(git(bare, "log", "--format=%s", "feat/phone").split("\n")[0]).toBe("Change a from the phone");
  });

  /** A branch git has never pushed, its remote a bare repository, and a `gh` that records each call and
   *  opens #42 on `pr create`. */
  const newBranch = () => {
    const repo = makeRepo();
    const bare = tempDir("realm-phone-remote-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-qb", "feat/phone");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const dir = tempDir("realm-phone-gh-");
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$1 $2" in\n  "pr create") echo https://github.com/acme/widgets/pull/42 ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(gh, 0o755);
    return { repo, bare, gh, calls: () => readFileSync(join(dir, "calls"), "utf8") };
  };
  /** What the phone's Commit, push & PR sends after its one confirm (ShipStep.commitAndPublish). */
  const commitPushAndPr = { id: "s", commit: true, message: "Change a from the phone\n\nOne confirm.", push: true, setUpstream: true, openPr: true };

  it("commits a new branch, pushes it with its upstream set and opens the pull request in one ship", async () => {
    const { repo, bare, gh, calls } = newBranch();
    const { rpc, asked } = rig(repo, { gh });
    await attempt(rpc, "session.stage", { id: "s", paths: ["a.txt"] });

    const got = await attempt(rpc, "session.ship", commitPushAndPr);
    if (!got.ok) throw new Error(got.message);
    parses("session.ship", got.result);
    expect(got.result).toMatchObject({ commit: { state: "committed", subject: "Change a from the phone" }, push: { state: "pushed", remote: "origin", branch: "feat/phone" },
      pr: { state: "created", url: "https://github.com/acme/widgets/pull/42" } });
    expect(asked.filter((a) => a.startsWith("ship"))).toHaveLength(1);
    expect(git(bare, "log", "--format=%s", "-1", "feat/phone").trim()).toBe("Change a from the phone");
    expect(git(repo, "rev-parse", "--abbrev-ref", "feat/phone@{upstream}").trim()).toBe("origin/feat/phone");
    expect(calls()).toContain("pr create --head feat/phone --base main --title Change a from the phone --body One confirm.");
  });

  it("refuses in the desktop's words when the remote has moved, and opens no pull request", async () => {
    const { repo, bare, gh, calls } = newBranch();
    // Someone else already pushed a feat/phone this checkout does not have.
    const other = tempDir("realm-phone-other-");
    execFileSync("git", ["clone", "-q", bare, other]);
    git(other, "checkout", "-qb", "feat/phone");
    writeFileSync(join(other, "b.txt"), "theirs\n");
    git(other, "commit", "-qam", "Theirs");
    git(other, "push", "-q", "origin", "feat/phone");
    const { rpc } = rig(repo, { gh });
    await attempt(rpc, "session.stage", { id: "s", paths: ["a.txt"] });

    const got = await attempt(rpc, "session.ship", commitPushAndPr);
    expect(got).toMatchObject({ ok: true, result: { commit: { state: "committed" },
      push: { state: "rejected", reason: "origin has commits feat/phone does not — pull or rebase, then ship again" }, pr: { state: "skipped" } } });
    expect(git(bare, "log", "--format=%s", "-1", "feat/phone").trim()).toBe("Theirs");
    expect(() => calls()).toThrow();
  });

  it("refuses a commit with no message before git is asked, and reports nothing staged as a state", async () => {
    const repo = makeRepo();
    const { rpc, asked } = rig(repo);
    expect(await attempt(rpc, "session.ship", { id: "s", message: "   " })).toMatchObject({ ok: false, code: "INVALID_PARAMS", message: "A commit needs a message." });
    expect(asked).toEqual([]);
    const none = await attempt(rpc, "session.ship", { id: "s", message: "m", push: false });
    expect(none).toMatchObject({ ok: true, result: { commit: { state: "nothing-to-commit" }, push: { state: "skipped" } } });
  });

  it("says a checkout with no remote has nowhere to push", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    git(repo, "add", "a.txt");
    const got = await attempt(rig(repo).rpc, "session.ship", { id: "s", message: "m", push: true });
    expect(got).toMatchObject({ ok: true, result: { commit: { state: "committed" }, push: { state: "no-remote" } } });
  });
});

describe("session.pr", () => {
  const detail: PrDetail = {
    ref: { owner: "acme", repo: "widgets", number: 7 }, title: "Phone diff", url: "https://github.com/acme/widgets/pull/7", state: "open", draft: false,
    author: "carlton", createdAt: 1, updatedAt: 2, body: "Body", base: "main", head: "feat/phone", headOwner: null, headSha: "abc1234",
    additions: 3, deletions: 1, changedFiles: 1, mergeable: "mergeable", mergeState: "unstable", decision: null,
    reviewers: [{ name: "abdul", team: false, state: "commented" }],
    comments: { total: 1, recent: [{ author: "abdul", body: "Looks good", createdAt: 3, url: null }] },
    checks: [{ name: "server", state: "success", url: null }, { name: "ios", state: "failure", url: "https://example.invalid/run/1" }],
  };
  const files: PrFiles = { headSha: "abc1234", files: [{ path: "a.txt", oldPath: null, status: "modified", additions: 3, deletions: 1, patch: "text" }], total: 1, truncated: false };
  const gh = (url: string | null) => {
    const dir = tempDir("realm-phone-gh-");
    const path = join(dir, "gh");
    writeFileSync(path, url ? `#!/bin/sh\necho '{"url":"${url}"}'\n` : "#!/bin/sh\nexit 1\n");
    chmodSync(path, 0o755);
    return path;
  };

  it("reads the branch's request as the Code Review page does, at the head its files were read at", async () => {
    const repo = makeRepo();
    git(repo, "checkout", "-qb", "feat/phone");
    const seen: unknown[] = [];
    const { rpc } = rig(repo, {
      gh: gh("https://github.com/acme/widgets/pull/7"),
      more: { "codeReview.detail": (p: never) => { seen.push(p); return detail; }, "codeReview.files": (p: never) => { seen.push(p); return files; } },
    });
    const got = await attempt(rpc, "session.pr", { id: "s" });
    if (!got.ok) throw new Error(got.message);
    parses("session.pr", got.result);
    expect(got.result).toMatchObject({ reason: null, pr: { owner: "acme", repo: "widgets", number: 7, title: "Phone diff", mergeState: "unstable", filesTruncated: false,
      checks: detail.checks, files: [{ path: "a.txt", oldPath: null, status: "modified", additions: 3, deletions: 1 }] } });
    expect(seen).toEqual([{ ref: detail.ref, force: false }, { ref: detail.ref, headSha: "abc1234" }]);
  });

  it("says why there is none: gh missing or signed out is not 'no pull request'", async () => {
    const repo = makeRepo();
    const status = (state: string) => ({ "codeReview.status": () => ({ state, login: null, reason: null }) });
    expect(await attempt(rig(repo, { gh: gh(null), more: status("ready") }).rpc, "session.pr", { id: "s" })).toEqual({ ok: true, result: { pr: null, reason: null } });
    expect(await attempt(rig(repo, { more: status("missing") }).rpc, "session.pr", { id: "s" })).toMatchObject({ ok: true, result: { pr: null, reason: expect.stringContaining("gh is not installed") } });
    expect(await attempt(rig(repo, { gh: gh(null), more: status("signed-out") }).rpc, "session.pr", { id: "s" })).toMatchObject({ ok: true, result: { reason: "gh is not signed in to GitHub on this Mac." } });
    // A request gh names but GitHub will not show is said in GitHub's words.
    const hidden = rig(repo, { gh: gh("https://github.com/acme/widgets/pull/7"), more: { "codeReview.detail": () => { throw new RpcError("PR_NOT_FOUND", "GitHub has no pull request there, or this account cannot see it"); } } });
    expect(await attempt(hidden.rpc, "session.pr", { id: "s" })).toMatchObject({ ok: true, result: { pr: null, reason: "GitHub has no pull request there, or this account cannot see it" } });
  });
});
