import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { NAMED_ROOT_DEPTH, OWN_ROOT_DEPTH, sweepTurnMedia, turnSearchRoots } from "./turn-media";

const T0 = 1_700_000_000_000;
/** A file at `path` (folders made), its mtime set to `at`. */
function put(path: string, at: number, bytes = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  utimesSync(path, at / 1000, at / 1000);
}
const window = { from: T0, to: T0 + 10_000, max: 200 };
const bash = (command: string) => sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command }, parentToolUseId: null });

describe("turnSearchRoots", () => {
  it("adds every folder a tool call named, outside the cwd, with ~ expanded", async () => {
    const home = tempDir("realm-home-");
    mkdirSync(join(home, "work/realm"), { recursive: true });
    mkdirSync(join(home, "work/versed/content/decks"), { recursive: true });
    const roots = await turnSearchRoots({
      cwd: join(home, "work/realm"), spaceFolder: null, home,
      events: [bash("cd ~/work/versed/content/decks && node compose.mjs deck v1")],
    });
    expect(roots).toEqual([
      { path: join(home, "work/realm"), depth: OWN_ROOT_DEPTH },
      { path: join(home, "work/versed/content/decks"), depth: NAMED_ROOT_DEPTH },
    ]);
  });

  it("refuses the disk, the home and the home's Library, and folders that do not exist", async () => {
    const home = tempDir("realm-home-");
    mkdirSync(join(home, "Library"), { recursive: true });
    // THE mutant: no floor under a root. The Realm space has an environment at `/`; this would walk the disk.
    const roots = await turnSearchRoots({
      cwd: "/", spaceFolder: home, home,
      events: [bash(`ls ${home}/Library/ /tmp/ ${home}/nowhere/at/all`)],
    });
    expect(roots).toEqual([]);
  });
});

describe("sweepTurnMedia", () => {
  it("finds a picture made in a folder outside the cwd, inside the turn's window", async () => {
    const home = tempDir("realm-home-");
    const cwd = join(home, "realm");
    mkdirSync(cwd, { recursive: true });
    put(join(home, "versed/decks/deck/v1/01.png"), T0 + 5_000);
    const roots = await turnSearchRoots({ cwd, spaceFolder: null, home, events: [bash(`cd ${home}/versed/decks && node compose.mjs deck v1`)] });
    // THE mutant: sweeping the cwd only — the shape of the bug that hid the deck.
    expect(await sweepTurnMedia(roots, window)).toEqual({ files: [{ path: join(home, "versed/decks/deck/v1/01.png"), size: 1 }], total: 1 });
  });

  it("ignores a picture older than the turn, and anything that is not media", async () => {
    const dir = tempDir("realm-sweep-");
    put(join(dir, "old.png"), T0 - 2_500);
    put(join(dir, "deck.json"), T0 + 1_000);
    put(join(dir, "notes.md"), T0 + 1_000);
    put(join(dir, "edge.png"), T0 - 1_500); // inside the slack
    put(join(dir, "clip.mp4"), T0 + 11_000); // a render finishing as the settle lands
    // THE mutants: no window check (old.png), and no media filter (deck.json, notes.md).
    const { files } = await sweepTurnMedia([{ path: dir, depth: 2 }], window);
    expect(files.map((f) => f.path)).toEqual([join(dir, "clip.mp4"), join(dir, "edge.png")]);
  });

  it("lists the newest up to the cap, and says how many there were", async () => {
    const dir = tempDir("realm-sweep-");
    for (let i = 0; i < 5; i++) put(join(dir, `0${i}.png`), T0 + i * 1_000);
    // THE mutant: an unbounded list.
    const { files, total } = await sweepTurnMedia([{ path: dir, depth: 0 }], { ...window, max: 2 });
    expect(files.map((f) => f.path)).toEqual([join(dir, "04.png"), join(dir, "03.png")]);
    expect(total).toBe(5);
  });

  it("skips hidden folders and ones a fetch or a build fills, and stops at the depth it was given", async () => {
    const dir = tempDir("realm-sweep-");
    put(join(dir, "node_modules/pkg/x.png"), T0 + 1);
    put(join(dir, ".git/x.png"), T0 + 1);
    put(join(dir, "Pods/x.png"), T0 + 1);
    put(join(dir, "a/b/deep.png"), T0 + 1);
    put(join(dir, "a/near.png"), T0 + 1);
    // THE mutant: losing the hidden-dir skip.
    const { files } = await sweepTurnMedia([{ path: dir, depth: 1 }], window);
    expect(files.map((f) => f.path)).toEqual([join(dir, "a/near.png")]);
  });

  it("reads a folder two roots reach once", async () => {
    const dir = tempDir("realm-sweep-");
    put(join(dir, "v1/01.png"), T0 + 1);
    const { files, total } = await sweepTurnMedia([{ path: dir, depth: 2 }, { path: join(dir, "v1"), depth: 3 }], window);
    expect(files).toHaveLength(1);
    expect(total).toBe(1);
  });

  it("gives up at its deadline, keeping what it found", async () => {
    const dir = tempDir("realm-sweep-");
    put(join(dir, "a/01.png"), T0 + 1);
    put(join(dir, "b/02.png"), T0 + 1);
    let clock = 0;
    // Each read of the clock moves it on a second: the budget runs out partway through the walk.
    const { files } = await sweepTurnMedia([{ path: dir, depth: 2 }], { ...window, now: () => (clock += 400) });
    expect(files.length).toBeLessThan(2);
  });
});
