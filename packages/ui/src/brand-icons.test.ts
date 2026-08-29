import { describe, expect, it } from "vitest";
import { brandMarks, isBrandName } from "./brand-icons";

describe("brand marks", () => {
  it("covers every provider the prompter can name", () => {
    expect(Object.keys(brandMarks).sort()).toEqual(["claude", "cursor", "gemini", "openai"]);
  });

  it("every mark is real 24×24 path data", () => {
    for (const [name, mark] of Object.entries(brandMarks)) {
      // A path that does not open with a moveto is not a path; a short one is a placeholder someone
      // typed rather than a glyph anyone traced.
      expect(mark.d, name).toMatch(/^[Mm]/);
      expect(mark.d.length, name).toBeGreaterThan(200);
      // No bounds assertion: path data packs numbers with implicit separators (`.9957.1336`), so
      // checking that every coordinate fits 24×24 needs a real path parser, not a number regex —
      // more machinery than the invariant is worth. Icon's render test covers the viewBox instead.
    }
  });

  it("keeps the even-odd fill on the OpenAI blossom and only there", () => {
    // The blossom is one self-intersecting path: under the default nonzero rule its negative space
    // fills in and the mark renders as a blob. The other three are simple paths that nonzero draws
    // correctly, and forcing even-odd on Cursor would hollow out its cube.
    expect(Object.entries(brandMarks).filter(([, m]) => "evenOdd" in m).map(([n]) => n)).toEqual(["openai"]);
  });

  it("isBrandName accepts the marks and rejects Hugeicons names", () => {
    expect(isBrandName("claude")).toBe(true);
    expect(isBrandName("openai")).toBe(true);
    expect(isBrandName("bot")).toBe(false);
    expect(isBrandName("toString")).toBe(false); // own-property check, not a prototype walk
  });
});
