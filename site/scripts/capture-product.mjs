/**
 * Capture the real Realm renderer for the marketing site: the features carousel, the landing page's
 * claims, the changelog's figures and the README's frames.
 *
 *   pnpm --filter realm-site capture:product      # or: node site/scripts/capture-product.mjs
 *
 * It boots the BUILT app (`apps/desktop/out`, `apps/server/dist`), so run `pnpm build` at the repo
 * root first — a stale build reads as a live bug.
 *
 * The run is isolated from the developer's app: Realm's data and Electron's user data live in a
 * disposable directory (under `REALM_CAPTURE_SCRATCH`, the system temp dir unless set), on the
 * documented alternate ports. The content is staged through the same RPC and UI paths a person uses;
 * only the final PNGs are kept.
 *
 * Nothing it does is billed. Claude and Codex are the scripted agent here (`REALM_FAKE_STANDS_IN`),
 * so every session — onboarding's included — answers from the fake's script, and the model chips
 * still name the models a real session would run. Code review talks to a fake `gh` that serves the
 * fixture pull requests, so nothing reaches GitHub either.
 *
 * Every capture asserts its own subject before it is written (see `shot`), so a scene that lands on
 * the wrong screen fails instead of photographing it. Scenes are independent and each is wrapped: a
 * selector that has moved loses one image and prints why, rather than ending the run. The full-window
 * scenes are written to `public/product/<scene>.png` and listed in `public/product/manifest.json`; the
 * site renders the intersection of that and the copy in `content/features.ts`, so a scene that breaks
 * drops out of the carousel instead of shipping a hole. The crops the changelog figures use go to
 * `public/product/details/`, and are imported by the entries that show them.
 */
import { execFileSync, spawn } from "node:child_process"
import { connect } from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const outputDir = path.join(repoRoot, "site/public/product")
const detailDir = path.join(outputDir, "details")
const cdpPort = Number(process.env.REALM_CAPTURE_CDP_PORT ?? 9350)
const serverPort = Number(process.env.REALM_CAPTURE_SERVER_PORT ?? 8917)
const scratchRoot = process.env.REALM_CAPTURE_SCRATCH ?? os.tmpdir()
fs.mkdirSync(scratchRoot, { recursive: true })
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-site-capture-"))
const home = path.join(scratch, "home")
/** Renders the pictures the staged spaces hold. Without it the run still works, with fewer of them. */
const chrome = process.env.REALM_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The window the captures are framed at, drawn at 2× — the carousel shows them near full width. */
const VIEWPORT = { width: 1440, height: 900 }
/**
 * `--color-page` from `site/app/globals.css`. The window is made of translucent material that is not
 * in the DOM, so a capture composites its grounds over nothing; each one is laid on the page colour
 * the site shows it on, for the length of the shot only.
 */
const PAGE = "#17181a"

/** The checkout the transcript scenes edit: the two files `fix the org access` expects to find. */
function seedWebApp(dir) {
  const lib = path.join(dir, "web/lib"), compaction = path.join(dir, "web/lib/agent/chat-runtime/compaction")
  fs.mkdirSync(compaction, { recursive: true })
  const slugs = Array.from({ length: 19 }, (_, i) => `export function orgSlug${i}(name: string) {\n  return name.toLowerCase().replace(/\\s+/g, "-") + "-${i}";\n}\n`).join("\n")
  const labels = Array.from({ length: 6 }, (_, i) => `export const orgLabel${i} = "Org ${i}";\n`).join("")
  fs.writeFileSync(path.join(lib, "orgs.ts"), `import { and, eq } from "drizzle-orm";\nimport { db } from "./db";\nimport { organizationMember } from "./schema";\n\n${slugs}\nexport async function getOrgMembership(orgId: string, userId: string) {\n  const rows = await db.select().from(organizationMember)\n    .where(and(eq(organizationMember.organizationId, orgId), eq(organizationMember.userId, userId)));\n  return rows[0] ?? null;\n}\n\n${labels}`)
  const chunks = Array.from({ length: 16 }, (_, i) => `export const chunkName${i} = "chunk-${i}";\n`).join("")
  fs.writeFileSync(path.join(compaction, "auto-compact.ts"), `${chunks}\nexport function shouldCompact(tokens: number, limit: number) {\n  return tokens > limit * 0.8;\n}\n`)
  fs.writeFileSync(path.join(dir, "README.md"), "# Dashboard\n\nThe customer dashboard: orgs, projects and their members.\n")
  commitAll(dir, "Seed the dashboard")
}

/** The site's checkout: a changelog to ask about, and branches for a question to offer. */
function seedSite(dir) {
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## 2.0.0\n\n- Every space in one sidebar.\n- One side panel for what agents open.\n")
  fs.writeFileSync(path.join(dir, "README.md"), "# Site\n\nrealm.computer: the landing page, the features and the changelog.\n")
  commitAll(dir, "Start the site")
  for (const branch of ["release/2.0", "site/changelog"]) git(dir, "branch", branch)
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Realm", "-c", "user.email=realm@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" })
}

function commitAll(dir, message) {
  if (!fs.existsSync(path.join(dir, ".git"))) git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", message)
}

/**
 * The pictures the staged work holds — three directions for a settings page, which a question offers
 * as tiles, and the images, poster and brief a Library is made of — drawn by headless Chrome from the
 * markup below, so the run reproduces without a folder of binaries beside it.
 */
const mark = fs.readFileSync(path.join(repoRoot, "resources/icon-src/mark.svg"), "utf8")
const font = `font-family: -apple-system, 'Inter', 'Helvetica Neue', sans-serif;`
const settingsMock = ({ ground, ink, quiet, line, card, accent, title, rows, gap, size }) => `<!doctype html><html><body style="margin:0;background:${ground};${font}">
<div style="display:flex;height:780px">
  <div style="width:240px;padding:36px 24px;border-right:1px solid ${line};color:${quiet};font-size:${size}px;line-height:2.4">
    <div style="color:${ink};font-weight:600">General</div><div>Appearance</div><div>Keys</div><div>Notifications</div><div>Engines</div><div>Sign-ins</div>
  </div>
  <div style="flex:1;padding:40px 56px;color:${ink}">
    <div style="font-size:${title}px;font-weight:650;letter-spacing:-0.03em">Appearance</div>
    <div style="margin-top:${gap}px;background:${card};border-radius:14px;padding:0 24px">
      ${Array.from({ length: rows }, (_, i) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:${gap / 2}px 0;${i ? `border-top:1px solid ${line};` : ""}font-size:${size}px">
        <span>${["Theme", "Accent colour", "Sidebar translucency", "Reduce motion", "UI font size", "Code font", "Cursor", "App icon", "Line height", "Contrast"][i % 10]}</span>
        <span style="width:${size * 2.6}px;height:${size * 1.5}px;border-radius:99px;background:${i % 3 ? line : accent}"></span></div>`).join("")}
    </div>
  </div>
</div></body></html>`
const PICTURES = {
  "mockups/calm.png": { width: 1200, height: 780, html: settingsMock({ ground: "#f7f7f8", ink: "#1d1d1f", quiet: "#8a8a8e", line: "#e4e4e7", card: "#ffffff", accent: "#3b82f6", title: 30, rows: 5, gap: 34, size: 17 }) },
  "mockups/bold.png": { width: 1200, height: 780, html: settingsMock({ ground: "#0b0b0d", ink: "#ffffff", quiet: "#9a9aa0", line: "#2a2a30", card: "#16161a", accent: "#ff5c39", title: 72, rows: 3, gap: 48, size: 24 }) },
  "mockups/dense.png": { width: 1200, height: 780, html: settingsMock({ ground: "#1c1d21", ink: "#e8e8ea", quiet: "#7c7d84", line: "#2c2d33", card: "#232429", accent: "#4cc9f0", title: 22, rows: 10, gap: 22, size: 14 }) },
  "desk/ridge-at-dusk.png": { width: 1600, height: 1000, html: `<!doctype html><html><body style="margin:0">
<svg width="1600" height="1000" viewBox="0 0 1600 1000" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a55"/><stop offset=".45" stop-color="#6b5b95"/><stop offset=".75" stop-color="#f09a6b"/><stop offset="1" stop-color="#ffd39b"/></linearGradient></defs>
  <rect width="1600" height="1000" fill="url(#sky)"/>
  <circle cx="1080" cy="640" r="70" fill="#ffe2b0" opacity=".9"/>
  <path d="M0 700 L180 560 L320 640 L470 500 L640 620 L820 470 L1010 610 L1180 520 L1360 640 L1600 540 L1600 1000 L0 1000Z" fill="#3c3460" opacity=".85"/>
  <path d="M0 800 L210 690 L400 760 L600 650 L780 760 L980 680 L1200 780 L1400 700 L1600 770 L1600 1000 L0 1000Z" fill="#26213f"/>
  <path d="M0 900 L260 830 L520 880 L760 820 L1040 890 L1300 840 L1600 880 L1600 1000 L0 1000Z" fill="#15122a"/>
