import { describe, expect, it } from "vitest";
import { briefSections, kindOf, placeOf, readList, saysMore } from "./brief-sections";

const BRIEF = [
  "You are fixing the sub-agent viewer.",
  "",
  "Where you work: `/r/wt/viewer` (branch `fix/viewer-readable`)",
  "",
  "Read first:",
  "- `design.md` — the source of design judgment",
  "- `apps/desktop/src/renderer/src/styles.css:4180`: the viewer's rules",
  "",
  "What to build:",
  "Make the report **collapsible**.",
  "",
  "RULES:",
  "Commit by path.",
].join("\n");

describe("reading a brief into its parts", () => {
  it("keeps the lead's labels and order, with what came before the first label as the opening", () => {
    const parts = briefSections(BRIEF);
    expect(parts.map((p) => [p.label, p.kind])).toEqual([
      [null, "build"], ["Where you work", "where"], ["Read first", "read"], ["What to build", "build"], ["Rules", "rules"],
    ]);
    // A label's own line keeps what followed it; the label itself is gone from the body.
    expect(parts[1]!.body).toBe("`/r/wt/viewer` (branch `fix/viewer-readable`)");
    expect(parts[3]!.body).toBe("Make the report **collapsible**.");
  });

  it("takes Markdown heads and bold labels, but not bold that opens a sentence", () => {
    const parts = briefSections("## Where you work\n/r/x\n\n**Read first:** `a.ts`\n\n**Do not** push.\n**Context**\nIt broke.");
    expect(parts.map((p) => p.label)).toEqual(["Where you work", "Read first", "Context"]);
    // THE MUTANT: any bold at a line's start opens a section — "Do not" would head a part of its own.
    expect(parts[1]!.body).toBe("`a.ts`\n\n**Do not** push.");
  });

  it("does not take a sentence with a colon for a label, nor anything inside a fence", () => {
    const parts = briefSections("Note: keep it short.\n\n```\nSteps:\nrun it\n```\nFacts:\nIt is due today.");
    expect(parts.map((p) => p.label)).toEqual([null, "Facts"]);
    expect(parts[0]!.body).toContain("Steps:");
  });

  it("is one untitled part when the lead wrote no labels at all", () => {
    expect(briefSections("Add the font-size picker beside the theme.")).toEqual([{ label: null, kind: "build", body: "Add the font-size picker beside the theme." }]);
  });

  it("knows the labels briefs use by their opening words", () => {
    expect(["Where to work", "Worktree", "Read these first", "Files to read", "The task", "Task", "Proof required", "Report back", "Odds and ends"].map(kindOf))
      .toEqual(["where", "where", "read", "read", "build", "build", "check", "report", "other"]);
  });
});

describe("what a part names", () => {
  it("reads the folder and the branch out of where it works", () => {
    expect(placeOf("Work ONLY in the worktree `/r/wt/viewer` (branch `fix/viewer-readable`, off main).")).toEqual({ path: "/r/wt/viewer", branch: "fix/viewer-readable" });
    expect(placeOf("In ~/code/realm on branch main.")).toEqual({ path: "~/code/realm", branch: "main" });
    expect(placeOf("Your own worktree.")).toBeNull();
  });

  it("drops the sentence only when the chip already says all of it", () => {
    expect(saysMore("Work in `/r/wt/viewer` (branch `fix/x`).", ["/r/wt/viewer", "fix/x"])).toBe(false);
    expect(saysMore("Work in `/r/wt/viewer`. Never touch the real home.", ["/r/wt/viewer"])).toBe(true);
  });

  it("reads a list of files as files and their notes, and a list with a sentence in it as prose", () => {
    expect(readList("- `design.md` — the source\n- [styles](apps/x/styles.css:12)\n1. src/a.ts")).toEqual([
      { file: { ref: "design.md", line: null, label: "design.md" }, note: "the source" },
      { file: { ref: "apps/x/styles.css", line: 12, label: "styles" }, note: "" },
      { file: { ref: "src/a.ts", line: null, label: "src/a.ts" }, note: "" },
    ]);
    expect(readList("`a.ts`, `b.ts` and `c.md`")?.map((i) => i.file.ref)).toEqual(["a.ts", "b.ts", "c.md"]);
    // THE MUTANT: pull the files out of a sentence — the words around them would be lost.
    expect(readList("- `a.ts`\n- the settings page, all of it")).toBeNull();
    expect(readList("Read `design.md` completely before designing.")).toBeNull();
  });
});
