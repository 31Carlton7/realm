// Local proof, not part of the build: with every word hidden (visibility, so nothing moves), photograph
// the landing page at each width and read the field inside every line of text, line by line
// (Range.getClientRects per text node). A star there reads as pixels well above the line's own ground.
//
//   node scripts/check-stars-under-text.mjs <url> <out-dir> <cdp-port>
//
// Needs a headless Chrome already listening on <cdp-port> (--use-angle=metal for WebGL2). Writes
// measures.json, a summary to stdout, and hero stills (with and without text) at 1440 and 390.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { inflateSync } from "node:zlib"

const [url, out, port] = process.argv.slice(2)
if (!url || !out || !port) throw new Error("usage: check-stars-under-text.mjs <url> <out-dir> <cdp-port>")

const WIDTHS = [
  { w: 1440, h: 900 },
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 390, h: 844, mobile: true },
]
const DPR = 2
/** A pixel this many levels (of 255, on its brightest channel) over its line's median ground is a star's light. */
const STAR_STEP = 12

// ---- CDP ----
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener("open", r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (fn, ...args) => {
  const r = await send("Runtime.evaluate", {
    expression: `(${fn})(...${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- PNG (8-bit RGB/RGBA, as Chrome writes them) ----
function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString("ascii", pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported png")
      channels = { 2: 3, 6: 4 }[data[9]]
      if (!channels) throw new Error(`png colour type ${data[9]}`)
    } else if (type === "IDAT") idat.push(data)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0
      let v = row[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + x] = v & 255
    }
  }
  return { width, height, at: (x, y) => { const i = y * stride + x * channels; return Math.max(px[i], px[i + 1], px[i + 2]) } }
}

const shot = async (clip) => Buffer.from((await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) })).data, "base64")

// ---- In the page ----
function lines() {
  const field = (el) => {
    if (el.closest("section")?.querySelector(":scope > canvas")) return "hero sky"
    return "page ground (no field)"
  }
  const label = (el) => {
    const named = el.closest("[class]")
    const cls = named ? String(named.className).split(/\s+/)[0].replace(/^.*?_(.*?)__.*$/, "$1") : el.tagName
    return `${el.tagName.toLowerCase()}.${cls}`
  }
  const out = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue
    const el = n.parentElement
    if (el.closest("script, style, noscript, [aria-hidden=true] svg")) continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 || getComputedStyle(el).display === "none") continue
    range.selectNodeContents(n)
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue
      out.push({
        text: n.textContent.trim().slice(0, 40),
        where: label(el),
        field: field(el),
        x: r.left + scrollX,
        y: r.top + scrollY,
        w: r.width,
        h: r.height,
      })
    }
  }
  // The worlds' boxes, so a line laid over one is caught too.
  const worlds = [...document.querySelectorAll("canvas[data-printed]")]
    .map((c) => c.parentElement.getBoundingClientRect())
    .map((r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }))
  const sky = document.querySelector("section > canvas").getBoundingClientRect()
  return { lines: out, worlds, sky: { x: sky.left, y: sky.top + scrollY, w: sky.width, h: sky.height }, height: document.documentElement.scrollHeight }
}

async function settle() {
  await evaluate(async () => {
    await document.fonts.ready
    const t0 = performance.now()
    while (performance.now() - t0 < 15000) {
      const sky = document.querySelector("section > canvas")
      const worlds = [...document.querySelectorAll("canvas")].filter((c) => c !== sky)
      if (sky?.dataset.ready && worlds.every((c) => c.dataset.printed)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 1000))
  })
}

const hide = () =>
  evaluate(() => {
    const s = document.createElement("style")
    s.id = "hide-text"
    s.textContent = "body * { visibility: hidden !important } canvas { visibility: visible !important }"
    document.head.append(s)
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
const show = () => evaluate(() => { document.getElementById("hide-text")?.remove(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const report = []
await send("Page.enable")
await send("Runtime.enable")
for (const { w, h, mobile } of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: DPR, mobile: !!mobile })
  await send("Page.navigate", { url })
  await sleep(500)
  await evaluate(() => new Promise((r) => (document.readyState === "complete" ? r() : addEventListener("load", r, { once: true }))))
  await settle()
  const page = await evaluate(lines)

  if (w === 1440 || w === 390) {
    await evaluate(() => scrollTo(0, 0))
    writeFileSync(join(out, `hero-${w}.png`), await shot())
  }
  await hide()

  // One photograph per screen of the page, each line read in the screen that holds it whole.
  const screens = []
  for (let top = 0; top < page.height; top += h - 120) {
    const y = Math.min(top, page.height - h)
    await evaluate((y) => scrollTo(0, y), y)
    await sleep(150)
    const real = await evaluate(() => scrollY)
    screens.push({ y: real, png: decodePng(await shot()) })
    if (y === page.height - h) break
  }
  if (w === 1440 || w === 390) {
    await evaluate(() => scrollTo(0, 0))
    await sleep(150)
    writeFileSync(join(out, `hero-${w}-text-hidden.png`), await shot())
  }

  const read = (box) => {
    const s = screens.find((s) => box.y >= s.y && box.y + box.h <= s.y + h)
    if (!s) return null
    const vals = []
    const x0 = Math.max(0, Math.floor(box.x * DPR))
    const x1 = Math.min(s.png.width, Math.ceil((box.x + box.w) * DPR))
    const y0 = Math.max(0, Math.floor((box.y - s.y) * DPR))
    const y1 = Math.min(s.png.height, Math.ceil((box.y - s.y + box.h) * DPR))
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(s.png.at(x, y))
    const sorted = [...vals].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]
    return { max: sorted[sorted.length - 1], median, stars: vals.filter((v) => v - median > STAR_STEP).length, px: vals.length }
  }

  const rows = page.lines.map((l) => ({ ...l, overWorld: page.worlds.some((b) => overlaps(l, b)), ...read(l) }))

  // A control: the same line boxes, slid into open sky above or beside the copy, where stars are drawn.
  const rand = (() => { let a = w; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()
  const controls = []
  const skyLines = rows.filter((r) => r.field === "hero sky")
  for (let i = 0; i < 400 && controls.length < 60; i++) {
    const l = skyLines[Math.floor(rand() * skyLines.length)]
    const box = { x: rand() * (page.sky.w - l.w), y: page.sky.y + rand() * (Math.min(page.sky.h, h) - l.h), w: l.w, h: l.h }
    const grown = (b) => ({ x: b.x - 30, y: b.y - 30, w: b.w + 60, h: b.h + 60 })
    if (page.lines.some((t) => overlaps(grown(t), box)) || page.worlds.some((b) => overlaps(grown(b), box))) continue
    const r = read(box)
    if (r) controls.push(r)
  }

  const sum = (rs) => ({
    lines: rs.length,
    maxBrightness: Math.max(...rs.map((r) => r.max)),
    maxOverGround: Math.max(...rs.map((r) => r.max - r.median)),
    starPixels: rs.reduce((n, r) => n + r.stars, 0),
  })
  const entry = {
    width: w,
    heroSky: sum(rows.filter((r) => r.field === "hero sky")),
    pageGround: sum(rows.filter((r) => r.field !== "hero sky")),
    worldBoxes: page.worlds.length,
    linesOverAWorld: rows.filter((r) => r.overWorld).map((r) => `${r.where} "${r.text}"`),
    unread: rows.filter((r) => r.max === undefined).length,
    worstHeroLines: rows
      .filter((r) => r.field === "hero sky")
      .sort((a, b) => b.max - b.median - (a.max - a.median))
      .slice(0, 3)
      .map((r) => ({ where: r.where, text: r.text, max: r.max, median: r.median, stars: r.stars })),
    controlOpenSky: { boxes: controls.length, ...sum(controls), boxesWithStars: controls.filter((c) => c.stars > 0).length },
    rows,
  }
  report.push(entry)
  await show()
  const { rows: _, ...short } = entry
  console.log(JSON.stringify(short))
}
writeFileSync(join(out, "measures.json"), JSON.stringify(report, null, 2))
ws.close()