</svg></body></html>` },
  "desk/palette.png": { width: 1200, height: 900, html: `<!doctype html><html><body style="margin:0;background:#17181a;${font}">
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:64px">
  ${["#3d9aff", "#7c6cff", "#3ddc97", "#ffb454", "#ff6b8b", "#4cc9f0", "#f4a261", "#a3e635", "#c084fc", "#38bdf8", "#fb7185", "#e8e8ea"].map((c) => `<div><div style="height:150px;border-radius:18px;background:${c}"></div><div style="margin-top:12px;color:#a8a9b0;font:500 20px ui-monospace,Menlo,monospace">${c}</div></div>`).join("")}
</div></body></html>` },
  "desk/launch-poster.png": { width: 1200, height: 1500, html: `<!doctype html><html><body style="margin:0;${font}">
<div style="width:1200px;height:1500px;background:linear-gradient(#33353a,#151619);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#f4f5f7">
  <div style="width:460px">${mark.replace(/width="40" height="48"/, 'width="460" height="552"')}</div>
  <div style="margin-top:72px;font-size:128px;font-weight:650;letter-spacing:-0.045em">Realm 2.0</div>
  <div style="margin-top:20px;font-size:40px;color:#b4b8be">One workspace for every coding agent.</div>
</div></body></html>` },
}

/** The brief is a PDF, printed by the same Chrome. */
const BRIEF = `<!doctype html><html><body style="${font};color:#1d1d1f;padding:56px 64px">
<h1 style="font-size:34px;letter-spacing:-0.02em">Release brief — Realm 2.0</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a3c">What ships, what is gone, and what to check before the tag.</p>
<h2 style="font-size:20px;margin-top:32px">What ships</h2>
<ul style="font-size:15px;line-height:1.8"><li>Every space in one sidebar, under Needs you</li><li>As many panes as there is room for, beside one side panel</li><li>The model picker, with effort and fast mode at its foot</li><li>One card for every agent's questions</li><li>Code review, through your own gh</li></ul>
<h2 style="font-size:20px;margin-top:32px">Before the tag</h2>
<ol style="font-size:15px;line-height:1.8"><li>The full suite, and the live checks on a scratch home</li><li>A signed, notarized build</li><li>The changelog, dated</li></ol>
</body></html>`

/** The Library's own files, beside the pictures: written straight into the folder they are added from. */
const DESK_FILES = {
  "desk/launch-notes.md": "# Launch notes\n\n- Friday: the changelog and the new captures go live.\n- Monday: the announcement, with the 2.0 film.\n",
  "desk/bundle-sizes.csv": "release,app_kb,libraries_kb\n1.4,722,1355\n1.5,760,1340\n1.6,781,1388\n2.0,798,1431\n",
  "desk/tokenizer.ts": "export function* tokens(text: string): Iterable<string> {\n  for (const word of text.split(/\\s+/)) if (word) yield word;\n}\n",
}

/** Draw `PICTURES` and the brief under `root`. Resolves to the files written; [] when there is no Chrome. */
async function renderPictures(root) {
  if (!fs.existsSync(chrome)) {
    console.warn(`    no Chrome at ${chrome} — the staged pictures are skipped (REALM_CHROME points elsewhere)`)
    return []
  }
  const profile = fs.mkdtempSync(path.join(scratch, "chrome-"))
  // Port 0 and the profile's DevToolsActivePort, so a browser left on a fixed port by another run can
  // never answer for this one.
  const child = spawn(chrome, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: "ignore" })
  const written = []
  try {
    const port = await until(() => {
      try { return Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || null } catch { return null }
    }, 20_000, "Chrome's DevTools port")
    const target = await until(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])).find((t) => t.type === "page"), 20_000, "a Chrome page")
    const page = connectCdp(target.webSocketDebuggerUrl)
    await page.ready
    await page.send("Page.enable")
    const load = async (html, width, height) => {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      await page.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` })
      await sleep(600)
    }
    for (const [name, picture] of Object.entries(PICTURES)) {
      await load(picture.html, picture.width, picture.height)
      const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: picture.width, height: picture.height, scale: 1 } })
      const file = path.join(root, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(data, "base64"))
      written.push(file)
    }
    await load(BRIEF, 900, 1200)
    const { data } = await page.send("Page.printToPDF", { printBackground: true, paperWidth: 8.27, paperHeight: 11.69 })
    const brief = path.join(root, "desk/release-brief.pdf")
    fs.writeFileSync(brief, Buffer.from(data, "base64"))
    written.push(brief)
    page.close()
  } finally {
    child.kill("SIGKILL")
  }
  return written
}

let electron = null
/** The live RPC client, so the shutdown at the bottom of the file can reach the server. */
let liveRpc = null

/** Ask realm-server to stop the way the product asks, and wait for the port to actually go quiet. */
async function stopDaemon() {
  if (!liveRpc) return
  await liveRpc.call("daemon.stop", {}).catch(() => null)
  liveRpc.close()
  liveRpc = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await portIsFree(serverPort)) return
    await sleep(250)
  }
  console.warn(`  realm-server is still on ${serverPort} after daemon.stop`)
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(true))
  })
}

