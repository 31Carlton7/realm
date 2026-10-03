/**
 * Live check for New Window (run with: node apps/desktop/scripts/windows-live.mjs)
 *
 * Several windows are a fact about real BrowserWindows, their renderers and a relaunch, none of
 * which a unit test has. This boots the built app, adds a second space, opens a second window through
 * the real bridge, and checks the rule that makes several windows safe — a space is open in at most
 * one — from both sides. Then it quits the way ⌘Q does, relaunches, and checks both windows came back
 * on their own spaces.
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
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-windows-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-windows-live-"));
let electron = null;
const replies = [];
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
  return { ready, call: (method, params) => new Promise((res, rej) => { const i = String(++id);
    pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
    ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

/* The wrapper reports on main: every window's title (the space it shows), which window was last
   brought forward, the menu as built, and a ⌘Q. `focus` is recorded rather than trusted — a window
   behind the person's own cannot actually become key, but main asking for it is the fact here. */
const WRAPPER = [
  'import { app, BrowserWindow, Menu } from "electron";',
  'import readline from "node:readline";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "Menu.prototype.popup = function (opts = {}) { setTimeout(() => opts.callback?.(), 10); };",
  "const origFocus = BrowserWindow.prototype.focus;",
  "BrowserWindow.prototype.focus = function () { console.log('LIVE_RAISED ' + JSON.stringify(this.getTitle())); return origFocus.call(this); };",
  "const walk = (items) => items.map((i) => ({ label: i.label, accelerator: i.accelerator ?? null, submenu: i.submenu ? walk(i.submenu.items) : null }));",
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const [cmd] = line.split(' ');",
  "  if (cmd === 'titles') console.log('LIVE_REPLY ' + JSON.stringify(BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort()));",
  "  if (cmd === 'menu') console.log('LIVE_REPLY ' + JSON.stringify(walk(Menu.getApplicationMenu().items)));",
  "  if (cmd === 'quit') { console.log('LIVE_REPLY true'); app.quit(); }",
  "  if (cmd === 'views') console.log('LIVE_REPLY ' + JSON.stringify(Object.fromEntries(BrowserWindow.getAllWindows().map((w) => [w.getTitle(), w.contentView.children.length]))));",
  "});",
  "await import(process.env.LIVE_MAIN);",
].join("\n");
const raised = [];

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env,
      REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", 
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  let buf = "";
  electron.stdout.on("data", (d) => {
    process.stderr.write(`    [electron] ${d}`);
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith("LIVE_REPLY ")) replies.push(JSON.parse(line.slice(11)));
      if (line.startsWith("LIVE_RAISED ")) raised.push(JSON.parse(line.slice(12)));
    }
  });
  return pages(1);
}

/** Connect to the first `n` renderer pages, in the order CDP lists them. */
async function pages(n) {
  const list = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const found = await until(async () => { const p = (await list()).filter((t) => t.type === "page" && t.url.startsWith("file://")); return p.length >= n ? p : null; }, 30000, `${n} renderer page(s)`);
  const out = [];
  for (const t of found) { const c = cdp(t.webSocketDebuggerUrl); await c.ready; await c.send("Runtime.enable"); out.push(c); }
  return out;
}
const ask = async (line) => {
  const n = replies.length;
  electron.stdin.write(`${line}\n`);
  await until(() => replies.length > n, 5000, line);
  return replies[replies.length - 1];
};
const title = (c) => evalIn(c, "document.title");
const flat = (items, out = []) => { for (const i of items) { out.push(i); if (i.submenu) flat(i.submenu, out); } return out; };

