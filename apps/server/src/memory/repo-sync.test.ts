import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { GhRun } from "../code-review/gh";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { gitCapture, type GitRun } from "../workspace/git-exec";
import { MemoryRepoService, SAVE_FETCH_TIMEOUT_MS } from "./repo";

/*
 * Sync against a real remote: a bare repository on disk, cloned again elsewhere to stand in for the
 * user's other machine. Never a network remote — "offline" is the bare repo moved out of the way.
 */

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const P = { scope: "profile", id: PROFILE } as const;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const headOf = (repo: string, ref = "HEAD"): string => git(repo, "rev-parse", ref).trim();

async function synced(o: { gh?: GhRun; stall?: { on: boolean; fetchWaits: number[]; hold?: (timeoutMs: number) => Promise<never> | null } } = {}) {
  const home = tempDir("realm-memsync-");
  const calls: string[][] = [];
  const recording: GitRun = (cwd, args, opts) => {
    calls.push(args);
    // A remote that never answers: the fetch runs out its timeout. Recorded rather than waited out.
    if (o.stall?.on && args[0] === "fetch") {
      o.stall.fetchWaits.push(opts?.timeoutMs ?? -1);
      return o.stall.hold?.(opts?.timeoutMs ?? -1) ?? Promise.reject(new Error(`timed out after ${opts?.timeoutMs}ms`));
    }
    return gitCapture(cwd, args, opts);
  };
  const synced: string[] = [];
  const repos = new MemoryRepoService({
    home, settings: new SettingsStore(openDatabase(join(home, "realm.db"))), git: recording, gh: o.gh,
    committerName: async () => "Tester", today: () => "2026-10-08", onSynced: (owner) => synced.push(owner.id),
  });
  const repo = (await repos.create(P)).path;
  const bare = join(home, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  return { home, repos, repo, bare, calls, synced };
}

/** The user's other machine: a clone of the remote that commits and pushes on its own. */
function otherMachine(home: string, bare: string, branch: string) {
  const dir = join(home, "other");
  execFileSync("git", ["clone", "-q", bare, dir]);
  return {
    dir,
    save(file: string, text: string) {
      writeFileSync(join(dir, file), text);
      git(dir, "add", "--", file);
      git(dir, "-c", "user.name=Other", "-c", "user.email=o@o", "commit", "-qm", `Other: ${file}`);
      git(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    },
  };
}

describe("memory repo sync — turning it on", () => {
  it("pushes nothing until the user turns sync on, and only after they confirm an unverifiable remote is private", async () => {
    const { repos, repo, bare } = await synced();
    await repos.setRemote(P, bare);
    await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION });
    await repos.whenSynced(P);
    expect(git(bare, "rev-list", "--all")).toBe("");
    // A local bare repo is no GitHub remote: Realm cannot check it, so only the user's word will do.
    // THE MUTANT: drop the `!confirmPrivate` refusal — memory goes to a remote nobody said is private.
    await expect(repos.setSync(P, true)).rejects.toMatchObject({ code: "MEMORY_REMOTE_UNCONFIRMED" });
    expect((await repos.state(P))!.sync).toBe("off");
    const on = await repos.setSync(P, true, true);
    expect(on.pushEnabled).toBe(true);
    await repos.whenSynced(P);
    expect(headOf(bare, `refs/heads/${git(repo, "symbolic-ref", "--short", "HEAD").trim()}`)).toBe(headOf(repo));
    expect(await repos.state(P)).toMatchObject({ sync: "synced", ahead: 0, behind: 0, syncError: null, remote: bare });
  });

  it("asks GitHub whether a GitHub remote is private: a public one is refused whatever the user says", async () => {
    let answer = { code: 0, stdout: "false\n", stderr: "" };
    const asked: string[][] = [];
    const gh: GhRun = async (args) => { asked.push(args); return answer; };
    const { repos } = await synced({ gh });
    await repos.setRemote(P, "git@github.com:carlton/memory.git");
    expect(await repos.checkRemote(P)).toEqual({ remote: "git@github.com:carlton/memory.git", verdict: "public", detail: "GitHub says carlton/memory is public" });
    expect(asked[0]).toEqual(["api", "repos/carlton/memory", "--jq", ".private"]);
    await expect(repos.setSync(P, true, true)).rejects.toMatchObject({ code: "MEMORY_REMOTE_PUBLIC" });
    answer = { code: 0, stdout: "true\n", stderr: "" };
    // Private by GitHub's own answer: no confirmation needed.
    expect((await repos.setSync(P, true)).pushEnabled).toBe(true);
    answer = { code: 127, stdout: "", stderr: "gh is not installed" };
    expect((await repos.checkRemote(P)).verdict).toBe("unknown");
  });

  it("a new remote turns sync off, and a remote changed by hand is never pushed to", async () => {
    const { home, repos, repo, bare } = await synced();
    await repos.setRemote(P, bare);
    await repos.setSync(P, true, true);
    await repos.whenSynced(P);
    const other = join(home, "other.git");
    execFileSync("git", ["init", "-q", "--bare", other]);
    // Someone edits .git/config: the remote sync was turned on for is gone.
    git(repo, "remote", "set-url", "origin", other);
    await repos.edit(P, { op: "add", entry: "Uses pnpm", sessionId: SESSION });
    await repos.whenSynced(P);
    // THE MUTANT: push to `origin` whatever its URL — memory lands in a remote nobody checked.
    expect(git(other, "rev-list", "--all")).toBe("");
    expect((await repos.state(P))!.syncError).toMatch(/remote changed/);
    // Through Realm, a new remote is a fresh start: sync off until it is checked in turn.
    expect((await repos.setRemote(P, other)).pushEnabled).toBe(false);
  });
});

