import { describe, expect, it } from "vitest";
import {
  MEMORY_INDEX_BUDGET, PROFILE_INDEX_CAP, SPACE_FOLDER_INDEX_CAP, TEAM_INDEX_CAP,
  budgetRepoIndexes, fitBlocks, readRestPointer, type RepoIndexLike,
} from "./context-budget";

/** `n` index lines of exactly `width` characters each (the newline included), numbered so a cut can be read. */
const lines = (n: number, width = 100, tag = "fact"): string =>
  Array.from({ length: n }, (_, i) => `- ${tag} ${String(i).padStart(4, "0")} `.padEnd(width - 1, "x")).join("\n");

const block = (o: Partial<{ priority: number; cap: number; text: string; pointer: string; cut: boolean }>) =>
  ({ priority: 0, cap: 1_000, text: "", pointer: "[more]", ...o });

describe("fitBlocks", () => {
  it("keeps every block whole when they fit, in the order they were given", () => {
    const out = fitBlocks([block({ priority: 2, text: "general" }), block({ priority: 0, text: "specific" })], 100);
    expect(out).toEqual([{ text: "general", cut: false }, { text: "specific", cut: false }]);
  });

  it("lets the most specific block take its share first, and the general one give way", () => {
    const specific = lines(5, 20);
    const general = lines(5, 20);
    // 99 + 99 = 198 against 150: the general block is the one that is cut.
    const [g, s] = fitBlocks([block({ priority: 2, text: general }), block({ priority: 0, text: specific })], 150);
    expect(s).toEqual({ text: specific, cut: false });
    expect(g!.cut).toBe(true);
    // THE MUTANT: fill in input order. The general block would win and the specific one be cut.
    expect(g!.text.length).toBeLessThan(general.length);
  });

  it("holds each block to its cap even with budget to spare", () => {
    const [out] = fitBlocks([block({ cap: 50, text: lines(5, 20) })], 10_000);
    expect(out!.cut).toBe(true);
    expect(out!.text.length + "[more]".length).toBeLessThanOrEqual(50);
  });

  it("cuts at a line break, never inside a line, and an unbreakable first line leaves nothing but the pointer", () => {
    const text = "- one fact\n- two facts\n- three facts";
    // Room for "- one fact\n- two" — the half line must not survive.
    const [out] = fitBlocks([block({ text, cap: 16 + "[more]".length })], 1_000);
    expect(out).toEqual({ text: "- one fact", cut: true });
    expect(fitBlocks([block({ text: "x".repeat(500), cap: 100 })], 1_000)).toEqual([{ text: "", cut: true }]);
  });

  it("never spends more than the total, pointers included, and holds room for every later block's pointer", () => {
    const pointer = "[read the rest]";
    const blocks = [
      block({ priority: 0, cap: 10_000, text: lines(80), pointer }),
      block({ priority: 1, cap: 10_000, text: lines(80), pointer }),
      block({ priority: 2, cap: 10_000, text: lines(80), pointer }),
    ];
    // Every total from just enough for the three pointers to more than all three blocks: the overrun
    // lives in narrow windows (a block that fits whole leaving less than the pointers still owed —
    // 8,010 is one), which a handful of round numbers walks straight past.
    const over: number[] = [];
    for (let total = 3 * pointer.length; total <= 25_000; total++) {
      const spent = fitBlocks(blocks, total).reduce((n, b) => n + b.text.length + (b.cut ? pointer.length : 0), 0);
      if (spent > total) over.push(total);
    }
    // THE MUTANT: no room held back. A block takes all that is left, and the blocks after it still
    // need their pointers — spent past the total.
    expect(over.slice(0, 5)).toEqual([]);
    const tight = fitBlocks(blocks, 9_000);
    expect(tight[0]!.text.length).toBeGreaterThan(tight[1]!.text.length);
    expect(tight.reduce((n, b) => n + b.text.length + pointer.length, 0)).toBeLessThanOrEqual(9_000);
  });

  it("gives a block that was already cut upstream its pointer even when all of it fits", () => {
    expect(fitBlocks([block({ text: "- a\n- b", cut: true })], 1_000)).toEqual([{ text: "- a\n- b", cut: true }]);
  });
});

