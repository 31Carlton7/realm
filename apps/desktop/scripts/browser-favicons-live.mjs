/**
 * Live check for a browser tab's favicon (run with: pnpm build && node apps/desktop/scripts/browser-favicons-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, opens browser tabs in a fake session's side pane on a
 * local fixture site, and checks, in the real window:
 *
 *   1. A page with a PNG icon draws it in its tab, decoded, in the glyph's 14px box; a page offering
 *      an SVG and a 16px PNG draws the SVG; a page offering none keeps the browser glyph — after its
 *      /favicon.ico was asked for and answered 404, so the glyph is an answer and not a page that
 *      never loaded (main says which pages its views are on).
 *   2. Main asked the site for the icon once across two of its pages, with no cookie although the
 *      page had set one, and no referrer.
 *   3. The tab strip, captured on both faces.
 *   4. A tab that moves from a page with an icon to one whose icon is slow to answer shows the glyph
 *      in the meantime — the icon is the page's, and is not lent to the next one (main drops it on
 *      the navigation; this is the check that fails without that).
 *   5. The sidebar's rows and a browser's own pane bar wear the same marks, and the server kept each
 *      icon on its browser row.
 *   6. A blank tab's Recently visited and the address suggestions show each page's icon.
 *   7. Relaunched with the site DOWN, each restored tab still draws its icon — from what Realm kept,
 *      since nothing can be fetched — and keeps it after its page has failed to load.
 *
 * Ports: LIVE_SERVER_PORT (8969), LIVE_CDP_PORT (9369), LIVE_MAIN_INSPECT_PORT (9469), LIVE_SITE_PORT
 * (8979). Touches only a scratch dir; kills only what is listening on its own ports. Browses nothing
 * but its own 127.0.0.1 fixture. Nothing is billed: the one session it drives is on the fake agent,
 * the onboarding session is moved to it too before anything else, and REALM_ENABLE_FAKE_AGENT=1 turns
 * the recap off. Nothing is ever typed into a composer.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9369);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8969);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8979);
/** Main's own inspector — the one place that knows which page each native view is on. */
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9469);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-favicons-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TITLE = "Favicon live check";
const WINDOW = { width: 1500, height: 900 };
const OUT = (tag) => path.join(os.tmpdir(), `realm-browser-favicons-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;
const daemonPids = [];

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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
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

/** A 32px PNG: a ring in four colours with a clear middle, so it reads as a site's mark in a capture
 *  and nothing like the browser glyph. Encoded here so the fixture is a real PNG, not a stand-in. */
function ringPng() {
  const size = 32;
  const colours = [[234, 67, 53], [66, 133, 244], [52, 168, 83], [251, 188, 5]];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2, dy = y + 0.5 - size / 2, r = Math.hypot(dx, dy);
      const quadrant = (dy < 0 ? 0 : 2) + (dx < 0 ? 0 : 1);
      const px = r <= 15.5 && r >= 7 ? [...colours[quadrant], 255] : [0, 0, 0, 0];
      raw.set(px, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ICON_PNG = ringPng();
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#16a34a"/><rect x="4" y="7" width="8" height="2" fill="#fff"/></svg>';

/** How long /slow.ico keeps a tab waiting — well past the pane's persist debounce. */
const SLOW_ICON_MS = 5_000;

/** Every request the site answered, with the two headers the icon fetch must not carry. */
const requests = [];

/**
 * Four kinds of page: one with a PNG icon (three of them, to show the icon is fetched once per site),
 * one offering an SVG beside a 16px PNG, one offering nothing — whose /favicon.ico is a 404 — and one
 * whose icon takes five seconds to answer, and then is a 404 too. Every page sets a cookie, so an
 * icon request that carried one would show it.
 */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", SITE);
      requests.push({ path: url.pathname, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null });
      const page = (title, head) => {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "visit=1; Path=/" });
        res.end(`<!doctype html><title>${title}</title>${head}<body style="margin:0;background:#fff"><h1>${title}</h1></body>`);
      };
      if (url.pathname === "/search") return page(`${url.searchParams.get("q")} - Search`, '<link rel="icon" href="/icon.png">');
      if (url.pathname === "/docs") return page("Docs", '<link rel="icon" href="/favicon-16x16.png"><link rel="icon" type="image/svg+xml" href="/icon.svg">');
      if (url.pathname === "/plain") return page("Plain page", "");
      if (url.pathname === "/quiet") return page("Quiet page", '<link rel="icon" href="/slow.ico">');
      if (url.pathname === "/slow.ico") {
        setTimeout(() => { res.writeHead(404, { "content-type": "text/html" }); res.end("<!doctype html><title>Not found</title>"); }, SLOW_ICON_MS);
        return;
      }
      if (url.pathname === "/icon.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(ICON_PNG); }
      if (url.pathname === "/icon.svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end(ICON_SVG); }
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>Not found</title><h1>Not found</h1>");
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** A chord as the window gets it from the keyboard: down and up, with the modifiers held. */
async function press(c, { key, code, keyCode, meta = false, shift = false, alt = false }) {
  const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

/** Boot the built app on the scratch home and attach to its renderer and its main process. */
async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) await until(() => portFree(p), 10_000, `port ${p} free`);
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

/** The app and its daemon gone, and their ports with them — the site is the caller's. */
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

const connectApi = async () => {
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
};

/** Every tab of the side pane, and what it wears where the kind's glyph goes. */
const tabs = (c) => evalIn(c, `[...document.querySelectorAll('.pane-tabs [role=tab]')].map((t) => {
  const img = t.querySelector('img.page-icon');
  const r = img?.getBoundingClientRect();
  return { name: t.textContent, selected: t.getAttribute('aria-selected') === 'true', glyph: !!t.querySelector('svg'),
    icon: img ? { type: img.getAttribute('src').slice(5, img.getAttribute('src').indexOf(';')), decoded: img.complete && img.naturalWidth > 0,
      natural: img.naturalWidth, box: [Math.round(r.width), Math.round(r.height)] } : null };
})`);
const tab = async (c, name) => (await tabs(c)).find((t) => t.name === name) ?? null;

/** Each fixture page's native view as main has it: the page it is on, and whether it shows. */
const views = (m) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView } = require("electron");
  const out = [];
  for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
    if (!(v instanceof WebContentsView)) continue;
    out.push({ url: v.webContents.getURL(), shown: v.getVisible(), title: v.webContents.getTitle() });
  }
  return out;
})()`);

