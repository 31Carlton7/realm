import { describe, expect, it } from "vitest";
import { contrast, hexToOklch, parseOklch as parse } from "./oklch";
import { clampContrast, CONTRAST_FLOOR, CONTRAST_RANGE, INK_GROUNDS, REALM_SEED, THEMES, THEME_VARS, contrastMisses, deriveVars, paletteFor,
  parseThemeOverride, parseThemeOverrides, resolveMode, seedFor, themeModes, themeSwatches, themeVars,
  type ThemeOverride } from "./themes";
import type { Mode } from "./theme";

/** The eight validated chart series, copied from tokens.css. A theme does not repaint them; what it
 *  moves is the ground under them, so this is the set the clamp has to keep working for. */
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

const faces = (): { theme: (typeof THEMES)[number]; mode: Mode }[] =>
  THEMES.flatMap((theme) => themeModes(theme.name).map((mode) => ({ theme, mode })));

describe("the two axes compose", () => {
  it("every theme previews as a face it actually has", () => {
    // `resolveMode` is what a picker card and a ⌘K hint use to say which face they are showing, so
    // it must never name a face the theme has no seeds for.
    for (const theme of THEMES) {
      const modes = themeModes(theme.name);
      expect(modes.length, theme.name).toBeGreaterThan(0);
      for (const mode of ["dark", "light"] as const) expect(modes).toContain(resolveMode(theme.name, mode));
    }
    expect(resolveMode("monokai", "light")).toBe("dark");
    expect(resolveMode("one", "light")).toBe("light");
  });

  it("a face reads its OWN slot — the two are chosen independently or they are one control", () => {
    // THE shared-slot mutant: return `selection.dark` whatever the mode. Every palette still paints,
    // every floor still clears, and the light window silently wears the night's palette.
    const sel = { light: "solarized", dark: "monokai" } as const;
    expect(paletteFor(sel, "light")).toBe("solarized");
    expect(paletteFor(sel, "dark")).toBe("monokai");
  });

  it("a slot naming a palette with no such face falls back rather than moving the mode", () => {
    // THE pinning mutant: keep the old rule that a one-faced palette resolves the mode to its face.
    // The mode is the user's other axis; a value sitting in a slot the light window does not read is
    // not permission to hand them a dark window. `realm` is the fallback because its face is the
    // static CSS, which is the one face that cannot be missing.
    expect(paletteFor({ light: "monokai", dark: "monokai" }, "light")).toBe("realm");
    expect(paletteFor({ light: "monokai", dark: "monokai" }, "dark")).toBe("monokai");
    // And the fallback is reachable for every face of every theme, so no selection can be unpaintable.
    for (const theme of THEMES) {
      for (const mode of ["dark", "light"] as const) {
        expect(themeModes(paletteFor({ light: theme.name, dark: theme.name }, mode)), `${theme.name}/${mode}`).toContain(mode);
      }
    }
  });
});

describe("the default theme is the absence of a theme", () => {
  it("realm states no seeds and derives no palette", () => {
    for (const mode of ["dark", "light"] as const) expect(themeVars("realm", mode)).toEqual({});
  });

  it("every other theme fills exactly THEME_VARS — no property escapes the clear-down list", () => {
    // THE orphan-property mutant: add a token to the derivation and forget to list it in
    // THEME_VARS. It would be written on every theme switch and never removed, so returning to
    // Realm would leave one of Monokai's colours behind on a palette that never asked for it.
    for (const { theme, mode } of faces()) {
      if (theme.name === "realm") continue;
      expect(Object.keys(themeVars(theme.name, mode)).sort(), theme.name).toEqual([...THEME_VARS].sort());
    }
  });
});

