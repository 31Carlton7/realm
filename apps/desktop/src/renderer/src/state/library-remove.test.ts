import { describe, expect, it } from "vitest";
import type { LibraryEntry } from "@realm/contracts";
import { libraryRemoveNotice, libraryRestoreNotice } from "./library-remove";

const entry = (name: string): LibraryEntry => ({
  id: `F-${name}`, sessionId: null, spaceId: null, kind: "added", path: `/realm-home/library/p1/${name}`, name, ext: "png", ts: 1,
  sessionTitle: null, agentKind: null,
});

describe("what a removal says", () => {
  it("names the file, or how many, and nothing more when nothing went with them", () => {
    expect(libraryRemoveNotice({ removed: [entry("hero.png")], messages: 0 })).toBe("Removed hero.png from the Library.");
    expect(libraryRemoveNotice({ removed: [entry("a.png"), entry("b.png"), entry("c.png")], messages: 0 })).toBe("Removed 3 files from the Library.");
  });

  it("says when a message it was sent with, or one being written, loses it too", () => {
    /* THE mutant: say nothing about them. The transcript's tile then shows a file it cannot open, and
       the prompter's chip just vanishes, with nothing anywhere saying why. */
    expect(libraryRemoveNotice({ removed: [entry("hero.png")], messages: 1 }))
      .toBe("Removed hero.png from the Library. It's gone from the message it was sent with, too.");
    expect(libraryRemoveNotice({ removed: [entry("hero.png")], messages: 2 }))
      .toBe("Removed hero.png from the Library. It's gone from the 2 messages it was sent with, too.");
    expect(libraryRemoveNotice({ removed: [entry("hero.png")], messages: 0 }, 1))
      .toBe("Removed hero.png from the Library. It's gone from the message you're writing, too.");
    expect(libraryRemoveNotice({ removed: [entry("a.png"), entry("b.png")], messages: 3 }, 1))
      .toBe("Removed 2 files from the Library. They're gone from the 3 messages they were sent with and the one you're writing, too.");
  });
});

describe("what an undo says", () => {
  it("nothing, when every file went back as it was — the list says it", () => {
    expect(libraryRestoreNotice({ restored: [entry("hero.png")], renamed: [] })).toBeNull();
  });

  it("which name a file came back under, when a file added since had its own", () => {
    expect(libraryRestoreNotice({ restored: [entry("notes 2.md")], renamed: [{ from: "notes.md", to: "notes 2.md" }] }))
      .toBe("notes.md is back as notes 2.md, beside the file of that name added since.");
    expect(libraryRestoreNotice({ restored: [], renamed: [{ from: "a.md", to: "a 2.md" }, { from: "b.md", to: "b 2.md" }] }))
      .toBe("2 files are back under new names, beside the files of their names added since.");
  });
});
