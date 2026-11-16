import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PANE_ALPHA, PANE_ALPHA_RANGE } from "@realm/ui";

/** The prompter thins with the pane (tokens.css, the owner 11-16). Its alpha is the pane's own mapping
 *  read 16 points further up the slider, floored where its quiet words still clear the hint floor over
 *  a picture: at 72% the placeholder measured 2.55:1 dark and 2.84:1 light, the strip's labels 2.82 and
 *  2.67, over the Cypresses at slider 0 (worst pixel under each run, in the built app). */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
const stylesCss = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");

const FLOOR = 72;

/** A token's `max`/`min`/`calc` expression over `var(--pane-alpha)` and `var(--prompter-floor)`,
 *  evaluated at a slider value in %. */
const at = (expr: string, v: number, floor = FLOOR) =>
  Function("p", "f", `return ${expr.replace(/var\(--pane-alpha\)/g, "p").replace(/var\(--prompter-floor\)/g, "f").replace(/%/g, "")
    .replace(/\bmax\(/g, "Math.max(").replace(/\bmin\(/g, "Math.min(").replace(/\bcalc\(/g, "(")};`)(v, floor) as number;

const prompterBlock = tokensCss.slice(tokensCss.indexOf("The prompter thins with the pane"));
const dark = /:root \{[^}]*--prompter-alpha: (.+);/.exec(prompterBlock)![1]!;
const light = /:root\[data-mode="light"\] \{[^}]*--prompter-alpha: (.+);/.exec(prompterBlock)![1]!;
const floor = /--prompter-floor: (\d+)%;/.exec(prompterBlock)![1]!;
const lightPane = /:root\[data-mode="light"\] \{[^}]*--pane-ground: color-mix\(in srgb, var\(--canvas\) (.+), transparent\);/.exec(tokensCss)![1]!;
const pane = { dark: (v: number) => v, light: (v: number) => at(lightPane, v) };
const prompter = { dark: (v: number) => at(dark, v), light: (v: number) => at(light, v) };
const slider = Array.from({ length: PANE_ALPHA_RANGE.max - PANE_ALPHA_RANGE.min + 1 }, (_, i) => PANE_ALPHA_RANGE.min + i);

describe("the prompter's fill follows Pane translucency", () => {
  it("is built from --pane-alpha with its floor, and the card and its tabs wear it", () => {
    // THE mutants: a floor left out (the card goes to bare material at 0), the number moved, or a rule
    // back on the opaque `--surface` / `--rl-frame`.
    expect(+floor).toBe(FLOOR);
    for (const face of ["dark", "light"] as const) {
      expect(prompter[face](PANE_ALPHA_RANGE.min)).toBeCloseTo(FLOOR, 5);
      expect(prompter[face](40)).toBeCloseTo(FLOOR, 5);
      expect(prompter[face](DEFAULT_PANE_ALPHA)).toBeCloseTo(100, 5);
      expect(prompter[face](PANE_ALPHA_RANGE.max)).toBeCloseTo(100, 5);
    }
    expect(prompter.dark(70)).toBeCloseTo(86, 5);
    expect(stylesCss).toMatch(/:root\[data-squircle\] \.composer \{ --sq-fill: color-mix\(in srgb, var\(--surface\) var\(--prompter-alpha\), transparent\); \}/);
    expect(stylesCss).toMatch(/--prompter-strip: color-mix\(in srgb, var\(--rl-frame\) var\(--prompter-alpha\), transparent\);/);
    const under = /:root\[data-squircle\] \.composer-understrip \{\s*--sq-fill: ([^;]+);/.exec(stylesCss)![1];
    expect(under).toBe("var(--prompter-strip)");
  });

  it("stays a step denser than the pane at every slider value, and opaque from the default up", () => {
    // THE mutant: the +16 dropped (the card as thin as the pane, so it stops reading as the place you
    // type), or the light face left on the dark line.
    for (const face of ["dark", "light"] as const) for (const v of slider) {
      const p = pane[face](v), c = prompter[face](v);
      if (v >= DEFAULT_PANE_ALPHA) expect(c, `${face} at ${v}`).toBeCloseTo(100, 5);
      else expect(c - p, `${face} at ${v}`).toBeGreaterThanOrEqual(8);
      expect(c, `${face} at ${v}`).toBeCloseTo(Math.max(FLOOR, Math.min(100, face === "dark" ? v + 16 : pane.light(v + 16))), 5);
    }
  });

  it("goes opaque under Reduce Transparency, on both faces", () => {
    // THE mutant: the line left out, or written as a bare `:root`, which the light rule outranks.
    const reduce = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(reduce.slice(0, reduce.indexOf("\n}") + 2)).toContain(':root, :root[data-mode="light"] { --prompter-alpha: 100%; }');
  });

  it("cuts a thinned tab at the card's line, and nothing while the card is opaque", () => {
    const tuck = /\.composer-dock \{ --tuck: min\(10px, calc\(\(100% - var\(--prompter-alpha\)\) \* 1000 - 24px\)\); \}/.test(stylesCss);
    expect(tuck).toBe(true);
    expect(stylesCss).toContain(".composer-understrip { clip-path: inset(var(--tuck) -24px -24px -24px); }");
  });
});
