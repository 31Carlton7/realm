/**
 * Live check for the platform table (run with: pnpm build && node apps/desktop/scripts/platform-chrome-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, on this Mac, and checks:
 *
 *   1. The Mac is untouched: the preload reports a Mac, the head row leaves the traffic lights their
 *      room (no `data-window-controls`), the palette prints ⌘ chords, and Settings keeps its Computer
 *      pages.
 *   2. The head row Linux and Windows get, by setting what `applyPlatform` sets there: the lead starts
 *      at 12px, and the side-pane toggle stands clear of the system's three window controls at the
 *      right end (138px, Windows' measure, where Chromium reports no overlay geometry — as on a Mac).
 *      The controls themselves are drawn by the OS and cannot be seen from here.
 *
 * Ports: LIVE_SERVER_PORT (8799), LIVE_CDP_PORT (9239). Scratch and pictures under LIVE_DIR. Nothing is
 * billed: every session is moved to the fake agent and nothing is typed into a composer. The window
 * cannot take focus (REALM_LIVE_SCRATCH). Kills only what listens on its own ports.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9239), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8799);
const LIVE_DIR = process.env.LIVE_DIR ?? path.join(repoRoot, "../.verify/platform-chrome-live");
const shots = path.join(LIVE_DIR, "shots");
fs.mkdirSync(shots, { recursive: true });
const scratch = fs.mkdtempSync(path.join(LIVE_DIR, "run-"));
const home = path.join(scratch, "home");
const WINDOW = { width: 1400, height: 900 };
let electron = null, api = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => false);
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The head row, with the window's material stood in for by a plain ground (it is not in the DOM). */
async function shot(c, name) {
  await evalIn(c, `(() => { document.documentElement.style.background = "#17181b"; const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WINDOW.width, height: 120, scale: 2 } });
    const file = path.join(shots, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SHOT ${file}`);
  } finally {
    await evalIn(c, `(() => { document.documentElement.style.background = ""; const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
  }
}

async function attach() {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return list.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  }, 30_000, "a page target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return c;
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const mainLog = fs.createWriteStream(path.join(scratch, "main.log"));
  electron = spawn(electronBin, [wrapper,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1",
      REALM_GH_BIN: path.join(scratch, "no-gh"), REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.pipe(mainLog); electron.stdout.pipe(mainLog);
  const c = await attach();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 60_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 60_000, "composer");
  return c;
}

/** Where the head row's pieces are, in window pixels. */
const HEAD = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: innerWidth - b.right, width: b.width }; };
  return { controls: document.documentElement.dataset.windowControls ?? null, lead: r(".window-lead"), trail: r(".window-trail"),
    controlsW: getComputedStyle(document.documentElement).getPropertyValue("--controls-w").trim() };
})()`;

async function main() {
  const c = await boot();
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  for (const s of await api.call("sessions.listAll", {})) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await c.send("Emulation.setDeviceMetricsOverride", { width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await sleep(800);

  /* ── 1. The Mac, untouched ─────────────────────────────────────────────────────────────────── */
  const caps = await evalIn(c, `window.realm.capabilities`);
  check("the preload reports a Mac with every Mac feature", caps.os === "mac" && caps.insetTrafficLights && caps.simulators && caps.fileManager === "Finder", caps);
  const mac = await evalIn(c, HEAD);
  check("the head row leaves the traffic lights their room", mac.controls === null && mac.lead?.left === 76 && mac.trail?.right === 12, mac);
  await shot(c, "head-mac");
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, bubbles: true })); true`);
  const kbd = await until(() => evalIn(c, `(() => { const k = [...document.querySelectorAll(".palette kbd")].map((e) => e.textContent); return k.length ? k : null; })()`), 8000, "a palette chord");
  check("the palette prints a Mac's chords", kbd.some((k) => /^⌘/.test(k)) && !kbd.some((k) => /Ctrl\+/.test(k)), kbd);
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); true`);
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, bubbles: true })); true`);
  const heads = await until(() => evalIn(c, `(() => { const h = [...document.querySelectorAll(".page-rail-head")].map((e) => e.textContent); return h.length ? h : null; })()`), 8000, "the settings rail");
  check("Settings keeps its Computer pages on a Mac", heads.includes("Computer"), heads);
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); true`);
  await sleep(400);

  /* ── 2. The head row Linux and Windows get ─────────────────────────────────────────────────── */
  await evalIn(c, `(document.documentElement.dataset.windowControls = "overlay", true)`);
  await sleep(300);
  const other = await evalIn(c, HEAD);
  check("off a Mac the lead starts at 12px, with no traffic lights to clear", other.lead?.left === 12, other);
  check("off a Mac the side-pane toggle stands clear of the system's window controls", other.trail?.right === 12 + 138, other);
  await shot(c, "head-overlay");
}

async function reap() {
  try { api?.close(); } catch {}
  await stopDaemons(home).catch(() => {});
  electron?.kill("SIGKILL");
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void reap().finally(() => process.exit(1)); });
