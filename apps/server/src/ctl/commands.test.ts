import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { SpacesStore } from "../store/spaces";
import { connect } from "./client";
import type { ShipResult } from "@realm/contracts";
import { commandLine, parseArgs, runCtl, shipReport, shipped, type CtlIo } from "./commands";

const apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close().catch(() => {}); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(): string {
  const dir = tempDir("realm-ctl-repo-");
  git(dir, "init", "-b", "main");
  // The server commits with no `-c` of its own, so the repository carries the identity `realm ship`
  // commits under, whatever this machine's global config says.
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init");
  return dir;
}

/** A real server on a scratch home, announced the way `main.ts` announces one, and a `realm` that
 *  talks to it through the same client the shipped binary uses. */
async function serverAndCli() {
  const home = tempDir("realm-ctl-home-");
  const token = "test-token";
  const app = await createApp({ home, port: 0, token }); apps.push(app);
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ port: app.port, token }));
  const realm = async (...argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const io: CtlIo = { out: (s) => out.push(s), err: (s) => err.push(s), env: { REALM_HOME: home }, cwd: home, connect, serve: async () => {} };
    const code = await runCtl(["--json", ...argv], io);
    return { code, json: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n") };
  };
  return { home, app, realm };
}

describe("parseArgs and commandLine", () => {
  it("splits options from the command after --, and keeps that command whole", () => {
    const p = parseArgs(["run", "/r", "--worktree", "t1", "--json", "--base=dev", "--", "agent", "--json"]);
    expect(p.positionals).toEqual(["run", "/r"]);
    expect(p.flags.get("worktree")).toBe("t1");
    expect(p.flags.get("base")).toBe("dev");
    expect(p.flags.get("json")).toBe(true);
    expect(p.command).toEqual(["agent", "--json"]); // a flag after -- belongs to the command
  });
  it("uses one argument as a command line and quotes several", () => {
    expect(commandLine(["env X=1 agent 'fix it'"])).toBe("env X=1 agent 'fix it'");
    expect(commandLine(["agent", "fix it", "it's"])).toBe(`agent 'fix it' 'it'\\''s'`);
    expect(() => commandLine([])).toThrow(/nothing to run/);
  });
});

describe("what realm ship reports", () => {
  const result = (o: { commit?: Partial<ShipResult["commit"]>; push?: Partial<ShipResult["push"]>; pr?: Partial<ShipResult["pr"]> }): ShipResult => ({
    commit: { state: "committed", sha: "3f2a1c9e0d", subject: "Fix the paging", reason: null, ...o.commit },
    push: { state: "skipped", remote: null, branch: null, reason: null, ...o.push },
    pr: { state: "skipped", url: null, reason: null, ...o.pr },
  });
  const pushed = { state: "pushed" as const, remote: "origin", branch: "realm/t1" };

  /* THE mutant is a ship that exits 0 because the commit landed, while the pull request it was asked
     for is a link to make one by hand. A script that opened PRs would report success for none. */
  it("succeeds only when every step it was asked for landed", () => {
    expect(shipped(result({}), { push: false, openPr: false })).toBe(true);
    expect(shipped(result({ push: pushed, pr: { state: "created", url: "https://github.com/o/r/pull/1" } }), { push: true, openPr: true })).toBe(true);
    expect(shipped(result({ push: pushed, pr: { state: "existing", url: "https://github.com/o/r/pull/1" } }), { push: true, openPr: true })).toBe(true);
    expect(shipped(result({ push: pushed, pr: { state: "compare", url: "https://github.com/o/r/compare/main...realm/t1?expand=1" } }), { push: true, openPr: true })).toBe(false);
    expect(shipped(result({ push: { state: "rejected", remote: "origin", branch: "realm/t1" } }), { push: true, openPr: false })).toBe(false);
    expect(shipped(result({ commit: { state: "no-identity", sha: null, subject: null } }), { push: false, openPr: false })).toBe(false);
  });

  it("says what each step did, and why one did not", () => {
    expect(shipReport(result({ push: pushed, pr: { state: "created", url: "https://github.com/o/r/pull/7" } }))).toEqual([
      "committed 3f2a1c9 Fix the paging", "pushed realm/t1 to origin", "opened https://github.com/o/r/pull/7",
    ]);
    expect(shipReport(result({ push: pushed, pr: { state: "compare", url: "https://github.com/o/r/compare/main...realm/t1?expand=1", reason: "gh is not installed — open this link to create the request" } }))
      .at(-1)).toBe("no pull request opened: gh is not installed — open this link to create the request. Open one at https://github.com/o/r/compare/main...realm/t1?expand=1");
    expect(shipReport(result({ push: { state: "no-remote", branch: "realm/t1", reason: "this repository has no remote configured" } })))
      .toEqual(["committed 3f2a1c9 Fix the paging", "not pushed: this repository has no remote configured"]);
  });
});

