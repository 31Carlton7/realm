/**
 * The Dock icon picker, end to end in the built app (run with: node apps/desktop/scripts/app-icon-live.mjs).
 *
 * Picks an icon in Settings ▸ App and checks what main kept in userData — the exact bytes of the tile's
 * picture, under its id — then relaunches on the same userData and checks the picker comes back on that
 * choice. Picking the default must forget both files, which is what lets the next launch leave the
 * bundle's icon alone. What it cannot show: the Dock itself (a CDP capture is the page only); the
 * call into `app.dock.setIcon` is the unit test's.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-app-icon";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-app-icon-"));
let electron = null;
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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip ? { clip: { ...clip, scale: 2 } } : {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
  return file;
}

/** A named element's box, or null. Used for both the geometry checks and the screenshot clips. */
const boxOf = (c, sel) => evalIn(c, `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);



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

const WRAPPER = [
  'import { app, BrowserWindow, Menu } from "electron";',
  'import readline from "node:readline";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  // Nothing here should open an OS menu; if something does, it must not open over the person's screen.
  "Menu.prototype.popup = function (opts = {}) { setTimeout(() => opts.callback?.(), 10); };",
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const [cmd, arg] = line.split(' ');",
  "  if (cmd === 'key') for (const w of BrowserWindow.getAllWindows()) w.webContents.send('window:key', arg === 'true');",
  "  if (cmd === 'phase') { const [phase, momentum] = arg.split('/'); for (const w of BrowserWindow.getAllWindows()) w.webContents.send('realm:scroll-phase', { phase, momentum, dx: 0, dy: 0, ts: Date.now() / 1000 }); }",
  "});",
  "await import(process.env.LIVE_MAIN);",
].join("\n");

async function shot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", { clip: { ...(clip ?? { x: 0, y: 0, width: 1280, height: 860 }), scale: 1 } });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
}

/** Pause every running animation on `sel` and capture it at each of `times` (ms) into a strip. */
async function strip(c, name, sel, times, clip) {
  for (const t of times) {
    await evalIn(c, `(() => { for (const el of document.querySelectorAll(${JSON.stringify(sel)}))
      for (const a of el.getAnimations()) { a.pause(); a.currentTime = ${t}; } return true; })()`);
    await sleep(60);
    await shot(c, `${name}-${String(t).padStart(3, "0")}`, clip);
  }
  await evalIn(c, `(() => { for (const el of document.querySelectorAll(${JSON.stringify(sel)})) for (const a of el.getAnimations()) a.finish(); return true; })()`);
}
const boxOf2 = (c, sel, pad = 0) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${2 * pad}, height: r.height + ${2 * pad} }; })()`);
const key = async (c, k, code, vk, modifiers = 0, text) => {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};

async function launch() {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {});
  electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}

async function openAppTab(c) {
  // Settings ▸ App, the way a person gets there: ⌘K, "Open settings".
  await key(c, "k", "KeyK", 75, 4);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await evalIn(c, `(() => { const input = document.querySelector('.palette input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, "Open settings");
    input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `[...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes("Open settings"))?.click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.settings-app') || [...document.querySelectorAll('.page-rail button, .page-rail [role=tab], .page-rail label')].some((b) => b.textContent.trim() === "App")`), 10000, "settings");
  await evalIn(c, `[...document.querySelectorAll('.page-rail button, .page-rail [role=tab], .page-rail label')].find((b) => b.textContent.trim() === "App")?.click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.app-icon-grid')`), 10000, "app icon grid");
}

const checked = (c) => evalIn(c, `document.querySelector('.app-icon-grid input:checked')?.value ?? null`);
const pick = (c, id) => evalIn(c, `document.querySelector('.app-icon-grid input[value=${JSON.stringify(id)}]').click(); true`);
const userData = () => path.join(scratch, "userData");
const read = (f) => { try { return fs.readFileSync(path.join(userData(), f)); } catch { return null; } };

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  let c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await openAppTab(c);

  check("a fresh install starts on the bundle's icon", (await checked(c)) === "default", await checked(c));
  await pick(c, "ocean");
  await until(() => read("app-icon.json"), 5000, "app-icon.json");
  const meta = JSON.parse(read("app-icon.json").toString());
  const png = read("app-icon.png");
  const asset = fs.readFileSync(path.join(repoRoot, "apps/desktop/src/renderer/src/assets/app-icons/ocean.png"));
  check("main keeps the chosen id", meta.id === "ocean", meta);
  check("main keeps exactly the tile's picture", png !== null && Buffer.compare(png, asset) === 0, png?.length);
  await evalIn(c, `document.querySelector('.app-icon-grid').scrollIntoView({ block: "center" }); true`);
  await sleep(300);
  await shoot(c, "picked-ocean");
  // Hold the app open so the real Dock can be captured by hand (`screencapture`); 0 by default.
  await sleep(Number(process.env.LIVE_HOLD_MS ?? 0));

  // Relaunch on the same userData: the choice must come back.
  c.close(); reapProcesses();
  await until(async () => (await portFree(CDP_PORT)) && (await portFree(SERVER_PORT)), 15000, "ports free");
  c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer after relaunch");
  await openAppTab(c);
  await until(async () => (await checked(c)) === "ocean", 5000, "relaunch restores the pick").catch(() => {});
  check("the choice survives a relaunch", (await checked(c)) === "ocean", await checked(c));

  await pick(c, "default");
  await until(() => read("app-icon.json") === null, 5000, "forget").catch(() => {});
  check("choosing the default forgets the saved icon", read("app-icon.json") === null && read("app-icon.png") === null);
  c.close();
}

function reapProcesses() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    } catch {}
  }
}

function reap() {
  reapProcesses();
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
