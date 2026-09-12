import { z } from "zod";

/**
 * The thirteen colours a Realm palette is made of, and the face it is for.
 *
 * These live here rather than in `@realm/ui` because they are the SHAPE a theme has, not a way of
 * drawing one: the server stores them, the translator produces them, and the renderer's `deriveVars`
 * expands them into a palette. Only that last one needs React anywhere near it.
 */
export type Mode = "light" | "dark";

export type SyntaxSeed = {
  /** Comments and doc tags. The one syntax colour allowed to sit near the ground. */
  comment: string;
  /** Keywords, storage, literals, HTML tag names. */
  keyword: string;
  /** Strings, regexes, and the additions in a diff. */
  string: string;
  /** Numbers, symbols, links, template holes. */
  number: string;
  /** The name being DEFINED: functions, classes, sections, `#id` selectors. */
  title: string;
  /** Types, built-ins and parameters. */
  type: string;
  /** Attributes, properties, `.class` selectors. */
  attr: string;
};

export type ThemeSeed = {
  /** The window ground. The whole surface ladder is this colour at other lightnesses, so its HUE and
   *  CHROMA are what make a theme's greys look like that theme's greys rather than Realm's. */
  bg: string;
  /** Primary UI ink — chrome, not code. */
  ink: string;
  /** The one hue the app uses for itself: primary buttons, focus rings, links, carets, active ticks. */
  accent: string;
  /** State colours. A theme states them because "green means it worked" has to survive a repaint. */
  green: string;
  orange: string;
  red: string;
  syntax: SyntaxSeed;
};

/** The seed as a schema, for the wire and for reading a file a user may have hand-edited. */
export const SyntaxSeedSchema = z.object({
  comment: z.string(), keyword: z.string(), string: z.string(),
  number: z.string(), title: z.string(), type: z.string(), attr: z.string(),
});
export const ThemeSeedSchema = z.object({
  bg: z.string(), ink: z.string(), accent: z.string(),
  green: z.string(), orange: z.string(), red: z.string(), syntax: SyntaxSeedSchema,
});

/**
 * A theme the user imported, as it sits in `~/Realm/themes/<id>.json`.
 *
 * `source` is kept because an import is a TRANSLATION and the app owes the user a way to see how
 * much of one: `derived` names the roles the VS Code file did not state, which Realm had to work out.
 * A theme with eight derived roles is worth knowing about before it repaints the app.
 */
export const StoredThemeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  mode: z.enum(["dark", "light"]),
  seed: ThemeSeedSchema,
  source: z.object({ file: z.string(), derived: z.array(z.string()) }),
});
export type StoredTheme = z.infer<typeof StoredThemeSchema>;

/** A font family fetched from Google Fonts and kept under `~/Realm/fonts`. */
export const InstalledFontSchema = z.object({
  family: z.string(),
  /** The weights actually downloaded — Realm's chrome is drawn against 400 and 500. */
  weights: z.array(z.number().int()),
  bytes: z.number().int().nonnegative(),
});
export type InstalledFont = z.infer<typeof InstalledFontSchema>;

/** One family on offer from Google Fonts. Three fields: the catalog is two thousand entries and
 *  everything else in it is for a type specimen site, not a picker. */
export const CatalogFontSchema = z.object({
  family: z.string(),
  category: z.string(),
  /** Whether it is a monospace family — the code-face picker must not offer a proportional one. */
  mono: z.boolean(),
});
export type CatalogFont = z.infer<typeof CatalogFontSchema>;
