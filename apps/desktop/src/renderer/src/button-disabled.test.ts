import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES, themeModes } from "@realm/ui";
import { CONTRAST_FLOOR, themeVars } from "@realm/ui/src/themes";
import { parseOklch, srgb, srgbLuminance } from "@realm/contracts";

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.replace(/\s+/g, " ").trim()),
  body: m[2]!,
}));

/** The value a disabled primary ends up with for `prop`: the rules that reach it, most specific
 *  last, the way the cascade settles it. */
function settled(prop: string): string | null {
  const chain = ["button:disabled", ".btn:disabled", ".btn.primary:disabled"];
  let value: string | null = null;
  for (const sel of chain) {
    for (const r of RULES.filter((x) => x.selectors.includes(sel))) {
      const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(r.body);
      if (m) value = m[1]!.trim();
    }
  }
  return value;
}

/** Contrast of `ink` drawn at `alpha` over `ground`, composited the way the screen does it. */
function drawnContrast(ink: string, ground: string, alpha: number): number {
  const fg = srgb(parseOklch(ink)), bg = srgb(parseOklch(ground));
  const mixed = fg.map((c, i) => c * alpha + bg[i]! * (1 - alpha));
  const a = srgbLuminance(mixed), b = srgbLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("a disabled primary keeps its label", () => {
  it("is dimmed once, not twice", () => {
    /* MN-03: the faint label AND the 45% every disabled button takes, so "Create" on an empty New
       space sheet measured about 1.5:1. THE MUTANT: the `opacity: 1` taken off `.btn.primary:disabled`. */
    expect(settled("color")).toBe("var(--rl-text-faint)");
    expect(Number(settled("opacity") ?? 1)).toBe(1);
  });

  it("reads at the quiet tier's floor on its own fill, in every theme and mode", () => {
    const alpha = Number(settled("opacity") ?? 1);
    const misses: string[] = [];
    for (const t of THEMES) {
      for (const mode of themeModes(t.name)) {
        const v = themeVars(t.name, mode);
        if (!v["--ink-3"]?.startsWith("oklch") || !v["--surface"]?.startsWith("oklch")) continue;
        const ratio = drawnContrast(v["--ink-3"], v["--surface"], alpha);
        if (ratio < CONTRAST_FLOOR.ink3) misses.push(`${t.name} ${mode}: ${ratio.toFixed(2)}`);
      }
    }
    expect(misses).toEqual([]);
  });
});
