/**
 * Realm's pictures for places outside realm.computer, photographed from a production build of the site
 * (site/: `npx next build && npx next start -p 3112`) in a headless Chrome running WebGPU:
 *
 *   github/social-preview.png   /share re-laid at 1280 × 640: the repository's social preview (< 1 MB)
 *   github/workspace.png        /share/readme at 1600 × 900, 2×: the README's picture under its title
 *   github/<part>.png           /share/readme/<part> at 1440 × 900, 2×: the README's feature pictures
 *   personal/realm.jpg          the landing page's first view at 1280 × 800, 1.5×, JPEG at 80: the card on
 *                               carltonaikins.com, as that site's capture-project-screenshots.mjs takes it
 *
 *   SITE=http://localhost:3112 SITE_DIR=$PWD node scripts/capture-brand.mjs   # from site/; OUT defaults to ~/.cache/realm-brand
 *
 * Every picture is the field's still frame (reduced motion) and flattened onto an opaque ground.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
// Written outside the repo: the GitHub pictures are copied into docs/images by hand, and the personal
// site's card into that repository, so neither is a build output of this one.
const out = path.resolve(process.env.OUT ?? path.join(os.homedir(), ".cache/realm-brand"))
const base = (process.env.SITE ?? "http://localhost:3112").replace(/\/$/, "")
const port = Number(process.env.CHROME_PORT ?? 9441)
const siteDir = process.env.SITE_DIR
if (!siteDir) throw new Error("Set SITE_DIR to the site/ folder whose Next carries sharp")
const fromSite = createRequire(path.join(siteDir, "package.json"))
const sharp = createRequire(fs.realpathSync(fromSite.resolve("next/package.json")))("sharp")
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

const PARTS = ["sidebar", "models", "connections", "sandbox"]
const GROUND = "#03050b"

if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) throw new Error(`Port ${port} is taken`)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "realm-brand-"))
const browser = spawn(CHROME, [
  "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
  "--enable-unsafe-webgpu", "--use-angle=metal", "--hide-scrollbars", "--force-color-profile=srgb", "about:blank",
], { stdio: "ignore" })

let socket
try {
  let targets
  for (let i = 0; i < 100 && !targets; i++) {
    await sleep(100)
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => undefined)
  }
  socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  const events = []
  socket.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result) }
    else events.push(d)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value
  await send("Page.enable")
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})

  /** A page's still frame once its field (if it has one) has drawn and faded in. */
  async function shoot(url, { width, height, dpr, settle = 1600, format = "png", quality }) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false })
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
    events.length = 0
    await send("Page.navigate", { url })
    for (let i = 0; i < 300 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(100)
    let field = null
    for (let i = 0; i < 100; i++) {
      field = await evaluate("document.documentElement.dataset.field ?? null")
      if (field === "on" || field === "off" || field === null && i > 20) break
      await sleep(100)
    }
    if (field === "off" || field === "pending") throw new Error(`The field at ${url} did not start (${field})`)
    // Only the pictures on screen: a lazy one below the fold never loads, and its decode never settles.
    await evaluate(`Promise.race([
      document.fonts.ready.then(() => Promise.all([...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight).map((i) => i.decode().catch(() => {})))),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ])`)
    await sleep(settle)
    const shot = await send("Page.captureScreenshot", { format, ...(quality ? { quality } : {}) })
    return { bytes: Buffer.from(shot.data, "base64"), field }
  }
  const flat = (bytes) => sharp(bytes).flatten({ background: GROUND }).removeAlpha()
  const report = async (file) => {
    const meta = await sharp(file).metadata()
    console.log(`${path.relative(out, file)}  ${meta.width}×${meta.height}  ${Math.round(fs.statSync(file).size / 1024)} KB`)
  }

  fs.mkdirSync(path.join(out, "github"), { recursive: true })
  fs.mkdirSync(path.join(out, "personal"), { recursive: true })

  const social = await shoot(`${base}/share`, { width: 1280, height: 640, dpr: 1 })
  await flat(social.bytes).png({ compressionLevel: 9 }).toFile(path.join(out, "github/social-preview.png"))
  await report(path.join(out, "github/social-preview.png"))

  // Quantized: 0.8 MB rather than 2.7; its dither is lost in the downsampling GitHub's column does (4×,
  // 2× on a Retina screen), and only a full-size look finds grain in the cube's shading.
  const hero = await shoot(`${base}/share/readme`, { width: 1600, height: 900, dpr: 2 })
  await flat(hero.bytes).png({ palette: true, quality: 95, effort: 10, dither: 1, compressionLevel: 9 }).toFile(path.join(out, "github/workspace.png"))
  await report(path.join(out, "github/workspace.png"))

  for (const part of PARTS) {
    const shot = await shoot(`${base}/share/readme/${part}`, { width: 1440, height: 900, dpr: 2, settle: 600 })
    await flat(shot.bytes).png({ compressionLevel: 9 }).toFile(path.join(out, `github/${part}.png`))
    await report(path.join(out, `github/${part}.png`))
  }

  // As the personal site's own script takes its cards: 1280 × 800 at 1.5×, reduced motion, a 4 s settle,
  // and Chrome's JPEG at 80.
  const landing = await shoot(`${base}/`, { width: 1280, height: 800, dpr: 1.5, settle: 4000, format: "jpeg", quality: 80 })
  fs.writeFileSync(path.join(out, "personal/realm.jpg"), landing.bytes)
  await report(path.join(out, "personal/realm.jpg"))
} finally {
  socket?.close()
  browser.kill("SIGKILL")
  fs.rmSync(profile, { recursive: true, force: true })
}
