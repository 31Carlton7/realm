/**
 * Decode the vendored PNGs into sprite grids, once, on Node.
 *
 * Run with `pnpm --filter @realm/pixel-office decode-assets` after anything under `assets/` changes.
 * The output is committed; the renderer imports it and never opens a PNG. See VENDOR.md for why —
 * the short version is that Realm's renderer runs from `file://`, and a `file://` image drawn into a
 * canvas taints it, so the upstream runtime decode path would throw on every sprite.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetIndex, buildFurnitureCatalog } from "./build.js";
import { decodeAllCarpets, decodeAllCharacters, decodeAllFloors, decodeAllFurniture, decodeAllWalls } from "./loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const catalog = buildFurnitureCatalog(assets);

const decoded = {
  /** Bumped when the SHAPE changes, so a stale file is a loud failure rather than a blank office. */
  v: 1,
  index: buildAssetIndex(assets),
  catalog,
  characters: decodeAllCharacters(assets),
  floors: decodeAllFloors(assets),
  walls: decodeAllWalls(assets),
  carpets: decodeAllCarpets(assets),
  furniture: decodeAllFurniture(assets, catalog),
};

const out = path.join(assets, "decoded.json");
fs.writeFileSync(out, JSON.stringify(decoded));
const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`decoded ${catalog.length} furniture, ${decoded.characters.length} characters → ${out} (${mb} MB)`);
