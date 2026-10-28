import { describe, expect, it } from "vitest";
import {
  binaryChanged, canRecreate, canSave, edited, externalChange, keepMine, mayWrite, opened, saved, takeTheirs, writeRejected,
} from "./buffers";

const H = (s: string) => `hash-${s}`;
const base = () => opened("a.md", "v1", H("v1"));

describe("editing", () => {
  it("marks a buffer dirty only when the text actually changes", () => {
    expect(edited(base(), "v2").dirty).toBe(true);
    expect(edited(base(), "v1").dirty).toBe(false);
  });

  it("re-bases on a successful save", () => {
    const b = saved(edited(base(), "v2"), H("v2"));
    expect(b).toMatchObject({ text: "v2", baseHash: H("v2"), dirty: false, conflict: null });
  });
});

describe("externalChange — a clean buffer", () => {
  it("reloads silently, which is the whole live-reload story", () => {
    const b = externalChange(base(), "written by an agent", H("agent"));
    expect(b).toMatchObject({ text: "written by an agent", baseHash: H("agent"), dirty: false, conflict: null });
  });

  it("ignores an echo of content it is already based on", () => {
    expect(externalChange(base(), "v1", H("v1"))).toEqual(base());
  });
});

describe("externalChange — a dirty buffer", () => {
  /** The one transition in this file that can destroy work if it is written backwards. */
  it("never overwrites unsaved text; it raises a conflict instead", () => {
    const mine = edited(base(), "the user's paragraph");
    const b = externalChange(mine, "the agent's rewrite", H("agent"));
    expect(b.text).toBe("the user's paragraph");
    expect(b.dirty).toBe(true);
    expect(b.conflict).toEqual({ theirs: "the agent's rewrite", theirHash: H("agent") });
  });

  it("is no conflict when disk now holds exactly the reader's text — a late echo of their own write", () => {
    /* THE MUTANT: drop the rule. A write that landed while the pane was away comes back as a conflict
       bar over two identical texts. */
    const b = externalChange(edited(base(), "mine"), "mine", H("mine"));
    expect(b).toMatchObject({ text: "mine", baseHash: H("mine"), dirty: false, conflict: null });
  });

  it("blocks saving until the conflict is resolved", () => {
    const b = externalChange(edited(base(), "mine"), "theirs", H("theirs"));
    expect(canSave(b)).toBe(false);
  });
});

describe("deletion underneath an open editor", () => {
  it("keeps the text, and does not count the deletion as typing", () => {
    /* THE MUTANT: mark the buffer dirty on a deletion, as it once was "so a save could rescue it". The
       pane's saves then put every deleted file back — see the pane's own tests for what that costs. */
    const b = externalChange(base(), null, null);
    expect(b).toMatchObject({ text: "v1", missing: true, dirty: false });
    expect(canSave(b)).toBe(false);
    expect(canRecreate(b)).toBe(false);
  });

  it("keeps the reader's typing, and leaves putting the file back to them", () => {
    const b = externalChange(edited(base(), "mine"), null, null);
    expect(b).toMatchObject({ text: "mine", missing: true, dirty: true });
    // Never on its own — not the autosave, not the write as the file is left…
    expect(canSave(b)).toBe(false);
    expect(mayWrite(b)).toBe(false);
    // …only when the reader says Keep mine.
    expect(canRecreate(b)).toBe(true);
    expect(mayWrite(b, true)).toBe(true);
  });

  it("clears the missing flag when the file comes back unchanged, and saves only typing that was there", () => {
    const untouched = externalChange(externalChange(base(), null, null), "v1", H("v1"));
    expect(untouched).toMatchObject({ missing: false, dirty: false, conflict: null });
    expect(canSave(untouched)).toBe(false);
    const typed = externalChange(externalChange(edited(base(), "mine"), null, null), "v1", H("v1"));
    expect(typed).toMatchObject({ text: "mine", missing: false, dirty: true, conflict: null });
    expect(canSave(typed)).toBe(true);
  });

  it("adopts a file that comes back different when nobody typed in it — a checkout is not a conflict", () => {
    const back = externalChange(externalChange(base(), null, null), "recreated by git checkout", H("other"));
    expect(back).toMatchObject({ text: "recreated by git checkout", baseHash: H("other"), missing: false, dirty: false, conflict: null });
  });

  it("raises a conflict — and stops reporting missing — when it comes back different under typing", () => {
    const gone = externalChange(edited(base(), "mine"), null, null);
    const back = externalChange(gone, "recreated by git checkout", H("other"));
    expect(back.missing).toBe(false);
    expect(back.conflict).toEqual({ theirs: "recreated by git checkout", theirHash: H("other") });
    expect(back.text).toBe("mine"); // the user's copy is still the one on screen
  });

  it("drops a pending conflict, which has no \"theirs\" left to take, and keeps the reader's text", () => {
    const conflicted = externalChange(edited(base(), "mine"), "theirs", H("theirs"));
    const gone = externalChange(conflicted, null, null);
    expect(gone).toMatchObject({ text: "mine", missing: true, dirty: true, conflict: null });
    expect(canRecreate(gone)).toBe(true);
  });
});

