/**
 * Live check for picking an element off a device into the prompter (run with: pnpm build && node apps/desktop/scripts/simulator-pick-live.mjs)
 *
 * The owner's report: with the device's elements showing, a click on one did not reach the prompter —
 * it tapped the device. What only the built app can say:
 *   1. With Elements on, every element of the device's tree is outlined over its picture, and the
 *      overlay says what a click will do and which session it goes to.
 *   2. A real click on one puts it into the prompter of the session the device belongs to — the side
 *      pane's owner — as a chip, with a picture of it taken from the window and attached beside it,
 *      and the overlay goes. Nothing is pressed on the device.
 *   3. Escape leaves with nothing picked, and never reaches the device.
 *   The highlight, the click and the chip in the prompter are captured in dark and light.
 *
 * The DEVICE is faked as laya-record-sheet-live.mjs fakes it: a running state handed to the renderer's
 * store, an SVG for its picture and a local socket for its input — which records every frame, so
 * "nothing was pressed" is counted rather than assumed. The device's accessibility tree is answered in
 * the renderer: the overlay asks the server for it, and this check answers that one request on the
 * socket's way out, with a tree drawn to match the picture. The picture of the pick is the window's
 * real capture (main/app-pick.ts). No prompt is sent to any agent.
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9244), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8804);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-simulator-pick");
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-simulator-pick-live-"));
const home = path.join(scratch, "home");
const { WebSocketServer } = createRequire(path.join(repoRoot, "apps/server/package.json"))("ws");
let electron = null, inputServer = null, api = null;
const pressed = [];
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

/** The window, or one element of it with a margin, at the device's scale. The root is painted for the
 *  capture, standing in for the window's material, which a capture cannot see. */
