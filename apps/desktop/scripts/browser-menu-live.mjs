/**
 * Live check for the browser pane's ⋯ menu (run with: pnpm build && node apps/desktop/scripts/browser-menu-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the fake agent, opens a session and a browser pane
 * beside it on a local fixture site, and drives the ⋯ menu the way a person does. The OS's own pieces —
 * the native menu, the print dialog, the confirm sheet, the Finder — are stubbed in MAIN over its
 * inspector, so the check needs no human and nothing is left on screen: the stub keeps the menu main
 * built, and the script clicks the row a person would, then closes it as the OS does. Everything about
 * a native view (where it sits, what it shows, its zoom, what it saved) is asked of main, because a
 * page cannot tell: views run unthrottled, so a hidden page still reads as visible to itself.
 *
 * What it proves, on a real page in a real pane:
 *   1. ⋯ pops ONE native menu, at the button, with the browser's rows; nothing opens in the DOM.
 *   2. Find in page: a strip above the view that pushes the view down, counts from the page itself,
 *      Return and ⇧Return stepping through them, Escape clearing the page's highlight.
 *   3. ⌘F pressed INSIDE the page opens the strip, the page never sees the key, and the keyboard lands
 *      in the find field; ⌘F in the chrome opens it too.
 *   4. Zoom in and Actual size change the VIEW's zoom, and the menu prints the level.
 *   5. Print reaches the view's print.
 *   6. Take a screenshot writes a PNG of the page into <space folder>/screenshots/ and puts it in the
 *      session's prompter.
 *   7. Downloads: a blocked file is saved from the menu into the project, then shown in the Finder.
 *   8. History lists the pane's own trail and goes where it is told.
 *   9. Clear browsing data asks first, as a sheet on the window: Cancel keeps the cookie, Clear takes it.
 *  10. Browser settings opens Settings on Sign-ins.
 *  11. Suggestions (Plan 26 W7c): typing in the address field lists the visited pages that match, most
 *      visited first, as a strip that pushes the view down; ↓ and Return open a page, the last row
 *      searches the web for the text, Escape closes the list, and Clear browsing data empties it.
 *  12. Annotate (Plan 26 W7d): every click in the page pins a numbered outline that stays, and the
 *      page's own toolbar counts them; Send captures the page WITH the pins and without the toolbar,
 *      lands one "3 annotations" chip and the capture in the session's prompter, and — sent — the
 *      agent is told each pin by its number. Escape ends it with nothing; a navigation says so.
 *
 * Ports: LIVE_SERVER_PORT (8961), LIVE_CDP_PORT (9361), LIVE_MAIN_INSPECT_PORT (9461), LIVE_SITE_PORT
 * (8971). Touches only a scratch dir; kills only what listens on its own ports. Browses nothing but its
 * own 127.0.0.1 fixture. Nothing is billed: the session is the fake agent's and is never sent a turn,
 * and REALM_ENABLE_FAKE_AGENT=1 keeps the titler and the recap off.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** Chromium's switches for a window that is covered or in the background: lay it out and run its timers
 *  anyway. Without them a window started from a background shell opens behind the front one, Chromium
 *  stops laying it out, and the browser pane — sized from that layout — gets no bounds at all. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8961);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9361);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9461);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8971);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-menu-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TITLE = "Browser menu live check";
const OUT = (tag) => path.join(os.tmpdir(), `realm-browser-menu-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;

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
    await sleep(150);
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

/* ---------------------------------- the fixture site ---------------------------------- */

