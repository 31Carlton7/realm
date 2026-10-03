/**
 * Live check for the menu bar and the remembered window
 * (run with: node apps/desktop/scripts/menu-bar-live.mjs)
 *
 * The app's menu bar is built in main from the keybinding catalog and the person's own rules, and a
 * click runs a command in the renderer — none of which a unit test can see end to end. The window's
 * place is a fact about a real BrowserWindow across two launches. So this boots the built app TWICE
 * on one scratch profile: the first run reads the real application menu, clicks its rows, moves the
 * window and quits; the second checks the window came back where it was left.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-menu-bar-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-menu-bar-live-"));
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


/* The wrapper answers questions about main over stdin/stdout: the application menu as built, a click
   on one of its rows by label, the window's bounds, moving it, and quitting. */
const WRAPPER = [
  'import { app, BrowserWindow, Menu } from "electron";',
  'import readline from "node:readline";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "const walk = (items) => items.map((i) => ({ label: i.label, role: i.role ?? null, accelerator: i.accelerator ?? null, type: i.type, submenu: i.submenu ? walk(i.submenu.items) : null }));",
  "const findItem = (items, label) => { for (const i of items) { if (i.label === label) return i; if (i.submenu) { const f = findItem(i.submenu.items, label); if (f) return f; } } return null; };",
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');",
  "  const win = BrowserWindow.getAllWindows()[0];",
  "  if (cmd === 'menu') console.log('LIVE_REPLY ' + JSON.stringify(walk(Menu.getApplicationMenu().items)));",
  "  if (cmd === 'click') { const item = findItem(Menu.getApplicationMenu().items, arg); if (item) item.click(); console.log('LIVE_REPLY ' + JSON.stringify(!!item)); }",
  "  if (cmd === 'bounds') console.log('LIVE_REPLY ' + JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() }));",
  "  if (cmd === 'move') { const [x, y, width, height] = arg.split(',').map(Number); win.setBounds({ x, y, width, height }); console.log('LIVE_REPLY true'); }",
  "  if (cmd === 'quit') { console.log('LIVE_REPLY true'); app.quit(); }",
  "});",
  "await import(process.env.LIVE_MAIN);",
].join("\n");

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env,
      REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
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
    }
  });
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}
/** Ask main something and wait for its one-line answer. */
const ask = async (line) => {
  const n = replies.length;
  electron.stdin.write(`${line}\n`);
  await until(() => replies.length > n, 5000, line);
  return replies[replies.length - 1];
};
const flat = (items, out = []) => { for (const i of items) { out.push(i); if (i.submenu) flat(i.submenu, out); } return out; };

async function main() {
  fs.mkdirSync(shots, { recursive: true });

  // ---- first launch -----------------------------------------------------------------------------
  let c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await sleep(800); // the renderer reports the person's keybindings once the server has answered

  const menu = await ask("menu");
  const items = flat(menu);
  const top = menu.map((m) => m.label);
  console.log(`  menu bar: ${JSON.stringify(top)}`);
  check("the menu bar reads like a Mac app's", ["File", "Edit", "View", "Go", "Window", "Help"].every((l) => top.includes(l)), top);
  const settings = items.find((i) => i.label === "Settings…");
  check("Settings… sits under the app's name with ⌘, beside it", settings?.accelerator === "Command+,", settings);
  check("File ▸ New Session shows the person's ⌘N", items.find((i) => i.label === "New Session")?.accelerator === "Command+N");
  check("⌘W closes a pane and nothing in the menu closes the window", items.filter((i) => i.accelerator === "Command+W").map((i) => i.label).join() === "Close Pane"
    && !items.some((i) => i.role === "close"), items.filter((i) => i.accelerator === "Command+W"));
  const view = menu.find((m) => m.label === "View");
  check("Reload is not a top-level View item for anyone", !view.submenu.some((i) => i.role === "reload"), view.submenu.map((i) => i.label ?? i.role));
  check("Help has its own role, so macOS gives it a search field", menu.some((m) => m.role === "help"));

  // A menu click runs the command in the renderer.
  const collapsedBefore = await evalIn(c, `document.querySelector('.sidebar')?.hasAttribute('data-collapsed') ?? null`);
  await ask("click Toggle Sidebar"); await sleep(400);
  const collapsedAfter = await evalIn(c, `document.querySelector('.sidebar')?.hasAttribute('data-collapsed') ?? null`);
  check("View ▸ Toggle Sidebar toggles the sidebar", collapsedBefore !== collapsedAfter, { collapsedBefore, collapsedAfter });
  await ask("click Toggle Sidebar"); await sleep(300);
  await ask("click Settings…"); await sleep(600);
  const page = await evalIn(c, `document.querySelector('.page h1, .page-head h1, .page-title')?.textContent?.trim() ?? document.querySelector('.page') !== null`);
  check("Realm ▸ Settings… opens Settings", page === "Settings" || page === true, page);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  // ⌘, from the keyboard reaches the page's keybinding layer, the path the menu now leaves it to.
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ",", code: "Comma", modifiers: 4, windowsVirtualKeyCode: 188 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ",", code: "Comma", modifiers: 4, windowsVirtualKeyCode: 188 });
  await sleep(500);
  check("⌘, from the keyboard opens Settings too", await evalIn(c, `document.querySelector('.page') !== null`));

  // Move the window, then quit — the place has to survive the app going away.
  const want = { x: 140, y: 90, width: 1180, height: 760 };
  await ask(`move ${want.x},${want.y},${want.width},${want.height}`);
  await sleep(700);
  const moved = await ask("bounds");
  console.log(`  moved to ${JSON.stringify(moved)}`);
  c.close();
  await ask("quit").catch(() => {});
  await until(() => electron.exitCode !== null || electron.signalCode !== null, 15000, "first run exit").catch(() => {});
  if (electron.exitCode === null) electron.kill();
  reapServer();
  await until(async () => (await portFree(CDP_PORT)) && (await portFree(SERVER_PORT)), 15000, "ports released after the first run");
  // windows.json since Realm has several windows: one entry per window, this run's one.
  const saved = JSON.parse(fs.readFileSync(path.join(scratch, "userData", "windows.json"), "utf8")).windows[0];
  check("the place was written down on the way out", saved.width === moved.width && saved.height === moved.height, saved);

  // ---- second launch ----------------------------------------------------------------------------
  c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.composer, .panel')`), 20000, "workspace");
  const back = await ask("bounds");
  console.log(`  reopened at ${JSON.stringify(back)}`);
  check("the window comes back where it was left", back.x === moved.x && back.y === moved.y && back.width === moved.width && back.height === moved.height,
    { moved, back });
  c.close();
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
