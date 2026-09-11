import { describe, expect, it } from "vitest";
import { contrast, css, emitted, hexToOklch, luminance, oklchToHex } from "./oklch";

/** These numbers are checkable against something outside this repo, which is the point of testing a
 *  colour space at all: an arithmetic slip in one matrix row produces colours that still look like
 *  colours. The hex values below are the ones theme/tokens.css itself records for its OKLCH tokens,
 *  and the contrast figures are WCAG's own worked examples. */

describe("hex ⇄ oklch", () => {
  it("reproduces the hexes tokens.css documents for its own tokens", () => {
    // tokens.css: "Realm's OWN chart surface (--surface, #232427)" and main/index.ts's non-mac
    // backgroundColor "#17181a ≈ oklch(.209 .004 264.477)" — two independent notes about the same
    // two tokens, so a broken conversion cannot agree with both by accident.
    expect(oklchToHex({ l: 0.26, c: 0.006, h: 271.191 })).toBe("#232427");
    expect(oklchToHex({ l: 0.209, c: 0.004, h: 264.477 })).toBe("#17181a");
  });

  it("round-trips an 8-bit colour through the space and back", () => {
    for (const hex of ["#7c6cff", "#282c34", "#f92672", "#fdf6e3", "#000000", "#ffffff"]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it("reports a neutral's hue as 0 rather than as rounding noise", () => {
    expect(hexToOklch("#888888").c).toBeLessThan(0.001);
    expect(hexToOklch("#888888").h).toBe(0);
  });

  it("clips out-of-gamut chroma instead of wrapping it into another colour", () => {
    // oklch(0.6 0.4 150) is far outside sRGB. The browser clips; so must this, or every contrast
    // figure computed near the gamut boundary would describe a colour nobody can display.
    const hex = oklchToHex({ l: 0.6, c: 0.4, h: 150 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(luminance({ l: 0.6, c: 0.4, h: 150 })).toBeLessThanOrEqual(1);
  });
});

describe("WCAG contrast", () => {
  it("matches the two anchors of the scale", () => {
    expect(contrast(hexToOklch("#ffffff"), hexToOklch("#000000"))).toBeCloseTo(21, 2);
    expect(contrast(hexToOklch("#777777"), hexToOklch("#777777"))).toBeCloseTo(1, 6);
  });

  it("is order-independent", () => {
    const [a, b] = [hexToOklch("#1a1a1a"), hexToOklch("#cccccc")];
    expect(contrast(a, b)).toBeCloseTo(contrast(b, a), 10);
  });

  it("agrees with the figure tokens.css records for its light chart palette", () => {
    // "Three slots (3 aqua 2.82:1, 4 yellow 2.17:1, 5 magenta 2.69:1) sit below 3:1 on white."
    const white = hexToOklch("#ffffff");
    expect(contrast(hexToOklch("#1baf7a"), white)).toBeCloseTo(2.82, 1);
    expect(contrast(hexToOklch("#eda100"), white)).toBeCloseTo(2.17, 1);
    expect(contrast(hexToOklch("#e87ba4"), white)).toBeCloseTo(2.69, 1);
  });
});

describe("css()", () => {
  it("writes the form tokens.css writes, and carries alpha when asked", () => {
    expect(css({ l: 0.209, c: 0.004, h: 264.477 })).toBe("oklch(0.209 0.004 264.48)");
    expect(css({ l: 0.68, c: 0.173, h: 253.301 }, 0.16)).toBe("oklch(0.68 0.173 253.3 / 0.16)");
  });
});

describe("emitted", () => {
  it("is what css() writes, so a walk that stops at a floor stops at the shipped value", () => {
    // THE unrounded-floor mutant: measure a contrast walk on the working value instead. `css` keeps
    // three decimals of lightness — finer than a display resolves, coarser than a WCAG floor — so a
    // tier walked to exactly 3.00:1 can be written at 2.9987 and break the assertion the whole
    // palette is held to. Gruvbox dark's --ink-2 at the bottom of the contrast range is that case.
    const o = { l: 0.6184937, c: 0.0173456, h: 92.4567 };
    expect(emitted(o)).toEqual({ l: 0.618, c: 0.0173, h: 92.46 });
    expect(css(emitted(o))).toBe(css(o));
  });
});
