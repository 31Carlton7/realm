import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { READING_PANE_ALPHA, PANE_ALPHA_RANGE, type Mode } from "@realm/ui";
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
      expect(prompter[face](READING_PANE_ALPHA)).toBeCloseTo(100, 5);
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
      if (v >= READING_PANE_ALPHA) { expect(c, `${face} at ${v}`).toBeCloseTo(100, 5); continue; }
      expect(c - p, `${face} at ${v}`).toBeGreaterThanOrEqual(8);
      expect(c, `${face} at ${v}`).toBeLessThan(prompter[face](v + 1));
      expect(c, `${face} at ${v}`).toBeCloseTo(40 + v * 60 / 84, 5);
    }
  });

  it("goes opaque under Reduce Transparency, on both faces, and its ink goes back with it", () => {
    // THE mutant: the line left out, or written as a bare `:root`, which the light rule outranks.
    const reduce = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)"));
    // The picture's line is named too: set on the pane, it would otherwise outrank the root's 100%.
    expect(reduce.slice(0, reduce.indexOf("\n}") + 2)).toContain(':root, :root[data-mode="light"], .session-pane:has(> .hero-backdrop) { --prompter-alpha: 100%; }');
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
    expect(stylesCss).toContain(".quick-chat, .media-viewer, .cr-ask, :is(.quick-chat, .media-viewer, .cr-ask) .session-pane:has(> .hero-backdrop) { --prompter-alpha: 100%; }");
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

/* Over a picture or a loop (the owner, 11-17, over Synth Coast: the grey card and its grey-brown halo
   don't carry the purple): a surface over a picture borrows the picture's colour, never a theme grey. */
describe("the prompter over a picture", () => {
  const scope = ":root .session-pane:has(> .hero-backdrop)";
  const rules = [...stylesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2]!.replace(/\s+/g, " ").trim() }));
  const overPicture = rules.filter((r) => r.sel.includes(":has(> .hero-backdrop)"));
  const token = (name: string, block = prompterBlock) => new RegExp(`${name}: ([^;]+);`).exec(block)![1]!;

  it("has no fill of its own there: the card and its tabs drop to 0%, and their words take the whole ink step", () => {
    // THE mutants: the denser fill back (`--prompter-alpha` above 0 over a picture), or the thinness
    // left uncapped, which at 0% is 119% and drops the ink mixes as invalid.
    expect(prompterBlock).toMatch(/\.session-pane:has\(> \.hero-backdrop\) \{ --prompter-alpha: 0%; \}/);
    expect(prompterBlock).not.toMatch(/--prompter-over-picture/);
    expect(thin(0)).toBe(100);
    expect(thin(40)).toBeCloseTo(60 * 100 / 84, 5);
  });

  it("is the picture blurred and dimmed, toward black in dark and white in light, by the pane's number", () => {
    // THE mutants: a colour mixed into the ground, a blur without the dim, a light face that dims
    // toward black (a grey wash on a bright picture), or the fixed share back where the pane measures.
    expect(token("--picture-ground")).toBe("blur(var(--picture-blur)) var(--picture-tone)");
    expect(token("--picture-frost")).toBe("blur(var(--picture-blur))");
    expect(token("--picture-tone")).toBe("brightness(calc(1 - var(--plain-dim)))");
    const light = /:root\[data-mode="light"\], :root\[data-mode="light"\] :is\(\.session-pane, \[data-over-picture\]\) \{([^}]*)\}/.exec(prompterBlock)![1]!;
    expect(token("--picture-tone", light)).toBe("contrast(calc((1 - var(--plain-dim)) / (1 + var(--plain-dim)))) brightness(calc(1 + var(--plain-dim)))");
    // That pair is exactly a share `d` of white mixed in, for every channel value.
    const d = Number(token("--picture-dim"));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.5);
    const k = (1 - d) / (1 + d), b = 1 + d;
    for (const c of [0, 0.2, 0.5, 0.8, 1]) expect(b * (k * (c - 0.5) + 0.5)).toBeCloseTo((1 - d) * c + d, 9);
    // The veil is the same step as a fill: pure black or white at the same share.
    expect(token("--picture-veil")).toBe("rgb(0 0 0 / var(--plain-dim))");
    expect(token("--picture-veil", light)).toBe("rgb(255 255 255 / var(--plain-dim))");
    // Clear drops the blur and the dim, and nothing else, on the pane and the picker as well as the root.
    expect(prompterBlock).toContain(":root[data-clear-over-picture], :root[data-clear-over-picture] :is(.session-pane, [data-over-picture]) { --picture-ground: none; --picture-frost: none; --picture-veil: transparent; }");
  });

  it("takes the pane's measured number, the picture's own until then, wherever a pane or a picker can set it", () => {
    // THE mutants: the tones left on the root alone (a pane's measured dim never reaching them), or the
    // fallback lost (no dim before the first measure).
    expect(token("--plain-dim")).toBe("var(--picture-dim)");
    const tones = /:root, \.session-pane, \[data-over-picture\] \{([^}]*)\}/.exec(prompterBlock)![1]!;
    for (const name of ["--picture-tone", "--picture-veil", "--picture-frost", "--picture-ground"]) expect(tones, name).toContain(`${name}:`);
  });

  it("dims glass by a number of its own, the picture's own until the pane measures one, toward white in light", () => {
    // THE mutants: dark glass back on `--picture-tone` (navy over a dark picture), the fallback lost
    // (no dim before the first measure), the tones left on the root alone (a pane's measured dim
    // never reaching them), or light glass dimmed toward black.
    const glassBlock = tokensCss.slice(tokensCss.indexOf("/* Glass (Settings"));
    expect(token("--glass-dim", glassBlock)).toBe("var(--picture-dim)");
    const tones = /:root, \.session-pane, \[data-over-picture\] \{([^}]*)\}/.exec(glassBlock)![1]!;
    expect(token("--glass-picture-tone", tones)).toBe("brightness(calc(1 - var(--glass-dim)))");
    expect(token("--glass-tone", tones)).toBe("saturate(var(--glass-saturate)) var(--glass-picture-tone)");
    expect(token("--glass-frost", tones)).toBe("blur(var(--glass-blur)) var(--glass-tone)");
    // Light glass takes the pane's number toward white, never the picture's own fixed tone.
    expect(glassBlock).toMatch(/:root\[data-mode="light"\], :root\[data-mode="light"\] :is\(\.session-pane, \[data-over-picture\]\) \{\s*--glass-picture-tone: contrast\(calc\(\(1 - var\(--glass-dim\)\) \/ \(1 \+ var\(--glass-dim\)\)\)\) brightness\(calc\(1 \+ var\(--glass-dim\)\)\); \}/);
    // Clear still drops the dim from the glass, on the pane and the picker as well as the root.
    expect(glassBlock).toMatch(/:root\[data-clear-over-picture\], :root\[data-clear-over-picture\] :is\(\.session-pane, \[data-over-picture\]\) \{\s*--glass-tone: saturate\(var\(--glass-saturate\)\); --glass-frost: var\(--glass-tone\); \}/);
    // Plain over a picture keeps the picture's own blur.
    expect(rules.find((r) => r.sel === `${scope} :is(.composer-goal, .composer-todos, .composer-overstrip, .composer-understrip)`)!.body).toBe("backdrop-filter: var(--picture-frost);");
  });

  it("casts no halo there, and blurs the picture from the layer that cast it", () => {
    // THE mutants: the lift back over a picture (the grey-brown halo), or the blur on the face, whose
    // circle would shave the painted ring.
    const lift = rules.find((r) => r.sel === `${scope} .composer::before`)!.body;
    expect(lift).toContain("box-shadow: none;");
    expect(lift).toContain("opacity: 1;");
    expect(lift).toContain("backdrop-filter: var(--picture-frost);");
    expect(stylesCss).toMatch(/:root\[data-squircle\] \.composer::before \{[^}]*box-shadow: var\(--prompter-lift\);/);
  });

  it("starts each tab's blur at the card's line, so nothing is blurred and dimmed twice", () => {
    // THE mutant: a tab left on the seat's `clip-path: none`, its blur doubled under the card's.
    expect(rules.find((r) => r.sel === `${scope} .composer-understrip`)!.body).toContain("clip-path: inset(var(--tuck) -24px -24px -24px);");
    expect(rules.find((r) => r.sel === `${scope} :is(.composer-goal, .composer-todos, .composer-overstrip)`)!.body).toContain("clip-path: inset(-24px -24px var(--tuck) -24px);");
    // After the seats, so they win at the same weight.
    expect(stylesCss.indexOf(`${scope} .composer-understrip {`)).toBeGreaterThan(stylesCss.indexOf(":root[data-squircle] .composer + .composer-understrip {"));
  });

  it("never lays a theme colour or a shadow on the picture", () => {
    // THE mutant this exists for: any rule scoped to a pane with a picture that fills or shades with
    // the theme's ladder (a grey slab) or casts a box-shadow (a neutral glow).
    const theme = /var\(--(surface|canvas|page|inset|hover|rl-raised|rl-frame|rl-panel|rl-hover|prompter-strip|shadow-[\w-]+|prompter-lift)\)/;
    expect(overPicture.length).toBeGreaterThan(6);
    for (const r of overPicture) {
      const fills = r.body.split(";").filter((d) => /^\s*(background|--sq-fill|box-shadow|filter)\s*:/.test(d));
      for (const decl of fills) {
        expect(decl, r.sel).not.toMatch(theme);
        if (/box-shadow/.test(decl)) expect(decl.trim(), r.sel).toBe("box-shadow: none");
      }
    }
  });
});

