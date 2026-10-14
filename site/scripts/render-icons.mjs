/**
 * Draw the site's marks and icons from the flat mark's geometry.
 *
 *   node scripts/render-icons.mjs
 *
 * The mark is the cube's silhouette with the doorway cut out of it. It is drawn two ways:
 *
 * - One colour, for small uses: the favicon, Safari's mask icon, and the mark beside the name in the
 *   header and footer (components/Wordmark.tsx draws the same path inline in the text colour).
 * - Three flat planes — top #9cc1ff, left #4f8cf5, right #2457c4 — for the app icon: the apple-touch
 *   icon, public/app-icon.png, and public/realm-mark.svg wherever the page shows the mark large.
 *
 * Writes public/realm-mark.svg, public/mask-icon.svg, public/icon.svg, app/favicon.ico,
 * public/apple-icon.png and public/app-icon.png. The PNGs are rasterised by headless Chrome, with the
 * same quirk scripts/capture-share-images.mjs works around: with a scratch profile Chrome writes the
 * screenshot and never exits, so the script waits for a complete PNG and kills it.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if (!fs.existsSync(chrome)) throw new Error(`No Chrome at ${chrome}; point REALM_CHROME at a Chromium binary`)

const SILHOUETTE =
  "M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205Z"
const DOOR = "M24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z"
const PLANES = {
  top: { fill: "#9cc1ff", d: "M20 24L0 24L10 6.6795L30 6.6795Z" },
  left: { fill: "#4f8cf5", d: "M20 24L30 41.3205L10 41.3205L0 24Z" },
  right: { fill: "#2457c4", d: "M20 24L30 6.6795L40 24L30 41.3205Z" },
}
/** Realm blue, the tile behind the one-colour mark in the .ico, top to bottom. */
const BLUE = ["#5b9bff", "#3b7cf0"]
/** The app icon's tile. */
const TILE = "#15161a"

const svg = (body, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="48" viewBox="0 0 40 48" fill="none"${attrs}>\n${body}\n</svg>\n`

const flat = (fill) => `<path fill="${fill}" fill-rule="evenodd" d="${SILHOUETTE}${DOOR}"/>`

const planes = (id) =>
  [
    `<clipPath id="${id}"><path clip-rule="evenodd" d="${SILHOUETTE}${DOOR}"/></clipPath>`,
    `<g clip-path="url(#${id})">`,
    ...Object.values(PLANES).map(({ fill, d }) => `  <path fill="${fill}" d="${d}"/>`),
    `</g>`,
  ].join("\n")

const realmMark = svg(planes("realm-mark"))
const maskIcon = svg(flat("#000"))
// Dark ink on a light tab strip, light ink on a dark one.
const favicon = svg(
  `<style>path{fill:#1c1d21}@media (prefers-color-scheme:dark){path{fill:#e9eaee}}</style>\n<path fill-rule="evenodd" d="${SILHOUETTE}${DOOR}"/>`,
)

/**
 * A square page of `size` px with the mark centred on a tile. `inset` is the tile's margin and
 * `radius` its corner, both as fractions of the page; `pad` is the mark's margin inside the tile.
 */
function tilePage({ size, background, mark, inset = 0, radius = 0, pad }) {
  const tile = size * (1 - 2 * inset)
  const box = tile * (1 - 2 * pad)
  return `<!doctype html><html><head><style>
html,body{margin:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
.tile{position:absolute;left:${size * inset}px;top:${size * inset}px;width:${tile}px;height:${tile}px;border-radius:${tile * radius}px;background:${background};display:grid;place-items:center}
.mark{width:${box}px;height:${box}px}
svg{display:block;width:100%;height:100%}
</style></head><body><div class="tile"><div class="mark">${mark}</div></div></body></html>`
}

const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
function isComplete(file) {
  if (!fs.existsSync(file)) return false
  const size = fs.statSync(file).size
  if (size < IEND.length) return false
  const tail = Buffer.alloc(IEND.length)
  const fd = fs.openSync(file, "r")
  try {
    fs.readSync(fd, tail, 0, IEND.length, size - IEND.length)
  } finally {
    fs.closeSync(fd)
  }
  return tail.equals(IEND)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-icons-"))

async function rasterise(name, html, size) {
  const page = path.join(scratch, `${name}.html`)
  const shot = path.join(scratch, `${name}.png`)
  const profile = path.join(scratch, `${name}-profile`)
  fs.writeFileSync(page, html)
  fs.mkdirSync(profile)
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--force-color-profile=srgb",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${shot}`,
      `file://${page}`,
    ],
    { stdio: "ignore" },
  )
  try {
    const deadline = Date.now() + 60_000
    while (!isComplete(shot)) {
      if (Date.now() > deadline) throw new Error(`Chrome did not finish ${name} within 60 s`)
      await sleep(100)
    }
    return fs.readFileSync(shot)
  } finally {
    child.kill("SIGKILL")
  }
}

/** An .ico holding PNG images, which every browser that still asks for /favicon.ico reads. */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)])
}

try {
  const write = (file, data) => {
    fs.writeFileSync(path.join(siteRoot, file), data)
    console.log(`wrote ${file}`)
  }
  write("public/realm-mark.svg", realmMark)
  write("public/mask-icon.svg", maskIcon)
  write("public/icon.svg", favicon)

  // The .ico has no colour scheme to follow, so it is the one-colour mark on a Realm-blue tile,
  // which reads on a light tab strip and a dark one alike.
  const blueTile = (size) =>
    tilePage({ size, background: `linear-gradient(${BLUE[0]},${BLUE[1]})`, mark: svg(flat("#fff")), radius: 0.225, pad: 0.16 })
  const icoImages = []
  for (const size of [16, 32, 48]) icoImages.push({ size, png: await rasterise(`favicon-${size}`, blueTile(size), size) })
  write("app/favicon.ico", ico(icoImages))

  // iOS rounds the touch icon itself, so it is a full-bleed square.
  write("public/apple-icon.png", await rasterise("apple-icon", tilePage({ size: 180, background: TILE, mark: realmMark, pad: 0.17 }), 180))
  // The Dock-shaped icon: the tile inset on a transparent page, the way macOS draws app icons.
  write(
    "public/app-icon.png",
    await rasterise("app-icon", tilePage({ size: 1024, background: TILE, mark: realmMark, inset: 100 / 1024, radius: 0.225, pad: 0.17 }), 1024),
  )
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
