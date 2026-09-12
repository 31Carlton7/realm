import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every class name these components use must resolve to a rule in `styles.css`.
 *
 * This exists because jsdom cannot catch the failure and the suite therefore cannot either: a
 * component referencing a class nobody ever wrote renders, holds the right state, passes every
 * behavioural test, and draws unstyled. It happened to all four panels added on 2026-09-11 — one of
 * them (`.documents-code`) would have mounted a working CodeMirror with zero height, which is the
 * worst version of it, because "the editor is blank" reads as the editor being broken.
 *
 * Scoped to a list rather than sweeping the whole renderer, and that is a deliberate limit rather
 * than laziness: a full sweep is the right test and would currently fail on pre-existing components
 * whose classes come from `@realm/ui`, from template literals, or from data attributes this crude
 * parser cannot follow. Widening it means teaching it those, and then fixing whatever it finds —
 * worth doing, and not something to do in the same change that needed the guard.
 */
const ROOT = join(__dirname, "..", "..");
const CSS = readFileSync(join(ROOT, "styles.css"), "utf8");
const DEFINED = new Set([...CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));

/** Components whose class names are checked. Add a file here when you add a panel. */
const GUARDED = [
  "components/settings/SandboxPanel.tsx",
  "components/settings/ScriptsPanel.tsx",
  "components/settings/KeybindingsPanel.tsx",
  "panes/documents/CodeEditor.tsx",
  "components/sidebar/ChatFeed.tsx",
];

/** Static `className="…"` only. A computed class is out of this parser's reach and is not claimed. */
function classesIn(src: string): string[] {
  return [...src.matchAll(/className="([^"{}]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean);
}

describe("panel class names resolve to real CSS", () => {
  it.each(GUARDED)("%s", (rel) => {
    const used = classesIn(readFileSync(join(ROOT, rel), "utf8"));
    expect(used.length).toBeGreaterThan(0); // a parser that matched nothing would pass vacuously
    expect(used.filter((c) => !DEFINED.has(c))).toEqual([]);
  });

  it("the code editor's host has a height, or CodeMirror's own 100% resolves to zero", () => {
    /* Named rather than left to the sweep above, because this one is not about looking unstyled: the
       theme sets `height: 100%` on the editor, so a host with auto height mounts an editor that
       draws nothing at all. THE MUTANT: delete the `.documents-code` rule. */
    expect(/\.documents-code\s*\{[^}]*height:/.test(CSS)).toBe(true);
  });
});
