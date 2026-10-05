/**
 * Live check for the browser pane's ground, its error pages and the picker's outline
 * (run with: pnpm build && node apps/desktop/scripts/browser-errors-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and, in a session's side pane, checks:
 *
 *   1. One ground. A blank tab's toolbar band, its new-tab page and the session pane beside it paint
 *      the same colour, on the dark face, the light one and a themed palette — sampled from the
 *      window's own capture, which is honest here because the native view is hidden. The old rule
 *      (the opaque panel tone under a new tab) is put back for one capture, to show what was fixed.
 *   2. A closed localhost port: Realm's error page where the page would be, the view hidden (main
 *      says so), the address kept. Reload with the server still down keeps the page; a server
 *      started on that port and Reload pressed again brings the page in.
 *   3. An unresolvable host and a self-signed certificate get their own pages.
 *   4. A working page: the view is shown, and is captured from the VIEW's own webContents.
 *   5. Back and Forward walk past an error entry, and the page shows again each way.
 *   6. An agent driving the pane: browser_snapshot and browser_read on the refused page answer
 *      with the failure, not an empty page.
 *   7. The picker: armed from the toolbar, the pointer moved over elements inside the view, the
 *      outline captured from the view; Escape, and a pick, leave nothing of it on the page.
 *
 * Ports: LIVE_SERVER_PORT (8798), LIVE_CDP_PORT (9238), LIVE_MAIN_INSPECT_PORT (9298), and three
 * fixtures on 127.0.0.1 — LIVE_SITE_PORT (8898), LIVE_CLOSED_PORT (8897, nothing listening until
 * step 2 starts one) and LIVE_TLS_PORT (8899, a certificate made for this run). Plus one lookup of
 * `realm-live-check.invalid`, a name that by RFC 2606 can never resolve. Scratch under
 * LIVE_SCRATCH_DIR, pictures under LIVE_SHOTS_DIR; kills only what is listening on its own ports.
 * Nothing is billed: the session is the ACP stub the adapter suite uses, onboarding's session is
 * moved to the fake agent before anything else, and nothing is ever typed into a composer.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** A window this script starts from the background opens behind whatever is in front, and Chromium
 *  stops laying out a covered window — the browser pane is a native view sized from that layout. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8798);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9238);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9298);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8898);
const CLOSED_PORT = Number(process.env.LIVE_CLOSED_PORT ?? 8897);
const TLS_PORT = Number(process.env.LIVE_TLS_PORT ?? 8899);
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-browser-errors-live-"));
const home = path.join(scratch, "home");
const SHOTS = process.env.LIVE_SHOTS_DIR ?? path.join(os.tmpdir(), "realm-browser-errors-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const REFUSED = `http://localhost:${CLOSED_PORT}/`;
const UNRESOLVED = "http://realm-live-check.invalid/";
const UNTRUSTED = `https://127.0.0.1:${TLS_PORT}/`;
const TITLE = "Browser errors live check";
const WINDOW = { width: 1500, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
const servers = [];
const daemonPids = [];

const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function portFree(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(200);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** An expression in main, with `require` — the Electron objects themselves, not what a page says. */
async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/* ── The fixtures ─────────────────────────────────────────────────────────────────────────────── */