describe("what may be written", () => {
  it("never a file the pane holds no text for, whatever its buffer says", () => {
    /* Its text is the empty string, so a write empties the file. THE MUTANT: drop the kind check from
       `mayWrite`. A PDF, a document Quick Look draws, or a video, dirty for any reason, becomes 0 bytes. */
    for (const path of ["slides/handout.pdf", "report.docx", "shot.png", "demo.mov"]) {
      const b = edited(opened(path, "", ""), "anything");
      expect(canSave(b)).toBe(true);
      expect(mayWrite(b)).toBe(false);
      expect(mayWrite({ ...b, missing: true }, true)).toBe(false);
    }
  });

  it("typing on a file that is there, and nothing else", () => {
    expect(mayWrite(base())).toBe(false);
    expect(mayWrite(edited(base(), "v2"))).toBe(true);
    expect(mayWrite(externalChange(edited(base(), "mine"), "theirs", H("theirs")))).toBe(false);
    expect(mayWrite(externalChange(base(), null, null), true)).toBe(false); // a deleted file nobody typed in stays deleted
  });

  it("a binary's change on disk leaves it clean and present, on its new hash", () => {
    /* Rebuilt behind its tab after a delete. THE MUTANT: adopt the hash and nothing else — the tab goes
       on saying the file was deleted, and a buffer the old deletion had marked dirty stays writable. */
    const pdf = { ...opened("handout.pdf", "", ""), missing: true, dirty: true };
    expect(binaryChanged(pdf, H("rebuilt"))).toMatchObject({ baseHash: H("rebuilt"), missing: false, dirty: false, conflict: null });
  });
});

describe("resolving a conflict", () => {
  const conflicted = () => externalChange(edited(base(), "mine"), "theirs", H("theirs"));

  it("keep-mine re-bases so the next save actually succeeds", () => {
    const b = keepMine(conflicted());
    expect(b).toMatchObject({ text: "mine", baseHash: H("theirs"), conflict: null, dirty: true });
    // The mutant: clearing the conflict without re-basing. The save then fails the server's baseHash
    // check and the user is handed the same dialog forever.
    expect(canSave(b)).toBe(true);
  });

  it("take-theirs adopts disk and leaves nothing to save", () => {
    const b = takeTheirs(conflicted());
    expect(b).toMatchObject({ text: "theirs", baseHash: H("theirs"), conflict: null, dirty: false });
    expect(canSave(b)).toBe(false);
  });

  it("resolvers are no-ops when there is no conflict", () => {
    expect(keepMine(base())).toEqual(base());
    expect(takeTheirs(base())).toEqual(base());
  });
});

describe("a save the server refused", () => {
  it("says the file is there, so a deleted file found back with other contents is a conflict and not a deletion", () => {
    /* THE MUTANT: leave `missing` as it was. The conflict's Keep mine then lands on a buffer still
       marked deleted, which nothing saves, and the bar goes back to saying the file was deleted. */
    const gone = externalChange(edited(base(), "mine"), null, null);
    const b = writeRejected(gone, "made again by an agent", H("again"));
    expect(b).toMatchObject({ text: "mine", missing: false, dirty: true, conflict: { theirs: "made again by an agent", theirHash: H("again") } });
    expect(canSave(keepMine(b))).toBe(true);
  });

  it("over a disk that already holds the reader's text, is a save", () => {
    /* THE MUTANT: drop the rule in writeRejected. A second write of typing the first already put there
       (a pane that came back before its own write did) asks the reader to choose between twins. */
    const b = writeRejected(edited(base(), "mine"), "mine", H("mine"));
    expect(b).toMatchObject({ text: "mine", baseHash: H("mine"), dirty: false, conflict: null });
  });

  it("lands in the same conflict state as an observed change", () => {
    const mine = edited(base(), "mine");
    const b = writeRejected(mine, "theirs", H("theirs"));
    expect(b.text).toBe("mine");
    expect(b.conflict).toEqual({ theirs: "theirs", theirHash: H("theirs") });
    expect(canSave(b)).toBe(false);
    expect(canSave(keepMine(b))).toBe(true);
  });
});