async function until(read, timeout, label) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`)
    await sleep(150)
  }
}

function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let id = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        pending.set(requestId, { resolve, reject })
        socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

/**
 * The RPC socket takes a token, and it travels as the WebSocket subprotocol `realm.<token>` — the one
 * channel both `ws` and a browser can set (apps/server/src/rpc/server.ts). realm-server mints it at
 * boot and writes it to `daemon.json` under REALM_HOME, which is the only place it exists.
 */
function connectRpc(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, [`realm.${token}`])
  const pending = new Map()
  let id = 0
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(message.error?.message ?? "RPC failed"))
  })
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    }),
    call(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = String(++id)
        pending.set(requestId, { resolve, reject })
        socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
    close: () => socket.close(),
  }
}

const helpers = String.raw`
window.__capture = window.__capture ?? {
  setInput(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  },
  clickText(selector, text) {
    const element = [...document.querySelectorAll(selector)]
      .find((candidate) => candidate.textContent.trim().startsWith(text));
    if (!element) return false;
    element.click();
    return true;
  },
  /** The app's store, found through React's tree once: the actions a person reaches by dragging. */
  store() {
    if (window.__captureStore) return window.__captureStore;
    const root = document.getElementById("root");
    const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
    const stack = key ? [root[key]] : [];
    for (let n = 0; stack.length && n < 400000; n++) {
      const fiber = stack.pop();
      const value = fiber && fiber.memoizedProps && fiber.memoizedProps.value;
      if (value && typeof value.getState === "function" && typeof value.getState().openItemBeside === "function") return (window.__captureStore = value);
      if (fiber && fiber.sibling) stack.push(fiber.sibling);
      if (fiber && fiber.child) stack.push(fiber.child);
    }
    return null;
  },
  /** A session's row in the sidebar's spaces, never its copy under Needs you. */
  row(title) {
    return [...document.querySelectorAll(".sb-sections .item-row, .sb-section .item-row")]
      .find((row) => !row.closest(".sb-needs") && row.textContent.trim().startsWith(title)) ?? null;
  },
  /** The focused pane's session title. */
  front() {
    return document.querySelector(".panehost .panel[data-focused] .panel-title")?.textContent.trim() ?? null;
  },
  /** What is actually on screen, so a failed expectation names the screen it found instead. */
  onScreen() {
    const overlay = document.querySelector(".page-overlay");
    const panes = [...document.querySelectorAll(".view-main .panel")].map((p) => p.querySelector(".panel-title")?.textContent.trim() ?? "?");
    const side = document.querySelector(".view-panel:not([hidden])");
    return [
      overlay ? "page “" + overlay.getAttribute("aria-label") + "”" : "no page",
      "panes: " + (panes.join(" | ") || "none"),
      side ? "side panel: " + [...side.querySelectorAll("[role=tab]")].map((t) => t.textContent.trim()).join(" | ") : "no side panel",
      document.querySelector(".palette") ? "palette open" : null,
      document.querySelector(".model-picker") ? "model picker open" : null,
      [...document.querySelectorAll("[role=dialog]")].map((d) => d.getAttribute("aria-label") || "(unlabelled)").join(" + ") || null,
    ].filter(Boolean).join("; ");
  },
};
void 0`

function makeContext(page, rpc) {
  const evaluate = async (expression) => {
    const result = await page.send("Runtime.evaluate", {
      expression: `${helpers};\n${expression}`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  /** A real key event through the input pipeline — what the app's keymap listens to. */
  const press = async (key, { code = key, vk, meta = false, shift = false, alt = false } = {}) => {
    const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)
    const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common })
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common })
  }

  const mouse = (type, x, y, modifiers = 0) =>
    page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1, modifiers })

  /** A real press at the middle of the first element `selector` matches: hit-testing included. */
  const click = async (selector, { modifiers = 0 } = {}) => {
    const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
      const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`)
    if (!point) throw new Error(`Nothing on screen matches ${selector}`)
    await mouse("mouseMoved", point[0], point[1])
    await mouse("mousePressed", point[0], point[1], modifiers)
    await mouse("mouseReleased", point[0], point[1], modifiers)
  }

  /**
   * The pointer, put where it lights nothing: the empty middle of the rail, which every layout has.
   * A tooltip comes up a fifth of a second after the pointer arrives, so a capture taken with it
   * still on the last control clicked shows that control's label over the subject.
   */
  const park = (x = 18, y = VIEWPORT.height * 0.6) => mouse("mouseMoved", x, y)

  /** Every finite animation finished, and two frames painted, so a capture is not of a surface on its way in. */
  const settle = () => evaluate(`(async () => {
    const running = document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming?.().endTime));
    await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 2000))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true; })()`)

  /** Put away any page and land on the work — Home is how a person gets back. */
  const home = async () => {
    await evaluate(`(() => { const p = document.querySelector('.model-picker, .palette'); return !p; })()`).then((clear) => (clear ? null : press("Escape", { vk: 27 })))
    if (await evaluate(`!!document.querySelector('.page-overlay')`)) {
      await click('.app-rail .rail-btn[aria-label="Home"]')
      await until(() => evaluate(`!document.querySelector('.page-overlay')`), 8_000, "Home")
    }
  }

  const rail = async (label) => {
    const lit = await evaluate(`document.querySelector('.app-rail .rail-btn[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-pressed') === 'true'`)
    if (!lit) await click(`.app-rail .rail-btn[aria-label=${JSON.stringify(label)}]`)
  }

  /** Open a session from its row in the sidebar, and wait for its pane to take the front. */
  const openSession = async (title) => {
    await home()
    const found = await evaluate(`(() => { const row = __capture.row(${JSON.stringify(title)}); if (!row) return false; row.click(); return true; })()`)
    if (!found) throw new Error(`No sidebar row for “${title}”`)
    await until(() => evaluate(`__capture.front() === ${JSON.stringify(title)}`), 10_000, `“${title}” in front`)
    await sleep(600)
  }

  /**
   * The side panel put away, or brought back — the button at the window's top right does the same.
   *
   * Decided by what is on screen, and only ever undoing a put-away: pressed while the session in
   * front has nothing in the panel, the button opens a blank tab onto the tools' page, and a blank
   * tab is not what any scene here is about.
   */
  const sidePanel = async (shown) => {
    await evaluate(`(() => { const s = __capture.store().getState(); const visible = !!document.querySelector('.view-panel:not([hidden])');
      if (${shown} ? s.sidePanesHidden : visible) s.toggleSidePanes(); return true; })()`)
    await sleep(500)
  }

  /**
   * A tool beside the session in front, the way a person opens one now that the session's bar
   * carries none: the side panel's "+" when it is up, else ⌘⇧B, whose blank tab lists the tools.
   */
  const sideTool = async (label) => {
    const plus = await evaluate(`!!document.querySelector('.view-panel:not([hidden]) .pane-tabs-add')`)
    if (plus) {
      await click(".view-panel:not([hidden]) .pane-tabs-add")
      await until(() => evaluate(`(() => { const row = [...document.querySelectorAll('.menu[aria-label="New tab"] [role^=menuitem]')]
        .find((r) => r.querySelector('.menu-label')?.textContent === ${JSON.stringify(label)}); if (!row) return false; row.click(); return true; })()`), 5_000, `${label} in the + menu`)
    } else {
      await evaluate(`(() => { document.querySelector('.panehost .panel[data-focused]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`)
      await sleep(400)
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press("B", { code: "KeyB", vk: 66, meta: true, shift: true })
      await until(() => evaluate(`(() => { const row = [...document.querySelectorAll('.new-tab-row')]
        .find((r) => r.querySelector('.new-tab-row-label')?.textContent === ${JSON.stringify(label)}); if (!row) return false; row.click(); return true; })()`), 10_000, `${label} on the new tab's page`)
    }
    await sleep(900)
  }

  /** Settings, on one of its pages. */
  const settings = async (label) => {
    if (!(await evaluate(`!!document.querySelector('.settings-page-pane')`))) {
      await home()
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press(",", { code: "Comma", vk: 188, meta: true })
      await until(() => evaluate(`!!document.querySelector('.settings-page-pane')`), 8_000, "Settings")
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const selected = await evaluate(`(() => { const tab = [...document.querySelectorAll('.settings-tab')].find((l) => l.textContent.trim() === ${JSON.stringify(label)});
        if (!tab) return null; if (tab.querySelector('input')?.checked) return true; (tab.querySelector('input') ?? tab).click(); return false; })()`)
      if (selected === null) throw new Error(`Settings has no ${label} page`)
      if (selected) return sleep(900)
      await sleep(400)
    }
    throw new Error(`Settings never opened ${label}`)
  }

  /** A row of the command palette, by the start of its name. */
  const command = async (query, label = query) => {
    await evaluate(`document.activeElement?.blur?.(); true`)
    await press("k", { code: "KeyK", vk: 75, meta: true })
    await until(() => evaluate(`!!document.querySelector('.palette input')`), 8_000, "the command palette")
    await evaluate(`__capture.setInput(document.querySelector('.palette input'), ${JSON.stringify(query)}); true`)
    await until(() => evaluate(`(() => { const hit = [...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}));
      if (!hit) return false; hit.click(); return true; })()`), 8_000, `“${label}” in the palette`)
    await until(() => evaluate(`!document.querySelector('.palette')`), 8_000, "the palette to close")
    await sleep(500)
  }

  /**
   * Scroll `selector` to the middle (or `block`) of the scroller it is in, moved by `offset`.
   *
   * Only that scroller. `scrollIntoView` scrolls every ancestor that can scroll, the pane host
   * among them, and a capture taken after it showed a session with its pane bar scrolled away —
   * a layout no person can reach.
   */
  const reveal = async (selector, block = "center", offset = 0) => {
    const found = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false;
      let s = e.parentElement;
      while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement;
      if (!s) return true;
      const er = e.getBoundingClientRect(), sr = s.getBoundingClientRect();
      const block = ${JSON.stringify(block)};
      const delta = block === "start" ? er.top - sr.top : block === "end" ? er.bottom - sr.bottom : er.top + er.height / 2 - (sr.top + sr.height / 2);
      s.scrollTop += delta + ${offset};
      return true; })()`)
    if (!found) throw new Error(`Nothing on screen matches ${selector}`)
    await sleep(500)
  }

  /** The box around everything `selectors` match, padded and held inside the window. */
  const boxOf = (selectors, pad = 16) => evaluate(`(() => {
    const rects = ${JSON.stringify(selectors)}.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    if (!rects.length) return null;
    const x = Math.max(0, Math.min(...rects.map((r) => r.left)) - ${pad}), y = Math.max(0, Math.min(...rects.map((r) => r.top)) - ${pad});
    const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + ${pad}), bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + ${pad});
    return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) }; })()`)

  /**
   * Write one capture — but only once the screen has proved it is the subject.
   *
   * `expect` is not optional, and that is the point. Four slides once shipped as the same photograph
   * of the code editor: a scene that failed to change screens left the app wherever the last one had
   * put it, the scenes after it waited on a generic `.page` — already satisfied by the page hanging
   * around — and photographed somebody else's subject. A capture asserts the thing its caption will
   * claim, in the same frame it is taken, and a scene that cannot get there fails loudly and drops out
   * of the manifest rather than overwriting a good file with a wrong one.
   *
   * `clip` makes it a crop for a changelog figure, written beside the scenes in `details/`.
   */
  const shot = async (name, expect, { clip = null } = {}) => {
    if (typeof expect !== "string" || !expect.trim()) {
      throw new Error(`shot("${name}") was given no expectation — every capture must prove its subject`)
    }
    await settle()
    await evaluate(`window.__realmScrub?.(); true`)
    await sleep(250)
    if (!(await evaluate(expect))) {
      throw new Error(`${name}: expected ${expect} — on screen instead: ${await evaluate(`__capture.onScreen()`)}`)
    }
    await evaluate(`(() => { document.documentElement.style.background = ${JSON.stringify(PAGE)}; return true; })()`)
    try {
      // A clip's scale multiplies the 2× the window is drawn at, so 1 keeps a crop at the scenes' density.
      const result = await page.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
      const dir = clip ? detailDir : outputDir
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(result.data, "base64"))
    } finally {
      await evaluate(`(() => { document.documentElement.style.background = ""; return true; })()`)
    }
  }

  return { evaluate, press, mouse, click, park, settle, home, rail, openSession, sidePanel, sideTool, settings, command, reveal, boxOf, shot, rpc, sleep, until }
}

/** The sessions the staging makes, by the title the scenes open them with. */
const TITLES = {
  fix: "Fix the org access crash",
  lead: "Dark mode",
  charts: "Release numbers, drawn",
  look: "Pick a look for the settings page",
  lecture: "Turn Tuesday's lecture into a study guide",
  flashcards: "Flashcards for chapter 4",
  quarterly: "Plan the quarterly report",
}

/** The brief the Agents tab's Build with sends — an ordinary message, in the person's words. */
const BUILD_BRIEF = [
  "Build this with sub-agents, one per task below. Start each with agent_start and set constraints.model to the model named for it. Start every one before you wait on any, collect their reports with agent_wait, and then tell me what each one did and anything left to do.",
  "",
  "- GPT-6 Luna: The toggle in Settings ▸ App, and its tests",
  "- Claude Fable 5.1: Storing the choice, with a migration",
  "",
  "The work:",
  "",
  "Add a dark-mode switch to the app settings, and keep the choice across launches.",
].join("\n")

/**
 * Stage a profile's worth of work: four spaces in Personal and one in a second profile, sessions in
 * every state a sidebar can show — waiting on you, working, with news, finished — a delegation in
 * flight, three scheduled tasks and a run, and a Library of files. All of it through the RPC a person's
 * actions go through, and every turn the scripted agent's.
 */
async function stage(ctx) {
  const { rpc, evaluate, until } = ctx
  const [personal] = await rpc.call("profiles.list", {})
  const space = async (name, icon, color, profileId = personal.id) => rpc.call("spaces.create", { profileId, name, icon, color })
  const [realm] = await rpc.call("spaces.list", {})
  const dashboard = await space("Dashboard", "layout", "#38bdf8")
  const site = await space("Site", "globe2", "#3ddc97")
  const school = await space("School", "book", "#ffb454")
  const work = await rpc.call("profiles.create", { name: "Client work", icon: "briefcase", color: "#f59e0b" })
  const atlas = await space("Atlas", "building", "#ff6b8b", work.id)
  const folder = async (s) => (await rpc.call("spaces.list", {})).find((x) => x.id === s.id)?.folderPath ?? s.folderPath

  seedWebApp(await folder(dashboard))
  const siteDir = await folder(site)
  seedSite(siteDir)
  const pictures = await renderPictures(siteDir)
  for (const [name, text] of Object.entries(DESK_FILES)) {
    fs.mkdirSync(path.dirname(path.join(siteDir, name)), { recursive: true })
    fs.writeFileSync(path.join(siteDir, name), text)
  }

  const make = async (s, title, extra = {}) => (await rpc.call("sessions.create", { spaceId: s.id, agentKind: "claude", title, ...extra })).session
  const send = (session, text) => rpc.call("sessions.send", { id: session.id, text, attachments: [], mentions: [] })
  const events = (session) => rpc.call("sessions.events", { id: session.id, afterSeq: 0, limit: 2000 })
  const settled = (session, label) => until(async () => (await rpc.call("sessions.get", { id: session.id })).status === "idle", 60_000, label)

  // A session that read before it changed anything: two turns, so its track has more than one tick,
  // and the second really edits the checkout, so the turn has a card with Review and Undo.
  const fix = await make(dashboard, TITLES.fix, { model: "claude-opus-5-5" })
  await send(fix, "Walk me through how the mapper works, and stream slowly")
  await settled(fix, "the first turn")
  await send(fix, "Please fix the org access crash path")
  await until(async () => (await events(fix)).some((e) => e.event.type === "turn_changes"), 60_000, "the fix's edits")
  await settled(fix, "the fix")
  const firstAsk = (await events(fix)).find((e) => e.event.type === "user_message")
  if (firstAsk) await rpc.call("sessions.setSaved", { id: fix.id, seq: firstAsk.seq, saved: true }).catch((error) => console.warn(`    sessions.setSaved: ${error.message}`))

  const charts = await make(realm, TITLES.charts)
  await send(charts, "Please draw the blocks")
  await until(async () => (await events(charts)).some((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("notes/blocks.md")), 60_000, "the blocks")

  // Work handed to two other models: one sub-agent finishes, the other stops on a permission and
  // stays there, which is what puts it under Needs you.
  const lead = await make(realm, TITLES.lead, { model: "claude-opus-5-5", permissionMode: "default" })
  await send(lead, BUILD_BRIEF)

  // Questions, from this profile and from another one.
  const look = await make(site, TITLES.look)
  await send(look, pictures.length ? "Show me three directions, and ask with pictures" : "Before you start, ask about the release")
  const quarterly = await make(atlas, TITLES.quarterly)
  await send(quarterly, "Before we start, ask who builds each step")

  const flashcards = await make(school, TITLES.flashcards)
  await send(flashcards, "Draft the cards, and stream slowly")
  await make(school, TITLES.lecture)
  await make(school, "Outline the literature review")

  // Three tasks on the clock, each on its own model, and one run already in.
  const schedule = (s, title, goal, cron, constraints) => rpc.call("schedules.create", { spaceId: s.id, title, goal, cron, constraints })
  await schedule(dashboard, "Morning triage", "Read the overnight CI failures and open one issue per distinct cause.", "0 9 * * 1-5", { agentKind: "codex", model: "gpt-6-luna" })
  await schedule(realm, "Dependency sweep", "Check every workspace for outdated dependencies and open one pull request per package.", "0 7 * * 1", { agentKind: "claude", model: "claude-sonnet-5" })
  const weekly = await schedule(site, "Weekly numbers", "Please draw the blocks for this week's numbers: the renderer bundle by release, how a sign-in goes, and where the session store lives.", "0 16 * * 5", { agentKind: "claude", model: "claude-opus-5-5", effort: "high" })
  await rpc.call("schedules.runNow", { id: weekly.id })

  // The Library: the person's own files, added the way Add adds them — a copy each, kept by Realm.
  const desk = [...pictures.filter((p) => !p.includes(`${path.sep}mockups${path.sep}`)), ...Object.keys(DESK_FILES).map((name) => path.join(siteDir, name))]
  if (desk.length) await rpc.call("library.add", { profileId: personal.id, paths: desk }).catch((error) => console.warn(`    library.add: ${error.message}`))

  await rpc.call("memory.setProfile", { profileId: personal.id, doc: "# How I work\n\n- Plain sentences in commits: what changed for the person using it.\n- Tests beside the code they cover, in the style of their neighbours.\n- Ask before anything that deletes or spends.\n" }).catch((error) => console.warn(`    memory.setProfile: ${error.message}`))
  await rpc.call("memory.set", { spaceId: realm.id, doc: "# Realm\n\n- Run `pnpm build` before a live check: the checks boot the built app.\n- Never type into onboarding's session in a harness; its engine is real.\n- Commit by path, never `git add -A`.\n" }).catch((error) => console.warn(`    memory.set: ${error.message}`))
  for (const script of [
    { id: null, name: "Test", command: "pnpm -r test", cwd: null },
    { id: null, name: "Typecheck", command: "pnpm -r typecheck", cwd: null },
    { id: null, name: "Dev server", command: "pnpm dev --port 3100", cwd: null },
  ]) await rpc.call("scripts.save", { spaceId: realm.id, script }).catch((error) => console.warn(`    scripts.save ${script.name}: ${error.message}`))

  await until(async () => {
    const all = await rpc.call("sessions.listAll", { profileId: null })
    const waiting = all.filter((s) => s.status === "waiting_permission").length
    return waiting >= 3
  }, 60_000, "the questions and the sub-agent's permission to be waiting").catch((error) => console.warn(`    ${error.message}`))
  await until(async () => (await rpc.call("runs.list", { spaceId: site.id, scheduleId: weekly.id })).runs?.[0]?.state === "succeeded", 60_000, "the weekly run").catch((error) => console.warn(`    ${error.message}`))
  return { personal, realm, dashboard, site, school, atlas, sessions: { fix, charts, lead, look, quarterly, flashcards } }
}

/**
 * The scenes, in capture order. Each starts from wherever the last one left the app, so each opens
 * its own surface first (`openSession`, `rail`, `settings`) rather than trusting what is in front.
 * `content/features.ts` orders the carousel; this list only orders the capture.
 */
const scenes = [
  {
    // Every space at once, under Needs you: questions from this profile and another, a sub-agent
    // stopped on a permission, a lecture being worked on and a session with news.
    name: "sidebar",
    async run({ evaluate, openSession, park, shot, rpc, until, boxOf }, staged) {
      const lecture = (await rpc.call("sessions.listAll", { profileId: null })).find((s) => s.title === TITLES.lecture)
      if (lecture) await rpc.call("sessions.send", { id: lecture.id, text: "keep working", attachments: [], mentions: [] }).catch(() => null)
      await openSession(TITLES.fix)
      await until(() => evaluate(`document.querySelectorAll('.sb-needs .item-row').length >= 3`), 15_000, "three rows under Needs you")
      await until(() => evaluate(`!!document.querySelector('.sb-section .status-dot[data-status="running"]')`), 15_000, "a session working").catch(() => null)
      await park()
      const expect = `document.querySelectorAll('.sb-needs .item-row').length >= 3 && document.querySelectorAll('.sb-section').length >= 4 && !!document.querySelector('.transcript')`
      await shot("sidebar", expect)
      await shot("sidebar", expect, { clip: { x: 0, y: 0, width: 700, height: 600 } })
    },
  },
  {
    // A transcript that says when, and what each turn changed: the ask, the reply, its Edited 2 files
    // card with Review and Undo, and the track down the pane's left edge, a tick per prompt. The
    // sidebar is folded away (⌘B), so the transcript is the subject rather than a repeat of the last.
    name: "session",
    async run({ evaluate, openSession, sidePanel, press, reveal, park, shot, boxOf, mouse, until, sleep }) {
      await openSession(TITLES.fix)
      await sidePanel(false)
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press("b", { code: "KeyB", vk: 66, meta: true })
      await until(() => evaluate(`!!document.querySelector('.sidebar[data-collapsed]')`), 5_000, "the sidebar folded")
      await sleep(600)
      await reveal(".session-pane .edit-summary", "end", 40)
      await park()
      const expect = `!!document.querySelector('.session-pane .edit-summary') && document.querySelector('.session-pane .edit-summary-title')?.textContent.startsWith('Edited 2 files') && !!document.querySelector('.sidebar[data-collapsed]')`
      await shot("session", expect)
      // The track's card, for the changelog: what was asked, how the answer began, what the turn edited.
      const tick = await evaluate(`(() => { const ticks = [...document.querySelectorAll('.view-main .panel .scroll-track .track-tick')]; const t = ticks.at(-1);
        if (!t) return null; const r = t.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`)
      if (tick) {
        await mouse("mouseMoved", tick[0], tick[1])
        await sleep(900)
        const card = await boxOf([".track-card[data-open]"], 0)
        if (card) await shot("track", `!!document.querySelector('.track-card[data-open]')`, { clip: { x: Math.max(0, Math.round(tick[0]) - 60), y: Math.max(0, card.y - 70), width: Math.min(760, card.x + card.width + 24 - Math.max(0, Math.round(tick[0]) - 60)), height: Math.min(VIEWPORT.height, card.height + 140) } })
      }
      await park()
      await press("b", { code: "KeyB", vk: 66, meta: true })
      await until(() => evaluate(`!document.querySelector('.sidebar[data-collapsed]')`), 5_000, "the sidebar back")
      await sidePanel(true)
    },
  },
  {
    // The picker on a session that has not started, so every harness's models are offered: Opus 5.5
    // picked, the level at Max — which lights the track — and fast mode on.
    name: "models",
    async run({ evaluate, openSession, click, press, park, shot, boxOf, until, sleep }) {
      await openSession("New session")
      await click('.composer button[aria-label="Model"]')
      await until(() => evaluate(`(() => { const p = document.querySelector('.model-picker'); return !!p && getComputedStyle(p).visibility === 'visible'; })()`), 8_000, "the model picker")
      await sleep(400)
      await click('.model-picker .mp-row[aria-label="Claude Opus 5.5"]')
      await until(() => evaluate(`document.querySelector('.mp-run-model')?.textContent.includes('Opus 5.5')`), 5_000, "Opus 5.5 picked")
      await evaluate(`(() => { const s = document.querySelector('.model-picker [role=slider]'); s.focus(); return document.activeElement === s; })()`)
      await press("End", { vk: 35 })
      await until(() => evaluate(`document.querySelector('.mp-run-level')?.textContent === 'Max'`), 5_000, "Max")
      if (!(await evaluate(`document.querySelector('.mp-bolt')?.getAttribute('aria-pressed') === 'true'`))) await click(".mp-bolt")
      await until(() => evaluate(`document.querySelector('.mp-bolt')?.getAttribute('aria-pressed') === 'true'`), 5_000, "fast mode on")
      await park()
      await sleep(900)
      const expect = `!!document.querySelector('.model-picker .mp-track-core') && document.querySelector('.mp-run-level')?.textContent === 'Max' && document.querySelectorAll('.mp-group').length >= 2`
      await shot("models", expect)
      const box = await boxOf([".model-picker", '.composer button[aria-label="Model"]'], 20)
      if (box) await shot("model-picker", expect, { clip: box })
      await press("Escape", { vk: 27 })
      await sleep(400)
    },
  },
  {
    // One card for every agent's questions: the options Realm draws from what the agent named — here
    // three pictures in the space's own folder, as tiles.
    name: "questions",
    async run({ evaluate, openSession, reveal, park, shot, boxOf, until }) {
      await openSession(TITLES.look)
      await until(() => evaluate(`!!document.querySelector('.question-card')`), 15_000, "the question card")
      await until(() => evaluate(`[...document.querySelectorAll('.question-card img')].every((img) => img.complete && img.naturalWidth > 0)`), 10_000, "its pictures").catch(() => null)
      await reveal(".question-card", "center")
      await park()
      const expect = `!!document.querySelector('.question-card') && document.querySelector('.question-card')?.textContent.includes('asks')`
      await shot("questions", expect)
      const box = await boxOf([".question-card"], 20)
      if (box) await shot("question-card", expect, { clip: box })
    },
  },
  {
    // A reply that carries a chart, a diagram and a comparison, drawn once their fences closed.
    name: "blocks",
    async run({ evaluate, openSession, sidePanel, reveal, park, shot, boxOf, sleep }) {
      await openSession(TITLES.charts)
      await sidePanel(false)
      await reveal('.session-pane .ui-block[data-kind="chart"]', "start", -110)
      await park()
      const expect = `!!document.querySelector('.session-pane .ui-block[data-kind="chart"] svg') && !!document.querySelector('.session-pane .ui-block[data-kind="diagram"] svg')`
      await shot("blocks", expect)
      const chart = await boxOf(['.session-pane .ui-block[data-kind="chart"]'], 20)
      if (chart) await shot("chart", expect, { clip: chart })
      await reveal('.session-pane .ui-block[data-kind="compare"]', "center")
      const compare = await boxOf(['.session-pane .ui-block[data-kind="compare"]'], 20)
      if (compare) await shot("compare", `!!document.querySelector('.session-pane .ui-block[data-kind="compare"]')`, { clip: compare })
      await sidePanel(true)
    },
  },
  {
    // Work handed to other models: the lead's sub-agents in its Agents tab, one finished with its
    // report and one waiting on you, and the quiet line each is in the lead's transcript.
    name: "delegation",
    async run({ evaluate, openSession, sidePanel, sideTool, park, shot, boxOf, until }) {
      await openSession(TITLES.lead)
      await sidePanel(true)
      const shown = await evaluate(`[...document.querySelectorAll('.view-panel:not([hidden]) [role=tab]')].some((t) => t.textContent.trim() === 'Agents')`)
      if (shown) await evaluate(`(() => { [...document.querySelectorAll('.view-panel:not([hidden]) [role=tab]')].find((t) => t.textContent.trim() === 'Agents').click(); return true; })()`)
      else await sideTool("Agents")
      await until(() => evaluate(`(() => { const s = [...document.querySelectorAll('.subagent')].map((li) => li.dataset.state); return s.includes('done') && s.includes('waiting'); })()`), 40_000, "one sub-agent done and one waiting")
      await until(() => evaluate(`[...document.querySelectorAll('.delegation-line .tool-row')].some((r) => r.textContent.startsWith('Subagent finished'))`), 15_000, "the lead's line for the finished one")
      await park()
      const expect = `document.querySelectorAll('.view-panel:not([hidden]) .subagent').length === 2 && [...document.querySelectorAll('.delegation-line .tool-row')].some((r) => r.textContent.startsWith('Subagent finished'))`
      await shot("delegation", expect)
      // The cards and the count over them.
      const box = await boxOf([".view-panel:not([hidden]) .subagent"], 20)
      if (box) await shot("sub-agents", expect, { clip: { ...box, y: Math.max(0, box.y - 32), height: box.height + 32 } })
    },
  },
  {
    // The workspace: a session and, in the side panel, the file its answer named — opened beside it
    // at the line the answer gave.
    name: "workspace",
    async run({ evaluate, openSession, sidePanel, click, reveal, park, shot, boxOf, until, sleep }) {
      await openSession(TITLES.fix)
      await sidePanel(true)
      await reveal('.session-pane .md-file[data-file$="web/lib/orgs.ts"]', "center")
      await click('.session-pane .md-file[data-file$="web/lib/orgs.ts"]')
      await until(() => evaluate(`!!document.querySelector('.view-panel:not([hidden]) .documents-code .cm-content')`), 15_000, "orgs.ts beside the session")
      await sleep(800)
      await reveal(".session-pane .edit-summary", "end", 40)
      await park()
      const expect = `!!document.querySelector('.view-panel:not([hidden]) .documents-code .cm-content') && !!document.querySelector('.view-main .transcript') && !document.querySelector('.page-overlay')`
      await shot("workspace", expect)
      // The turn's card for the changelog, from this narrower pane, where the card and the answer
      // above it fit a reading column.
      const card = await boxOf([".view-main .session-pane .edit-summary"], 0)
      if (card) await shot("edited-files", expect, { clip: { x: Math.max(0, card.x - 24), y: Math.max(0, card.y - 330), width: card.width + 48, height: Math.min(VIEWPORT.height - Math.max(0, card.y - 330), card.height + 354) } })
    },
  },
  {
    // A terminal's tab says what is running in it: vim, in the session's own terminal, on the file the
    // turn edited. The shell is a clean one (the run's own ZDOTDIR), so nobody's dotfiles are in it.
    name: "terminal",
    async run({ evaluate, openSession, sidePanel, press, park, shot, rpc, until, sleep }) {
      await openSession(TITLES.fix)
      await sidePanel(true)
      await evaluate(`(() => { document.querySelector('.panehost .panel[data-focused]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`)
      await sleep(400)
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press("j", { code: "KeyJ", vk: 74, meta: true })
      await until(() => evaluate(`!!document.querySelector('.view-panel:not([hidden]) .xterm')`), 20_000, "the session's terminal")
      const terminal = (await rpc.call("items.listAll", {})).filter((item) => item.kind === "terminal").at(-1)
      if (!terminal) throw new Error("No terminal item to write to")
      // No vimrc and no viminfo, so nothing of anybody's is read or written; the function the turn
      // rewrote in the middle of the screen. Coloured as JavaScript: vim's TypeScript syntax blew its
      // redraw budget on this file's `async function` line even at ten seconds, and switched the
      // highlighting off halfway down the screen with a message across its foot.
      await rpc.call("terminals.write", { terminalId: terminal.refId, data: "clear; vim -u NONE -i NONE -N -n --cmd 'set bg=dark' --cmd 'syntax on' -c 'set ft=javascript number laststatus=2 ruler linebreak breakindent' -c 'normal! 62Gzt81G' web/lib/orgs.ts\r" })
      await until(async () => (await rpc.call("terminals.programs", {}).catch(() => ({})))[terminal.refId]?.id === "editor", 15_000, "vim in the foreground")
      await until(async () => (await rpc.call("terminals.read", { terminalId: terminal.refId, cursor: null }).catch(() => null))?.live.includes("withInviteDefaults"), 30_000, "vim's screen drawn")
      await sleep(1200)
      await park()
      await shot("terminal", `!!document.querySelector('.view-panel:not([hidden]) .xterm') && [...document.querySelectorAll('.view-panel:not([hidden]) [role=tab]')].some((t) => t.textContent.includes('vim'))`)
      await rpc.call("terminals.write", { terminalId: terminal.refId, data: "\x1b:qa!\r" }).catch(() => null)
    },
  },
  {
    // As many panes as there is room for, beside one side panel: two sessions with the sidebar folded
    // away, and the panel holding both sessions' tabs, a hairline between the runs.
    name: "splits",
    async run({ evaluate, openSession, sidePanel, press, park, shot, rpc, until, sleep }, staged) {
      await openSession(TITLES.fix)
      await sidePanel(true)
      const item = (await rpc.call("items.listAll", {})).find((i) => i.kind === "session" && i.refId === staged.sessions.lead.id)?.id
      if (!item) throw new Error(`No item for “${TITLES.lead}”`)
      await evaluate(`(() => { __capture.store().getState().openItemBeside(${JSON.stringify(item)}); return true; })()`)
      await until(() => evaluate(`document.querySelectorAll('.view-main .panel').length === 2`), 10_000, "two panes")
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press("b", { code: "KeyB", vk: 66, meta: true })
      await until(() => evaluate(`!!document.querySelector('.sidebar[data-collapsed]')`), 5_000, "the sidebar folded")
      await evaluate(`(() => { __capture.store().getState().resizePanel(0.34, { commit: true }); return true; })()`)
      await sleep(600)
      // The lead's Agents tab in front: the strip then holds both sessions' runs of tabs.
      await evaluate(`(() => { [...document.querySelectorAll('.view-panel:not([hidden]) [role=tab]')].find((t) => t.textContent.trim() === 'Agents')?.click(); return true; })()`)
      await sleep(700)
      await park()
      await shot("splits", `document.querySelectorAll('.view-main .panel').length === 2 && !!document.querySelector('.view-panel:not([hidden])') && !!document.querySelector('.sidebar[data-collapsed]')`)
      // Back to one pane and the sidebar: the pane leaves the split it shares, as ⌘W does.
      await evaluate(`(() => { const s = __capture.store().getState(); const walk = (n, out = []) => { if (!n) return out; if (n.type === 'leaf') out.push(n); else n.children.forEach((c) => walk(c, out)); return out; };
        const extra = walk(s.layout).find((l) => l.itemId === ${JSON.stringify(item)} || (l.tabs ?? []).includes(${JSON.stringify(item)})); if (extra) s.closeInPane(extra.id); return true; })()`)
      await sleep(600)
      await evaluate(`(() => { __capture.store().getState().resizePanel(0.5, { commit: true }); return true; })()`)
      await press("b", { code: "KeyB", vk: 66, meta: true })
      await until(() => evaluate(`!document.querySelector('.sidebar[data-collapsed]')`), 5_000, "the sidebar back")
      await sleep(500)
    },
  },
  {
    // A pull request read and reviewed in Realm: its summary, and the findings of a reviewer run on
    // the model chosen — none of which reaches GitHub until Submit review.
    name: "review",
    async run({ evaluate, home, rail, park, shot, boxOf, until, sleep }) {
      await home()
      await rail("Code review")
      await until(() => evaluate(`document.querySelectorAll('.cr-row').length >= 6`), 15_000, "the pull requests")
      await evaluate(`(() => { const r = [...document.querySelectorAll('.cr-row')].find((x) => x.querySelector('.cr-row-title')?.textContent.includes('Stream the tokenizer')); r.click(); return true; })()`)
      await until(() => evaluate(`document.querySelector('.cr-title')?.textContent.includes('Stream the tokenizer')`), 10_000, "the tokenizer request")
      if (!(await evaluate(`!!document.querySelector('.cr-review[data-state=done]')`))) {
        await evaluate(`(() => { document.querySelector('.cr-review-with > button.cr-review-run').click(); return true; })()`)
        await until(() => evaluate(`!!document.querySelector('.cr-review[data-state=done]') && document.querySelectorAll('.cr-finding').length >= 3`), 60_000, "the reviewer's findings")
      }
      await sleep(600)
      await park()
      const expect = `!!document.querySelector('.code-review-page') && document.querySelectorAll('.cr-finding').length >= 3`
      await shot("review", expect)
      const box = await boxOf([".cr-review"], 16)
      if (box) await shot("review-findings", expect, { clip: box })
      await home()
    },
  },
  {
    // Scheduled tasks as a page: the column of tasks with their models, a run open as its own session,
    // and the task's card at the top right.
    name: "schedules",
    async run({ evaluate, home, rail, park, shot, until, sleep }) {
      await home()
      await rail("Scheduled tasks")
      await until(() => evaluate(`document.querySelectorAll('.sched-task').length >= 3`), 15_000, "the tasks")
      await evaluate(`(() => { const t = [...document.querySelectorAll('.sched-task')].find((x) => x.querySelector('.sched-task-name')?.textContent.includes('Weekly numbers')); t.querySelector('.sched-task-hit').click(); return true; })()`)
      await until(() => evaluate(`!!document.querySelector('.sched-run')`), 10_000, "the weekly run")
      await evaluate(`(() => { document.querySelector('.sched-run').click(); return true; })()`)
      await until(() => evaluate(`!!document.querySelector('.sched-view .ui-block') && !!document.querySelector('.sched-card')`), 15_000, "the run and its card")
      await evaluate(`(() => { for (const s of document.querySelectorAll('.sched-view [data-dissolve], .sched-view .transcript-wrap')) s.scrollTop = 0; return true; })()`)
      await sleep(600)
      await park()
      await shot("schedules", `!!document.querySelector('.schedules-page') && !!document.querySelector('.sched-card') && document.querySelectorAll('.sched-task').length >= 3`)
      await home()
    },
  },
  {
    // The Library's files: tabs for the kind of file, every file one square tile, a picture filling its own.
    name: "library",
    async run({ evaluate, home, rail, park, shot, until, sleep }) {
      await home()
      await rail("Library")
      await until(() => evaluate(`!!document.querySelector('.library-add')`), 10_000, "the Library's files")
      await until(() => evaluate(`document.querySelectorAll('.library-tile').length >= 6`), 15_000, "its tiles").catch(() => null)
      await until(() => evaluate(`[...document.querySelectorAll('.library-tile[data-thumb] img')].every((img) => img.complete && img.naturalWidth > 0)`), 15_000, "the pictures in the tiles").catch(() => null)
      await sleep(600)
      await park()
      await shot("library", `!!document.querySelector('.library-page-pane .library-types') && document.querySelectorAll('.library-tile').length >= 6`)
    },
  },
  {
    // Memory is the document itself, at reading size, with Write and Preview.
    name: "memory",
    async run({ evaluate, rail, park, shot, until, sleep }) {
      await rail("Library")
      await evaluate(`(() => { const t = [...document.querySelectorAll('.page-rail-tab')].find((x) => x.textContent.trim().startsWith('Memory')); (t?.querySelector('input') ?? t)?.click(); return !!t; })()`)
      await until(() => evaluate(`!!document.querySelector('.library-page-pane') && [...document.querySelectorAll('.library-page-pane h1, .page-title h1')].some((h) => h.textContent.trim() === 'Memory')`), 10_000, "Memory")
      await sleep(900)
      await park()
      await shot("memory", `[...document.querySelectorAll('.page-title h1')].some((h) => h.textContent.trim() === 'Memory')`)
    },
  },
  {
    // Connections takes the whole width right of the rail: it has no use for the spaces beside it.
    name: "connections",
    async run({ evaluate, home, rail, park, shot, until, sleep }) {
      await home()
      await rail("Connections")
      await until(() => evaluate(`!!document.querySelector('.connections-page-pane')`), 10_000, "Connections")
      await sleep(900)
      await park()
      await shot("connections", `!!document.querySelector('.connections-page-pane') && !!document.querySelector('.page-overlay')`)
      await home()
    },
  },
  {
    // The Documents pane opens on a home: what this session made and was given, then the Library's.
    name: "documents",
    async run({ evaluate, openSession, sidePanel, sideTool, park, shot, until, sleep }) {
      await openSession(TITLES.fix)
      await sidePanel(true)
      const tab = await evaluate(`(() => { const t = [...document.querySelectorAll('.view-panel:not([hidden]) [role=tab]')].find((x) => x.textContent.trim().startsWith('Documents')); t?.click(); return !!t; })()`)
      if (!tab) await sideTool("Documents")
      await sleep(600)
      await evaluate(`(() => { document.querySelector('.view-panel:not([hidden]) .documents-home-tab button')?.click(); return true; })()`)
      await until(() => evaluate(`!!document.querySelector('.view-panel:not([hidden]) .docs-home') && document.querySelectorAll('.view-panel:not([hidden]) .docs-home-row').length >= 3`), 10_000, "the documents home")
      await sleep(700)
      await park()
      await shot("documents", `!!document.querySelector('.view-panel:not([hidden]) .docs-home') && document.querySelectorAll('.view-panel:not([hidden]) .docs-home-row').length >= 3`)
    },
  },
  {
    // Settings ▸ Appearance, at the app icons: the new icon and the eight the Dock can wear instead.
    name: "appearance",
    async run({ settings, reveal, park, shot, boxOf, sleep }) {
      await settings("Appearance")
      await reveal('.settings-page-pane [data-setting="app-icon"]', "start", -60)
      await sleep(300)
      await park()
      const expect = `!!document.querySelector('.settings-page-pane [data-setting="app-icon"]') && [...document.querySelectorAll('.settings-page-pane [data-setting="app-icon"] img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 9`
      await shot("appearance", expect)
      const icons = await boxOf(['.settings-page-pane [data-setting="app-icon"]'], 20)
      if (icons) await shot("app-icons", expect, { clip: icons })
    },
  },
  {
    name: "keys",
    async run({ evaluate, settings, park, shot, until }) {
      await settings("Keys")
      await until(() => evaluate(`document.querySelectorAll('.settings-page-pane kbd, .settings-page-pane .keycap').length > 6`), 15_000, "the shortcut list").catch(() => null)
      await park()
      await shot("keys", `!!document.querySelector('.settings-page-pane') && document.querySelector('.settings-page-pane .page-title h1, .settings-page-pane h1')?.textContent.trim() === 'Keys'`)
    },
  },
  {
    // A space's settings, at its sandbox: the three postures it can take, on the one it ships with.
    name: "sandbox",
    async run({ evaluate, home, park, shot, until, sleep }, staged) {
      await home()
      await evaluate(`(() => { __capture.store().getState().openSpacePage(${JSON.stringify(staged.realm.id)}, "sandbox"); return true; })()`)
      await until(() => evaluate(`!!document.querySelector('.space-page-pane')`), 10_000, "the space's page")
      await evaluate(`(() => { const t = [...document.querySelectorAll('.page-rail-tab')].find((x) => x.textContent.trim() === 'Sandbox'); (t?.querySelector('input') ?? t)?.click(); return !!t; })()`)
      await until(() => evaluate(`!!document.querySelector('.sandbox-choice')`), 10_000, "the sandbox postures")
      await sleep(700)
      await park()
      await shot("sandbox", `!!document.querySelector('.space-page-pane') && !!document.querySelector('.sandbox-choice')`)
    },
  },
  {
    // The commands a space owns: its scripts, each a named shell line started in a terminal.
    name: "commands",
    async run({ evaluate, park, shot, until, sleep }) {
      await evaluate(`(() => { const t = [...document.querySelectorAll('.page-rail-tab')].find((x) => x.textContent.trim() === 'Scripts'); (t?.querySelector('input') ?? t)?.click(); return !!t; })()`)
      await until(() => evaluate(`!!document.querySelector('.space-page-pane') && document.querySelectorAll('.space-page-pane .settings-row').length >= 3`), 10_000, "the scripts")
      await sleep(700)
      await park()
      await shot("commands", `!!document.querySelector('.space-page-pane') && document.querySelectorAll('.space-page-pane .settings-row').length >= 3`)
    },
  },
  {
    // ⌘K: what is open, then every space's sessions, by when they last moved.
    name: "palette",
    async run({ evaluate, openSession, press, park, shot, until, sleep }) {
      await openSession(TITLES.fix)
      await evaluate(`document.activeElement?.blur?.(); true`)
      await press("k", { code: "KeyK", vk: 75, meta: true })
      await until(() => evaluate(`document.querySelectorAll('.palette-list [role=option]').length > 4`), 8_000, "the command palette")
      await sleep(500)
      await park(VIEWPORT.width * 0.1, VIEWPORT.height * 0.9)
      await shot("palette", `document.querySelectorAll('.palette-list [role=option]').length > 4`)
      await press("Escape", { vk: 27 })
      await sleep(300)
    },
  },
  {
    // New space asks what the space is: a name, its icon and colours, then one card of the rest.
    name: "new-space",
    async run({ evaluate, home, click, press, park, shot, until, sleep }) {
      await home()
      await click(".sb-new-space")
      await until(() => evaluate(`!!document.querySelector('[role="dialog"][aria-label="New space"]')`), 8_000, "the New space sheet")
      await sleep(500)
      await evaluate(`(() => { const i = document.querySelector('[role="dialog"][aria-label="New space"] input[aria-label="Space name"]'); __capture.setInput(i, 'Garden journal'); return true; })()`)
      // Its icon and its colour, picked the way the sheet offers them.
      await click('[role="dialog"][aria-label="New space"] .space-tile')
      await until(() => evaluate(`!!document.querySelector('.icon-picker input')`), 5_000, "the icon picker").then(async () => {
        await evaluate(`(() => { __capture.setInput(document.querySelector('.icon-picker input'), 'leaf'); return true; })()`)
        await until(() => evaluate(`!!document.querySelector('.icon-picker [aria-label="Icon leaf"]')`), 5_000, "the leaf")
        await click('.icon-picker [aria-label="Icon leaf"]')
      }).catch((error) => console.warn(`    the space's icon: ${error.message}`))
      await sleep(400)
      await evaluate(`(() => { document.querySelector('[role="dialog"][aria-label="New space"] [role="radio"][aria-label="Color #3ddc97"]')?.click(); return true; })()`)
      await sleep(600)
      await park(VIEWPORT.width * 0.1, VIEWPORT.height * 0.9)
      await shot("new-space", `!!document.querySelector('[role="dialog"][aria-label="New space"]') && document.querySelector('[role="dialog"][aria-label="New space"] input[aria-label="Space name"]')?.value === 'Garden journal'`)
      await press("Escape", { vk: 27 })
      await until(() => evaluate(`!document.querySelector('[role="dialog"][aria-label="New space"]')`), 5_000, "the sheet to close").catch(() => null)
    },
  },
  {
    // The sidebar's activity lens: the same sessions by when they last moved.
    name: "activity",
    async run({ evaluate, openSession, click, park, shot, until, sleep }) {
      await openSession(TITLES.fix)
      await click('.sb-lens button[aria-label="Activity"]')
      await until(() => evaluate(`document.querySelector('.sb-lens button[aria-label="Activity"]')?.getAttribute('aria-pressed') === 'true'`), 5_000, "the activity lens")
      await sleep(800)
      await park()
      await shot("activity", `document.querySelector('.sb-lens button[aria-label="Activity"]')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('.transcript')`)
      await click('.sb-lens button[aria-label="Activity"]')
      await sleep(500)
    },
  },
  {
    // Profiles: the switcher, where a profile can also open in a window of its own.
    name: "profiles",
    async run({ evaluate, openSession, click, park, shot, until, sleep }) {
      await openSession(TITLES.fix)
      await click('.sb-header button[aria-label^="Profile"], .sidebar button[aria-label^="Profile:"]')
      await until(() => evaluate(`!!document.querySelector('.menu [role^=menuitem]')`), 5_000, "the profile switcher")
      await sleep(500)
      await park(VIEWPORT.width * 0.62, VIEWPORT.height * 0.6)
      await shot("profiles", `[...document.querySelectorAll('.menu [role^=menuitem]')].some((m) => m.textContent.includes('Client work'))`)
      await evaluate(`(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`)
      await sleep(400)
    },
  },
]

async function main() {
  for (const port of [cdpPort, serverPort]) {
    if (!(await portIsFree(port))) throw new Error(`Port ${port} is in use`)
  }

  // A fake gh, signed in, answering from the Code review fixture — so the page lists, opens and
  // reviews the same pull requests every run, and nothing reaches GitHub.
  const { buildFixture } = await import(pathToFileURL(path.join(repoRoot, "apps/server/scripts/fixtures/code-review-fixture.mjs")).href)
  const ghDir = path.join(scratch, "gh")
  fs.mkdirSync(ghDir, { recursive: true })
  fs.writeFileSync(path.join(ghDir, "fixture.json"), JSON.stringify({ ...buildFixture(), auth: "ready" }))
  const ghBin = path.join(ghDir, "gh")
  fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${path.join(ghDir, "fixture.json")}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`)
  fs.chmodSync(ghBin, 0o755)

  const wrapper = path.join(scratch, "wrapper.mjs")
  fs.writeFileSync(
    wrapper,
    [
      'import { app } from "electron";',
      'app.setPath("userData", process.env.REALM_CAPTURE_USER_DATA);',
      "await import(process.env.REALM_CAPTURE_MAIN);",
    ].join("\n"),
  )

  const electronBinary =
    process.platform === "darwin"
      ? path.join(
          repoRoot,
          "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        )
      : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron")

  // The terminals' shell is a clean zsh: its dotfiles are this run's, so the captures show nobody's
  // prompt and nothing typed into them reaches anybody's history.
  const zdot = path.join(scratch, "zsh")
  fs.mkdirSync(zdot, { recursive: true })
  fs.writeFileSync(path.join(zdot, ".zshrc"), "PS1='%1~ %# '\nunset HISTFILE\n")

  // The window opens behind whatever has the person's attention, and Chromium stops laying out a
  // covered window; the first three switches keep it drawing. The last renders in sRGB whatever
  // display the window lands on: left to the display, a capture carries that display's own profile,
  // and the same scene came out vivid from one screen and washed out from the Mac's P3 panel.
  electron = spawn(electronBinary, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--force-color-profile=srgb"], {
    env: {
      ...process.env,
      SHELL: "/bin/zsh",
      ZDOTDIR: zdot,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_HTML_MENUS: "1",
      REALM_GH_BIN: ghBin,
      REALM_PORT: String(serverPort),
      REALM_DEVTOOLS_PORT: String(cdpPort),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_CAPTURE_USER_DATA: path.join(scratch, "userData"),
      REALM_CAPTURE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  })

  const targets = () =>
    fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      .then((response) => response.json())
      .catch(() => [])
  const attach = async () => {
    const target = await until(
      async () => (await targets()).find((candidate) => candidate.type === "page" && candidate.url.startsWith("file://")),
      40_000,
      "the renderer",
    )
    const page = connectCdp(target.webSocketDebuggerUrl)
    await page.ready
    await page.send("Runtime.enable")
    await page.send("Page.enable")
    await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false })
    // A window that is not in front greys its accent and goes quiet. Focus is emulated and the two
    // marks held off, so what is captured is the app as the person at the Mac sees it.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    return page
  }
  const awake = `(() => { const r = document.documentElement; const clear = () => { r.removeAttribute("data-window-inactive"); r.removeAttribute("data-quiet"); };
    clear(); if (!window.__captureAwake) { window.__captureAwake = new MutationObserver(clear); window.__captureAwake.observe(r, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] }); } return true; })()`

  let page = await attach()
  const token = await until(
    () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")).token ?? null
      } catch {
        return null
      }
    },
    20_000,
    "realm-server's token",
  )
  const rpc = connectRpc(serverPort, token)
  await rpc.ready
  liveRpc = rpc
  let ctx = makeContext(page, rpc)
  const only = (process.env.REALM_CAPTURE_ONLY ?? "").split(",").map((n) => n.trim()).filter(Boolean)
  const captured = []

  // The person's name and the machine's are the developer's; the site is not the place to publish
  // either. The store's copies go first — the greeting and the rail read them — and an observer
  // keeps the rest scrubbed: the composer's understrip redraws on its own and brings a name back,
  // and a path through the scratch home reads as Realm's own folder. Installed again after the
  // reload below, which takes both with it.
  const system = await rpc.call("system.info", {}).catch(() => null)
  const swaps = [
    [home, "~/Realm"],
    [os.homedir(), "~"],
    ...(system?.machineName ? [[system.machineName, "MacBook Pro"]] : []),
  ]
  const scrub = async () => {
    await until(() => ctx.evaluate(`!!__capture.store()`), 10_000, "the app's store")
    await ctx.evaluate(`(() => { __capture.store().setState({ userName: "", machineName: "MacBook Pro" }); return true; })()`)
    await ctx.evaluate(`(() => {
      const swaps = ${JSON.stringify(swaps)};
      const swap = (text) => swaps.reduce((t, [from, to]) => (t.includes(from) ? t.split(from).join(to) : t), text);
      const scrub = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const next = swap(node.nodeValue);
          if (next !== node.nodeValue) node.nodeValue = next;
        }
        for (const element of document.querySelectorAll('[title]')) {
          const title = element.getAttribute('title');
          const next = swap(title);
          if (next !== title) element.setAttribute('title', next);
        }
      };
      window.__realmScrub = scrub;
      new MutationObserver(scrub).observe(document.body, { subtree: true, childList: true, characterData: true });
      scrub();
      return true;
    })()`)
  }

  // ---- first run: the one page, before there is a space -------------------------------------
  await until(() => ctx.evaluate(`!!document.querySelector('.onboarding input:not([type=radio])')`), 40_000, "onboarding")
  await ctx.evaluate(awake)
  await scrub()
  if (!only.length || only.includes("onboarding")) {
    try {
      // The cards are probed ahead of the agents behind the fold; a capture of "Checking…" is not first run.
      await until(() => ctx.evaluate(`!![...document.querySelectorAll('.agent-card-status')].length && ![...document.querySelectorAll('.agent-card-status')].some((e) => e.textContent.includes('Checking'))`), 45_000, "the agents probed")
      await ctx.evaluate(`(() => { __capture.setInput(document.querySelector('.onboarding input:not([type=radio])'), 'Realm'); return true; })()`)
      await sleep(700)
      await ctx.park()
      await ctx.shot("onboarding", `!!document.querySelector('.app[data-first-run] .agent-card') && document.querySelector('.onboarding input:not([type=radio])')?.value === 'Realm'`)
      captured.push("onboarding")
      console.log("  ✓ onboarding")
    } catch (error) {
      console.warn(`  ✗ onboarding — ${error.message}`)
    }
  }
  await ctx.evaluate(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __capture.setInput(input, 'Realm');
    input.closest('form').requestSubmit();
    return true;
  })()`)
  await until(() => ctx.evaluate(`!!document.querySelector('.composer')`), 30_000, "the first session")

  // ---- stage ---------------------------------------------------------------------------------
  // Dark, whatever this Mac is set to: the site is dark, and every capture is laid on its page.
  await rpc.call("settings.set", { key: "ui.theme", value: "dark" })
  // The last agent used is what Code review's reviewer and a fresh prompter take.
  await rpc.call("settings.set", { key: "ui.lastAgentKind", value: "claude" })
  // What Claude's own report would have said by now: Opus 5.5 runs fast. Without it the bolt carries
  // the note a first turn would settle, which is true of the harness and not of a session in use.
  await rpc.call("settings.set", { key: "models.fastSupport", value: { "claude:claude-opus-5-5": true } })
  await rpc.call("agents.probe", { force: false }).catch(() => null)
  const staged = await stage(ctx)

  // The settings above are read at boot, so the window is reloaded once the staging is done.
  await page.send("Page.reload", {})
  page.close()
  await sleep(1500)
  page = await attach()
  ctx = makeContext(page, rpc)
  await until(() => ctx.evaluate(`!!document.querySelector('.composer')`).catch(() => false), 30_000, "the window after its reload")
  await ctx.evaluate(awake)
  await scrub()

  // ---- run the scenes ------------------------------------------------------------------------
  /* REALM_CAPTURE_ONLY=sidebar,models runs a subset — a diagnostic tool, not a way to refresh one
     slide: skipped scenes keep their file and their manifest entry. */
  for (const scene of scenes) {
    if (only.length && !only.includes(scene.name)) continue
    try {
      await scene.run({ ...ctx, page }, staged)
      captured.push(scene.name)
      console.log(`  ✓ ${scene.name}`)
    } catch (error) {
      console.warn(`  ✗ ${scene.name} — ${error.message}`)
      const where = await ctx.evaluate(`__capture.onScreen()`).catch(() => null)
      if (where) console.warn(`      screen: ${where}`)
      await ctx.press("Escape", { vk: 27 }).catch(() => {})
      await ctx.home().catch(() => {})
    }
  }

  /**
   * The manifest is a UNION, not a replacement.
   *
   * A slug listed here means "there is a usable `<slug>.png` on disk", which is what the site reads
   * it for. A scene that fails now leaves the previous file untouched — `shot` refuses to write
   * unless the screen proves it is the subject — so dropping the slug would delete a working slide
   * from the site to record a fact about this run instead. A slug whose file is gone is dropped.
   */
  const manifestPath = path.join(outputDir, "manifest.json")
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : []
  const kept = previous.filter((slug) => fs.existsSync(path.join(outputDir, `${slug}.png`)))
  const manifest = [...new Set([...kept, ...captured])]
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  page.close()
  console.log(`\n${captured.length}/${scenes.length + 1} scenes captured; ${manifest.length} slides in ${path.relative(repoRoot, outputDir)}`)
  const stale = manifest.filter((slug) => !captured.includes(slug))
  if (stale.length) console.log(`  kept from an earlier run: ${stale.join(", ")}`)
}

main()
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    /*
     * Stop the SERVER, not just the window.
     *
     * realm-server is spawned by the desktop app and outliving the window is the whole point of it —
     * so killing the Electron this script started reparents the server to init and leaves it holding
     * the scratch home and REALM_PORT. `daemon.stop` is how the product itself asks; the kills by
     * port below are the answer for a server that will not, and they only ever reach this run's
     * own two ports.
     */
    await stopDaemon().catch(() => {})
    electron?.kill("SIGKILL")
    for (const port of [serverPort, cdpPort]) {
      try {
        for (const pid of execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
          try { process.kill(Number(pid), "SIGKILL") } catch { /* already gone */ }
        }
      } catch { /* nothing listening */ }
    }
    if (!process.env.REALM_CAPTURE_KEEP) fs.rmSync(scratch, { recursive: true, force: true })
    process.exit(process.exitCode ?? 0)
  })
