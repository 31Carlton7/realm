import type { SpriteData } from "./vendor/office/types.js";
import { TILE_SIZE } from "./vendor/office/types.js";

/** A sprite as a model is asked to draw it: a small palette, then rows of single characters that
 *  index into it. `.` is transparent. */
export type DrawnSprite = { name: string; palette: Record<string, string>; pixels: string[] };

export type SpriteCheck =
  | { ok: true; name: string; sprite: SpriteData; footprintW: number; footprintH: number }
  | { ok: false; problems: string[] };

/** How big a drawn sprite may be, in tiles. Three by three is a big desk; past that a piece stops
 *  being furniture and starts being architecture, which is the room's job. */
const MAX_TILES = 3;
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Turn a drawn sprite into the grid the renderer paints, or say why it cannot.
 *
 * The palette-and-characters form is here for the same reason the room is drawn as text: the
 * alternative asks a model to emit `height` rows of `width` hex strings — a 32×32 piece is 1,024 of
 * them — and to keep every row the same length while doing it. A ragged row there is a sprite that
 * renders with a bite out of it, and nothing in the answer looks wrong. Drawn as characters over a
 * named palette, a row that is short is visibly short, the colours are stated once, and the whole
 * piece is small enough to read back.
 *
 * The footprint is derived from the pixel size rather than asked for: a model that says a piece is
 * two tiles wide and then draws it three tiles wide has told the engine something that will put a
 * chair through a wall, and only one of those two numbers is evidence.
 */
export function checkSprite(value: unknown): SpriteCheck {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return { ok: false, problems: ["The sprite is not an object."] };
  const v = value as Partial<DrawnSprite> & Record<string, unknown>;

  const name = typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 40) : null;
  if (!name) problems.push("name must be a non-empty string.");

  const palette = v.palette;
  const colours = new Map<string, string>();
  if (typeof palette !== "object" || palette === null) problems.push("palette must be an object of key → #RRGGBB.");
  else {
    for (const [key, hex] of Object.entries(palette as Record<string, unknown>)) {
      if (key.length !== 1) { problems.push(`palette key ${JSON.stringify(key)} must be a single character.`); continue; }
      if (key === ".") { problems.push("`.` is reserved for transparent and cannot be a palette key."); continue; }
      if (typeof hex !== "string" || !HEX.test(hex)) { problems.push(`palette.${key} must be #RRGGBB; got ${JSON.stringify(hex)}.`); continue; }
      colours.set(key, hex);
    }
  }

  const pixels = v.pixels;
  if (!Array.isArray(pixels) || pixels.length === 0) problems.push("pixels must be a non-empty array of rows.");
  else {
    const width = typeof pixels[0] === "string" ? pixels[0].length : 0;
    if (width === 0) problems.push("the first row of pixels is empty.");
    const ragged = pixels.findIndex((r) => typeof r !== "string" || r.length !== width);
    if (width > 0 && ragged >= 0) problems.push(`every row must be ${width} characters wide (row ${ragged + 1} is not).`);
    if (width > MAX_TILES * TILE_SIZE || pixels.length > MAX_TILES * TILE_SIZE) {
      problems.push(`a sprite may be at most ${MAX_TILES * TILE_SIZE}×${MAX_TILES * TILE_SIZE} pixels (${MAX_TILES} tiles).`);
    }
    if (problems.length === 0) {
      const stray = new Set<string>();
      for (const row of pixels as string[]) for (const ch of row) if (ch !== "." && !colours.has(ch)) stray.add(ch);
      if (stray.size > 0) problems.push(`pixels use ${[...stray].map((c) => JSON.stringify(c)).join(", ")}, which the palette does not define.`);
    }
  }

  if (problems.length > 0 || !name || !Array.isArray(pixels)) return { ok: false, problems };
  const rows = pixels as string[];
  const sprite: SpriteData = rows.map((row) => [...row].map((ch) => (ch === "." ? "" : colours.get(ch)!)));
  const opaque = sprite.some((r) => r.some((c) => c !== ""));
  if (!opaque) return { ok: false, problems: ["the sprite is entirely transparent."] };
  return {
    ok: true, name, sprite,
    footprintW: Math.max(1, Math.ceil((rows[0]?.length ?? 0) / TILE_SIZE)),
    footprintH: Math.max(1, Math.ceil(rows.length / TILE_SIZE)),
  };
}

/** The size a drawn sprite should be asked for, in pixels — one, two or three tiles square. Stated
 *  here so the prompt and the check cannot disagree about it. */
export const SPRITE_TILE = TILE_SIZE;
export const SPRITE_MAX_TILES = MAX_TILES;
