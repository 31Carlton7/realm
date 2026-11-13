/**
 * Encodes the landing page's component captures into the files the page serves.
 *
 *   node scripts/encode-early.mjs <dir of PNGs>
 *
 * Each `<name>.png`, shot at 2x, becomes two files in `public/early/`: `<name>.webp` as shot, for 2x
 * screens, and `<name>-1x.webp` at its size in points, for 1x screens. `content/early.json` records the
 * size in points. Crops of the app's chrome are lossless as shot, which keeps small text sharp (see
 * encode-product.mjs); at 1x, lossless came out no smaller than the 2x file, so that copy is lossy.
 * A crop that is mostly one of the worlds' photographs (PHOTOS) is lossy at both sizes, with
 * full-resolution colour, since lossless spends most of its bytes on the stars.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PHOTOS = new Set(["session", "session-phone"])

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const from = path.resolve(process.argv[2] ?? "")
const out = path.join(site, "public/early")
const manifest = path.join(site, "content/early.json")

if (!fs.existsSync(from)) throw new Error(`no captures at ${from}`)
fs.mkdirSync(out, { recursive: true })
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "encode-early-"))

const encode = (name, png, webp, scaled) => {
  const lossy = (q) => ["-q", q, "-sharp_yuv", "-m", "6"]
  const quality = PHOTOS.has(name) ? lossy("82") : scaled ? lossy("92") : ["-lossless", "-z", "9"]
  execFileSync("cwebp", ["-quiet", ...quality, png, "-o", webp])
}

const sizes = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {}
for (const file of fs.readdirSync(from).filter((f) => f.endsWith(".png")).sort()) {
  const name = path.basename(file, ".png")
  const png = path.join(from, file)
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { encoding: "utf8" })
  const [w, h] = ["pixelWidth", "pixelHeight"].map((key) => Number(info.match(new RegExp(`${key}: (\\d+)`))[1]))
  const size = { w: Math.round(w / 2), h: Math.round(h / 2) }
  encode(name, png, path.join(out, `${name}.webp`))
  const half = path.join(scratch, file)
  execFileSync("sips", ["-z", String(size.h), String(size.w), png, "--out", half], { stdio: "ignore" })
  encode(name, half, path.join(out, `${name}-1x.webp`), true)
  sizes[name] = size
}
fs.rmSync(scratch, { recursive: true, force: true })
fs.writeFileSync(manifest, `${JSON.stringify(sizes, null, 2)}\n`)
