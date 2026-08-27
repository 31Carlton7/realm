import { describe, expect, it } from "vitest";
import { hexToHsl, hslToHex, paletteFromColor, themeToCssVars } from "./theme";

describe("hex/hsl roundtrip", () => {
  it("hslToHex(hexToHsl(x)) === x", () => { expect(hslToHex(hexToHsl("#7c6cff"))).toBe("#7c6cff"); });
});

describe("paletteFromColor (flat)", () => {
  it("dark palette uses fixed neutral surfaces and the space colour only as accent", () => {
    const p = paletteFromColor("#3ddc97", "dark");
    expect(p.frame).toBe("#131417");
    expect(p.panel).toBe("#1b1c20");
    expect(p.raised).toBe("#222329");
    expect(p.line).toBe("#26272c");
    expect(p.accent).not.toBe(p.frame);
  });
  it("accent is contrast-adjusted: a near-black accent is lightened in dark mode", () => {
    const p = paletteFromColor("#111111", "dark");
    expect(hexToHsl(p.accent).l).toBeGreaterThan(40);
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
    expect(vars["--rl-mode"]).toBeUndefined();
  });
});
