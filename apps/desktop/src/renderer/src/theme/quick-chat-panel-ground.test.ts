import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveVars, REALM_SEED, seedFor, THEMES, themeModes, type Mode } from "@realm/ui";
import { CONTRAST_FLOOR } from "@realm/ui/src/themes";
import { parseOklch, srgb, srgbLuminance, type Oklch } from "@realm/contracts";

/** The quick chat panel in Glass shows the app behind it through its ground, and that app is a
 *  desktop nobody chose, as a pane's is (`pane-ground.test.ts`, whose pessimistic model this is: the
 *  window's material is assumed to do nothing). So its body ink has to hold over a white window and a
 *  black one in every face, at the alpha the stylesheet gives it. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const styles = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");

/** The Glass ground's opacity for a face, read from its rule. */
function glassAlpha(mode: Mode): number {
  const light = /:root\[data-surface="quick-chat"\]\[data-mode="light"\]\[data-glass\] \.quick-chat \{ background: color-mix\(in srgb, var\(--surface\) (\d+)%, transparent\); \}/.exec(styles);
  const dark = /:root\[data-surface="quick-chat"\]\[data-glass\] \.quick-chat \{ background: color-mix\(in srgb, var\(--surface\) (\d+)%, transparent\); \}/.exec(styles);
  const rule = mode === "light" ? light ?? dark : dark;
  if (!rule) throw new Error("no Glass ground for the quick chat panel in styles.css");
  return Number(rule[1]) / 100;
}

const over = (ground: Oklch, behind: 0 | 1, alpha: number): number =>
  srgbLuminance(srgb(ground).map((c) => c * alpha + behind * (1 - alpha)));
const ratio = (ink: Oklch, groundLuminance: number): number => {
  const a = srgbLuminance(srgb(ink));
  return (Math.max(a, groundLuminance) + 0.05) / (Math.min(a, groundLuminance) + 0.05);
};

function misses(alphaFor: (mode: Mode) => number) {
  const out: { face: string; behind: string; ratio: number }[] = [];
  for (const t of THEMES) for (const mode of themeModes(t.name)) {
    const vars = deriveVars(seedFor(t.name, mode, {}) ?? REALM_SEED[mode], mode) as Record<string, string>;
    const surface = parseOklch(vars["--surface"]!);
    for (const behind of [0, 1] as const) {
      const r = ratio(parseOklch(vars["--ink"]!), over(surface, behind, alphaFor(mode)));
      if (r < CONTRAST_FLOOR.ink) out.push({ face: `${t.name}/${mode}`, behind: behind ? "white" : "black", ratio: +r.toFixed(2) });
    }
  }
  return out;
}

describe("the quick chat panel's Glass ground", () => {
  it("keeps body text above WCAG AA on every face, over a white window and a black one", () => {
    expect(misses(glassAlpha)).toEqual([]);
  });

  it("was thinner than that before: the 62% it first had put dark body text under AA over white", () => {
    expect(misses(() => 0.62).some((m) => m.face === "realm/dark" && m.behind === "white")).toBe(true);
  });

  it("carries the prompter on the panel's ground, with no fill of its own over it", () => {
    expect(styles).toMatch(/:root\[data-surface="quick-chat"\] \.quick-chat \.composer \{ --prompter-alpha: 0%; \}/);
    expect(styles).toMatch(/\.composer \{[^}]*background: color-mix\(in srgb, var\(--surface\) var\(--prompter-alpha\), transparent\);/);
  });

  it("shows the light face's window less than the dark one's, as the panes do", () => {
    expect(glassAlpha("light")).toBeGreaterThan(glassAlpha("dark"));
    expect(glassAlpha("dark")).toBeLessThan(1);
  });
});
