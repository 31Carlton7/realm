import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GROUND_ALPHA, DEFAULT_PANE_ALPHA, deriveVars, PANE_ALPHA_RANGE, REALM_SEED, seedFor, THEMES, themeModes, type Mode, type ThemeName } from "@realm/ui";
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

/** The thin end of `--pane-alpha`, as a fraction — what a pane's ground comes to with its
 *  translucency slider pushed all the way down. Read from the range the control is clamped to rather
 *  than restated: the point of this suite is to fail when that number moves. */
const PANE_ALPHA = PANE_ALPHA_RANGE.min / 100;

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

  it("is the pane's own number now, written by applyTheme, with an opaque fallback", () => {
    /* THE derived-again mutant: map the pane off --ground-alpha in the stylesheet, and the sidebar's
       control moves the reading again whatever the pane's own control says. */
    expect(tokensCss).toMatch(/--pane-alpha:\s*100%;/);
    expect(tokensCss).not.toMatch(/--pane-alpha:[^;]*--ground-alpha/);
  });

  it("goes fully opaque under the system's reduced-transparency preference", () => {
    const block = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? "";
    expect(block).toContain("--pane-ground: var(--canvas)");
    expect(block).toContain("--sidebar-ground: var(--page)");
  });
});

/* The light face shows far less of the desktop than the dark one (tokens.css). Over a Mac's usual
   wallpaper — darker and more saturated than near-white paper — the dark face's alphas turned light
   mode into a grey-blue wash; Codex's light window, measured beside it, shows almost none. */
describe("the light face is nearly opaque", () => {
  const light = tokensCss.slice(tokensCss.indexOf("The LIGHT face shows far less of the desktop"));
  // calc(A% + var(--x) * B) or calc(A% + (var(--x) - C%) * B), evaluated at a slider value in %.
  const at = (expr: string, v: number) =>
    Function("g", `return ${expr.replace(/var\(--(?:ground|pane)-alpha\)/g, "g").replace(/%/g, "")};`)(v) as number;
  const sidebar = /--sidebar-ground: color-mix\(in srgb, var\(--page\) calc\(([^;]+)\), transparent\);/.exec(light)![1]!;
  const pane = /--pane-ground: color-mix\(in srgb, var\(--canvas\) calc\(([^;]+)\), transparent\);/.exec(light)![1]!;

  it("at the defaults the light sidebar is ~80% and the panes 92%, against the dark 55% and 84%", () => {
    expect(at(sidebar, DEFAULT_GROUND_ALPHA)).toBeCloseTo(79.75, 1);
    expect(at(pane, DEFAULT_PANE_ALPHA)).toBeCloseTo(92, 1);
  });

  it("fully opaque still means opaque, in the light face too", () => {
    expect(at(sidebar, 100)).toBeCloseTo(100, 1);
    expect(at(pane, PANE_ALPHA_RANGE.max)).toBeCloseTo(100, 1);
  });

  it("Reduce Transparency still wins over the light rule — it is more specific than a bare :root", () => {
    // THE mutant: the media block left as `:root { … }`. `:root[data-mode="light"]` outranks it and
    // the light window stays see-through under a preference that asked for it not to be.
    const reduce = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(reduce.slice(0, reduce.indexOf("}") + 1)).toContain(':root[data-mode="light"] { --sidebar-ground: var(--page); --pane-ground: var(--canvas); }');
  });
});

/* A themed palette's sidebar (tokens.css). The material under the window is the system's grey, and a
   hue mixed 55% into it reads as grey: on Rosé Pine the sidebar stopped looking like the theme its
   panes wore (reported 10-04). Realm's own near-grey dark ground is the one the 55% was drawn for. */
describe("a themed palette's sidebar wears the theme", () => {
  const themed = tokensCss.slice(tokensCss.indexOf("A THEMED palette's sidebar starts where the light face's does"));
  const at = (expr: string, v: number) =>
    Function("g", `return ${expr.replace(/var\(--ground-alpha\)/g, "g").replace(/%/g, "")};`)(v) as number;
  const rule = /:root\[data-mode="dark"\]\[data-theme\]:not\(\[data-theme="realm"\]\) \{\s*--sidebar-ground: color-mix\(in srgb, var\(--page\) calc\(([^;]+)\), transparent\);/.exec(themed);

  it("starts the sidebar's range where the light face does: ~80% at the default, opaque at the top", () => {
    // THE mutants: the rule dropped (a themed dark sidebar back on Realm's 55%), or aimed at Realm's
    // own face too (which keeps the range it was drawn for).
    expect(rule).not.toBeNull();
    expect(at(rule![1]!, DEFAULT_GROUND_ALPHA)).toBeCloseTo(79.75, 1);
    expect(at(rule![1]!, 100)).toBeCloseTo(100, 1);
  });

  it("still goes opaque under Reduce Transparency, which a bare :root would no longer reach", () => {
    const reduce = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(reduce.slice(0, reduce.indexOf("\n}") + 2)).toContain(':root[data-mode="dark"][data-theme]:not([data-theme="realm"]) { --sidebar-ground: var(--page); }');
  });
});
