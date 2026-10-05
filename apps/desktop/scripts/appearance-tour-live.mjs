/**
 * A tour of the app's colour, in both faces, for a person's eyes (run with:
 * node apps/desktop/scripts/appearance-tour-live.mjs; pictures land in LIVE_SHOT_DIR).
 *
 * Captures the surfaces the work touched, in both faces, and the MOTION as frame strips: each CSS
 * animation is paused and stepped through its own timeline with the Web Animations API, so a strip
 * shows the curve the stylesheet actually produces rather than whatever a screenshot happened to
 * catch. The rubber-band runs on a JS spring, so its strip is successive captures instead.
 *
 * What it cannot show, by construction: native views (OS menus, Quick Look, the window's material) —
 * a CDP capture renders the DOM only. Those need a real screen capture.
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
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-appearance-tour";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-appearance-tour-"));
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

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
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
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  electron.stdout.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  const tell = (line) => electron.stdin.write(`${line}\n`);
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  tell("key true");
  // A candidate palette, laid over the built stylesheet so it can be judged before it is written.
  if (process.env.LIVE_INJECT_CSS) {
    const css = fs.readFileSync(process.env.LIVE_INJECT_CSS, "utf8");
    await evalIn(c, `(() => { const s = document.createElement('style'); s.id = 'live-proto'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); return true; })()`);
  }

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  await api.call("spaces.create", { profileId: space.profileId, name: "Laya", icon: "folder" });
  for (const title of ["Port the importer", "Fix the diff gutter", "Teach the rail to wrap"]) {
    const made = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title });
    await api.call("sessions.send", { id: made.session.id, text: "hello", attachments: [], mentions: [] });
  }
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length >= 4 ? all : null; }, 15000, "sessions");
  const main = sessions.find((s) => !["Port the importer", "Fix the diff gutter", "Teach the rail to wrap"].includes(s.title)) ?? sessions[0];
  await api.call("sessions.setAgent", { id: main.id, agentKind: "fake" });
  const md = [
    "## Where the sidebar decides", "",
    "The rows come from **`groupItems`** in `state/groups.ts`, and the [design notes](https://realm.computer) say why.", "",
    "- Sessions are grouped by space", "- Pinned rows stay on top", "- Archived rows are hidden", "",
    "```ts", "export function groupItems(items: Item[]): Group[] {", "  return items.filter((i) => !i.archived).sort(byPinned);", "}", "```", "",
    "| Rule | Where |", "| --- | --- |", "| Pinned first | `byPinned` |", "| Hide archived | `filter` |", "",
    "> Archived rows come back from the Library.",
  ].join("\n");
  await api.call("sessions.send", { id: main.id, text: md, attachments: [], mentions: [] });
  await until(() => evalIn(c, `document.querySelectorAll('.msg-assistant-row').length > 0`), 20000, "a reply");
  await sleep(2500);

  const esc = () => key(c, "Escape", "Escape", 27);
  // Key before every capture: the window sits behind the person's own and can lose key status
  // mid-run, which greys the accent (KeyWindowBridge) and would misreport the palette.
  const snap = async (name) => { tell("key true"); await sleep(250); await shot(c, name); };
  const palette = async (label) => {
    await key(c, "k", "KeyK", 75, 4);
    await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
    await evalIn(c, `(() => { const input = document.querySelector('.palette input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
      input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    await evalIn(c, `[...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes(${JSON.stringify(label)}))?.click(); true`);
    await sleep(700);
  };
  const settingsTab = async (label) => {
    await evalIn(c, `[...document.querySelectorAll('.page-rail button, .page-rail [role=tab], .settings-rail button, .page-rail label')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(); true`);
    await sleep(600);
  };

  for (const mode of (process.env.LIVE_MODES ?? "light,dark").split(",")) {
    await evalIn(c, `document.documentElement.dataset.mode = ${JSON.stringify(mode)}; true`);
    await sleep(600);
    await snap(`${mode}-01-session`);
    await key(c, "k", "KeyK", 75, 4); await sleep(500);
    await snap(`${mode}-02-palette`);
    await esc(); await sleep(300);
    await evalIn(c, `document.querySelector('.model-chip')?.click(); true`); await sleep(500);
    await snap(`${mode}-03-model-picker`);
    await esc(); await sleep(300);
    await palette("Open settings");
    await snap(`${mode}-04-settings-engines`);
    await settingsTab("App");
    await snap(`${mode}-05-settings-app`);
    await settingsTab("Keys");
    await snap(`${mode}-06-settings-keys`);
    await esc(); await sleep(400);
    await palette("Agents");
    await snap(`${mode}-07-agents`);
    await esc(); await sleep(400);
    await palette("New space");
    await snap(`${mode}-08-sheet`);
    await esc(); await sleep(400);
  }
  api.close();
  c.close();
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
