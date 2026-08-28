import { describe, expect, it } from "vitest";
import { applyTheme, hexToHsl, hslToHex, paletteFromColor, themeToCssVars } from "./theme";

describe("hex/hsl roundtrip", () => {
  it("hslToHex(hexToHsl(x)) === x", () => { expect(hslToHex(hexToHsl("#7c6cff"))).toBe("#7c6cff"); });
});

/** Max per-channel distance between two hexes — the "sub-perceptual" yardstick for the ground tint. */
const channelDelta = (a: string, b: string): number => {
  const n = (h: string) => parseInt(h.replace("#", ""), 16);
  const x = n(a), y = n(b);
  return Math.max(
    Math.abs(((x >> 16) & 255) - ((y >> 16) & 255)),
    Math.abs(((x >> 8) & 255) - ((y >> 8) & 255)),
    Math.abs((x & 255) - (y & 255)),
  );
};

describe("paletteFromColor (flat)", () => {
  it("dark surfaces stay (near-)neutral; raised/line are fixed, frame/panel only carry the sub-perceptual tint", () => {
    const p = paletteFromColor("#3ddc97", "dark");
    expect(p.raised).toBe("#222329");
    expect(p.line).toBe("#26272c");
    // frame/panel are hue-tinted (V-X5) but must remain within a few channel steps of the base greys.
    expect(channelDelta(p.frame, "#131417")).toBeLessThanOrEqual(5);
    expect(channelDelta(p.panel, "#1b1c20")).toBeLessThanOrEqual(5);
    expect(p.accent).not.toBe(p.frame);
  });
  it("ground tint (V-X5): different space hues produce different frame/panel hexes", () => {
    const violet = paletteFromColor("#7c6cff", "dark");
    const green = paletteFromColor("#3ddc97", "dark");
    expect(violet.frame).not.toBe(green.frame);
    expect(violet.panel).not.toBe(green.panel);
    // Same lightness ladder either way — the tint is hue-only, never a luminance shift.
    expect(hexToHsl(violet.frame).l).toBeCloseTo(hexToHsl(green.frame).l, 0);
  });
  it("ground tint skips achromatic space colours — the stock greys, exactly (no fabricated hue)", () => {
    const p = paletteFromColor("#888888", "dark");
    expect(p.frame).toBe("#131417");
    expect(p.panel).toBe("#1b1c20");
    const q = paletteFromColor("#888888", "light");
    expect(q.frame).toBe("#f2f2f4");
    expect(q.panel).toBe("#ffffff");
  });
  it("light panel stays pure white under the tint — full lightness has no room for hue", () => {
    expect(paletteFromColor("#3ddc97", "light").panel).toBe("#ffffff");
  });
  it("hover is a translucent fill per mode (visible on any surface, unlike surface-on-surface fills)", () => {
    expect(paletteFromColor("#3ddc97", "dark").hover).toBe("rgba(255,255,255,.05)");
    expect(paletteFromColor("#3ddc97", "light").hover).toBe("rgba(20,20,30,.05)");
  });
  it("light raised sits below panel (#f7f7f9 vs #ffffff), so raised-on-panel fills are visible", () => {
    const p = paletteFromColor("#3ddc97", "light");
    expect(p.raised).toBe("#f7f7f9");
    expect(p.panel).toBe("#ffffff");
  });
  it("accent is contrast-adjusted: a near-black accent is lightened in dark mode", () => {
    const p = paletteFromColor("#111111", "dark");
    expect(hexToHsl(p.accent).l).toBeGreaterThan(40);
  });
  it("accent is contrast-adjusted: a near-white accent is darkened in dark mode", () => {
    const p = paletteFromColor("#ffffff", "dark");
    expect(hexToHsl(p.accent).l).toBeLessThanOrEqual(75);
  });
  it("achromatic accent stays achromatic in dark mode (no fabricated hue)", () => {
    const p = paletteFromColor("#888888", "dark");
    const hsl = hexToHsl(p.accent);
    expect(hsl.s).toBeLessThan(8);
    // Round-tripped through hex (8-bit channel quantization), so allow a hair outside the [55, 75] clamp.
    expect(hsl.l).toBeGreaterThan(54);
    expect(hsl.l).toBeLessThan(76);
  });
  it("near-black accent regression: #111111 stays achromatic, not a fabricated dusty red", () => {
    const p = paletteFromColor("#111111", "dark");
    const hsl = hexToHsl(p.accent);
    expect(hsl.s).toBeLessThan(8);
    // Round-tripped through hex (8-bit channel quantization), so allow a hair outside the [55, 75] clamp.
    expect(hsl.l).toBeGreaterThan(54);
    expect(hsl.l).toBeLessThan(76);
  });
  it("washed-out hued accent still gets the saturation floor", () => {
    const p = paletteFromColor("#8a7f9e", "dark"); // s ≈ 13.8, above the achromatic threshold
    expect(hexToHsl(p.accent).s).toBeGreaterThanOrEqual(25);
  });
  it("light palette flips the ladder", () => {
    const p = paletteFromColor("#3ddc97", "light");
    expect(hexToHsl(p.frame).l).toBeGreaterThan(90);                        // light ground
    expect(hexToHsl(p.frame).l).toBeLessThan(hexToHsl(p.panel).l);          // panel sits above frame
    expect(hexToHsl(p.textBright).l).toBeLessThan(30);
  });
  it("css vars are kebab-cased --rl-*", () => {
    const vars = themeToCssVars(paletteFromColor("#7c6cff", "dark"));
    expect(vars["--rl-frame"]).toBeDefined();
    expect(vars["--rl-text-bright"]).toBeDefined();
    expect(vars["--rl-hover"]).toBe("rgba(255,255,255,.05)");
    expect(vars["--rl-mode"]).toBeUndefined();
  });
  it("textFaint meets WCAG AA (≥4.5:1) on the panel it sits on, in both modes (V-T1/A-H4)", () => {
    // Computed, not pinned: any future re-tint of faint or panel must keep group labels, hints and
    // placeholders legible.
    const luminance = (hex: string): number => {
      const n = parseInt(hex.replace("#", ""), 16);
      const chan = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    // Sanity-pin the formula itself so a broken luminance can't vacuously pass: black-on-white is 21:1.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    for (const mode of ["dark", "light"] as const) {
      const p = paletteFromColor("#3ddc97", mode);
      expect(contrast(p.textFaint, p.panel), `${mode} faint on panel`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applyTheme sets data-mode on the root element", () => {
    const root = { style: { setProperty: () => {} }, dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyTheme(paletteFromColor("#3ddc97", "dark"), root);
    expect(root.dataset.mode).toBe("dark");
  });
});
