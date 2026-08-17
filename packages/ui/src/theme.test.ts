import { describe, expect, it } from "vitest";
import { hexToHsl, hslToHex, paletteFromColor, themeToCssVars } from "./theme";
describe("theme", () => {
  it("hex/hsl roundtrip", () => { expect(hslToHex(hexToHsl("#7c6cff"))).toBe("#7c6cff"); });
  it("light palette has pale sidebar tint and near-white surface; dark has deep tint and near-black surface", () => {
    const l = paletteFromColor("#7c6cff", "light"); const d = paletteFromColor("#7c6cff", "dark");
    expect(hexToHsl(l.sidebarBg).l).toBeGreaterThan(80); expect(hexToHsl(l.surface).l).toBeGreaterThan(95);
    expect(hexToHsl(d.sidebarBg).l).toBeLessThan(25); expect(hexToHsl(d.surface).l).toBeLessThan(12);
    expect(l.accent).toBe("#7c6cff");
  });
  it("gray/black/white accents yield neutral sidebar tints; 3-digit hex is accepted", () => {
    for (const hex of ["#808080", "#000000", "#ffffff"]) {
      for (const mode of ["light", "dark"] as const) {
        const p = paletteFromColor(hex, mode);
        expect(hexToHsl(p.sidebarBg).s).toBe(0); expect(hexToHsl(p.sidebarBg2).s).toBe(0);
      }
    }
    expect(hexToHsl(paletteFromColor("#7c6cff", "light").sidebarBg).s).toBeGreaterThan(50);
    // low-but-nonzero saturation scales down proportionally
    const soft = paletteFromColor(hslToHex({ h: 200, s: 15, l: 50 }), "light");
    expect(hexToHsl(soft.sidebarBg).s).toBeLessThan(40); expect(hexToHsl(soft.sidebarBg).s).toBeGreaterThan(20);
    expect(paletteFromColor("#f00", "dark").accent).toBe("#f00");
    expect(hexToHsl(paletteFromColor("#f00", "dark").sidebarBg).h).toBeCloseTo(0, 0);
  });
  it("themeToCssVars emits --rl-* variables", () => {
    const vars = themeToCssVars(paletteFromColor("#3ddc97", "light"));
    expect(vars["--rl-accent"]).toBe("#3ddc97"); expect(Object.keys(vars).every((k) => k.startsWith("--rl-"))).toBe(true);
  });
});
