/**
 * Live check for Plan 26's leftover (run with: pnpm build && node apps/desktop/scripts/plan-26-leftovers-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and checks, in the real window:
 *
 *   1. W6's Recently visited. A blank tab in a profile that has been nowhere lists none. Once a tab has
 *      been to three pages, the next blank tab lists them under its tools, newest first, on the tools'
 *      own grid. Choosing one loads it in THAT tab: the strip keeps its count, no browser is made, and
 *      main says the tab's own view is the one showing the page. A new blank tab reads the list fresh,
 *      a blank tab kept behind another reads it again when it comes back on screen, and Clear browsing
 *      data from its ⋯ takes the list down.
 *
 * (Its second part, the peek from a Notifications row, went with that page in v2.)
 *
 * Ports: LIVE_SERVER_PORT (8967), LIVE_CDP_PORT (9367), LIVE_MAIN_INSPECT_PORT (9467), LIVE_SITE_PORT
 * (8977). Screenshots go to LIVE_OUT_DIR (the system temp dir by default). Touches only a scratch dir;
 * kills only what is listening on its own ports. Browses nothing but its own 127.0.0.1 fixture. Nothing
 * is billed: every session is the fake agent — onboarding's is switched to it over RPC before anything
 * is sent — REALM_ENABLE_FAKE_AGENT=1 turns the titler and recap off, and the desktop notification
 * switch is turned off first so no toast reaches the Mac.
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
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9367);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8967);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8977);
/** Main's own inspector — the one place that knows where a native view is and whether it shows. */
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9467);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-plan-26-leftovers-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const LEAD = "Leftovers lead";
const WINDOW = { width: 1500, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `realm-plan-26-leftovers-${tag}.png`);
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

