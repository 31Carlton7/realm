/**
 * What's new, end to end in the built app (run with: node apps/desktop/scripts/whats-new-live.mjs).
 *
 * A fresh install opens on first run and records its version without showing the sheet. Seeding an
 * older version into userData then stands in for an update: the next launch opens the sheet by
 * itself, Done writes the running version down, and a launch after that stays quiet. The rail's
 * button, above the profile, opens the sheet again. Captured in dark and light, sheet and button.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started. Sends no
 * message to any agent.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9235), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8795);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-whats-new";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-whats-new-live-"));
const userData = path.join(scratch, "userData");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/desktop/package.json"), "utf8")).version;
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip ? { clip: { ...clip, scale: 2 } } : {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
}

const boxOf = (c, sel, pad = 0) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${2 * pad}, height: r.height + ${2 * pad} }; })()`);

const key = async (c, k, code, vk, modifiers = 0) => {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};

const WRAPPER = [
  'import { app } from "electron";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "await import(process.env.LIVE_MAIN);",
].join("\n");

async function launch() {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  // The window opens behind whatever is in front; without these Chromium stops laying it out.
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: userData, LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  // A window that is not key greys its accent; this one is a test's, behind the person's own.
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute('data-window-inactive');
    new MutationObserver(() => root.hasAttribute('data-window-inactive') && root.removeAttribute('data-window-inactive'))
      .observe(root, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  return c;
}

const sheetUp = (c) => evalIn(c, `!!document.querySelector('[role=dialog][aria-label="What\\'s new"]')`);
const seen = () => { try { return JSON.parse(fs.readFileSync(path.join(userData, "whats-new.json"), "utf8")).seen; } catch { return null; } };

async function theme(c, name) {
  await key(c, "k", "KeyK", 75, 4);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await evalIn(c, `(() => { const input = document.querySelector('.palette input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`Theme: ${name}`)});
    input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `[...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes(${JSON.stringify(`Theme: ${name}`)}))?.click(); true`);
  await until(() => evalIn(c, `!document.querySelector('.palette input')`), 5000, "palette closed");
  await sleep(400);
}

async function relaunch(c) {
  c.close();
  reapProcesses();
  await until(async () => (await portFree(CDP_PORT)) && (await portFree(SERVER_PORT)), 15000, "ports free");
  const next = await launch();
  await until(() => evalIn(next, `!!document.querySelector('.composer')`), 30000, "composer after relaunch");
  return next;
}

async function captureSheet(c, face) {
  await until(() => sheetUp(c), 5000, "sheet");
  await sleep(700); // the sheet's entrance
  await shoot(c, `sheet-${face}-window`);
  await shoot(c, `sheet-${face}`, await boxOf(c, ".sheet", 24));
}

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  // 1. A brand-new install: first run, then the workspace — and no sheet.
  let c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer");
  await sleep(1500);
  check("a new install does not open the sheet", !(await sheetUp(c)));
  check("a new install records its version silently", seen() === version, seen());
  await theme(c, "Dark"); // kept across the relaunches below

  // Its second launch is quiet too, though by now it has a window place an earlier Realm would leave.
  c = await relaunch(c);
  await sleep(2500);
  check("a new install's second launch does not open the sheet", !(await sheetUp(c)));

  // 2. An update: the profile last saw an older version.
  fs.writeFileSync(path.join(userData, "whats-new.json"), JSON.stringify({ seen: "2.0.0" }));
  c = await relaunch(c);
  await until(() => sheetUp(c), 10000, "sheet after update").catch(() => {});
  check("an update opens the sheet by itself", await sheetUp(c));
  const facts = await evalIn(c, `(() => { const d = document.querySelector('[role=dialog]');
    return { version: d.querySelector('.whats-new-version')?.textContent, items: [...d.querySelectorAll('li')].map((li) => li.textContent),
      href: d.querySelector('a.btn')?.getAttribute('href'), img: d.querySelector('img.whats-new-icon')?.naturalWidth ?? 0 }; })()`);
  check("it names the running version", facts.version === `Realm ${version}`, facts.version);
  check("it lists this version's notes", facts.items.length > 0, facts.items);
  check("it links the changelog", facts.href === "https://realm.computer/changelog", facts.href);
  check("its image loaded", facts.img > 0, facts.img);
  await captureSheet(c, "dark");
  await evalIn(c, `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent === 'Done').click(); true`);
  await until(async () => !(await sheetUp(c)), 5000, "closed");
  await until(() => seen() === version, 5000, "seen written").catch(() => {});
  check("Done records the running version", seen() === version, seen());

  // 3. The rail's button, above the profile, opens it again — dark, then light.
  const order = await evalIn(c, `[...document.querySelectorAll('.rail-foot > *')].map((e) => e.getAttribute('aria-label'))`);
  check("the button sits directly above the profile button", order.at(-2) === "What's new", order);
  await shoot(c, "rail-foot-dark", await boxOf(c, ".rail-foot", 12));
  await evalIn(c, `document.querySelector('.rail-foot [aria-label="What\\'s new"]').click(); true`);
  check("the button reopens the sheet", Boolean(await until(() => sheetUp(c), 5000, "reopen").catch(() => false)));
  await key(c, "Escape", "Escape", 27);
  await until(async () => !(await sheetUp(c)), 5000, "closed by Escape");

  await theme(c, "Light");
  await shoot(c, "rail-foot-light", await boxOf(c, ".rail-foot", 12));
  await evalIn(c, `document.querySelector('.rail-foot [aria-label="What\\'s new"]').click(); true`);
  await captureSheet(c, "light");
  await key(c, "Escape", "Escape", 27);
  await until(async () => !(await sheetUp(c)), 5000, "closed by Escape");

  // 4. The same version again: quiet.
  c = await relaunch(c);
  await sleep(2500);
  check("the same version does not open it again", !(await sheetUp(c)));
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
