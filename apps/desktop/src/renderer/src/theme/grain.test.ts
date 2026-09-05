import { describe, expect, it } from "vitest";
import { grainVars } from "./grain";

const num = (v: unknown) => Number(String(v).replace(/(deg|%)$/, ""));
const SURFACES = ["sheet", "settings-page", "notifications-page"];
const vars = (surface: string, seed: number) => grainVars(surface, seed) as unknown as Record<string, string>;

/* The bounds are written out here rather than imported from the module: a test that reads its
   expectation out of the constant it is checking widens with it, and every widening is exactly the
   change that would put a decorative field somewhere it does not belong. */
describe("the decorative wash's randomisation", () => {
  it("stays inside the arc and the top band, whatever the seed", () => {
    for (let seed = 0; seed < 3000; seed++) {
      for (const surface of SURFACES) {
        const v = vars(surface, seed);
        expect(Math.abs(num(v["--grain-hue"]))).toBeLessThanOrEqual(40);
        expect(num(v["--grain-x"])).toBeGreaterThanOrEqual(12);
        expect(num(v["--grain-x"])).toBeLessThanOrEqual(88);
        // Never below the midline: the app lights everything from above, and a glow climbing out of
        // a bottom corner reads as a rendering fault rather than as a decision.
        expect(num(v["--grain-y"])).toBeLessThan(50);
        expect(num(v["--grain-spread"])).toBeGreaterThanOrEqual(72);
        expect(num(v["--grain-spread"])).toBeLessThanOrEqual(108);
      }
    }
  });

  it("is the same picture every time it is asked, so a re-render cannot reshuffle it", () => {
    expect(grainVars("sheet", 12345)).toEqual(grainVars("sheet", 12345));
  });

  it("gives two surfaces on screen together two different pictures", () => {
    expect(new Set(SURFACES.map((s) => JSON.stringify(grainVars(s, 7)))).size).toBe(SURFACES.length);
  });

  it("re-rolls with the launch seed rather than being a constant", () => {
    expect(new Set(Array.from({ length: 64 }, (_, i) => JSON.stringify(grainVars("sheet", i)))).size).toBeGreaterThan(48);
  });

  it("spends the whole arc and the whole spread, so the bounds bind nothing that is never reached", () => {
    const draws = Array.from({ length: 4000 }, (_, i) => vars("sheet", i));
    const hues = draws.map((v) => num(v["--grain-hue"]));
    const spread = draws.map((v) => num(v["--grain-spread"]));
    expect(Math.min(...hues)).toBeLessThan(-37);
    expect(Math.max(...hues)).toBeGreaterThan(37);
    expect(Math.min(...spread)).toBeLessThan(75);
    expect(Math.max(...spread)).toBeGreaterThan(105);
  });
});
