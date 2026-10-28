import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryRepoService } from "./repo";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const P = { scope: "profile", id: PROFILE } as const;

function harness(o: { autoCreate?: boolean; forbidHome?: () => boolean } = {}) {
  const home = tempDir("realm-memdefault-");
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const repos = new MemoryRepoService({
    home, settings, autoCreate: o.autoCreate ?? true,
    forbiddenRoots: () => (o.forbidHome?.() ? [home] : []),
    committerName: async () => "Tester",
  });
  return { home, settings, repos };
}

const commits = (repo: string): number => Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" }).trim());

afterEach(() => { vi.restoreAllMocks(); });

describe("MemoryRepoService.ensureProfileRepo — memory on by default", () => {
  it("makes a repo for a profile that has never had one, and only the first time", async () => {
    const { home, repos } = harness();
    const made = await repos.ensureProfileRepo(PROFILE);
    expect(made).toMatchObject({ path: join(home, "memory", "repos", `profile-${PROFILE}`), valid: true, clean: true });
    expect(repos.config(P)?.path).toBe(made!.path);
    // THE MUTANT: no "already configured" check — a second call would re-run create on every boot.
    expect(await repos.ensureProfileRepo(PROFILE)).toBeNull();
    expect(commits(made!.path)).toBe(1);
  });

  it("leaves a profile whose repo was detached without one, however long ago it was detached", async () => {
    const { settings, repos } = harness();
    const made = await repos.ensureProfileRepo(PROFILE);
    repos.detach(P);
    // THE MUTANT: `get(key) === null` as the test for "never configured" — a detach writes null too.
    expect(await repos.ensureProfileRepo(PROFILE)).toBeNull();
    expect(repos.config(P)).toBeNull();
    expect(existsSync(made!.path)).toBe(true);
    // A profile detached before this release left the same null row behind.
    const other = "01ARZ3NDEKTSV4RRFFQ69G5FP2";
    settings.set(`memory.repo:profile:${other}`, null);
    expect(await repos.ensureProfileRepo(other)).toBeNull();
  });

  it("makes nothing in a harness that did not turn it on", async () => {
    const { repos } = harness({ autoCreate: false });
    expect(await repos.ensureProfileRepo(PROFILE)).toBeNull();
    expect(repos.config(P)).toBeNull();
  });

  it("logs rather than throws where there is nowhere to put a repo, and tries again next time", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let forbidden = true;
    const { repos } = harness({ forbidHome: () => forbidden });
    expect(await repos.ensureProfileRepo(PROFILE)).toBeNull();
    expect(log.mock.calls.flat().join(" ")).toMatch(/no memory repo made for profile/);
    // Nothing was recorded, so the refusal is not mistaken for a detach on the next boot.
    forbidden = false;
    expect(await repos.ensureProfileRepo(PROFILE)).not.toBeNull();
  });

  it("logs rather than throws when the default folder already holds something else", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { repos } = harness();
    const at = repos.defaultPath(P);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "notes.txt"), "mine");
    expect(await repos.ensureProfileRepo(PROFILE)).toBeNull();
    expect(log.mock.calls.flat().join(" ")).toMatch(/not a memory repo/);
    expect(existsSync(join(at, ".git"))).toBe(false);
  });
});
