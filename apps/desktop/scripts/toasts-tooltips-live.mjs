/**
 * Live check for v2's toasts, its tooltip layer, and a plain folder having no worktrees
 * (run with: pnpm build && node apps/desktop/scripts/toasts-tooltips-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and checks, in the real window:
 *
 *   1. A space made from nothing (onboarding with no folder, and one from the New space sheet) is a
 *      plain folder, and nothing asks it for a worktree: no "New worktree…" in the prompter's
 *      workspace menu, none in the palette or the space's ⋯, no worktree row in the database, and no
 *      toast — where v1.6 put "…is not a git repository, so it has no worktrees" across the top.
 *   2. Toasts: a real failed action, a real refused attachment and a receipt stack at the foot, newest
 *      in front, lifted over the docked prompter; under the pointer they fan out and their clocks and
 *      lines stop; off it they go on and leave; their words select. Dark and light, and reduced motion.
 *   3. Toasts beside a browser view — the browser in a side pane, filling the panes, and filling the
 *      window with the sidebar folded away — never stand where the view paints, measured against
 *      main's own bounds for every view; in the last case the view gives up the corner.
 *   4. Tooltips: the app's chip a fifth of a second after a real pointer arrives, at once on the next
 *      button, flipped over a browser toolbar button rather than under it onto the page, the title
 *      held off the system meanwhile, a shortcut shown as a key, keyboard focus showing it too.
 *
 * Captures: a CDP screenshot has no native view in it, so each one is composited with every visible
 * view's own `capturePage()` at main's bounds — the picture is what is on screen, not the DOM alone.
 *
 * Ports: LIVE_SERVER_PORT (8796), LIVE_CDP_PORT (9236), LIVE_MAIN_INSPECT_PORT (9336), LIVE_SITE_PORT
 * (8896). Touches only its scratch dir (LIVE_SCRATCH, default the system temp dir); writes pictures to
 * LIVE_OUT. Kills only what listens on its own ports. Nothing is billed: the one session is moved to
 * the fake agent before anything is sent, and REALM_ENABLE_FAKE_AGENT=1 turns the titler and recap off.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9236);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8796);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9336);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8896);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-toasts-tooltips-live-"));
const OUT = process.env.LIVE_OUT ?? path.join(scratch, "shots");
fs.mkdirSync(OUT, { recursive: true });
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const WINDOW = { width: 1440, height: 900 };
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
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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
    await sleep(100);
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

/** Page-side helpers, prepended to every evaluation (the page reloads during startup). The store is
 *  found from the DOM up, as one-list-live does — the provider's value on a fiber above the shell. */
const HELPERS = `
globalThis.__live ??= {
  store() {
    if (globalThis.__liveStore) return globalThis.__liveStore;
    const el = document.querySelector('.app') ?? document.querySelector('#root > *');
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && 'toasts' in v.getState()) { globalThis.__liveStore = v; return v; }
    }
    return null;
  },
  st() { return __live.store().getState(); },
  rect(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  scaleX(el) { const t = getComputedStyle(el).transform; if (t === 'none') return 0; return Number(t.match(/matrix\\(([^,]+)/)?.[1] ?? 0); },
  toasts() {
    return [...document.querySelectorAll('.toast')].map((t) => ({
      text: t.querySelector('.toast-text')?.textContent, tone: t.dataset.tone, role: t.getAttribute('role'),
      front: t.hasAttribute('data-front'), paused: t.hasAttribute('data-paused'), leaving: t.hasAttribute('data-leaving'),
      y: t.style.getPropertyValue('--toast-y'), rect: __live.rect(t),
    }));
  },
  stack() { const s = document.querySelector('.toasts'); return s ? { rect: __live.rect(s), expanded: s.hasAttribute('data-expanded') } : null; },
  tip() { const t = document.querySelector('.tooltip'); return t ? { open: t.hasAttribute('data-open'), instant: t.hasAttribute('data-instant'), side: t.dataset.side ?? null,
    label: t.querySelector('.tooltip-label')?.textContent, key: t.querySelector('.tooltip-key')?.hidden ? null : t.querySelector('.tooltip-key')?.textContent, rect: __live.rect(t) } : null; },
  keepKey() {
    const root = document.documentElement;
    root.removeAttribute('data-window-inactive');
    if (!globalThis.__keepKey) {
      globalThis.__keepKey = new MutationObserver(() => { if (root.hasAttribute('data-window-inactive')) root.removeAttribute('data-window-inactive'); });
      globalThis.__keepKey.observe(root, { attributes: true, attributeFilter: ['data-window-inactive'] });
    }
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A page that fills its view with one loud colour, so a capture says at a glance where the view is. */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Live page</title><body style="margin:0;height:100vh;background:#0a8f8f;color:#fff;font:600 28px system-ui;display:grid;place-items:center">a browser view (native)</body>`);
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

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
      // The prompter's and the sidebar's menus drawn in the DOM, so what they offer can be read.
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

