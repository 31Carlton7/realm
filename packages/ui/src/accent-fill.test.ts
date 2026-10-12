import { describe, expect, it } from "vitest";
import { contrast, hexToOklch, parseOklch as parse, type Oklch } from "@realm/contracts";
import { accentFill, FILL_BUDGET, ON_ACCENT_TARGET, WHITE } from "./accent-fill";
import { CODEX_LIGHT_SEED } from "./codex-theme";
import { CONTRAST_FLOOR, THEMES, themeVars } from "./themes";
import type { Mode } from "./theme";

const FILLS = ["--accent-fill", "--accent-fill-hover", "--accent-fill-press"] as const;

const faces = (): [string, Mode][] =>
  THEMES.flatMap((t) => (["dark", "light"] as const).filter((m) => t[m]).map((m) => [t.name, m] as [string, Mode]));

describe("a word on a filled accent control reads at AA", () => {
  it.each(faces())("%s %s: the label clears 4.5 : 1 on the fill, its hover and its press", (name, mode) => {
    const v = themeVars(name, mode);
    const label = parse(v["--rl-accent-contrast"]!);
    for (const token of FILLS) {
      expect(contrast(label, parse(v[token]!)), `${name}/${mode} ${token}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.onAccent);
    }
  });

  it("keeps Codex's own pairing: its exact blue, black on it, and a press that brightens instead of darkening", () => {
    // Codex writes black on #3a83f7 (5.8 : 1). Darkening that for a press, as a white-label button
    // does, takes it to 3.7. THE mutant: flip `away` in accentFill and this press goes dark.
    const v = themeVars("codex", "light");
    const accent = hexToOklch(CODEX_LIGHT_SEED.accent);
    expect(parse(v["--accent"]!).l).toBeCloseTo(accent.l, 3);
    expect(parse(v["--accent-fill"]!).l).toBeCloseTo(accent.l, 3);
    expect(parse(v["--rl-accent-contrast"]!).l).toBe(0);
    expect(parse(v["--accent-fill-press"]!).l).toBeGreaterThan(parse(v["--accent-fill-hover"]!).l);
    expect(parse(v["--accent-fill-hover"]!).l).toBeGreaterThan(parse(v["--accent-fill"]!).l);
  });
});

describe("any accent a user picks gets a label that reads on it", () => {
  const dark = hexToOklch("#17181a");
  const sweep: Oklch[] = [];
  for (let l = 0.2; l <= 0.96; l += 0.04) for (let h = 0; h < 360; h += 30) for (const c of [0, 0.06, 0.12, 0.2]) sweep.push({ l, c, h });

  it("clears the target on rest, hover and press, whatever the hue and lightness", () => {
    for (const accent of sweep) {
      const f = accentFill(accent, { dark });
      const at = JSON.stringify(accent);
      expect(contrast(f.label, f.fill), at).toBeGreaterThanOrEqual(ON_ACCENT_TARGET);
      expect(contrast(f.label, f.hover), at).toBeGreaterThanOrEqual(ON_ACCENT_TARGET);
      expect(contrast(f.label, f.press), at).toBeGreaterThanOrEqual(ON_ACCENT_TARGET);
      // Away from the label wherever the axis has room, so each state reads at least as well as rest.
      if (f.fill.l > 0.1 && f.fill.l < 0.9) {
        expect(contrast(f.label, f.hover), at).toBeGreaterThanOrEqual(contrast(f.label, f.fill));
        expect(contrast(f.label, f.press), at).toBeGreaterThanOrEqual(contrast(f.label, f.hover));
      }
      // The three states are distinguishable fills, not one colour three times.
      expect(Math.abs(f.hover.l - f.fill.l), at).toBeGreaterThan(0.03);
      expect(Math.abs(f.press.l - f.fill.l), at).toBeGreaterThan(0.08);
      // The fill is still the accent's colour: only its lightness moves.
      expect([f.fill.c, f.fill.h], at).toEqual([accent.c, accent.h]);
    }
  });

  it("keeps white for as long as the fill stays within the budget of the accent, and goes dark past it", () => {
    // Realm's own dark blue keeps a white label on a fill 0.136 deeper.
    const realm = accentFill(hexToOklch("#3d9aff"), { dark });
    expect(realm.label).toEqual(WHITE);
    expect(hexToOklch("#3d9aff").l - realm.fill.l).toBeLessThanOrEqual(FILL_BUDGET);
    // Dracula's lavender would need to sink past the budget to carry white: the label goes dark.
    const dracula = accentFill(hexToOklch("#bd93f9"), { dark });
    expect(dracula.label).toEqual(dark);
    expect(dracula.fill.l).toBeCloseTo(hexToOklch("#bd93f9").l, 3);
  });
});