/** A page with things worth pointing at, at known places: a rounded button, a pill, a square card and
 *  a round avatar — the four kinds of corner the outline has to follow. White, as most pages are. */
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Weekly report</title>
<style>
  body { margin: 0; font: 15px -apple-system, system-ui, sans-serif; background: #fff; color: #1d1d1f; }
  h1 { position: absolute; left: 40px; top: 24px; margin: 0; font-size: 26px; }
  #save { position: absolute; left: 40px; top: 120px; width: 132px; height: 40px; border: 0; border-radius: 10px; background: #2563eb; color: #fff; font: inherit; }
  #beta { position: absolute; left: 196px; top: 126px; height: 28px; padding: 0 14px; border-radius: 999px; background: #eef2ff; color: #3730a3; display: flex; align-items: center; }
  #card { position: absolute; left: 40px; top: 200px; width: 360px; height: 140px; background: #f4f4f5; padding: 16px; box-sizing: border-box; }
  #card h2 { margin: 0 0 6px; font-size: 17px; } #card p { margin: 0; color: #52525b; }
  #avatar { position: absolute; left: 440px; top: 210px; width: 56px; height: 56px; border-radius: 50%; background: #f59e0b; }
</style>
<h1>Weekly report</h1>
<button id="save">Save changes</button>
<span id="beta">Beta</span>
<div id="card"><h2>Three builds shipped</h2><p>One rolled back, two still in review.</p></div>
<div id="avatar" title="Avatar"></div>`;
/** Where each is, in the view's own CSS px. */
const AT = { save: { x: 106, y: 140 }, beta: { x: 230, y: 140 }, card: { x: 300, y: 300 }, avatar: { x: 468, y: 238 } };

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { servers.push(server); resolve(server); });
  });
}
/** `/hang` takes the connection and then drops it without a word: a slow first page that ends as
 *  ERR_EMPTY_RESPONSE, which is long enough to see the spiral waiting and the pulse on a retry. */
const HANG_MS = 2500;
const startSite = () => listen(http.createServer((req, res) => {
  if (req.url === "/hang") { setTimeout(() => req.socket.destroy(), HANG_MS); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE);
}), SITE_PORT);
/** A dev server coming up on the port that refused — what Reload is for. */
const startLateServer = () => listen(http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<!doctype html><title>Dev server</title><body style="margin:0;background:#fff;font:15px system-ui"><h1 style="margin:40px">The dev server is up</h1>');
}), CLOSED_PORT);
/** A certificate this run made, which nothing trusts. */
function startUntrusted() {
  const key = path.join(scratch, "key.pem"), cert = path.join(scratch, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  return listen(https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Untrusted</title>untrusted");
  }), TLS_PORT);
}

/* ── The app ──────────────────────────────────────────────────────────────────────────────────── */

async function launch(agent) {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_GEMINI_BIN: agent,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");
  return { c, m };
}

/** The window as a person at the Mac sees it when it is the key window: not greyed, not quiet. The
 *  script's window is neither — it opens behind whatever is in front — and both would change what is
 *  being looked at (the accent goes grey, the busy pulse holds still). */
const holdKey = (c) => evalIn(c, `(() => {
  const root = document.documentElement;
  const clear = () => { root.removeAttribute("data-window-inactive"); root.removeAttribute("data-quiet"); };
  clear();
  new MutationObserver(clear).observe(root, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] });
  return true;
})()`);

/** Pick a command-palette row by its label — how the face and the palette are changed. */
async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const picked = await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`).catch(() => false);
  if (!picked) {
    await evalIn(c, `(() => { document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    throw new Error(`no palette row: ${label}`);
  }
  await sleep(500);
}

async function press(c, { key, code, keyCode, meta = false, shift = false }) {
  const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

/** The keyboard into the session's pane, as a click there puts it, and then out of any field. */
async function intoSession(c) {
  await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await sleep(100);
}

const tabCount = (c) => evalIn(c, `document.querySelectorAll('.pane-tabs [role=tab]').length`);
/** ⌘⇧B from the session: a blank browser tab in its side pane, its address field focused. */
async function newTab(c) {
  const before = await tabCount(c);
  await intoSession(c);
  await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true });
  await until(async () => (await tabCount(c)) === before + 1, 10_000, "a new tab");
  await until(() => evalIn(c, `document.activeElement?.getAttribute('aria-label') === 'Address'`), 5_000, "the address field focused");
  await sleep(300);
}

const PANE = `[...document.querySelectorAll('.browser-pane')].find((p) => p.offsetParent !== null)`;
/** Type an address into the shown pane's field, and go. */
async function go(c, address) {
  await evalIn(c, `(() => {
    const input = ${PANE}.querySelector('.browser-address input');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(address)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
}
/** What the shown pane is drawing where its view would be. */
const paneState = (c) => evalIn(c, `(() => {
  const pane = ${PANE};
  if (!pane) return null;
  const err = pane.querySelector('.browser-error');
  return {
    address: pane.querySelector('.browser-address input').value,
    error: err ? { title: err.querySelector('.browser-error-title').textContent, reason: [...err.querySelectorAll('.browser-error-reason')].map((p) => p.textContent).join(' '),
      tips: [...err.querySelectorAll('li')].map((li) => li.textContent), code: err.querySelector('.browser-error-code').textContent,
      mark: err.dataset.mark, busy: !!err.querySelector('.reach-mark[data-busy]'), buttons: [...err.querySelectorAll('button')].map((b) => b.textContent) } : null,
    newTab: !!pane.querySelector('.new-tab'),
    connecting: !!pane.querySelector('.browser-connecting'),
    hostPaintsPage: pane.querySelector('.browser-view-host').hasAttribute('data-page'),
    hostBackground: getComputedStyle(pane.querySelector('.browser-view-host')).backgroundColor,
    canGoBack: !pane.querySelector('[aria-label="Back"]').disabled,
    canGoForward: !pane.querySelector('[aria-label="Forward"]').disabled,
  };
})()`);

/** Every native browser view, as main has it: the page it is on, and whether it is on screen. */
const views = (m) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView } = require("electron");
  const out = [];
  for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
    if (!(v instanceof WebContentsView)) continue;
    out.push({ url: v.webContents.getURL(), shown: v.getVisible(), bounds: v.getBounds() });
  }
  return out;
})()`);
/** The view on a page — the one on screen, when several tabs are on the same address. */
const viewOn = async (m, url) => {
  const on = (await views(m)).filter((v) => v.url === url);
  return on.find((v) => v.shown) ?? on[0] ?? null;
};

/** Find the shown view on a page and run `body` with it bound as `v`, in main. */
const withView = (m, url, body) => inMain(m, `(async () => {
  // Bound before the first await: the inspector's command-line \`require\` is gone once it returns.
  const { BrowserWindow, WebContentsView } = require("electron");
  const fs = require("fs");
  let v = null;
  for (const w of BrowserWindow.getAllWindows()) for (const x of w.contentView.children) {
    if (x instanceof WebContentsView && x.webContents.getURL() === ${JSON.stringify(url)} && x.getVisible()) v = x;
  }
  if (!v) return null;
  ${body}
})()`);
/** The VIEW's own picture: the window's capture composites no child view (and a CDP capture of the
 *  window is DOM only), so anything drawn inside the page is read from here. */
const viewShot = (m, url, tag) => withView(m, url, `
  const img = await v.webContents.capturePage();
  fs.writeFileSync(${JSON.stringify(path.join(SHOTS, `${tag}.png`))}, img.toPNG());
  return { size: img.getSize(), bounds: v.getBounds() };`).then((r) => { console.log(`SCREENSHOT ${tag} ${path.join(SHOTS, `${tag}.png`)}`); return r; });
const inView = (m, url, expr) => withView(m, url, `return await v.webContents.executeJavaScript(${JSON.stringify(expr)});`);
const viewInput = (m, url, events) => withView(m, url, `
  v.webContents.focus();
  for (const e of ${JSON.stringify(events)}) { v.webContents.sendInputEvent(e); await new Promise((r) => setTimeout(r, 40)); }
  return true;`);

/** The window's DOM as the renderer draws it, whole or clipped. Native views are not in it — which is
 *  what makes it honest for a pane whose view is hidden. */
async function shot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.writeFileSync(path.join(SHOTS, `${tag}.png`), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${path.join(SHOTS, `${tag}.png`)}`);
  return data;
}
/** The shown browser pane with the session pane beside it: what the owner's report was about. */
const sidePaneClip = (c) => evalIn(c, `(() => {
  const pane = ${PANE}.closest('.panel').getBoundingClientRect();
  return { x: Math.max(0, pane.x - 160), y: Math.max(0, pane.y), width: Math.min(pane.width + 160, ${WINDOW.width} - Math.max(0, pane.x - 160)), height: pane.height };
})()`);

