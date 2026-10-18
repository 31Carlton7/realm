import { describe, expect, it } from "vitest";
import type { DiffFileStatus } from "@realm/contracts";
import { changeKindOf, changePhrase, groupByKind, kindBreakdown, kindCounts, whatOf } from "./what-changed";

const c = (path: string, status: DiffFileStatus = "modified") => ({ path, status });

describe("changeKindOf", () => {
  it.each([
    ["notes/plan.md", "document"], ["Report.DOCX", "document"], ["brief.pdf", "document"], ["todo.txt", "document"],
    ["shots/hero.png", "image"], ["logo.svg", "image"], ["photo.JPEG", "image"],
    ["demo.mov", "media"], ["voice.m4a", "media"],
    ["budget.xlsx", "data"], ["rows.csv", "data"], ["package.json", "data"],
    ["src/app.ts", "code"], ["main.py", "code"],
    // Not in the Library's table, but the Documents pane opens them in its code editor.
    ["vite.config.mjs", "code"], ["App.vue", "code"], [".gitignore", "code"],
    ["Makefile", "other"], ["archive.zip", "other"], ["no-extension", "other"],
  ] as const)("%s is %s", (path, kind) => {
    expect(changeKindOf(path)).toBe(kind);
  });

  it("reads the file's own name, not a dot in a folder above it", () => {
    expect(changeKindOf("site.v2/README")).toBe("other");
  });
});

describe("changePhrase", () => {
  it.each<[string, ReturnType<typeof c>[], string | null]>([
    ["nothing", [], null],
    ["one file of one kind", [c("notes.md")], "Changed 1 document"],
    ["several of one kind", [c("a.ts"), c("b.ts"), c("c.ts")], "Changed 3 code files"],
    ["mixed kinds", [c("notes.md"), c("hero.png"), c("app.ts")], "Changed 3 files"],
    ["only new images", [c("a.png", "untracked"), c("b.jpg", "added")], "Added 2 images"],
    ["one new image", [c("a.png", "untracked")], "Added 1 image"],
    ["only deletions", [c("old.md", "deleted")], "Deleted 1 document"],
    ["only renames", [c("b.ts", "renamed"), c("d.ts", "renamed")], "Renamed 2 code files"],
    ["a rename beside a deletion", [c("b.ts", "renamed"), c("old.md", "deleted")], "Changed 2 files"],
    ["a new file beside an edit", [c("a.png", "untracked"), c("b.png")], "Changed 2 images"],
    ["files with no kind", [c("Makefile"), c("LICENSE")], "Changed 2 files"],
  ])("%s", (_, changes, phrase) => {
    expect(changePhrase(changes)).toBe(phrase);
  });

  it("goes general when the list was cut short — the unlisted files may be anything", () => {
    // 3 images listed out of 1200: neither "images" nor "Added" can speak for the other 1197.
    const listed = [c("a.png", "untracked"), c("b.png", "untracked"), c("c.png", "untracked")];
    expect(changePhrase(listed, 1200)).toBe("Changed 1200 files");
  });
});

describe("kindBreakdown", () => {
  it("names each kind with its count, in the review's order", () => {
    expect(kindBreakdown([c("app.ts"), c("hero.png"), c("notes.md"), c("b.ts")])).toBe("1 document, 1 image and 2 code files");
    expect(kindBreakdown([c("a.png"), c("b.png")])).toBe("2 images");
    expect(kindCounts([c("a.png"), c("x.md")]).map((k) => k.kind)).toEqual(["document", "image"]);
  });

  it("says how many it could not sort", () => {
    expect(kindBreakdown([c("a.png")], 5)).toBe("1 image and 4 more");
  });
});

describe("whatOf", () => {
  it.each<[DiffFileStatus, string | null, string]>([
    ["added", null, "New"], ["untracked", null, "New"], ["modified", null, "Edited"], ["type-changed", null, "Edited"],
    ["deleted", null, "Deleted"], ["renamed", "docs/old.md", "Renamed from docs/old.md"], ["renamed", null, "Renamed"],
    ["copied", "a.ts", "Copied from a.ts"], ["conflicted", null, "Conflict to resolve"],
  ])("%s → %s", (status, oldPath, what) => {
    expect(whatOf(status, oldPath)).toBe(what);
  });
});

describe("groupByKind", () => {
  it("groups in the review's order and keeps each group's own order", () => {
    const groups = groupByKind([c("z.ts"), c("b.png"), c("a.ts"), c("notes.md")]);
    expect(groups.map((g) => [g.kind, g.files.map((f) => f.path)])).toEqual([
      ["document", ["notes.md"]], ["image", ["b.png"]], ["code", ["z.ts", "a.ts"]],
    ]);
  });
});
