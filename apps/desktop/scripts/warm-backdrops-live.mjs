#!/usr/bin/env node
/**
 * What a pane's warm sessions (components/warm-panes.ts) cost behind a moving backdrop: frames drawn,
 * WebGL contexts held and the renderer's memory.
 *
 *   pnpm build && node apps/desktop/scripts/warm-backdrops-live.mjs
 *
 * Boots the BUILT app on a scratch home with the fake agent and the renderer over http. Every session
 * is an empty one on "haze", a moving WebGL look. Three panes side by side each show four sessions in
 * turn, so each keeps three hidden, and the quick chat panel is opened.
 *
 *   frames    every WebGL draw is counted per canvas for WARM_WINDOW_MS (10 s): the shown backdrops
 *             draw, the hidden ones draw nothing; a hidden session brought back draws again.
 *   contexts  the WebGL contexts alive in the window and in the panel, every context lost, and any
 *             "Too many active WebGL contexts" in either console. Then two more panes of four.
 *   memory    the window's renderer (app.getAppMetrics, and `footprint`), with this check's switch
 *             `realm.warmSessions` at 1 (nothing kept) and at the default.
 *
 * `WARM_OUT` writes the numbers as JSON. Nothing is billed: no session is sent a prompt.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, desktopRoot, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const WINDOW_MS = Number(process.env.WARM_WINDOW_MS ?? 10_000);
const OUT = process.env.WARM_OUT ?? null;
const LOOK = "haze";
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];

function serveRenderer() {
  const root = path.join(desktopRoot, "out/renderer");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".wasm": "application/wasm", ".json": "application/json", ".mp4": "video/mp4" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(root, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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

/** Installed before the page's own scripts: every WebGL context the page makes, each one's draws,
 *  and each loss. */
const COUNT_GL = `(() => {
  const gl = window.__gl = { contexts: [], made: 0 };
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    const ctx = get.call(this, kind, ...rest);
    if (ctx && /webgl/.test(kind) && !gl.contexts.some((c) => c.ctx === ctx)) {
      const c = { ctx, canvas: this, draws: 0, lost: false, lostWhileShown: false };
      gl.contexts.push(c);
      gl.made++;
      this.addEventListener("webglcontextlost", () => { c.lost = true; c.lostWhileShown = !this.closest("[hidden]") && this.isConnected && !c.released; });
    }
    return ctx;
  };
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    for (const name of ["drawArrays", "drawElements"]) {
      const draw = proto[name];
      proto[name] = function (...args) { const c = gl.contexts.find((x) => x.ctx === this); if (c) c.draws++; return draw.apply(this, args); };
    }
    const ext = proto.getExtension;
    proto.getExtension = function (name) {
      const e = ext.call(this, name);
      if (e && name === "WEBGL_lose_context" && !e.__counted) {
        const lose = e.loseContext, ctx = this;
        e.__counted = true;
        e.loseContext = function () { const c = gl.contexts.find((x) => x.ctx === ctx); if (c) c.released = true; return lose.call(this); };
      }
      return e;
    };
  }
})()`;

