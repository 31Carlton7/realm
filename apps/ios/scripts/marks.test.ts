import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script with no type declarations
import { GLYPH_POINTS, brandSvg, build, drift, hugeiconExports, sources, strokeSvg } from "./marks.mjs";

const s = await sources();

describe("the iPhone's marks", () => {
  it("are the Mac's own drawings, file for file", () => {
    // Fails when a vendor mark, a space glyph or the Realm mark changes and the catalog was not
    // regenerated, or the other way round.
    expect(drift(build(s)), "run: node apps/ios/scripts/marks.mjs").toEqual([]);
  });

  it("notices a vendor mark that moves", () => {
    const moved = { ...s, brandMarks: { ...s.brandMarks, claude: { ...s.brandMarks.claude, d: "M0 0L24 24Z" } } };
    expect(drift(build(moved))).toContain("apps/ios/Realm/Assets.xcassets/Marks/Agents/claude.imageset/claude.svg differs from its source");
  });

  it("draws every agent kind and every space glyph, and names them in Swift", () => {
    const files = build(s);
    const swift = [...files.entries()].find(([path]) => path.endsWith("Theme/Marks.swift"))![1] as string;
    for (const [kind, meta] of Object.entries(s.AGENT_META as Record<string, { icon: string }>)) {
      expect(swift).toContain(`"${kind}": "${meta.icon}",`);
      expect([...files.keys()].some((path) => path.endsWith(`Agents/${meta.icon}.imageset/${meta.icon}.svg`)), kind).toBe(true);
    }
    for (const name of s.SPACE_ICONS as string[]) {
      expect(swift).toContain(`"${name}",`);
      expect([...files.keys()].some((path) => path.endsWith(`Spaces/${name}.imageset/${name}.svg`)), name).toBe(true);
    }
  });

  it("draws a stroke glyph at the weight the desktop gives its size", () => {
    // Shown at 20 pt, the desktop's `iconStroke` is its 1.5 px ceiling: 1.8 units of the 24-unit grid,
    // where the pack's own 1.5 would thin to 1.25 pt beside the row's text.
    expect(GLYPH_POINTS).toBe(20);
    const folder = strokeSvg(s.pack.Folder01Icon);
    expect(folder).toContain('stroke-width="1.8"');
    expect(folder).not.toContain('stroke-width="1.5"');
    expect(folder).not.toContain("currentColor");
  });

  it("keeps a wide mark's aspect rather than squeezing it square", () => {
    // OpenHands' mark is drawn on a 45 × 30 box.
    expect(brandSvg(s.brandMarks.openhands)).toContain('width="30" height="20" viewBox="0 0 45 30"');
    expect(brandSvg(s.brandMarks.openai)).toContain('fill-rule="evenodd"');
  });

  it("refuses a name the desktop draws no glyph for", () => {
    expect(() => hugeiconExports(["noSuchGlyph"], s.iconTsx)).toThrow("Icon.tsx draws no glyph called noSuchGlyph");
  });
});
