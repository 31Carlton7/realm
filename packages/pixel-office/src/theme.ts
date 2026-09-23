import type { ColorValue } from "./vendor/components/ui/types.js";
import { TileType, type OfficeLayout } from "./vendor/office/types.js";

/**
 * A skin for a world: what its floors, walls and carpets are painted with.
 *
 * Separate from the world itself because the two change for different reasons. A world is a room —
 * where the walls are, where the desks go — and redesigning it moves everyone's chair. A theme is
 * paint, and repainting should not make the staff stand up. Keeping them apart is also what lets
 * "make it darker" cost a four-number answer from a model rather than a whole floor plan.
 *
 * The values are the engine's own `ColorValue`: hue, saturation, brightness, contrast, plus the
 * `colorize` flag that switches between replacing the hue outright (Photoshop's Colorize) and
 * shifting what the sprite already had.
 */
export type OfficeTheme = {
  name: string;
  floor: ColorValue;
  wall: ColorValue;
  carpet?: ColorValue;
};

export type ThemeCheck =
  | { ok: true; theme: OfficeTheme }
  | { ok: false; problems: string[] };

/** The ranges the engine's colorize maths is defined over. Outside them a sprite does not error, it
 *  just comes out somewhere nobody asked for — which is worse, because it looks deliberate. */
const RANGE = {
  h: [-360, 360], s: [-100, 100], b: [-100, 100], c: [-100, 100],
} as const;

function checkColor(label: string, value: unknown, problems: string[]): ColorValue | null {
  if (typeof value !== "object" || value === null) {
    problems.push(`${label} must be an object with h, s, b and c.`);
    return null;
  }
  const v = value as Record<string, unknown>;
  let bad = false;
  for (const k of ["h", "s", "b", "c"] as const) {
    const n = v[k];
    const [lo, hi] = RANGE[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < lo || n > hi) {
      problems.push(`${label}.${k} must be a number from ${lo} to ${hi}; got ${JSON.stringify(n)}.`);
      bad = true;
    }
  }
  if (bad) return null;
  return { h: v.h as number, s: v.s as number, b: v.b as number, c: v.c as number, colorize: v.colorize === true };
}

/** Validate a theme, for the same reason `checkWorld` exists: anything not shipped with Realm came
 *  out of a model. Collects every problem so one turn can fix all of them. */
export function checkTheme(value: unknown): ThemeCheck {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return { ok: false, problems: ["The theme is not an object."] };
  const t = value as Record<string, unknown>;
  const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 60) : null;
  if (!name) problems.push("name must be a non-empty string.");
  const floor = checkColor("floor", t.floor, problems);
  const wall = checkColor("wall", t.wall, problems);
  const carpet = t.carpet === undefined ? null : checkColor("carpet", t.carpet, problems);
  if (problems.length > 0 || !name || !floor || !wall) return { ok: false, problems };
  return { ok: true, theme: { name, floor, wall, ...(carpet ? { carpet } : {}) } };
}

/**
 * Paint a world.
 *
 * `tileColors` is parallel to `tiles`, so this is a map from each tile's TYPE to the colour that
 * type wears. Returns a new layout — the office rebuilds from a layout identity change, and mutating
 * the one it is already holding would repaint nothing until something else happened to move.
 */
export function applyTheme(layout: OfficeLayout, theme: OfficeTheme | null): OfficeLayout {
  if (!theme) return layout;
  const tileColors = layout.tiles.map((t) =>
    t === TileType.VOID ? null : t === TileType.WALL ? theme.wall : theme.floor);
  const carpetTiles = theme.carpet && layout.carpetTiles
    ? layout.carpetTiles.map((c) => (c ? { ...c, color: theme.carpet! } : c))
    : layout.carpetTiles;
  return { ...layout, tileColors, carpetTiles };
}

/**
 * The themes Realm ships.
 *
 * Deliberately few. They are here so the office has somewhere to start and so "themes" does not mean
 * "nothing until you describe one" — not as a catalogue. Anything beyond these comes from the
 * prompter, which is the point of having a prompter.
 *
 * `colorize: true` on the dark ones because shifting what a bright office sprite already had cannot
 * get to a dark room; replacing the hue outright can.
 */
export const THEMES: OfficeTheme[] = [
  /* Not `{0,0,0,0}`. The floor sprites are greyscale masters, so "no adjustment" is not a neutral
     office — it is a grey one, which is the white room this preset used to produce. */
  { name: "Daylight", floor: { h: 30, s: 30, b: -14, c: 8, colorize: true }, wall: { h: 222, s: 12, b: -48, c: 10, colorize: true } },
  { name: "Night shift", floor: { h: 230, s: 30, b: -42, c: 10, colorize: true }, wall: { h: 232, s: 34, b: -55, c: 8, colorize: true } },
  { name: "Terminal green", floor: { h: 140, s: 26, b: -40, c: 16, colorize: true }, wall: { h: 140, s: 30, b: -58, c: 12, colorize: true } },
  { name: "Amber CRT", floor: { h: 34, s: 46, b: -30, c: 18, colorize: true }, wall: { h: 28, s: 40, b: -50, c: 12, colorize: true } },
  { name: "Blueprint", floor: { h: 210, s: 52, b: -34, c: 22, colorize: true }, wall: { h: 214, s: 58, b: -48, c: 18, colorize: true } },
];


/**
 * The theme a generated world gets when the model did not give it one.
 *
 * Not an aesthetic default so much as a correctness one. The floor and wall sprites are greyscale
 * masters — floor 1 is one flat `#A7A7A7` — so a world with no `tileColors` renders as a white room
 * full of grey furniture, which is a thing nobody asked for and looks like a bug rather than a
 * choice. Leaving the paint out has to mean "pick something", not "render grey".
 */
export const FALLBACK_THEME: OfficeTheme = THEMES[0]!;