/** The page's store, found from the pane host up. */
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
  leaves() { const out = []; const f = (n) => { if (!n) return; if (n.type === 'leaf') out.push(n); else n.children.forEach(f); }; f(__live.st().layout); return out; },
  leafOf(itemId) { return __live.leaves().find((l) => l.itemId === itemId)?.id ?? null; },
  /** Each WebGL context still alive, by the session it draws for and whether its slot is shown. */
  report() {
    return __gl.contexts.map((c) => {
      const slot = c.canvas.closest('.pane-slot');
      return { draws: c.draws, lost: c.lost, released: !!c.released, lostWhileShown: c.lostWhileShown, connected: c.canvas.isConnected,
        shown: !!slot && !slot.hidden && c.canvas.isConnected, hiddenSlot: !!slot && slot.hidden, look: c.canvas.dataset.look ?? null };
    });
  },
};
true`;

/** Keeps the window counting as in front and awake, so a moving look moves: quiet mode never puts
 *  the window in front, and the Mac may be on Low Power Mode. */
const AWAKE = `(() => { const r = document.documentElement; const strip = () => { for (const a of ['data-quiet', 'data-low-power-mode', 'data-window-covered', 'data-display-asleep', 'data-screen-locked', 'data-window-inactive']) if (r.hasAttribute(a)) r.removeAttribute(a); };
  strip(); new MutationObserver(strip).observe(r, { attributes: true }); return true; })()`;

async function launch(warm, renderer) {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "realm-warm-backdrops-user-"));
  const app = await launchLiveApp({ name: "warm-backdrops", rendererUrl: renderer, inspect: true, args: UNTHROTTLED, timeoutMs: 120_000, env: { HOME: user, REALM_LAYA_VENV: path.join(user, "laya-venv"), REALM_LAYA_HF_HOME: path.join(user, "laya-hf") } });
  const console_ = [];
  const { page } = app;
  page.on("Runtime.consoleAPICalled", (e) => console_.push({ where: "window", text: e.args.map((a) => a.value ?? a.description ?? "").join(" ") }));
  page.on("Log.entryAdded", (e) => console_.push({ where: "window", text: e.entry.text }));
  await page.send("Log.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: COUNT_GL });
  if (warm !== null) await page.eval(`localStorage.setItem("realm.warmSessions", ${JSON.stringify(String(warm))}); true`);
  else await page.eval(`localStorage.removeItem("realm.warmSessions"); true`);
  await page.send("Page.reload");
  await sleep(1500);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await app.main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows().find((x) => x.isResizable()); w.setContentSize(2200, 1100); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])') || !!document.querySelector('.composer')`), 60_000, "onboarding or a composer");
  if (await page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`)) {
    await page.eval(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
      input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  }
  await until(() => page.eval(`!!document.querySelector('.composer')`), 60_000, "a composer");
  await page.eval(HELPERS);
  await page.eval(AWAKE);
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  return { app, api, user, console: console_ };
}

async function stop({ app, api, user }) {
  api.close();
  const laya = [path.join(user, "Library/Application Support/Laya"), path.join(app.home, "laya")].filter((p) => fs.existsSync(p));
  await app.stop();
  fs.rmSync(user, { recursive: true, force: true });
  return laya;
}

/** `panes` panes side by side, each shown four fresh sessions in turn, the first last again. */
async function fill(run, panes, from = 0) {
  const { app, api } = run;
  const page = app.page;
  const space = (await api.call("spaces.list", {}))[0];
  await api.call("settings.set", { key: "ui.background", value: LOOK });
  await api.call("settings.set", { key: "ui.backgroundMotion", value: true });
  const made = [];
  for (let p = 0; p < panes; p++) {
    const four = [];
    for (let i = 0; i < 4; i++) four.push(await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: `Pane ${from + p + 1} session ${i + 1}` }));
    made.push(four);
  }
  const S = (expr) => page.eval(`(async () => { const s = __live.st(); ${expr}; return true; })()`);
  await S(`await s.refreshItems(${JSON.stringify(space.id)}); await s.refreshSessions(${JSON.stringify(space.id)})`);
  await sleep(500);
  const leaves = [];
  for (let p = 0; p < panes; p++) {
    const first = made[p][0].itemId;
    if (from === 0 && p === 0) await S(`await s.openItem(${JSON.stringify(first)})`);
    else {
      await S(`s.focusLeaf(${JSON.stringify(leaves.at(-1) ?? (await page.eval(`__live.leaves().at(-1).id`)))}); await s.openItemBeside(${JSON.stringify(first)})`);
    }
    await sleep(500);
    const leaf = await page.eval(`__live.leafOf(${JSON.stringify(first)})`);
    if (!leaf) throw new Error(`pane ${from + p + 1} did not open (refused split?)`);
    leaves.push(leaf);
  }
  for (let p = 0; p < panes; p++) {
    for (const s of [...made[p].slice(1), made[p][0]]) {
      await S(`await s.openItem(${JSON.stringify(s.itemId)}, ${JSON.stringify(leaves[p])})`);
      await sleep(400);
    }
  }
  await sleep(1500);
  return { made, leaves };
}

const summarize = (rows) => ({
  alive: rows.filter((r) => !r.lost && r.connected).length,
  shownAlive: rows.filter((r) => !r.lost && r.shown).length,
  hiddenAlive: rows.filter((r) => !r.lost && r.hiddenSlot).length,
  released: rows.filter((r) => r.released).length,
  lostNotReleased: rows.filter((r) => r.lost && !r.released).length,
  lostWhileShown: rows.filter((r) => r.lostWhileShown).length,
});

async function panelContexts(run) {
  const { app } = run;
  for (const t of (await app.targets()).filter((x) => x.type === "page")) {
    const c = await cdp(t.webSocketDebuggerUrl);
    const surface = await c.eval(`window.realm?.surface ?? null`).catch(() => null);
    if (surface === "quick-chat") {
      const n = await c.eval(`document.querySelectorAll("canvas").length`);
      const backdrops = await c.eval(`document.querySelectorAll("canvas.hero-backdrop").length`);
      c.close();
      return { canvases: n, backdrops };
    }
    c.close();
  }
  return null;
}

async function openPanel(run) {
  const main = (body) => run.app.main.eval(`(() => { const { BrowserWindow, globalShortcut } = require("electron"); ${body} })()`);
  await main(`const register = globalShortcut.register; globalShortcut.register = (accelerator, cb) => { globalThis.__quickChatChord = { accelerator, press: cb }; return register(accelerator, cb); }; return true;`);
  await run.app.page.eval(`window.realm.quickChatPanel.setShortcut("mod+ctrl+alt+shift+f19")`).catch(() => null);
  const pressed = await main(`if (!globalThis.__quickChatChord) return false; globalThis.__quickChatChord.press(); return true;`);
  await sleep(2500);
  const state = await main(`const p = BrowserWindow.getAllWindows().find((w) => !w.isResizable()); const w = BrowserWindow.getAllWindows().find((x) => x.isResizable());
    return p ? { visible: p.isVisible(), pid: p.webContents.getOSProcessId(), windowPid: w.webContents.getOSProcessId() } : null;`);
  return { pressed, ...state };
}

async function memory(run) {
  const { app } = run;
  await app.page.send("HeapProfiler.collectGarbage").catch(() => {});
  await sleep(3000);
  const m = await app.main.eval(`(() => { const { app, BrowserWindow } = require("electron"); const w = BrowserWindow.getAllWindows().find((x) => x.isResizable()); const pid = w.webContents.getOSProcessId();
    const row = app.getAppMetrics().find((x) => x.pid === pid); return { pid, workingSetMB: row.memory.workingSetSize / 1024, privateMB: (row.memory.privateBytes ?? 0) / 1024, peakMB: row.memory.peakWorkingSetSize / 1024 }; })()`);
  const heap = await app.page.send("Runtime.getHeapUsage");
  let footprintMB = null;
  try {
    const out = execFileSync("footprint", ["-p", String(m.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const hit = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i.exec(out) ?? /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/i.exec(out);
    if (hit) footprintMB = Number(hit[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[hit[2].toUpperCase()];
  } catch { /* no footprint tool */ }
  const dom = await app.page.eval(`({ sessionPanes: document.querySelectorAll('.session-pane').length, nodes: document.getElementsByTagName('*').length })`);
  return { ...m, footprintMB, jsHeapMB: heap.usedSize / 1048576, ...dom };
}

const round = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)));
const results = { at: new Date().toISOString(), load: os.loadavg()[0] };
const fails = [];
const check = (ok, what, seen) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${seen === undefined ? "" : ` ${JSON.stringify(seen)}`}`); if (!ok) fails.push(what); };
const leftLaya = [];

