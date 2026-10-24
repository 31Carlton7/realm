/**
 * Live check for the runner under a failed load's Reload
 * (run with: pnpm build && node apps/desktop/scripts/runner-game-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and, in a session's side pane:
 *
 *   1. Opens a closed localhost port: the refused page carries the runner, Reload first and the only
 *      filled button. `localhost:1` is tried too, and noted: Chromium refuses port 1 as unsafe before
 *      connecting, so that page is ERR_UNSAFE_PORT and has no runner.
 *   2. Space typed in the address bar goes to the address, not the game.
 *   3. Space in the game starts a run; jumps are pressed with CDP key events; pictures idle and
 *      mid-run, dark and light, and mid-run under Reduce motion.
 *   4. Frame time while running: rAF intervals, and main-thread script time per frame from
 *      Performance.getMetrics.
 *   5. A window blur pauses the run, and the loop stops (no frames drawn while paused).
 *   6. Offline (the view's session emulating no network): ERR_INTERNET_DISCONNECTED carries the
 *      runner. A self-signed certificate's page does not.
 *
 * Ports: LIVE_SERVER_PORT (8828), LIVE_CDP_PORT (9268), LIVE_MAIN_INSPECT_PORT (9269), LIVE_CLOSED_PORT
 * (8827, never listened on), LIVE_TLS_PORT (8829). Pictures under LIVE_SHOTS_DIR. Kills only what
 * listens on its own ports. Nothing is billed: onboarding's session goes to the fake agent first, the
 * pane's session is the ACP stub, and nothing is typed into a composer.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8828);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9268);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9269);
const CLOSED_PORT = Number(process.env.LIVE_CLOSED_PORT ?? 8827);
const TLS_PORT = Number(process.env.LIVE_TLS_PORT ?? 8829);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH_DIR ?? os.tmpdir(), "realm-runner-game-live-"));
const home = path.join(scratch, "home");
const SHOTS = process.env.LIVE_SHOTS_DIR ?? path.join(os.tmpdir(), "realm-runner-game-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const TITLE = "Runner live check";
const WINDOW = { width: 1500, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
const servers = [];
const daemonPids = [];

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

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

function startUntrusted() {
  const key = path.join(scratch, "key.pem"), cert = path.join(scratch, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => { res.writeHead(200); res.end("untrusted"); });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(TLS_PORT, "127.0.0.1", () => { servers.push(server); resolve(); }); });
}

async function launch(agent) {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
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

const holdKey = (c) => evalIn(c, `(() => {
  const root = document.documentElement;
  const clear = () => { root.removeAttribute("data-window-inactive"); root.removeAttribute("data-quiet"); };
  // The window is unfocused behind the person's own, so Realm would mark it quiet — which pauses a
  // run, as it should for a window nobody is looking at. Held off here, before anyone sees it.
  if (!root.__liveHeld) {
    const set = root.setAttribute.bind(root);
    root.setAttribute = (n, v) => { if (n !== "data-quiet" && n !== "data-window-inactive") set(n, v); };
    root.__liveHeld = true;
  }
  clear();
  new MutationObserver(clear).observe(root, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] });
  return true;
})()`);

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
  await sleep(500);
}

const key = (c, type, k = " ", code = "Space", keyCode = 32, modifiers = 0) =>
  c.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: keyCode, modifiers, ...(type === "keyDown" && k === " " ? { text: " " } : {}) });
const tap = async (c, k, code, keyCode, modifiers = 0) => { await key(c, "keyDown", k, code, keyCode, modifiers); await key(c, "keyUp", k, code, keyCode, modifiers); };

async function intoSession(c) {
  await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await sleep(100);
}

const tabCount = (c) => evalIn(c, `document.querySelectorAll('.pane-tabs [role=tab]').length`);
async function newTab(c) {
  const before = await tabCount(c);
  await intoSession(c);
  await tap(c, "B", "KeyB", 66, 4 | 8);
  await until(async () => (await tabCount(c)) === before + 1, 10_000, "a new tab");
  await sleep(300);
}

const PANE = `[...document.querySelectorAll('.browser-pane')].find((p) => p.offsetParent !== null)`;
async function go(c, address) {
  await evalIn(c, `(() => {
    const input = ${PANE}.querySelector('.browser-address input');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(address)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
}
const errorCode = (c) => evalIn(c, `${PANE}?.querySelector('.browser-error-code')?.textContent ?? null`);
const runner = (c) => evalIn(c, `(() => {
  const r = ${PANE}?.querySelector('.browser-runner');
  if (!r) return null;
  const err = ${PANE}.querySelector('.browser-error');
  return {
    buttons: [...err.querySelectorAll('button')].map((b) => ({ text: b.textContent, primary: b.classList.contains('primary') })),
    play: r.querySelector('.browser-runner-play').textContent,
    score: r.querySelector('.browser-runner-score').textContent,
    width: Math.round(r.querySelector('canvas').getBoundingClientRect().width),
    height: Math.round(r.querySelector('canvas').getBoundingClientRect().height),
    canvasPx: [r.querySelector('canvas').width, r.querySelector('canvas').height],
    focused: document.activeElement === r.querySelector('canvas'),
  };
})()`);

async function shot(c, tag) {
  const clip = await evalIn(c, `(() => { const b = ${PANE}.closest('.panel').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  fs.writeFileSync(path.join(SHOTS, `${tag}.png`), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${path.join(SHOTS, `${tag}.png`)}`);
}

const focusGame = (c) => evalIn(c, `(() => { ${PANE}.querySelector('.browser-runner canvas').focus(); return true; })()`);

/** Frames while running: rAF intervals, and main-thread script time per frame. */
async function frameTimes(c, ms) {
  const metric = async () => Object.fromEntries((await c.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const a = await metric();
  const deltas = await evalIn(c, `new Promise((resolve) => { const ds = []; let last = 0; const t0 = performance.now();
    const f = (t) => { if (last) ds.push(t - last); last = t; if (t - t0 < ${ms}) requestAnimationFrame(f); else resolve(ds); }; requestAnimationFrame(f); })`);
  const b = await metric();
  const sorted = [...deltas].sort((x, y) => x - y);
  const q = (p) => Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2));
  return {
    frames: deltas.length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: q(1), over20ms: deltas.filter((d) => d > 20).length,
    scriptMsPerFrame: Number((((b.ScriptDuration - a.ScriptDuration) * 1000) / deltas.length).toFixed(3)),
    taskMsPerFrame: Number((((b.TaskDuration - a.TaskDuration) * 1000) / deltas.length).toFixed(3)),
  };
}

