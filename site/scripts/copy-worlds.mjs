/**
 * Copies the landing page's worlds from the desktop app's own gallery into `public/worlds/`, with the
 * gallery's credit line for each into `content/worlds.json`.
 *
 * The page's worlds are the pictures Realm opens new sessions onto, never scenes made for the site, so
 * they are copied rather than kept as a second set that could drift. `pnpm build` runs this first. A
 * deploy uploads `site/` alone, where the app's folder is not there to read, so the copies are committed
 * and a build without the gallery checks that they are all present instead, with the WebP encodes the
 * page serves (scripts/encode-worlds.mjs, run again whenever a picture here changes).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const gallery = path.resolve(site, "../apps/desktop/src/renderer/src/assets/hero-backdrops")
const out = path.join(site, "public/worlds")
const manifest = path.join(site, "content/worlds.json")

/**
 * The gallery ids the page shows, in page order, with the side of each look it uses. A world is shown
 * on the dark page, so it is the look's night picture, except Sky, whose day is the one its section
 * shows.
 */
const WORLDS = [
  ["webb", "dark"],
  ["church", "dark"],
  ["hubble", "dark"],
  ["sky", "light"],
  ["heade", "dark"],
]

if (!fs.existsSync(path.join(gallery, "gallery.json"))) {
  const listed = JSON.parse(fs.readFileSync(manifest, "utf8"))
  const missing = listed.filter((world) => !fs.existsSync(path.join(out, world.file)))
  if (missing.length) throw new Error(`public/worlds is missing ${missing.map((w) => w.file).join(", ")}`)
  const encodes = JSON.parse(fs.readFileSync(path.join(site, "content/world-widths.json"), "utf8"))
  const unencoded = listed.flatMap((world) =>
    (encodes[world.file] ?? [0]).map((w) => world.file.replace(/\.[^.]+$/, `-${w}.webp`)).filter((f) => !fs.existsSync(path.join(out, f))),
  )
  if (unencoded.length) throw new Error(`public/worlds is missing ${unencoded.join(", ")}; run scripts/encode-worlds.mjs`)
  process.exit(0)
}

const looks = JSON.parse(fs.readFileSync(path.join(gallery, "gallery.json"), "utf8"))
fs.mkdirSync(out, { recursive: true })
const worlds = WORLDS.map(([id, side]) => {
  const look = looks.find((entry) => entry.id === id)
  if (!look) throw new Error(`gallery.json has no "${id}"`)
  const file = look[side]
  fs.copyFileSync(path.join(gallery, file), path.join(out, file))
  return { id, name: look.name, file, credit: look.credit }
})
fs.writeFileSync(manifest, `${JSON.stringify(worlds, null, 2)}\n`)