/** Pages with their own titles, so a list row and a tab name which one they are. */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const n = /^\/page-(\d)$/.exec(req.url ?? "")?.[1] ?? "0";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Page ${n}</title><body style="margin:0;background:#fff;font:16px system-ui"><h1>Page ${n}</h1></body>`);
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

/** The pointer, as a hand moves it: a real hover, which is what reveals a row's eye. */
const mouseTo = (c, pt) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
async function clickAt(c, pt) {
  await mouseTo(c, pt);
  await sleep(60);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
}

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
  // Unfocused, Realm goes quiet (`data-quiet`); a window behind the user's own never has focus.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl); await m.ready;
  /* The OS's pieces stood in for, so nothing waits on a person: the ⋯ menu is recorded rather than
     drawn, and Clear browsing data's confirm answers with whatever the check says. */
  const stubs = await inMain(m, `(() => {
    const { Menu, dialog, BrowserWindow } = require("electron");
    const L = globalThis.__live = { menus: [], dialogs: [], dialogAnswer: 1 };
    Menu.prototype.popup = function (opts) { L.menus.push({ menu: this, opts: opts || {} }); };
    const fakeBox = async (...args) => { const o = args.length > 1 ? args[1] : args[0]; L.dialogs.push({ message: o.message, buttons: o.buttons }); return { response: L.dialogAnswer, checkboxChecked: false }; };
    dialog.showMessageBox = fakeBox;
    for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height});
    return { menu: Menu.prototype.popup.toString().includes("L.menus"), dialog: dialog.showMessageBox === fakeBox };
  })()`);
  check("main's menu and confirm are stood in for, so nothing waits on a person", stubs.menu && stubs.dialog, stubs);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");

  // Onboarding makes the space. Its first session would run a REAL engine; it is moved to the fake
  // before anything is sent, and nothing is ever typed into a composer.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const onboarding = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all[0] : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: onboarding.id, agentKind: "fake" });
  await api.call("settings.set", { key: "notifications.desktop", value: false });
  const [space] = await api.call("spaces.list", {});

  const { session: lead } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: LEAD, permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(LEAD)}))`), 20_000, "the lead's row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(LEAD)})).click(); return true; })()`);
  await sleep(800);
  // The lead alone, so every pane after this is one the checks asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(LEAD)})) b.click(); return true; })()`);
  await sleep(500);

  const panes = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].map((p) => ({
    tabs: [...p.querySelectorAll('.pane-tabs [role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true' })),
    title: p.querySelector('.panel-title')?.textContent ?? null }))`);
  const sidePane = async () => (await panes()).find((p) => p.tabs.length > 0) ?? null;
  /** Every fixture page's native view, as main has it: where it is and whether it shows. */
  const views = () => inMain(m, `(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    const out = [];
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView)) continue;
      const url = v.webContents.getURL();
      if (url.startsWith(${JSON.stringify(SITE)})) out.push({ path: url.slice(${SITE.length}), shown: v.getVisible() && v.getBounds().width > 0, ...v.getBounds() });
    }
    return out;
  })()`);
  const showing = async () => (await views()).filter((v) => v.shown).map((v) => v.path).sort();
  /** The keyboard into the lead's pane, as a click there puts it, and then out of any text field. */
  const intoLead = async () => {
    await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(LEAD)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
    await sleep(400);
    await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
    await sleep(100);
  };
  const newTab = async () => { await intoLead(); await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true }); };
  const visiblePane = `[...document.querySelectorAll('.browser-pane')].find((p) => p.offsetParent !== null)`;
  /** The blank tab on screen, as drawn: its two sections' rows and their boxes. */
  const blankTab = () => evalIn(c, `(() => {
    const page = [...document.querySelectorAll('.new-tab')].find((p) => p.offsetParent !== null); if (!page) return null;
    const rows = (name) => { const s = page.querySelector('.new-tab-section[aria-label="' + name + '"]'); if (!s) return null;
      return [...s.querySelectorAll('.new-tab-row')].map((b) => { const r = b.getBoundingClientRect();
        return { label: b.querySelector('.new-tab-row-label').textContent, title: b.title, left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top) }; }); };
    return { tools: rows("Tools"), recent: rows("Recently visited") };
  })()`);
  const labels = (rows) => (rows ?? []).map((r) => r.label).join("|");
  const recentOnServer = async () => (await api.call("browsers.recent", { spaceId: space.id })).pages.map((p) => p.title);
  const browsersHere = async () => (await api.call("items.list", { spaceId: space.id })).filter((i) => i.kind === "browser");
  /** Type an address into the browser on screen and wait for main to show the page. */
  const go = async (pathname) => {
    await evalIn(c, `(() => {
      const input = ${visiblePane}.querySelector('input[aria-label=Address]');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(`${SITE}${pathname}`)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form").requestSubmit(); return true; })()`);
    await until(async () => (await showing()).includes(pathname), 20_000, `${pathname} on screen`);
  };
  const clickTab = async (index) => {
    await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')][${index}].click(); return true; })()`);
    await sleep(500);
  };

  // ── 1. Recently visited ─────────────────────────────────────────────────────────────────────────
  await newTab();
  await until(async () => (await blankTab())?.tools, 10_000, "the first blank tab");
  await sleep(700); // long enough for a read to have come back, had there been anything to read
  const empty = await blankTab();
  check("a blank tab in a profile that has been nowhere draws no Recently visited, only its tools",
    empty.recent === null && labels(empty.tools).startsWith("Files"), empty);
  for (const n of [1, 2, 3]) {
    await go(`/page-${n}`);
    await until(async () => (await recentOnServer())[0] === `Page ${n}`, 10_000, `Page ${n} kept`);
  }
  check("the tab's visits are kept on the server, newest first", (await recentOnServer()).join("|") === "Page 3|Page 2|Page 1", await recentOnServer());

  const browsersBefore = await browsersHere();
  await newTab();
  const listed = await until(async () => { const b = await blankTab(); return b?.recent ? b : null; }, 10_000, "the second blank tab's list").catch(blankTab);
  note("the second blank tab", listed);
  check("the next blank tab lists them under its tools, newest first", labels(listed?.recent) === "Page 3|Page 2|Page 1", listed?.recent);
  const tool = listed?.tools?.[0];
  check("…on the tools' own grid: the same left edge, width and height, and below them",
    !!tool && listed.recent.every((r) => r.left === tool.left && r.width === tool.width && r.height === tool.height && r.top > listed.tools.at(-1).top), { tool, recent: listed?.recent });
  check("…each named for its address in the tooltip", (listed?.recent ?? []).map((r) => r.title).join("|") === ["/page-3", "/page-2", "/page-1"].map((p) => SITE + p).join("|"), listed?.recent?.map((r) => r.title));
  check("…and the page behind it is off screen, as a blank tab's always is", (await showing()).length === 0, await views());
  await sleep(300);
  await shot(c, "new-tab-recent");
  await shot(c, "new-tab-recent-crop", await newTabClip(c));
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(400);
  await shot(c, "new-tab-recent-light", await newTabClip(c));
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  await sleep(300);

  const browsersWithTab = await browsersHere();
  const blank = browsersWithTab.find((b) => !browsersBefore.some((x) => x.id === b.id));
  const tabsBefore = await sidePane();
  const at = await evalIn(c, `(() => { const page = [...document.querySelectorAll('.new-tab')].find((p) => p.offsetParent !== null);
    const b = [...page.querySelectorAll('.new-tab-section[aria-label="Recently visited"] .new-tab-row')].find((x) => x.textContent === "Page 1");
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await clickAt(c, at);
  await until(async () => (await showing()).includes("/page-1"), 15_000, "Page 1 on screen").catch(() => {});
  const tabsAfter = await until(async () => { const s = await sidePane(); return s?.tabs[1]?.name === "Page 1" ? s : null; }, 10_000, "the tab named for its page").catch(sidePane);
  check("choosing Page 1 loads it in that tab: the strip keeps its two tabs, the second now Page 1 and showing",
    tabsBefore?.tabs.length === 2 && tabsAfter?.tabs.length === 2 && tabsAfter.tabs[1].selected && tabsAfter.tabs[1].name === "Page 1", { before: tabsBefore?.tabs, after: tabsAfter?.tabs });
  check("…and main shows Page 1 alone, the first tab's Page 3 kept behind it", (await showing()).join() === "/page-1" && (await views()).some((v) => v.path === "/page-3" && !v.shown), await views());
  const row = await until(async () => { const r = await api.call("browsers.get", { browserId: blank.refId }); return r.url === `${SITE}/page-1` ? r : null; }, 10_000, "the blank tab's row").catch(() => api.call("browsers.get", { browserId: blank.refId }));
  check("…it is the blank tab's own browser that went there, and no browser was made", row.url === `${SITE}/page-1` && (await browsersHere()).length === browsersWithTab.length,
    { url: row.url, browsers: [browsersWithTab.length, (await browsersHere()).length] });

  await newTab();
  const fresh = await until(async () => { const b = await blankTab(); return b?.recent?.[0]?.label === "Page 1" ? b : null; }, 10_000, "the third blank tab's list").catch(blankTab);
  check("a new blank tab reads the list fresh: Page 1, just visited, first", labels(fresh?.recent) === "Page 1|Page 3|Page 2", fresh?.recent);

  await clickTab(0);
  await go("/page-4");
  await until(async () => (await recentOnServer())[0] === "Page 4", 10_000, "Page 4 kept");
  await clickTab(2);
  const again = await until(async () => { const b = await blankTab(); return b?.recent?.[0]?.label === "Page 4" ? b : null; }, 10_000, "the kept blank tab's list").catch(blankTab);
  check("a blank tab kept behind another reads again when it comes back on screen", labels(again?.recent) === "Page 4|Page 1|Page 3|Page 2", again?.recent);

  // Clear browsing data from the blank tab's own ⋯, with the confirm answered Clear.
  await inMain(m, `globalThis.__live.dialogAnswer = 0; true`);
  const menusBefore = await inMain(m, `globalThis.__live.menus.length`);
  await evalIn(c, `(() => { ${visiblePane}.querySelector('.browser-more').click(); return true; })()`);
  await until(() => inMain(m, `globalThis.__live.menus.length > ${menusBefore}`), 10_000, "the ⋯ menu");
  const picked = await inMain(m, `(() => { const last = globalThis.__live.menus.at(-1);
    const item = last.menu.items.find((i) => i.label === "Clear browsing data…"); if (!item || !item.enabled) return false;
    item.click(); last.opts.callback?.(); return true; })()`);
  const cleared = await until(async () => { const b = await blankTab(); return b && b.recent === null ? b : null; }, 10_000, "the list gone").catch(blankTab);
  check("Clear browsing data from the blank tab's ⋯ takes its list down, and the server has forgotten the pages",
    picked && cleared?.recent === null && (await recentOnServer()).length === 0, { picked, recent: cleared?.recent, server: await recentOnServer() });
  await shot(c, "new-tab-cleared", await newTabClip(c));

}

/** The browser pane on screen, from its address field down through the blank tab's last list. */
async function newTabClip(c) {
  const r = await evalIn(c, `(() => { const p = [...document.querySelectorAll('.browser-pane')].find((x) => x.offsetParent !== null); if (!p) return null;
    const b = p.getBoundingClientRect(); const s = [...p.querySelectorAll('.new-tab-section')].at(-1)?.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, bottom: s ? s.bottom : b.top + 400 }; })()`);
  return r ? { x: r.x, y: r.y, width: r.width, height: Math.min(r.bottom - r.y + 24, WINDOW.height - r.y), scale: 2 } : undefined;
}

/** The window as the renderer draws it. Native browser views are not in a DOM capture, so where the
 *  views are comes from main's bounds instead — every capture here is taken with none showing. */
async function shot(c, tag, clip) {
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
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