describe("what a theme states survives derivation", () => {
  it("the ground and the ink are the seed exactly — those two are never corrected", () => {
    for (const { theme, mode } of faces()) {
      const seed = mode === "dark" ? theme.dark : theme.light;
      if (!seed) continue;
      const v = themeVars(theme.name, mode);
      for (const [token, hex] of [["--page", seed.bg], ["--ink", seed.ink]] as const) {
        const [a, b] = [parse(v[token]!), hexToOklch(hex)];
        expect(a.l, `${theme.name}/${mode} ${token}`).toBeCloseTo(b.l, 3);
        expect(a.c, `${theme.name}/${mode} ${token}`).toBeCloseTo(b.c, 3);
      }
    }
  });

  it("a corrected colour moves along lightness only — hue and chroma are the theme's identity", () => {
    // THE mix-to-white mutant: fix contrast by blending the colour towards the ground's opposite
    // instead of stepping its lightness. It clears the same floors and desaturates every hue on the
    // way, which is how a vendored palette quietly stops being that palette.
    for (const { theme, mode } of faces()) {
      const seed = mode === "dark" ? theme.dark : theme.light;
      if (!seed) continue;
      const v = themeVars(theme.name, mode);
      const pairs = [
        ["--green", seed.green], ["--orange", seed.orange], ["--red", seed.red],
        ["--syn-keyword", seed.syntax.keyword], ["--syn-string", seed.syntax.string],
        ["--syn-number", seed.syntax.number], ["--syn-title", seed.syntax.title],
        ["--syn-type", seed.syntax.type], ["--syn-attr", seed.syntax.attr],
        ["--syn-comment", seed.syntax.comment], ["--accent", seed.accent],
      ] as const;
      for (const [token, hex] of pairs) {
        const [got, want] = [parse(v[token]!), hexToOklch(hex)];
        const where = `${theme.name}/${mode} ${token}`;
        expect(got.c, where).toBeCloseTo(want.c, 3);
        expect(Math.abs(got.h - want.h), where).toBeLessThan(0.5);
        // ...and moved no further than the budget, or the "correction" is a repaint.
        expect(Math.abs(got.l - want.l), where).toBeLessThanOrEqual(0.121);
      }
    }
  });
});

describe(`every theme clears the floor (ink ${CONTRAST_FLOOR.ink}:1, ink-2 ${CONTRAST_FLOOR.ink2}:1, syntax ${CONTRAST_FLOOR.syntax}:1)`, () => {
  it.each(faces().map(({ theme, mode }) => [`${theme.label} ${mode}`, theme.name, mode] as const))(
    "%s", (_label, name, mode) => {
      const v = themeVars(name, mode);
      if (name === "realm") return; // tokens.css is the palette; styles.test.ts pins it there.
      const worst = (token: string, grounds: readonly string[]) =>
        Math.min(...grounds.map((g) => contrast(parse(v[token]!), parse(v[g]!))));
      const onSurface = (token: string) => contrast(parse(v[token]!), parse(v["--surface"]!));

      // The one assertion here that no derivation can rescue: `--ink` is a seed, held to AA on every
      // ground the stylesheet puts it on. A theme whose foreground is too close to its background is
      // a bug in the theme, and this is the line that says so.
      expect(worst("--ink", INK_GROUNDS.ink), "--ink").toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink);
      expect(worst("--ink-2", INK_GROUNDS.ink2), "--ink-2").toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink2);
      expect(worst("--ink-3", INK_GROUNDS.ink3), "--ink-3").toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink3);

      for (const token of ["--accent", "--green", "--orange", "--red"]) {
        expect(onSurface(token), token).toBeGreaterThanOrEqual(CONTRAST_FLOOR.chrome);
      }
      expect(onSurface("--accent-ink"), "--accent-ink").toBeGreaterThanOrEqual(CONTRAST_FLOOR.accentInk);
      expect(contrast(parse(v["--rl-accent-contrast"]!), parse(v["--accent"]!)), "label on the accent fill")
        .toBeGreaterThanOrEqual(CONTRAST_FLOOR.onAccent);

      for (const token of THEME_VARS.filter((t) => t.startsWith("--syn-"))) {
        expect(onSurface(token), token).toBeGreaterThanOrEqual(CONTRAST_FLOOR.syntax);
      }

      if (mode === "dark") {
        for (const [i, hex] of SERIES_DARK.entries()) {
          expect(contrast(hexToOklch(hex), parse(v["--chart-surface"]!)), `--series-${i + 1}`)
            .toBeGreaterThanOrEqual(CONTRAST_FLOOR.series);
        }
      }
    });

  it("the budget REFUSES rather than over-lifting — which is what makes a stated hue vendored", () => {
    // Every syntax seed in this file is the value its upstream publishes, and `lift` is what makes
    // that safe: it corrects along lightness and stops at LIFT_BUDGET. If it kept going instead,
    // every published hue would "clear" at whatever distance from the published colour it took, and
    // the provenance in the comments would be decoration.
    //
    // Nord is the case that proves it. Its spec comment is nord3 (#4c566a), which measures 1.39:1 on
    // the surface derived from nord0 and needs 0.160 of lightness — past the budget. The palette
    // therefore states #616e88, the tone Nord's own editor ports adopted, which needs 0.074.
    const nord = THEMES.find((t) => t.name === "nord")!.dark!;
    const spec = deriveVars({ ...nord, syntax: { ...nord.syntax, comment: "#4c566a" } }, "dark");
    const asShipped = deriveVars(nord, "dark");
    const onSurface = (v: Record<string, string>) => contrast(parse(v["--syn-comment"]!), parse(v["--surface"]!));
    // THE runaway-lift mutant: drop the budget from `lift`'s loop bound. This flips green, nord3
    // "works", and the one seed in the set that upstream's own value cannot carry stops being
    // visible to anyone reading the file.
    expect(onSurface(spec), "nord3 must NOT be rescued past the budget").toBeLessThan(CONTRAST_FLOOR.syntax);
    expect(onSurface(asShipped), "the value the palette actually states does clear").toBeGreaterThanOrEqual(CONTRAST_FLOOR.syntax);
  });

  it("the floor can actually fail — a ground and an ink half a step apart do not clear it", () => {
    // Without this the suite above proves only that the derivation is self-consistent. `--ink` is
    // the un-derived seed, so it is the one that demonstrates the check has teeth: #2b2b2b on
    // #282828 is a plausible-looking pair and it is 1.03:1.
    expect(contrast(hexToOklch("#2b2b2b"), hexToOklch("#282828"))).toBeLessThan(CONTRAST_FLOOR.ink);
  });
});