describe("memory repo sync — saving", () => {
  it("never lets the network block a save: the push waits, and goes with the next one", async () => {
    const { home, repos, repo, bare, synced: told } = await synced();
    await repos.setRemote(P, bare);
    await repos.setSync(P, true, true);
    await repos.whenSynced(P);
    const away = join(home, "away.git");
    renameSync(bare, away); // offline
    // THE MUTANT: make `ensureWritable` refuse when the pull could not reach the remote — the save fails.
    const r = await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION });
    expect(r.changed).toBe(true);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain("Prefers tabs");
    await repos.whenSynced(P);
    const queued = (await repos.state(P))!;
    expect(queued).toMatchObject({ sync: "queued", ahead: 1, behind: 0 });
    expect(queued.syncError).not.toBeNull();
    expect(told.length).toBeGreaterThan(0);
    renameSync(away, bare); // back online
    // "Retry now", or a boot: the queued commit goes.
    expect(await repos.sync(P)).toMatchObject({ sync: "synced", ahead: 0, syncError: null });
    expect(headOf(bare, "HEAD")).toBe(headOf(repo));
  });

  it("a save waits at most 5 s on a remote that does not answer, then commits here and queues the push", async () => {
    const stall = { on: false, fetchWaits: [] as number[] };
    const { repos, repo, bare } = await synced({ stall });
    await repos.setRemote(P, bare);
    await repos.setSync(P, true, true);
    await repos.whenSynced(P);
    stall.on = true;
    const before = headOf(repo);
    const r = await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION });
    // THE mutant: the save's fetch at the sync timeout — 20 s of a save that feels stuck.
    expect(stall.fetchWaits[0]).toBe(SAVE_FETCH_TIMEOUT_MS);
    expect(SAVE_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(r.changed).toBe(true);
    expect(headOf(repo)).not.toBe(before);
    await repos.whenSynced(P);
    // The background sync after the save is not someone waiting: it keeps the full timeout.
    expect(stall.fetchWaits[1]).toBe(20_000);
    expect((await repos.state(P))!).toMatchObject({ sync: "queued", ahead: 1 });
  });

  it("a save made while the last save's sync is still fetching does not wait behind that fetch", async () => {
    // The background sync's fetch (the full timeout) is held open as a remote that has not answered
    // yet; the saves' own fetches give up at once, as a 5 s wait would.
    const held: ((e: Error) => void)[] = [];
    const release = () => { stall.on = false; for (const r of held.splice(0)) r(new Error("timed out")); };
    const stall = { on: false, fetchWaits: [] as number[],
      hold: (ms: number) => (ms === SAVE_FETCH_TIMEOUT_MS ? null : new Promise<never>((_, reject) => { held.push(reject); })) };
    const { repos, repo, bare } = await synced({ stall });
    await repos.setRemote(P, bare);
    await repos.setSync(P, true, true);
    await repos.whenSynced(P);
    stall.on = true;
    await repos.edit(P, { op: "add", entry: "Prefers tabs", sessionId: SESSION });
    await new Promise((r) => setTimeout(r, 50)); // the sync it queued is now out on the network
    // THE mutant: the sync's fetch inside the save lock — this save then waits the whole sync timeout.
    const second = repos.edit(P, { op: "add", entry: "Prefers spaces", sessionId: SESSION });
    const first = await Promise.race([second.then(() => "saved"), new Promise((r) => setTimeout(() => r("stuck"), 1_000))]);
    release();
    expect(first).toBe("saved");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain("Prefers spaces");
    await repos.whenSynced(P);
  });

  it("takes in what another machine pushed, fast-forward, before it saves on top", async () => {
    const { home, repos, repo, bare } = await synced();
    await repos.setRemote(P, bare);
    await repos.setSync(P, true, true);
    await repos.whenSynced(P);
    const branch = git(repo, "symbolic-ref", "--short", "HEAD").trim();
    otherMachine(home, bare, branch).save("laptop.md", "- Saved on the laptop\n");
    // THE MUTANT: skip the fast-forward — the save lands beside the laptop's commit, not on it, and
    // the push is refused for good.
    await repos.edit(P, { op: "add", entry: "Saved on the desktop", sessionId: SESSION });
    await repos.whenSynced(P);
    expect(readFileSync(join(repo, "laptop.md"), "utf8")).toBe("- Saved on the laptop\n");
    expect(git(repo, "log", "--format=%s", "-2").split("\n").filter(Boolean)).toEqual(["Remember Saved on the desktop", "Other: laptop.md"]);
    // No merge commit: history stays a line.
    expect(git(repo, "rev-list", "--merges", "--count", "HEAD").trim()).toBe("0");
    expect(headOf(bare, `refs/heads/${branch}`)).toBe(headOf(repo));
  });

  it("pauses saving when the repo and its remote have diverged — nothing merged, nothing forced", async () => {
    const { home, repos, repo, bare, calls } = await synced();
    await repos.setRemote(P, bare);
    await repos.setSync(P, true, true);
    await repos.whenSynced(P);
    const branch = git(repo, "symbolic-ref", "--short", "HEAD").trim();
    // Offline, this Mac saves; meanwhile the laptop pushes. Both sides now have a commit the other lacks.
    renameSync(bare, join(home, "away.git"));
    await repos.edit(P, { op: "add", entry: "Saved offline", sessionId: SESSION });
    await repos.whenSynced(P);
    renameSync(join(home, "away.git"), bare);
    otherMachine(home, bare, branch).save("laptop.md", "- Saved on the laptop\n");
    const remoteHead = headOf(bare, `refs/heads/${branch}`);
    const localHead = headOf(repo);

    // THE MUTANT: let `pull` answer "ok" when both sides moved — the save lands and the push is refused
    // forever, with nothing on the row to say why.
    await expect(repos.edit(P, { op: "add", entry: "Another fact", sessionId: SESSION })).rejects.toMatchObject({ code: "MEMORY_REPO_DIVERGED" });
    expect(headOf(repo)).toBe(localHead);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).not.toContain("Another fact");
    expect(headOf(bare, `refs/heads/${branch}`)).toBe(remoteHead);
    const st = (await repos.state(P))!;
    expect(st).toMatchObject({ sync: "diverged", ahead: 1, behind: 1 });
    expect(st.reason).toMatch(/resolve it in Terminal/);
    // A retry changes nothing either: it still will not merge.
    expect((await repos.sync(P)).sync).toBe("diverged");
    expect(headOf(repo)).toBe(localHead);
    for (const args of calls) {
      expect(args).not.toContain("--force");
      expect(args).not.toContain("-f");
      expect(args.some((a) => /^(rebase|reset)$/.test(a))).toBe(false);
      if (args.includes("push")) expect(args.some((a) => a.startsWith("+"))).toBe(false);
    }

    // The user merges by hand in Terminal; saving resumes.
    git(repo, "-c", "user.name=Me", "-c", "user.email=m@m", "pull", "-q", "--no-rebase", "--no-edit", "origin", branch);
    expect((await repos.edit(P, { op: "add", entry: "Another fact", sessionId: SESSION })).changed).toBe(true);
    await repos.whenSynced(P);
    expect(await repos.state(P)).toMatchObject({ sync: "synced", reason: null });
    expect(headOf(bare, `refs/heads/${branch}`)).toBe(headOf(repo));
  });
});
