import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRAST_FLOOR, REALM_SEED, THEMES, deriveVars, themeVars } from "@realm/ui/src/themes";
import { hexToOklch, parseOklch, srgb, srgbLuminance } from "@realm/ui/src/oklch";
import { grainVars } from "./grain";

/* The wash is decoration; the contrast floor is not. This walks every face the app can wear, paints
   the decoration over the ground the surface actually has, and reads the ratio back — because the
   thing that makes a decorative background dangerous here is that it looks fine on the face you
   built it on and puts text under the floor on one of the sixteen you did not.
 
   Every number comes out of tokens.css and out of grain.ts. Nothing is restated, so the proof cannot
   go on describing a stylesheet that has changed. */

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");

/** The grain section's two halves. The base :root is the dark face; light overrides it. */
const section = tokensCss.slice(tokensCss.indexOf("══ DECORATIVE GRAIN"));
const half = { dark: section.slice(0, section.indexOf(':root[data-mode="light"]')), light: section.slice(section.indexOf(':root[data-mode="light"]')) };
const decl = (mode: Mode, name: string): string => {
  for (const body of [half[mode], half.dark]) {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
    if (m) return m[1]!.trim();
  }
  throw new Error(`${name} is not declared in the grain section of tokens.css`);
};
type Mode = "dark" | "light";
type Rgb = [number, number, number];

/** `oklch(0 0 0 / 0.05)` → the colour and how much of it lands. */
function layer(value: string): { rgb: Rgb; alpha: number } {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (!m) throw new Error(`not a plain oklch layer: ${value}`);
  return { rgb: srgb({ l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) }), alpha: Number(m[4] ?? 1) };
}

/** The shipped texture, read out of its own feColorMatrix: the RGB it forces and the alpha ceiling
 *  its luminance row can reach. Conservative — it costs the darkest speckle the filter can emit. */
function texture(mode: Mode): { rgb: Rgb; alpha: number } {
  const v = /values='([^']+)'/.exec(decl(mode, "--grain-tex"));
  if (!v) throw new Error("no feColorMatrix in --grain-tex");
  const n = v[1]!.trim().split(/\s+/).map(Number);
  expect(n, "an feColorMatrix is 4 rows of 5").toHaveLength(20);
  return { rgb: [n[4]!, n[9]!, n[14]!], alpha: n.slice(15, 20).reduce((a, b) => a + Math.max(0, b), 0) };
}