/** What an element wears where a kind's glyph goes: the decoded icon's type, the glyph, or nothing. */
const MARK = `((el) => { const img = el.querySelector('img.page-icon');
  if (img) { const src = img.getAttribute('src'); return img.naturalWidth > 0 ? src.slice(5, src.indexOf(';')) : 'undecoded'; }
  return el.querySelector('svg') ? 'glyph' : null; })`;

/** The keyboard into the fake session's pane, as a click there puts it, and then out of any field. */
async function intoSession(c) {
  await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await sleep(100);
}

/** ⌘⇧B from the session: a blank browser tab in its side pane, the address field focused. */
async function newTab(c) {
  const before = (await tabs(c)).length;
  await intoSession(c);
  await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true });
  await until(async () => (await tabs(c)).length === before + 1, 10_000, "a new tab");
  await until(() => evalIn(c, `document.activeElement?.getAttribute('aria-label') === 'Address'`), 5_000, "the address field focused");
}

/** Type an address into the address field the keyboard is in, and go. */
async function go(c, address) {
  await evalIn(c, `(() => {
    const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(address)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
}

/** The window as the renderer draws it, or a part of it. Native views are not in a DOM capture,
 *  which is fine here: everything this checks is DOM — the tab strip, the rows, the bar. */
async function shot(c, tag, clip) {
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
}

/** The side pane's bar and the rows beside it, as one picture: what the report was about. */
const stripClip = (c) => evalIn(c, `(() => {
  const bar = document.querySelector('.panel[data-tabbed] .panel-bar').getBoundingClientRect();
  return { x: Math.max(0, bar.x - 8), y: Math.max(0, bar.y - 8), width: Math.min(bar.width + 16, ${WINDOW.width}), height: bar.height + 16 };
})()`);

async function setTheme(c, label) {
  await evalIn(c, `(async () => {
    document.querySelector('[aria-label="Space menu"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[role="menu"]'); i++) await new Promise((r) => setTimeout(r, 25));
    const hit = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) throw new Error("no menu item: " + ${JSON.stringify(label)});
    hit.click(); return true; })()`);
  await sleep(400);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();
  let { c, m } = await launch();

  // Onboarding makes the space. Its first session runs a REAL engine, so it is moved to the fake
  // agent before anything else happens, and nothing is ever typed into it.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await connectApi();
  const [space] = await api.call("spaces.list", {});
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the fake session alone, so every pane after this is one the checks asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── 1. Three pages, three answers ─────────────────────────────────────────────────────────────
  await newTab(c);
  await go(c, `${SITE}/search?q=hi`);
  const hi = await until(async () => { const t = await tab(c, "hi - Search"); return t?.icon?.decoded ? t : null; }, 15_000, "hi's icon").catch(() => tab(c, "hi - Search"));
  check("a page with a PNG icon draws it in its tab, decoded, in the glyph's 14px box",
    hi?.icon?.type === "image/png" && hi.icon.decoded && hi.icon.natural === 32 && hi.icon.box.join() === "14,14" && !hi.glyph, hi);
  // The same tab, a second page of the site: its icon is the one main already holds.
  await evalIn(c, `(() => { [...document.querySelectorAll('.browser-address input')].find((i) => i.offsetParent !== null).focus(); return true; })()`);
  await go(c, `${SITE}/search?q=two`);
  const two = await until(async () => { const t = await tab(c, "two - Search"); return t?.icon?.decoded ? t : null; }, 15_000, "two's icon").catch(() => tab(c, "two - Search"));
  check("…and the site's next page wears it too", two?.icon?.type === "image/png" && two.icon.decoded, two);

  await newTab(c);
  await go(c, `${SITE}/docs`);
  const docs = await until(async () => { const t = await tab(c, "Docs"); return t?.icon?.decoded ? t : null; }, 15_000, "Docs' icon").catch(() => tab(c, "Docs"));
  check("a page offering an SVG and a 16px PNG draws the SVG, which is sharp at any size", docs?.icon?.type === "image/svg+xml" && docs.icon.decoded, docs);

  await newTab(c);
  await go(c, `${SITE}/plain`);
  await until(async () => !!(await tab(c, "Plain page")), 15_000, "the plain page's tab");
  await until(() => requests.some((r) => r.path === "/favicon.ico"), 10_000, "the plain page's /favicon.ico").catch(() => {});
  await sleep(1500); // past the persist debounce, so a wrongly kept icon would have landed by now
  const plain = await tab(c, "Plain page");
  const loaded = await views(m);
  note("the views, as main has them", loaded);
  check("a page offering no icon keeps the browser glyph — never an empty slot or a broken picture",
    !!plain && plain.icon === null && plain.glyph, plain);
  check("…and that is an answer: its view is on the page, and the /favicon.ico Blink offers for it was asked for and 404'd",
    loaded.some((v) => v.url === `${SITE}/plain`) && requests.some((r) => r.path === "/favicon.ico"), { favicon: requests.filter((r) => r.path === "/favicon.ico").length });

  // ── 2. One request, no cookie, no referrer ─────────────────────────────────────────────────────
  const iconAsks = requests.filter((r) => r.path === "/icon.png");
  const pageAsks = requests.filter((r) => r.path === "/search");
  check("main asked the site for its icon once across two of its pages", iconAsks.length === 1, { iconAsks: iconAsks.length });
  check("…with no cookie, though the page had set one, and no referrer",
    iconAsks.every((r) => r.cookie === null && r.referer === null) && pageAsks.some((r) => r.cookie === "visit=1"), { icon: iconAsks, pages: pageAsks.map((r) => r.cookie) });
  check("the SVG was taken first: the 16px PNG beside it was never fetched", !requests.some((r) => r.path === "/favicon-16x16.png"), requests.map((r) => r.path));

  // ── 3. The strip, on both faces — while the side pane still has its width ──────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')].find((t) => t.textContent === 'two - Search').click(); return true; })()`);
  await sleep(600);
  await setTheme(c, "Theme: Dark");
  await shot(c, "strip-dark", await stripClip(c));
  await shot(c, "window-dark");
  await setTheme(c, "Theme: Light");
  await shot(c, "strip-light", await stripClip(c));
  await shot(c, "window-light");
  const lightMarks = await tabs(c);
  check("the marks hold on the light face", lightMarks.find((t) => t.name === "two - Search")?.icon?.decoded === true, lightMarks.map((t) => [t.name, t.icon?.type ?? "glyph"]));
  await setTheme(c, "Theme: Dark");

  // ── 4. A tab that moves on: the next page does not wear the last one's icon ───────────────────
  await newTab(c);
  await go(c, `${SITE}/search?q=three`);
  await until(async () => (await tab(c, "three - Search"))?.icon?.decoded, 15_000, "three's icon");
  await evalIn(c, `(() => { [...document.querySelectorAll('.browser-address input')].find((i) => i.offsetParent !== null).focus(); return true; })()`);
  await go(c, `${SITE}/quiet`);
  await until(async () => !!(await tab(c, "Quiet page")), 15_000, "the quiet page's tab");
  await sleep(1500); // past the persist debounce, and still well inside the slow icon's wait
  const waiting = await tab(c, "Quiet page");
  const askedSlow = requests.some((r) => r.path === "/slow.ico");
  check("a tab that moved from a page with an icon shows the glyph while the next page's icon is still coming",
    !!waiting && waiting.icon === null && waiting.glyph && askedSlow, { tab: waiting, askedSlow });
  await sleep(SLOW_ICON_MS);
  const answered = await tab(c, "Quiet page");
  check("…and keeps the glyph once that icon turns out to be a 404", !!answered && answered.icon === null && answered.glyph, answered);

  // ── 5. The rows, a pane bar, and what the server kept ─────────────────────────────────────────
  const rows = await evalIn(c, `Object.fromEntries([...document.querySelectorAll('.item-list .item-row')].map((b) => [b.querySelector('.item-title')?.textContent, ${MARK}(b)]))`);
  check("the sidebar's rows wear the same marks as the tabs",
    rows["two - Search"] === "image/png" && rows["Docs"] === "image/svg+xml" && rows["Plain page"] === "glyph" && rows["Quiet page"] === "glyph", rows);
  const items = (await api.call("items.list", { spaceId: space.id })).filter((i) => i.kind === "browser");
  const kept = Object.fromEntries(await Promise.all(items.map(async (i) => [i.title, (await api.call("browsers.get", { browserId: i.refId })).favicon.slice(0, 22)])));
  check("the server kept each icon on its browser row, and none for the page without one",
    kept["two - Search"] === "data:image/png;base64," && kept["Docs"]?.startsWith("data:image/svg+xml") && kept["Plain page"] === "" && kept["Quiet page"] === "", kept);

  // A browser in a pane of its own: split the session, and open a fresh browser into the new pane.
  const { browserId: soloId } = await api.call("browsers.create", { spaceId: space.id, url: `${SITE}/search?q=pane` });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent === 'Browser')`), 10_000, "the fresh browser's row");
  await intoSession(c);
  await press(c, { key: "\\", code: "Backslash", keyCode: 220, meta: true });
  await until(() => evalIn(c, `document.querySelectorAll('.panehost .panel[data-empty]').length === 1`), 5_000, "an empty pane").catch(() => {});
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent === 'Browser').click(); return true; })()`);
  const solo = await until(() => evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel:not([data-tabbed])')].find((x) => x.querySelector('.panel-title')?.textContent === 'pane - Search');
    const img = p?.querySelector('.panel-icon img.page-icon'); return img && img.naturalWidth > 0 ? { src: img.getAttribute('src').slice(0, 22), box: [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)] } : null; })()`), 15_000, "the solo pane's mark").catch(() => null);
  check("a browser in its own pane wears its page's icon in the pane bar, where the glyph went", solo?.src === "data:image/png;base64," && solo.box.join() === "14,14", { solo, browserId: soloId });

  // ── 6. Recently visited and the suggestions ───────────────────────────────────────────────────
  await newTab(c);
  const recent = await until(() => evalIn(c, `(() => { const page = [...document.querySelectorAll('.new-tab')].find((p) => p.offsetParent !== null);
    const sec = page?.querySelector('[aria-label="Recently visited"]'); if (!sec) return null;
    return Object.fromEntries([...sec.querySelectorAll('.new-tab-row')].map((b) => [b.querySelector('.new-tab-row-label').textContent, ${MARK}(b)])); })()`), 10_000, "Recently visited").catch(() => null);
  check("a blank tab's Recently visited shows each page's icon, and the glyph for the page with none",
    recent?.["three - Search"] === "image/png" && recent?.["Docs"] === "image/svg+xml" && recent?.["Plain page"] === "glyph" && recent?.["Quiet page"] === "glyph", recent);
  await evalIn(c, `(() => { const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "search");
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const suggested = await until(() => evalIn(c, `(() => { const list = [...document.querySelectorAll('.browser-suggest')].find((l) => l.offsetParent !== null);
    if (!list) return null; const rows = [...list.querySelectorAll('[role=option]')];
    return rows.length > 1 ? rows.map((r) => ({ text: r.querySelector('.browser-suggest-title').textContent, icon: r.querySelector('img.page-icon')?.naturalWidth > 0 })) : null; })()`), 10_000, "suggestions").catch(() => null);
  check("the address suggestions show the page's icon on each visited page", !!suggested && suggested.filter((r) => r.text.endsWith("- Search")).length >= 2
    && suggested.filter((r) => r.text.endsWith("- Search")).every((r) => r.icon) && suggested.at(-1).icon === false, suggested);
  await evalIn(c, `(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.activeElement?.blur(); return true; })()`);

  // ── 7. Relaunched with the site down ──────────────────────────────────────────────────────────
  await shutDown();
  await new Promise((r) => site.close(() => r()));
  site = null;
  const asksBefore = requests.length;
  ({ c, m } = await launch());
  const restored = await until(async () => {
    const t = await tabs(c);
    return t.length >= 5 ? t : null;
  }, 30_000, "the restored tabs").catch(() => tabs(c));
  note("restored tabs, at first sight", restored);
  check("relaunched with the site down, each restored tab draws the icon Realm kept — nothing could have been fetched",
    restored.find((t) => t.name === "two - Search")?.icon?.decoded === true && restored.find((t) => t.name === "Docs")?.icon?.decoded === true
      && restored.find((t) => t.name === "Plain page")?.icon === null && restored.find((t) => t.name === "Quiet page")?.icon === null
      && requests.length === asksBefore, restored.map((t) => [t.name, t.icon?.type ?? "glyph"]));
  await sleep(4000); // the views try their pages, fail, and settle; the persist debounce passes
  const after = await tabs(c);
  const failed = await views(m);
  note("the views after their pages failed", failed);
  check("…and keeps it once its page has failed to load, rather than trading it for the glyph",
    after.find((t) => t.icon?.type === "image/png")?.icon?.decoded === true && after.find((t) => t.icon?.type === "image/svg+xml")?.icon?.decoded === true,
    after.map((t) => [t.name, t.icon?.type ?? "glyph"]));
  await shot(c, "relaunched-dark", await stripClip(c).catch(() => undefined));
}

async function teardown() {
  await shutDown().catch(() => {});
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  killPort(SITE_PORT);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