describe("the ramps derivation reproduces", () => {
  it("the ink ramp still reads as three steps on every theme", () => {
    // THE lightness-fraction mutant: derive --ink-2 and --ink-3 as fixed fractions of the way from
    // --ink to --page, the way the shipped palette's own values sit. Realm's span is near-white over
    // near-black; on One Dark's #282c34 the same fractions put --ink-2 at 3.4:1 and --ink-3 at 1.9:1,
    // which is a ramp with no legible bottom. Deriving by CONTRAST instead keeps the steps apart.
    for (const { theme, mode } of faces()) {
      if (theme.name === "realm") continue;
      const v = themeVars(theme.name, mode);
      const g = parse(v["--surface"]!);
      const [ink, ink2, ink3] = ["--ink", "--ink-2", "--ink-3"].map((k) => contrast(parse(v[k]!), g));
      expect(ink!, `${theme.name}/${mode}`).toBeGreaterThan(ink2! * 1.15);
      expect(ink2!, `${theme.name}/${mode}`).toBeGreaterThan(ink3! * 1.15);
    }
  });

  it("the surface ladder climbs in dark and sinks in light, off the theme's own ground", () => {
    for (const { theme, mode } of faces()) {
      if (theme.name === "realm") continue;
      const v = themeVars(theme.name, mode);
      const [page, surface, canvas] = ["--page", "--surface", "--canvas"].map((k) => parse(v[k]!).l);
      if (mode === "dark") { expect(surface!).toBeGreaterThan(page!); expect(canvas!).toBeGreaterThan(page!); }
      else { expect(surface!).toBeGreaterThan(page!); expect(canvas!).toBeLessThan(page!); }
    }
  });

  it("the chart ground is pulled back into the band the series were validated in", () => {
    // THE unclamped-chart mutant: point --chart-surface at --surface. Every dark theme here has a
    // ground lighter than Realm's #232427, and slot 6 (#008300) drops under 3:1 on all of them —
    // silently, because nothing about a chart looks broken when two segments stop being telling
    // apart. At least one shipped theme must therefore have a chart ground strictly darker than its
    // own surface, or the clamp is dead code.
    const clamped = faces().filter(({ theme, mode }) => {
      if (theme.name === "realm" || mode !== "dark") return false;
      const v = themeVars(theme.name, mode);
      return parse(v["--chart-surface"]!).l < parse(v["--surface"]!).l - 1e-6;
    });
    expect(clamped.length).toBeGreaterThan(0);
  });
});

