import { contrast, css, oklchToHex, type Oklch } from "@realm/contracts";

/** The parts a Realmite is made of, by stable id. A spec stores ids, never geometry or colour, so a
 *  part can be redrawn later without a migration, and a stored spec keeps meaning what it meant. The
 *  label is what the maker's pickers announce. */

export const BODIES = {
  cube: "Cube",
  squircle: "Squircle",
  gumdrop: "Gumdrop",
  bean: "Bean",
  mochi: "Mochi",
  egg: "Egg",
  drop: "Drop",
} as const;

export const EYES = {
  dot: "Dots",
  bean: "Beans",
  shine: "Shiny",
  lidded: "Lidded",
  cyclops: "One eye",
} as const;

export const MOUTHS = {
  none: "No mouth",
  smile: "Smile",
  cat: "Cat",
  open: "Open",
  flat: "Flat",
  fang: "Fang",
} as const;

export const ACCESSORIES = {
  none: "Nothing",
  sprout: "Sprout",
  bobble: "Bobble",
  beanie: "Beanie",
  cap: "Cap",
  horns: "Horns",
  headphones: "Headphones",
  "cat-ears": "Cat ears",
  "bear-ears": "Bear ears",
} as const;

export const PATTERNS = {
  none: "Plain",
  belly: "Belly",
  facet: "Facet",
  spots: "Spots",
  stripes: "Stripes",
  faceplate: "Face plate",
} as const;

export type BodyId = keyof typeof BODIES;
export type EyesId = keyof typeof EYES;
export type MouthId = keyof typeof MOUTHS;
export type AccessoryId = keyof typeof ACCESSORIES;
export type PatternId = keyof typeof PATTERNS;

/** A palette is a body hue and a companion hue for what the Realmite wears.
 *
 *  The body is the creature's silhouette, so it is held to the WCAG 1.4.11 floor for a graphical
 *  object — 3 : 1 — against every ground Realm draws a row or a page on, in both faces. That floor is
 *  why the bodies are mid-tones rather than pastels: on the dark face a body has to sit well above
 *  L 0.5, and on the light face well below 0.75, so each face gets its own lightness and keeps the
 *  hue and chroma that make it recognisably the same creature. (Light is not dark inverted —
 *  design.md, Surfaces.)
 *
 *  The hues stay clear of the three that carry state. Green, orange and red mean running, waiting
 *  and failed, and a Realmite sits beside a status dot in every row it appears in; so there is a rose
 *  but no red, an apricot well yellow of the waiting orange, a moss well yellow of the running green,
 *  and the warm brown (clay) is low enough in chroma to read as a material rather than a signal. */
export type PaletteDef = { label: string; hue: number; chroma: number; dark: number; light: number; wear: number };

export const PALETTES = {
  rose: { label: "Rose", hue: 5, chroma: 0.14, dark: 0.72, light: 0.635, wear: 300 },
  clay: { label: "Clay", hue: 50, chroma: 0.07, dark: 0.7, light: 0.62, wear: 220 },
  apricot: { label: "Apricot", hue: 72, chroma: 0.13, dark: 0.76, light: 0.62, wear: 260 },
  honey: { label: "Honey", hue: 86, chroma: 0.13, dark: 0.8, light: 0.615, wear: 20 },
  moss: { label: "Moss", hue: 128, chroma: 0.12, dark: 0.74, light: 0.605, wear: 330 },
  teal: { label: "Teal", hue: 190, chroma: 0.1, dark: 0.74, light: 0.6, wear: 30 },
  sky: { label: "Sky", hue: 228, chroma: 0.11, dark: 0.74, light: 0.61, wear: 60 },
  realm: { label: "Realm blue", hue: 256, chroma: 0.15, dark: 0.7, light: 0.62, wear: 80 },
  iris: { label: "Iris", hue: 285, chroma: 0.14, dark: 0.7, light: 0.625, wear: 100 },
  orchid: { label: "Orchid", hue: 322, chroma: 0.14, dark: 0.72, light: 0.635, wear: 200 },
  slate: { label: "Slate", hue: 264, chroma: 0.025, dark: 0.72, light: 0.615, wear: 256 },
  sage: { label: "Sage", hue: 160, chroma: 0.045, dark: 0.74, light: 0.61, wear: 10 },
} as const satisfies Record<string, PaletteDef>;

export type PaletteId = keyof typeof PALETTES;
export type Face = "dark" | "light";

/** Every colour a Realmite is drawn in, for one face. All CSS strings. */
export type Colours = {
  body: string; shade: string; light: string; ink: string; white: string; blush: string; wear: string; wearLight: string; leaf: string;
};

/** The body colour as OKLCH — exported so the contrast suite measures the value that is drawn. */
export function bodyOklch(id: PaletteId, face: Face): Oklch {
  const p: PaletteDef = PALETTES[id];
  /* The light face's lightness is the brightest that still clears 3 : 1 on the darkest light ground
     a Realmite stands on (a lit row, `--hover-2`), and it
     carries a tenth more chroma: a mid-tone on near-white paper otherwise reads as muddy. */
  return face === "dark" ? { l: p.dark, c: p.chroma, h: p.hue } : { l: p.light, c: p.chroma * 1.1, h: p.hue };
}

/** The face ink: a near-black of the body's own hue, so a face never looks pasted on. */
export function inkOklch(id: PaletteId): Oklch {
  const p: PaletteDef = PALETTES[id];
  return { l: 0.24, c: Math.min(0.04, p.chroma * 0.4), h: p.hue };
}

const hex = (o: Oklch) => oklchToHex(o);

export function colours(id: PaletteId, face: Face): Colours {
  const p: PaletteDef = PALETTES[id];
  const body = bodyOklch(id, face);
  /* What it wears is the companion hue, a clear step DARKER than the body on both faces, so a hat
     separates from the head it sits on by lightness and not by hue alone. */
  const wear: Oklch = { l: body.l - 0.2, c: Math.max(0.06, p.chroma * 0.9), h: p.wear };
  return {
    body: hex(body),
    shade: hex({ ...body, l: body.l - 0.12, c: body.c * 1.08 }),
    light: hex({ ...body, l: Math.min(0.94, body.l + 0.14), c: body.c * 0.55 }),
    ink: hex(inkOklch(id)),
    white: "#ffffff",
    blush: css({ l: 0.72, c: 0.13, h: 10 }, 0.55),
    wear: hex(wear),
    wearLight: hex({ ...wear, l: wear.l + 0.12 }),
    leaf: hex({ l: body.l - 0.12, c: 0.1, h: 125 }),
  };
}

/** The contrast the face's ink makes against the body it is drawn on. */
export const faceContrast = (id: PaletteId, face: Face): number => contrast(inkOklch(id), bodyOklch(id, face));
