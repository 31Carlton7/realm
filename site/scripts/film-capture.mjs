#!/usr/bin/env node
/**
 * Record Realm's launch film (app/film) frame by frame from a running server.
 *
 *   npx next build && npx next start -p 3641
 *   node scripts/film-capture.mjs --out film.mp4                     # 1920 × 1080, 60 fps, the whole film
 *   node scripts/film-capture.mjs --out draft.mp4 --fps 30 --scale 0.5 --draft
 *   node scripts/film-capture.mjs --stills 0,2.5,6 --dir shots/      # single frames as PNG
 *   node scripts/film-capture.mjs --out film.mp4 --poster 7.4 --dir out/   # and a poster frame
 *
 * Options: --url (default http://localhost:3641/film?capture), --port (Chrome's DevTools port, 9443),
 * --from/--to (seconds), --crf (14), --preset (slow).
 *
 * Headless Chrome rather than Playwright, because the film's world is WebGPU and Chrome is what renders
 * it here. Each frame is `window.__film.seek(t)` — which resolves once that exact frame is drawn and on
 * screen — then a PNG screenshot, piped straight into ffmpeg: no frame is ever written to disk. A port
 * that already answers is refused: a leftover browser there would be photographed instead of this one.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const CHROME = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const WIDTH = 1920
const HEIGHT = 1080

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
if (!args.out && !args.stills) {
  console.error("usage: film-capture.mjs --out <file.mp4> [--fps 60] [--scale 1] [--draft] [--from s] [--to s] [--poster s --dir d] | --stills t,t,… --dir <dir>")
  process.exit(2)
}

const url = String(args.url ?? "http://localhost:3641/film?capture")
const port = Number(args.port ?? 9443)
const fps = Number(args.fps ?? 60)
const scale = Number(args.scale ?? 1)
const dir = resolve(String(args.dir ?? "."))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) {
  console.error(`Something already answers on port ${port}; pass another --port.`)
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), "realm-film-"))
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // sRGB whatever the display: the film is watched on other people's screens.
    "--force-color-profile=srgb",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  { stdio: "ignore" },
)

let ffmpeg = null
const finish = (code) => {
  chrome.kill("SIGKILL")
  if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill("SIGKILL")
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  process.exit(code)
}
process.on("SIGINT", () => finish(130))

/** The DevTools protocol over the page's socket. */
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
      return
    }
    if (data.method === "Runtime.exceptionThrown") console.error("page:", data.params.exceptionDetails?.exception?.description ?? data.params.exceptionDetails?.text)
    if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") console.error("page:", data.params.args.map((a) => a.value ?? a.description).join(" "))
    events.push(data)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  return { send, evaluate, events }
}

/** One frame: drawn for `t`, then photographed. */
async function shoot(page, t, format = "png", k = scale) {
  await page.evaluate(`window.__film.seek(${t})`)
  const shot = await page.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: 92 } : {}),
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: k },
    captureBeyondViewport: false,
  })
  return Buffer.from(shot.data, "base64")
}

try {
  const page = await connect()
  await page.send("Runtime.enable")
  await page.send("Page.enable")
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  // Emulated focus, or a headless page reports itself unfocused and anything that rests while nobody
  // is looking rests here too.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})
  await page.send("Page.navigate", { url })
  for (let i = 0; i < 300 && !page.events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(100)
  for (let i = 0; i < 300 && !(await page.evaluate("Boolean(window.__film)")); i++) await sleep(100)
  await page.evaluate("window.__film.ready")
  // A development server draws its badge in the corner; it is not part of the film.
  await page.evaluate(`document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())`)
  const duration = await page.evaluate("window.__film.duration")

  if (args.stills) {
    mkdirSync(dir, { recursive: true })
    for (const t of String(args.stills).split(",").map(Number)) {
      const file = join(dir, `still-${t.toFixed(2).padStart(5, "0")}.png`)
      writeFileSync(file, await shoot(page, t))
      console.log(file)
    }
  }

  if (args.out) {
    const from = Number(args.from ?? 0)
    const to = Number(args.to ?? duration)
    const first = Math.round(from * fps)
    const count = Math.round((to - from) * fps)
    const draft = Boolean(args.draft)
    const out = resolve(String(args.out))
    ffmpeg = spawn(
      "ffmpeg",
      [
        "-v", "error", "-y",
        "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
        // RGB to BT.709 at video range, and every frame tagged so (the encoder writes what the frames
        // carry): a blue film shifts visibly under the BT.601 default.
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        "-c:v", "libx264", "-preset", draft ? "veryfast" : String(args.preset ?? "slow"), "-crf", String(args.crf ?? (draft ? 20 : 14)),
        "-r", String(fps), "-movflags", "+faststart",
        out,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    )
    const exited = new Promise((resolve) => ffmpeg.on("exit", resolve))
    const started = Date.now()
    for (let f = 0; f < count; f++) {
      const t = (first + f) / fps
      const frame = await shoot(page, t, draft ? "jpeg" : "png")
      if (!ffmpeg.stdin.write(frame)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve))
      if (f % fps === 0 || f === count - 1) {
        const rate = (f + 1) / ((Date.now() - started) / 1000)
        console.log(`frame ${f + 1}/${count}  t=${t.toFixed(2)}s  ${rate.toFixed(1)} frames/s  eta ${Math.round((count - f - 1) / rate)}s`)
      }
    }
    ffmpeg.stdin.end()
    const code = await exited
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`)
    console.log(out)
  }

  if (args.poster !== undefined) {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "poster.png")
    writeFileSync(file, await shoot(page, Number(args.poster), "png", 1))
    console.log(file)
  }
  finish(0)
} catch (error) {
  console.error(error)
  finish(1)
}
