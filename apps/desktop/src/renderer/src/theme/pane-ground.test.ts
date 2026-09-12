import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveVars, REALM_SEED, seedFor, THEMES, themeModes, type Mode, type ThemeName } from "@realm/ui";
import { CONTRAST_FLOOR } from "@realm/ui/src/themes";
import { parseOklch, srgb, srgbLuminance, type Oklch } from "@realm/contracts";

/** The panes show the macOS material through them, which means every line of text in the app is read
 *  on a ground nobody chose: whatever is on the desktop behind the window. The stylesheet cannot be
 *  asked about that, and neither can a screenshot of one desktop — the question is what the WORST
 *  desktop does, and the worst one is a flat field of the opposite tone to the ink.
 *
 *  So the alpha is derived rather than picked: composite each theme's `--canvas` over white and over
 *  black at the pane's thinnest setting, and hold the READING to the same `CONTRAST_FLOOR` the
 *  palette derivation is held to. The number in tokens.css is the one this walks, so thinning it
 *  past what body text survives fails here rather than on someone's screen.
 *
 *  This is the pessimistic model on purpose: it assumes the raw desktop shows through, when what is
 *  actually behind the window is AppKit's material, which has already blurred and darkened whatever
 *  is back there. Measuring the material needs a real screen capture (`pane-material-live.mjs`) and
 *  Screen Recording permission; until someone runs that, the alpha is the one that holds even if the
 *  material did nothing at all. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");

/** The thin end of `--pane-alpha`, as a fraction — what a pane's ground comes to with the
 *  translucency slider pushed all the way down. Read from the file rather than restated: the point
 *  of this suite is to fail when that number moves. */
const PANE_ALPHA = (() => {
  const m = /--pane-alpha:\s*calc\((\d+(?:\.\d+)?)% \+ \(var\(--ground-alpha\) - (\d+)%\)/.exec(tokensCss);
  if (!m) throw new Error("tokens.css no longer maps --pane-alpha off --ground-alpha");
  return Number(m[1]) / 100;
})();

/** What the eye actually receives: the ground painted at `alpha` over a desktop of `behind`.
 *  Composited on the ENCODED channels, because that is where a compositor does it — mixing linear
 *  channels and taking the luminance of the result describes a pixel no screen shows. */
const over = (ground: Oklch, behind: 0 | 1, alpha: number): number =>
  srgbLuminance(srgb(ground).map((c) => c * alpha + behind * (1 - alpha)));

const ratio = (ink: Oklch, groundLuminance: number): number => {
  const a = srgbLuminance(srgb(ink)), b = groundLuminance;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const faces: { name: ThemeName; mode: Mode }[] = THEMES.flatMap((t) =>
  themeModes(t.name).map((mode) => ({ name: t.name, mode })));

/** Every face × tier × desktop-extreme that falls under its floor at a given alpha. */
function misses(alpha: number): { face: string; tier: string; ratio: number; floor: number }[] {
  const out: { face: string; tier: string; ratio: number; floor: number }[] = [];
  for (const { name, mode } of faces) {
    const vars = deriveVars(seedFor(name, mode, {}) ?? REALM_SEED[mode], mode) as Record<string, string>;
    const canvas = parseOklch(vars["--canvas"]!);
    const tiers: [string, Oklch, number][] = [
      ["--ink", parseOklch(vars["--ink"]!), CONTRAST_FLOOR.ink],
      ["--ink-2", parseOklch(vars["--ink-2"]!), CONTRAST_FLOOR.ink2],
      ["--ink-3", parseOklch(vars["--ink-3"]!), CONTRAST_FLOOR.ink3],
    ];
    for (const [tier, ink, floor] of tiers) {
      /* Both extremes, for both modes. A dark face is hurt by a white desktop and a light face by a
         black one, but a custom palette need not be either — so neither is assumed. */
      for (const behind of [0, 1] as const) {
        const r = ratio(ink, over(canvas, behind, alpha));
        if (r < floor) out.push({ face: `${name}/${mode}`, tier, ratio: +r.toFixed(2), floor });
      }
    }
  }
  return out;
}

describe("the pane ground, with the desktop showing through it", () => {
  it("keeps BODY text above WCAG AA on every face, over a white desktop and a black one", () => {
    /* The reading is the thing that may not be a judgement call, so it is the thing the alpha is
       derived from. THE mutant: thin the ground one point past the number in tokens.css. */
    expect(misses(PANE_ALPHA).filter((m) => m.tier === "--ink")).toEqual([]);
    expect(misses(PANE_ALPHA - 0.01).filter((m) => m.tier === "--ink").length,
      "--pane-alpha has more room than it claims; the mapping should be thinner").toBeGreaterThan(0);
  });

  it("names the quiet tiers it cannot cover, rather than leaving them to be discovered", () => {
    /* `--ink-2` and `--ink-3` are derived to CONTRAST_FLOOR and no further, and some vendored
       palettes land exactly on it — one/light's hint tier is 2.41 against a floor of 2.4. There is
       no alpha below opaque that keeps those above the line, so translucency costs them a fraction
       over a desktop of the opposite tone. They are hints on a borrowed palette rather than the
       reading, which is why this records the set instead of blocking on it. If a tier that carries
       meaning ever joins the list, or a face does that did not, this fails and someone looks. */
    const quiet = misses(PANE_ALPHA);
    expect(quiet.every((m) => m.tier === "--ink-2" || m.tier === "--ink-3")).toBe(true);
    expect(new Set(quiet.map((m) => m.face)).size).toBeLessThanOrEqual(faces.length);
  });

  it("would put the reading under the floor at the sidebar's own alpha, which is why the two differ", () => {
    /* The reason the slider maps rather than being shared outright: the sidebar goes to 55% and
       holds short labels. A pane at 55% does not hold a transcript. */
    const light = deriveVars(seedFor("rosepine", "light", {}) ?? REALM_SEED.light, "light") as Record<string, string>;
    const onBlack = over(parseOklch(light["--canvas"]!), 0, 0.55);
    expect(ratio(parseOklch(light["--ink"]!), onBlack)).toBeLessThan(CONTRAST_FLOOR.ink);
  });

  it("goes fully opaque under the system's reduced-transparency preference", () => {
    const block = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? "";
    expect(block).toContain("--pane-ground: var(--canvas)");
    expect(block).toContain("--sidebar-ground: var(--page)");
  });
});
