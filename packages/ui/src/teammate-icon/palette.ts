import { css, type Oklch } from "@realm/contracts";

/** A teammate's colour, by stable name. A teammate stores the name, never the value, so the set can be
 *  retuned without a migration.
 *
 *  The twelve sit at ONE lightness per face and as near one chroma as sRGB allows there (teal, sky,
 *  yellow and amber run out of gamut first, so they take what fits on both faces), which is what makes
 *  them read as a family rather than as twelve picks: only the hue moves. The lightness is the one
 *  place where both contrasts a face needs hold at once — the body at 3 : 1 or better on every ground a
 *  row or a page puts under it (WCAG 1.4.11's floor for a graphical object), and the eyes at about
 *  3 : 1 on the body. Higher and the white eyes wash out; lower and the body sinks into the dark ground
 *  or, on the light face, the eyes do. Light is not dark inverted: the light face sits a step deeper,
 *  because near-white paper is brighter than near-black is dark.
 *
 *  Red, orange and green are here although they also carry state elsewhere: an icon's colour is the
 *  teammate's signature, as a file's mark is the file's, and state is said by the row's dot beside it,
 *  never by the icon. */
export const TEAMMATE_COLORS = {
  red: { label: "Red", hue: 25, chroma: 0.15 },
  orange: { label: "Orange", hue: 50, chroma: 0.15 },
  amber: { label: "Amber", hue: 72, chroma: 0.13 },
  yellow: { label: "Yellow", hue: 95, chroma: 0.128 },
  lime: { label: "Lime", hue: 125, chroma: 0.15 },
  green: { label: "Green", hue: 152, chroma: 0.15 },
  teal: { label: "Teal", hue: 188, chroma: 0.106 },
  sky: { label: "Sky", hue: 228, chroma: 0.122 },
  blue: { label: "Blue", hue: 260, chroma: 0.15 },
  violet: { label: "Violet", hue: 296, chroma: 0.15 },
  pink: { label: "Pink", hue: 350, chroma: 0.15 },
  graphite: { label: "Graphite", hue: 264, chroma: 0.014 },
} as const satisfies Record<string, { label: string; hue: number; chroma: number }>;

export type TeammateColor = keyof typeof TEAMMATE_COLORS;
export type Face = "dark" | "light";

const LIGHTNESS: Record<Face, number> = { dark: 0.645, light: 0.605 };

export function bodyOklch(color: TeammateColor, face: Face): Oklch {
  const { hue, chroma } = TEAMMATE_COLORS[color];
  return { l: LIGHTNESS[face], c: chroma, h: hue };
}

/** The eyes: white on the dark face, a near-white of the light face's own paper on the light one, so a
 *  face on near-white reads as cut from the same sheet rather than as a second, brighter white. */
export const EYE_OKLCH: Record<Face, Oklch> = { dark: { l: 1, c: 0, h: 0 }, light: { l: 0.985, c: 0.002, h: 264 } };

/** The Lead's star: one gold, lighter than every body so it stands off any of them. */
export const BADGE_OKLCH: Record<Face, Oklch> = { dark: { l: 0.86, c: 0.15, h: 86 }, light: { l: 0.72, c: 0.16, h: 76 } };

/** A CSS colour for both faces at once. The window declares its `color-scheme` from Realm's mode, so
 *  an icon follows the window's face without being told it. */
export const bothFaces = (pick: (face: Face) => Oklch): string => `light-dark(${css(pick("light"))}, ${css(pick("dark"))})`;
