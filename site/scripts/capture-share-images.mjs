/**
 * Capture the site's share images from the /share route.
 *
 *   pnpm build && pnpm start -p 3111      # a production server: the dev server draws its badge into the shot
 *   node scripts/capture-share-images.mjs # or: pnpm capture:share, with REALM_SHARE_URL to point elsewhere
 *
 * Writes app/opengraph-image.png and app/twitter-image.png at 1200 × 630, which Next serves as the
 * og:image and twitter:image for every page, plus the alt text beside each.
 *
 * The capture is headless Chrome rather than Playwright because the hero is WebGPU, and Chrome is
 * what renders it here. Two Chrome quirks shape the script, the same ones resources/icon-src/render.mjs
 * works around: with a scratch profile it writes the screenshot and then never exits, so the script
 * waits for a complete PNG and kills it; and it needs WebGPU enabled explicitly when headless.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const appDir = path.join(siteRoot, "app")
const url = process.env.REALM_SHARE_URL ?? "http://localhost:3111/share"
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if (!fs.existsSync(chrome)) throw new Error(`No Chrome at ${chrome}; point REALM_CHROME at a Chromium binary`)

const WIDTH = 1200
const HEIGHT = 630
const TIMEOUT_MS = 90_000
const ALT = "Realm, with the words: A local-first control plane for coding agents."
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-share-"))
const profile = path.join(scratch, "chrome-profile")
const shot = path.join(scratch, "share.png")
fs.mkdirSync(profile)

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
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    // The still frame: the loop never starts, so the shot is the field at time zero every run.
    "--force-prefers-reduced-motion",
    "--virtual-time-budget=12000",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${shot}`,
    url,
  ],
  { stdio: "ignore" },
)

try {
  const deadline = Date.now() + TIMEOUT_MS
  while (!isComplete(shot)) {
    if (child.exitCode !== null && !fs.existsSync(shot)) {
      throw new Error(`Chrome exited with ${child.exitCode} before writing a screenshot of ${url}`)
    }
    if (Date.now() > deadline) throw new Error(`Chrome did not finish a screenshot of ${url} within ${TIMEOUT_MS} ms`)
    await sleep(100)
  }
  for (const name of ["opengraph-image", "twitter-image"]) {
    fs.copyFileSync(shot, path.join(appDir, `${name}.png`))
    fs.writeFileSync(path.join(appDir, `${name}.alt.txt`), `${ALT}\n`)
  }
  console.log(`wrote app/opengraph-image.png and app/twitter-image.png (${WIDTH}×${HEIGHT}) from ${url}`)
} finally {
  child.kill("SIGKILL")
  fs.rmSync(scratch, { recursive: true, force: true })
}