/**
 * The colour at a few points of the window's capture: the toolbar band beside the arrows, the view's
 * rectangle near its far corner, and the session pane's gutter. Read through a canvas in the renderer,
 * which is already holding a decoder.
 */
async function grounds(c) {
  const at = await evalIn(c, `(() => {
    const pane = ${PANE};
    const chrome = pane.querySelector('.browser-chrome').getBoundingClientRect();
    const host = pane.querySelector('.browser-view-host').getBoundingClientRect();
    const session = document.querySelector('.session-pane').getBoundingClientRect();
    // The session pane's open ground: right of the composer column and below it, clear of its edges.
    return { band: [chrome.left + 3, chrome.top + chrome.height / 2], content: [host.right - 14, host.bottom - 14], session: [session.right - 24, session.top + session.height * 0.85] };
  })()`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  const px = await evalIn(c, `(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${data}";
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const k = img.naturalWidth / window.innerWidth;
    const at = ${JSON.stringify(at)};
    return Object.fromEntries(Object.entries(at).map(([name, [x, y]]) => [name, Array.from(g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data)]));
  })()`);
  return px;
}
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/* ── The run ──────────────────────────────────────────────────────────────────────────────────── */

async function shutDown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  api = null;
  electron?.kill("SIGKILL");
  electron = null;
  await sleep(500);
  daemonPids.push(...(await stopDaemons(home, daemonPids)));
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
}

