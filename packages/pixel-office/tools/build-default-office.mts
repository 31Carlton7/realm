/**
 * Build the office Realm opens on.
 *
 * Run with `pnpm --filter @realm/pixel-office build-default-office`. Writes `assets/default-office.json`,
 * which is committed and imported by `src/assets.ts`.
 *
 * A generator rather than a hand-written JSON file because the thing being written is 900 tile
 * integers and a furniture list whose every entry has to miss every other entry's footprint. Done by
 * hand that is a puzzle with no feedback; done here the placement rules are stated once, the
 * footprints are read from the real catalog, and an overlap is a thrown error at build time rather
 * than a chair standing inside a desk on screen.
 *
 * The shape: one wide workspace with three banks of desks, a meeting room and a lounge along the
 * right, connected by doorways. Fifteen workstations, because the fan-out launcher will start twelve
 * agents and a room that seats six puts half of them on the floor.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFurnitureCatalog } from "./build.js";
import { decodeAllFurniture } from "./loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, "..", "assets");
const catalog = buildFurnitureCatalog(assetsDir);
void decodeAllFurniture; // the sprites are not needed here; footprints come from the catalog

const entry = (id: string) => {
  const e = catalog.find((c) => c.id === id);
  if (!e) throw new Error(`no such furniture: ${id}`);
  return e;
};

const COLS = 38, ROWS = 24;
const WALL = 0, VOID = 255;
/** Floor patterns per area, so the rooms read as different rooms rather than one hall. */
const FLOOR = { work: 1, meeting: 3, lounge: 5, corridor: 2 };

const tiles: number[] = Array(COLS * ROWS).fill(VOID);
const at = (col: number, row: number) => row * COLS + col;
const fill = (c0: number, r0: number, c1: number, r1: number, t: number) => {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) tiles[at(c, r)] = t;
};

// ── The plan ────────────────────────────────────────────────────────────────
// One border wall around everything; two interior walls carve off the right-hand rooms.
fill(0, 0, COLS - 1, ROWS - 1, WALL);
fill(1, 1, 24, ROWS - 2, FLOOR.work);            // the workspace, left
fill(26, 1, COLS - 2, 10, FLOOR.meeting);        // meeting room, top right
fill(26, 12, COLS - 2, ROWS - 2, FLOOR.lounge);  // lounge, bottom right
fill(25, 1, 25, ROWS - 2, WALL);                 // the wall between left and right
fill(26, 11, COLS - 2, 11, WALL);                // the wall between meeting and lounge
// Doorways. A gap in a wall IS a door — the characters path straight through it.
fill(25, 5, 25, 6, FLOOR.corridor);
fill(25, 17, 25, 18, FLOOR.corridor);

// ── Furniture ───────────────────────────────────────────────────────────────
type Placed = { type: string; col: number; row: number };
const furniture: Placed[] = [];
const taken = new Set<string>();

function place(type: string, col: number, row: number) {
  const e = entry(type);
  for (let dr = 0; dr < e.footprintH; dr++) {
    for (let dc = 0; dc < e.footprintW; dc++) {
      const key = `${col + dc},${row + dr}`;
      if (taken.has(key)) throw new Error(`${type} at ${col},${row} overlaps something at ${key}`);
      const t = tiles[at(col + dc, row + dr)];
      if (t === WALL || t === VOID) throw new Error(`${type} at ${col},${row} sits on a wall at ${key}`);
      taken.add(key);
    }
  }
  furniture.push({ type, col, row });
}

/* A desk with its chair in front — the pair that makes one place an agent can work at.
   DESK_FRONT is 3x2 and WOODEN_CHAIR_FRONT is 1x2, so a workstation is four rows deep. The chair
   goes BELOW the desk, which is what gives `layoutToSeats` `facing: UP` — the direction the sitting
   sprites are actually drawn for. */
function workstation(col: number, row: number) {
  place("DESK_FRONT", col, row);
  place("WOODEN_CHAIR_FRONT", col + 1, row + 2);
}

/* Three banks of five, down the workspace, with a walking lane between each. Fifteen places, because
   the fan-out launcher starts up to twelve agents and a room that seats six puts half of them on
   the floor. */
const BANK_COLS = [2, 6, 10, 14, 18];
for (const row of [4, 10, 16]) for (const col of BANK_COLS) workstation(col, row);

// The workspace's walls, along the top row the desks leave free.
place("DOUBLE_BOOKSHELF", 2, 1);
place("LARGE_PAINTING", 6, 1);
place("CLOCK", 11, 1);
place("BOOKSHELF", 15, 1);
place("DOUBLE_BOOKSHELF", 19, 1);
place("PLANT", 23, 1);
place("LARGE_PLANT", 22, ROWS - 4);
place("BIN", 1, ROWS - 2);
place("COFFEE", 2, ROWS - 2);

// The meeting room: a table with three chairs along the near side, and a board to point at.
place("WHITEBOARD", 33, 1);
place("TABLE_FRONT", 29, 3);
for (const c of [29, 30, 31]) place("CUSHIONED_CHAIR_FRONT", c, 7);
place("PLANT_2", 27, 1);

// The lounge: two sofas facing a low table, something green in each corner.
place("SOFA_FRONT", 29, 14);
place("COFFEE_TABLE", 29, 16);
place("SOFA_FRONT", 29, 19);
place("LARGE_PLANT", 26, 13);
place("CACTUS", 35, 13);
place("PLANT", 35, ROWS - 3);

/* ── Paint ──────────────────────────────────────────────────────────────────
   The floor and wall sprites are GREYSCALE masters — floor 1 is a single #A7A7A7, and the only
   thing that gives a room a colour is `tileColors`. A layout without them is not "unpainted", it is
   grey, which is what an office built without this looked like: a white room with grey furniture.
   `colorize: true` rather than adjust, for the same reason: adjust SHIFTS the hue a pixel already
   has, and a grey pixel has none to shift. */
const PAINT = {
  wall:    { h: 222, s: 14, b: -54, c: 12, colorize: true },
  work:    { h: 28,  s: 34, b: -20, c: 10, colorize: true },  // warm wood
  meeting: { h: 208, s: 20, b: -26, c: 8,  colorize: true },  // cool and quiet
  lounge:  { h: 168, s: 20, b: -28, c: 8,  colorize: true },  // muted green
  corridor:{ h: 222, s: 10, b: -34, c: 8,  colorize: true },
};
const tileColors = tiles.map((t, i) => {
  if (t === VOID) return null;
  if (t === WALL) return PAINT.wall;
  const col = i % COLS, row = Math.floor(i / COLS);
  if (col === 25) return PAINT.corridor;
  if (col < 25) return PAINT.work;
  return row <= 10 ? PAINT.meeting : PAINT.lounge;
});

const layout = { version: 1, cols: COLS, rows: ROWS, layoutRevision: 2, tiles, tileColors, furniture };
const seats = furniture.filter((f) => entry(f.type).category === "chairs")
  .reduce((n, f) => n + entry(f.type).footprintW * entry(f.type).footprintH, 0);
if (seats < 12) throw new Error(`the default office seats only ${seats}; it needs at least 12`);

const out = path.join(assetsDir, "default-office.json");
fs.writeFileSync(out, JSON.stringify(layout));
console.log(`default office: ${COLS}×${ROWS}, ${furniture.length} pieces, ~${seats} seats → ${out}`);
