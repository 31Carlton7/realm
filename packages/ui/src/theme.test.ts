import { describe, expect, it } from "vitest";
import { applyTheme, hexToHsl, hslToHex, spaceColor } from "./theme";
import { THEME_VARS } from "./themes";
import { DEFAULT_FONTS, FONT_VARS, fontVars } from "./fonts";
import { DEFAULT_GROUND_ALPHA, GROUND_ALPHA_RANGE, clampGroundAlpha } from "./theme";

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

/** What `applyTheme` writes on EVERY apply, whatever the palette. The font stacks are here and the
 *  palette is not, and the difference is the point: a palette is a second skin over 85 properties of
 *  hand-tuned static CSS, so the default has to write none of it; the font tokens' static values ARE
 *  the bundled stacks, so writing them back is a no-op and there is nothing to preserve by staying
 *  silent. */
const BASE_PROPS = ["--ground-alpha", "--rl-space", ...FONT_VARS].sort();

describe("applyTheme (runtime writes: --rl-space, the fonts, the two attributes, and a custom theme's palette)", () => {
  const fakeRoot = () => {
    const props: Record<string, string> = {};
    const root = {
      style: {
        setProperty: (k: string, v: string) => { props[k] = v; },
        removeProperty: (k: string) => { delete props[k]; },
      },
      dataset: {} as Record<string, string>,
    } as unknown as HTMLElement;
    return { root, props, dataset: (root as unknown as { dataset: Record<string, string> }).dataset };
  };

  it("writes the clamped space colour to --rl-space and stamps data-mode", () => {
    for (const mode of ["dark", "light"] as const) {
      const { root, props, dataset } = fakeRoot();
      applyTheme({ space: "#3ddc97", mode: mode, theme: "realm" }, root);
      expect(props["--rl-space"]).toBe(spaceColor("#3ddc97", mode));
      expect(dataset.mode).toBe(mode);
    }
  });

  it("the default theme writes no other custom property — the BUI tokens are CSS truth, not runtime writes", () => {
    // THE default-theme mutant: make `realm` derive a palette like any other theme and this goes red.
    // Realm's own colours are 85 properties of hand-tuned static CSS with per-mode shadow stacks and
    // a validated chart palette; a mechanism that "re-derived" them would silently repaint the app
    // for every user who never asked for a theme.
    const { root, props } = fakeRoot();
    applyTheme({ space: "#7c6cff", mode: "dark", theme: "realm" }, root);
    expect(Object.keys(props).sort()).toEqual(BASE_PROPS);
  });

  it("a custom theme writes its whole palette inline, and returning to the default clears every one", () => {
    const { root, props } = fakeRoot();
    applyTheme({ space: "#7c6cff", mode: "dark", theme: "one" }, root);
    for (const name of THEME_VARS) expect(props[name], name).toMatch(/^oklch\(/);
    applyTheme({ space: "#7c6cff", mode: "dark", theme: "realm" }, root);
    // THE stale-palette mutant: drop the removeProperty branch and this keeps One Dark's inline
    // values, which beat both token blocks in tokens.css — the app would be stuck on the last theme
    // chosen with no way back short of a reload.
    expect(Object.keys(props).sort()).toEqual(BASE_PROPS);
  });

  it("writes the type faces on every apply, default included", () => {
    // THE clear-on-default mutant: treat fonts like the palette and remove them when they are the
    // default. Every property here would fall back to the stylesheet's value, which is the same
    // value — so it would look correct, until someone changed --font-ui in styles.css and the
    // "default" preference stopped meaning "the bundled face".
    const { root, props } = fakeRoot();
    applyTheme({ space: "#7c6cff", mode: "dark" }, root);
    for (const [name, value] of Object.entries(fontVars(DEFAULT_FONTS))) expect(props[name], name).toBe(value);
    applyTheme({ space: "#7c6cff", mode: "dark", fonts: { ui: "system", uiWeight: "medium", code: "system" } }, root);
    expect(props["--font-ui"]).not.toContain("Inter");
    expect(props["--fw-shift"]).not.toBe("0");
  });

  it("stamps the theme on the root so the stylesheet and the live checks can name it", () => {
    const { root, dataset } = fakeRoot();
    applyTheme({ space: "#7c6cff", mode: "dark", theme: "one" }, root);
    expect(dataset.theme).toBe("one");
  });
});

describe("the adjustable ground", () => {
  it("is written as a percentage on every apply, defaulting to the value the sidebar always had", () => {
    const props: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: () => {} }, dataset: {} } as unknown as HTMLElement;
    applyTheme({ space: "#7c6cff", mode: "dark" }, root);
    expect(props["--ground-alpha"]).toBe(`${DEFAULT_GROUND_ALPHA}%`);
    expect(DEFAULT_GROUND_ALPHA).toBe(82);
  });

  it("clamps, so no stored or hand-edited value can make the sidebar unreadable or negative", () => {
    // THE unclamped mutant: pass the stored number straight through. `ui.groundAlpha` is a settings
    // row like any other — a 0 in it would make the app's own navigation a window onto the desktop,
    // with no control on screen able to explain what happened.
    expect(clampGroundAlpha(0)).toBe(GROUND_ALPHA_RANGE.min);
    expect(clampGroundAlpha(-40)).toBe(GROUND_ALPHA_RANGE.min);
    expect(clampGroundAlpha(1000)).toBe(GROUND_ALPHA_RANGE.max);
    expect(clampGroundAlpha(63.4)).toBe(63);
    expect(GROUND_ALPHA_RANGE.min).toBe(55);
    expect(GROUND_ALPHA_RANGE.max).toBe(100); // fully opaque has to be reachable — that is "off"
  });

  it("does not compose the ground itself — that stays in CSS, where a media query can reach it", () => {
    const props: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: () => {} }, dataset: {} } as unknown as HTMLElement;
    applyTheme({ space: "#7c6cff", mode: "dark", groundAlpha: 60 }, root);
    expect(props["--sidebar-ground"]).toBeUndefined();
  });
});
