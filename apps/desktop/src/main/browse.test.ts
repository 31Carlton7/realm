import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { BROWSE_LIMIT, browseFolder, folderLabel, insideRoot } from "./browse";

let root = "";
const file = (rel: string, body = "x", ageMin = 0) => {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  const when = new Date(Date.now() - ageMin * 60_000);
  utimesSync(abs, when, when);
  return abs;
};

beforeEach(() => { root = tempDir("realm-browse-"); });

describe("browseFolder", () => {
  it("lists what is on disk, newest first", async () => {
    /* The whole reason this exists. The Library is an index of write-TOOL calls, so a zip built by a
       shell line is not in it and the session's Outputs list cannot show it either. A directory read
       has no such gap, and the newest thing is what someone who just asked for a file is looking
       for — so that is the order, folders and files together. */
    file("old.txt", "x", 120);
    file("handwriting-starter.zip", "x", 1);
    file("middle.md", "x", 30);
    const r = await browseFolder(root);
    expect(r.entries.map((e) => e.name)).toEqual(["handwriting-starter.zip", "middle.md", "old.txt"]);
    expect(r.dir).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("carries the size and the time each row is drawn from", async () => {
    file("report.pdf", "12345");
    const [row] = (await browseFolder(root)).entries;
    expect(row!.size).toBe(5);
    expect(row!.mtimeMs).toBeGreaterThan(0);
    expect(row!.isDir).toBe(false);
    expect(row!.path).toBe("report.pdf");
  });

  it("descends, and the paths it hands back are the ones to descend with", async () => {
    file("sheet/blank.pdf");
    const top = await browseFolder(root);
    const dir = top.entries.find((e) => e.isDir)!;
    expect(dir).toMatchObject({ name: "sheet", path: "sheet", size: 0 });
    const inner = await browseFolder(root, dir.path);
    expect(inner.dir).toBe("sheet");
    expect(inner.entries.map((e) => e.path)).toEqual(["sheet/blank.pdf"]);
  });

  it("leaves out the noise nobody opens this to find", async () => {
    // Dotfiles and build trees. One `node_modules` can hold more files than the rest of a home.
    file(".DS_Store");
    file("node_modules/react/index.js");
    file("dist/bundle.js");
    file("kept.txt");
    expect((await browseFolder(root)).entries.map((e) => e.name)).toEqual(["kept.txt"]);
  });

  it("survives a file that disappears under it", async () => {
    // A dangling symlink is the reproducible version of "removed mid-listing": stat throws, and one
    // row going missing must not take the folder with it.
    file("real.txt");
    symlinkSync(join(root, "gone.txt"), join(root, "dangling.txt"));
    const r = await browseFolder(root);
    expect(r.entries.map((e) => e.name)).toEqual(["real.txt"]);
  });

  it("caps a folder that is a data dump, and says that it did", async () => {
    for (let i = 0; i < 12; i++) file(`f${i}.txt`, "x", i);
    const r = await browseFolder(root, "", 10);
    expect(r.entries).toHaveLength(10);
    expect(r.truncated).toBe(true);
    // The cap takes the NEWEST, not whatever the directory happened to hand back first.
    expect(r.entries[0]!.name).toBe("f0.txt");
    expect(BROWSE_LIMIT).toBeGreaterThan(100);
  });

  it("refuses to walk out of the folder it was given", async () => {
    /* THE MUTANT: join the paths and read whatever comes out. A `..` typed into a breadcrumb — or
       sent by anything else with the bridge — then browses the user's home from a panel that claims
       to be showing one space's files. */
    file("inside.txt");
    expect(insideRoot(root, "..")).toBeNull();
    expect(insideRoot(root, "sub/../..")).toBeNull();
    expect(insideRoot(root, "")).toBe(root);
    await expect(browseFolder(root, "../..")).rejects.toThrow(/outside/);
  });

  it("names the folder a breadcrumb is showing", () => {
    expect(folderLabel("/a/b/space", "")).toBe("space");
    expect(folderLabel("/a/b/space", "sheet/out")).toBe("out");
  });
});
