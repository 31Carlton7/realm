import { describe, expect, it } from "vitest";
import { edited, externalChange, opened } from "./buffers";
import { KEPT_TYPING_MAX_CHARS, forgetKeptTyping, keepTyping, keptTyping } from "./kept-typing";

const typed = (path: string, text: string) => edited(opened(path, "x", "h-x"), text);

describe("kept typing", () => {
  it("keeps a buffer holding typing, and forgets the file's copy for one that holds none", () => {
    expect(keepTyping("d", typed("a.md", "mine"))).toBe(true);
    expect(keptTyping("d").get("a.md")?.text).toBe("mine");
    expect(keepTyping("d", opened("a.md", "x", "h-x"))).toBe(false);
    expect(keptTyping("d").has("a.md")).toBe(false);
  });

  it("keeps no more than two of the largest files the pane opens, and forgets an older copy rather than keep it", () => {
    /* THE MUTANT: drop the size check. A paste of a book into a conflicted file stays in memory for the run. */
    keepTyping("d", typed("a.md", "mine"));
    const huge = externalChange(typed("a.md", "m".repeat(KEPT_TYPING_MAX_CHARS - 10)), "t".repeat(20), "h-t");
    expect(keepTyping("d", huge)).toBe(false);
    expect(keptTyping("d").has("a.md")).toBe(false);
    expect(keepTyping("d", typed("a.md", "m".repeat(KEPT_TYPING_MAX_CHARS)))).toBe(true);
  });

  it("forgets a copy on a landed write only while it is still the copy that was sent", () => {
    const sent = typed("a.md", "first");
    keepTyping("d", sent);
    const later = typed("a.md", "first, then more");
    keepTyping("d", later);
    forgetKeptTyping("d", "a.md", sent);
    expect(keptTyping("d").get("a.md")).toBe(later);
    forgetKeptTyping("d", "a.md", later);
    expect(keptTyping("d").has("a.md")).toBe(false);
  });

  it("hands a copy to the pane, so the memory can change while the pane reads", () => {
    keepTyping("d", typed("a.md", "mine"));
    const held = keptTyping("d");
    forgetKeptTyping("d", "a.md");
    expect(held.has("a.md")).toBe(true);
  });
});
