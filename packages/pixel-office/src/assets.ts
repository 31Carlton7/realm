import decoded from "../assets/decoded.json";
import defaultLayout from "../assets/default-office.json";
import { setFloorSprites } from "./vendor/office/floorTiles.js";
import { setWallSprites } from "./vendor/office/wallTiles.js";
import { setCarpetSprites } from "./vendor/office/sprites/carpetTiles.js";
import { setCharacterTemplates } from "./vendor/office/sprites/spriteData.js";
import { buildDynamicCatalog } from "./vendor/office/layout/furnitureCatalog.js";
import type { OfficeLayout, SpriteData } from "./vendor/office/types.js";

/** The shape `tools/decode-assets.mts` writes. Bumped with it; a mismatch is a loud failure. */
const EXPECTED_V = 1;

let installed = false;

/**
 * Hand the vendored engine its sprites.
 *
 * The engine keeps its art in module-level registries that something has to fill before the first
 * frame — upstream fills them from a transport that decodes PNGs in the browser. Realm cannot: its
 * renderer is loaded from `file://`, and a `file://` image drawn into a canvas taints it, so
 * `getImageData` throws on every sprite. So the decode happens once on Node at vendor time
 * (`tools/decode-assets.mts`) and this hands the result straight over. See VENDOR.md.
 *
 * Idempotent, because every office pane calls it and they share one engine: the registries are
 * module state, so the second call would be pure waste rather than a second office.
 */
export function installOfficeAssets(): void {
  if (installed) return;
  if (decoded.v !== EXPECTED_V) {
    throw new Error(`pixel-office: assets/decoded.json is v${decoded.v}, expected v${EXPECTED_V} — re-run decode-assets`);
  }
  setCharacterTemplates(decoded.characters as { down: SpriteData[]; up: SpriteData[]; right: SpriteData[] }[]);
  setFloorSprites(decoded.floors as SpriteData[]);
  setWallSprites(decoded.walls as SpriteData[][]);
  setCarpetSprites(decoded.carpets as SpriteData[][]);
  rebuildCatalog();
  installed = true;
}

/** Furniture drawn by a model this run, by id. Not persisted: a piece nobody kept should not be in
 *  the catalog next launch, and a world that used one carries the piece's id — which is why
 *  `checkWorld` refusing an unknown id is what keeps a stale world honest rather than a crash. */
const generated = new Map<string, { entry: Record<string, unknown>; sprite: SpriteData }>();

function rebuildCatalog(): void {
  buildDynamicCatalog({
    catalog: [...decoded.catalog, ...[...generated.values()].map((g) => g.entry)] as never,
    sprites: { ...(decoded.furniture as Record<string, SpriteData>), ...Object.fromEntries([...generated].map(([id, g]) => [id, g.sprite])) },
  });
}

/**
 * Add a piece of furniture a model drew, so a world may place it.
 *
 * The catalog is rebuilt wholesale rather than appended to, because `buildDynamicCatalog` is what
 * derives rotation groups, state pairs and animation groups from the whole set — appending past it
 * would produce an entry the renderer draws but the rest of the catalog does not know about.
 *
 * The id is namespaced so a generated piece can never shadow one from the pack: a model asked for a
 * "desk" that overwrote `DESK` would change every existing office silently.
 */
export function registerDrawnFurniture(input: {
  id: string; label: string; sprite: SpriteData; footprintW: number; footprintH: number; isDesk?: boolean;
}): string {
  const id = `DRAWN_${input.id.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`;
  generated.set(id, {
    sprite: input.sprite,
    entry: {
      id, label: input.label, category: input.isDesk ? "desks" : "decor",
      footprintW: input.footprintW, footprintH: input.footprintH, isDesk: input.isDesk === true,
    },
  });
  rebuildCatalog();
  return id;
}

/** What has been drawn this run, for the prompter's own list. */
export function drawnFurniture(): { id: string; label: string }[] {
  return [...generated].map(([id, g]) => ({ id, label: String(g.entry.label) }));
}

/** How many characters the pack holds — what a palette index is taken modulo. */
export const CHARACTER_COUNT = decoded.characters.length;

/** The world the office opens on until one is generated or loaded.
 *
 *  Realm's own (`tools/build-default-office.mts`) rather than upstream's, and bigger on purpose:
 *  three rooms, three banks of desks, fifteen places to sit. Upstream's default is a single room
 *  that seats six, which is the right size for a VS Code panel and half a batch short here — the
 *  fan-out launcher starts up to twelve agents at once.
 *
 *  Embedded rather than fetched for the same `file://` reason the sprites are. */
export const DEFAULT_LAYOUT = defaultLayout as unknown as OfficeLayout;
