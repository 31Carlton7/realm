/**
 * Encodes the landing page's worlds (public/worlds, copied by copy-worlds.mjs) into the smaller WebP
 * files the page serves through srcset, so a phone fetches a picture at the size it draws it.
 *
 *   node scripts/encode-worlds.mjs   # again whenever copy-worlds.mjs brings in a changed picture
 *
 * Each `<name>.jpg` becomes `<name>-<width>.webp` at every width in WIDTHS narrower than the picture,
 * and once at its own width. The widths are the boxes a world is drawn in at 1x and 2x: the hero's ring
 * (210 px on a phone, up to 470 on a desktop) and a section's frame (350 px at 390, 968 at 1024, 1184
 * at 1440). `content/world-widths.json` records which widths each picture has.
 */
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const WIDTHS = [420, 700, 960, 1200, 1600, 1920, 2400]

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dir = path.join(site, "public/worlds")
const manifest = path.join(site, "content/world-widths.json")

// sharp is Next's own image encoder; the site does not depend on it directly, so it is found through Next.
const fromSite = createRequire(path.join(site, "package.json"))
const sharp = createRequire(fs.realpathSync(fromSite.resolve("next/package.json")))("sharp")

const worlds = JSON.parse(fs.readFileSync(path.join(site, "content/worlds.json"), "utf8"))
const widths = {}
for (const { file } of worlds) {
  const source = path.join(dir, file)
  const { width } = await sharp(source).metadata()
  const stem = path.basename(file, path.extname(file))
  widths[file] = [...WIDTHS.filter((w) => w < width), width]
  for (const w of widths[file]) {
    await sharp(source).resize({ width: w }).webp({ quality: 78, effort: 6 }).toFile(path.join(dir, `${stem}-${w}.webp`))
  }
  console.log(`${file}: ${widths[file].join(", ")}`)
}
fs.writeFileSync(manifest, `${JSON.stringify(widths, null, 2)}\n`)