describe("budgetRepoIndexes", () => {
  const idx = (o: Partial<RepoIndexLike> & { index: string }): RepoIndexLike => ({ scope: "profile", path: "/mine", truncated: false, ...o });

  it("fits the owner's own project index whole — 75 one-line entries, about 12,000 characters", () => {
    const realm = lines(75, 160);
    expect(realm.length).toBeGreaterThan(11_900);
    const root = lines(20, 100, "about the user");
    const [folder, rest] = budgetRepoIndexes([
      idx({ kind: "spaceFolder", path: "/mine/spaces/realm", index: realm }),
      idx({ kind: "root", index: root }),
    ]);
    expect(folder).toMatchObject({ index: realm, truncated: false });
    expect(rest).toMatchObject({ index: root, truncated: false });
  });

  it("keeps a space with no team repo whole up to both caps — the total is exactly their sum", () => {
    expect(MEMORY_INDEX_BUDGET).toBe(SPACE_FOLDER_INDEX_CAP + PROFILE_INDEX_CAP);
    const folder = lines(SPACE_FOLDER_INDEX_CAP / 100);
    const root = lines(PROFILE_INDEX_CAP / 100);
    const out = budgetRepoIndexes([idx({ kind: "root", index: root }), idx({ kind: "spaceFolder", path: "/mine/spaces/a", index: folder })]);
    expect(out.map((r) => r.truncated)).toEqual([false, false]);
  });

  it("orders who gives way: the space folder last, then a team's root, the profile's root first", () => {
    const big = lines(400);
    const out = budgetRepoIndexes([
      idx({ kind: "root", scope: "profile", path: "/mine", index: big }),
      idx({ kind: "root", scope: "space", path: "/team", index: big }),
      idx({ kind: "spaceFolder", scope: "profile", path: "/mine/spaces/a", index: big }),
    ]);
    const [profile, team, folder] = out;
    expect(out.every((r) => r.truncated)).toBe(true);
    expect(folder!.index.length).toBeGreaterThan(SPACE_FOLDER_INDEX_CAP - 300);
    expect(team!.index.length).toBeGreaterThan(TEAM_INDEX_CAP - 300);
    // What is left after the two more specific blocks, less the pointers: next to nothing.
    expect(profile!.index.length).toBeLessThan(team!.index.length);
    const spent = out.reduce((n, r) => n + r.index.length + readRestPointer(r).length, 0);
    expect(spent).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET);
  });

  it("reads an entry with no kind as a repo's root index", () => {
    const [r] = budgetRepoIndexes([{ scope: "space", path: "/team", index: lines(200), truncated: false }]);
    expect(r!.index.length).toBeLessThanOrEqual(TEAM_INDEX_CAP);
    expect(r!.truncated).toBe(true);
  });
});

describe("readRestPointer", () => {
  it("names the file and the repo the rest is in", () => {
    expect(readRestPointer({ scope: "profile", path: "/mine" })).toBe('That MEMORY.md is longer than this; `memory_read` MEMORY with `repo: "profile"` for the rest.');
    expect(readRestPointer({ scope: "space", kind: "root", path: "/team" })).toContain('`memory_read` MEMORY with `repo: "space"`');
    for (const path of ["/mine/spaces/realm", "/mine/spaces/realm/", "/mine/spaces/realm/MEMORY.md"]) {
      expect(readRestPointer({ scope: "profile", kind: "spaceFolder", path })).toContain('`memory_read` spaces/realm/MEMORY with `repo: "profile"`');
    }
    // A folder entry whose path does not say which folder: the listing, never a guess.
    expect(readRestPointer({ scope: "profile", kind: "spaceFolder", path: "/mine" })).toContain('`memory_read` spaces with `repo: "profile"` lists the space folders');
  });
});