/* Your own message (the owner, 11-17: "for user messages they should be transparent similar coloring
   to the prompter and should depend on the system transparency with the option to have it be the
   same as the theme"). */
describe("your bubble follows the prompter's ground", () => {
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{\\s*([^}]+)\\}`).exec(stylesCss)?.[1] ?? "";

  it("thins with the pane in dark as the prompter does, and over a picture is the picture's veil", () => {
    // THE mutants: the bubble back on the solid raised fill, or a theme fill over a picture.
    expect(rule(':root:not([data-mode="light"])[data-squircle]:not([data-theme-bubble]) .msg-user:not(.quick-chat *)'))
      .toContain("--sq-fill: color-mix(in srgb, var(--rl-raised) var(--prompter-alpha), transparent);");
    expect(rule(":root[data-squircle]:not([data-theme-bubble]) .session-pane:has(> .hero-backdrop) .msg-user:not(.quick-chat *)"))
      .toContain("--sq-fill: var(--picture-veil);");
    expect(rule(":root:not([data-squircle]):not([data-theme-bubble]) .session-pane:has(> .hero-backdrop) .msg-user:not(.quick-chat *)"))
      .toContain("background: var(--picture-veil);");
  });

  it("keeps today's solid theme bubble under Theme colour, and quick chat's own step", () => {
    // THE mutant: a see-through rule that forgets the setting, or reaches quick chat's window.
    const see = [...stylesCss.matchAll(/^([^{}\n]*\.msg-user[^{}\n]*)\{[^}]*(picture-veil|--prompter-alpha)/gm)].map((m) => m[1]!);
    expect(see.length).toBe(4);
    for (const sel of see) {
      expect(sel).toContain(":not([data-theme-bubble])");
      expect(sel).toContain(":not(.quick-chat *)");
    }
    expect(stylesCss).toMatch(/:root\[data-squircle\] \.msg-user \{[^}]*--sq-fill: var\(--rl-raised\);/);
  });
});
