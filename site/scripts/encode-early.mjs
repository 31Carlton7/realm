/**
 * Encodes the landing page's component captures into the files the page serves.
 *
 *   node scripts/encode-early.mjs <dir of PNGs>
 *
 * Each `<name>.png`, shot at 2x, becomes a lossless `public/early/<name>.webp` (lossless keeps small
 * text sharp, see encode-product.mjs), and `content/early.json` records its size in points.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const from = path.resolve(process.argv[2] ?? "")
const out = path.join(site, "public/early")
const manifest = path.join(site, "content/early.json")

if (!fs.existsSync(from)) throw new Error(`no captures at ${from}`)
fs.mkdirSync(out, { recursive: true })
const sizes = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {}
for (const file of fs.readdirSync(from).filter((f) => f.endsWith(".png")).sort()) {
  const name = path.basename(file, ".png")
  const png = path.join(from, file)
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { encoding: "utf8" })
  const [w, h] = ["pixelWidth", "pixelHeight"].map((key) => Number(info.match(new RegExp(`${key}: (\\d+)`))[1]))
  execFileSync("cwebp", ["-quiet", "-lossless", "-z", "9", png, "-o", path.join(out, `${name}.webp`)])
  sizes[name] = { w: Math.round(w / 2), h: Math.round(h / 2) }
}
fs.writeFileSync(manifest, `${JSON.stringify(sizes, null, 2)}\n`)