describe("the picker's swatches", () => {
  it("preview the mode the theme would really resolve to", () => {
    // Asked for light, Monokai has none: the card must show its dark face rather than a fabricated
    // light one, because that is what clicking it produces.
    expect(themeSwatches("monokai", "light")).toEqual(themeSwatches("monokai", "dark"));
  });

  it("come from the same derivation the app applies, so a card cannot lie about its theme", () => {
    const v = themeVars("one", "dark");
    expect(themeSwatches("one", "dark")).toEqual([v["--page"], v["--surface"], v["--accent"], v["--syn-string"], v["--ink-3"]]);
  });

  it("carry a hairline the swatches stay visible against, on every face", () => {
    // THE fixed-hairline mutant: ring the swatches in a constant black or white. The card is painted
    // in the theme it names, so a constant ring is invisible on half of them — and the dot it was
    // added for is the one that matches the card ground, which on every light palette is --surface.
    // 1.5:1 is the floor for "this is a shape" rather than for text.
    for (const { theme, mode } of faces()) {
      const [page, surface, , , line] = themeSwatches(theme.name, mode);
      for (const [what, ground] of [["page", page], ["surface", surface]] as const) {
        expect(contrast(parse(line), parse(ground)), `${theme.name}/${mode} hairline on ${what}`).toBeGreaterThan(1.5);
      }
    }
  });
});

describe("provenance", () => {
  it("every vendored palette credits its upstream and its licence", () => {
    for (const theme of THEMES) {
      if (theme.name === "realm") { expect(theme.credit).toBeNull(); continue; }
      expect(theme.credit, theme.name).toMatch(/MIT ©/);
    }
  });
});

describe("a user's own colours go through the same machinery", () => {
  const derived = (name: Parameters<typeof themeVars>[0], mode: Mode, override: ThemeOverride) => themeVars(name, mode, { override });

  it("an override is merged into the SEED, so the whole palette follows it", () => {
    // THE raw-write mutant: write the three overridden values straight onto :root and leave the rest
    // of the derivation on the palette's own seeds. Every floor still passes — they are measured
    // against the surface the OLD ground derived — and the app is a One Dark card ladder floating on
    // a black page, with a tooltip and a chart ground that never heard about the change.
    const v = derived("one", "dark", { bg: "#101014" });
    const base = themeVars("one", "dark");
    for (const token of ["--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2",
      "--field", "--stripe-bg", "--tooltip-bg", "--tooltip-border", "--chart-surface"]) {
      expect(v[token], token).not.toBe(base[token]);
    }
    expect(parse(v["--page"]!).l).toBeCloseTo(hexToOklch("#101014").l, 3);
    // ...and the ladder still climbs off the NEW ground by the ramp's own step.
    expect(parse(v["--surface"]!).l - parse(v["--page"]!).l)
      .toBeCloseTo(parse(base["--surface"]!).l - parse(base["--page"]!).l, 3);
  });

  it("an overridden hue is corrected exactly as a vendored one is — lightness only, inside the budget", () => {
    // THE unchecked-override mutant: skip `lift` for user colours because "the user asked for it".
    // A #333 accent on One Dark's card is 1.3:1, which is a focus ring nobody can find.
    const v = derived("one", "dark", { accent: "#333333" });
    const want = hexToOklch("#333333"), got = parse(v["--accent"]!);
    expect(got.c).toBeCloseTo(want.c, 3);
    expect(Math.abs(got.h - want.h)).toBeLessThan(0.5);
    expect(Math.abs(got.l - want.l)).toBeLessThanOrEqual(0.121);
    expect(contrast(got, parse(v["--surface"]!))).toBeGreaterThan(contrast(want, parse(v["--surface"]!)));
  });

  it("the ground and the ink are handed back exactly as asked, and the miss is REPORTED", () => {
    // The decision this pins: correcting these two silently would hand back a theme the user did not
    // pick — a palette's identity is its paper and its text. So they are derived verbatim and named.
    // THE silent-fix mutant: lift `ink` off `bg` like any other hue. `contrastMisses` returns empty,
    // the warning never renders, and the foreground in the field stops being the one on screen.
    const seed = seedFor("one", "dark", { bg: "#282828", ink: "#2b2b2b" })!;
    const v = deriveVars(seed, "dark");
    expect(parse(v["--ink"]!).l).toBeCloseTo(hexToOklch("#2b2b2b").l, 3);
    expect(contrastMisses(seed, "dark").map((m) => m.role)).toContain("Foreground");
  });

  it("a palette that clears every floor reports nothing — the warning cannot be always-on", () => {
    // Without this, `contrastMisses` returning every role unconditionally would pass the test above.
    for (const { theme, mode } of faces()) {
      if (theme.name === "realm") continue;
      expect(contrastMisses(seedFor(theme.name, mode)!, mode), `${theme.name}/${mode}`).toEqual([]);
    }
    expect(contrastMisses(REALM_SEED.dark, "dark")).toEqual([]);
    expect(contrastMisses(REALM_SEED.light, "light")).toEqual([]);
  });

  it("Realm untouched still writes nothing, and Realm edited derives off its own seeds", () => {
    // THE eager-seed mutant: give `realm` seeds in THEMES. Every user who never chose a theme gets
    // 34 inline properties over the hand-tuned static CSS — near-identical, and no longer it.
    expect(seedFor("realm", "dark")).toBeNull();
    expect(themeVars("realm", "dark", { override: {} })).toEqual({});
    const edited = seedFor("realm", "dark", { accent: "#f92672" })!;
    expect(edited.bg).toBe(REALM_SEED.dark.bg);
    expect(edited.accent).toBe("#f92672");
    expect(Object.keys(themeVars("realm", "dark", { override: { accent: "#f92672" } })).sort()).toEqual([...THEME_VARS].sort());
  });

  it("a face with no seeds cannot be conjured out of an override", () => {
    // Monokai has no light palette. An override is an edit to something, not a way to invent the
    // thing — otherwise a stray stored key would produce a "Monokai Light" nobody designed.
    expect(seedFor("monokai", "light", { accent: "#f92672" })).toBeNull();
  });
});

