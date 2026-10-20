/**
 * Photograph the site's share images from a running production server.
 *
 *   pnpm build && pnpm start -p 3111      # a production server: the dev server draws its badge into the shot
 *   node scripts/capture-share-images.mjs # or: pnpm capture:share, with REALM_SITE_URL to point elsewhere
 *
 * Writes:
 *   app/opengraph-image.png, app/twitter-image.png and the alt text beside each: /share at 1200 × 630,
 *     which Next serves as the og:image and twitter:image of every page without a card of its own.
 *   public/og/sky-<name>.jpg: /share/sky/<name>, for each sky lib/og/layout.ts names, the backgrounds
 *     the changelog's cards (lib/og/card.tsx) are drawn over at build. Run `next build` again after.
 *
 * Headless Chrome rather than Playwright, because the field is WebGPU and Chrome is what renders it
 * here, driven over the DevTools protocol so one browser takes every picture. Each is the field's still
 * frame (reduced motion), the same every run; a page whose field did not start (no WebGPU) is refused
 * rather than photographed as its CSS fallback. A port that already answers is refused too: a leftover
 * browser there would be photographed instead of this one.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { CARD, SKIES, skyFile } from "../lib/og/layout.ts"

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const base = (process.env.REALM_SITE_URL ?? "http://localhost:3111").replace(/\/$/, "")
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const port = Number(process.env.REALM_CHROME_PORT ?? 9333)
if (!fs.existsSync(chrome)) throw new Error(`No Chrome at ${chrome}; point REALM_CHROME at a Chromium binary`)

// sharp is Next's own image encoder; the site does not depend on it directly, so it is found through Next.
const fromSite = createRequire(path.join(siteRoot, "package.json"))
const sharp = createRequire(fs.realpathSync(fromSite.resolve("next/package.json")))("sharp")

const ALT =
  "Realm. Give your agents a world to work in. One workspace for every coding agent, on your computer. Beside the words, one of Realm's realms, a cube lying on its side with its doorway lit, hangs in a blue nebula, with more realms going away behind it."

if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) {
  throw new Error(`Something already answers on port ${port}; set REALM_CHROME_PORT to a free one`)
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "realm-share-"))
const browser = spawn(
  chrome,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--hide-scrollbars",
    // sRGB whatever the display: the cards are read on other people's screens.
    "--force-color-profile=srgb",
    "about:blank",
  ],
  { stdio: "ignore" },
)

/** The DevTools protocol over the page's socket: send a method, await its result. */
async function connect() {
  let targets
  for (let i = 0; i < 100 && !targets; i++) {
    await sleep(100)
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => undefined)
  }
  const page = targets?.find((target) => target.type === "page")
  if (!page) throw new Error("Chrome started without a page to drive")
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let id = 0
  const pending = new Map()
  const events = []
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    } else events.push(data)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value
  return { send, evaluate, events, close: () => socket.close() }
}

/** The still frame of a page at the card's size, once its field has drawn and faded in. */
async function photograph({ send, evaluate, events }, url) {
  await send("Emulation.setDeviceMetricsOverride", { width: CARD.width, height: CARD.height, deviceScaleFactor: 1, mobile: false })
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  events.length = 0
  await send("Page.navigate", { url })
  for (let i = 0; i < 300 && !events.some((event) => event.method === "Page.loadEventFired"); i++) await sleep(100)
  let field = null
  for (let i = 0; i < 300 && field !== "on" && field !== "off"; i++) {
    await sleep(100)
    field = await evaluate("document.documentElement.dataset.field ?? null")
  }
  if (field !== "on") throw new Error(`The field at ${url} did not start (data-field=${field}); is WebGPU available to this Chrome?`)
  await evaluate("document.fonts.ready.then(() => Promise.all([...document.images].map((image) => image.decode().catch(() => {}))))")
  // The canvas fades in over a second once it has drawn (FieldCanvas), reduced motion or not.
  await sleep(1600)
  const shot = await send("Page.captureScreenshot", { format: "png" })
  return Buffer.from(shot.data, "base64")
}

let page
try {
  page = await connect()
  await page.send("Page.enable")

  const card = await photograph(page, `${base}/share`)
  for (const name of ["opengraph-image", "twitter-image"]) {
    fs.writeFileSync(path.join(siteRoot, "app", `${name}.png`), card)
    fs.writeFileSync(path.join(siteRoot, "app", `${name}.alt.txt`), ALT)
  }
  console.log(`wrote app/opengraph-image.png and app/twitter-image.png (${CARD.width}×${CARD.height}) from ${base}/share`)

  for (const name of Object.keys(SKIES)) {
    const sky = await photograph(page, `${base}/share/sky/${name}`)
    fs.mkdirSync(path.join(siteRoot, "public/og"), { recursive: true })
    await sharp(sky).jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).toFile(path.join(siteRoot, "public/og", skyFile(name)))
    console.log(`wrote public/og/${skyFile(name)} from ${base}/share/sky/${name}`)
  }
} finally {
  page?.close()
  browser.kill("SIGKILL")
  fs.rmSync(profile, { recursive: true, force: true })
}