/** Every page records the keys it was sent, so the check can say whether a ⌘F ever reached it. */
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body { font: 17px/1.6 -apple-system, sans-serif; margin: 0; color: #222; }
  nav { padding: 10px 24px; border-bottom: 1px solid #ddd; } nav a { margin-right: 18px; } main { padding: 8px 24px; }
</style></head><body><nav><a href="/">Home</a><a href="/docs">Docs</a><a href="/files">Files</a></nav><main>${body}</main>
<script>window.__keys = []; addEventListener("keydown", (e) => window.__keys.push((e.metaKey ? "Meta+" : "") + e.key), true);</script></body></html>`;

const ROUTES = {
  "/": () => page("Fixture", "<h1>Fixture</h1><p>An agent is a program that works for you. The agent reads this page, and each agent runs on your Mac.</p>"),
  "/docs": () => page("Docs — Fixture", "<h1>Docs</h1><p>Every setting lives in one file.</p>"),
  "/files": () => page("Files — Fixture", '<h1>Files</h1><p><a id="dl" href="/files/notes.txt">notes.txt</a></p>'),
  "/cookie": () => page("Cookie — Fixture", "<h1>Cookie</h1><p>This page set a cookie.</p>"),
  // Big targets with a link in each, so pinning one proves a click on a link changes nothing.
  "/list": () => page("List — Fixture", `<h1>List</h1><style>li { list-style: none; width: 340px; margin: 10px 0; padding: 14px 18px;
    border: 1px solid #ddd; border-radius: 8px; font-size: 18px; } li a { color: #222; }</style><ul style="padding:0">${
    [1, 2, 3, 4].map((n) => `<li id="i${n}"><a href="#item-${n}">Item ${n}</a></li>`).join("")}</ul>`),
};

function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (url.pathname === "/files/notes.txt") {
        res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="notes.txt"' });
        res.end("Notes from the fixture.\n");
        return;
      }
      const body = ROUTES[url.pathname]?.();
      const headers = { "content-type": "text/html" };
      if (url.pathname === "/cookie") headers["set-cookie"] = "realm_live=1; Path=/; Max-Age=3600";
      res.writeHead(body ? 200 : 404, headers);
      res.end(body ?? page("Not found", "<h1>Not found</h1>"));
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------------------------- the run ---------------------------------- */

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();

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
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");

  /* Main's own inspector: the one place that knows where a native view is, and where the OS's pieces
     can be stood in for. The window is sized there rather than emulated in the renderer, because the
     view's bounds are derived from the renderer's devicePixelRatio and an emulated one would size the
     view for a display it is not on. */
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const mainC = cdp(mainTarget.webSocketDebuggerUrl); await mainC.ready;
  const mainEval = async (expr) => {
    const r = await mainC.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const stubs = await mainEval(`(() => {
    const { Menu, dialog, shell, BrowserWindow } = require("electron");
    const L = globalThis.__live = { menus: [], prints: 0, dialogs: [], dialogAnswer: 1, revealed: [], stops: [] };
    Menu.prototype.popup = function (opts) { L.menus.push({ menu: this, opts: opts || {} }); };
    const fakeBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      L.dialogs.push({ attached: args.length > 1, message: o.message, detail: o.detail, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId });
      return { response: L.dialogAnswer, checkboxChecked: false };
    };
    dialog.showMessageBox = fakeBox;
    shell.showItemInFolder = (p) => { L.revealed.push(p); };
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1500, 920);
    return { menu: Menu.prototype.popup.toString().includes("L.menus"), dialog: dialog.showMessageBox === fakeBox, shell: shell.showItemInFolder.toString().includes("L.revealed") };
  })()`);
  check("main's OS pieces are stood in for, so nothing waits on a person", stubs.menu && stubs.dialog && stubs.shell, stubs);

  /** What main says about the fixture's native view: where it is, whether it is shown, its zoom. */
  const view = () => mainEval(`(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView)) continue;
      const url = v.webContents.getURL();
      if (!url.startsWith(${JSON.stringify(SITE)})) continue;
      return { url, shown: v.getVisible(), bounds: v.getBounds(), zoom: v.webContents.getZoomFactor(), wcId: v.webContents.id };
    }
    return null;
  })()`);
  const inView = (js) => mainEval(`(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children)
      if (v instanceof WebContentsView && v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) return v.webContents.executeJavaScript(${JSON.stringify(js)});
    return null;
  })()`);
  /** The last menu main was asked to pop: its rows as the OS would draw them, and where. */
  const lastMenu = () => mainEval(`(() => {
    const L = globalThis.__live; const last = L.menus[L.menus.length - 1]; if (!last) return null;
    const rows = (items) => items.map((i) => ({ label: i.label, type: i.type, enabled: i.enabled, checked: i.checked, accelerator: i.accelerator ?? null, sub: i.submenu ? rows(i.submenu.items) : null }));
    return { count: L.menus.length, rows: rows(last.menu.items), x: last.opts.x, y: last.opts.y, window: !!last.opts.window };
  })()`);
  /** Click a row the way a person does in the OS's menu, then close it as the OS does. A row that is
   *  not there, or not enabled, is a FAIL of its own rather than a silent no-op. */
  const clickRow = async (labels) => {
    const r = await clickRowRaw(labels);
    if (r !== "ok") check(`the menu has an enabled row ${labels.join(" › ")}`, false, r);
    return r === "ok";
  };
  const clickRowRaw = (labels) => mainEval(`(() => {
    const L = globalThis.__live; const last = L.menus[L.menus.length - 1]; if (!last) return "no menu";
    let items = last.menu.items, item = null;
    for (const label of ${JSON.stringify(labels)}) {
      item = items.find((i) => i.label === label);
      if (!item) return "no row " + label + " in " + items.map((i) => i.label).join(" | ");
      items = item.submenu ? item.submenu.items : [];
    }
    if (!item.enabled) return "disabled: " + item.label;
    item.click();
    if (last.opts.callback) last.opts.callback();
    return "ok";
  })()`);
  const dismissMenu = () => mainEval(`(() => { const L = globalThis.__live; const last = L.menus[L.menus.length - 1]; if (last?.opts.callback) last.opts.callback(); return true; })()`);
  /** Press ⋯ in the pane and wait for main to be asked for a menu. */
  const openMenu = async () => {
    const before = (await lastMenu())?.count ?? 0;
    await evalIn(c, `(() => { document.querySelector('.browser-pane .browser-more').click(); return true; })()`);
    return until(async () => { const m = await lastMenu(); return m && m.count > before ? m : null; }, 10_000, "a native menu");
  };
  const choose = async (labels) => {
    await openMenu();
    const ok = await clickRow(labels);
    await sleep(300);
    return ok;
  };

  // ── Onboarding makes the space. Its first session runs a REAL engine, so nothing is typed there. ──
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // A project, so a saved download has somewhere to go: `<project root>/downloads`, as the agent's do.
  await api.call("projects.create", { spaceId: space.id, name: "Live", rootPath: space.folderPath });
  const { session: fakeSession } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.panel-title')].some((t) => t.textContent === ${JSON.stringify(TITLE)})`), 10_000, "session pane");
  // A browser BESIDE the session, from the session's own bar — the way a person opens one to look at
  // something while the session works.
  const opened = await evalIn(c, `(() => {
    const b = document.querySelector('[aria-label=${JSON.stringify(`Open a browser beside ${TITLE}`)}]');
    if (b) { b.click(); return "bar"; }
    return null; })()`);
  if (!opened) {
    await evalIn(c, `(() => { document.querySelector('[aria-label=${JSON.stringify(`Pane menu for ${TITLE}`)}]').click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('[role=menuitem]')`), 5_000, "pane menu");
    await evalIn(c, `(() => { [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.includes("Browser")).click(); return true; })()`);
  }
  await until(() => evalIn(c, `!!document.querySelector('.browser-pane input[aria-label=Address]')`), 10_000, "browser pane");
  const go = async (pathname) => {
    await evalIn(c, `(() => {
      const input = document.querySelector('.browser-pane input[aria-label=Address]');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(`${SITE}${pathname}`)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form").requestSubmit(); return true; })()`);
    return until(async () => { const v = await view(); return v && v.url === `${SITE}${pathname}` && v.shown && v.bounds.width > 0 ? v : null; }, 20_000, `${pathname} on screen`);
  };
  await go("/");
  await sleep(600);
  // The pane's first page is the first page: Realm's own about:blank bootstrap is not something to go
  // Back to.
  check("the first page has no Back — Realm's blank bootstrap page is not in the trail",
    await evalIn(c, `document.querySelector('.browser-pane button[aria-label=Back]').disabled`));

  // ── 1. One native menu, at the button, with a browser's rows ──────────────────────────────────
  const menu = await openMenu();
  const button = await evalIn(c, `(() => { const r = document.querySelector('.browser-pane .browser-more').getBoundingClientRect();
    return { left: Math.round(r.left), bottom: Math.round(r.bottom), lit: document.querySelector('.browser-more').hasAttribute('data-on'),
      last: document.querySelector('.browser-chrome').lastElementChild === document.querySelector('.browser-more'),
      domMenu: !!document.querySelector('[role=menu]') }; })()`);
  const labels = menu.rows.map((r) => r.label || "—");
  note("the ⋯ menu", labels);
  check("⋯ is the last control in the browser's toolbar", button.last, button);
  check("⋯ pops the OS's menu at its own bottom-left, on this window", Math.abs(menu.x - button.left) <= 1 && Math.abs(menu.y - button.bottom) <= 1 && menu.window, { menu: { x: menu.x, y: menu.y }, button });
  check("…and nothing opens in the window's DOM, which the page would paint over", !button.domMenu);
  check("the button is lit while its menu is up", button.lit);
  check("the rows are the browser's: find, print, zoom, screenshot, downloads, history, clear, settings",
    JSON.stringify(labels) === JSON.stringify(["Find in page…", "Print…", "—", "Zoom out", "Actual size (100%)", "Zoom in", "—", "Take a screenshot", "—", "Downloads", "History", "—", "Clear browsing data…", "Browser settings"]), labels);
  check("Find shows its shortcut", menu.rows[0].accelerator === "CmdOrCtrl+F", menu.rows[0]);
  check("no cookie or password import is offered (Plan 26 D3)", !JSON.stringify(menu.rows).match(/import|password/i));
  await dismissMenu();
  await sleep(300);
  check("dismissed, the button goes dark", !(await evalIn(c, `document.querySelector('.browser-more').hasAttribute('data-on')`)));

  // ── 2. Find in page ───────────────────────────────────────────────────────────────────────────
  await mainEval(`(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView) || !v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) continue;
      const wc = v.webContents, stop = wc.stopFindInPage.bind(wc);
      wc.stopFindInPage = (a) => { globalThis.__live.stops.push(a); return stop(a); };
      wc.print = (_o, cb) => { globalThis.__live.prints++; if (cb) cb(true, ""); };
    }
    return true; })()`);
  await choose(["Find in page…"]);
  const strip = await until(() => evalIn(c, `(() => { const s = document.querySelector('.browser-find'); if (!s) return null;
    const host = document.querySelector('.browser-view-host').getBoundingClientRect();
    return { focused: document.activeElement === s.querySelector('input'), bottom: s.getBoundingClientRect().bottom, hostTop: host.top, inHost: !!document.querySelector('.browser-view-host .browser-find') }; })()`), 5_000, "find strip");
  check("Find in page opens a strip, with the keyboard in its field", strip.focused, strip);
  const type = (text) => evalIn(c, `(() => { const input = document.querySelector('.browser-find input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const count = () => evalIn(c, `document.querySelector('.browser-find-count')?.textContent ?? null`);
  await type("agent");
  const first = await until(async () => { const t = await count(); return t && /of/.test(t) ? t : null; }, 5_000, "a count").catch(() => count());
  check("the page itself counts the matches: 1 of 3", first === "1 of 3", first);
  await sleep(400); // the view's bounds follow the strip on the next frame
  const pushed = await view();
  check("the strip sits ABOVE the view, and the view gives up its height to it",
    !strip.inHost && pushed.bounds.y >= Math.floor(strip.bottom) - 1 && Math.abs(pushed.bounds.y - strip.hostTop) <= 1, { stripBottom: strip.bottom, hostTop: strip.hostTop, viewY: pushed.bounds.y });
  const key = async (k, modifiers = 0) => {
    const named = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
    for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", {
      type, key: k, code: k in named ? k : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: named[k] ?? k.toUpperCase().charCodeAt(0), modifiers,
      // Return's character is what a form's implicit submission listens for; a bare key-down never sends it.
      ...(type === "keyDown" && k === "Enter" ? { text: "\r" } : {}),
    });
  };
  await key("Enter");
  const second = await until(async () => { const t = await count(); return t === "2 of 3" ? t : null; }, 5_000, "2 of 3").catch(() => count());
  check("Return steps to the next match", second === "2 of 3", second);
  await shotView(mainEval, "find-page");
  await shot(c, "find-chrome");
  await key("Enter", 8);
  const back = await until(async () => { const t = await count(); return t === "1 of 3" ? t : null; }, 5_000, "back to 1 of 3").catch(() => count());
  check("⇧Return steps back", back === "1 of 3", back);
  await type("nowhere-to-be-found");
  const none = await until(async () => { const t = await count(); return t === "No matches" ? t : null; }, 5_000, "no matches").catch(() => count());
  check("a word the page does not have says so", none === "No matches", none);
  await key("Escape");
  await sleep(300);
  const closed = await evalIn(c, `!document.querySelector('.browser-find')`);
  const stops = await mainEval(`globalThis.__live.stops.slice()`);
  check("Escape closes the strip and clears the page's highlight", closed && stops.includes("clearSelection"), { closed, stops });
  await sleep(300);
  check("…and the view takes its height back", Math.abs((await view()).bounds.y - (await evalIn(c, `document.querySelector('.browser-view-host').getBoundingClientRect().top`))) <= 1);

  // ── 3. ⌘F from inside the page, and from the chrome ───────────────────────────────────────────
  await inView(`window.__keys.length = 0; true`);
  const fromPage = await mainEval(`(async () => {
    const { BrowserWindow, WebContentsView, webContents } = require("electron");
    const win = BrowserWindow.getAllWindows()[0];
    // Every hand-off of the keyboard to the window's own page, in order with the relay to the pane.
    const L = globalThis.__live; L.windowFocus = 0;
    const focus = win.webContents.focus.bind(win.webContents);
    win.webContents.focus = () => { L.windowFocus++; return focus(); };
    for (const v of win.contentView.children) {
      if (!(v instanceof WebContentsView) || !v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) continue;
      v.webContents.focus();
      await new Promise((r) => setTimeout(r, 150));
      // Which webContents holds the keyboard is only answered while this app is the ACTIVE one; with
      // another app in front the answer is null whoever holds it, and a background launch cannot
      // take the front (macOS refuses the activation).
      const active = BrowserWindow.getFocusedWindow() !== null;
      const before = webContents.getFocusedWebContents()?.id === v.webContents.id;
      v.webContents.sendInputEvent({ type: "keyDown", keyCode: "f", modifiers: ["meta"] });
      v.webContents.sendInputEvent({ type: "keyUp", keyCode: "f", modifiers: ["meta"] });
      await new Promise((r) => setTimeout(r, 400));
      return { active, pageHadKeyboard: before, windowHasKeyboard: webContents.getFocusedWebContents()?.id === win.webContents.id, windowFocused: L.windowFocus };
    }
    return null; })()`);
  const fromPageStrip = await until(() => evalIn(c, `(() => { const s = document.querySelector('.browser-find'); return s ? { focused: document.activeElement === s.querySelector('input') } : null; })()`), 5_000, "find from the page").catch(() => null);
  const pageKeys = await inView(`window.__keys.slice()`);
  check("⌘F pressed inside the page opens the find strip, its field focused", !!fromPageStrip?.focused, { fromPage, fromPageStrip });
  check("…the page never sees the ⌘F", !(pageKeys ?? []).some((k) => /^Meta\+f$/i.test(k)), pageKeys);
  check("…and main hands the keyboard to the window's own page before the pane focuses its field", fromPage?.windowFocused === 1, fromPage);
  if (fromPage?.active) {
    check("…which moves the keyboard out of the site and into the find field", fromPage.pageHadKeyboard && fromPage.windowHasKeyboard, fromPage);
  } else {
    note("the keyboard's OS-level home was not read: another app is in front, and macOS does not let a background launch take it", fromPage);
  }
  await key("Escape");
  await until(() => evalIn(c, `!document.querySelector('.browser-find')`), 5_000, "find closed");
  // From the chrome: a real click in the address field (which also makes this pane the focused one), then ⌘F.
  const addr = await evalIn(c, `(() => { const r = document.querySelector('.browser-pane input[aria-label=Address]').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: addr.x, y: addr.y, button: "left", clickCount: 1 });
  await sleep(200);
  await key("f", 4);
  const fromChrome = await until(() => evalIn(c, `!!document.querySelector('.browser-find')`), 5_000, "find from the chrome").catch(() => false);
  check("⌘F in the address field opens it too", fromChrome);
  await key("Escape");
  await until(() => evalIn(c, `!document.querySelector('.browser-find')`), 5_000, "find closed again");

  // ── 4. Zoom ───────────────────────────────────────────────────────────────────────────────────
  await choose(["Zoom in"]);
  const zoomed = await until(async () => { const v = await view(); return v && Math.abs(v.zoom - 1.1) < 0.001 ? v : null; }, 5_000, "zoom 110%").catch(() => view());
  check("Zoom in zooms the VIEW one rung, to 110%", Math.abs(zoomed.zoom - 1.1) < 0.001, zoomed.zoom);
  const zoomMenu = await openMenu();
  const reset = zoomMenu.rows.find((r) => (r.label ?? "").startsWith("Actual size"));
  check("the menu prints the level the page is at", reset?.label === "Actual size (110%)" && reset.enabled, reset);
  await clickRow(["Actual size (110%)"]);
  const actual = await until(async () => { const v = await view(); return v && Math.abs(v.zoom - 1) < 0.001 ? v : null; }, 5_000, "zoom 100%").catch(() => view());
  check("Actual size puts it back at 100%", Math.abs(actual.zoom - 1) < 0.001, actual.zoom);

  // ── 5. Print ──────────────────────────────────────────────────────────────────────────────────
  await choose(["Print…"]);
  check("Print reaches the view's own print", (await mainEval(`globalThis.__live.prints`)) === 1);

  // ── 6. Take a screenshot ──────────────────────────────────────────────────────────────────────
  const shotsDir = path.join(space.folderPath, "screenshots");
  // Read before the shot: the receipt that follows it is a strip above the view, and takes its height.
  const vb = (await view()).bounds;
  await choose(["Take a screenshot"]);
  const shots = await until(() => (fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((n) => n.endsWith(".png")) : null)?.length ? fs.readdirSync(shotsDir) : null, 10_000, "a screenshot file").catch(() => []);
  const file = shots[0] ? path.join(shotsDir, shots[0]) : null;
  const png = file ? fs.readFileSync(file) : null;
  const dims = png ? { w: png.readUInt32BE(16), h: png.readUInt32BE(20) } : null;
  check("Take a screenshot writes a PNG of the page into the space's screenshots/ folder",
    !!png && png.subarray(1, 4).toString() === "PNG" && /^127\.0\.0\.1-\d+-\d{4}-\d\d-\d\dT/.test(shots[0]), { file, dims });
  check("…the page as the pane shows it — the view's own size, at the display's scale",
    !!dims && dims.w > 0 && Math.abs(dims.w / vb.width - Math.round(dims.w / vb.width)) < 0.02 && Math.abs(dims.h / vb.height - dims.w / vb.width) < 0.02, { dims, view: vb });
  if (file) { fs.copyFileSync(file, OUT("screenshot-file")); console.log(`SCREENSHOT screenshot-file ${OUT("screenshot-file")}`); }
  const attached = await until(() => evalIn(c, `(() => {
    const pane = [...document.querySelectorAll('.panehost .panel')].find((p) => p.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)});
    const list = pane?.querySelector('.composer-attachments');
    return list && list.children.length > 0 ? { count: list.children.length, text: list.textContent, html: list.innerHTML.slice(0, 300) } : null; })()`), 5_000, "the attachment").catch(() => null);
  const toast = await evalIn(c, `document.querySelector('.browser-toast')?.textContent ?? null`);
  check("…and it is in the session's prompter, the way a dropped file is", !!attached, attached);
  check("…with a receipt that names the file and the session", toast === `Added ${shots[0]} to ${TITLE}.`, toast);
  await shot(c, "screenshot-attached");

  // ── 7. Downloads ──────────────────────────────────────────────────────────────────────────────
  await go("/files");
  await sleep(500);
  await inView(`document.getElementById("dl").click(); true`);
  const blocked = await until(() => evalIn(c, `[...document.querySelectorAll('.browser-notice')].map((n) => n.textContent).find((t) => t.includes("notes.txt")) ?? null`), 10_000, "blocked bar").catch(() => null);
  check("a download the page starts is blocked, and the bar says so", !!blocked && blocked.includes("Blocked a download"), blocked);
  const dlMenu = await openMenu();
  const dlRows = dlMenu.rows.find((r) => r.label === "Downloads")?.sub?.map((r) => r.label);
  check("the menu's Downloads offers to save what was blocked", JSON.stringify(dlRows) === JSON.stringify(["Save notes.txt"]), dlRows);
  await clickRow(["Downloads", "Save notes.txt"]);
  const savedPath = path.join(space.folderPath, "downloads", "notes.txt");
  // The bar's own receipt is what says the download FINISHED: the file can be on disk a moment before
  // Chromium reports it done, and the pane learns it was saved from that report.
  const savedNote = await until(() => evalIn(c, `[...document.querySelectorAll('.browser-notice')].map((n) => n.textContent).find((t) => t.includes("Saved notes.txt")) ?? null`), 15_000, "saved receipt").catch(() => null);
  const saved = fs.existsSync(savedPath);
  check("…and saving it from the menu puts the file in the project's downloads/", !!savedNote && saved && fs.readFileSync(savedPath, "utf8").startsWith("Notes"), { savedNote, savedPath });
  const showMenu = await openMenu();
  const showRows = showMenu.rows.find((r) => r.label === "Downloads")?.sub?.map((r) => r.label);
  check("then Downloads lists it as saved", JSON.stringify(showRows) === JSON.stringify(["Show notes.txt in Finder"]), showRows);
  await clickRow(["Downloads", "Show notes.txt in Finder"]);
  await sleep(300);
  const revealed = await mainEval(`globalThis.__live.revealed.slice()`);
  check("…and Show in Finder selects that file", revealed.some((p) => fs.realpathSync(p) === fs.realpathSync(savedPath)), revealed);

  // ── 8. History ────────────────────────────────────────────────────────────────────────────────
  await go("/docs");
  await sleep(400);
  const hMenu = await openMenu();
  const hRows = hMenu.rows.find((r) => r.label === "History")?.sub ?? [];
  note("History", hRows.map((r) => `${r.checked ? "✓ " : ""}${r.label}${r.enabled ? "" : " (off)"}`));
  const current = hRows.find((r) => r.checked);
  check("History ticks the page the pane is on, and it is not a row to choose", current?.label === "Docs — Fixture" && current.enabled === false, current);
  check("…and lists the pages behind it, nearest first", hRows.map((r) => r.label).join(" | ").includes("Docs — Fixture | Files — Fixture | Fixture"), hRows.map((r) => r.label));
  check("…without Realm's own blank bootstrap page among them", !hRows.some((r) => r.label === "about:blank"), hRows.map((r) => r.label));
  await clickRow(["History", "Fixture"]);
  const wentBack = await until(async () => { const v = await view(); return v?.url === `${SITE}/` ? v : null; }, 10_000, "history step").catch(() => view());
  check("choosing a page goes there", wentBack?.url === `${SITE}/`, wentBack?.url);

  // ── 11. Suggestions under the address field ─────────────────────────────────────────────────
  /** Click into the address field for real — which selects what is in it — and type over it. */
  const typeAddress = async (text) => {
    const at = await evalIn(c, `(() => { const r = document.querySelector('.browser-pane input[aria-label=Address]').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    await sleep(150);
    // The click leaves a caret where it landed; select the address so the typing replaces it, as ⌘A would.
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
    if (text) await c.send("Input.insertText", { text });
    await sleep(400); // the list waits for typing to pause, then asks the server
  };
  const suggestions = () => evalIn(c, `(() => { const l = document.querySelector('.browser-suggest'); if (!l) return null;
    return { rows: [...l.querySelectorAll('[role=option]')].map((o) => ({ title: o.querySelector('.browser-suggest-title')?.textContent ?? "", url: o.querySelector('.browser-suggest-url')?.textContent ?? null, selected: o.getAttribute('aria-selected') === 'true' })),
      bottom: l.getBoundingClientRect().bottom, inHost: !!document.querySelector('.browser-view-host .browser-suggest'),
      hostTop: document.querySelector('.browser-view-host').getBoundingClientRect().top }; })()`);
  await typeAddress("");
  check("focusing the address field alone opens no list", (await suggestions()) === null);
  await key("Escape");
  await typeAddress("fixture");
  const list = await until(suggestions, 5_000, "suggestions").catch(() => null);
  note("suggestions for \"fixture\"", list?.rows.map((r) => `${r.title}${r.url ? ` · ${r.url}` : ""}`));
  check("typing lists the pages this profile visited, the one gone back to most first, then a web search",
    JSON.stringify(list?.rows.map((r) => r.title)) === JSON.stringify(["Fixture", "Docs — Fixture", "Files — Fixture", "Search the web for “fixture”"]), list?.rows);
  await sleep(300);
  const under = await view();
  // Anything else above the view (the download bar from step 7 is still up) sits between the two, so
  // the test is that the list ends above where the view begins, and the view begins where its host does.
  check("the list is a strip ABOVE the view, and the view gives up its height to it",
    !!list && !list.inHost && list.bottom <= list.hostTop + 1 && Math.abs(under.bounds.y - list.hostTop) <= 1, { listBottom: list?.bottom, hostTop: list?.hostTop, viewY: under.bounds.y });
  const edges = await evalIn(c, `(() => { const row = document.querySelector('.browser-suggest [role=option]').getBoundingClientRect();
    const field = document.querySelector('.browser-pane input[aria-label=Address]').getBoundingClientRect();
    return { rowLeft: Math.round(row.left), rowRight: Math.round(row.right), fieldLeft: Math.round(field.left), fieldRight: Math.round(field.right) }; })()`);
  check("its rows hang from the field's own edges, so the list reads as the field's", Math.abs(edges.rowLeft - edges.fieldLeft) <= 1 && Math.abs(edges.rowRight - edges.fieldRight) <= 1, edges);
  await shot(c, "suggestions");
  await key("ArrowDown");
  await key("ArrowDown");
  const moved = await suggestions();
  check("↓ moves through the rows", moved?.rows[1]?.selected === true && moved.rows.filter((r) => r.selected).length === 1, moved?.rows);
  await key("Enter");
  const picked = await until(async () => { const v = await view(); return v?.url === `${SITE}/docs` ? v : null; }, 10_000, "suggestion opened").catch(() => view());
  check("Return opens the row it is on", picked?.url === `${SITE}/docs`, picked?.url);
  check("…and the list goes with it", (await suggestions()) === null);
  await typeAddress("fix");
  await until(suggestions, 5_000, "suggestions again");
  await key("Escape");
  await sleep(200);
  const restored = await evalIn(c, `({ list: !!document.querySelector('.browser-suggest'), value: document.querySelector('.browser-pane input[aria-label=Address]').value })`);
  check("Escape closes the list and puts the page's own address back", !restored.list && restored.value === `${SITE}/docs`, restored);
  // The web search row: the typed text searched, even though it reads like a word on this site. The
  // search engine is never actually reached — the view's load is stood in for — because this check
  // browses nothing but its own fixture.
  await mainEval(`(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView) || !v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) continue;
      const wc = v.webContents, load = wc.loadURL.bind(wc);
      globalThis.__live.loads = [];
      wc.loadURL = (url, opts) => { globalThis.__live.loads.push(url); return url.startsWith(${JSON.stringify(SITE)}) ? load(url, opts) : Promise.resolve(); };
    }
    return true; })()`);
  await typeAddress("fixture");
  await until(suggestions, 5_000, "suggestions for the search");
  for (let i = 0; i < 6; i++) await key("ArrowDown");
  const onSearch = await suggestions();
  check("the last row is the search, and ↓ stops there", onSearch?.rows.at(-1)?.selected === true, onSearch?.rows.map((r) => r.selected));
  await key("Enter");
  await sleep(500);
  const loads = await mainEval(`globalThis.__live.loads.slice()`);
  check("…and Return on it searches the web for exactly what was typed", loads.includes("https://www.google.com/search?q=fixture"), loads);
  await go("/");

  // ── 9. Clear browsing data ────────────────────────────────────────────────────────────────────
  await go("/cookie");
  const cookies = () => mainEval(`require("electron").session.fromPartition("persist:browser").cookies.get({ url: ${JSON.stringify(SITE)} }).then((cs) => cs.map((c) => c.name))`);
  check("the fixture's cookie is in the browser's partition", (await cookies()).includes("realm_live"), await cookies());
  await mainEval(`globalThis.__live.dialogAnswer = 1; true`);
  await choose(["Clear browsing data…"]);
  await sleep(500);
  const dialogs = await mainEval(`globalThis.__live.dialogs.slice()`);
  const d0 = dialogs[0];
  check("Clear browsing data asks first, as a sheet on the window, with Cancel the default", dialogs.length === 1 && d0.attached && d0.defaultId === 1 && d0.cancelId === 1 && d0.buttons?.[1] === "Cancel", d0);
  check("…naming what it does: every pane signed out, sign-ins and passkeys kept", /every browser pane/.test(d0?.message ?? "") && /signed out/.test(d0?.detail ?? "") && /Saved sign-ins and passkeys/.test(d0?.detail ?? ""), d0);
  check("Cancel keeps the cookie", (await cookies()).includes("realm_live"), await cookies());
  await mainEval(`globalThis.__live.dialogAnswer = 0; true`);
  await choose(["Clear browsing data…"]);
  const gone = await until(async () => !(await cookies()).includes("realm_live"), 5_000, "cookie cleared").catch(() => false);
  check("Clear takes it", gone, await cookies());
  const clearedToast = await until(() => evalIn(c, `document.querySelector('.browser-toast')?.textContent ?? null`), 3_000, "clear receipt").catch(() => null);
  check("…and the pane says every browser pane is signed out", /Every browser pane is signed out/.test(clearedToast ?? ""), clearedToast);
  await typeAddress("fixture");
  const afterClear = await until(suggestions, 5_000, "suggestions after clearing").catch(() => null);
  check("…and the address field has forgotten the pages: only the web search is left", JSON.stringify(afterClear?.rows.map((r) => r.title)) === JSON.stringify(["Search the web for “fixture”"]), afterClear?.rows);
  await key("Escape");

  // ── 12. Annotate ──────────────────────────────────────────────────────────────────────────────
  await go("/list");
  await sleep(400);
  /** A real click in the VIEW, the way a hand makes one: the move, then the press and the release. */
  const clickInView = (pt) => mainEval(`(async () => {
    const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView) || !v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) continue;
      const wc = v.webContents, at = { x: ${pt.x}, y: ${pt.y} };
      wc.sendInputEvent({ type: "mouseMove", ...at });
      await new Promise((r) => setTimeout(r, 40));
      wc.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 200));
      return true;
    }
    return false; })()`);
  const centreOf = (js) => inView(`(() => { const r = (${js}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const annotateLit = () => evalIn(c, `document.querySelector('.browser-pane button[aria-label=Annotate]')?.getAttribute('aria-pressed')`);
  const barText = () => inView(`document.querySelector('[role=toolbar][aria-label=Annotate]')?.textContent ?? null`);
  const pressAnnotate = () => evalIn(c, `(() => { document.querySelector('.browser-pane button[aria-label=Annotate]').click(); return true; })()`);
  await pressAnnotate();
  const armedBar = await until(barText, 5_000, "the page's annotate toolbar").catch(() => null);
  check("Annotate arms the page: its own toolbar is up in the page, and the pane's button is lit", !!armedBar?.includes("click to pin") && (await annotateLit()) === "true", { armedBar });
  for (const n of [1, 2, 3]) await clickInView(await centreOf(`document.getElementById("i${n}")`));
  const pinned = await until(async () => { const t = await barText(); return t?.includes("Annotating · 3") ? t : null; }, 5_000, "three pins").catch(() => barText());
  check("every click pins one and numbers it, and the toolbar counts them", !!pinned?.includes("Annotating · 3"), pinned);
  check("…and pinning a link changed nothing about the page", (await view())?.url === `${SITE}/list`, (await view())?.url);
  const geometry = await inView(`(() => {
    const bar = document.querySelector('[role=toolbar][aria-label=Annotate]');
    const pins = [...bar.parentElement.children[1].children].map((b) => { const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, n: b.textContent }; });
    const r = bar.getBoundingClientRect();
    return { bar: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, pins, viewport: { w: innerWidth, h: innerHeight } };
  })()`);
  check("three numbered outlines stay on the page, one per pin", geometry.pins.length === 3 && geometry.pins.map((p) => p.n).join() === "1,2,3", geometry.pins);
  await shotView(mainEval, "annotate-page");
  const shotsBefore = new Set(fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : []);
  await clickInView(await centreOf(`[...document.querySelectorAll('[role=toolbar][aria-label=Annotate] button')].find((b) => b.textContent === "Send")`));
  const capture = await until(() => (fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : []).find((f) => !shotsBefore.has(f) && f.endsWith("-annotations.png")) ?? null, 10_000, "the annotated capture").catch(() => null);
  const capturePath = capture ? path.join(shotsDir, capture) : null;
  check("Send writes the page as it looked, pins and all, into the space's screenshots/ folder", !!capturePath, capture);
  if (capturePath) { fs.copyFileSync(capturePath, OUT("annotate-capture")); console.log(`SCREENSHOT annotate-capture ${OUT("annotate-capture")}`); }
  // Read the capture's own pixels: the pins must be in it and Realm's toolbar must not.
  const pixels = capturePath ? await mainEval(`(() => {
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromPath(${JSON.stringify(capturePath)});
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const k = width / ${geometry.viewport.w};
    const at = (x, y) => { const i = (Math.round(y * k) * width + Math.round(x * k)) * 4; return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i] }; };
    const p1 = ${JSON.stringify(geometry.pins[0] ?? null)};
    // The badge is centred on the outline's corner with its white digit in the middle, so its fill is
    // read beside the digit rather than on it.
    return { toolbar: at(${geometry.bar.x}, ${geometry.bar.y}), badge: p1 ? at(p1.left - 7, p1.top) : null, border: p1 ? at(p1.left + 1, p1.top + p1.height / 2) : null };
  })()`) : null;
  note("capture pixels", pixels);
  const blue = (px) => !!px && px.b > 150 && px.b > px.r + 40;
  check("…the capture shows the numbered pins in the accent", blue(pixels?.badge) && blue(pixels?.border), pixels);
  check("…and not the toolbar, which is Realm's, not the page's", !!pixels && pixels.toolbar.r > 200 && pixels.toolbar.g > 200 && pixels.toolbar.b > 200, pixels?.toolbar);
  const after = await until(async () => ((await barText()) === null && (await annotateLit()) === "false" ? true : null), 5_000, "annotate taken down").catch(() => false);
  check("Send takes the pins and the toolbar off the page and puts the button out", after);
  const landed = await until(() => evalIn(c, `(() => {
    const pane = [...document.querySelectorAll('.panehost .panel')].find((p) => p.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)});
    const draft = pane?.querySelector('textarea')?.value ?? "";
    const files = [...(pane?.querySelectorAll('.composer-attachments li') ?? [])].map((li) => li.textContent);
    return draft.includes("@[3 annotations]") ? { draft, files, toast: document.querySelector('.browser-toast')?.textContent ?? null } : null; })()`), 5_000, "the chip in the prompter").catch(() => null);
  check("…and ONE chip, \"3 annotations\", is waiting in the session's prompter", !!landed && (landed.draft.match(/@\[/g) ?? []).length === 1, landed?.draft);
  check("…with the capture of the pins attached beside it", !!landed?.files.some((f) => f.includes(capture ?? "nothing")), landed?.files);
  check("…and a receipt that names the chip and the session", landed?.toast === `Added 3 annotations to ${TITLE}.`, landed?.toast);
  await shot(c, "annotate-prompter");
  // Sent for real, through the composer: the fake agent echoes what it was handed, which is the message
  // plus what the chip stands for — so this reads exactly what an agent would be told.
  const box = await evalIn(c, `(() => { const pane = [...document.querySelectorAll('.panehost .panel')].find((p) => p.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)});
    const r = pane.querySelector('textarea').getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(200);
  await key("Enter");
  const echoed = await until(async () => {
    const evs = await api.call("sessions.events", { id: fakeSession.id, afterSeq: 0, limit: 500 });
    return evs.map((e) => e.event).find((e) => e.type === "assistant_text" && e.payload.text.includes("@[3 annotations] pin 3"))?.payload.text ?? null;
  }, 15_000, "the agent's echo").catch(() => null);
  check("the agent is told each pin by its number, under one token", !!echoed && [1, 2, 3].every((n) => echoed.includes(`@[3 annotations] pin ${n}\nurl: ${SITE}/list`)) && (echoed.match(/ {2}@\[3 annotations\] — /g) ?? []).length === 1, echoed?.slice(0, 600));
  check("…and which attached file shows the numbers", !!echoed?.includes(`the attached ${capture} shows each number`), echoed?.match(/An annotation chip[^\n]*/)?.[0]);
  // Escape in the page ends it with nothing; a navigation ends it and says so.
  await pressAnnotate();
  await until(barText, 5_000, "armed again");
  await mainEval(`(() => { const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children)
      if (v instanceof WebContentsView && v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) { v.webContents.focus(); v.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); v.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); }
    return true; })()`);
  const escaped = await until(async () => ((await barText()) === null && (await annotateLit()) === "false" ? true : null), 5_000, "escaped").catch(() => false);
  check("Escape in the page ends annotating, with nothing sent", escaped && !(await evalIn(c, `document.querySelector('.browser-toast')?.textContent?.includes("annotation") ?? false`)));
  await pressAnnotate();
  await until(barText, 5_000, "armed a third time");
  await clickInView(await centreOf(`document.getElementById("i4")`));
  await go("/");
  const leftToast = await until(() => evalIn(c, `document.querySelector('.browser-toast')?.textContent ?? null`), 5_000, "left toast").catch(() => null);
  check("a navigation ends it and says the pins went with the page", leftToast === "The page changed, so its pins were cleared." && (await annotateLit()) === "false", leftToast);

  // ── 10. Browser settings ──────────────────────────────────────────────────────────────────────
  await choose(["Browser settings"]);
  const settings = await until(() => evalIn(c, `(() => { const r = document.querySelector('.settings-page-pane input[name=settings-page-tab]:checked'); return r ? r.value : null; })()`), 5_000, "settings page").catch(() => null);
  check("Browser settings opens Settings on Sign-ins", settings === "signins", settings);
  await sleep(400);
  check("…and the page's view steps aside while Settings is over it", (await view())?.shown === false);
  await shot(c, "settings-signins");

  c.close();
  mainC.close();
}

/** The window as the renderer draws it. A native view is not in a DOM capture: its rectangle shows the
 *  pane's own ground, which is what makes this the picture of the CHROME — the strip, the toast. */
async function shot(c, tag) {
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
}

/** The page as its own view draws it — the find highlight lives in there, where no DOM capture reaches. */
async function shotView(mainEval, tag) {
  try {
    const b64 = await mainEval(`(async () => {
      const { BrowserWindow, WebContentsView } = require("electron");
      for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children)
        if (v instanceof WebContentsView && v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) return (await v.webContents.capturePage()).toPNG().toString("base64");
      return null; })()`);
    if (!b64) return;
    fs.writeFileSync(OUT(tag), Buffer.from(b64, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("view screenshot failed", String(e)); }
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
