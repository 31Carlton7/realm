#!/usr/bin/env node
/**
 * Photograph a hero-lab concept in a headless Chrome that runs WebGPU on Metal.
 *
 *   node scripts/lab-shot.mjs --url http://localhost:3611/lab/hero/doorway --out ~/.cache/hero-lab/doorway \
 *     [--name desk] [--port 9411] [--size 1440x900] [--dpr 1] [--mobile] [--reduced] \
 *     [--pointer 980,520] [--frames 3] [--gap 400] [--wait 3500] [--scroll 0] [--nogpu] [--switcher]
 *
 * Writes <out>/<name>-<i>.png (one per frame) and prints a JSON summary: the canvas state
 * (`data-lab-field`: on | off | pending), an estimated frame rate over two seconds, and any page
 * errors. Headless frame rates run lower than a real window's; compare concepts with each other.
 *
 * Each concurrent user needs its own --port. A port that already answers is refused rather than
 * reused: a leftover browser there would be photographed instead of this one.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "")
  const value = process.argv[i + 1]
  if (value === undefined || value.startsWith("--")) args[key] = true
  else {
    args[key] = value
    i++
  }
}
if (!args.url || !args.out) {
  console.error("usage: lab-shot.mjs --url <url> --out <dir> [--name] [--port] [--size WxH] [--dpr] [--mobile] [--reduced] [--pointer x,y] [--frames n] [--gap ms] [--wait ms] [--scroll px] [--nogpu]")
  process.exit(2)
}

const port = Number(args.port ?? 9411)
const [width, height] = String(args.size ?? (args.mobile ? "390x844" : "1440x900")).split("x").map(Number)
const dpr = Number(args.dpr ?? (args.mobile ? 2 : 1))
const frames = Number(args.frames ?? 1)
const gap = Number(args.gap ?? 400)
const wait = Number(args.wait ?? 3500)
const name = String(args.name ?? (args.mobile ? "mobile" : "desk"))
const out = resolve(String(args.out).replace(/^~(?=$|\/)/, homedir()))
mkdirSync(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await fetch(`http://127.0.0.1:${port}/json/version`)
  console.error(`Something already answers on port ${port}; pass another --port.`)
  process.exit(2)
} catch {
  // Free, as it should be.
}

const profile = mkdtempSync(join(tmpdir(), "lab-shot-"))
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    ...(args.nogpu ? ["--disable-gpu", "--disable-features=WebGPU"] : ["--enable-unsafe-webgpu", "--use-angle=metal"]),
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${Math.max(width, 500)},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
)

const finish = (code) => {
  chrome.kill("SIGKILL")
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  process.exit(code)
}
const deadline = setTimeout(() => {
  console.error("Timed out after 120 s.")
  finish(1)
}, 120_000)

try {
  let list
  for (let i = 0; i < 100 && !list; i++) {
    await sleep(100)
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    } catch {}
  }
  const page = list?.find((t) => t.type === "page")
  if (!page) throw new Error("Chrome started without a page to drive.")

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  const errors = []
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id && pending.has(data.id)) {
      const { r, j } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) j(new Error(data.error.message))
      else r(data.result)
      return
    }
    if (data.method === "Runtime.exceptionThrown") errors.push(data.params.exceptionDetails?.exception?.description ?? data.params.exceptionDetails?.text)
    if (data.method === "Runtime.consoleAPICalled" && (data.params.type === "error" || data.params.type === "warning"))
      errors.push(`console.${data.params.type}: ${data.params.args.map((a) => a.value ?? a.description).join(" ")}`)
    for (const l of listeners) l(data)
  }
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const n = ++id
      pending.set(n, { r, j })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value

  await send("Runtime.enable")
  await send("Page.enable")
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: Boolean(args.mobile) })
  if (args.reduced) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  // Emulated focus, or a headless page reports itself unfocused and anything that rests while
  // nobody is looking rests here too.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})

  const loaded = new Promise((r) => listeners.push((d) => d.method === "Page.loadEventFired" && r()))
  await send("Page.navigate", { url: String(args.url) })
  await Promise.race([loaded, sleep(30_000)])
  if (args.scroll) await evaluate(`window.scrollTo(0, ${Number(args.scroll)})`)
  await sleep(wait)

  if (args.pointer) {
    const [x, y] = String(args.pointer).split(",").map(Number)
    const from = [width * 0.5, height * 0.5]
    for (let i = 1; i <= 16; i++) {
      const k = i / 16
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0] + (x - from[0]) * k, y: from[1] + (y - from[1]) * k, pointerType: "mouse" })
      await sleep(30)
    }
    await sleep(900)
  }

  // The lab's own switcher is review chrome, not part of any concept: out of every picture unless asked for.
  if (!args.switcher) await evaluate(`document.querySelector('nav[aria-label="Hero concepts"]')?.remove()`)

  const field = await evaluate("document.documentElement.dataset.labField ?? document.documentElement.dataset.dimField ?? null")
  const before = await evaluate("window.__labFrames ?? -1")
  const t0 = Date.now()
  const files = []
  for (let i = 0; i < frames; i++) {
    const shot = await send("Page.captureScreenshot", { format: "png" })
    const file = join(out, `${name}-${i}.png`)
    writeFileSync(file, Buffer.from(shot.data, "base64"))
    files.push(file)
    if (i < frames - 1) await sleep(gap)
  }
  const elapsed = Date.now() - t0
  if (elapsed < 2000) await sleep(2000 - elapsed)
  const after = await evaluate("window.__labFrames ?? -1")
  const seconds = (Date.now() - t0) / 1000
  const fps = before >= 0 && after >= 0 ? Math.round(((after - before) / seconds) * 10) / 10 : null

  console.log(JSON.stringify({ url: args.url, size: `${width}x${height}@${dpr}`, reduced: Boolean(args.reduced), field, fps, files, errors }, null, 2))
  clearTimeout(deadline)
  ws.close()
  finish(0)
} catch (error) {
  console.error(error)
  clearTimeout(deadline)
  finish(1)
}