/** Run for a while with a few jumps, catching one picture with the hero curled in the air. */
async function midRun(c, tag) {
  await focusGame(c);
  await tap(c);
  await until(async () => (await runner(c))?.play === "Pause", 3000, "the run started");
  await sleep(1400);
  await key(c, "keyDown");
  await sleep(170);
  await shot(c, tag);
  await key(c, "keyUp");
  await sleep(600);
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

async function main() {
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT, CLOSED_PORT, TLS_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  await startUntrusted();
  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const { c, m } = await launch(agent);
  await c.send("Performance.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── 1. localhost:1, then a closed port ──────────────────────────────────────────────────────
  await newTab(c);
  await go(c, "http://localhost:1/");
  const one = await until(() => errorCode(c), 15_000, "localhost:1's page");
  note("localhost:1 fails as", { code: one, runner: !!(await runner(c)) });
  await shot(c, "00-localhost-1");
  await go(c, `http://localhost:${CLOSED_PORT}/`);
  await until(async () => (await errorCode(c)) === "ERR_CONNECTION_REFUSED", 15_000, "the refused page");
  await sleep(600);
  const idle = await until(() => runner(c), 5000, "the runner");
  check("the refused page carries the runner", !!idle, idle);
  check("Reload is first and the only filled button", idle.buttons[0].text === "Reload" && idle.buttons.filter((b) => b.primary).length === 1, idle.buttons);
  check("the canvas fills the pane's width (to 720) at the device's pixel ratio", idle.width > 400 && idle.canvasPx[0] >= idle.width, idle);

  // ── 2. Space in the address bar is the address's ────────────────────────────────────────────
  await evalIn(c, `(() => { const i = ${PANE}.querySelector('.browser-address input'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return true; })()`);
  await tap(c);
  const typed = await evalIn(c, `({ value: ${PANE}.querySelector('.browser-address input').value, focused: document.activeElement === ${PANE}.querySelector('.browser-address input') })`);
  const stillIdle = await runner(c);
  check("Space in the address bar types a space there and leaves the game idle", typed.focused && typed.value.endsWith(" ") && stillIdle.play === "Play", { typed, play: stillIdle.play });
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await shot(c, "01-idle-dark");

  // ── 3, 4. A run, dark ───────────────────────────────────────────────────────────────────────
  await focusGame(c);
  await tap(c);
  await until(async () => (await runner(c))?.play === "Pause", 3000, "the run started");
  const timing = await frameTimes(c, 2000);
  note("frame time, running, dark", timing);
  check("frames hold the display's rate while running (p95 under 20 ms)", timing.p95Ms < 20, timing);
  await key(c, "keyDown");
  await sleep(170);
  await shot(c, "02-midrun-dark");
  await key(c, "keyUp");
  await sleep(300);
  await shot(c, "03-midrun-dark-later");

  // ── 5. Blur pauses, and the loop stops ──────────────────────────────────────────────────────
  const before = await runner(c);
  if (before.play === "Pause") {
    await evalIn(c, `(() => { window.dispatchEvent(new Event('blur')); return true; })()`);
    await sleep(100);
    const paused = await runner(c);
    const s1 = paused.score;
    await sleep(600);
    const s2 = (await runner(c)).score;
    check("a window blur pauses the run, and the score holds", paused.play === "Resume" && s1 === s2, { play: paused.play, s1, s2 });
    await shot(c, "04-paused-dark");
  } else note("the run had already ended before the blur check", before);

  // Run until it ends, for the game-over picture.
  await focusGame(c);
  if ((await runner(c)).play !== "Play again") await tap(c);
  await until(async () => (await runner(c))?.play === "Play again", 40_000, "the run ended").catch(() => null);
  const over = await runner(c);
  note("after the run", over);
  await shot(c, "05-over-dark");

  // ── 3, light ────────────────────────────────────────────────────────────────────────────────
  await paletteRow(c, "Theme: Light");
  await holdKey(c);
  await sleep(500);
  await shot(c, "06-idle-light");
  await midRun(c, "07-midrun-light");
  const timingLight = await frameTimes(c, 1500);
  note("frame time, running, light", timingLight);

  // ── 3, Reduce motion ───────────────────────────────────────────────────────────────────────
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evalIn(c, `(() => { window.dispatchEvent(new Event('blur')); return true; })()`);
  await midRun(c, "08-midrun-light-reduced-motion");
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await paletteRow(c, "Theme: Dark");
  await holdKey(c);

  // ── 6. Offline, and a certificate page ──────────────────────────────────────────────────────
  await inMain(m, `(() => { const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) if (v instanceof WebContentsView) { try { v.webContents.debugger.attach("1.3"); } catch {} void v.webContents.debugger.sendCommand("Network.enable"); void v.webContents.debugger.sendCommand("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
    return true; })()`);
  await go(c, "https://example.com/");
  await sleep(300);
  const offline = await until(async () => { const code = await errorCode(c); return code && code !== "ERR_CONNECTION_REFUSED" ? code : null; }, 15_000, "the offline page")
    .catch(async () => { note("offline page never came", { code: await errorCode(c), address: await evalIn(c, `${PANE}.querySelector('.browser-address input').value`) }); return null; });
  await sleep(500);
  check("offline: the page is ERR_INTERNET_DISCONNECTED and carries the runner", offline === "ERR_INTERNET_DISCONNECTED" && !!(await runner(c)), { offline });
  await shot(c, "09-offline-dark");
  await inMain(m, `(() => { const { BrowserWindow, WebContentsView } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) if (v instanceof WebContentsView) { try { v.webContents.debugger.detach(); } catch {} }
    return true; })()`);
  await go(c, `https://127.0.0.1:${TLS_PORT}/`);
  const cert = await until(async () => { const code = await errorCode(c); return code?.startsWith("ERR_CERT") ? code : null; }, 15_000, "the certificate page");
  check("a certificate page has no runner", !(await runner(c)), { cert });
  await shot(c, "10-certificate-dark");

  // ── A wider window: the world is drawn bigger as well as further ahead ──────────────────────
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(2400, ${WINDOW.height}); return true; })()`);
  await go(c, `http://localhost:${CLOSED_PORT}/`);
  await until(async () => (await errorCode(c)) === "ERR_CONNECTION_REFUSED", 15_000, "the refused page, wide");
  await sleep(800);
  const wide = await runner(c);
  note("wide window", { width: wide?.width, canvasPx: wide?.canvasPx });
  await shot(c, "11-idle-dark-wide");
  await midRun(c, "12-midrun-dark-wide");
  note("frame time, running, wide", await frameTimes(c, 1500));
}

async function teardown() {
  await shutDown().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(() => r()));
  for (const p of [CLOSED_PORT, TLS_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