async function main() {
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT, SITE_PORT, CLOSED_PORT, TLS_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  await startSite();
  await startUntrusted();

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const { c, m } = await launch(agent);

  // Onboarding makes the space. Its first session runs a REAL engine, so it goes to the fake agent
  // before anything else, and nothing is ever typed into it.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);

  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    // The agent's cards, answered as a user would: allow.
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    void api.call("sessions.respondPermission", { id: sessionId, requestId: payload.event.payload.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
  sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the session alone, so every pane after this is one the checks asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── 1. One ground, on a blank tab ──────────────────────────────────────────────────────────
  await newTab(c);
  const blank = await grounds(c);
  note("blank tab, dark", blank);
  check("dark: the toolbar band and the new tab's ground are one colour", near(blank.band, blank.content), blank);
  check("…and it is the session pane's ground", near(blank.band, blank.session), blank);
  await shot(c, "01-ground-blank-dark", await sidePaneClip(c));
  // What it was: the opaque panel tone under a new tab, put back for one picture.
  await evalIn(c, `(() => { const s = document.createElement('style'); s.id = 'live-before'; s.textContent = '.browser-pane:has(.new-tab) .browser-view-host { background: var(--rl-panel) !important; }'; document.head.append(s); return true; })()`);
  await sleep(200);
  const before = await grounds(c);
  note("blank tab with the old rule put back", before);
  check("…where the old rule painted a different ground under the toolbar (the lighter strip)", !near(before.band, before.content), before);
  await shot(c, "00-ground-blank-dark-before", await sidePaneClip(c));
  await evalIn(c, `(() => { document.getElementById('live-before')?.remove(); return true; })()`);

  // ── 2. A closed port on this Mac ──────────────────────────────────────────────────────────
  await go(c, `localhost:${CLOSED_PORT}`);
  const refused = await until(async () => { const s = await paneState(c); return s?.error ? s : null; }, 15_000, "the refused page");
  note("refused", refused);
  check("a closed port draws Realm's page: the title, the reason and the code the owner expected",
    refused.error.title === "This site can't be reached" && refused.error.reason === "localhost refused to connect." && refused.error.code === "ERR_CONNECTION_REFUSED", refused.error);
  check("…with what to try on this Mac, and a Reload", refused.error.tips[0] === `Checking that a server is running on port ${CLOSED_PORT}` && refused.error.buttons.join() === "Reload", refused.error);
  check("…and the bar keeps the address that was asked for", refused.address === REFUSED, refused.address);
  const refusedView = await viewOn(m, REFUSED);
  check("main: the view is on the failed address and NOT on screen, so the page Realm drew is what shows", !!refusedView && refusedView.shown === false, refusedView);
  check("…and the host paints nothing of its own over the pane's ground", !refused.hostPaintsPage && refused.hostBackground === "rgba(0, 0, 0, 0)", refused.hostBackground);
  const refusedGround = await grounds(c);
  check("…on the same ground as the toolbar band", near(refusedGround.band, refusedGround.content), refusedGround);
  await shot(c, "02-refused-dark", await sidePaneClip(c));

  // Reload with the server still down: the same page, still the error entry, nothing else on screen.
  await evalIn(c, `(() => { [...${PANE}.querySelectorAll('.browser-error button')].find((b) => b.textContent === 'Reload').click(); return true; })()`);
  await sleep(1500);
  const again = await paneState(c);
  check("Reload with the server still down keeps the page, and the view stays hidden",
    again.error?.code === "ERR_CONNECTION_REFUSED" && (await viewOn(m, REFUSED))?.shown === false, again.error);
  check("a first page that failed leaves no blank page behind it for Back to go to", again.canGoBack === false, again);

  // ── 6. The agent's side, while the port is still closed ──────────────────────────────────
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "browser-errors-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const text = (r) => (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  const call = async (name, args = {}) => client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 60_000 });
  const opened = await call("browser_open", { url: REFUSED });
  const agentBrowser = /pane (\S+) at/.exec(text(opened))?.[1];
  check("browser_open opens a pane at the refused address", !!agentBrowser && !opened.isError, text(opened));
  const snapText = await until(async () => {
    const t = text(await call("browser_snapshot", { browserId: agentBrowser }));
    return t.includes("did not load") ? t : null;
  }, 20_000, "the agent's snapshot of the refused page").catch(() => "");
  note("browser_snapshot", snapText);
  check("browser_snapshot tells the agent the page did not load, and why, in Realm's own words",
    snapText.includes(`The page at ${REFUSED} did not load. This site can't be reached: localhost refused to connect. (ERR_CONNECTION_REFUSED)`) && !snapText.includes("untrusted-"), snapText);
  const readText = text(await call("browser_read", { browserId: agentBrowser, kind: "text" }));
  check("browser_read says the same, not an empty page", readText.includes("localhost refused to connect."), readText);
  const listed = text(await call("browser_list", {}));
  check("browser_list marks the pane that did not load", listed.includes("did not load (ERR_CONNECTION_REFUSED)"), listed);
  await client.close().catch(() => {});

  // ── 3. An unresolvable host, and a certificate nothing trusts ─────────────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')][0].click(); return true; })()`);
  await sleep(500);
  await go(c, UNRESOLVED);
  const unresolved = await until(async () => { const s = await paneState(c); return s?.error?.code === "ERR_NAME_NOT_RESOLVED" ? s : null; }, 20_000, "the unresolved page");
  check("an unresolvable host gets its own reason", unresolved.error.reason === "realm-live-check.invalid's address couldn't be found.", unresolved.error);
  check("…and Back now reaches the refused entry behind it", unresolved.canGoBack === true, unresolved);
  await shot(c, "03-unresolved-dark", await sidePaneClip(c));
  await go(c, UNTRUSTED);
  const untrusted = await until(async () => { const s = await paneState(c); return s?.error?.code === "ERR_CERT_AUTHORITY_INVALID" ? s : null; }, 20_000, "the certificate page");
  check("a certificate nothing trusts gets the padlock, its reason, and no way past it but Reload",
    untrusted.error.mark === "lock" && untrusted.error.title === "Your connection isn't private" && untrusted.error.buttons.join() === "Reload", untrusted.error);
  await shot(c, "04-untrusted-dark", await sidePaneClip(c));

  // ── 4. A working page ─────────────────────────────────────────────────────────────────────
  await go(c, `${SITE}/`);
  const shown = await until(async () => { const v = await viewOn(m, `${SITE}/`); return v?.shown ? v : null; }, 15_000, "the working page on screen");
  const working = await paneState(c);
  check("a working page: the view is on screen, and the pane draws nothing of its own in its place",
    !!shown && !working.error && !working.connecting && working.hostPaintsPage, { shown, working });
  const viewPicture = await viewShot(m, `${SITE}/`, "05-working-page-view");
  check("…captured from the view's own webContents, at the view's size", !!viewPicture && viewPicture.size.width === viewPicture.bounds.width, viewPicture);
  await shot(c, "05-working-page-window-dark", await sidePaneClip(c));

  // ── 5. Back and Forward walk past the error entry ─────────────────────────────────────────
  await evalIn(c, `(() => { ${PANE}.querySelector('[aria-label="Back"]').click(); return true; })()`);
  const back = await until(async () => { const s = await paneState(c); return s?.error?.code === "ERR_CERT_AUTHORITY_INVALID" ? s : null; }, 15_000, "Back to the certificate entry");
  check("Back goes to the error entry, and its page is drawn again", !!back && (await viewOn(m, UNTRUSTED))?.shown === false, back?.error);
  await evalIn(c, `(() => { ${PANE}.querySelector('[aria-label="Forward"]').click(); return true; })()`);
  const forward = await until(async () => { const v = await viewOn(m, `${SITE}/`); return v?.shown ? v : null; }, 15_000, "Forward to the working page");
  check("Forward comes back to the page, with the view on screen again", !!forward && !(await paneState(c)).error, forward);

  // ── 7. The picker ─────────────────────────────────────────────────────────────────────────
  const pickerHosts = () => inView(m, `${SITE}/`, "document.querySelectorAll('realm-picker').length");
  await evalIn(c, `(() => { ${PANE}.querySelector('.browser-pick').click(); return true; })()`);
  await until(async () => (await pickerHosts()) === 1, 5_000, "the picker armed");
  const outlines = {};
  for (const [name, at] of Object.entries(AT)) {
    await viewInput(m, `${SITE}/`, [{ type: "mouseMove", x: at.x - 6, y: at.y - 2 }, { type: "mouseMove", x: at.x, y: at.y }]);
    await sleep(350);
    outlines[name] = await inView(m, `${SITE}/`, `(() => { const r = document.querySelector('realm-picker').shadowRoot; const b = r.querySelector('.box'); const l = r.querySelector('.label');
      return { radius: b.style.borderRadius, on: b.hasAttribute('data-on'), label: l.textContent, box: b.getBoundingClientRect().toJSON() }; })()`);
    await viewShot(m, `${SITE}/`, `06-picker-${name}`);
  }
  note("outlines", outlines);
  check("the outline follows each element's own corner: a 10px button, a pill, a square card, a circle",
    outlines.save.radius.startsWith("13px") && outlines.beta.radius.startsWith("17px") && outlines.card.radius.startsWith("8px") && outlines.avatar.radius.startsWith("31px"), outlines);
  check("…and labels each with its name and size", outlines.save.label === "button#save132 × 40" && outlines.card.label === "div#card360 × 140", outlines);
  await viewInput(m, `${SITE}/`, [{ type: "keyDown", keyCode: "Escape" }, { type: "keyUp", keyCode: "Escape" }]);
  await sleep(400);
  check("Escape takes the outline down, and the toolbar button lets go",
    (await pickerHosts()) === 0 && (await evalIn(c, `${PANE}.querySelector('.browser-pick').getAttribute('aria-pressed')`)) === "false");
  await evalIn(c, `(() => { ${PANE}.querySelector('.browser-pick').click(); return true; })()`);
  await until(async () => (await pickerHosts()) === 1, 5_000, "the picker armed again");
  await viewInput(m, `${SITE}/`, [{ type: "mouseMove", x: AT.save.x - 4, y: AT.save.y }, { type: "mouseMove", x: AT.save.x, y: AT.save.y },
    { type: "mouseDown", x: AT.save.x, y: AT.save.y, button: "left", clickCount: 1 }, { type: "mouseUp", x: AT.save.x, y: AT.save.y, button: "left", clickCount: 1 }]);
  const toast = await until(() => evalIn(c, `${PANE}.querySelector('.browser-toast')?.textContent ?? null`), 5_000, "the pick's receipt").catch(() => null);
  check("a pick goes into the session's prompter", typeof toast === "string" && toast.startsWith("Added ") && toast.includes(TITLE), toast);
  await sleep(500);
  check("…and nothing of the picker is left on the page after it", (await pickerHosts()) === 0);
  check("…nor the stamp it hands the element back by", (await inView(m, `${SITE}/`, "document.querySelectorAll('[data-realm-picked]').length")) === 0);

  // ── A slow page: the spiral while the first page is on its way, and the pulse on a retry ──
  await newTab(c);
  await go(c, `${SITE}/hang`);
  await sleep(1300);
  const waiting = await paneState(c);
  check("a first page that keeps the pane waiting shows the spiral on the pane's ground, and no view", waiting.connecting && !waiting.error && !(await viewOn(m, `${SITE}/hang`))?.shown, waiting);
  await shot(c, "11-connecting-dark", await sidePaneClip(c));
  const empty = await until(async () => { const s = await paneState(c); return s?.error ? s : null; }, 10_000, "the empty response's page");
  check("…and when it ends without an answer, its own page", empty.error.code === "ERR_EMPTY_RESPONSE" && empty.error.reason === "127.0.0.1 didn't send any data.", empty.error);
  await evalIn(c, `(() => { [...${PANE}.querySelectorAll('.browser-error button')].find((b) => b.textContent === 'Reload').click(); return true; })()`);
  await sleep(900);
  const retrying = await paneState(c);
  check("Reload keeps the page up while it tries again, its spiral busy", retrying.error?.code === "ERR_EMPTY_RESPONSE" && retrying.error.busy, retrying.error);
  await shot(c, "12-retrying-dark", await sidePaneClip(c));
  await until(async () => { const s = await paneState(c); return s?.error && !s.error.busy ? s : null; }, 10_000, "the retry settled");

  // ── 1 and 2 again, on the light face and a themed palette ─────────────────────────────────
  for (const face of [{ tag: "light", rows: ["Theme: Light"] }, { tag: "nord", rows: ["Theme: Dark", "Palette: Nord"] }]) {
    for (const row of face.rows) await paletteRow(c, row);
    await holdKey(c);
    await newTab(c);
    const g = await grounds(c);
    note(`blank tab, ${face.tag}`, g);
    check(`${face.tag}: the toolbar band, the new tab's ground and the session pane's are one colour`, near(g.band, g.content) && near(g.band, g.session), g);
    await shot(c, `07-ground-blank-${face.tag}`, await sidePaneClip(c));
    await go(c, `localhost:${CLOSED_PORT}`);
    await until(async () => (await paneState(c))?.error?.code === "ERR_CONNECTION_REFUSED", 15_000, `the refused page, ${face.tag}`);
    const e = await grounds(c);
    check(`${face.tag}: the error page sits on that same ground`, near(e.band, e.content), e);
    await shot(c, `08-refused-${face.tag}`, await sidePaneClip(c));
    if (face.tag === "light") {
      await go(c, UNTRUSTED);
      await until(async () => (await paneState(c))?.error?.mark === "lock", 15_000, "the certificate page, light");
      await shot(c, "09-untrusted-light", await sidePaneClip(c));
      await go(c, `localhost:${CLOSED_PORT}`);
      await until(async () => (await paneState(c))?.error?.code === "ERR_CONNECTION_REFUSED", 15_000, "back on the refused page");
    }
  }
  await paletteRow(c, "Palette: Realm").catch(() => {});

  // ── 2, finished: the server comes up and Reload brings the page ───────────────────────────
  await startLateServer();
  await evalIn(c, `(() => { [...${PANE}.querySelectorAll('.browser-error button')].find((b) => b.textContent === 'Reload').click(); return true; })()`);
  const up = await until(async () => { const v = await viewOn(m, REFUSED); return v?.shown ? v : null; }, 15_000, "the dev server's page after Reload");
  const upState = await paneState(c);
  check("with a server on the port, Reload on the error page brings the page in: the error page goes and the view is on screen",
    !!up && !upState.error, { up, error: upState.error });
  await viewShot(m, REFUSED, "10-reloaded-dev-server-view");
}

async function teardown() {
  await shutDown().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(() => r()));
  for (const p of [SITE_PORT, CLOSED_PORT, TLS_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
