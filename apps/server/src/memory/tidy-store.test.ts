import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { MemoryTidyInput } from "@realm/adapters";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryRepoService } from "./repo";
import { spaceFolderSettingKey } from "./sink";
import { MemoryTidier, TIDY_EVERY_MS } from "./tidy";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const P = { scope: "profile", id: PROFILE } as const;
const HOUR = 60 * 60_000;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const subjects = (repo: string): string[] => git(repo, "log", "--format=%s").trim().split("\n");

/**
 * The tidy pass over the store itself — a real profile repo, written through `MemoryRepoService` — so
 * a save that lands while the model is thinking meets the pass exactly as it would in Realm. The
 * clock runs two hours ahead, so the files saved here are not "changed in the last hour".
 */
async function harness(plan: (folder: string) => unknown, duringTheCall: (repos: MemoryRepoService, folder: string) => Promise<unknown> = async () => {}) {
  const home = tempDir("realm-tidy-store-");
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const repos = new MemoryRepoService({
    home, settings,
    scopes: { profileIdOf: () => PROFILE, spaceIdsOf: () => [SPACE], spaceNameOf: () => "Billing" },
    committerName: async () => "Tester",
  });
  const { path: repo } = await repos.create(P);
  const { folder } = repos.spaceFolderFor(SPACE)!;
  const tidier = new MemoryTidier({
    profileIds: () => [PROFILE], spaceIdsOf: () => [SPACE],
    folderRecorded: (spaceId) => settings.get(spaceFolderSettingKey(spaceId)) !== null,
    sink: repos, settings,
    generate: async (_input: MemoryTidyInput) => { await duringTheCall(repos, folder); return JSON.stringify(plan(folder)); },
    now: () => Date.now() + 2 * HOUR, today: () => "2026-10-28",
  });
  const lastWeek = Date.now() - TIDY_EVERY_MS;
  settings.set(`memory.tidiedAt:${PROFILE}`, lastWeek);
  return { repos, repo, folder, settings, tidier, lastWeek };
}

const save = (repos: MemoryRepoService, name: string, type: "user" | "project", body: string) =>
  repos.saveSpaceMemory(SPACE, { name, description: body.split(".")[0]!, type, body });

describe("the tidy pass against the store — a save during the model call", () => {
  it("commits as one 'Tidy memory' when nothing lands while it plans (the control)", async () => {
    const h = await harness(() => ({ operations: [] }));
    await save(h.repos, "terse", "user", "Keep answers short.");
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toMatchObject({ ran: true, promoted: 1 });
    expect(subjects(h.repo)[0]).toBe("Tidy memory");
    expect(readFileSync(join(h.repo, "MEMORY.md"), "utf8")).toContain(`([[spaces/${h.folder}/terse]])`);
  });

  it("writes nothing and loses nothing when an agent saves to the root while the model thinks", async () => {
    // THE BUG: the promotion rewrote MEMORY.md from the copy read before the call, and the entry the
    // agent saved during it was gone after the "Tidy memory" commit.
    const h = await harness(() => ({ operations: [] }), (repos) => repos.edit(P, { op: "add", entry: "Ships on Fridays now", sessionId: SESSION }));
    await save(h.repos, "terse", "user", "Keep answers short.");
    const before = subjects(h.repo).length;
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toEqual({ ran: false, why: "memory changed during the pass: MEMORY.md" });
    const root = readFileSync(join(h.repo, "MEMORY.md"), "utf8");
    expect(root).toContain("- Ships on Fridays now");
    expect(root).not.toContain(`[[spaces/${h.folder}/terse]]`); // the promotion was not written
    expect(root).toContain(`[[spaces/${h.folder}/MEMORY]]`); // the folder's own link, untouched
    expect(subjects(h.repo)).toHaveLength(before + 1); // the agent's save, and nothing of the pass
    expect(subjects(h.repo)).not.toContain("Tidy memory");
    expect(git(h.repo, "status", "--porcelain")).toBe("");
    // The clock goes back, so the next hourly check plans again from the files as they are now.
    expect(h.settings.get(`memory.tidiedAt:${PROFILE}`)).toBe(h.lastWeek);
  });

  it("writes nothing when the save lands in a space's folder the plan would change", async () => {
    const merge = (folder: string) => ({ operations: [
      { op: "merge", into: `spaces/${folder}/billing-owner.md`, from: [`spaces/${folder}/billing-lead.md`], description: "Dana owns and runs billing", body: "Dana owns and runs billing." },
    ] });
    const h = await harness(merge, (repos) => save(repos, "deploy-day", "project", "Billing ships on Thursdays."));
    await save(h.repos, "billing-owner", "project", "Dana owns billing.");
    await save(h.repos, "billing-lead", "project", "Dana runs billing.");
    for (const n of ["a", "b", "c"]) await save(h.repos, `old-${n}`, "project", `Old fact ${n}.`);
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toEqual({ ran: false, why: `memory changed during the pass: spaces/${h.folder}/MEMORY.md` });
    // The fact saved during the call is there, and so is everything the merge would have removed.
    expect(existsSync(join(h.repo, "spaces", h.folder, "deploy-day.md"))).toBe(true);
    expect(existsSync(join(h.repo, "spaces", h.folder, "billing-lead.md"))).toBe(true);
    const index = readFileSync(join(h.repo, "spaces", h.folder, "MEMORY.md"), "utf8");
    expect(index).toContain("(deploy-day.md)");
    expect(index).toContain("(billing-lead.md)");
    expect(subjects(h.repo)).not.toContain("Tidy memory");
  });

  it("plans again at the next check after a pass that was overtaken", async () => {
    let calls = 0;
    const h = await harness(() => ({ operations: [] }), async (repos) => {
      if (calls++ === 0) await repos.edit(P, { op: "add", entry: "Ships on Fridays now", sessionId: SESSION });
    });
    await save(h.repos, "terse", "user", "Keep answers short.");
    expect((await h.tidier.tidy(PROFILE)).ran).toBe(false);
    h.tidier.check(PROFILE);
    await expect.poll(() => subjects(h.repo)[0]).toBe("Tidy memory");
    const root = readFileSync(join(h.repo, "MEMORY.md"), "utf8");
    // Planned from the files as they are now: the agent's entry stays, and the promotion lands beside it.
    expect(root).toContain("- Ships on Fridays now");
    expect(root).toContain(`([[spaces/${h.folder}/terse]])`);
  });
});