/** Every visible browser view, as main has it: bounds in window DIPs, and the page it shows. */
const views = (m) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView } = require("electron");
  const out = [];
  for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
    if (!(v instanceof WebContentsView) || !v.getVisible()) continue;
    const b = v.getBounds();
    if (b.width > 0 && b.height > 0) out.push({ ...b, url: v.webContents.getURL() });
  }
  return out;
})()`);

/**
 * What is on screen, as one picture: the window's DOM from CDP, with every visible native view's own
 * capture laid over it at main's bounds — which is exactly what the window server does. `clip` is in
 * window px.
 */
async function shot(c, m, tag, clip) {
  const file = path.join(OUT, `${tag}.png`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    const dom = path.join(scratch, `${tag}-dom.png`);
    fs.writeFileSync(dom, Buffer.from(data, "base64"));
    const layers = await inMain(m, `(async () => {
      const { BrowserWindow, WebContentsView } = require("electron");
      const out = [];
      for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
        if (!(v instanceof WebContentsView) || !v.getVisible()) continue;
        const b = v.getBounds(); if (b.width <= 0 || b.height <= 0) continue;
        const img = await v.webContents.capturePage();
        out.push({ bounds: b, png: img.toPNG().toString("base64") });
      }
      return out;
    })()`);
    const parts = layers.map((l, k) => {
      const p = path.join(scratch, `${tag}-view${k}.png`);
      fs.writeFileSync(p, Buffer.from(l.png, "base64"));
      return { path: p, bounds: l.bounds };
    });
    execFileSync("python3", ["-c", `
import json, sys
from PIL import Image
spec = json.loads(sys.argv[1])
base = Image.open(spec["dom"]).convert("RGBA")
k = base.width / ${WINDOW.width}
for part in spec["parts"]:
    b = part["bounds"]
    view = Image.open(part["path"]).convert("RGBA").resize((round(b["width"] * k), round(b["height"] * k)))
    base.paste(view, (round(b["x"] * k), round(b["y"] * k)))
clip = spec["clip"]
if clip:
    base = base.crop((round(clip["x"] * k), round(clip["y"] * k), round((clip["x"] + clip["width"]) * k), round((clip["y"] + clip["height"]) * k)))
base.save(spec["out"])
`, JSON.stringify({ dom, parts, clip: clip ?? null, out: file })]);
    console.log(`SCREENSHOT ${tag} ${file}`);
  } catch (e) { note(`screenshot ${tag} failed`, String(e).slice(0, 300)); }
}

/** A real pointer: the move the window server would send, at window px. */
const pointerTo = (c, x, y) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const picked = await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 2000, `palette row ${label}`).catch(() => false);
  if (picked) return true;
  await evalIn(c, `(() => { document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  throw new Error(`no palette row: ${label}`);
}
/** What the palette offers for a query, then closed again. */
async function paletteOffers(c, query) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(300);
  const rows = await evalIn(c, `[...document.querySelectorAll(".palette-list [role=option] .palette-label")].map((l) => l.textContent.trim())`);
  await evalIn(c, `(() => { document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector(".palette input")`), 5000, "the palette closed").catch(() => {});
  return rows;
}

