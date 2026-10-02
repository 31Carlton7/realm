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
  await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
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
    for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: k, code: k === "Enter" ? "Enter" : k === "Escape" ? "Escape" : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k === "Enter" ? 13 : k === "Escape" ? 27 : k.toUpperCase().charCodeAt(0), modifiers });
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