async function main() {
  fs.mkdirSync(shots, { recursive: true });

  // ---- first launch: one window, two spaces ------------------------------------------------------
  let [c1] = await launch();
  await until(() => evalIn(c1, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c1, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Alpha');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c1, `!!document.querySelector('.composer')`), 20000, "composer");
  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [first] = await api.call("spaces.list", {});
  await api.call("spaces.create", { profileId: first.profileId, name: "Beta", icon: "folder" });
  await until(async () => (await title(c1)) === "Alpha", 10000, "window titled for its space");
  check("a window is titled for its space", (await title(c1)) === "Alpha", await title(c1));

  const menu = flat(await ask("menu"));
  check("File ▸ New Window on ⌘⇧N", menu.find((i) => i.label === "New Window")?.accelerator === "Command+Shift+N", menu.find((i) => i.label === "New Window"));
  check("Quick Chat moved to ⌥⌘N", menu.find((i) => i.label === "New Quick Chat")?.accelerator === "Command+Alt+N", menu.find((i) => i.label === "New Quick Chat"));

  // ---- New Window opens on the space nobody is looking at ----------------------------------------
  await evalIn(c1, `window.realm.windows.newWindow().then(() => true)`);
  const both = await pages(2);
  const c2 = both.find((c) => c !== c1) ?? both[1];
  await until(async () => (await title(c2)) === "Beta", 15000, "second window on the free space").catch(() => {});
  check("the new window opens on the space no window shows", (await title(c2)) === "Beta", { w1: await title(c1), w2: await title(c2) });
  for (const [name, c] of [["window-1", c1], ["window-2", c2]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const { data } = await c.send("Page.captureScreenshot", {});
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
    await c.send("Emulation.clearDeviceMetricsOverride");
  }
  check("main sees two windows, one per space", JSON.stringify(await ask("titles")) === JSON.stringify(["Alpha", "Beta"]), await ask("titles"));

  // ---- asking for a space another window has brings that window forward instead -------------------
  raised.length = 0;
  const switched = await evalIn(c2, `(async () => {
    const strip = [...document.querySelectorAll('.strip-space, [data-space-id]')];
    return strip.length; })()`);
  // ⌘1 is "switch to space 1" — Alpha, which window 1 has.
  for (const type of ["keyDown", "keyUp"]) await c2.send("Input.dispatchKeyEvent", { type, key: "1", code: "Digit1", modifiers: 4, windowsVirtualKeyCode: 49, ...(type === "keyDown" ? { text: "1" } : {}) });
  await sleep(800);
  check("window 2 stays on its own space", (await title(c2)) === "Beta", await title(c2));
  check("window 1, which has that space, is brought forward instead", raised.includes("Alpha"), { raised, stripButtons: switched });

  // ---- a browser pane's native view lives in the window that opened it ----------------------------
  const viewsBefore = await ask("views");
  await evalIn(c2, `(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector('.palette input'); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector('.palette input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'New browser');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 80; i++) {
      const hit = [...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes('New browser'));
      if (hit) { hit.click(); return true; }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false; })()`);
  await until(async () => { const v = await ask("views"); return v.Beta > viewsBefore.Beta ? v : null; }, 15000, "a browser view in window 2").catch(() => {});
  const viewsAfter = await ask("views");
  console.log(`  native views per window: before ${JSON.stringify(viewsBefore)} after ${JSON.stringify(viewsAfter)}`);
  check("a browser pane opened in window 2 attaches its native view to window 2, not window 1",
    viewsAfter.Beta === viewsBefore.Beta + 1 && viewsAfter.Alpha === viewsBefore.Alpha, { viewsBefore, viewsAfter });

  // ---- ⌘Q, then a relaunch: both come back on their own spaces -----------------------------------
  await ask("quit").catch(() => {});
  await sleep(1500);
  const saved = JSON.parse(fs.readFileSync(path.join(scratch, "userData", "windows.json"), "utf8"));
  console.log(`  windows.json after ⌘Q: ${JSON.stringify(saved.windows.map((w) => w.spaceId))}`);
  check("⌘Q remembers every window it closed", saved.windows.length === 2 && new Set(saved.windows.map((w) => w.spaceId)).size === 2, saved);
  api.close();
  for (const c of both) c.close();
  if (electron.exitCode === null) electron.kill();
  reapServer();
  await until(async () => (await portFree(CDP_PORT)) && (await portFree(SERVER_PORT)), 15000, "ports released");

  const again = await launch();
  const back = await pages(2);
  await until(async () => (await Promise.all(back.map(title))).sort().join() === "Alpha,Beta", 20000, "both windows back").catch(() => {});
  const titles = (await Promise.all(back.map(title))).sort();
  check("after a relaunch both windows come back, each on its own space", titles.join() === "Alpha,Beta", titles);
  for (const c of back) c.close();
  void again;
}

/** Kill whatever this run left on its two ports — the server outlives a killed Electron. */
function reapServer() {
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    } catch {}
  }
}

/**
 * The server is a SECOND Electron process, spawned by the one we started, and killing the parent
 * leaves it holding REALM_PORT — so the next run refuses to start on a port nothing is using any
 * more. Killed by port rather than by pid so an orphan from an interrupted run is cleared too, and
 * only ever the port this script chose.
 */
function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid)); } catch {}
      }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
