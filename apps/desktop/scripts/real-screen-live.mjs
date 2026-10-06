/**
 * The surfaces a CDP capture cannot see, on the REAL screen (run with:
 * LIVE_FRONT=1 node apps/desktop/scripts/real-screen-live.mjs; pictures land in LIVE_SHOT_DIR).
 *
 * Every other live script captures the page, and the page is not where these live: the window's
 * material is NSVisualEffectView, a native menu is an NSMenu, Quick Look is a QLPreviewPanel, Share is
 * NSSharingServicePicker, and the Dock tile is the Dock's. So this one drives the built app on a
 * scratch home and takes `screencapture` of the screen while each is up.
 *
 * It TAKES OVER THE SCREEN with LIVE_FRONT=1 — the window is brought to the front, menus and panels
 * open over whatever the person was doing. Without it the flow still runs (useful to check the
 * plumbing) and the window stays wherever macOS put it. Captures need Screen Recording for the app
 * this runs under; without it each capture is reported as SKIP rather than as a pass.
 *
 * Which app that is matters. Spawned from a shell, Electron's Screen Recording is judged against
 * whatever app owns the shell (a terminal, or Realm itself when an agent runs this), and a grant made
 * since that app launched does not count until it relaunches. So the app is started with `open`,
 * which makes the test Electron its OWN responsible app, and every capture is taken BY that process
 * — a `screencapture` spawned from here would be judged against the shell's app again. With `open`
 * there is no stdin, so main takes its commands over a loopback port (LIVE_CMD_PORT).
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-real-screen";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-real-screen-"));
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

const FRONT = process.env.LIVE_FRONT === "1";
const CMD_PORT = Number(process.env.LIVE_CMD_PORT ?? 9452);

/** Commands main runs for the script. Menus are NOT stubbed: the OS menu is the thing under test. */
const WRAPPER = [
  'import { app, BrowserWindow, Menu, ShareMenu } from "electron";',
  'import net from "node:net";',
  'import { spawnSync } from "node:child_process";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "let lastMenu = null, share = null;",
  "const popup = Menu.prototype.popup;",
  "Menu.prototype.popup = function (opts = {}) { lastMenu = { menu: this, win: opts.window }; return popup.call(this, opts); };",
  "const win = () => BrowserWindow.getAllWindows()[0];",
  "const run = (line) => {",
  "  const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');",
  "  const w = win();",
  "  if (cmd === 'key') for (const x of BrowserWindow.getAllWindows()) x.webContents.send('window:key', arg === 'true');",
  "  if (cmd === 'front') { w.setBounds({ x: 120, y: 80, width: 1240, height: 800 }); app.focus({ steal: true }); w.show(); w.focus(); }",
  "  if (cmd === 'bounds') return JSON.stringify(w.getBounds());",
  "  if (cmd === 'raise') { app.focus({ steal: true }); w.show(); w.focus(); return 'ok'; }",
  "  if (cmd === 'key?') return String(w.isFocused());",
  // The capture runs HERE, so Screen Recording is judged against this app (see the header).
  "  if (cmd === 'capture') { const [file, rect] = arg.split('|'); const r = spawnSync('screencapture', ['-x', ...(rect ? ['-R', rect] : []), file], { encoding: 'utf8' }); return JSON.stringify({ status: r.status, err: r.stderr }); }",
  "  if (cmd === 'menu-close') { lastMenu?.menu.closePopup(lastMenu.win); lastMenu = null; }",
  "  if (cmd === 'ql') w.previewFile(arg);",
  "  if (cmd === 'ql-close') w.closeFilePreview();",
  "  if (cmd === 'share') { share = new ShareMenu({ filePaths: [arg] }); share.popup({ window: w, x: 420, y: 300 }); }",
  "  if (cmd === 'share-close') { share?.closePopup(w); share = null; }",
  "  return 'ok';",
  "};",
  "net.createServer((sock) => { let buf = ''; sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let out; try { out = run(line); } catch (e) { out = 'error ' + e.message; } sock.write(out + '\\n'); } }); }).listen(Number(process.env.LIVE_CMD_PORT), '127.0.0.1');",
  "await import(process.env.LIVE_MAIN);",
].join("\n");

const key = async (c, k, code, vk, modifiers = 0, text) => {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};

async function launch() {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const env = { REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1",
    REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
    REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), LIVE_CMD_PORT: String(CMD_PORT),
    LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") };
  const app = path.resolve(electronBin, "../../..");
  execSync(`open -n -a ${JSON.stringify(app)} ${Object.entries(env).map(([k, v]) => `--env ${k}=${JSON.stringify(v)}`).join(" ")} --args ${JSON.stringify(wrapper)}`);
  await until(async () => !(await portFree(CMD_PORT)), 30000, "command port");
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}

/** One command to main, and its one-line answer. */
function ask(line) {
  return new Promise((resolve, reject) => {
    const sock = connect({ port: CMD_PORT, host: "127.0.0.1" });
    let buf = "";
    sock.on("data", (d) => { buf += d; if (buf.includes("\n")) { sock.end(); resolve(buf.trim()); } });
    sock.on("error", reject);
    sock.write(`${line}\n`);
  });
}
const tell = (line) => ask(line);

/** The window's frame in screen points, from main. */
const bounds = async () => JSON.parse(await ask("bounds"));