describe("realm, against a real server", () => {
  it("runs a command in a new worktree of the repo, and reports it finished", async () => {
    const { realm } = await serverAndCli();
    const repo = initRepo();
    const run = await realm("run", repo, "--worktree", "t1", "--", "echo done > out.txt");
    expect(run.code).toBe(0);
    expect(run.json.branch).toBe("realm/t1");
    expect(run.json.path).not.toBe(repo);
    const waited = await realm("wait", run.json.terminalId, "--timeout", "10");
    expect(waited.code).toBe(0);
    expect(waited.json).toMatchObject([{ terminalId: run.json.terminalId, running: false, exitCode: 0, signal: null }]);
    // The work landed in the worktree, on its own branch, and not in the repo it came from.
    expect(readFileSync(join(run.json.path, "out.txt"), "utf8")).toBe("done\n");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
    expect(git(run.json.path, "branch", "--show-current").trim()).toBe("realm/t1");
    const listed = await realm("worktree", "list", repo);
    expect(listed.json).toEqual([{ environmentId: run.json.environmentId, path: run.json.path, branch: "realm/t1" }]);
  });

  it("launches several at once into one project, isolated, and survives one being killed", async () => {
    const { realm, app } = await serverAndCli();
    const repo = initRepo();
    const names = ["a", "b", "c", "d"];
    const runs = await Promise.all(names.map((n) => realm("run", repo, "--worktree", n, "--", n === "b" ? "exec sh -c 'kill -9 $$'" : `echo ${n} > mine.txt`)));
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(new Set(runs.map((r) => r.json.spaceId)).size).toBe(1); // one space for the repo, not one per racing call
    expect(new Set(runs.map((r) => r.json.path)).size).toBe(4);
    // Generous: four git worktree adds and four shells on a loaded machine are slow, and a 124 here
    // would be the timeout, not the behaviour under test.
    const waited = await realm("wait", "--timeout", "40");
    expect(waited.code).toBe(1); // one of them did not succeed…
    const byId = new Map((waited.json as any[]).map((t) => [t.terminalId, t]));
    expect(byId.get(runs[1]!.json.terminalId)).toMatchObject({ running: false, signal: 9 }); // …and it is the killed one
    for (const i of [0, 2, 3]) {
      expect(byId.get(runs[i]!.json.terminalId)).toMatchObject({ exitCode: 0, signal: null });
      expect(readFileSync(join(runs[i]!.json.path, "mine.txt"), "utf8")).toBe(`${names[i]}\n`);
    }
    expect(new SpacesStore(app.db, "").listAll()).toHaveLength(1);
  }, 60000);

  it("says when a wait timed out, prints logs, and stops a terminal", async () => {
    const { realm } = await serverAndCli();
    const repo = initRepo();
    const run = await realm("run", repo, "--", "echo REALM_SAID_THIS; sleep 30");
    expect(run.json.path).toBe(git(repo, "rev-parse", "--show-toplevel").trim()); // no --worktree: the checkout itself
    const waited = await realm("wait", run.json.terminalId, "--timeout", "0.3");
    expect(waited.code).toBe(124);
    expect((await realm("logs", run.json.terminalId)).json.output).toContain("REALM_SAID_THIS");
    expect((await realm("ps")).json).toMatchObject([{ terminalId: run.json.terminalId, running: true, command: "echo REALM_SAID_THIS; sleep 30" }]);
    expect((await realm("kill", run.json.terminalId)).code).toBe(0);
    expect((await realm("ps")).json).toEqual([]);
  });

  it("fails with the server's code and a non-zero exit, as JSON", async () => {
    const { realm } = await serverAndCli();
    const notRepo = tempDir("realm-ctl-plain-");
    const r = await realm("worktree", "create", notRepo, "x");
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("NOT_A_REPOSITORY");
    expect((await realm("frobnicate")).code).toBe(2);
    expect((await realm("run", notRepo)).json.error.code).toBe("USAGE"); // no command after --
  });

  it("commits everything a run changed in its worktree, and files the ship in the space's History", async () => {
    const { realm, home } = await serverAndCli();
    const repo = initRepo();
    writeFileSync(join(repo, "gone.txt"), "x\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "two files");
    const run = await realm("run", repo, "--worktree", "t1", "--", "echo two > a.txt && echo new > b.txt && rm gone.txt");
    expect((await realm("wait", run.json.terminalId, "--timeout", "10")).code).toBe(0);
    const before = git(repo, "rev-parse", "HEAD").trim();

    const ship = await realm("ship", run.json.environmentId, "--message", "t1: the run's work");
    expect(ship.code).toBe(0);
    expect(ship.json).toMatchObject({ environmentId: run.json.environmentId, path: run.json.path, branch: "realm/t1",
      commit: { state: "committed", subject: "t1: the run's work" }, push: { state: "skipped" }, pr: { state: "skipped" } });
    // An edit, a new file and a deletion — every change, not only what was already staged — on the
    // worktree's own branch, and nothing left behind in it.
    expect(ship.json.commit.sha).toBe(git(run.json.path, "rev-parse", "HEAD").trim());
    expect(git(run.json.path, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["A\tb.txt", "D\tgone.txt", "M\ta.txt"]);
    expect(git(run.json.path, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(before);
    // The same row a ship from the Changes pane writes, so it shows in the space's History.
    const c = await connect({ kind: "home", home });
    try {
      const { ships } = await c.call<{ ships: { environmentId: string; sha: string; branch: string }[] }>("ships.list", { spaceId: run.json.spaceId });
      expect(ships).toMatchObject([{ environmentId: run.json.environmentId, sha: ship.json.commit.sha, branch: "realm/t1" }]);
    } finally { c.close(); }
  });

  it("pushes the worktree's new branch with --push and tracks it, and exits 1 when there is nothing to ship", async () => {
    const { realm } = await serverAndCli();
    const repo = initRepo();
    const remote = tempDir("realm-ctl-remote-");
    git(remote, "init", "--bare", "-b", "main");
    git(repo, "remote", "add", "origin", remote);
    const run = await realm("run", repo, "--worktree", "t2", "--", "echo two > a.txt");
    await realm("wait", run.json.terminalId, "--timeout", "10");

    const ship = await realm("ship", run.json.environmentId, "--message", "t2", "--push");
    expect(ship.code).toBe(0);
    expect(ship.json.push).toMatchObject({ state: "pushed", remote: "origin", branch: "realm/t2" });
    expect(git(remote, "rev-parse", "realm/t2").trim()).toBe(ship.json.commit.sha);
    expect(git(run.json.path, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/realm/t2");

    // Again, with the work already sent: nothing to commit, and the branch already there, is a ship
    // that has happened. Without --push the same clean checkout shipped nothing at all.
    expect((await realm("ship", run.json.environmentId, "--message", "t2", "--push")).json.push.state).toBe("up-to-date");
    const empty = await realm("ship", run.json.environmentId, "--message", "t2");
    expect(empty.code).toBe(1);
    expect(empty.json.commit.state).toBe("nothing-to-commit");
  });

  it("refuses a blank message before anything is staged, and an id that names no checkout", async () => {
    const { realm } = await serverAndCli();
    const repo = initRepo();
    const run = await realm("run", repo, "--worktree", "t3", "--", "echo two > a.txt");
    await realm("wait", run.json.terminalId, "--timeout", "10");
    const blank = await realm("ship", run.json.environmentId, "--message", " ");
    expect(blank.code).toBe(2);
    expect(blank.json.error.code).toBe("USAGE");
    expect(git(run.json.path, "diff", "--cached", "--name-only")).toBe("");
    expect((await realm("ship", "01ARZ3NDEKTSV4RRFFQ69G5FA9", "--message", "m")).json.error.code).toBe("NOT_FOUND");
  });

  it("reports no server, rather than hanging, on a home nothing is serving", async () => {
    const out: string[] = [];
    const code = await runCtl(["status", "--json", "--home", tempDir("realm-ctl-empty-")], {
      out: (s) => out.push(s), err: () => {}, env: {}, cwd: "/", connect, serve: async () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(out[0]!).error.code).toBe("NOT_RUNNING");
  });
});