describe("overrides read back off a user-editable settings row", () => {
  it("keeps hex and drops everything else, per field", () => {
    // THE trusted-blob mutant: cast the stored row to ThemeOverride. `hexToOklch` THROWS on
    // "cornflowerblue", inside a layout effect, at boot — a white window with no settings page left
    // to undo it from.
    expect(parseThemeOverride({ bg: "#101014", ink: "cornflowerblue", accent: 42, nope: "#fff" }))
      .toEqual({ bg: "#101014" });
    expect(parseThemeOverride({ syntax: { keyword: "#abc", string: "rgb(1,2,3)" } }))
      .toEqual({ syntax: { keyword: "#abc" } });
    for (const junk of [null, undefined, "one", 7, [], { bg: "#12345" }]) expect(parseThemeOverride(junk)).toEqual({});
  });

  it("drops a key naming a palette or a face this build does not have", () => {
    expect(parseThemeOverrides({ "one:dark": { accent: "#ff0000" } })).toEqual({ "one:dark": { accent: "#ff0000" } });
    expect(parseThemeOverrides({ "cobalt:dark": { accent: "#ff0000" } })).toEqual({});
    expect(parseThemeOverrides({ "one:sepia": { accent: "#ff0000" } })).toEqual({});
    // An entry whose every field was dropped is not an override — it would make `isOverridden` true
    // and show a "Reset" button for an edit that no longer exists.
    expect(parseThemeOverrides({ "one:dark": { accent: "nope" } })).toEqual({});
  });
});

