/**
 * Live check for the sheet that asks before Laya records (run with: pnpm build && node apps/desktop/scripts/laya-record-sheet-live.mjs)
 *
 * Under a device, "Record my use of this app…" opens a sheet that says what a recording keeps, and only
 * the sheet's Start records. What only the built app can say:
 *   1. The control is under a real device pane's picture, in words, and the pane bar has no record
 *      control left.
 *   2. Clicking it opens the sheet and the SERVER is not recording (laya.status, over RPC); Cancel and
 *      Escape close it with nothing started.
 *   3. Start reaches the server, and its refusal is shown in the sheet in its own words rather than in
 *      the window's error bar.
 *   4. While a recording runs, the row under the device is the recording, and the rail carries its
 *      Stop — on a page over the workspace too — and that Stop ends it on the server.
 *   5. Settings ▸ App's icon picker draws the icons this build ships (the calmer set).
 *   Each is captured in dark and light under LIVE_SHOT_DIR.
 *
 * The DEVICE is faked, so nobody's screen is read: no simulator boots and serve-sim never runs. The
 * pane is handed a running state through the renderer's own store (reached from React's root), with an
 * SVG for its picture and a local socket for its input, so everything it draws is the real pane. Step
 * 3's refusal is therefore the server's "start the simulator's stream first", and step 4's recording
 * is the renderer's copy of a status, because a real one needs a real app in front. The recorder
 * itself is laya-record-live.mjs's, on a real simulator.
 *
 * Ports: LIVE_CDP_PORT / LIVE_SERVER_PORT. Touches a scratch home (LIVE_SCRATCH, else the temp dir);
 * kills only its own ports.
 */
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9243), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8803);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-laya-record-sheet");
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-laya-record-sheet-live-"));
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1440, height: 900 };
const { WebSocketServer } = createRequire(path.join(repoRoot, "apps/server/package.json"))("ws");
let electron = null, inputServer = null, api = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The window, or one element of it with a margin, at the device's scale. */
async function shoot(c, name, selector, pad = 16) {
  const box = selector ? await evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${2 * pad}, height: r.height + ${2 * pad} }; })()`) : null;
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(box ? { clip: { ...box, scale: 1 } } : {}) });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
}

/** A phone's screen for the picture: any app will do, since nothing is read off it. */
const SCREEN = `<svg xmlns="http://www.w3.org/2000/svg" width="1206" height="2622" viewBox="0 0 402 874">
<rect width="402" height="874" fill="#f2f2f7"/><text x="20" y="112" font-family="-apple-system, Helvetica" font-weight="700" font-size="34">Recipes</text>
${["Lemon pasta", "Green curry", "Miso soup", "Shakshuka", "Ube cake", "Cold noodles"].map((name, i) => `<rect x="16" y="${140 + i * 74}" width="370" height="64" rx="12" fill="#fff"/>
<rect x="28" y="${152 + i * 74}" width="40" height="40" rx="9" fill="${["#ff9f0a", "#30d158", "#0a84ff", "#ff375f", "#bf5af2", "#64d2ff"][i]}"/>
<text x="82" y="${178 + i * 74}" font-family="-apple-system, Helvetica" font-size="17">${name}</text>`).join("")}</svg>`;

const store = (expr) => `window.__liveStore.getState().${expr}`;
const sheetOpen = (c) => evalIn(c, `!!document.querySelector('.sheet[aria-label="Record your use of this app"]')`);
const clickText = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`;
const setTheme = async (c, mode) => { await evalIn(c, `${store(`setThemePref(${JSON.stringify(mode)})`)}, true`); await sleep(500); };

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // The device's input socket: accepts and drops every frame, which is all a pane needs to call itself live.
  inputServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => inputServer.once("listening", r));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app, Menu } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    // A window opened behind someone's is not laid out without these (live-window-occluded memory).
    'for (const s of ["disable-backgrounding-occluded-windows", "disable-renderer-backgrounding", "disable-background-timer-throttling"]) app.commandLine.appendSwitch(s);',
    "Menu.prototype.popup = function (opts = {}) { setTimeout(() => opts.callback?.(), 10); };",
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stdout.on("data", () => {}); electron.stderr.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  // An unkeyed window greys its accent; this one is the person's window for the length of the check.
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
    new MutationObserver(() => r.hasAttribute('data-window-inactive') && r.removeAttribute('data-window-inactive')).observe(r, { attributes: true }); return true; })()`);
  // The renderer's store: the value of the provider at React's root.
  const found = await evalIn(c, `(() => { const root = document.getElementById('root'); const key = Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    const stack = [root[key]]; while (stack.length) { const f = stack.pop(); if (!f) continue; const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && typeof v.getState().applyLaya === 'function') { window.__liveStore = v; return true; }
      if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); } return false; })()`);
  if (!found) throw new Error("no store under React's root");

  // ── 1. A device pane, live, with the control under its picture ──────────────────────────────
  // A simulator is opened from the session's side pane — the session's bar carries no tools.
  await openSideTool(c, null, "Simulator");
  await until(() => evalIn(c, `!!document.querySelector('.sim-pane')`), 15000, "simulator pane");
  const simulatorId = await until(() => evalIn(c, `${store("items")}.find((i) => i.kind === 'simulator')?.refId ?? null`), 10000, "simulator item");
  await sleep(600);
  const running = { simulatorId, status: "running", udid: null, serial: null, streamUrl: `data:image/svg+xml;base64,${Buffer.from(SCREEN).toString("base64")}`,
    wsUrl: `ws://127.0.0.1:${inputServer.address().port}/ws`, screen: { width: 1206, height: 2622, orientation: "portrait" }, error: null, detail: null, physical: false };
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify(running)})`)}, true`);
  const record = await until(() => evalIn(c, `(() => { const b = document.querySelector('.sim-pane .sim-record-start'); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()`), 10000, "Record under the device").catch(() => null);
  check("under the device, the control says what it records", record?.text === "Record my use of this app…" && !record.disabled, record);
  const barLabels = await evalIn(c, `[...document.querySelectorAll('.panel-bar button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim())`);
  check("the pane bar carries no record control any more", !barLabels.some((l) => /record/i.test(l ?? "")), barLabels);
  await sleep(400);
  await shoot(c, "pane-idle-dark", ".sim-pane", 0);

  // ── 2. The click asks; nothing records until Start ───────────────────────────────────────────
  await evalIn(c, `document.querySelector('.sim-record-start').click(), true`);
  check("clicking it opens the sheet", await until(() => sheetOpen(c), 5000, "sheet").catch(() => false));
  check("…and the server is not recording", (await api.call("laya.status", {})).recording === null);
  const facts = await evalIn(c, `[...document.querySelectorAll('.laya-record-fact-title')].map((e) => e.textContent)`);
  check("the sheet says what is kept, left out, where, what for, and how it ends", JSON.stringify(facts) === JSON.stringify(["What is kept", "What is left out", "Where it goes", "What it is for", "How it ends"]), facts);
  const where = await evalIn(c, `document.querySelector('.laya-record-fact-body code')?.textContent ?? null`);
  check("…and the folder it names is this home's own", where === path.join(home, "laya", "recordings"), where);
  await sleep(500);
  await shoot(c, "sheet-dark");
  await shoot(c, "sheet-dark-close", ".sheet");
  await setTheme(c, "light");
  await shoot(c, "sheet-light");
  await shoot(c, "sheet-light-close", ".sheet");
  await setTheme(c, "dark");

  await evalIn(c, `${clickText(".sheet button", "Cancel")}, true`);
  check("Cancel closes it", await until(async () => !(await sheetOpen(c)), 5000, "closed").catch(() => false));
  await evalIn(c, `document.querySelector('.sim-record-start').click(), true`);
  await until(() => sheetOpen(c), 5000, "sheet again");
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("Escape closes it", await until(async () => !(await sheetOpen(c)), 5000, "closed by escape").catch(() => false));
  check("…and neither started a recording", (await api.call("laya.status", {})).recording === null);

  // ── 3. Start reaches the server; its refusal stays in the sheet ─────────────────────────────
  await evalIn(c, `document.querySelector('.sim-record-start').click(), true`);
  await until(() => sheetOpen(c), 5000, "sheet for start");
  await evalIn(c, `${clickText(".sheet button", "Start recording")}, true`);
  const refused = await until(() => evalIn(c, `document.querySelector('.laya-record-refused')?.textContent ?? null`), 15000, "refusal").catch(() => null);
  check("Start asks the server, and its refusal is in the sheet in its own words", refused === "start the simulator's stream first", refused);
  const errorBar = await evalIn(c, `document.querySelector('.error-bar span')?.textContent ?? null`);
  check("…not in the window's error bar, and the sheet stays open", errorBar === null && await sheetOpen(c), errorBar);
  await shoot(c, "sheet-refused-dark", ".sheet");
  await evalIn(c, `${clickText(".sheet button", "Cancel")}, true`);
  await until(async () => !(await sheetOpen(c)), 5000, "closed after refusal");

  // ── 4. A recording under way: the row under the device, and the rail's Stop ─────────────────
  const status = await api.call("laya.status", {});
  const recording = { id: "rec-live", simulatorId, device: "iPhone 17 Pro", apps: ["Recipes"], seen: ["Recipes"], screens: 12,
    startedAt: new Date().toISOString(), endedAt: null, lastError: null };
  await evalIn(c, `${store(`applyLaya(${JSON.stringify({ ...status, recording })})`)}, true`);
  const row = await until(() => evalIn(c, `document.querySelector('.sim-pane .sim-recording')?.innerText ?? null`), 5000, "recording row").catch(() => null);
  check("the row under the device is the recording, with what it keeps and a Stop", /Recording Recipes for Laya/.test(row ?? "") && /12 screens kept/.test(row ?? "") && /Stop/.test(row ?? ""), row);
  const railStop = await evalIn(c, `document.querySelector('.rail-recording')?.getAttribute('aria-label') ?? null`);
  check("the rail carries its Stop", railStop === "Stop recording Recipes for Laya", railStop);
  await sleep(300);
  await shoot(c, "recording-dark");
  await shoot(c, "recording-row-dark", ".sim-pane .sim-recording", 24);
  await shoot(c, "rail-recording-dark", ".app-rail .rail-foot", 8);
  await setTheme(c, "light");
  await shoot(c, "recording-light");
  await shoot(c, "recording-row-light", ".sim-pane .sim-recording", 24);
  await shoot(c, "rail-recording-light", ".app-rail .rail-foot", 8);
  await setTheme(c, "dark");

  // A page over the workspace hides the device; the rail does not go anywhere.
  await evalIn(c, `${store(`openDestinationPage("settings-page")`)}, true`);
  await until(() => evalIn(c, `!!document.querySelector('.settings-page-pane, .page-overlay')`), 10000, "settings page");
  await sleep(800);
  // The page reads Laya's status from the server on its way in, so the renderer's copy is put back.
  await evalIn(c, `${store(`applyLaya(${JSON.stringify({ ...status, recording })})`)}, true`);
  await sleep(300);
  check("with Settings over the device, the rail still carries the Stop", await evalIn(c, `!!document.querySelector('.rail-recording')`));
  await shoot(c, "recording-elsewhere-dark");
  await evalIn(c, `document.querySelector('.rail-recording').click(), true`);
  const gone = await until(() => evalIn(c, `!document.querySelector('.rail-recording') && !document.querySelector('.sim-recording')`), 10000, "stopped").catch(() => false);
  check("the rail's Stop ends it on the server, and both controls go", gone && (await api.call("laya.status", {})).recording === null);

  // ── 5. Settings ▸ App: the icon picker draws the icons this build ships ───────────────────
  await evalIn(c, `(() => { const b = [...document.querySelectorAll('.page-rail button, .page-rail [role=tab], .page-rail label, .page-nav button, nav button')].find((x) => ["App", "Appearance"].includes(x.textContent.trim())); b?.click(); return !!b; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.app-icon-grid')`), 10000, "app icon grid");
  await evalIn(c, `document.querySelector('.app-icon-grid').scrollIntoView({ block: "center" }), true`);
  await sleep(600);
  const tiles = await evalIn(c, `[...document.querySelectorAll('.app-icon-grid img')].map((i) => i.naturalWidth)`);
  check("the picker draws nine 256 px icons", tiles.length === 9 && tiles.every((w) => w === 256), tiles);
  await shoot(c, "icons-dark", ".app-icon-grid", 24);
  await setTheme(c, "light");
  await shoot(c, "icons-light", ".app-icon-grid", 24);
  c.close();
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  inputServer?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.log(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
