import { describe, expect, it } from "vitest";
import { applyTheme, hexToHsl, hslToHex, paletteFromColor, themeToCssVars } from "./theme";

describe("hex/hsl roundtrip", () => {
  it("hslToHex(hexToHsl(x)) === x", () => { expect(hslToHex(hexToHsl("#7c6cff"))).toBe("#7c6cff"); });
});

/** WCAG relative-luminance contrast — computed, not pinned, so any future re-grey keeps text legible. */
const luminance = (hex: string): number => {
  const n = parseInt(hex.replace("#", ""), 16);
  const chan = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Pure grey = identical channels — the ink spec's "no blue cast" invariant. */
const isPureGrey = (hex: string): boolean => {
  const n = parseInt(hex.replace("#", ""), 16);
  return ((n >> 16) & 255) === ((n >> 8) & 255) && ((n >> 8) & 255) === (n & 255);
};

describe("paletteFromColor (ink grayscale, spec 2026-08-27 §3)", () => {
  it("sanity: the contrast formula itself is sound (black on white = 21:1)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("every dark surface is a pure neutral grey — no blue cast, no space tint", () => {
    const p = paletteFromColor("#3ddc97", "dark");
    for (const k of ["frame", "panel", "raised", "line", "lineStrong", "terminalBg"] as const) {
      expect(isPureGrey(p[k]), `dark ${k} (${p[k]})`).toBe(true);
    }
  });
  it("light surfaces are pure neutral greys too", () => {
    const p = paletteFromColor("#3ddc97", "light");
    for (const k of ["frame", "raised", "line", "lineStrong", "terminalBg"] as const) {
      expect(isPureGrey(p[k]), `light ${k} (${p[k]})`).toBe(true);
    }
    expect(p.panel).toBe("#ffffff");
  });

  it("ground tint is dead: any two space colours produce identical frame/panel", () => {
    const violet = paletteFromColor("#7c6cff", "dark");
    const green = paletteFromColor("#3ddc97", "dark");
    expect(violet.frame).toBe(green.frame);
    expect(violet.panel).toBe(green.panel);
    expect(violet.frame).toBe("#121212");
    expect(violet.panel).toBe("#1a1a1a");
  });

  it("accent is the fixed ink value per mode — never derived from the space colour", () => {
    // A violet space must produce ink accent (mutation target: any surviving derivation fails here).
    expect(paletteFromColor("#7c6cff", "dark").accent).toBe("#f2f2f2");
    expect(paletteFromColor("#3ddc97", "dark").accent).toBe("#f2f2f2");
    expect(paletteFromColor("#7c6cff", "light").accent).toBe("#181818");
    expect(paletteFromColor("#3ddc97", "light").accent).toBe("#181818");
  });
  it("accentContrast pairs with accent per mode", () => {
    expect(paletteFromColor("#7c6cff", "dark").accentContrast).toBe("#111111");
    expect(paletteFromColor("#7c6cff", "light").accentContrast).toBe("#ffffff");
  });
  it("accent on its contrast colour clears WCAG AA in both modes (button text)", () => {
    for (const mode of ["dark", "light"] as const) {
      const p = paletteFromColor("#3ddc97", mode);
      expect(contrast(p.accent, p.accentContrast), `${mode} accent/contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("terminal-bg is the darkest step in dark mode (pinned) and stays dark in light mode", () => {
    const d = paletteFromColor("#3ddc97", "dark");
    expect(d.terminalBg).toBe("#0e0e0e");
    expect(luminance(d.terminalBg)).toBeLessThan(luminance(d.frame));
    expect(paletteFromColor("#3ddc97", "light").terminalBg).toBe("#141414");
  });

  it("space keeps the space colour, contrast-clamped: near-black is lightened in dark mode", () => {
    const p = paletteFromColor("#111111", "dark");
    expect(hexToHsl(p.space).l).toBeGreaterThan(40);
  });
  it("space clamp: near-white is darkened in dark mode", () => {
    expect(hexToHsl(paletteFromColor("#ffffff", "dark").space).l).toBeLessThanOrEqual(75);
  });
  it("space clamp flips for light mode: lightness lands in [35, 55]", () => {
    const hi = hexToHsl(paletteFromColor("#ffffff", "light").space);
    const lo = hexToHsl(paletteFromColor("#111111", "light").space);
    // Round-tripped through hex (8-bit quantization), so allow a hair outside the clamp.
    expect(hi.l).toBeLessThan(56);
    expect(lo.l).toBeGreaterThan(34);
  });
  it("achromatic space colour stays achromatic (no fabricated hue), lightness clamped", () => {
    const hsl = hexToHsl(paletteFromColor("#888888", "dark").space);
    expect(hsl.s).toBeLessThan(8);
    expect(hsl.l).toBeGreaterThan(54);
    expect(hsl.l).toBeLessThan(76);
  });
  it("washed-out hued space colour still gets the 25% saturation floor", () => {
    const p = paletteFromColor("#8a7f9e", "dark"); // s ≈ 13.8, above the achromatic threshold
    expect(hexToHsl(p.space).s).toBeGreaterThanOrEqual(25);
  });
  it("space keeps the input's hue (it is the identity pixel, not a recolour)", () => {
    const p = paletteFromColor("#3ddc97", "dark");
    expect(Math.abs(hexToHsl(p.space).h - hexToHsl("#3ddc97").h)).toBeLessThan(2);
  });

  it("hover and active are translucent per-mode fills (read on any surface)", () => {
    const d = paletteFromColor("#3ddc97", "dark");
    expect(d.hover).toBe("rgba(255,255,255,.06)");
    expect(d.active).toBe("rgba(255,255,255,.09)");
    const l = paletteFromColor("#3ddc97", "light");
    expect(l.hover).toBe("rgba(0,0,0,.05)");
    expect(l.active).toBe("rgba(0,0,0,.07)");
  });

  it("text tiers: bright and dim clear WCAG AA (≥4.5:1) on frame, panel and raised, both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      const p = paletteFromColor("#3ddc97", mode);
      for (const surface of ["frame", "panel", "raised"] as const) {
        expect(contrast(p.textBright, p[surface]), `${mode} bright on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.textDim, p[surface]), `${mode} dim on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("text-faint is the doc's pinned value per mode (deliberately sub-AA whisper tier)", () => {
    expect(paletteFromColor("#3ddc97", "dark").textFaint).toBe("#6f6f6f");
    expect(paletteFromColor("#3ddc97", "light").textFaint).toBe("#8f8f8f");
  });

  it("edge is the per-mode inset hairline; shadow is the two-layer stack", () => {
    const d = paletteFromColor("#3ddc97", "dark");
    expect(d.edge).toBe("inset 0 0 0 1px rgba(255,255,255,.07)");
    expect(d.shadow).toBe("0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.45)");
    const l = paletteFromColor("#3ddc97", "light");
    expect(l.edge).toBe("inset 0 0 0 1px rgba(0,0,0,.07)");
    expect(l.shadow).toBe("0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(20,20,20,.10)");
  });

  it("semantic colours are the desaturated ink-spec set", () => {
    const d = paletteFromColor("#3ddc97", "dark");
    expect([d.danger, d.success, d.warning]).toEqual(["#e5484d", "#46a758", "#d9822b"]);
    const l = paletteFromColor("#3ddc97", "light");
    expect([l.danger, l.success, l.warning]).toEqual(["#d93036", "#2f9e44", "#c2701d"]);
  });

  it("css vars are kebab-cased --rl-*, including the new tokens, per mode", () => {
    for (const mode of ["dark", "light"] as const) {
      const p = paletteFromColor("#7c6cff", mode);
      const vars = themeToCssVars(p);
      expect(vars["--rl-frame"]).toBe(p.frame);
      expect(vars["--rl-text-bright"]).toBe(p.textBright);
      expect(vars["--rl-active"]).toBe(p.active);
      expect(vars["--rl-accent-contrast"]).toBe(p.accentContrast);
      expect(vars["--rl-edge"]).toBe(p.edge);
      expect(vars["--rl-space"]).toBe(p.space);
      expect(vars["--rl-mode"]).toBeUndefined();
    }
  });

  it("applyTheme sets data-mode on the root element", () => {
    const root = { style: { setProperty: () => {} }, dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyTheme(paletteFromColor("#3ddc97", "dark"), root);
    expect(root.dataset.mode).toBe("dark");
  });
});
