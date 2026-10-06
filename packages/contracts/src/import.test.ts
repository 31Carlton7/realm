import { describe, it, expect } from "vitest";
import { Methods } from "./rpc";
import { IMPORT_MEMORY_MARKER_CLOSE, IMPORT_MEMORY_MARKER_OPEN, withImportedMemory } from "./import";

describe("withImportedMemory", () => {
  const block = "## Imported memory\n\n- [A fact](/Users/me/Realm/memory/imported/S1/proj/a.md)";
  const fenced = `${IMPORT_MEMORY_MARKER_OPEN}\n${block}\n${IMPORT_MEMORY_MARKER_CLOSE}`;

  it("appends a fenced block to an empty document", () => {
    expect(withImportedMemory("", block)).toBe(`${fenced}\n`);
  });

  it("appends below the user's own writing without touching it", () => {
    const doc = withImportedMemory("My standing instructions.", block);
    expect(doc.startsWith("My standing instructions.")).toBe(true);
    expect(doc).toContain(fenced);
  });

  it("REPLACES the block on re-import rather than stacking a second copy", () => {
    const once = withImportedMemory("Mine.", block);
    const twice = withImportedMemory(once, `${block}\n- [B fact](/x/b.md)`);
    expect(twice.split(IMPORT_MEMORY_MARKER_OPEN)).toHaveLength(2);
    expect(twice).toContain("B fact");
    expect(twice).toContain("Mine.");
  });

  it("preserves text on BOTH sides of the fence", () => {
    const doc = `Above.\n\n${fenced}\n\nBelow.`;
    const next = withImportedMemory(doc, "## Imported memory\n\n- new");
    expect(next).toContain("Above.");
    expect(next).toContain("Below.");
    expect(next).toContain("- new");
    expect(next).not.toContain("A fact");
  });

  it("an empty block removes the fence, leaving the user's own text and nothing else", () => {
    const doc = withImportedMemory("Mine.", block);
    expect(withImportedMemory(doc, "")).toBe("Mine.\n");
  });

  it("an empty block on a document with no fence changes nothing", () => {
    expect(withImportedMemory("Mine.", "")).toBe("Mine.");
  });

  it("treats a close marker with no open one as no fence, rather than slicing away the user's text", () => {
    // Hand-edited into nonsense. Slicing on the stray marker would eat everything before it.
    const doc = `Mine.\n${IMPORT_MEMORY_MARKER_CLOSE}\nAlso mine.`;
    const next = withImportedMemory(doc, block);
    expect(next).toContain("Mine.");
    expect(next).toContain("Also mine.");
    expect(next).toContain(block);
  });
});

describe("import contracts", () => {

  it("apply defaults every list, so a partial selection is not a validation error", () => {
    expect(Methods["import.apply"].params.parse({})).toEqual({ sessions: [], memories: [], skills: [] });
  });

  it("apply defaults a session target to 'no space, no profile' rather than inventing one", () => {
    const p = Methods["import.apply"].params.parse({ sessions: [{ key: "/a/b.jsonl" }] });
    expect(p.sessions[0]).toEqual({ key: "/a/b.jsonl", spaceId: null, profileId: null });
  });

  it("apply refuses a skill id that is not a plain directory name", () => {
    expect(Methods["import.apply"].params.safeParse({ skills: ["../../etc"] }).success).toBe(false);
    expect(Methods["import.apply"].params.safeParse({ skills: ["web-design"] }).success).toBe(true);
  });

});
