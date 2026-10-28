import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { MemoryTidyInput } from "@realm/adapters";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryRepoService } from "./repo";
import { spaceFolderSettingKey, type MemorySink } from "./sink";
import { MemoryTidier, TIDY_BACKOFF_MS, TIDY_EVERY_MS } from "./tidy";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const P = { scope: "profile", id: PROFILE } as const;
const HOUR = 60 * 60_000;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const subjects = (repo: string): string[] => git(repo, "log", "--format=%s").trim().split("\n");

type Harness = {
  /** The model's plan, made from what it was shown. */
  plan?: (folder: string, input: MemoryTidyInput) => unknown;
  /** Something saved while the model thinks. */
  duringTheCall?: (repos: MemoryRepoService, folder: string) => Promise<unknown>;
  /** The sink the tidier writes through, over the store: to land saves at the moment it writes. */
  sink?: (repos: MemoryRepoService) => MemorySink;
};

/**
 * The tidy pass over the store itself — a real profile repo, written through `MemoryRepoService` — so
 * a save that lands while the model is thinking meets the pass exactly as it would in Realm. The
 * clock runs two hours ahead, so the files saved here are not "changed in the last hour".
 */
async function harness(o: Harness = {}) {
  const home = tempDir("realm-tidy-store-");
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const repos = new MemoryRepoService({
    home, settings,
    scopes: { profileIdOf: () => PROFILE, spaceIdsOf: () => [SPACE], spaceNameOf: () => "Billing" },
    committerName: async () => "Tester",
  });
  const { path: repo } = await repos.create(P);
  const { folder } = repos.spaceFolderFor(SPACE)!;
  let ahead = 2 * HOUR;
  const generate = vi.fn(async (input: MemoryTidyInput) => {
    await o.duringTheCall?.(repos, folder);
    return JSON.stringify(o.plan?.(folder, input) ?? { operations: [] });
  });
  const tidier = new MemoryTidier({
    profileIds: () => [PROFILE], spaceIdsOf: () => [SPACE],
    folderRecorded: (spaceId) => settings.get(spaceFolderSettingKey(spaceId)) !== null,
    sink: o.sink?.(repos) ?? repos, settings, generate,
    now: () => Date.now() + ahead, today: () => "2026-10-28",
  });
  const lastWeek = Date.now() - TIDY_EVERY_MS;
  settings.set(`memory.tidiedAt:${PROFILE}`, lastWeek);
  return { repos, repo, folder, settings, tidier, generate, lastWeek, later: (ms: number) => { ahead += ms; } };
}

const save = (repos: MemoryRepoService, name: string, type: "user" | "project", body: string) =>
  repos.saveSpaceMemory(SPACE, { name, description: body.split(".")[0]!, type, body });
const read = (repo: string, ...path: string[]) => readFileSync(join(repo, ...path), "utf8");
const agentSaves = (entry: string) => (repos: MemoryRepoService) => repos.edit(P, { op: "add", entry, sessionId: SESSION });