async function shoot(c, name, selector, pad = 16) {
  const box = selector ? await evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${2 * pad}, height: r.height + ${2 * pad} }; })()`) : null;
  if (selector && !box) { console.log(`  (no ${selector} to shoot for ${name})`); return; }
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  // Twice the window's own pixels: this window runs at 1×, and the evidence should be readable.
  const clip = box ?? await evalIn(c, `({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
}

const RECIPES = ["Lemon pasta", "Green curry", "Miso soup", "Shakshuka", "Ube cake", "Cold noodles"];
/** A phone's screen for the picture, in the device's points (402×874) at three pixels to the point. */
const SCREEN = `<svg xmlns="http://www.w3.org/2000/svg" width="1206" height="2622" viewBox="0 0 402 874">
<rect width="402" height="874" fill="#f2f2f7"/><text x="20" y="112" font-family="-apple-system, Helvetica" font-weight="700" font-size="34">Recipes</text>
${RECIPES.map((name, i) => `<rect x="16" y="${140 + i * 74}" width="370" height="64" rx="12" fill="#fff"/>
<rect x="28" y="${152 + i * 74}" width="40" height="40" rx="9" fill="${["#ff9f0a", "#30d158", "#0a84ff", "#ff375f", "#bf5af2", "#64d2ff"][i]}"/>
<text x="82" y="${178 + i * 74}" font-family="-apple-system, Helvetica" font-size="17">${name}</text>`).join("")}</svg>`;
/** …and its accessibility tree, drawn to match: the title, and a button per recipe — the last one
 *  disabled, which is still a thing to point at. */
const TREE = {
  units: "points", screen: { width: 402, height: 874 }, app: "Recipes",
  elements: [
    { path: "0.0", label: "Recipes", value: "", role: "StaticText", id: null, enabled: true, frame: { x: 20, y: 80, width: 150, height: 40 }, depth: 1 },
    ...RECIPES.map((label, i) => ({ path: `0.${i + 1}`, label, value: "", role: "Button", id: `recipe-${i}`, enabled: i !== 5,
      frame: { x: 16, y: 140 + i * 74, width: 370, height: 64 }, depth: 1 })),
  ],
};

const store = (expr) => `window.__liveStore.getState().${expr}`;
const setTheme = async (c, mode) => { await evalIn(c, `${store(`setThemePref(${JSON.stringify(mode)})`)}, true`); await sleep(500); };
const centreOf = (c, selector) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
async function click(c, at) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const key = async (c, k, code, vk) => {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
};
/** A PNG's size, read off its header. */
const pngSize = (file) => { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // The device's input socket. It keeps every frame it is sent: a pick must press nothing.
  inputServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  inputServer.on("connection", (sock) => sock.on("message", (data) => pressed.push(Buffer.from(data).length)));
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
  /* The window as it is, with no emulated metrics: the picture of a pick is main's capture of the REAL
     window, and a page laid out to an emulated size would be pointing it at the wrong rectangle. */
  const dpr = await evalIn(c, `window.devicePixelRatio`);
  console.log(`  window ${await evalIn(c, `window.innerWidth + "×" + window.innerHeight`)} at ${dpr}×`);
  // An unkeyed window greys its accent; this one is the person's window for the length of the check.
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
    new MutationObserver(() => r.hasAttribute('data-window-inactive') && r.removeAttribute('data-window-inactive')).observe(r, { attributes: true }); return true; })()`);
  const found = await evalIn(c, `(() => { const root = document.getElementById('root'); const key = Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    const stack = [root[key]]; while (stack.length) { const f = stack.pop(); if (!f) continue; const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && typeof v.getState().applySimulatorState === 'function') { window.__liveStore = v; return true; }
      if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); } return false; })()`);
  if (!found) throw new Error("no store under React's root");

  // ── A device beside the onboarding session, live ─────────────────────────────────────────────
  const lead = await evalIn(c, `(() => { const s = ${store("items")}.find((i) => i.kind === 'session'); return { itemId: s.id, sessionId: s.refId, title: s.title }; })()`);
  await evalIn(c, `${store(`newSimulator(null, { sessionId: ${JSON.stringify(lead.sessionId)} })`)}, true`);
  const sim = await until(() => evalIn(c, `(() => { const i = ${store("items")}.find((x) => x.kind === 'simulator'); return i ? { itemId: i.id, simulatorId: i.refId } : null; })()`), 10000, "simulator item");
  await evalIn(c, `${store(`updateItem({ id: ${JSON.stringify(sim.itemId)}, title: "iPhone 17 Pro" })`)}, true`);
  await until(() => evalIn(c, `!!document.querySelector('.sim-pane')`), 15000, "simulator pane");
  await sleep(600);
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify({ simulatorId: sim.simulatorId, status: "running", udid: null, serial: null,
    streamUrl: `data:image/svg+xml;base64,${Buffer.from(SCREEN).toString("base64")}`, wsUrl: `ws://127.0.0.1:${inputServer.address().port}/ws`,
    screen: { width: 1206, height: 2622, orientation: "portrait" }, error: null, detail: null, physical: false })})`)}, true`);
  await until(() => evalIn(c, `!!document.querySelector('.sim-toolbar')`), 10000, "device toolbar");
  // The overlay's one request, answered on its way out with the tree drawn to match the picture.
  await evalIn(c, `(() => { const send = WebSocket.prototype.send; const tree = ${JSON.stringify(TREE)};
    WebSocket.prototype.send = function (data) {
      let m = null; try { m = JSON.parse(data); } catch {}
      if (m && m.method === "simulators.ax") { const ws = this; setTimeout(() => ws.onmessage?.({ data: JSON.stringify({ id: m.id, ok: true, result: { tree } }) }), 40); return; }
      return send.call(this, data);
    }; return true; })()`);
  const leadComposer = `.panel[data-leaf-id="${await evalIn(c, `document.querySelector('.composer').closest('.panel').dataset.leafId`)}"] .composer`;

  // ── 1. Elements on: the highlight ────────────────────────────────────────────────────────────
  await click(c, await centreOf(c, '.sim-toolbar [aria-label="Show the device\'s elements"]'));
  await until(() => evalIn(c, `document.querySelectorAll('.sim-ax-box').length === ${TREE.elements.length}`), 8000, "element boxes").catch(() => null);
  const boxes = await evalIn(c, `document.querySelectorAll('.sim-ax-box').length`);
  check("with Elements on, every element of the device is outlined over its picture", boxes === TREE.elements.length, boxes);
  const hint = await evalIn(c, `document.querySelector('.sim-ax-bar')?.textContent ?? null`);
  check("…and the overlay says what a click does, and which session it goes to", hint?.includes(`Click to add to ${lead.title}`) && hint.includes("Esc"), hint);
  const whole = await evalIn(c, `(() => { const t = document.querySelector('.sim-ax-count'); return t ? t.scrollWidth <= t.clientWidth : null; })()`);
  check("…with the session's name whole, not cut to an ellipsis", whole === true, whole);
  const curry = '.sim-ax-box[aria-label="Green curry"]';
  const at = await centreOf(c, curry);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(250);
  await shoot(c, "select-dark", ".sim-stage", 0);
  await setTheme(c, "light");
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y + 1 });
  await sleep(250);
  await shoot(c, "select-light", ".sim-stage", 0);
  await setTheme(c, "dark");

  // ── 2. The click: a chip in the owner's prompter, its picture beside it ───────────────────────
  const before = pressed.length;
  await click(c, at);
  const draft = await until(() => evalIn(c, `${store(`drafts[${JSON.stringify(lead.sessionId)}]`)} ?? null`), 8000, "a chip in the draft").catch(() => null);
  await shoot(c, "pick-window-dark");
  check("a click puts the element into the prompter of the session the device belongs to", draft === "@[iPhone · Green curry button] ", draft);
  const chip = await evalIn(c, `${store(`draftElements[${JSON.stringify(lead.sessionId)}]`)}?.[0] ?? null`);
  check("…carrying what the device says about it — role, label, frame — and which device",
    chip?.element?.role === "Button" && chip.element.label === "Green curry" && chip.element.frame?.y === 214 && chip.element.screen?.width === 402
      && chip.element.units === "points" && chip.element.simulator?.id === sim.simulatorId && chip.element.simulator.kind === "iPhone" && chip.element.simulator.app === "Recipes",
    chip?.element);
  const shot = chip?.element?.simulator?.shot ?? null;
  const pending = await evalIn(c, `(${store(`pendingAttachments[${JSON.stringify(lead.sessionId)}]`)} ?? []).map((a) => a.path)`);
  check("…with a picture of it taken from the window, attached beside it", !!shot && fs.existsSync(shot) && pending.includes(shot), { shot, pending });
  if (shot && fs.existsSync(shot)) {
    fs.copyFileSync(shot, path.join(shots, "pick-picture.png"));
    const size = pngSize(shot);
    const onScreen = await evalIn(c, `(() => { const p = document.querySelector('.sim-picture').getBoundingClientRect(); const k = p.width / ${TREE.screen.width}; return { w: 370 * k, h: 64 * k }; })()`);
    // The element and 24 DIPs of what is round it, at the display's own pixels a DIP.
    check("…the element and a margin of what is round it, at the display's scale",
      Math.abs(size.width - (onScreen.w + 48) * dpr) <= 2 * dpr && Math.abs(size.height - (onScreen.h + 48) * dpr) <= 2 * dpr, { size, onScreen, dpr });
  }
  const toast = await evalIn(c, `[...document.querySelectorAll('.toast-text')].map((t) => t.textContent)`);
  check("…said where it went", toast.includes(`Added iPhone · Green curry button to ${lead.title}.`), toast);
  check("…and the overlay went with the pick", await evalIn(c, `!document.querySelector('.sim-ax') && !${store(`simulatorElements[${JSON.stringify(sim.simulatorId)}]`)}`));
  check("…and nothing was pressed on the device", pressed.length === before, pressed.length - before);
  await shoot(c, "prompter-chip-dark", leadComposer, 16);
  await setTheme(c, "light");
  await shoot(c, "prompter-chip-light", leadComposer, 16);
  await shoot(c, "pick-window-light");
  await setTheme(c, "dark");

  // ── 3. Escape: out, with nothing picked and nothing sent to the device ───────────────────────
  await click(c, await centreOf(c, '.sim-toolbar [aria-label="Show the device\'s elements"]'));
  await until(() => evalIn(c, `document.querySelectorAll('.sim-ax-box').length > 0`), 8000, "boxes again");
  // Focus on the device itself, whose own keys would otherwise take the Escape to the phone.
  await evalIn(c, `document.querySelector('.sim-screen').focus(), true`);
  const beforeEsc = pressed.length;
  await key(c, "Escape", "Escape", 27);
  const left = await until(() => evalIn(c, `!document.querySelector('.sim-ax')`), 4000, "overlay gone").catch(() => false);
  check("Escape leaves with nothing picked", left && (await evalIn(c, `${store(`draftElements[${JSON.stringify(lead.sessionId)}]`)}.length`)) === 1);
  await sleep(200);
  check("…and the Escape never reached the device", pressed.length === beforeEsc, pressed.length - beforeEsc);
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
