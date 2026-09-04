import { describe, expect, it } from "vitest";
import { contrast, hexToOklch, type Oklch } from "./oklch";
import { CONTRAST_FLOOR, THEMES, THEME_VARS, resolveMode, themeModes, themeSwatches, themeVars } from "./themes";
import type { Mode } from "./theme";

const parse = (value: string): Oklch => {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(value);
  if (!m) throw new Error(`not an oklch value: ${value}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
};

/** The grounds each ink tier actually lands on, read off styles.css rather than taken as the whole
 *  ladder: `--ink-2` never appears on `--hover-2` or `--field` (both are written with `--ink` in
 *  every rule that uses them), and `--ink-3` never leaves the resting surfaces. Widening these to the
 *  full cross-product would fail themes over pairings the stylesheet never produces; narrowing them
 *  past what it does produce is how an unreadable pairing ships. */
const GROUNDS = {
  ink: ["--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2", "--field"],
  ink2: ["--page", "--canvas", "--surface", "--inset", "--hover"],
  ink3: ["--page", "--canvas", "--surface", "--inset"],
} as const;

/** The eight validated chart series, copied from tokens.css. A theme does not repaint them; what it
 *  moves is the ground under them, so this is the set the clamp has to keep working for. */
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

const faces = (): { theme: (typeof THEMES)[number]; mode: Mode }[] =>
  THEMES.flatMap((theme) => themeModes(theme.name).map((mode) => ({ theme, mode })));

describe("the two axes compose", () => {
  it("a theme with both faces takes whichever mode the preference resolved to", () => {
    for (const mode of ["dark", "light"] as const) {
      expect(resolveMode("realm", mode)).toBe(mode);
      expect(resolveMode("one", mode)).toBe(mode);
    }
  });

  it("a theme with one face pins the mode, and every theme still resolves to something", () => {
    for (const { theme } of THEMES.map((theme) => ({ theme }))) {
      const modes = themeModes(theme.name);
      expect(modes.length, theme.name).toBeGreaterThan(0);
      for (const mode of ["dark", "light"] as const) expect(modes).toContain(resolveMode(theme.name, mode));
    }
  });

  it("pinning is a fact about the theme, not a write to the preference", () => {
    // THE clobber mutant: have the picker call setThemePref("dark") when a dark-only palette is
    // chosen. Nothing here would notice — which is why `resolveMode` is a pure function of the two
    // inputs and the preference is never an output. A user who prefers "system" and tries Monokai
    // for an afternoon must find "system" again afterwards.
    expect(resolveMode("monokai", "light")).toBe("dark");
    expect(resolveMode("one", "light")).toBe("light");
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
      expect(worst("--ink", GROUNDS.ink), "--ink").toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink);
      expect(worst("--ink-2", GROUNDS.ink2), "--ink-2").toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink2);
      expect(worst("--ink-3", GROUNDS.ink3), "--ink-3").toBeGreaterThanOrEqual(CONTRAST_FLOOR.ink3);

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
    expect(themeSwatches("one", "dark")).toEqual([v["--page"], v["--surface"], v["--accent"], v["--syn-string"]]);
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