describe("the tidy pass against the store — a save during the model call", () => {
  it("commits as one 'Tidy memory' when nothing lands while it plans (the control)", async () => {
    const h = await harness();
    await save(h.repos, "terse", "user", "Keep answers short.");
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toMatchObject({ ran: true, promoted: 1 });
    expect(subjects(h.repo)[0]).toBe("Tidy memory");
    expect(read(h.repo, "MEMORY.md")).toContain(`([[spaces/${h.folder}/terse]])`);
  });

  it("makes the pass once more on the files as they are when an agent saves to the root — nothing lost, no second call", async () => {
    // THE BUG this replaces: the promotion rewrote MEMORY.md from the copy read before the call, and
    // the entry the agent saved during it was gone after the "Tidy memory" commit.
    const h = await harness({ duringTheCall: agentSaves("Ships on Fridays now") });
    await save(h.repos, "terse", "user", "Keep answers short.");
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toMatchObject({ ran: true, promoted: 1 });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(subjects(h.repo).slice(0, 2)).toEqual(["Tidy memory", "Remember Ships on Fridays now"]);
    const root = read(h.repo, "MEMORY.md");
    expect(root).toContain("- Ships on Fridays now");
    expect(root).toContain(`([[spaces/${h.folder}/terse]])`);
    expect(git(h.repo, "status", "--porcelain")).toBe("");
  });

  it("drops the operation whose file was written after the plan was made, and writes the rest", async () => {
    const plan = (folder: string, input: MemoryTidyInput) => ({ operations: [
      { op: "line", file: "MEMORY.md", line: input.indexes[0]!.text.split("\n").find((l) => l.includes("every day of the week")), to: "- Works in TypeScript" },
      { op: "merge", into: `spaces/${folder}/billing-owner.md`, from: [`spaces/${folder}/billing-lead.md`], description: "Dana owns and runs billing", body: "Dana owns and runs billing." },
    ] });
    const h = await harness({ plan, duringTheCall: agentSaves("Ships on Fridays now") });
    await h.repos.edit(P, { op: "add", entry: "Works in TypeScript every day of the week", sessionId: SESSION });
    await save(h.repos, "billing-owner", "project", "Dana owns billing.");
    await save(h.repos, "billing-lead", "project", "Dana runs billing.");
    for (const n of ["a", "b", "c"]) await save(h.repos, `old-${n}`, "project", `Old fact ${n}.`);
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toMatchObject({ ran: true, applied: 1 });
    expect(r.ran && r.dropped.map((d) => [d.op.op, d.why])).toEqual([["line", "a file it would change was written after the plan was made"]]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    // The merge went in; the line the model planned against the root as it was did not.
    expect(existsSync(join(h.repo, "spaces", h.folder, "billing-lead.md"))).toBe(false);
    const root = read(h.repo, "MEMORY.md");
    expect(root).toContain("- Works in TypeScript every day of the week");
    expect(root).toContain("- Ships on Fridays now");
    expect(subjects(h.repo)[0]).toBe("Tidy memory");
  });

  it("writes nothing when what was saved meanwhile leaves none of the plan standing, and waits six hours", async () => {
    const merge = (folder: string) => ({ operations: [
      { op: "merge", into: `spaces/${folder}/billing-owner.md`, from: [`spaces/${folder}/billing-lead.md`], description: "Dana owns and runs billing", body: "Dana owns and runs billing." },
    ] });
    const h = await harness({ plan: merge, duringTheCall: (repos) => save(repos, "deploy-day", "project", "Billing ships on Thursdays.") });
    await save(h.repos, "billing-owner", "project", "Dana owns billing.");
    await save(h.repos, "billing-lead", "project", "Dana runs billing.");
    for (const n of ["a", "b", "c"]) await save(h.repos, `old-${n}`, "project", `Old fact ${n}.`);
    const r = await h.tidier.tidy(PROFILE);
    expect(r).toEqual({ ran: false, why: `memory changed during the pass: spaces/${h.folder}/MEMORY.md` });
    // The fact saved during the call is there, and so is everything the merge would have removed.
    expect(existsSync(join(h.repo, "spaces", h.folder, "deploy-day.md"))).toBe(true);
    expect(existsSync(join(h.repo, "spaces", h.folder, "billing-lead.md"))).toBe(true);
    const index = read(h.repo, "spaces", h.folder, "MEMORY.md");
    expect(index).toContain("(deploy-day.md)");
    expect(index).toContain("(billing-lead.md)");
    expect(subjects(h.repo)).not.toContain("Tidy memory");
    // Still due once the wait is over: the clock went back, and the wait is six hours.
    expect(h.settings.get(`memory.tidiedAt:${PROFILE}`)).toBe(h.lastWeek);
    const backoff = h.settings.get(`memory.tidyBackoff:${PROFILE}`) as { overtaken: number[]; notBefore: number };
    expect(backoff.notBefore - backoff.overtaken[0]!).toBe(TIDY_BACKOFF_MS);
  });

  it("under steady saves writes nothing, makes no second call at once, and tries again after six hours", async () => {
    let n = 0;
    // A save lands each time the pass comes to write — as planned, and once more.
    const busy = (repos: MemoryRepoService): MemorySink => ({
      spaceFolderFor: (spaceId) => repos.spaceFolderFor(spaceId),
      saveSpaceMemory: (spaceId, m) => repos.saveSpaceMemory(spaceId, m),
      edit: (owner, e) => repos.edit(owner, e),
      writeBatch: async (owner, writes, message, author) => {
        await repos.edit(P, { op: "add", entry: `Saved while tidying ${++n}`, sessionId: SESSION });
        return repos.writeBatch(owner, writes, message, author);
      },
    });
    const h = await harness({ sink: busy });
    await save(h.repos, "terse", "user", "Keep answers short.");
    expect(await h.tidier.tidy(PROFILE)).toEqual({ ran: false, why: "memory changed during the pass: MEMORY.md" });
    expect(n).toBe(2); // overtaken as planned, and once more
    const root = read(h.repo, "MEMORY.md");
    expect(root).toContain("- Saved while tidying 1");
    expect(root).toContain("- Saved while tidying 2");
    expect(subjects(h.repo)).not.toContain("Tidy memory");
    h.tidier.check(PROFILE);
    h.later(TIDY_BACKOFF_MS - 60_000);
    h.tidier.check(PROFILE);
    expect(h.generate).toHaveBeenCalledTimes(1);
    h.later(60_000);
    h.tidier.check(PROFILE);
    await expect.poll(() => h.generate.mock.calls.length).toBe(2);
  });
});
