import { describe, expect, it } from "vitest";
import { canSave, created, edited, externalChange, keepMine, opened, saved, takeTheirs, writeRejected } from "./buffers";

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

  it("a new document starts dirty with no base", () => {
    const b = created("new.md", "# New\n");
    expect(b).toMatchObject({ baseHash: null, dirty: true });
    expect(canSave(b)).toBe(true);
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

  it("blocks saving until the conflict is resolved", () => {
    const b = externalChange(edited(base(), "mine"), "theirs", H("theirs"));
    expect(canSave(b)).toBe(false);
  });
});

describe("deletion underneath an open editor", () => {
  it("keeps the text and marks the buffer dirty so a save can rescue it", () => {
    const b = externalChange(base(), null, null);
    expect(b).toMatchObject({ text: "v1", missing: true, dirty: true });
    expect(canSave(b)).toBe(true);
  });

  it("clears the missing flag when the file comes back unchanged", () => {
    const gone = externalChange(base(), null, null);
    const back = externalChange(gone, "v1", H("v1"));
    expect(back.missing).toBe(false);
    expect(back.conflict).toBeNull();
    // Still dirty: the deletion marked it so, and this buffer cannot tell "dirty because deleted"
    // from "the user had typed before it vanished". Offering a redundant save is the safe side.
    expect(back.dirty).toBe(true);
  });

  it("raises a conflict — and stops reporting missing — when it comes back different", () => {
    const gone = externalChange(base(), null, null);
    const back = externalChange(gone, "recreated by git checkout", H("other"));
    expect(back.missing).toBe(false);
    expect(back.conflict).toEqual({ theirs: "recreated by git checkout", theirHash: H("other") });
    expect(back.text).toBe("v1"); // the user's copy is still the one on screen
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
  it("lands in the same conflict state as an observed change", () => {
    const mine = edited(base(), "mine");
    const b = writeRejected(mine, "theirs", H("theirs"));
    expect(b.text).toBe("mine");
    expect(b.conflict).toEqual({ theirs: "theirs", theirHash: H("theirs") });
    expect(canSave(b)).toBe(false);
    expect(canSave(keepMine(b))).toBe(true);
  });
});
