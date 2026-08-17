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
  it("themeToCssVars emits --rl-* variables", () => {
    const vars = themeToCssVars(paletteFromColor("#3ddc97", "light"));
    expect(vars["--rl-accent"]).toBe("#3ddc97"); expect(Object.keys(vars).every((k) => k.startsWith("--rl-"))).toBe(true);
  });
});
