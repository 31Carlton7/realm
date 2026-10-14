import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseNotes, spans } from "./whats-new-notes";

const CHANGELOG = `# Changelog

## v2.1.1 — 2026-10-12

**Make team works when a space works in your whole Mac.** A space with a checkout at \`/\` made every
folder count as one of your projects.

## v2.1.0 — 2026-10-12

### Teams

**A space can have a team.** Make team gives a space roles, each with its own Realmite, from seven
templates or a custom teammate.

**Realmites.** Every role gets a small character of its own.

### Sessions

- **Unread sessions** show a bold title and a blue dot, and the sidebar keeps the most recently
  active spaces at the top.
- **⌘\\\\** opens a split with a new session.

## v2.0.3 — 2026-10-06

This release has no bold lead, only a sentence.
`;

const text = (item: { text: string }[]) => item.map((s) => s.text).join("");

describe("release notes from CHANGELOG.md", () => {
  it("lists a paragraph by its bold sentence, and keeps the section's date", () => {
    const notes = releaseNotes(CHANGELOG, "2.1.1")!;
    expect(notes).toMatchObject({ version: "2.1.1", date: "2026-10-12" });
    expect(notes.groups).toHaveLength(1);
    expect(notes.groups[0]!.title).toBeNull();
    expect(notes.groups[0]!.items.map(text)).toEqual(["Make team works when a space works in your whole Mac."]);
  });

  it("groups by ### heading, lists each item whole, and joins an item's wrapped lines", () => {
    const notes = releaseNotes(CHANGELOG, "v2.1.0")!;
    expect(notes.groups.map((g) => g.title)).toEqual(["Teams", "Sessions"]);
    expect(notes.groups[0]!.items.map(text)).toEqual(["A space can have a team.", "Realmites."]);
    expect(notes.groups[1]!.items.map(text)).toEqual([
      "Unread sessions show a bold title and a blue dot, and the sidebar keeps the most recently active spaces at the top.",
      "⌘\\ opens a split with a new session.",
    ]);
    // A list item's bold lead stays bold; the escape is a literal backslash.
    expect(notes.groups[1]!.items[0]![0]).toEqual({ text: "Unread sessions", strong: true });
    expect(notes.groups[1]!.items[1]![0]).toEqual({ text: "⌘\\", strong: true });
  });

  /* THE mutant this pins: reading on past the section's end, which lists the previous release's
     notes under this version's number. */
  it("stops at the next release", () => {
    const notes = releaseNotes(CHANGELOG, "2.1.0")!;
    expect(JSON.stringify(notes)).not.toContain("no bold lead");
    expect(releaseNotes(CHANGELOG, "2.0.3")!.groups[0]!.items.map(text)).toEqual(["This release has no bold lead, only a sentence."]);
  });

  it("answers null for a version the changelog has no section for, not a neighbour's", () => {
    expect(releaseNotes(CHANGELOG, "2.1.2")).toBeNull();
    expect(releaseNotes(CHANGELOG, "2.1")).toBeNull();
  });

  it("reads bold, code and escapes as spans", () => {
    expect(spans("Run **`pnpm release`** now, or `x` \\*not bold\\*")).toEqual([
      { text: "Run " }, { text: "pnpm release", code: true, strong: true }, { text: " now, or " },
      { text: "x", code: true }, { text: " *not bold*" },
    ]);
  });

  it("reads the repository's own changelog", () => {
    const real = readFileSync(join(__dirname, "../../../../CHANGELOG.md"), "utf8");
    const notes = releaseNotes(real, "2.1.0")!;
    expect(notes.groups.map((g) => g.title)).toContain("Teams");
    expect(notes.groups.every((g) => g.items.length > 0)).toBe(true);
  });
});
