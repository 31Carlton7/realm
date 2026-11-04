import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEAMMATE_COLORS, TEAMMATE_SHAPES } from "../../../packages/contracts/src/teammates";
import { BADGE_OKLCH, EYE_OKLCH, TEAMMATE_PALETTE } from "../../../packages/ui/src/teammate-icon/palette";
import { SHAPE_GEO, TEAMMATE_SHAPE_LABELS } from "../../../packages/ui/src/teammate-icon/shapes";

/** The phone draws teammates' icons from its own copy of the desktop's numbers (TeammateMark.swift):
 *  these fail when one side moves and the other does not. */
const swift = readFileSync(new URL("../Realm/Theme/TeammateMark.swift", import.meta.url), "utf8");

describe("the iPhone's teammate icons", () => {
  it("have the desktop's twelve colours, in its order, at its hues and chromas", () => {
    const rows = [...swift.matchAll(/\("(\w+)", "([^"]+)", ([\d.]+), ([\d.]+)\)/g)].map((m) => [m[1], m[2], Number(m[3]), Number(m[4])]);
    expect(rows).toEqual(TEAMMATE_COLORS.map((c) => [c, TEAMMATE_PALETTE[c].label, TEAMMATE_PALETTE[c].hue, TEAMMATE_PALETTE[c].chroma]));
  });

  it("set the bodies, the eyes and the Lead's star at the desktop's lightness on each face", () => {
    expect(swift).toContain("oklch(dark ? 0.645 : 0.605, color.chroma, color.hue)");
    const at = (o: { l: number; c: number; h: number }) => `oklch(${o.l}, ${o.c}, ${o.h})`;
    expect(swift).toContain(`dark ? ${at(EYE_OKLCH.dark)} : ${at(EYE_OKLCH.light)}`);
    expect(swift).toContain(`dark ? ${at(BADGE_OKLCH.dark)} : ${at(BADGE_OKLCH.light)}`);
  });

  it("have the desktop's eight shapes, each with its label and where its eyes sit", () => {
    expect(swift).toContain(`case ${TEAMMATE_SHAPES.join(", ")}`);
    for (const shape of TEAMMATE_SHAPES) {
      expect(swift).toContain(`case .${shape}: "${TEAMMATE_SHAPE_LABELS[shape]}"`);
      const [x, y] = SHAPE_GEO[shape].face;
      expect(swift).toContain(`case .${shape}: CGPoint(x: ${x}, y: ${y})`);
    }
  });
});
