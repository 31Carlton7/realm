import { FURNITURE_CATEGORIES, getCatalogByCategory, getCatalogEntry } from "./vendor/office/layout/furnitureCatalog.js";
import { MAX_COLS, MAX_ROWS, TileType, type OfficeLayout } from "./vendor/office/types.js";

/** The reasons a world is refused, in the words the prompter shows the user. */
export type WorldProblem = string;

export type WorldCheck =
  | { ok: true; layout: OfficeLayout }
  | { ok: false; problems: WorldProblem[] };

/** Tile values the renderer knows how to draw. Anything else is a hole in the floor. */
const TILES = new Set<number>(Object.values(TileType));

/**
 * Validate a world before it is allowed anywhere near the renderer.
 *
 * Every world the office draws that Realm did not ship came out of a language model, so this is the
 * trust boundary rather than a formality. The engine indexes `tiles` by `row * cols + col` and looks
 * furniture up by id without checking either — which is correct for a layout its own editor built,
 * and a crash for one a model wrote. A short world, a stray tile value or a piece of furniture that
 * does not exist are all one-line mistakes for a model to make and all of them take the pane down.
 *
 * Refusals are collected rather than thrown one at a time: the caller shows them to the user, and a
 * model handed all four of its mistakes fixes them in one turn where it would fix them in four.
 *
 * What this does NOT do is judge the world. A room with no chairs, a wall across the middle, an
 * office nobody could work in — all of those render, so all of them are allowed. The user asked for
 * it, and refusing it because it is odd would be this function exceeding its brief.
 */
export function checkWorld(value: unknown): WorldCheck {
  const problems: WorldProblem[] = [];
  const bad = (p: string) => { problems.push(p); return problems; };

  if (typeof value !== "object" || value === null) return { ok: false, problems: bad("The world is not an object.") };
  const w = value as Partial<OfficeLayout> & Record<string, unknown>;

  const cols = w.cols, rows = w.rows;
  if (!Number.isInteger(cols) || (cols as number) < 4 || (cols as number) > MAX_COLS) {
    bad(`cols must be a whole number from 4 to ${MAX_COLS}; got ${JSON.stringify(cols)}.`);
  }
  if (!Number.isInteger(rows) || (rows as number) < 4 || (rows as number) > MAX_ROWS) {
    bad(`rows must be a whole number from 4 to ${MAX_ROWS}; got ${JSON.stringify(rows)}.`);
  }
  if (!Array.isArray(w.tiles)) bad("tiles must be an array.");
  else if (Number.isInteger(cols) && Number.isInteger(rows)) {
    const want = (cols as number) * (rows as number);
    // The one that would otherwise be a blank office rather than an error: the renderer reads
    // `tiles[row * cols + col]`, so a short array is `undefined` tiles and no exception.
    if (w.tiles.length !== want) bad(`tiles must hold exactly cols × rows = ${want} entries; got ${w.tiles.length}.`);
    const stray = [...new Set(w.tiles.filter((t) => !TILES.has(t as number)))];
    if (stray.length > 0) bad(`tiles may only contain ${[...TILES].join(", ")}; found ${stray.slice(0, 5).join(", ")}.`);
  }

  if (!Array.isArray(w.furniture)) bad("furniture must be an array (use [] for an empty room).");
  else {
    const unknown = new Set<string>();
    for (const f of w.furniture) {
      const piece = f as { type?: unknown; col?: unknown; row?: unknown };
      if (typeof piece.type !== "string" || !getCatalogEntry(piece.type)) {
        if (typeof piece.type === "string") unknown.add(piece.type);
        else bad("every piece of furniture needs a string `type`.");
        continue;
      }
      if (!Number.isInteger(piece.col) || !Number.isInteger(piece.row)) {
        bad(`furniture "${piece.type}" needs whole-number col and row.`);
      }
    }
    if (unknown.size > 0) bad(`no such furniture: ${[...unknown].slice(0, 8).join(", ")}.`);
  }

  if (problems.length > 0) return { ok: false, problems };
  // `version` and the optional layers are normalised rather than demanded: a model that leaves out
  // `carpetTiles` meant an office without carpets, and refusing that would be pedantry.
  return { ok: true, layout: { ...(w as OfficeLayout), version: 1 } };
}

/**
 * Every furniture id a world may use, grouped as the catalog groups them.
 *
 * Read from the live catalog rather than written down, so the vocabulary a model is handed and the
 * vocabulary `checkWorld` accepts are the same list by construction. A prompt listing a piece the
 * catalog dropped is how a model gets blamed for a mistake the asset pipeline made.
 *
 * Only valid after `installOfficeAssets()` — the catalog is built from the decoded assets.
 */
