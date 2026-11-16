import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PANE_ALPHA, PANE_ALPHA_RANGE, type Mode } from "@realm/ui";
import { CONTRAST_FLOOR, DEFAULT_SELECTION, deriveVars, REALM_SEED, themeVars, type ThemeName } from "@realm/ui/src/themes";
import { parseOklch, srgb, srgbLuminance, type Oklch } from "@realm/contracts";

/** The prompter thins with the pane (tokens.css, the owner 11-16) the whole range, a step denser, and
 *  its words hold by moving their ink (styles.css, the prompter on a thinned pane). */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
const stylesCss = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");
const squircleTs = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/squircle.ts"), "utf8");

/** A `min`/`max`/`calc` expression over `var(--pane-alpha)` or `var(--prompter-alpha)`, evaluated at a
 *  value in %. */
const at = (expr: string, v: number) =>
  Function("p", `return ${expr.replace(/var\(--(?:pane|prompter)-alpha\)/g, "p").replace(/%/g, "")
    .replace(/\bmax\(/g, "Math.max(").replace(/\bmin\(/g, "Math.min(").replace(/\bcalc\(/g, "(")};`)(v) as number;

const prompterBlock = tokensCss.slice(tokensCss.indexOf("The prompter thins with the pane"));
const dark = /:root \{[^}]*--prompter-alpha: (.+);/.exec(prompterBlock)![1]!;
// One line for both faces: 40% at pane 0 to solid at the default (the owner, 11-16).
const light = dark;
const lightPane = /:root\[data-mode="light"\] \{[^}]*--pane-ground: color-mix\(in srgb, var\(--canvas\) (.+), transparent\);/.exec(tokensCss)![1]!;
const pane = { dark: (v: number) => v, light: (v: number) => at(lightPane, v) };
const prompter = { dark: (v: number) => at(dark, v), light: (v: number) => at(light, v) };
const slider = Array.from({ length: PANE_ALPHA_RANGE.max - PANE_ALPHA_RANGE.min + 1 }, (_, i) => PANE_ALPHA_RANGE.min + i);
const faces = ["dark", "light"] as const;

