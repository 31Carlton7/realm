import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Icon } from "@realm/ui";

afterEach(cleanup);

/** The stroke a rendered glyph is ACTUALLY drawn with, in CSS px: its stroke-width in the 24-unit
 *  grid, scaled to the size it is drawn at. */
function drawnStroke(size: number): number {
  const { container } = render(<Icon name="settings" size={size} />);
  const svg = container.querySelector("svg")!;
  const stroked = svg.querySelector("[stroke-width]")!;
  const units = Number(stroked.getAttribute("stroke-width"));
  const grid = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
  cleanup();
  return (units * size) / grid;
}

describe("icon stroke", () => {
  /* The pack's own 1.5 is in grid units, so at the small rungs it drew a hairline (0.75px at 12),
     fainter than the 12-13px text it sits in. THE mutant is dropping `absoluteStrokeWidth`, which puts
     the 12 rung back at 0.75 and fails the first line. */
  it("holds a visible weight at the small rungs and never outgrows 1.5px at the large ones", () => {
    expect(drawnStroke(12)).toBeCloseTo(1.125, 2);
    expect(drawnStroke(14)).toBeCloseTo(14 / 12, 2);
    expect(drawnStroke(16)).toBeCloseTo(16 / 12, 2);
    expect(drawnStroke(18)).toBeCloseTo(1.5, 2);
    expect(drawnStroke(20)).toBeCloseTo(1.5, 2);
  });

  it("never gets lighter as the glyph gets larger", () => {
    const rungs = [12, 14, 16, 18, 20].map(drawnStroke);
    for (let i = 1; i < rungs.length; i++) expect(rungs[i]!).toBeGreaterThanOrEqual(rungs[i - 1]!);
  });
});
