#!/usr/bin/env node
/**
 * Build the images the root README shows, from the site as it is deployed.
 *
 *   node scripts/readme-images.mjs
 *   REALM_SITE_URL=http://localhost:3111 node scripts/readme-images.mjs   # a `pnpm start` in site/
 *
 * GitHub shows the README from `main`, and the site is deployed from whichever branch carries its
 * newest captures, so the pictures come from the site rather than from this checkout: the README
 * shows what realm.computer shows. Rerun this after the site ships new captures or a new share card.
 *
 * - `banner.png` is the share card, `/share`, at 1.5x. It renders the dimension field, so it needs a
 *   Chrome with WebGPU, the same one `site/scripts/capture-share-images.mjs` uses.
 * - The rest are captures from `/product`, each cropped to the region its landing-page claim is
 *   about (`focus` in site/content/home.ts, held inside the capture the way Claim.tsx holds it) and
 *   laid on Realm's page colour. The window is translucent, and GitHub would otherwise composite it
 *   onto white.
 *
 * Every image gets the site's frame, rounded corners and a hairline edge, drawn by Chrome onto a
 * transparent ground so it sits on GitHub's light and dark themes alike. Chrome writes a screenshot
 * and then does not always exit, so each shot waits for a complete PNG and kills it.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const site = (process.env.REALM_SITE_URL ?? "https://realm.computer").replace(/\/$/, "")
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if (!fs.existsSync(chrome)) throw new Error(`No Chrome at ${chrome}; point REALM_CHROME at a Chromium binary`)

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "images")

/** `--color-page` from `site/app/globals.css`. Keep the two in step. */
const PAGE = "#17181a"
/** Every capture is the whole 1440x900 window at 2x. */
const SHOT = { width: 2880, height: 1800 }
/** One cell of the README's grid, in the 15/8 frame the landing page shows its claims through. */
const CELL = { width: 1200, height: 640, radius: 28, edge: 2 }
/** The share card, and the scale it is taken at: sharp across the README's full width. */
const BANNER = { width: 1200, height: 630, scale: 1.5, radius: 20, edge: 1 }

/** The landing page's claims, in its order, with the regions site/content/home.ts frames. */
const CLAIMS = [
  { name: "session", focus: { x: 0.6, y: 0.33, span: 0.64 } },
  { name: "models", focus: { x: 0.62, y: 0.71, span: 0.66 } },
  { name: "connections", focus: { x: 0.6, y: 0.34, span: 0.68 } },
  { name: "sandbox", focus: { x: 0.7, y: 0.515, span: 0.6 } },
  { name: "schedules", focus: { x: 0.6, y: 0.328, span: 0.66 } },
  { name: "activity", focus: { x: 0.1, y: 0.593, span: 0.61 } },
]

const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
const TIMEOUT_MS = 90_000
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-readme-"))

/** Claim.tsx's rule: a point nearer an edge than half the visible span stops half a span in. */
function hold(point, visible) {
  if (visible >= 1) return 0.5
  return Math.min(Math.max(point, visible / 2), 1 - visible / 2)
}

/** True once Chrome has written the whole PNG: the file ends with the IEND chunk. */
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

async function shoot({ url, file, width, height, scale = 1, webgpu = false }) {
  const profile = fs.mkdtempSync(path.join(scratch, "profile-"))
  const flags = webgpu
    ? ["--enable-unsafe-webgpu", "--use-angle=metal", "--force-prefers-reduced-motion", "--virtual-time-budget=12000"]
    : ["--allow-file-access-from-files", "--default-background-color=00000000", "--virtual-time-budget=5000"]
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--hide-scrollbars",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      ...flags,
      `--screenshot=${file}`,
      url,
    ],
    { stdio: "ignore" },
  )
  try {
    const deadline = Date.now() + TIMEOUT_MS
    while (!isComplete(file)) {
      if (child.exitCode !== null && !fs.existsSync(file)) {
        throw new Error(`Chrome exited with ${child.exitCode} before writing a screenshot of ${url}`)
      }
      if (Date.now() > deadline) throw new Error(`Chrome did not finish a screenshot of ${url} within ${TIMEOUT_MS} ms`)
      await sleep(100)
    }
  } finally {
    child.kill("SIGKILL")
  }
}

/** A page that shows `src` through a rounded frame with a hairline edge, on a transparent ground. */
function framed({ src, width, height, radius, edge, left = 0, top = 0, imageWidth = width }) {
  return `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
.frame { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; border-radius: ${radius}px; background: ${PAGE}; }
.frame img { position: absolute; left: ${left}px; top: ${top}px; width: ${imageWidth}px; }
.frame::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 ${edge}px rgb(255 255 255 / 0.09); }
</style><div class="frame"><img src="${src}" alt=""></div>`
}

async function frame(name, page, { width, height, scale = 1 }) {
  const html = path.join(scratch, `${name}.html`)
  fs.writeFileSync(html, page)
  const file = path.join(out, `${name}.png`)
  fs.rmSync(file, { force: true })
  await shoot({ url: `file://${html}`, file, width, height, scale })
  console.log(`wrote docs/images/${name}.png (${width * scale}×${height * scale})`)
}

try {
  fs.mkdirSync(out, { recursive: true })

  const card = path.join(scratch, "share.png")
  await shoot({ url: `${site}/share`, file: card, width: BANNER.width, height: BANNER.height, scale: BANNER.scale, webgpu: true })
  await frame("banner", framed({ src: `file://${card}`, ...BANNER }), BANNER)

  for (const { name, focus } of CLAIMS) {
    const response = await fetch(`${site}/product/${name}.png`)
    if (!response.ok) throw new Error(`${site}/product/${name}.png answered ${response.status}`)
    const capture = path.join(scratch, `${name}-capture.png`)
    fs.writeFileSync(capture, Buffer.from(await response.arrayBuffer()))

    const imageWidth = CELL.width / focus.span
    const imageHeight = (imageWidth * SHOT.height) / SHOT.width
    const left = CELL.width / 2 - hold(focus.x, focus.span) * imageWidth
    const top = CELL.height / 2 - hold(focus.y, CELL.height / imageHeight) * imageHeight
    await frame(name, framed({ src: `file://${capture}`, ...CELL, left, top, imageWidth }), CELL)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
