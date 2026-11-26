import { describe, expect, it } from "vitest";
import { materialShapes } from "./panel-material";

/** The panel's window: 362 × 140, the bar at the bottom and the answer over it. */
const W = 362;
const H = 140;

describe("the panel material's shapes", () => {
  it("measures each shape from the window's bottom, so a window grown upward keeps them in place", () => {
    const [answer, bar] = materialShapes([
      { x: 16, y: 36, width: 330, height: 40, radius: 20 },
      { x: 16, y: 84, width: 330, height: 40, radius: 20 },
    ], H, W);
    expect(bar).toMatchObject({ x: 16, bottom: 16, width: 330, height: 40 });
    expect(answer).toMatchObject({ x: 16, bottom: 64, width: 330, height: 40 });
  });

  it("puts the edges on whole points, as the rim over them is drawn", () => {
    const [s] = materialShapes([{ x: 15.6, y: 83.7, width: 330.2, height: 40.4, radius: 20 }], H, W);
    expect(s).toMatchObject({ x: 16, bottom: 16, width: 330, height: 40 });
  });

  it("never rounds a corner past half the short side, and keeps the card's curve", () => {
    const [capsule, card] = materialShapes([
      { x: 0, y: 0, width: 100, height: 40, radius: Number.MAX_VALUE },
      { x: 0, y: 50, width: 100, height: 60, radius: 20, squircle: true },
    ], H, W);
    expect(capsule).toMatchObject({ radius: 20, squircle: false });
    expect(card).toMatchObject({ radius: 20, squircle: true });
  });

  it("keeps the shapes inside the window", () => {
    const [s] = materialShapes([{ x: -10, y: -4, width: 400, height: 40, radius: 20 }], H, W);
    expect(s).toMatchObject({ x: 0, bottom: H - 36, width: W, height: 36 });
  });

  it("drops a shape with no area, one that is not a number, and one faded out", () => {
    expect(materialShapes([
      { x: 0, y: 0, width: 0, height: 40, radius: 20 },
      { x: NaN, y: 0, width: 10, height: 40, radius: 20 },
      { x: 0, y: 0, width: 10, height: 40, radius: 20, alpha: 0 },
    ], H, W)).toEqual([]);
  });

  it("carries a fade, held to 0 to 1", () => {
    expect(materialShapes([{ x: 0, y: 0, width: 10, height: 10, radius: 5, alpha: 1.4 }], H, W)[0]!.alpha).toBe(1);
    expect(materialShapes([{ x: 0, y: 0, width: 10, height: 10, radius: 5, alpha: 0.4 }], H, W)[0]!.alpha).toBe(0.4);
  });

  it("cuts nothing for a window with no size", () => {
    expect(materialShapes([{ x: 0, y: 0, width: 10, height: 10, radius: 5 }], 0, W)).toEqual([]);
  });
});