describe("the contrast control moves the ink ramp and nothing else", () => {
  const levels = [CONTRAST_RANGE.min, 20, 40, CONTRAST_RANGE.default, 80, CONTRAST_RANGE.max];
  const seeds = () => [...faces().filter((f) => f.theme.name !== "realm").map(({ theme, mode }) => ({ seed: seedFor(theme.name, mode)!, mode, label: `${theme.name}/${mode}` })),
    { seed: REALM_SEED.dark, mode: "dark" as Mode, label: "realm/dark" },
    { seed: REALM_SEED.light, mode: "light" as Mode, label: "realm/light" }];

  it("passing the default is the same as passing nothing — moving the slider and back returns the palette it started from", () => {
    // THE drifted-default mutant: hardcode some other level as deriveVars' default argument. Every
    // caller that does not thread the preference — the picker swatches, the guardrail in
    // styles.test.ts — would derive a palette the window never shows.
    // What this canNOT catch is the scale itself being centred somewhere other than the default:
    // both sides of this comparison would move together. The check with teeth for that is
    // styles.test.ts's "the ramp reproduces the palette it was measured from", where the default
    // derivation is held against tokens.css and a shifted centre stops reproducing it.
    for (const { seed, mode, label } of seeds()) {
      expect(deriveVars(seed, mode, CONTRAST_RANGE.default), label).toEqual(deriveVars(seed, mode));
    }
  });

  it("raising it closes the ramp up and lowering it opens it out, monotonically", () => {
    // THE inverted-scale mutant: multiply where it should divide. The label says Contrast and the
    // control does the opposite, which no floor and no ratio would ever catch.
    for (const { seed, mode, label } of seeds()) {
      const gap = (level: number) => {
        const v = deriveVars(seed, mode, level);
        const ground = parse(v["--surface"]!);
        return contrast(parse(v["--ink"]!), ground) - contrast(parse(v["--ink-2"]!), ground);
      };
      for (let i = 1; i < levels.length; i++) {
        expect(gap(levels[i]!), `${label} @${levels[i]}`).toBeLessThanOrEqual(gap(levels[i - 1]!) + 1e-9);
      }
      expect(gap(CONTRAST_RANGE.min), label).toBeGreaterThan(gap(CONTRAST_RANGE.max));
    }
  });

  it("cannot push any tier below the floor, at any setting, on any palette", () => {
    // This is the whole safety claim, and it is structural rather than arithmetic: `inkStep` floors
    // every tier before it walks. THE unfloored mutant: pass 0 as inkStep's floor and let the
    // exponent decide. Nothing about the slider looks different until it is near the bottom, where
    // the hint tier quietly stops being text.
    for (const { seed, mode, label } of seeds()) {
      for (const level of levels) {
        const v = deriveVars(seed, mode, level);
        const worst = (token: string, grounds: readonly string[]) =>
          Math.min(...grounds.map((g) => contrast(parse(v[token]!), parse(v[g]!))));
        expect(worst("--ink", INK_GROUNDS.ink), `${label} @${level} --ink`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink);
        expect(worst("--ink-2", INK_GROUNDS.ink2), `${label} @${level} --ink-2`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink2);
        expect(worst("--ink-3", INK_GROUNDS.ink3), `${label} @${level} --ink-3`).toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink3);
      }
    }
  });

  it("cannot collapse the three tiers into one, at the top of the range", () => {
    // THE unbounded-top mutant: let the exponent reach 1. --ink-2 and --ink-3 become --ink, and
    // every distinction the ramp draws — a label from its value, a timestamp from a title — is gone.
    // Raising contrast must not be a way to destroy the hierarchy contrast is for.
    for (const { seed, mode, label } of seeds()) {
      const v = deriveVars(seed, mode, CONTRAST_RANGE.max);
      const g = parse(v["--surface"]!);
      const [ink, ink2, ink3] = ["--ink", "--ink-2", "--ink-3"].map((k) => contrast(parse(v[k]!), g));
      expect(ink!, label).toBeGreaterThan(ink2! * 1.15);
      expect(ink2!, label).toBeGreaterThan(ink3! * 1.15);
    }
  });

  it("moves no hue and no surface — a contrast control that repainted a palette would be a repaint", () => {
    // THE overreaching mutant: apply the spread to the accent, or to the surface ladder. It would
    // look like it was working, and Monokai at 20 would no longer be Monokai.
    const seed = seedFor("one", "dark")!;
    const [lo, hi] = [deriveVars(seed, "dark", CONTRAST_RANGE.min), deriveVars(seed, "dark", CONTRAST_RANGE.max)];
    for (const token of THEME_VARS.filter((t) => t !== "--ink-2" && t !== "--ink-3" && t !== "--syn-fg" && t !== "--tooltip-muted")) {
      expect(hi[token], token).toBe(lo[token]);
    }
  });

  it("clamps whatever it is handed, so a stored or hand-edited value cannot leave the range", () => {
    expect(clampContrast(-40)).toBe(CONTRAST_RANGE.min);
    expect(clampContrast(1000)).toBe(CONTRAST_RANGE.max);
    expect(clampContrast(61.6)).toBe(62);
    expect(deriveVars(REALM_SEED.dark, "dark", -40)).toEqual(deriveVars(REALM_SEED.dark, "dark", CONTRAST_RANGE.min));
  });
});
