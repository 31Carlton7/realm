import { describe, expect, it } from "vitest";
import { applyTheme, hexToHsl, hslToHex, spaceColor } from "./theme";

/** Plan 9 W1 re-scope: the ink-grayscale palette generator is gone — surfaces, text tiers, accent,
 *  semantic colours and shadows are the Beautiful UI token set, static CSS in the renderer
 *  (theme/tokens.css + the styles.css bridge, pinned by styles.test.ts there). This module now owns
 *  exactly two things, and these tests cover exactly those: the contrast-clamped space colour, and
 *  the runtime application of `--rl-space` + `data-mode`. The old pins on `#1a1a1a` panels and
 *  `#f2f2f2` ink asserted values this module no longer produces. */

describe("hex/hsl roundtrip", () => {
  it("hslToHex(hexToHsl(x)) === x", () => { expect(hslToHex(hexToHsl("#7c6cff"))).toBe("#7c6cff"); });
});

describe("spaceColor (the one identity pixel, clamp rules unchanged from spec 2026-08-27 §3)", () => {
  it("keeps the space colour's hue (it is the identity pixel, not a recolour)", () => {
    expect(Math.abs(hexToHsl(spaceColor("#3ddc97", "dark")).h - hexToHsl("#3ddc97").h)).toBeLessThan(2);
  });
  it("near-black is lightened in dark mode", () => {
    expect(hexToHsl(spaceColor("#111111", "dark")).l).toBeGreaterThan(40);
  });
  it("near-white is darkened in dark mode", () => {
    expect(hexToHsl(spaceColor("#ffffff", "dark")).l).toBeLessThanOrEqual(75);
  });
  it("the clamp flips for light mode: lightness lands in [35, 55]", () => {
    // Round-tripped through hex (8-bit quantization), so allow a hair outside the clamp.
    expect(hexToHsl(spaceColor("#ffffff", "light")).l).toBeLessThan(56);
    expect(hexToHsl(spaceColor("#111111", "light")).l).toBeGreaterThan(34);
  });
  it("achromatic input stays achromatic (no fabricated hue), lightness clamped", () => {
    const hsl = hexToHsl(spaceColor("#888888", "dark"));
    expect(hsl.s).toBeLessThan(8);
    expect(hsl.l).toBeGreaterThan(54);
    expect(hsl.l).toBeLessThan(76);
  });
  it("washed-out hued input still gets the 25% saturation floor", () => {
    expect(hexToHsl(spaceColor("#8a7f9e", "dark")).s).toBeGreaterThanOrEqual(25); // s ≈ 13.8, above the achromatic threshold
  });
});

describe("applyTheme (runtime writes: --rl-space and data-mode, nothing else)", () => {
  const fakeRoot = () => {
    const props: Record<string, string> = {};
    const root = {
      style: { setProperty: (k: string, v: string) => { props[k] = v; } },
      dataset: {} as Record<string, string>,
    } as unknown as HTMLElement;
    return { root, props };
  };

  it("writes the clamped space colour to --rl-space and stamps data-mode", () => {
    for (const mode of ["dark", "light"] as const) {
      const { root, props } = fakeRoot();
      applyTheme("#3ddc97", mode, root);
      expect(props["--rl-space"]).toBe(spaceColor("#3ddc97", mode));
      expect((root as unknown as { dataset: Record<string, string> }).dataset.mode).toBe(mode);
    }
  });

  it("writes no other custom property — the BUI tokens are CSS truth, not runtime writes", () => {
    const { root, props } = fakeRoot();
    applyTheme("#7c6cff", "dark", root);
    expect(Object.keys(props)).toEqual(["--rl-space"]);
  });
});