const server = await serveRenderer();
const renderer = `http://127.0.0.1:${server.address().port}/`;
try {
  /* ── The default cap: frames, contexts, memory ─────────────────────────────────────────── */
  const run = await launch(null, renderer);
  try {
    const { made, leaves } = await fill(run, 3);
    const page = run.app.page;
    check((await page.eval(`document.querySelectorAll('.session-pane').length`)) === 12, "three panes each keep four sessions mounted", await page.eval(`document.querySelectorAll('.session-pane').length`));
    results.panel = await openPanel(run);
    console.log("panel", results.panel);
    await sleep(1000);

    // Frames: counters zeroed, then WINDOW_MS of the window as it is.
    await page.eval(`__gl.contexts.forEach((c) => { c.draws = 0; }); true`);
    const t0 = Date.now();
    await sleep(WINDOW_MS);
    const rows = await page.eval(`__live.report()`);
    const seconds = (Date.now() - t0) / 1000;
    const shown = rows.filter((r) => r.shown && !r.lost);
    const hiddenDraws = rows.filter((r) => !r.shown).reduce((s, r) => s + r.draws, 0);
    results.frames = { seconds, shown: shown.map((r) => r.draws), hiddenSlotsMounted: await page.eval(`document.querySelectorAll(".pane-slot[hidden] .session-pane").length`), hiddenContexts: rows.filter((r) => r.hiddenSlot && !r.lost).length, hiddenDraws };
    check(shown.length === 3 && shown.every((r) => r.draws > seconds * 10), "each shown backdrop keeps drawing", shown.map((r) => r.draws));
    check(hiddenDraws === 0 && rows.filter((r) => r.hiddenSlot && !r.lost).length === 0, "the nine hidden backdrops draw nothing and hold no context", { hiddenDraws, hiddenAlive: rows.filter((r) => r.hiddenSlot && !r.lost).length });

    // Back to a hidden session in the first pane: its backdrop is built again and draws.
    const back = made[0][1].itemId;
    const backAt = await page.eval(`(async () => { const s = __live.st(); const t = performance.now(); let first = null;
      const before = __gl.made; await s.openItem(${JSON.stringify(back)}, ${JSON.stringify(leaves[0])});
      await new Promise((r) => requestAnimationFrame(() => r()));
      first = __gl.contexts.slice(before).find((c) => c.canvas.isConnected && !c.canvas.closest('[hidden]'));
      return { drawsInFirstFrame: first?.draws ?? null, ms: performance.now() - t }; })()`);
    await page.eval(`__gl.contexts.forEach((c) => { c.draws = 0; }); true`);
    await sleep(2000);
    const after = await page.eval(`__live.report()`);
    const restarted = after.filter((r) => r.shown && !r.lost);
    results.switchBack = { ...backAt, drawsIn2s: restarted.map((r) => r.draws), hiddenDrawsIn2s: after.filter((r) => !r.shown).reduce((s, r) => s + r.draws, 0) };
    check(backAt.drawsInFirstFrame > 0, "the restarted backdrop has drawn by the first frame after the switch", backAt);
    check(restarted.length === 3 && restarted.every((r) => r.draws > 20), "after switching back, all three shown backdrops draw", restarted.map((r) => r.draws));
    check(results.switchBack.hiddenDrawsIn2s === 0, "the session switched away from stops drawing", results.switchBack.hiddenDrawsIn2s);

    // Contexts.
    results.contexts3 = { window: summarize(after), made: await page.eval(`__gl.made`), panel: await panelContexts(run) };
    results.memory4 = await memory(run);

    // Two more panes of four: twenty sessions mounted.
    await fill(run, 2, 3).catch((err) => { results.morePanes = String(err.message); });
    await sleep(2000);
    const five = await page.eval(`__live.report()`);
    results.contexts5 = { panes: await page.eval(`__live.leaves().length`), sessionPanes: await page.eval(`document.querySelectorAll('.session-pane').length`), window: summarize(five) };
    const tooMany = run.console.filter((c) => /too many active webgl contexts/i.test(c.text));
    results.console = { tooMany: tooMany.length, lost: run.console.filter((c) => /context lost|webglcontextlost/i.test(c.text)).length, lines: run.console.length };
    check(tooMany.length === 0, "the console never says too many WebGL contexts", tooMany.slice(0, 2));
    check(results.contexts3.window.lostWhileShown === 0 && results.contexts5.window.lostWhileShown === 0 && results.contexts5.window.lostNotReleased === 0, "no shown backdrop's context is lost", results.contexts5.window);
  } finally {
    leftLaya.push(...await stop(run));
  }

  /* ── Nothing kept: the same panes with the cap at one ─────────────────────────────────── */
  const one = await launch(1, renderer);
  try {
    await fill(one, 3);
    check((await one.app.page.eval(`document.querySelectorAll('.session-pane').length`)) === 3, "with realm.warmSessions=1 each pane mounts only its own session");
    results.memory1 = await memory(one);
  } finally {
    leftLaya.push(...await stop(one));
  }
} finally {
  server.close();
}
results.load1End = os.loadavg()[0];
console.log(JSON.stringify(round(results), null, 2));
if (leftLaya.length) console.log("laya dirs seen (removed with their homes):", leftLaya);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(round(results), null, 2));
process.exit(fails.length ? 1 : 0);