const over = (ground: Rgb, top: Rgb, alpha: number): Rgb =>
  ground.map((v, i) => v * (1 - alpha) + top[i]! * alpha) as Rgb;
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [srgbLuminance(a), srgbLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Every face the app ships. `realm` has no seed table — tokens.css IS its palette — so it comes
 *  through the derivation styles.test.ts already pins against that file. */
const FACES: { label: string; mode: Mode; vars: Record<string, string> }[] = [];
for (const theme of THEMES) {
  for (const mode of ["dark", "light"] as const) {
    if (theme.name === "realm") { FACES.push({ label: `realm ${mode}`, mode, vars: deriveVars(REALM_SEED[mode], mode) }); continue; }
    const vars = themeVars(theme.name, mode) as Record<string, string>;
    if (vars["--surface"]) FACES.push({ label: `${theme.label} ${mode}`, mode, vars });
  }
}

const INK = [["--ink", CONTRAST_FLOOR.ink], ["--ink-2", CONTRAST_FLOOR.ink2], ["--ink-3", CONTRAST_FLOOR.ink3]] as const;
/** The offsets the shipped randomiser can actually produce, not an arc restated here. */
const HUE_OFFSETS = [...new Set(Array.from({ length: 600 }, (_, i) =>
  Number((grainVars("sheet", i) as unknown as Record<string, string>)["--grain-hue"])))];

/** The ground under each decorated surface, and whether it is textured. `.page` is --rl-panel, which
 *  the bridge in styles.css resolves to --canvas; `.sheet` is --surface. */
const SURFACES = [
  { name: "Settings / Notifications (.page)", ground: "--canvas", grain: false },
  { name: "first run (.sheet)", ground: "--surface", grain: true },
] as const;

/** The decorated ground, worst pixel: the wash at its peak, the lift, and the speckle that spends
 *  the most of the budget the lift banked. */
function decorate(vars: Record<string, string>, mode: Mode, ground: string, hue: number, grain: boolean): Rgb {
  const wash = {
    rgb: srgb({ l: Number(decl(mode, "--grain-wash-l")), c: Number(decl(mode, "--grain-wash-c")), h: (parseOklch(vars["--accent"]!).h + hue + 360) % 360 }),
    alpha: Number(decl(mode, "--grain-wash-a")),
  };
  let g = over(srgb(parseOklch(vars[ground]!)), wash.rgb, wash.alpha);
  if (!grain) return g;
  const lift = layer(decl(mode, "--grain-lift"));
  const tex = texture(mode);
  g = over(g, lift.rgb, lift.alpha);
  return over(g, tex.rgb, tex.alpha);
}

describe("the decorative wash never costs text its contrast floor", () => {
  for (const surface of SURFACES) {
    it(`${surface.name}: every ink tier clears its floor on all ${FACES.length} faces, at every hue the draw can land on`, () => {
      const misses: string[] = [];
      for (const face of FACES) {
        for (const hue of HUE_OFFSETS) {
          const ground = decorate(face.vars, face.mode, surface.ground, hue, surface.grain);
          for (const [token, floor] of INK) {
            const r = ratio(srgb(parseOklch(face.vars[token]!)), ground);
            if (r < floor) misses.push(`${face.label} ${token} at ${hue}deg: ${r.toFixed(3)} < ${floor}`);
          }
        }
      }
      expect(misses.slice(0, 8)).toEqual([]);
    });
  }

  it("the colour field costs nothing at all, because its lightness never leaves the ground's own band", () => {
    // This is the property that lets the field be painted on --canvas, where the derivation has left
    // no room: --ink-3 sits at exactly 2.400 against a 2.4 floor on six light faces. A field that
    // moved luminance by any amount would take one of them under; a field that only moves hue cannot.
    let worst = 0;
    for (const face of FACES) {
      for (const hue of HUE_OFFSETS) {
        const ground = decorate(face.vars, face.mode, "--canvas", hue, false);
        for (const [token] of INK) {
          const ink = srgb(parseOklch(face.vars[token]!));
          worst = Math.min(worst, ratio(ink, ground) - ratio(ink, srgb(parseOklch(face.vars["--canvas"]!))));
        }
      }
    }
    expect(worst).toBeGreaterThan(-0.01);
  });

  it("adds hue to the ground without restating its lightness", () => {
    // The other ceiling on these numbers, and the one that is about the design rather than the
    // reader: a wash heavy enough to move the ground's lightness stops being decoration ON the
    // user's palette and becomes a different palette. Contrast alone would allow far more than this
    // on a dark face, where darkening the ground only ever helps.
    const okl = (rgb: Rgb) => hexToOklch("#" + rgb
      .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")).l;
    for (const surface of SURFACES) {
      for (const face of FACES) {
        const plain = okl(srgb(parseOklch(face.vars[surface.ground]!)));
        for (const hue of HUE_OFFSETS) {
          // Measured on the STEADY ground, without the speckles: the grain's excursion is the
          // texture itself, bounded by the lift and by the floor, not by this.
          const moved = Math.abs(okl(decorate(face.vars, face.mode, surface.ground, hue, false)) - plain);
          expect(moved, `${face.label} ${surface.ground} at ${hue}deg`).toBeLessThan(0.025);
        }
      }
    }
  });

  it("the lift pushes the ground away from the ink and the speckles push it back", () => {
    /* The two layers have to point OPPOSITE ways or the lift is not paying for anything: it exists
       to bank a margin in advance so the grain can spend it. Contrast alone will not catch this,
       because on a dark face a grain that darkens along WITH the lift only ever raises the ratio —
       it just carries the ground further from the palette and leaves the lift doing nothing. */
    for (const face of FACES) {
      const ground = srgbLuminance(srgb(parseOklch(face.vars["--surface"]!)));
      const ink = srgbLuminance(srgb(parseOklch(face.vars["--ink-3"]!)));
      const away = Math.sign(ground - ink);
      // The lift may be a no-op where the ground is already at the end of the gamut — One Light's
      // surface is pure white and nothing is whiter — but it may never point at the ink.
      expect(Math.sign(srgbLuminance(layer(decl(face.mode, "--grain-lift")).rgb) - ground) * away,
        `lift, ${face.label}`).toBeGreaterThanOrEqual(0);
      expect(Math.sign(srgbLuminance(texture(face.mode).rgb) - ground) * away, `speckles, ${face.label}`).toBe(-1);
    }
  });

  it("the texture is paid for by the lift, not by the reader", () => {
    // The speckles push the ground back TOWARD the ink; the lift has already pushed it the same way
    // away. Remove the lift and the grain spends the text's margin instead — which is the whole
    // reason a --canvas ground gets no texture, since there is no margin there to spend.
    for (const face of FACES) {
      const lifted = decorate(face.vars, face.mode, "--surface", 0, true);
      const tex = texture(face.mode);
      const unlifted = over(over(srgb(parseOklch(face.vars["--surface"]!)),
        srgb({ l: Number(decl(face.mode, "--grain-wash-l")), c: Number(decl(face.mode, "--grain-wash-c")), h: parseOklch(face.vars["--accent"]!).h }),
        Number(decl(face.mode, "--grain-wash-a"))), tex.rgb, tex.alpha);
      const ink = srgb(parseOklch(face.vars["--ink-3"]!));
      expect(ratio(ink, lifted), face.label).toBeGreaterThan(ratio(ink, unlifted));
    }
  });
});
