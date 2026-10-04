/**
 * Live check for Plan 26's two leftovers (run with: pnpm build && node apps/desktop/scripts/plan-26-leftovers-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and checks, in the real window:
 *
 *   1. W6's Recently visited. A blank tab in a profile that has been nowhere lists none. Once a tab has
 *      been to three pages, the next blank tab lists them under its tools, newest first, on the tools'
 *      own grid. Choosing one loads it in THAT tab: the strip keeps its count, no browser is made, and
 *      main says the tab's own view is the one showing the page. A new blank tab reads the list fresh,
 *      a blank tab kept behind another reads it again when it comes back on screen, and Clear browsing
 *      data from its ⋯ takes the list down.
 *   2. W11b's peek from a notification row. The eye is on the rows whose session the Agents page would
 *      offer one for, and not on the lead's, which is on screen. It is not drawn at rest; under the
 *      pointer or the keyboard it takes the slot the time and the unread dot give up, centred on the
 *      title's line. Clicking it opens the session as a peek beside the lead without leaving the
 *      space, reads the row, and is never saved into the layout. The Agents page's eye, now the same
 *      component, still peeks.
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

  // ── 2. Peek from a notification row ─────────────────────────────────────────────────────────────
  const homework = await api.call("spaces.create", { profileId: space.profileId, name: "Homework" });
  const { session: target } = await api.call("sessions.create", { spaceId: homework.id, agentKind: "fake", title: "Peek target", permissionMode: "default" });
  await api.call("sessions.send", { id: target.id, text: "ask me", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: target.id })).status === "waiting_permission", 20_000, "the peek target waiting on a card");
  const { session: second, itemId: secondItem } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Second session", permissionMode: "default" });
  await api.call("sessions.send", { id: second.id, text: "hello", attachments: [], mentions: [] });
  await api.call("sessions.send", { id: lead.id, text: "hello", attachments: [], mentions: [] });
  const titles = ["Peek target", "Second session", LEAD];
  await until(async () => { const { notifications } = await api.call("notifications.list", {}); return titles.every((t) => notifications.some((n) => n.title === t)); }, 20_000, "the three rows");

  await intoLead();
  await evalIn(c, `(() => { [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Notifications')).click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.notif-cards > li').length >= 3`), 10_000, "the feed");
  await sleep(800); // every space's rows, for the guard, are read as the page comes up
  await mouseTo(c, { x: 4, y: WINDOW.height - 4 });
  await sleep(300);
  const feed = () => evalIn(c, `[...document.querySelectorAll('.notif-cards > li')].map((li) => {
    const row = li.querySelector('.notif-row'); const eye = li.querySelector('.peek-btn');
    const vis = (sel) => { const el = li.querySelector(sel); return el ? getComputedStyle(el).visibility : null; };
    return { name: row.getAttribute('aria-label'), eye: eye?.getAttribute('aria-label') ?? null, inRow: !!row.querySelector('.peek-btn'),
      tip: eye?.title ?? null, opacity: eye ? getComputedStyle(eye).opacity : null, time: vis('.notif-time'), dot: vis('.notif-dot') };
  })`);
  const rest = await feed();
  note("the feed at rest", rest);
  const byName = (rows, name) => rows.find((r) => r.name === name);
  check("the eye is on the rows the Agents page would offer it on — the other space's session and an unopened one — and not on the lead's, which is on screen",
    byName(rest, "Peek target")?.eye === "Peek at Peek target" && byName(rest, "Second session")?.eye === "Peek at Second session" && byName(rest, LEAD)?.eye === null, rest);
  check("…beside each row, never inside its button, with the Agents page's tooltip",
    rest.every((r) => !r.inRow) && byName(rest, "Peek target")?.tip === "Peek — look at it beside your session, without opening it", rest);
  check("…and not drawn at rest, where the time and the unread dot show", rest.filter((r) => r.eye).every((r) => r.opacity === "0" && r.time === "visible" && r.dot !== "hidden"), rest);
  await shot(c, "notif-rest", await feedClip(c));

  /** One row's geometry: the row, its title's TEXT (not the stretched box), the kind, the eye. */
  const geometry = (name) => evalIn(c, `(() => {
    const li = [...document.querySelectorAll('.notif-cards > li')].find((x) => x.querySelector('.notif-row').getAttribute('aria-label') === ${JSON.stringify(name)});
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: r.top + r.height / 2 }; };
    const title = li.querySelector('.notif-title'); const range = document.createRange(); range.selectNodeContents(title);
    const first = range.getClientRects()[0];
    return { row: box(li.querySelector('.notif-row')), eye: box(li.querySelector('.peek-btn')), kind: box(li.querySelector('.notif-kind')),
      text: { left: first.left, right: first.right, top: first.top, bottom: first.bottom, cy: first.top + first.height / 2 },
      line: parseFloat(getComputedStyle(title).lineHeight), titleTop: box(title).top };
  })()`);
  const g = await geometry("Peek target");
  await mouseTo(c, { x: g.row.left + 60, y: g.row.top + 12 });
  await sleep(350);
  const hover = byName(await feed(), "Peek target");
  const lineCentre = g.titleTop + g.line / 2;
  check("under the pointer the eye shows, in the slot the time and the unread dot give up", hover?.opacity === "1" && hover.time === "hidden" && hover.dot === "hidden", hover);
  check("…8px in from the row's end, centred on the title's line, clear of the title and the kind",
    Math.abs(g.row.right - g.eye.right - 8) < 0.5 && Math.abs(g.eye.cy - lineCentre) <= 1 && g.text.right < g.eye.left && g.kind.right <= g.eye.left,
    { rowRight: g.row.right, eye: g.eye, lineCentre, text: g.text, kind: g.kind });
  await shot(c, "notif-hover", await feedClip(c));
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(400);
  await shot(c, "notif-hover-light", await feedClip(c));
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  await sleep(300);

  // The keyboard: the row focused, with the pointer nowhere near it.
  await mouseTo(c, { x: 4, y: WINDOW.height - 4 });
  await evalIn(c, `(() => { [...document.querySelectorAll('.notif-row')].find((r) => r.getAttribute('aria-label') === "Second session").focus(); return true; })()`);
  await sleep(350);
  const keyed = byName(await feed(), "Second session");
  check("…and under the keyboard, as the Agents page's is", keyed?.opacity === "1" && keyed.time === "hidden", keyed);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);

  await mouseTo(c, { x: g.row.left + 60, y: g.row.top + 12 });
  await sleep(300);
  await clickAt(c, { x: (g.eye.left + g.eye.right) / 2, y: g.eye.cy });
  const peekTab = () => evalIn(c, `(() => { const t = document.querySelector('.pane-tab[data-peek] [role=tab]'); return t ? { label: t.getAttribute('aria-label'), selected: t.getAttribute('aria-selected') === 'true' } : null; })()`);
  const tab = await until(peekTab, 10_000, "the peek's tab").catch(() => null);
  const overlay = await evalIn(c, `!!document.querySelector('.notifications-page-pane')`);
  // Nothing switched: the lead's own pane is still on screen, its crumb naming Live. (The focus may be
  // in the side pane now, which carries no crumb.)
  const leadCrumb = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].find((p) => p.querySelector('.panel-title')?.textContent === ${JSON.stringify(LEAD)})?.querySelector('.panel-crumb')?.getAttribute('aria-label') ?? null`);
  check("the eye opens the other space's session as a tab of the lead's side pane, the feed out of the way, still beside the lead in Live",
    tab?.label === "Peek: Peek target" && tab.selected && !overlay && (await leadCrumb()) === "Open Live", { tab, overlay, lead: await leadCrumb() });
  const peekPane = () => evalIn(c, `(() => { const p = document.querySelector('.session-pane[data-peek]');
    return p ? { card: !!p.querySelector('.permission-card'), composer: !!p.querySelector('.composer'), bar: p.querySelector('.peek-bar')?.textContent ?? null } : null; })()`);
  const pane = await until(async () => { const p = await peekPane(); return p?.card ? p : null; }, 10_000, "the peek's card").catch(peekPane);
  check("…showing its card, no prompter, and which space it is from", pane?.card === true && pane.composer === false && pane.bar === "Peek · HomeworkOpen session", pane);
  check("…with no browser view over it", (await showing()).length === 0, await views());
  const readRow = await until(async () => { const { notifications } = await api.call("notifications.list", {}); const n = notifications.find((x) => x.title === "Peek target"); return n?.readAt ? n : null; }, 5_000, "the row read").catch(() => null);
  check("…and the row it was opened from is read, as opening it would make it", !!readRow, readRow);
  /** Every item the window's saved view names — on screen or kept in a side pane — as the profile's
   *  `ui.view:<id>` row has it. */
  const savedIds = async () => {
    const { value } = await api.call("settings.get", { key: `ui.view:${space.profileId}` });
    const walk = (n) => (n.type === "leaf" ? [...(n.tabs ?? []), ...(n.itemId ? [n.itemId] : [])] : n.children.flatMap(walk));
    const kept = Object.values(value?.sidePanes ?? {}).flatMap((p) => p.tabs);
    return [...new Set([...(value?.layout ? walk(value.layout) : []), ...kept])];
  };
  const targetItem = (await api.call("items.list", { spaceId: homework.id })).find((i) => i.refId === target.id);
  await sleep(600);
  const saved = await savedIds();
  check("…never written into the window's saved view", saved.length > 0 && !saved.includes(targetItem.id), { saved, peek: targetItem.id });
  await sleep(300);
  await shot(c, "notif-peeked");

  // A same-space session from its row: the next peek replaces the last.
  await evalIn(c, `(() => { [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Notifications')).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.notif-cards button[aria-label="Peek at Second session"]')`), 10_000, "the feed again");
  const g2 = await geometry("Second session");
  await mouseTo(c, { x: g2.row.left + 60, y: g2.row.top + 12 });
  await sleep(300);
  await clickAt(c, { x: (g2.eye.left + g2.eye.right) / 2, y: g2.eye.cy });
  const tab2 = await until(async () => { const t = await peekTab(); return t?.label === "Peek: Second session" ? t : null; }, 10_000, "the second peek").catch(peekTab);
  const peeks = await evalIn(c, `document.querySelectorAll('.pane-tab[data-peek]').length`);
  check("a same-space session's eye peeks at it beside the lead, replacing the last peek", tab2?.label === "Peek: Second session" && peeks === 1 && !(await savedIds()).includes(secondItem), { tab2, peeks });

  // The Agents page draws the same component: its eye still peeks.
  await intoLead();
  await evalIn(c, `(() => { [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Home')).click(); return true; })()`);
  const agentsEye = await until(() => evalIn(c, `(() => { const b = document.querySelector('.agents-page button[aria-label="Peek at Peek target"]'); return b ? b.className : null; })()`), 10_000, "the Agents page's eye").catch(() => null);
  if (agentsEye) await evalIn(c, `(() => { document.querySelector('.agents-page button[aria-label="Peek at Peek target"]').click(); return true; })()`);
  const tab3 = await until(async () => { const t = await peekTab(); return t?.label === "Peek: Peek target" ? t : null; }, 10_000, "the Agents page's peek").catch(peekTab);
  check("the Agents page's eye is the same control, and still peeks", agentsEye === "icon-btn peek-btn" && tab3?.label === "Peek: Peek target", { agentsEye, tab3 });
}

/** The browser pane on screen, from its address field down through the blank tab's last list. */
async function newTabClip(c) {
  const r = await evalIn(c, `(() => { const p = [...document.querySelectorAll('.browser-pane')].find((x) => x.offsetParent !== null); if (!p) return null;
    const b = p.getBoundingClientRect(); const s = [...p.querySelectorAll('.new-tab-section')].at(-1)?.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, bottom: s ? s.bottom : b.top + 400 }; })()`);
  return r ? { x: r.x, y: r.y, width: r.width, height: Math.min(r.bottom - r.y + 24, WINDOW.height - r.y), scale: 2 } : undefined;
}

/** The feed's first rows, for a capture that can be read at a glance. */
async function feedClip(c) {
  const r = await evalIn(c, `(() => { const f = document.querySelector('.notif-feed'); if (!f) return null; const b = f.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width }; })()`);
  return r ? { x: Math.max(0, r.x - 16), y: Math.max(0, r.y - 8), width: Math.min(r.width + 32, WINDOW.width), height: 260, scale: 2 } : undefined;
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