export function furnitureVocabulary(): { category: string; ids: string[] }[] {
  return FURNITURE_CATEGORIES
    .map(({ id, label }) => ({ category: label, ids: getCatalogByCategory(id).map((e) => e.type) }))
    .filter((g) => g.ids.length > 0);
}

/**
 * A room drawn as text, expanded into the tile array the engine indexes.
 *
 * `#` is wall, `.` is nothing (outside the room), `1`–`9` are the nine floor patterns.
 *
 * This exists because of what the alternative asks a language model to do. `tiles` is a flat array
 * of `cols × rows` integers — a 20×16 room is 320 numbers in one line, and the model has to keep an
 * exact count while imagining a floor plan. Getting that wrong by one is invisible in the answer and
 * a room with a hole in it on screen. Drawn as text the shape IS the data: rows are lines, a wall is
 * a `#` where you can see it, and a mistake is a ragged edge the model can spot in its own output.
 *
 * Refuses ragged rows rather than padding them. A padded room is a room the user did not describe
 * and nobody would connect to what they typed.
 */
export function expandRoom(rows: readonly string[]): { ok: true; cols: number; rows: number; tiles: number[] } | { ok: false; problems: string[] } {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, problems: ["The room has no rows."] };
  const width = rows[0]!.length;
  if (width === 0) return { ok: false, problems: ["The room's first row is empty."] };
  const ragged = rows.findIndex((r) => typeof r !== "string" || r.length !== width);
  if (ragged >= 0) {
    return { ok: false, problems: [`every row must be ${width} characters wide (row ${ragged + 1} is ${rows[ragged]?.length ?? "not a string"}).`] };
  }
  const tiles: number[] = [];
  const stray = new Set<string>();
  for (const row of rows) {
    for (const ch of row) {
      if (ch === "#") tiles.push(TileType.WALL);
      else if (ch === ".") tiles.push(TileType.VOID);
      else if (ch >= "1" && ch <= "9") tiles.push(Number(ch));
      else { stray.add(ch); tiles.push(TileType.VOID); }
    }
  }
  if (stray.size > 0) {
    return { ok: false, problems: [`a room may only use # . and 1-9; found ${[...stray].map((c) => JSON.stringify(c)).join(", ")}.`] };
  }
  return { ok: true, cols: width, rows: rows.length, tiles };
}

/** The reverse, for showing an existing world back to a model that is being asked to change it. */
export function roomToText(layout: OfficeLayout): string[] {
  const out: string[] = [];
  for (let r = 0; r < layout.rows; r++) {
    let line = "";
    for (let c = 0; c < layout.cols; c++) {
      const t = layout.tiles[r * layout.cols + c];
      line += t === TileType.WALL ? "#" : t === TileType.VOID || t === undefined ? "." : String(t);
    }
    out.push(line);
  }
  return out;
}

/** The part of a world that actually has floor in it, in tiles. */
export type WorldBounds = { minCol: number; maxCol: number; minRow: number; maxRow: number; cols: number; rows: number };

/**
 * Where the room is inside the grid it was declared with.
 *
 * These are not the same thing, and assuming they were is what made the office render at half size
 * in the bottom corner of its pane. The layout Realm ships declares 21×22 and fills rows 10–20 —
 * 52% of that grid is `VOID` padding above the room. Fitting to `cols × rows` therefore divides by
 * twice the height there is anything in, and centring the grid centres the padding along with it.
 *
 * A generated world is usually tight to its own walls, so this changes nothing for one. It is the
 * hand-authored layouts — which are the ones anybody sees first — that carry the slack.
 */
export function worldBounds(layout: OfficeLayout): WorldBounds {
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (let i = 0; i < layout.tiles.length; i++) {
    if (layout.tiles[i] === TileType.VOID) continue;
    const col = i % layout.cols, row = Math.floor(i / layout.cols);
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
  }
  // An empty world has no bounds to speak of; answer with the declared grid so callers need no
  // special case and a blank office simply draws blank in the middle.
  if (maxCol < minCol) return { minCol: 0, maxCol: layout.cols - 1, minRow: 0, maxRow: layout.rows - 1, cols: layout.cols, rows: layout.rows };
  return { minCol, maxCol, minRow, maxRow, cols: maxCol - minCol + 1, rows: maxRow - minRow + 1 };
}