/** A real screen capture of a region (points), or of the whole main display — taken by the app.
 *  A capture with the test window NOT key is reported as OCCLUDED, not as a shot: anything the person
 *  clicked in the meantime is in the picture instead, and Quick Look asks the KEY window for its item
 *  (a non-key test window gets "No items selected" from someone else's window). */
async function capture(name, r) {
  if (FRONT && (await ask("key?")) !== "true") { console.log(`OCCLUDED ${name} (another window took the front — keep hands off during the run)`); process.exitCode = 1; return false; }
  const file = path.join(shots, `${name}.png`);
  const res = JSON.parse(await ask(`capture ${file}|${r ? `${r.x},${r.y},${r.width},${r.height}` : ""}`));
  const ok = res.status === 0 && fs.existsSync(file);
  console.log(`${ok ? "SHOT" : "SKIP"} ${name}${ok ? " " + file : " (no Screen Recording: " + (res.err || "").trim() + ")"}`);
  return ok;
}
const around = (b, pad) => ({ x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad });

async function openSettingsApp(c) {
  await key(c, "k", "KeyK", 75, 4);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await evalIn(c, `(() => { const input = document.querySelector('.palette input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, "Open settings");
    input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `[...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes("Open settings"))?.click(); true`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.page-rail button, .page-rail [role=tab], .page-rail label')].some((b) => ["App", "Appearance"].includes(b.textContent.trim()))`), 10000, "settings");
  await evalIn(c, `[...document.querySelectorAll('.page-rail button, .page-rail [role=tab], .page-rail label')].find((b) => ["App", "Appearance"].includes(b.textContent.trim()))?.click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.app-icon-grid')`), 10000, "app icon grid");
}

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT, CMD_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  // Something real to look at and to share.
  const doc = path.join(scratch, "Release notes.md");
  fs.writeFileSync(doc, "# Release notes\n\n- Arc-style app icon, and eight more in Settings\n- One type ladder\n- Icons at the weight of their text\n");

  const c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  for (const title of ["Port the importer", "Fix the diff gutter", "Teach the rail to wrap"]) {
    const made = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title });
    await api.call("sessions.send", { id: made.session.id, text: "hello", attachments: [], mentions: [] });
  }
  await sleep(1500);
  if (FRONT) { await tell("front"); await sleep(800); }
  await tell("key true");
  const b = await bounds();
  console.log("window", JSON.stringify(b));

  // 1. The window's material, in both faces, with whatever is on the desktop behind it. Through the
  //    REAL Theme control: it is what tells main the appearance (main/appearance.ts), and a mode
  //    stamped on the page alone would leave the material on the Mac's appearance — the grey bug.
  await openSettingsApp(c);
  for (const mode of ["dark", "light"]) {
    await evalIn(c, `document.querySelector('input[name="settings-theme"][value=${JSON.stringify(mode)}]').click(); true`);
    if (FRONT) await tell("raise");
    await sleep(900);
    await capture(`01-material-${mode}-settings`, b);
    await evalIn(c, `[...document.querySelectorAll('.sidebar button, .sidebar [role=button], .sidebar a')].find((e) => e.textContent.trim() === "Port the importer")?.click(); true`);
    await sleep(900);
    await capture(`01-material-${mode}-session`, b);
    await openSettingsApp(c);
  }
  await evalIn(c, `document.querySelector('input[name="settings-theme"][value="dark"]').click(); true`);
  await sleep(400);
  if (process.env.LIVE_ONLY === "material") { api.close(); c.close(); return; }

  // 2. The menu bar: Realm's own menus, frontmost.
  if (FRONT) { await tell("raise"); await sleep(400); }
  await capture("02-menu-bar", { x: 0, y: 0, width: 900, height: 30 });

  // 3. A native menu, from a real control.
  if (FRONT) { await tell("raise"); await sleep(400); }
  await evalIn(c, `document.querySelector('[aria-label="Space menu"]')?.click(); true`);
  await sleep(900);
  await capture("03-native-menu", around(b, 0));
  await tell("menu-close");
  await sleep(500);

  // 4. Quick Look on a file.
  if (FRONT) { await tell("raise"); await sleep(400); }
  await tell(`ql ${doc}`);
  await sleep(1800);
  await capture("04-quick-look");
  await tell("ql-close");
  await sleep(700);

  // 5. The system Share menu.
  if (FRONT) { await tell("raise"); await sleep(400); }
  await tell(`share ${doc}`);
  await sleep(1200);
  await capture("05-share", around(b, 0));
  await tell("share-close");
  await sleep(500);

  // 6. The Dock tile, after picking an icon in Settings — the whole display, since only the person's
  //    own Dock settings say which edge it is on.
  if (FRONT) { await tell("raise"); await sleep(400); }
  await openSettingsApp(c);
  await evalIn(c, `document.querySelector('.app-icon-grid').scrollIntoView({ block: "center" }); true`);
  await evalIn(c, `document.querySelector('.app-icon-grid input[value="ocean"]').click(); true`);
  await sleep(1200);
  await capture("06-dock-ocean");
  await capture("06-picker", b);
  await evalIn(c, `document.querySelector('.app-icon-grid input[value="default"]').click(); true`);
  await sleep(1200);
  await capture("07-dock-graphite");

  api.close();
  c.close();
}

function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT, CMD_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
