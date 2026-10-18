#!/usr/bin/env node
/**
 * Cut the docs' pictures out of the product captures.
 *
 *   node scripts/docs-crops.mjs
 *
 * A docs page is read in a column about 700px wide, and a whole 1440px window drawn there sets the
 * app's text at half its size: a picture of the product rather than a readable one (design.md:
 * prefer one large legible view and a few purposeful crops over a mosaic of tiny screens). So each
 * page that shows one surface shows that surface on its own, cut from the window it was shot in.
 *
 * The source is the scene as shot (public/product/<scene>-4320.webp, written by encode-product.mjs at
 * the capture's 3× density); each crop is a rect in the window's own points, kept at that density so
 * it is drawn near the size it has in the app and stays sharp. An object with its own corner (a sheet,
 * a card) is cut on its outer edge and carries its corner, so the page rounds the picture where the
 * app rounded the object. Re-run this after a capture run retakes a scene, then re-read every caption
 * the docs set beside the crops it rewrote.
 *
 * Writes public/docs/<name>.webp (lossless, like every capture the site serves) and
 * public/docs/crops.json: each crop's size in points and its corner.
 */
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sharp = createRequire(fs.realpathSync(path.join(siteDir, "node_modules/next/package.json")))("sharp")

/** The capture's density (lib/frames.ts, CAPTURE_DENSITY). */
const DENSITY = 3

/**
 * Each crop: the scene it comes from, its rect in points (x, y, width, height), and its corner. The
 * rects of objects were measured on the 4320px files, where an edge is a step of colour.
 */
const CROPS = {
  // Settings ▸ Keys, its Panes group whole down to the card's foot.
  "keys-list": { scene: "keys", rect: [521, 52, 721, 816], radius: 12 },
  // The New space sheet, on its own rim.
  "new-space-sheet": { scene: "new-space", rect: [489.33, 224.33, 461.34, 451.34], radius: 16 },
  // First run's agent step: the two cards and the fold of the other agents.
  "onboarding-agents": { scene: "onboarding", rect: [380, 296, 680, 232], radius: 12 },
  // A sub-agent's permission card, in its lead's Agents tab.
  "permission-card": { scene: "delegation", rect: [930.33, 175.33, 481.34, 307.34], radius: 12 },
  // The command palette, on its own rim.
  palette: { scene: "palette", rect: [440, 108, 560, 498], radius: 16 },
  // Library ▸ Files: the kind tabs and the grid.
  "library-files": { scene: "library", rect: [345, 52, 1085, 780], radius: 12 },
  // The side panel's Documents tab, with nothing open: this session's files, then the Library's.
  "documents-home": { scene: "documents", rect: [887, 41, 553, 511], radius: 12 },
  // A terminal in the side panel, running vim, under its tab, cut after a whole line.
  "terminal-panel": { scene: "terminal", rect: [887, 0, 553, 456], radius: 12 },
  // A space's Scripts tab.
  scripts: { scene: "commands", rect: [507, 52, 760, 393], radius: 12 },
}

const outDir = path.join(siteDir, "public/docs")
fs.mkdirSync(outDir, { recursive: true })
const sizes = {}
for (const [name, { scene, rect, radius }] of Object.entries(CROPS)) {
  const [x, y, width, height] = rect.map((v) => Math.round(v * DENSITY))
  const source = path.join(siteDir, `public/product/${scene}-4320.webp`)
  await sharp(source).extract({ left: x, top: y, width, height }).webp({ lossless: true, effort: 6 }).toFile(path.join(outDir, `${name}.webp`))
  sizes[name] = { width: Math.round(width / DENSITY), height: Math.round(height / DENSITY), radius }
  console.log(`${name}: ${width}×${height} from ${scene}`)
}
fs.writeFileSync(path.join(outDir, "crops.json"), `${JSON.stringify(sizes, null, 2)}\n`)