describe("the prompter's fill follows Pane translucency", () => {
  it("has no floor: it runs on down with the pane to slider 0, and the card and its tabs wear it", () => {
    // THE mutants: a floor put back (the card a solid slab over the window material at 0), or a rule
    // back on the opaque `--surface` / `--rl-frame`.
    expect(prompterBlock.slice(0, prompterBlock.indexOf("@media"))).not.toMatch(/max\(|--prompter-floor/);
    // 40% at pane 0: thin enough to follow the pane, solid enough to read as the place you type.
    expect(prompter.dark(PANE_ALPHA_RANGE.min)).toBeCloseTo(40, 5);
    expect(prompter.light(PANE_ALPHA_RANGE.min)).toBeCloseTo(40, 5);
    expect(prompter.dark(40)).toBeCloseTo(40 + 40 * 60 / 84, 5);
    for (const face of faces) {
      expect(prompter[face](DEFAULT_PANE_ALPHA)).toBeCloseTo(100, 5);
      expect(prompter[face](PANE_ALPHA_RANGE.max)).toBeCloseTo(100, 5);
    }
    expect(stylesCss).toMatch(/:root\[data-squircle\] \.composer \{ --sq-fill: color-mix\(in srgb, var\(--surface\) var\(--prompter-alpha\), transparent\); \}/);
    expect(stylesCss).toMatch(/--prompter-strip: color-mix\(in srgb, var\(--rl-frame\) var\(--prompter-alpha\), transparent\);/);
    const under = /:root\[data-squircle\] \.composer-understrip \{\s*--sq-fill: ([^;]+);/.exec(stylesCss)![1];
    expect(under).toBe("var(--prompter-strip)");
  });

  it("thins with every step of the slider below the default, always a step denser than the pane", () => {
    // THE mutants: the line flattened onto the pane (the card as thin as the pane, so it stops reading as
    // the place you type), a flat stretch anywhere below the default, or a floor or a different start.
    for (const face of faces) for (const v of slider) {
      const p = pane[face](v), c = prompter[face](v);
      if (v >= DEFAULT_PANE_ALPHA) { expect(c, `${face} at ${v}`).toBeCloseTo(100, 5); continue; }
      expect(c - p, `${face} at ${v}`).toBeGreaterThanOrEqual(8);
      expect(c, `${face} at ${v}`).toBeLessThan(prompter[face](v + 1));
      expect(c, `${face} at ${v}`).toBeCloseTo(40 + v * 60 / 84, 5);
    }
  });

  it("goes opaque under Reduce Transparency, on both faces, and its ink goes back with it", () => {
    // THE mutant: the line left out, or written as a bare `:root`, which the light rule outranks.
    const reduce = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(reduce.slice(0, reduce.indexOf("\n}") + 2)).toContain(':root, :root[data-mode="light"] { --prompter-alpha: 100%; }');
    expect(thin(100)).toBe(0);
  });
});

/* ── The ink ── */
const dock = /\.composer-dock \{\s*--prompter-thin: ([^;]+);\s*--rl-text-faint: ([^;]+);\s*--rl-text-dim: ([^;]+); \}/.exec(stylesCss);
const thin = (alpha: number) => at(dock![1]!, alpha);
/** `color-mix(in oklab, var(--a) <pct>, var(--b))`, read as [a, b, the share of a at a given thinness]. */
const mixOf = (decl: string) => {
  const m = /^color-mix\(in oklab, var\((--[\w-]+)\) (.+), var\((--[\w-]+)\)\)$/.exec(decl)!;
  return { toward: m[1]!, from: m[3]!, share: (t: number) => at(m[2]!.replace("var(--prompter-thin)", `${t}%`), 0) / 100 };
};
const oklab = (o: Oklch) => [o.l, o.c * Math.cos((o.h * Math.PI) / 180), o.c * Math.sin((o.h * Math.PI) / 180)];
const mix = (a: Oklch, b: Oklch, share: number): Oklch => {
  const [l, x, y] = oklab(a).map((v, i) => v * share + oklab(b)[i]! * (1 - share)) as [number, number, number];
  return { l, c: Math.hypot(x, y), h: (Math.atan2(y, x) * 180) / Math.PI };
};
/** The card's fill at `alpha` over what is behind it, composited on the encoded channels. */
const over = (ground: Oklch, behind: number, alpha: number) => srgbLuminance(srgb(ground).map((c) => c * alpha + behind * (1 - alpha)));
const ratio = (ink: Oklch, ground: number) => {
  const a = srgbLuminance(srgb(ink));
  return (Math.max(a, ground) + 0.05) / (Math.min(a, ground) + 0.05);
};
/** The worst window material a thinned prompter can stand on, as an sRGB grey. A CDP capture cannot
 *  see the material, so this is reasoned: `vibrancy: "sidebar"` over a bright white desktop. Dark,
 *  AppKit's sidebar material over pure white is taken no brighter than #606060; light, its material
 *  over a black desktop no darker than #b8b8b8. Both pessimistic against what the owner's window
 *  measured (#262a32 behind a dark face). */
const MATERIAL: Record<Mode, number> = { dark: 0x60 / 255, light: 0xb8 / 255 };

describe("the prompter's words move their ink as it thins", () => {
  const faint = mixOf(dock![2]!), dim = mixOf(dock![3]!);

  it("steps the hints toward the quiet ink and the quiet ink toward body ink, by how thin the card is", () => {
    // THE mutants: a step left out, run the wrong way, or scaled off something other than the card.
    expect([faint.toward, faint.from]).toEqual(["--ink-2", "--ink-3"]);
    expect([dim.toward, dim.from]).toEqual(["--ink", "--ink-2"]);
    expect(thin(100)).toBe(0);
    expect(thin(16)).toBeCloseTo(100, 5);
    expect(thin(58)).toBeCloseTo(50, 5);
    // Fully thin (past the 40% floor, so never reached) the hints would BE the quiet ink, and the quiet ink halfway to body ink.
    expect(faint.share(100)).toBeCloseTo(1, 5);
    expect(dim.share(100)).toBeCloseTo(0.5, 5);
    // Opaque, nothing moves: the default looks exactly as it did.
    expect(faint.share(0)).toBe(0);
    expect(dim.share(0)).toBe(0);
  });

  it("holds hints to 2.4:1 and quiet text to 4.5:1 on the thinned card, at every slider value, on the default faces", () => {
    // THE mutants: either step removed (dark hints fall to 1.45:1, quiet text to 3.06:1 at slider 0).
    const shipped: [ThemeName, Mode][] = [["realm", "dark"], ["realm", "light"], [DEFAULT_SELECTION.light, "light"]];
    for (const [name, mode] of shipped) {
      // Realm's own face is tokens.css itself, which is what its seed derives to.
      const v = name === "realm" ? deriveVars(REALM_SEED[mode], mode) : themeVars(name, mode);
      const [ink, ink2, ink3, surface] = ["--ink", "--ink-2", "--ink-3", "--surface"].map((k) => parseOklch(v[k]!)) as [Oklch, Oklch, Oklch, Oklch];
      for (const s of slider) {
        const a = prompter[mode](s), t = thin(a);
        const ground = over(surface, MATERIAL[mode], a / 100);
        expect(ratio(mix(ink2, ink3, faint.share(t)), ground), `${name}/${mode} hint at ${s}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink3);
        expect(ratio(mix(ink, ink2, dim.share(t)), ground), `${name}/${mode} quiet at ${s}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink);
        expect(ratio(ink, ground), `${name}/${mode} body at ${s}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink);
      }
    }
  });

  it("is set on the dock, so an opaque prompter elsewhere (quick chat) keeps its inks", () => {
    // THE mutant: the thinness set on :root, where quick chat's own `--prompter-alpha: 100%` never reaches it.
    expect(stylesCss).not.toMatch(/:root \{[^}]*--prompter-thin/);
    expect(stylesCss).toContain(".quick-chat, .media-viewer, .cr-ask { --prompter-alpha: 100%; }");
  });
});

describe("the tabs meet the card in one clean edge", () => {
  it("seats the tab touching the card on it, above and below, with the card's own corner", () => {
    // THE mutants: the seat dropped (the notch comes back), put on the wrong edge, or a stacked tab
    // seated on another tab (it would cut a curve into a straight join).
    for (const tab of ["goal", "todos", "overstrip"]) {
      expect(stylesCss).toContain(`:root[data-squircle] .composer-${tab}:has(+ .composer)`);
    }
    const above = /:root\[data-squircle\] \.composer-overstrip:has\(\+ \.composer\) \{\s*([^}]+)\}/.exec(stylesCss)![1]!;
    expect(above).toContain("clip-path: none; --sq-seat: bottom; --sq-seat-radius: var(--r-squircle); --sq-seat-inset: 10px;");
    const below = /:root\[data-squircle\] \.composer \+ \.composer-understrip \{\s*([^}]+)\}/.exec(stylesCss)![1]!;
    expect(below).toContain("clip-path: none; --sq-seat: top; --sq-seat-radius: var(--r-squircle); --sq-seat-inset: 10px;");
    // The seat's inset is the tuck the layout gives every tab.
    expect(stylesCss).toMatch(/\.composer-overstrip \{[^}]*margin: 0 10px -10px;/);
    expect(stylesCss).toMatch(/\.composer-understrip \{[^}]*margin: -10px 10px 0;/);
    for (const name of ["--sq-seat", "--sq-seat-radius", "--sq-seat-inset"]) {
      expect(squircleTs).toMatch(new RegExp(`name: "${name}",[^}]*inherits: false`));
    }
  });

  it("still cuts a thinned tab at the line without the painter, and nothing while the card is opaque", () => {
    expect(stylesCss).toMatch(/\.composer-dock \{ --tuck: min\(10px, calc\(\(100% - var\(--prompter-alpha\)\) \* 1000 - 24px\)\); \}/);
    expect(stylesCss).toContain(".composer-understrip { clip-path: inset(var(--tuck) -24px -24px -24px); }");
  });
});
