/**
 * Live check for the window's one view: any number of panes beside one side panel
 * (run with: pnpm build && node apps/desktop/scripts/splits-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with fake sessions, and checks, in the real window:
 *
 *   1. One session and a browser tab: the panel is half the main area, the full height below the
 *      head row, and the browser's native view is exactly the pane's box — asked of main, and its
 *      own webContents captured (a window capture cannot see a native view).
 *   2. A session joining the split brings its tab into the strip, after a hairline, without taking
 *      the panel from what was showing; a tab under the pointer marks its session's pane; choosing a
 *      tab swaps the native views and leaves the keyboard where it was.
 *   3. The session leaving takes its tab with it, and brings it back.
 *   4. Three panes in a row, a two-by-two grid, and one pane beside a stack of three: every pane at
 *      least its floor, the panel giving way first.
 *   5. Dragging the panel's edge resizes it and the share is remembered; the native view follows.
 *   6. Folding the sidebar widens the main area, and the panel keeps its share of it.
 *   7. A window too narrow for the panel beside the panes: it steps aside, the toggle shows it in the
 *      panes' place, and a split there is refused with a toast saying why — the palette too.
 *   8. Pane focus keeps the panel beside the one pane; a refused drop edge says why; the light face.
 *
 * Ports: LIVE_SERVER_PORT (8817), LIVE_CDP_PORT (9257), LIVE_SITE_PORT (8818), LIVE_MAIN_INSPECT_PORT
 * (9258). Touches only a scratch dir; kills only what is listening on its own ports. Browses nothing
 * but its own 127.0.0.1 fixture. Nothing is billed: every session is the fake agent's, and
 * REALM_ENABLE_FAKE_AGENT=1 turns the titler and recap off. Screenshots go to LIVE_SHOT_DIR.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9257);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8817);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8818);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9258);
const SHOTS = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-splits-live");
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH_DIR ?? os.tmpdir(), "realm-splits-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
/** The floors the app holds a split to (contracts/view.ts). */
const PANE_MIN = { width: 280, height: 300 };
const PANEL_MIN = 320;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null, api = null, site = null;
fs.mkdirSync(SHOTS, { recursive: true });

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

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
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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
async function evalIn(c, expr, extra = {}) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, ...extra });
  if (r.exceptionDetails) throw new Error(`exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}

/** Pages of one solid colour each, so a capture of a view's own webContents says which page it is. */
const COLORS = { red: [214, 40, 40], blue: [40, 90, 214], green: [40, 170, 80], amber: [230, 160, 30] };
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const name = (req.url ?? "/").slice(1);
      const rgb = COLORS[name] ?? [128, 128, 128];
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${name}</title><style>html,body{margin:0;height:100%;background:rgb(${rgb.join(",")})}</style>`);
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** Page-side helpers, found from the DOM up (the store is the provider's value above the host). */
const HELPERS = `globalThis.__live = {
  store() {
    if (globalThis.__liveStore) return globalThis.__liveStore;
    const el = document.querySelector('.panehost') ?? document.querySelector('#root > *'); if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? el[key] : null; f; f = f.return) { const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && typeof v.subscribe === 'function') { const st = v.getState(); if (st && 'activeProfileId' in st && 'view' in st) { globalThis.__liveStore = v; return v; } } }
    return null;
  },
  st() { return __live.store().getState(); },
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  leafOf(itemId) { const s = __live.st(); const f = (n) => n.type === 'leaf' ? ((n.tabs ?? [n.itemId]).includes(itemId) ? n : null) : n.children.map(f).find(Boolean) ?? null; return f(s.layout)?.id ?? null; },
  /** The view as drawn: the host, each main pane by title, the panel, its edge, its strip. */
  report() {
    const s = __live.st();
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const host = document.querySelector('.panehost');
    const panes = [...document.querySelectorAll('.view-main .panel')].map((p) => ({ title: byId.get(p.dataset.item)?.title ?? null, box: __live.box(p),
      focused: p.hasAttribute('data-focused'), hover: p.hasAttribute('data-owner-hover'), active: p.hasAttribute('data-owner-active') }));
    const column = document.querySelector('.view-panel');
    const panel = column?.querySelector(':scope > .panel');
    return {
      host: __live.box(host), panes,
      panel: column ? { hidden: column.hidden, full: column.hasAttribute('data-full'), box: column.hidden ? null : __live.box(column),
        bar: __live.box(panel?.querySelector(':scope > .panel-bar')), body: __live.box(panel?.querySelector(':scope > .panel-body')) } : null,
      edge: __live.box(document.querySelector('.panehost > .panel-edge')),
      tabs: [...document.querySelectorAll('.view-panel [role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true', title: t.getAttribute('title') })),
      runs: document.querySelectorAll('.view-panel .pane-tab-run').length,
      share: s.view?.panelShare ?? null, zoomed: s.view?.zoomedLeafId ?? null, hidden: s.sidePanesHidden,
      toggle: (() => { const b = document.querySelector('.window-trail button'); return b ? { label: b.getAttribute('aria-label'), title: b.getAttribute('title'), on: b.hasAttribute('data-on') } : null; })(),
      topRight: document.querySelector('[data-top-right]')?.dataset.leafId ?? null,
      browserHost: __live.box([...document.querySelectorAll('.browser-view-host')].find((h) => h.offsetParent !== null && !h.closest('[hidden]'))),
    };
  },
};`;

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
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1",
      // The pane menu drawn in the page, so a capture can see it (an OS menu is not in the DOM).
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
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
  const inMain = (expr) => evalIn(m, expr, { includeCommandLineAPI: true });
  const size = (w, h) => inMain(`(() => { require("electron").BrowserWindow.getAllWindows()[0].setContentSize(${w}, ${h}); return true; })()`);
  await size(1600, 1000);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, HELPERS);
  // The window is unkeyed with the person's own app in front, which greys the accent: hold it keyed.
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
    new MutationObserver(() => r.removeAttribute('data-window-inactive')).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const SID = JSON.stringify(space.id);
  const sessions = {};
  for (const [key, title] of [["alpha", "Alpha"], ["bravo", "Bravo"], ["charlie", "Charlie"], ["delta", "Delta"]]) {
    const made = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title });
    sessions[key] = { refId: made.session.id, itemId: made.itemId };
  }
  const browsers = {};
  for (const name of ["red", "blue", "green"]) {
    const made = await api.call("browsers.create", { spaceId: space.id, url: `${SITE}/${name}` });
    browsers[name] = made;
  }
  const S = (expr) => evalIn(c, `(async () => { const s = __live.st(); ${expr}; return true; })()`);
  await S(`await s.refreshItems(${SID}); await s.refreshSessions(${SID})`);
  const report = () => evalIn(c, `__live.report()`);
  const settle = (ms = 700) => sleep(ms);

  /** Main's own answer for each fixture view: shown or not, and its bounds. */
  const views = async () => inMain(`(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    const out = {};
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView)) continue;
      const url = v.webContents.getURL();
      if (!url.startsWith(${JSON.stringify(SITE)})) continue;
      out[url.slice(${SITE.length + 1})] = { shown: v.getVisible(), ...v.getBounds() };
    }
    return out;
  })()`);
  /** The view's OWN picture: what it paints, which a window capture cannot see. Its mean colour, and
   *  the PNG kept beside the screenshots. */
  const viewShot = async (name, tag) => {
    const r = await inMain(`(async () => {
      const { BrowserWindow, WebContentsView } = require("electron");
      for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
        if (!(v instanceof WebContentsView) || !v.webContents.getURL().endsWith("/${name}")) continue;
        const img = await v.webContents.capturePage();
        const { width, height } = img.getSize();
        const bmp = img.toBitmap(); let r = 0, g = 0, b = 0; const n = bmp.length / 4;
        for (let i = 0; i < bmp.length; i += 4) { b += bmp[i]; g += bmp[i + 1]; r += bmp[i + 2]; }
        return { width, height, mean: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], png: img.toPNG().toString("base64") };
      }
      return null;
    })()`);
    if (!r) return null;
    fs.writeFileSync(path.join(SHOTS, `${tag}-view-${name}.png`), Buffer.from(r.png, "base64"));
    return { width: r.width, height: r.height, mean: r.mean };
  };
  const shot = async (tag) => {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOTS, `${tag}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${file}`);
  };
  /** The native view for `name` is on screen exactly where the pane's placeholder is. */
  const viewOnPane = async (name, label) => {
    await settle(500);
    const [v, r] = [await views(), await report()];
    const view = v[name], hostBox = r.browserHost;
    const ok = !!view?.shown && !!hostBox && near(view.x, hostBox.l) && near(view.y, hostBox.t) && near(view.width, hostBox.w) && near(view.height, hostBox.h);
    check(`${label}: ${name}'s native view is on screen on the pane's own box`, ok, { view, pane: hostBox });
    const others = Object.entries(v).filter(([k, x]) => k !== name && x.shown && x.width > 0).map(([k]) => k);
    check(`${label}: no other view is on screen`, others.length === 0, others);
    const pic = await viewShot(name, label.replace(/\W+/g, "-"));
    // The capture comes back in the display's colour space, so the page is told by its strongest
    // channel and how far it stands above the others, not by an exact value.
    const want = COLORS[name];
    const top = (rgb) => rgb.indexOf(Math.max(...rgb));
    check(`${label}: the view's own capture is the ${name} page, at its size`, !!pic && top(pic.mean) === top(want) && Math.max(...pic.mean) - Math.min(...pic.mean) > 100 && near(pic.width, view.width, 2), pic);
  };
  const mouse = async (type, x, y, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  const click = async (x, y) => { await mouse("mouseMoved", x, y, { buttons: 0, button: "none" }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
  const center = (b) => ({ x: (b.l + b.r) / 2, y: (b.t + b.b) / 2 });

  // ── 1. One session and a tab: the panel is half the main area, the full height ─────────────────
  await S(`await s.openItem(${JSON.stringify(sessions.alpha.itemId)})`);
  await S(`await s.openInSidePane(${JSON.stringify(sessions.alpha.refId)}, ${JSON.stringify(browsers.red.itemId)})`);
  await settle(1200);
  let r = await report();
  note("one session and a tab", r);
  check("the panel is half the main area by default", r.panel && near(r.panel.box.w, r.host.w / 2, 1.5), { panel: r.panel?.box.w, host: r.host.w });
  check("the panel is the full height of the window, its bar in the head row", r.panel && near(r.panel.box.t, r.host.t, 0.5) && near(r.panel.box.b, r.host.b, 0.5) && near(r.panel.bar.t, 0, 0.5) && near(r.panel.bar.h, 40, 0.5), r.panel);
  check("the edge is the panel's left edge, one hairline", r.edge && near(r.edge.r, r.panel.box.l, 0.5) && near(r.edge.w, 1, 0.01), r.edge);
  check("the toggle at the top right is lit, over the panel's bar", r.toggle?.on === true && r.topRight === (await evalIn(c, `__live.leafOf(${JSON.stringify(browsers.red.itemId)})`)), r.toggle);
  await viewOnPane("red", "1-default");
  await shot("1-default-half");

  // ── 2. A session joining the split brings its tab into the strip ───────────────────────────────
  // Bravo's agent opened the blue page while Bravo was off screen: it waits, live, for Bravo.
  await S(`await s.applyAgentPaneOpened({ spaceId: ${SID}, itemId: ${JSON.stringify(browsers.blue.itemId)}, openedBy: ${JSON.stringify(sessions.bravo.refId)} })`);
  await S(`s.focusLeaf(__live.leafOf(${JSON.stringify(sessions.alpha.itemId)})); await s.openItemBeside(${JSON.stringify(sessions.bravo.itemId)})`);
  await settle(1000);
  r = await report();
  note("bravo joined", r);
  check("two panes, one panel", r.panes.length === 2 && r.panel && !r.panel.hidden, r.panes.map((p) => p.title));
  check("the strip holds both sessions' tabs, Alpha's run first, a hairline between them", r.tabs.map((t) => t.name).join() === "red,blue" && r.runs === 1, r.tabs);
  check("the merge did not take the panel from what it was showing", r.tabs.find((t) => t.selected)?.name === "red", r.tabs);
  check("each tab names its session in its tooltip", r.tabs.map((t) => t.title).join(" | ") === "red — Alpha | blue — Bravo", r.tabs.map((t) => t.title));
  const blueTab = await evalIn(c, `__live.box([...document.querySelectorAll('.view-panel [role=tab]')].find((t) => t.textContent === 'blue'))`);
  await mouse("mouseMoved", center(blueTab).x, center(blueTab).y, { buttons: 0, button: "none" });
  await settle(300);
  r = await report();
  check("a tab under the pointer marks its session's pane, and only that one", r.panes.map((p) => `${p.title}:${p.hover}`).join() === "Alpha:false,Bravo:true", r.panes);
  await shot("2-merged-hover-bravo");
  const typing = await evalIn(c, `(() => { const ta = [...document.querySelectorAll('.view-main .panel')].find((p) => p.dataset.item === ${JSON.stringify(sessions.bravo.itemId)}).querySelector('textarea'); ta.focus(); return document.activeElement === ta; })()`);
  check("the keyboard is in Bravo's prompter", typing);
  await click(center(blueTab).x, center(blueTab).y);
  await settle(800);
  r = await report();
  check("a click on Bravo's tab shows it", r.tabs.find((t) => t.selected)?.name === "blue", r.tabs);
  check("…and leaves the keyboard in the prompter", await evalIn(c, `document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.view-main')`));
  await viewOnPane("blue", "2-tab-chosen");
  await mouse("mouseMoved", 5, 500, { buttons: 0, button: "none" });

  // ── 3. The session leaving takes its tab with it, and brings it back ──────────────────────────
  await S(`await s.closeInPane(__live.leafOf(${JSON.stringify(sessions.bravo.itemId)}))`);
  await settle(800);
  r = await report();
  const kept = await evalIn(c, `__live.st().view.sidePanes[${JSON.stringify(sessions.bravo.itemId)}]?.tabs ?? null`);
  check("Bravo left the split, taking its tab", r.panes.length === 1 && r.tabs.map((t) => t.name).join() === "red", r.tabs);
  check("…which waits for Bravo", JSON.stringify(kept) === JSON.stringify([browsers.blue.itemId]), kept);
  await viewOnPane("red", "3-parted");
  await shot("3-bravo-left");
  await S(`s.focusLeaf(__live.leafOf(${JSON.stringify(sessions.alpha.itemId)})); await s.openItemBeside(${JSON.stringify(sessions.bravo.itemId)})`);
  await settle(800);
  r = await report();
  check("Bravo back, its tab back in its run", r.tabs.map((t) => t.name).join() === "red,blue" && r.runs === 1, r.tabs);

  // ── 4. Three in a row, a grid of four, one beside a stack of three ────────────────────────────
  await S(`s.focusLeaf(__live.leafOf(${JSON.stringify(sessions.bravo.itemId)})); await s.openItemBeside(${JSON.stringify(sessions.charlie.itemId)})`);
  await settle(900);
  r = await report();
  note("three in a row", r);
  const floorsHeld = (rr) => rr.panes.every((p) => p.box.w >= PANE_MIN.width - 0.5 && p.box.h >= PANE_MIN.height - 0.5);
  check("three panes in a row, each at least its floor", r.panes.length === 3 && floorsHeld(r) && new Set(r.panes.map((p) => p.box.t)).size === 1, r.panes.map((p) => [p.title, p.box.w]));
  const need3 = 3 * PANE_MIN.width + 2;
  check("the panel gave way first: as wide as the panes leave it, never under its floor", r.panel && near(r.panel.box.w, Math.min(r.host.w / 2, r.host.w - need3 - 1), 1.5) && r.panel.box.w >= PANEL_MIN, { panel: r.panel?.box.w, host: r.host.w });
  await viewOnPane("red", "4-three-in-a-row");
  await shot("4-three-in-a-row");
  // A grid of four: Alpha | Bravo, each with one below it.
  await S(`await s.closeInPane(__live.leafOf(${JSON.stringify(sessions.charlie.itemId)}))`);
  await S(`await s.openItemAt(${JSON.stringify(sessions.charlie.itemId)}, __live.leafOf(${JSON.stringify(sessions.alpha.itemId)}), "bottom")`);
  await S(`await s.openItemAt(${JSON.stringify(sessions.delta.itemId)}, __live.leafOf(${JSON.stringify(sessions.bravo.itemId)}), "bottom")`);
  await settle(900);
  r = await report();
  note("grid of four", r);
  const rows = new Set(r.panes.map((p) => Math.round(p.box.t))).size, cols = new Set(r.panes.map((p) => Math.round(p.box.l))).size;
  check("four panes as a two-by-two grid, each at least its floor", r.panes.length === 4 && rows === 2 && cols === 2 && floorsHeld(r), r.panes.map((p) => [p.title, p.box.l, p.box.t, p.box.w, p.box.h]));
  check("…the panel the full height beside all four, its tabs still Alpha's and Bravo's", r.panel && near(r.panel.box.h, r.host.h, 0.5) && r.tabs.map((t) => t.name).join() === "red,blue", r.tabs);
  await viewOnPane("red", "4-grid");
  await shot("5-grid-of-four");
  // One beside a stack of three: Alpha | (Bravo / Charlie / Delta).
  for (const k of ["charlie", "delta"]) await S(`await s.closeInPane(__live.leafOf(${JSON.stringify(sessions[k].itemId)}))`);
  await S(`await s.openItemAt(${JSON.stringify(sessions.charlie.itemId)}, __live.leafOf(${JSON.stringify(sessions.bravo.itemId)}), "bottom")`);
  await S(`await s.openItemAt(${JSON.stringify(sessions.delta.itemId)}, __live.leafOf(${JSON.stringify(sessions.charlie.itemId)}), "bottom")`);
  await settle(900);
  r = await report();
  const lefts = r.panes.map((p) => Math.round(p.box.l));
  check("one pane beside a stack of three, each at least its floor", r.panes.length === 4 && new Set(lefts).size === 2 && lefts.filter((x) => x === lefts[1]).length === 3 && floorsHeld(r), r.panes.map((p) => [p.title, p.box.l, p.box.t, p.box.h]));
  await shot("6-one-beside-a-stack-of-three");
  for (const k of ["charlie", "delta"]) await S(`await s.closeInPane(__live.leafOf(${JSON.stringify(sessions[k].itemId)}))`);
  await settle(600);

  // ── 5. Dragging the panel's edge ────────────────────────────────────────────────────────────
  r = await report();
  const before = r.panel.box.w;
  const e0 = center(r.edge);
  await mouse("mouseMoved", e0.x, e0.y, { buttons: 0, button: "none" });
  await mouse("mousePressed", e0.x, e0.y);
  for (let dx = 20; dx <= 160; dx += 20) { await mouse("mouseMoved", e0.x - dx, e0.y); await sleep(30); }
  await viewOnPane("red", "5-mid-drag");
  await mouse("mouseReleased", e0.x - 160, e0.y);
  await settle(800);
  r = await report();
  note("after the drag", r);
  check("dragging the edge 160 left widens the panel by 160", near(r.panel.box.w, before + 160, 1.5), { before, after: r.panel.box.w });
  check("…and the share is the window's to remember", r.share !== null && near(r.share * r.host.w, r.panel.box.w, 1.5), { share: r.share });
  await viewOnPane("red", "5-dragged");
  await shot("7-edge-dragged");
  await api.call("settings.get", { key: "ui.view:" + (await evalIn(c, `__live.st().activeProfileId`)) }).then((v) => check("…written down with the view", near((v?.value?.panelShare ?? 0) * r.host.w, r.panel.box.w, 1.5), v?.value?.panelShare)).catch((e) => note("settings.get", String(e)));

  // ── 6. Folding the sidebar ──────────────────────────────────────────────────────────────────
  const hostBefore = r.host.w, share = r.share;
  await S(`await s.toggleSidebar()`);
  await settle(1200);
  r = await report();
  note("sidebar folded", r);
  check("folded, the main area takes the sidebar's width", r.host.w > hostBefore + 200, { before: hostBefore, after: r.host.w });
  check("…and the panel keeps its share of it", near(r.panel.box.w, Math.round(share * r.host.w), 1.5), { panel: r.panel.box.w, want: share * r.host.w });
  await viewOnPane("red", "6-folded");
  await shot("8-sidebar-folded");
  await S(`await s.toggleSidebar()`);
  await settle(1200);
  await viewOnPane("red", "6-unfolded");

  // ── 7. A window too narrow for the panel beside the panes ─────────────────────────────────────
  await S(`s.resizePanel(0.5, { commit: true })`);
  await size(1180, 900);
  await settle(1000);
  r = await report();
  note("narrow window, two panes", r);
  check("too narrow for the panel beside two panes: it steps aside, and the panes keep their floor", r.panel?.hidden === true && floorsHeld(r), { host: r.host.w, panes: r.panes.map((p) => p.box.w) });
  check("…the toggle says so, unlit", r.toggle && r.toggle.on === false && /no room beside these panes/.test(r.toggle.title), r.toggle);
  const views7 = await views();
  check("…and no native view is on screen for it", Object.values(views7).every((v) => !v.shown || v.width === 0), views7);
  await shot("9-narrow-panel-aside");
  const toggleBox = await evalIn(c, `__live.box(document.querySelector('.window-trail button'))`);
  await click(center(toggleBox).x, center(toggleBox).y);
  await settle(900);
  r = await report();
  check("the toggle shows the panel in the panes' place", r.panel?.full === true && r.panes.length === 0 && r.toggle?.on === true, r.panel);
  await viewOnPane("red", "7-full-view");
  await shot("10-no-room-full-view");
  await click(center(toggleBox).x, center(toggleBox).y);
  await settle(800);
  r = await report();
  check("lit there, it gives the panes back and puts the panel away", r.panes.length === 2 && r.zoomed === null && r.hidden === true, { zoomed: r.zoomed, hidden: r.hidden });
  await S(`s.focusLeaf(__live.leafOf(${JSON.stringify(sessions.bravo.itemId)})); await s.splitFocused("row")`);
  await settle(500);
  const toast = await evalIn(c, `__live.st().toasts.at(-1)?.text ?? null`);
  check("a split with no room is refused, and the toast says why", /No room for another pane beside it/.test(toast ?? ""), toast);
  await shot("11-split-refused-toast");
  await S(`s.setPaletteOpen(true)`);
  await settle(400);
  await evalIn(c, `(() => { const i = document.querySelector('.palette input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "split"); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await settle(400);
  const opts = await evalIn(c, `[...document.querySelectorAll('.palette-opt')].map((o) => ({ text: o.textContent, disabled: o.getAttribute('aria-disabled') === 'true' }))`);
  check("the palette draws the splits unavailable, with the sentence", opts.some((o) => /Split right/.test(o.text) && o.disabled && /No room/.test(o.text)), opts);
  await shot("12-palette-split-refused");
  await S(`s.setPaletteOpen(false)`);
  await S(`await s.toggleSidePanes()`);
  await size(1600, 1000);
  await settle(1000);

  // ── 8. Pane focus, a refused drop edge, the light face ──────────────────────────────────────
  await S(`await s.focusPaneFull(__live.leafOf(${JSON.stringify(sessions.alpha.itemId)}))`);
  await settle(800);
  r = await report();
  check("pane focus fills the panes' place with one pane, the panel still beside it", r.panes.length === 1 && r.panes[0].title === "Alpha" && r.panel && !r.panel.hidden, { panes: r.panes.map((p) => p.title), panel: r.panel?.box });
  await viewOnPane("red", "8-pane-focus");
  await shot("13-pane-focus-with-panel");
  await S(`await s.unfocusPane()`);
  await settle(600);
  // A drag of a session row over Bravo's right edge, in a window with no room for a third pane.
  await size(1200, 900);
  await settle(900);
  await evalIn(c, `(() => {
    const dt = new DataTransfer(); dt.setData('application/x-realm-item', ${JSON.stringify(sessions.charlie.itemId)});
    window.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    globalThis.__liveDt = dt; return true; })()`);
  await settle(300);
  const overlay = await evalIn(c, `__live.box([...document.querySelectorAll('.view-main .panel')].find((p) => p.dataset.item === ${JSON.stringify(sessions.bravo.itemId)}).querySelector('.drop-overlay'))`);
  await evalIn(c, `(() => { const o = [...document.querySelectorAll('.view-main .panel')].find((p) => p.dataset.item === ${JSON.stringify(sessions.bravo.itemId)}).querySelector('.drop-overlay');
    o.dispatchEvent(new DragEvent('dragover', { dataTransfer: globalThis.__liveDt, bubbles: true, cancelable: true, clientX: ${overlay ? overlay.r - 10 : 0}, clientY: ${overlay ? (overlay.t + overlay.b) / 2 : 0} })); return true; })()`);
  await settle(300);
  const zone = await evalIn(c, `(() => { const z = document.querySelector('.drop-zone[data-hot]'); return z ? { edge: z.dataset.edge, refused: z.hasAttribute('data-refused'), why: z.textContent } : null; })()`);
  check("a drop edge with no room lights as refused, and says why", zone?.edge === "right" && zone.refused && /No room/.test(zone.why), zone);
  await shot("14-refused-drop-edge");
  await evalIn(c, `(() => { window.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true; })()`);
  await size(1600, 1000);
  await settle(800);
  // Three panes, both sessions' tabs, in the light face.
  await S(`s.focusLeaf(__live.leafOf(${JSON.stringify(sessions.bravo.itemId)})); await s.openItemBeside(${JSON.stringify(sessions.charlie.itemId)})`);
  await S(`await s.setThemePref("dark")`);
  await settle(900);
  await shot("15-dark-three-and-merged-strip");
  await S(`await s.setThemePref("light")`);
  await settle(1200);
  r = await report();
  check("the light face draws the same view", r.panes.length === 3 && r.tabs.length === 2 && r.runs === 1, r.tabs);
  await shot("16-light-three-and-merged-strip");
  await S(`await s.setThemePref("dark")`);
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
