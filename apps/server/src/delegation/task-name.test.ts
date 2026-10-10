import { describe, expect, it } from "vitest";
import { taskName } from "./dispatch";

/**
 * A sub-agent's name when its lead gave none. The user's own data: sixteen children titled "Agent:
 * You are researching ORGANIC soci…", "Agent: Read-only research task. Repo: /…" four times over —
 * the frame the lead opened its goal with, never the task.
 */
describe("taskName", () => {
  it("skips 'You are a … ' and 'Read-only research task.' openers and names the task", () => {
    // THE MUTANT: the goal's first line.
    expect(taskName("You are implementing a feature in the settings page. Add the font-size picker to Settings.")).toBe("Add the font-size picker to Settings");
    expect(taskName("Read-only research task. Repo: /Users/c/realm. Find every caller of setOptions.")).toBe("Find every caller of setOptions");
    expect(taskName("You are researching organic social growth.\nList the accounts Hallow grew from.")).toBe("List the accounts Hallow grew from");
    expect(taskName("## Context\nBackground: the theme lives in the settings KV.\nWrite the migration that stores it")).toBe("Write the migration that stores it");
  });

  it("cuts at the first clause, and clips long names the way a session's title is clipped", () => {
    expect(taskName("Build the toggle; then wire it to the theme hook")).toBe("Build the toggle");
    const long = taskName("Survey every pane that draws a tool card and list the ones that still use the old type ladder");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });

  it("clips at a word, never inside one", () => {
    // THE mutant: the fixed-width cut, which named a sub-agent "Survey every theme hook across the rend…".
    expect(taskName("Survey every theme hook across the renderer and list what reads the mode")).toBe("Survey every theme hook across the…");
    // A line that ends a word exactly at the limit keeps that word.
    expect(taskName("Check the twelve panes that draw a card and fix them")).toBe("Check the twelve panes that draw a card…");
    // One long word (a path) has no word to stop at and is cut where it must be.
    const path = taskName("/Users/someone/Desktop/Projects/realm/apps/desktop/src/renderer");
    expect(path.length).toBe(40);
    expect(path.endsWith("…")).toBe(true);
  });

  it("falls back to the first line when every sentence is boilerplate", () => {
    // THE MUTANT: returning "" — a child with no title at all.
    expect(taskName("You are a careful reviewer.")).toBe("You are a careful reviewer.");
  });

  it("never prefixes 'Agent:'", () => {
    expect(taskName("Write the tests")).toBe("Write the tests");
    expect(taskName("You are a delegated agent. Write the tests")).not.toMatch(/^Agent:/);
  });
});
