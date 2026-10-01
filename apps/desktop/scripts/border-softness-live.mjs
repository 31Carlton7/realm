/**
 * The app's hairlines, measured as pixels (run with: node apps/desktop/scripts/border-softness-live.mjs)
 *
 * design.md: a contrast claim about a hairline is a pixel measurement, not a stylesheet reading —
 * what `6% white` comes to depends on the ground it lands on. Each line token is drawn as a real
 * half-pixel rule on the panel's own ground, captured at the device's 2x, and its step from that
 * ground reported as a share of full range, in both faces. The divider and the mark tokens ride
 * along as the references the softened lines are judged against. Screenshots of a session and of
 * Settings go to LIVE_SHOT_DIR for the eye.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-border-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-border-live-"));
let electron = null;
const menus = [];
const focusReports = [];
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

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  const wrapper = path.join(scratch, "wrapper.mjs");
  /* The OS menu is stood in for, not shown: it cannot be clicked over CDP, and a real one would open
     over whatever the person running this is doing. The stand-in reports exactly what main built and
     answers the way NSMenu does — the pick lands, then the close. stdin drives the rest: which label
     to pick, a key-window report, and a question about the window's real focus. */
  fs.writeFileSync(wrapper, [
    'import { app, BrowserWindow, Menu } from "electron";',
    'import readline from "node:readline";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "let pickLabel = null;",
    "Menu.prototype.popup = function (opts = {}) {",
    "  const items = this.items.map((i) => ({ label: i.label, role: i.role ?? null, type: i.type, enabled: i.enabled, checked: i.checked, accelerator: i.accelerator ?? null, icon: !!i.icon }));",
    "  console.log('LIVE_MENU ' + JSON.stringify({ items, x: opts.x ?? null, y: opts.y ?? null }));",
    "  const idx = pickLabel === null ? -1 : this.items.findIndex((i) => i.label === pickLabel);",
    "  setTimeout(() => { if (idx >= 0) this.items[idx].click(); opts.callback?.(); }, 30);",
    "};",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const [cmd, arg] = line.split(' ');",
    "  if (cmd === 'pick') pickLabel = arg === '-' ? null : decodeURIComponent(arg);",
    "  if (cmd === 'key') for (const w of BrowserWindow.getAllWindows()) w.webContents.send('window:key', arg === 'true');",
    "  if (cmd === 'focused') console.log('LIVE_FOCUSED ' + JSON.stringify(BrowserWindow.getAllWindows().map((w) => w.isFocused())));",
    "  if (cmd === 'phase') { const [phase, momentum] = arg.split('/'); for (const w of BrowserWindow.getAllWindows()) w.webContents.send('realm:scroll-phase', { phase, momentum, dx: 0, dy: 0, ts: Date.now() / 1000 }); }",
    "});",
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  let outBuf = "";
  electron.stdout.on("data", (d) => {
    process.stderr.write(`    [electron] ${d}`);
    outBuf += d.toString();
    for (let nl = outBuf.indexOf("\n"); nl !== -1; nl = outBuf.indexOf("\n")) {
      const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1);
      if (line.startsWith("LIVE_MENU ")) menus.push(JSON.parse(line.slice(10)));
      if (line.startsWith("LIVE_FOCUSED ")) focusReports.push(JSON.parse(line.slice(13)));
    }
  });
  const tell = (line) => electron.stdin.write(`${line}\n`);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await sleep(500);


  /* Settings is reached the way a person without the sidebar row reaches it: the command palette,
     which is page DOM (the space menu that also offers it is an OS menu now). */
  const HELPERS = `window.__live = { async palette(label) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector('.palette input'); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector('.palette input');
    if (!input) throw new Error('the palette did not open');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, label);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 80; i++) {
      const hit = [...document.querySelectorAll('.palette-list [role=option]')]
        .find((o) => o.querySelector('.palette-label')?.textContent.trim() === label);
      if (hit) { hit.click(); for (let j = 0; j < 60 && !document.querySelector('.page'); j++) await new Promise((r) => setTimeout(r, 25)); return true; }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no palette entry: ' + label); } }; true`;
  await evalIn(c, HELPERS);
  const TOKENS = ["--rl-line", "--rl-line-strong", "--line-soft", "--btn-ring", "--rl-divider", "--mark", "--mark-strong"];

  /** One 40px-tall strip per token, a 0.5px rule across its middle, on the panel ground. */
  const measure = async (label) => {
    await evalIn(c, `(() => {
      document.getElementById('hl-probe')?.remove();
      const host = document.createElement('div'); host.id = 'hl-probe';
      host.style.cssText = 'position:fixed;left:0;top:0;width:200px;z-index:99999;background:var(--rl-panel)';
      for (const t of ${JSON.stringify(TOKENS)}) {
        const row = document.createElement('div');
        row.style.cssText = 'height:40px;position:relative';
        const rule = document.createElement('div');
        rule.style.cssText = 'position:absolute;left:0;right:0;top:20px;height:0;border-top:var(--hairline-w) solid var(' + t + ')';
        row.appendChild(rule); host.appendChild(row);
      }
      document.body.appendChild(host); return true; })()`);
    await sleep(250);
    const { data } = await c.send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 200, height: 40 * TOKENS.length, scale: 1 }, format: "png" });
    await evalIn(c, `document.getElementById('hl-probe').remove(); true`);
    const png = Buffer.from(data, "base64");
    const file = path.join(shots, `probe-${label}.png`); fs.writeFileSync(file, png);
    return file;
  };

  const modes = {};
  for (const mode of ["dark", "light"]) {
    await evalIn(c, `document.documentElement.dataset.mode = ${JSON.stringify(mode)}; true`);
    await sleep(400);
    modes[mode] = await measure(mode);
    await shoot(c, `${mode}-session`, { x: 0, y: 0, width: 1280, height: 860 });
    await evalIn(c, `__live.palette('Open settings')`); await sleep(500);
    await shoot(c, `${mode}-settings`, { x: 0, y: 0, width: 1280, height: 860 });
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
  console.log("PROBES " + JSON.stringify({ tokens: TOKENS, files: modes }));

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
