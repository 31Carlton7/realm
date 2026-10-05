/**
 * Live check for one list with no rooms (run with: pnpm build && node apps/desktop/scripts/one-list-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and proves, in the real window, what Plan 27's third
 * phase promised:
 *
 *   1. Every space of the profile is loaded at once: sessions made over RPC in a second space reach
 *      the window's lists without anybody going there.
 *   2. Sessions from two different spaces stand side by side in ONE view, each with its own side
 *      pane — a terminal beside the one from Homework, a browser beside the one from Thesis.
 *   3. Moving the keyboard between them unloads nothing: both spaces' items stay loaded, the view is
 *      untouched, no pane remounts, and the current space follows the focus.
 *   4. A view shows at most two panes: no split is offered at two, and a session dropped on an edge
 *      takes the OTHER side's place — whose side pane is kept, its browser page alive behind the
 *      screen, and comes back with it.
 *   5. No group bar and no "New split", anywhere.
 *   6. A relaunch restores the view: the same two sessions, each with its side pane, the same focus.
 *
 * Sessions are the fake agent's, made over RPC. Onboarding's own session runs a real, billed engine:
 * it is switched to the fake before anything could be sent to it, and nothing is typed into any
 * prompter. Ports: LIVE_SERVER_PORT (8978), LIVE_CDP_PORT (9378), LIVE_MAIN_INSPECT_PORT (9478),
 * LIVE_SITE_PORT (8988). Touches only a scratch dir; kills only what listens on its own ports and
 * was started from this checkout; browses nothing but its own 127.0.0.1 fixture. Screenshots go to
 * LIVE_SHOTS (default: the OS temp dir) for a person to read.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** A window this script starts opens behind whatever the person at the Mac has in front, and Chromium
 *  stops laying out a covered window — the browser pane's native view would get no bounds. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8978);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9378);
/** Main's own inspector — the one place that knows which native browser view is on screen. */
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9478);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8988);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const WINDOW = { width: 1600, height: 1000 };
const SHOTS = process.env.LIVE_SHOTS ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-one-list-live-"));
const home = path.join(scratch, "home");
const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const ALPHA = "Alpha in Homework", BRAVO = "Bravo in Thesis", CHARLIE = "Charlie in Thesis";
const PAGE_TITLE = "Thesis sources";
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
    await sleep(150);
  }
}

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
    }
  });
  return { ws, ready, pending, errors, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready, errors: s.errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    // Bounded: a server that went away mid-run fails the run with its name on it.
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s — is the server still up?`)); }, 30_000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

/**
 * Page-side reads, one round trip each. The store is found from the DOM up — the provider's value
 * on the fiber above the pane host — so the script reads exactly what the window holds, and never
 * reaches into anything the app exports for tests (it exports nothing).
 */
const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  store() {
    if (globalThis.__liveStore) return globalThis.__liveStore;
    const el = document.querySelector('.panehost') ?? document.querySelector('#root > *');
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && typeof v.subscribe === 'function') {
        const st = v.getState();
        if (st && 'activeProfileId' in st && 'view' in st) { globalThis.__liveStore = v; return v; }
      }
    }
    return null;
  },
  st() { return __live.store().getState(); },
  /** The view as the window holds it, by title: the main panes, the side panes on screen, the side
   *  panes remembered for sessions off screen, where the keyboard is, and the current space. */
  view() {
    const s = __live.st();
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const t = (id) => id == null ? null : (byId.get(id)?.title ?? id);
    const leaves = [];
    const walk = (n) => { if (!n) return; if (n.type === 'leaf') leaves.push(n); else n.children.forEach(walk); };
    walk(s.layout);
    return {
      panes: leaves.filter((l) => !l.tabs).map((l) => t(l.itemId)),
      sides: leaves.filter((l) => l.tabs).map((l) => ({ owner: t(l.owner), tabs: l.tabs.map((id) => ({ id, title: t(id), kind: byId.get(id)?.kind ?? null })), showing: t(l.itemId), leaf: l.id })),
      remembered: Object.fromEntries(Object.entries(s.view?.sidePanes ?? {}).map(([o, sp]) => [t(o), { tabs: sp.tabs.map((id) => ({ id, title: t(id), kind: byId.get(id)?.kind ?? null })), showing: t(sp.itemId) }])),
      focused: t(leaves.find((l) => l.id === s.focusedLeafId)?.itemId ?? null),
      leafOf: Object.fromEntries(leaves.filter((l) => !l.tabs && l.itemId).map((l) => [t(l.itemId), l.id])),
      current: s.spaces.find((sp) => sp.id === s.activeSpaceId)?.name ?? null,
      zoomed: s.view?.zoomedLeafId ?? null,
    };
  },
  /** Every space of the window's profile and the titles of the items it holds for it. */
  loaded() {
    const s = __live.st();
    const out = {};
    for (const sp of s.spaces.filter((x) => x.profileId === s.activeProfileId)) out[sp.name] = s.items.filter((i) => i.spaceId === sp.id && !i.archived).map((i) => i.title).sort();
    return out;
  },
  held() {
    const s = __live.st();
    return { items: s.items.map((i) => i.id).sort(), sessions: Object.keys(s.sessions).sort(), environments: Object.keys(s.environments).sort(), projects: s.projects.map((p) => p.id).sort() };
  },
  /** The panels the window draws, in DOM order. */
  panels() {
    return [...document.querySelectorAll('.panehost .panel')].map((p) => ({
      leaf: p.dataset.leafId, tabbed: p.hasAttribute('data-tabbed'), focused: p.hasAttribute('data-focused'),
      title: p.querySelector(':scope > .panel-bar .panel-title')?.textContent ?? null,
      tabs: [...p.querySelectorAll('[role=tab]')].map((x) => ({ name: x.textContent, selected: x.getAttribute('aria-selected') === 'true' })),
      box: __live.box(p),
    }));
  },
  panel(leaf) { return document.querySelector('.panehost .panel[data-leaf-id="' + leaf + '"]'); },
  chrome() {
    const words = [...document.querySelectorAll('button, [role=menuitem], [role=option], [role=tab]')].map((b) => (b.textContent ?? '') + ' ' + (b.getAttribute('aria-label') ?? ''));
    return { groupBar: document.querySelectorAll('.group-bar').length, newSplit: words.filter((w) => /new split/i.test(w)).length,
      splitButtons: document.querySelectorAll('.panel-bar button[aria-label^="Split "]').length };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { expression: expr, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`main exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A real pointer: move there, press, release. */
async function clickAt(c, { x, y }) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(60);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
const centre = (b) => ({ x: Math.round((b.l + b.r) / 2), y: Math.round((b.t + b.b) / 2) });

/** A chord as the window gets it from the keyboard: down and up, with the modifiers held. */
async function press(c, { key, code, keyCode, meta = false, shift = false }) {
  const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

async function shot(c, tag) {
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(SHOTS, { recursive: true });
    const out = path.join(SHOTS, `realm-one-list-${tag}.png`);
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${out}`);
  } catch (e) { note("screenshot failed", String(e)); }
}

/** ⌘K, the query typed, and the row whose label is exactly `label` clicked. Never a prompter: the
 *  palette's own field must have the keyboard before a character goes anywhere. */
async function palette(c, query) {
  await press(c, { key: "k", code: "KeyK", keyCode: 75, meta: true });
  await until(() => evalIn(c, `document.activeElement?.getAttribute('role') === 'combobox' && document.activeElement?.getAttribute('aria-label') === 'Command palette'`), 5_000, "the palette's field has the keyboard");
  await evalIn(c, `(() => { const i = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(query)});
    i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(150);
}
const paletteLabels = (c) => evalIn(c, `[...document.querySelectorAll('.palette [role=option] .palette-label')].map((o) => o.textContent)`);
async function paletteRun(c, query, label = query) {
  await palette(c, query);
  const box = await until(() => evalIn(c, `(() => { const o = [...document.querySelectorAll('.palette [role=option]')].find((x) => x.querySelector('.palette-label')?.textContent === ${JSON.stringify(label)});
    return o ? __live.box(o) : null; })()`), 5_000, `the palette row "${label}"`);
  await clickAt(c, centre(box));
  await until(() => evalIn(c, `!document.querySelector('.palette-backdrop')`), 5_000, "the palette closed");
}
async function paletteClose(c) {
  await press(c, { key: "Escape", code: "Escape", keyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector('.palette-backdrop')`), 5_000, "the palette closed");
}

/** The fixture page the browser beside Thesis's session shows: loud enough to read in a capture. */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${PAGE_TITLE}</title><body style="margin:0;font:600 28px system-ui;background:#1d4ed8;color:white;display:grid;place-items:center;height:100vh">
        <div><h1 style="margin:0">${PAGE_TITLE}</h1><p style="font-weight:400;font-size:18px">The page open beside ${BRAVO}.</p></div>`);
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** Every fixture page main holds, attached or not: whether its view is in the window and drawn,
 *  and its size. A page cannot say (the views run unthrottled, so a hidden page reads as visible),
 *  and a DOM capture leaves native views out. */
const views = (m) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView, webContents } = require("electron");
  const out = {};
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.getURL().startsWith(${JSON.stringify(SITE)})) continue;
    out[wc.id] = { url: wc.getURL().slice(${SITE.length}), attached: false, shown: false, width: 0 };
  }
  for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
    if (!(v instanceof WebContentsView) || !out[v.webContents.id]) continue;
    const b = v.getBounds();
    Object.assign(out[v.webContents.id], { attached: true, shown: v.getVisible(), width: b.width, height: b.height });
  }
  return out;
})()`);
const onScreen = (v) => Object.values(v).filter((x) => x.attached && x.shown && x.width > 0);

async function holdKey(c) {
  /* The window this opens is rarely the key one, and an unkeyed Mac window greys its accent; the
     page is also told it has focus, or Realm goes quiet. Held for the run in case focus moves. */
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

/** Boot the built app on the scratch home and attach to its renderer and its main process. */
async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) await until(() => portFree(p), 15_000, `port ${p} free`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
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
  await until(() => inMain(m, `require("electron").BrowserWindow.getAllWindows().length > 0`), 20_000, "the window");
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");
  return { c, m };
}

const connectApi = async () => {
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
};

/** The app and its server gone, and their ports with them — the site is the caller's. */
async function shutDown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  api = null;
  electron?.kill("SIGKILL");
  electron = null;
  await sleep(600);
  daemonPids.push(...(await stopDaemons(home, daemonPids)));
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killOwnPort(p);
}

/** Whatever still listens on one of this run's ports — but only if it was started from this checkout
 *  or names this run's scratch dir. Never a name match, never someone else's app. */
function killOwnPort(port) {
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { /* nothing listening */ }
  for (const pid of pids) {
    let cmd = "";
    try { cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { continue; }
    if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

/** A session settled: idle, and its log no longer moving. */
const settled = (id) => until(async () => {
  const a = await api.call("sessions.get", { id });
  if (a.status !== "idle") return null;
  await sleep(300);
  const b = await api.call("sessions.get", { id });
  return b.status === "idle" && b.lastEventSeq === a.lastEventSeq ? b : null;
}, 15_000, `session ${id} settled`);

const sameSet = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sidesBrief = (v) => v.sides.map((s) => ({ owner: s.owner, tabs: s.tabs.map((t) => t.kind) }));

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  for (const f of ["apps/desktop/out/main/index.js", "apps/server/dist/main.js"]) {
    if (!fs.existsSync(path.join(repoRoot, f))) throw new Error(`${f} is missing — run \`pnpm build\` first`);
  }
  site = await startSite();
  let { c, m } = await launch();

  // ── Onboarding makes Homework. Its session is a real engine: switched to the fake at once. ─────
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Homework');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await connectApi();
  const [homework] = await api.call("spaces.list", {});
  const profileId = homework.profileId;
  for (const s of await api.call("sessions.listAll", { profileId })) {
    if (s.agentKind !== "fake") await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  }
  await holdKey(c);

  // ── Seed: a second space, and fake sessions in both, through the real create/send seam. ───────
  const thesis = await api.call("spaces.create", { profileId, name: "Thesis", icon: "folder" });
  const make = async (space, title) => api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title });
  const alpha = await make(homework, ALPHA);
  const bravo = await make(thesis, BRAVO);
  const charlie = await make(thesis, CHARLIE);
  // A turn each, so every pane shows whose it is.
  for (const s of [alpha, bravo, charlie]) { await api.call("sessions.send", { id: s.session.id, text: "hello" }); await settled(s.session.id); }

  /* ── 1. Every space of the profile is loaded at once ─────────────────────────────────────────── */
  const loaded = await until(async () => {
    const l = await evalIn(c, `__live.loaded()`);
    return l.Thesis?.includes(BRAVO) && l.Thesis?.includes(CHARLIE) && l.Homework?.includes(ALPHA) ? l : null;
  }, 15_000, "both spaces' sessions in the window").catch(() => evalIn(c, `__live.loaded()`));
  const v0 = await evalIn(c, `__live.view()`);
  check("every space of the profile is loaded at once — Thesis's sessions reach the window while Homework is current",
    v0.current === "Homework" && loaded.Thesis?.includes(BRAVO) && loaded.Thesis?.includes(CHARLIE) && loaded.Homework?.includes(ALPHA), { current: v0.current, loaded });

  /* ── 2. Two spaces side by side, each session with its own side pane ─────────────────────────── */
  await paletteRun(c, ALPHA);
  await until(async () => (await evalIn(c, `__live.view()`)).focused === ALPHA, 10_000, "Alpha open");
  // The session's bar carries no tools: a terminal is opened from its side pane (a new tab's page).
  await openSideTool(c, ALPHA, "Terminal");
  const vA = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.sides.find((s) => s.owner === ALPHA && s.tabs.length === 1 && s.tabs[0].kind === "terminal") ? v : null;
  }, 15_000, "Alpha's terminal side pane").catch(async (e) => { note("view at timeout", await evalIn(c, `__live.view()`)); throw e; });
  check("Alpha's terminal opens as its side pane, not a column of its own", sameSet(vA.panes, [ALPHA]) && vA.sides.length === 1, { panes: vA.panes, sides: sidesBrief(vA) });

  await paletteRun(c, BRAVO);
  const vB = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.panes.includes(BRAVO) ? v : null;
  }, 10_000, "Bravo open");
  check("opening Thesis's session from Homework takes the pane — no room switch — and Alpha's side pane is remembered",
    sameSet(vB.panes, [BRAVO]) && vB.sides.length === 0 && vB.remembered[ALPHA]?.tabs[0]?.kind === "terminal" && vB.current === "Thesis",
    { panes: vB.panes, sides: sidesBrief(vB), remembered: Object.keys(vB.remembered), current: vB.current });
  await openSideTool(c, BRAVO, "New tab");
  const vB2 = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.sides.find((s) => s.owner === BRAVO && s.tabs[0]?.kind === "browser") ? v : null;
  }, 15_000, "Bravo's browser side pane");
  const browserSide = vB2.sides.find((s) => s.owner === BRAVO);
  const browserItemId = browserSide.tabs[0].id;
  // The page, typed into the browser's own address field as a person would.
  await until(() => evalIn(c, `!!__live.panel(${JSON.stringify(browserSide.leaf)})?.querySelector('input[aria-label="Address"]')`), 10_000, "the address field");
  await evalIn(c, `(() => { const i = __live.panel(${JSON.stringify(browserSide.leaf)}).querySelector('input[aria-label="Address"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(`${SITE}/sources`)});
    i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').requestSubmit(); return true; })()`);
  await until(async () => (await evalIn(c, `__live.panels()`)).some((p) => p.tabs.some((t) => t.name === PAGE_TITLE)), 15_000, "the browser tab titled by its page")
    .catch(async () => note("tabs at timeout", (await evalIn(c, `__live.panels()`)).map((p) => p.tabs)));

  // A second pane beside, and Alpha in it: Alpha's side pane comes back with it.
  await paletteRun(c, "Split right");
  await until(async () => (await evalIn(c, `__live.view()`)).panes.length === 2, 5_000, "the split");
  await paletteRun(c, ALPHA);
  const two = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.panes.length === 2 && v.panes.includes(ALPHA) && v.panes.includes(BRAVO) && v.sides.length === 2 ? v : null;
  }, 10_000, "Alpha beside Bravo").catch(async (e) => { note("view at timeout", await evalIn(c, `__live.view()`)); throw e; });
  await sleep(800);
  const panels2 = await evalIn(c, `__live.panels()`);
  note("view, two spaces side by side", two);
  check("sessions from two spaces stand side by side in one view", sameSet(two.panes, [BRAVO, ALPHA]), two.panes);
  check("…each with its own side pane intact — Alpha's terminal, Bravo's browser",
    two.sides.find((s) => s.owner === ALPHA)?.tabs.map((t) => t.kind).join() === "terminal"
      && two.sides.find((s) => s.owner === BRAVO)?.tabs.map((t) => t.id).join() === browserItemId, sidesBrief(two));
  check("…drawn as four panels, two of them tabbed side panes", panels2.length === 4 && panels2.filter((p) => p.tabbed).length === 2
    && panels2.filter((p) => !p.tabbed).map((p) => p.title).sort().join("|") === [ALPHA, BRAVO].sort().join("|"),
    panels2.map((p) => ({ title: p.title, tabs: p.tabs.map((t) => t.name), w: p.box.w })));
  check("the current space is the focused session's", two.focused === ALPHA && two.current === "Homework", { focused: two.focused, current: two.current });
  const v2 = await views(m);
  check("Bravo's browser page is on screen beside it", onScreen(v2).length === 1 && onScreen(v2)[0].url === "/sources", v2);
  const chrome2 = await evalIn(c, `__live.chrome()`);
  check("no group bar, no New split, and no split offered in a pane bar at two panes", chrome2.groupBar === 0 && chrome2.newSplit === 0 && chrome2.splitButtons === 0, chrome2);
  await palette(c, "Split");
  const splitRows = (await paletteLabels(c)).filter((l) => /^Split (right|down)$/.test(l));
  await paletteClose(c);
  check("…nor in the palette", splitRows.length === 0, splitRows);
  await shot(c, "two-spaces");

  /* ── 3. Moving the keyboard between them unloads nothing ──────────────────────────────────────── */
  await evalIn(c, `(() => { document.querySelectorAll('.panehost .pane-slot').forEach((el, i) => { el.dataset.liveMark = 'slot-' + i; }); return true; })()`);
  const marks = await evalIn(c, `[...document.querySelectorAll('.panehost .pane-slot[data-live-mark]')].map((el) => el.dataset.liveMark)`);
  const heldBefore = await evalIn(c, `__live.held()`);
  const focusOn = async (title) => {
    const leaf = (await evalIn(c, `__live.view()`)).leafOf[title];
    const body = await evalIn(c, `__live.box(__live.panel(${JSON.stringify(leaf)}).querySelector('.panel-body'))`);
    await clickAt(c, { x: Math.round((body.l + body.r) / 2), y: Math.round(body.t + 40) });
    return until(async () => { const v = await evalIn(c, `__live.view()`); return v.focused === title ? v : null; }, 5_000, `focus on ${title}`);
  };
  const toBravo = await focusOn(BRAVO);
  await sleep(500);
  const heldBravo = await evalIn(c, `__live.held()`);
  const marksBravo = await evalIn(c, `[...document.querySelectorAll('.panehost .pane-slot[data-live-mark]')].map((el) => el.dataset.liveMark)`);
  check("a click into Bravo makes Thesis current", toBravo.current === "Thesis", { current: toBravo.current });
  check("…and unloads nothing: every item, session, checkout and project of both spaces is still held",
    sameSet(heldBefore, heldBravo), { before: { items: heldBefore.items.length, sessions: heldBefore.sessions.length }, after: { items: heldBravo.items.length, sessions: heldBravo.sessions.length } });
  check("…the view is untouched: the same two panes, the same two side panes", sameSet(toBravo.panes, two.panes) && sameSet(sidesBrief(toBravo), sidesBrief(two)), { panes: toBravo.panes, sides: sidesBrief(toBravo) });
  check("…and no pane remounted — every pane's own element is the one it was", sameSet(marks, marksBravo) && marks.length >= 4, { before: marks, after: marksBravo });
  await shot(c, "focus-thesis");
  const toAlpha = await focusOn(ALPHA);
  await sleep(300);
  check("a click back into Alpha makes Homework current again, still unloading nothing",
    toAlpha.current === "Homework" && sameSet(heldBefore, await evalIn(c, `__live.held()`)) && sameSet(marks, await evalIn(c, `[...document.querySelectorAll('.panehost .pane-slot[data-live-mark]')].map((el) => el.dataset.liveMark)`)),
    { current: toAlpha.current });

  /* ── 4. A third session dropped on an edge takes the other side's place ─────────────────────── */
  // The page marked, to tell a page that lived on from one loaded again.
  const fixtureId = Number(Object.keys(v2)[0]);
  await inMain(m, `require("electron").webContents.fromId(${fixtureId}).executeJavaScript("window.__liveMark = 'kept'; true")`);
  const alphaLeaf = toAlpha.leafOf[ALPHA];
  await evalIn(c, `(() => { const dt = new DataTransfer(); dt.setData('application/x-realm-item', ${JSON.stringify(charlie.itemId)}); globalThis.__liveDrag = dt;
    window.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await until(() => evalIn(c, `!!__live.panel(${JSON.stringify(alphaLeaf)})?.querySelector('.drop-overlay')`), 5_000, "the drop zones");
  await evalIn(c, `(() => { const ov = __live.panel(${JSON.stringify(alphaLeaf)}).querySelector('.drop-overlay'); const r = ov.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.right - 8, clientY: r.top + r.height / 2, dataTransfer: globalThis.__liveDrag };
    ov.dispatchEvent(new DragEvent('dragover', at)); ov.dispatchEvent(new DragEvent('drop', at));
    window.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true; })()`);
  const three = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.panes.includes(CHARLIE) ? v : null;
  }, 8_000, "Charlie dropped").catch(async (e) => { note("view at timeout", await evalIn(c, `__live.view()`)); throw e; });
  await sleep(800);
  note("view, Charlie dropped on Alpha's right edge", three);
  check("a session dropped on Alpha's right edge takes the OTHER side's place — still two panes, Charlie on the right",
    sameSet(three.panes, [ALPHA, CHARLIE]), three.panes);
  check("…Alpha keeps its side pane on screen; Bravo's is remembered, browser and all",
    sameSet(sidesBrief(three), [{ owner: ALPHA, tabs: ["terminal"] }]) && three.remembered[BRAVO]?.tabs.map((t) => t.id).join() === browserItemId,
    { sides: sidesBrief(three), remembered: Object.fromEntries(Object.entries(three.remembered).map(([k, sp]) => [k, sp.tabs.map((t) => t.kind)])) });
  const v3 = await views(m);
  check("…and Bravo's page is off screen but alive", Object.keys(v3).length === 1 && onScreen(v3).length === 0, v3);
  check("the current space follows the keyboard to Charlie's", three.focused === CHARLIE && three.current === "Thesis", { focused: three.focused, current: three.current });
  await shot(c, "third-replaces-other-side");

  await paletteRun(c, BRAVO);
  const back = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.panes.includes(BRAVO) ? v : null;
  }, 8_000, "Bravo back");
  await sleep(800);
  const v4 = await views(m);
  check("Bravo back in Charlie's place brings its own side pane — the same browser", sameSet(back.panes, [ALPHA, BRAVO])
    && back.sides.find((s) => s.owner === BRAVO)?.tabs.map((t) => t.id).join() === browserItemId && back.sides.find((s) => s.owner === ALPHA)?.tabs[0]?.kind === "terminal",
    { panes: back.panes, sides: sidesBrief(back) });
  const kept = await inMain(m, `require("electron").webContents.fromId(${fixtureId})?.executeJavaScript("window.__liveMark ?? null")`).catch(() => null);
  check("…its page on screen again, the very page — never reloaded", onScreen(v4).length === 1 && onScreen(v4)[0].url === "/sources" && kept === "kept", { views: v4, mark: kept });
  await shot(c, "bravo-back");

  /* ── 6. A relaunch restores the view ──────────────────────────────────────────────────────────── */
  const before = await focusOn(ALPHA);
  await sleep(1000);
  const stored = (await api.call("settings.get", { key: `ui.view:${profileId}` })).value;
  const storedView = typeof stored === "string" ? JSON.parse(stored) : stored;
  const storedItems = [];
  const walk = (n) => { if (!n) return; if (n.type === "leaf") { if (n.itemId) storedItems.push(n.itemId); for (const t of n.tabs ?? []) if (t !== n.itemId) storedItems.push(t); } else n.children.forEach(walk); };
  walk(storedView?.layout);
  const ids = await evalIn(c, `(() => { const s = __live.st(); const out = []; const w = (n) => { if (!n) return; if (n.type === 'leaf') { if (n.itemId) out.push(n.itemId); for (const t of n.tabs ?? []) if (t !== n.itemId) out.push(t); } else n.children.forEach(w); }; w(s.layout); return out; })()`);
  check("the view is saved under the profile, as the window shows it — the keyboard's place with it",
    sameSet([...storedItems].sort(), [...ids].sort()) && storedView?.focusedItemId === alpha.itemId,
    { stored: storedItems.length, shown: ids.length, focusSaved: storedView?.focusedItemId === alpha.itemId });
  await shutDown();
  ({ c, m } = await launch());
  await until(() => evalIn(c, `!!__live.store()?.getState().booted`), 30_000, "the relaunched window booted");
  await holdKey(c);
  await connectApi();
  const after = await until(async () => {
    const v = await evalIn(c, `__live.view()`);
    return v.panes.length === 2 && v.sides.length === 2 ? v : null;
  }, 20_000, "the view restored").catch(() => evalIn(c, `__live.view()`));
  await sleep(1500);
  note("view, relaunched", after);
  check("a relaunch restores the view: the same two sessions, in the same places", sameSet(after.panes, before.panes), { before: before.panes, after: after.panes });
  check("…each with its side pane", sameSet(sidesBrief(after), sidesBrief(before)) && after.sides.find((s) => s.owner === BRAVO)?.tabs[0]?.id === browserItemId, sidesBrief(after));
  check("…the keyboard where it was, and its space current", after.focused === ALPHA && after.current === "Homework", { focused: after.focused, current: after.current });
  const loadedAfter = await evalIn(c, `__live.loaded()`);
  check("…with every space's items loaded again", loadedAfter.Thesis?.includes(BRAVO) && loadedAfter.Thesis?.includes(CHARLIE) && loadedAfter.Homework?.includes(ALPHA), loadedAfter);
  const v5 = await until(async () => { const v = await views(m); return onScreen(v).length === 1 ? v : null; }, 15_000, "the page after relaunch").catch(() => views(m));
  check("…and Bravo's page back on screen beside it", onScreen(v5).length === 1 && onScreen(v5)[0].url === "/sources", v5);
  note("the browser tab's title after the relaunch", (await evalIn(c, `__live.view()`)).sides.find((sd) => sd.owner === BRAVO)?.tabs[0]?.title);
  const chrome5 = await evalIn(c, `__live.chrome()`);
  check("still no group bar after the relaunch", chrome5.groupBar === 0 && chrome5.newSplit === 0, chrome5);
  await shot(c, "relaunched");
  // The page itself, from its own view: a capture of the window leaves native views out.
  const pagePng = await inMain(m, `(async () => { const { webContents } = require("electron"); const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(${JSON.stringify(SITE)}));
    return wc ? (await wc.capturePage()).toPNG().toString("base64") : null; })()`).catch(() => null);
  if (pagePng) { const out = path.join(SHOTS, "realm-one-list-relaunched-browser.png"); fs.writeFileSync(out, Buffer.from(pagePng, "base64")); console.log(`SCREENSHOT relaunched-browser ${out}`); }

  const errs = c.errors.filter((e) => !/Autofill/.test(e));
  if (errs.length) note("renderer console errors after the relaunch", errs.slice(0, 8));
  check("no renderer exceptions after the relaunch", !errs.some((e) => /^(Uncaught|TypeError|ReferenceError)/.test(e)), errs.slice(0, 3));
}

async function teardown() {
  await shutDown();
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  site = null;
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