async function press(c, { key, code, keyCode, meta = false, shift = false }) {
  const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

/** How long, from now, until the tooltip opens — polled, so the figure is good to ~20ms. */
async function timeTipOpen(c, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    const t = await evalIn(c, `__live.tip()`);
    if (t?.open) return { ms: Date.now() - t0, tip: t };
    if (Date.now() - t0 > ms) return { ms: null, tip: t };
    await sleep(15);
  }
}

/** A checkout id of the right shape that names nothing: the server refuses it in a sentence. */
const NO_SUCH_ENV = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** Three toasts: a real failed action, a real refused attachment, and a receipt. */
const THREE = (sessionId) => `(async () => {
  const st = __live.st();
  st.run(() => st.setSessionEnvironment(${JSON.stringify(sessionId)}, ${JSON.stringify(NO_SUCH_ENV)}));
  await new Promise((r) => setTimeout(r, 350));
  st.attachPicked(${JSON.stringify(sessionId)}, [{ path: "/tmp/screen-recording.mov", mime: "video/quicktime", name: "screen-recording.mov", size: 26 * 1024 * 1024 }]);
  await new Promise((r) => setTimeout(r, 350));
  st.toast({ tone: "info", icon: "target", text: 'Added button "Sign in" to New session.' });
  return true;
})()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();
  const { c, m } = await launch();

  // Onboarding with no folder: the space gets the default one, which is a plain folder. Its first
  // session runs a REAL engine, so it goes to the fake agent before anything is sent.
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
  const [sess] = await api.call("sessions.list", { spaceId: space.id });
  await api.call("sessions.setAgent", { id: sess.id, agentKind: "fake" });
  // The user is at the Mac, so this window opens unkeyed — and a window that is not key stops the
  // toasts' clocks, which is right for the app and wrong for a check of them.
  await evalIn(c, `__live.keepKey()`);
  await until(() => evalIn(c, `!!__live.store()`), 10_000, "the store");

  // ── 1. A plain folder has no worktrees, and nothing asks it for one ─────────────────────────────
  const folder = space.folderPath;
  check("the onboarding space is a plain folder under the scratch home", folder.startsWith(home) && !fs.existsSync(path.join(folder, ".git")), { folder });
  await until(() => evalIn(c, `__live.st().gitInfo[${JSON.stringify(folder)}] === null`), 15_000, "git asked about the folder");
  const lone = await evalIn(c, `(() => { const strip = document.querySelector('.composer-understrip');
    return { button: !!strip?.querySelector('button[aria-label="Workspace"]'), label: strip?.querySelector('.ghost-chip[data-static][title^="Workspace"]')?.textContent ?? null }; })()`);
  check("with nowhere else to go, the workspace chip is the folder's name — no menu of one row", !lone.button && lone.label === "Live", lone);

  // A second space from the New space sheet — the other way v1.6 came up under the red bar.
  await evalIn(c, `(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New space')?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('input[aria-label="Space name"]')`), 5000, "the New space sheet");
  await evalIn(c, `(() => { const input = document.querySelector('input[aria-label="Space name"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Other");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(async () => (await api.call("spaces.list", {})).length === 2, 10_000, "the second space");
  await sleep(1500);
  check("making a plain-folder space raises nothing", (await evalIn(c, `__live.toasts().length`)) === 0 && !(await evalIn(c, `!!document.querySelector('.error-bar')`)));
  // Back to the first session, which can now move to the other space.
  await evalIn(c, `(async () => { const st = __live.st(); await st.revealSession(${JSON.stringify(sess.id)}, ${JSON.stringify(space.id)}); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer-understrip button[aria-label="Workspace"]')`), 10_000, "the workspace menu");
  await evalIn(c, `(() => { document.querySelector('.composer-understrip button[aria-label="Workspace"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[role=menu][aria-label="Workspace"]')`), 5000, "the menu open");
  const rows = await evalIn(c, `[...document.querySelectorAll('[role=menu][aria-label="Workspace"] [role^=menuitem]')].map((r) => r.textContent.trim())`);
  check("the prompter's workspace menu offers no worktree in a plain folder", !rows.some((r) => /worktree/i.test(r)) && rows.some((r) => r === "Move to Other"), rows);
  const composerBox = await evalIn(c, `__live.rect(document.querySelector('.composer-dock'))`);
  await shot(c, m, "1-plain-folder-workspace-menu-dark", { x: composerBox.x - 20, y: composerBox.y - 140, width: composerBox.width + 40, height: composerBox.height + 170 });
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(300);
  const offers = await paletteOffers(c, "worktree");
  check("the palette offers no session in a worktree there", !offers.includes("New session in a worktree"), offers);
  await evalIn(c, `(() => { document.querySelector('button[aria-label="More for Live"]')?.click(); return true; })()`);
  const more = await until(() => evalIn(c, `(() => { const m = document.querySelector('[role=menu][aria-label="Live"]'); return m ? [...m.querySelectorAll('[role^=menuitem]')].map((r) => r.textContent.trim()) : null; })()`), 5000, "the space's ⋯").catch(() => null);
  check("…nor does the space's ⋯ in the sidebar", Array.isArray(more) && !more.some((r) => /worktree/i.test(r)) && more.length > 0, more);
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(300);
  const worktreeRows = execFileSync("sqlite3", [path.join(home, "realm.db"), "select count(*) from environments where kind = 'worktree'"], { encoding: "utf8" }).trim();
  check("…and the server was never asked to make one: no worktree row", worktreeRows === "0", { worktreeRows });
  check("…and nothing at all was said about it", (await evalIn(c, `__live.toasts().length`)) === 0);

  // A reply, so the prompter docks at the pane's foot and a message has its actions (fake agent).
  await api.call("sessions.send", { id: sess.id, text: "Say hello." }).catch((e) => note("send", String(e)));
  await until(() => evalIn(c, `!!document.querySelector('button.msg-action[aria-label="Retry"]')`), 30_000, "the reply's actions").catch(() => note("no reply actions", null));
  await sleep(800);

  // ── 2. Three toasts at the foot ─────────────────────────────────────────────────────────────────
  await evalIn(c, THREE(sess.id));
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 3, 8000, "three toasts");
  await sleep(700);
  const three = await evalIn(c, `__live.toasts()`);
  const stack = await evalIn(c, `__live.stack()`);
  const dock = await evalIn(c, `__live.rect(document.querySelector('.composer-dock'))`);
  note("three toasts", { three: three.map((t) => [t.tone, t.role, t.front, t.y, t.text]), stack, dock });
  check("a failed action is an error toast, announced as an alert", three.some((t) => t.tone === "error" && t.role === "alert"));
  check("a refused attachment is a warning, a receipt an info status", three.some((t) => t.tone === "warning" && /Too large to attach/.test(t.text)) && three.some((t) => t.tone === "info" && t.role === "status"));
  check("the newest is in front and the others tucked behind it", three[0].front && three[0].tone === "info" && three.slice(1).every((t) => !t.front) && three[1].y === "-10px" && three[2].y === "-20px", three.map((t) => t.y));
  check("the stack stands at the window's right edge, over the docked prompter rather than on it",
    Math.abs(stack.rect.x + stack.rect.width - (WINDOW.width - 16)) < 1 && (!dock || !intersects(stack.rect, dock) || stack.rect.x > dock.x + dock.width), { stack: stack.rect, dock });
  await shot(c, m, "2-toasts-stack-dark", { x: WINDOW.width - 420, y: WINDOW.height - 330, width: 420, height: 330 });
  await shot(c, m, "2-toasts-window-dark");

  // Under the pointer: fanned out, every clock and line stopped.
  const front = three[0].rect;
  await pointerTo(c, front.x + front.width / 2, front.y + front.height / 2);
  await sleep(500);
  const fanned = await evalIn(c, `({ stack: __live.stack(), toasts: __live.toasts() })`);
  const lineA = await evalIn(c, `[...document.querySelectorAll('.toast-progress')].map((p) => __live.scaleX(p))`);
  await sleep(1500);
  const lineB = await evalIn(c, `[...document.querySelectorAll('.toast-progress')].map((p) => __live.scaleX(p))`);
  check("under the pointer the stack fans out and every toast is paused", fanned.stack.expanded && fanned.toasts.every((t) => t.paused) && new Set(fanned.toasts.map((t) => t.y)).size === 3, fanned.toasts.map((t) => t.y));
  check("…and the line across each foot stands still while it is", lineA.every((v, k) => Math.abs(v - lineB[k]) < 0.002), { lineA, lineB });
  await shot(c, m, "2-toasts-fanned-dark", { x: WINDOW.width - 420, y: WINDOW.height - 400, width: 420, height: 400 });
  // Its words select, for copying.
  const picked = await evalIn(c, `(() => { const t = document.querySelector('.toast[data-tone="error"] .toast-text'); const sel = getSelection(); sel.selectAllChildren(t);
    const got = sel.toString(); sel.removeAllRanges(); return { got, userSelect: getComputedStyle(t).userSelect, text: t.textContent }; })()`);
  const words = (t) => t.replace(/\s+/g, " ").trim();
  check("a toast's words are selectable content", picked.userSelect === "text" && words(picked.got) === words(picked.text) && picked.got.length > 0, picked);
  // Off it: the lines run on, and the toasts leave on their own.
  await pointerTo(c, 700, 300);
  const left = Date.now();
  await sleep(600);
  const lineC = await evalIn(c, `[...document.querySelectorAll('.toast-progress')].map((p) => __live.scaleX(p))`);
  check("off the stack the lines run on from where they stopped", lineC.every((v, k) => v > lineB[k]), { lineB, lineC });
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 0, 15_000, "the toasts gone").catch(() => {});
  check("…and the toasts leave on their own, the error last", (await evalIn(c, `__live.toasts().length`)) === 0, { secondsAfterPointerLeft: (Date.now() - left) / 1000 });

  // The v1.6 banner's own words (02-error-banner-top.png), through the same `run` every failure takes —
  // STAGED: the action that produced them cannot be reached any more, which is the point of item 1.
  await evalIn(c, `(() => { const st = __live.st(); st.run(async () => { throw new Error(${JSON.stringify(folder + " is not a git repository, so it has no worktrees")}); }); return true; })()`);
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 1, 8000, "the v1.6 words as a toast");
  await sleep(700);
  await shot(c, m, "2-v16-banner-words-as-a-toast-dark");
  await evalIn(c, `(() => { for (const t of __live.st().toasts) __live.st().dismissToast(t.id); return true; })()`);

  // Light.
  await paletteRow(c, "Theme: Light");
  await sleep(500);
  await evalIn(c, THREE(sess.id));
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 3, 8000, "three toasts, light");
  await sleep(700);
  await shot(c, m, "2-toasts-stack-light", { x: WINDOW.width - 420, y: WINDOW.height - 330, width: 420, height: 330 });
  const frontL = (await evalIn(c, `__live.toasts()`))[0].rect;
  await pointerTo(c, frontL.x + frontL.width / 2, frontL.y + frontL.height / 2);
  await sleep(600);
  await shot(c, m, "2-toasts-fanned-light", { x: WINDOW.width - 420, y: WINDOW.height - 400, width: 420, height: 400 });
  await shot(c, m, "2-toasts-window-light");
  await pointerTo(c, 700, 300);
  await evalIn(c, `(() => { for (const t of __live.st().toasts) __live.st().dismissToast(t.id); return true; })()`);
  await paletteRow(c, "Theme: Dark");
  await sleep(500);

  // Reduced motion: no line, no travel — and it still leaves.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evalIn(c, `(() => { __live.st().toast({ tone: "success", text: "Saved.", life: 1500 }); return true; })()`);
  await sleep(200);
  const still = await evalIn(c, `(() => { const p = document.querySelector('.toast-progress'); const t = document.querySelector('.toast'); return { line: getComputedStyle(p).animationName, rise: getComputedStyle(t).animationName }; })()`);
  await sleep(1700);
  check("under reduced motion there is no moving line and no rise, and the toast still leaves", still.line === "none" && still.rise === "none" && (await evalIn(c, `__live.toasts().length`)) === 0, still);
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  // ── 4a. Tooltips with no browser on screen ──────────────────────────────────────────────────────
  const search = await evalIn(c, `__live.rect(document.querySelector('.sb-header button[aria-label="Search"]'))`);
  await pointerTo(c, search.x + search.width / 2, search.y + search.height / 2);
  const first = await timeTipOpen(c);
  const heldTitle = await evalIn(c, `document.querySelector('.sb-header button[aria-label="Search"]').getAttribute('title')`);
  check("a real pointer brings the app's tooltip in a fifth of a second", first.ms !== null && first.ms >= 150 && first.ms <= 400, { ms: first.ms });
  check("…with the shortcut as a key, and the system's title held off meanwhile", first.tip?.label === "Search" && first.tip?.key === "⌘K" && heldTitle === "", { tip: first.tip, heldTitle });
  await sleep(250);
  await shot(c, m, "4-tooltip-shortcut-dark", { x: Math.max(0, search.x - 120), y: Math.max(0, search.y - 10), width: 260, height: 90 });
  const newSession = await evalIn(c, `__live.rect(document.querySelector('.sb-header button[aria-label="New session"]'))`);
  await pointerTo(c, newSession.x + newSession.width / 2, newSession.y + newSession.height / 2);
  const next = await timeTipOpen(c, 600);
  check("the next button's arrives at once — no wait inside the grace period", next.ms !== null && next.ms < 80 && next.tip.instant, { ms: next.ms, tip: next.tip });
  await pointerTo(c, 700, 300);
  await sleep(300);
  check("…and the title is given back when the pointer leaves", (await evalIn(c, `document.querySelector('.sb-header button[aria-label="Search"]').getAttribute('title')`)) === "Search (⌘K)");
  // The message action the reference screenshot shows (04): Ask the last message again.
  const retry = await evalIn(c, `__live.rect(document.querySelector('button.msg-action[aria-label="Retry"]'))`);
  if (retry) {
    await sleep(700);
    await pointerTo(c, retry.x + retry.width / 2, retry.y + retry.height / 2);
    const r = await timeTipOpen(c);
    note("message action tooltip", r);
    await sleep(250);
    await shot(c, m, "4-tooltip-message-action-dark", { x: Math.max(0, retry.x - 140), y: Math.max(0, retry.y - 50), width: 340, height: 120 });
    await paletteRow(c, "Theme: Light");
    await sleep(600);
    await pointerTo(c, 700, 300); await sleep(700);
    await pointerTo(c, retry.x + retry.width / 2, retry.y + retry.height / 2);
    await timeTipOpen(c); await sleep(250);
    await shot(c, m, "4-tooltip-message-action-light", { x: Math.max(0, retry.x - 140), y: Math.max(0, retry.y - 50), width: 340, height: 120 });
    await pointerTo(c, 700, 300);
    await paletteRow(c, "Theme: Dark");
    await sleep(500);
  }
  // A disabled button: whether the page hears the pointer over one decides whose tooltip it gets.
  const send = await evalIn(c, `(() => { const b = document.querySelector('.composer button[disabled][title]'); return b ? { rect: __live.rect(b), title: b.getAttribute('title') } : null; })()`);
  if (send) {
    await pointerTo(c, 700, 300); await sleep(700);
    await pointerTo(c, send.rect.x + send.rect.width / 2, send.rect.y + send.rect.height / 2);
    const d = await timeTipOpen(c, 800);
    note("a disabled button's tooltip", { title: send.title, custom: d.ms !== null, label: d.tip?.label });
    if (d.ms !== null) { await sleep(200); await shot(c, m, "4-tooltip-disabled-button-dark", { x: send.rect.x - 220, y: send.rect.y - 70, width: 300, height: 120 }); }
    await pointerTo(c, 700, 300);
  }
  // A press takes it away and keeps it away.
  await sleep(700);
  await pointerTo(c, search.x + search.width / 2, search.y + search.height / 2);
  await timeTipOpen(c);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: search.x + search.width / 2, y: search.y + search.height / 2, button: "left", buttons: 1, clickCount: 1 });
  await sleep(100);
  const pressedTip = await evalIn(c, `__live.tip()`);
  // Released off the button, so the press clicks nothing.
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 700, y: 300, button: "left", buttons: 0, clickCount: 1 });
  check("a press takes the tooltip away", !pressedTip.open, pressedTip);
  await pointerTo(c, 700, 320);
  // Keyboard focus shows it too.
  await sleep(700);
  let focused = null;
  for (let k = 0; k < 40 && !focused; k++) {
    await press(c, { key: "Tab", code: "Tab", keyCode: 9 });
    await sleep(60);
    focused = await evalIn(c, `(() => { const a = document.activeElement; const t = a?.getAttribute('title'); return a && a.matches(':focus-visible') && (t === '' || t?.trim()) && a.tagName === 'BUTTON' ? a.getAttribute('aria-label') ?? a.textContent.trim() : null; })()`);
  }
  const byKey = await timeTipOpen(c, 800);
  check("keyboard focus shows the tooltip too", !!focused && byKey.ms !== null, { focused, tip: byKey.tip });
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);

  // ── 3. Toasts beside a browser view ─────────────────────────────────────────────────────────────
  // (a) A browser in the session's side pane: the right half of the window.
  await evalIn(c, `(() => { const p = document.querySelector('.panehost .panel'); p?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true });
  await until(() => evalIn(c, `document.activeElement?.getAttribute('aria-label') === 'Address'`), 10_000, "the address field");
  await evalIn(c, `(() => { const input = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(SITE + "/")});
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  const side = await until(async () => (await views(m)).find((v) => v.url.startsWith(SITE)), 20_000, "the side pane's view");
  await sleep(800);
  await evalIn(c, `(() => { __live.st().run(() => __live.st().setSessionEnvironment(${JSON.stringify(sess.id)}, ${JSON.stringify(NO_SUCH_ENV)})); return true; })()`);
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 1, 8000, "a toast beside the side pane");
  await sleep(700);
  const besideRect = (await evalIn(c, `__live.stack()`)).rect;
  const besideViews = await views(m);
  note("beside a side-pane browser", { stack: besideRect, views: besideViews });
  check("a toast beside a browser in the side pane stands clear of the view — main's own bounds", besideViews.length > 0 && besideViews.every((v) => !intersects(besideRect, v)), { stack: besideRect, view: side });
  await shot(c, m, "3-toast-beside-side-pane-browser-dark");
  await evalIn(c, `(() => { for (const t of __live.st().toasts) __live.st().dismissToast(t.id); return true; })()`);

  // 4b. A tooltip on the browser's own toolbar, whose buttons sit right on the page.
  const reload = await evalIn(c, `__live.rect([...document.querySelectorAll('.browser-chrome button')].find((b) => /Reload/i.test(b.getAttribute('aria-label') ?? '')))`);
  const back = await evalIn(c, `__live.rect([...document.querySelectorAll('.browser-chrome button')].find((b) => /Back/i.test(b.getAttribute('aria-label') ?? '')))`);
  if (reload) {
    await sleep(700);
    await pointerTo(c, reload.x + reload.width / 2, reload.y + reload.height / 2);
    const onToolbar = await timeTipOpen(c);
    const vs = await views(m);
    note("tooltip on the browser toolbar", { tip: onToolbar.tip, views: vs });
    check("a tooltip on a browser toolbar button flips over it, clear of the page under it",
      onToolbar.ms !== null && onToolbar.tip.side === "above" && vs.every((v) => !intersects(onToolbar.tip.rect, v)), { tip: onToolbar.tip, views: vs });
    await sleep(250);
    await shot(c, m, "4-tooltip-browser-toolbar-dark", { x: Math.max(0, reload.x - 200), y: Math.max(0, reload.y - 80), width: 460, height: 200 });
    if (back) {
      await pointerTo(c, back.x + back.width / 2, back.y + back.height / 2);
      const adj = await timeTipOpen(c, 600);
      note("the adjacent toolbar button", adj);
      await sleep(150);
      await shot(c, m, "4-tooltip-browser-toolbar-adjacent-dark", { x: Math.max(0, back.x - 200), y: Math.max(0, back.y - 80), width: 460, height: 200 });
    }
    await paletteRow(c, "Theme: Light");
    await sleep(600);
    await pointerTo(c, 700, 600); await sleep(700);
    await pointerTo(c, reload.x + reload.width / 2, reload.y + reload.height / 2);
    await timeTipOpen(c); await sleep(250);
    await shot(c, m, "4-tooltip-browser-toolbar-light", { x: Math.max(0, reload.x - 200), y: Math.max(0, reload.y - 80), width: 460, height: 200 });
    await pointerTo(c, 700, 600);
    await paletteRow(c, "Theme: Dark");
    await sleep(500);
  } else note("no reload button found on the browser toolbar", null);

  // (b) A browser filling the panes, sidebar open: the corner left is the sidebar's column.
  await evalIn(c, `(async () => { const st = __live.st(); const leaf = (function find(n) { if (!n) return null; if (n.type === 'leaf') return n.tabs ? n : null; for (const ch of n.children) { const f = find(ch); if (f) return f; } return null; })(st.layout); if (leaf) await st.focusPaneFull(leaf.id); return !!leaf; })()`);
  await sleep(1200);
  let full = await views(m);
  note("the browser filling the panes", full);
  await evalIn(c, `(() => { __live.st().run(() => __live.st().setSessionEnvironment(${JSON.stringify(sess.id)}, ${JSON.stringify(NO_SUCH_ENV)})); return true; })()`);
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 1, 8000, "a toast over a full browser");
  await sleep(700);
  const sidebarRect = (await evalIn(c, `__live.stack()`)).rect;
  full = await views(m);
  check("with a browser filling the panes the toast stands in the sidebar's column, clear of the view",
    full.length > 0 && full.every((v) => !intersects(sidebarRect, v)) && sidebarRect.x < 400, { stack: sidebarRect, views: full });
  await shot(c, m, "3-toast-browser-filling-panes-dark");
  await evalIn(c, `(() => { for (const t of __live.st().toasts) __live.st().dismissToast(t.id); return true; })()`);

  // (c) …and with the sidebar folded away: nowhere along the foot is clear, so the view gives up the corner.
  await evalIn(c, `(async () => { await __live.st().toggleSidebar(); return true; })()`);
  await sleep(1200);
  const before = await views(m);
  await evalIn(c, `(() => { __live.st().toast({ tone: "error", text: "The page could not be saved: the disk is full.", life: 4000 }); return true; })()`);
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 1, 8000, "a toast over a full window");
  await sleep(900);
  const cornerRect = (await evalIn(c, `__live.stack()`)).rect;
  const during = await views(m);
  const reserve = await evalIn(c, `__live.st().toastReserve`);
  note("the view, before and while the toast is up", { before, during, stack: cornerRect, reserve });
  check("with the sidebar folded away the view gives up the corner the toast stands in", !!reserve && during.length > 0 && during.every((v) => !intersects(cornerRect, v))
    && during[0].height < before[0].height && Math.abs(cornerRect.x + cornerRect.width - (WINDOW.width - 16)) < 1, { before: before[0], during: during[0], stack: cornerRect });
  await shot(c, m, "3-toast-over-yielded-browser-dark");
  // A tooltip over the full browser's toolbar, for the record.
  const reload2 = await evalIn(c, `__live.rect([...document.querySelectorAll('.browser-chrome button')].find((b) => /Reload/i.test(b.getAttribute('aria-label') ?? '')))`);
  if (reload2) {
    await pointerTo(c, reload2.x + reload2.width / 2, reload2.y + reload2.height / 2);
    const t2 = await timeTipOpen(c);
    const vs2 = await views(m);
    check("…and a tooltip there still stands clear of the page", t2.ms !== null && vs2.every((v) => !intersects(t2.tip.rect, v)), { tip: t2.tip });
    await sleep(250);
    await shot(c, m, "4-tooltip-full-browser-toolbar-dark", { x: Math.max(0, reload2.x - 200), y: 0, width: 460, height: 180 });
    await pointerTo(c, 700, 500);
  }
  await until(async () => (await evalIn(c, `__live.toasts().length`)) === 0, 12_000, "the toast gone").catch(() => {});
  await sleep(600);
  const after = await views(m);
  check("…and takes it back when the toast has gone", after.length > 0 && after[0].height === before[0].height, { after: after[0], before: before[0] });
}

main()
  .catch((e) => { console.error("FAIL harness", e); process.exitCode = 1; })
  .finally(async () => {
    await shutDown();
    site?.close();
  });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void shutDown().finally(() => process.exit(130)); });
