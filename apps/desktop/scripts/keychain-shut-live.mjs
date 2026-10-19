/**
 * Live check for saved passwords behind a shut Keychain (run with: pnpm build && node apps/desktop/scripts/keychain-shut-live.mjs)
 *
 * Boots the BUILT app twice on one scratch REALM_HOME, on the scripted agent and an in-memory keychain:
 *
 *   K1  the first launch saves a password, so secrets.json holds a keyring and a row;
 *   K2  the second launch is refused the Keychain (macOS offering no encryption key, stood in for):
 *       secrets.json is left byte for byte, nothing is set aside, and Settings ▸ Passwords says
 *       "Realm needs Keychain access…" with Try again — dark and light — in place of the saving line;
 *   K3  the Keychain opens, Try again lifts the notice, and the saved password is listed.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8822 / 9262), refused if taken. Screenshots go to LIVE_OUT.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9262);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8822);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-keychain-shut-live");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-keychain-shut-live-"));
const HOME = path.join(scratch, "home");
const shutFlag = path.join(scratch, "keychain-shut");
const NOTICE = "Realm needs Keychain access to read your saved passwords.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;
let electron = null;
fs.mkdirSync(OUT_DIR, { recursive: true });

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + js(detail) : ""}`);
};
const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});
async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`);
    await sleep(100);
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
const setInput = (c, selector, value) => evalIn(c, `(() => {
  const el = document.querySelector(${js(selector)}); if (!el) throw new Error("no " + ${js(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${js(value)});
  el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

async function shot(c, tag) {
  await evalIn(c, `(() => { const b = document.getElementById('live-scratch-banner'); if (b) b.style.inset = 'auto 0 0 0'; return true; })()`);
  await sleep(400);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
async function palette(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await setInput(c, ".palette input", label);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.includes(${js(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
}
async function setTheme(c, mode) {
  await palette(c, `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${js(mode)}`), 4000, `mode ${mode}`);
}

async function launch() {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app, safeStorage } from "electron";',
    'import fs from "node:fs";',
    'app.commandLine.appendSwitch("use-mock-keychain");',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    // A Keychain macOS will not open for Realm: no encryption key on offer while the flag file is there.
    "const offered = safeStorage.isEncryptionAvailable.bind(safeStorage);",
    "Object.defineProperty(safeStorage, 'isEncryptionAvailable', { value: () => !fs.existsSync(process.env.LIVE_KEYCHAIN_SHUT) && offered(), configurable: true, writable: true });",
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: HOME, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"), LIVE_KEYCHAIN_SHUT: shutFlag,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const page = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  return c;
}

async function quit(c) {
  const api = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}`, tokenProtocols(await daemonToken(HOME)));
  await new Promise((r) => api.addEventListener("open", r));
  api.send(JSON.stringify({ id: "stop", method: "daemon.stop", params: {} }));
  await sleep(500);
  api.close();
  c.close();
  electron.kill("SIGKILL");
  await until(async () => portFree(SERVER_PORT), 15_000, "the server to stop");
  await until(async () => portFree(CDP_PORT), 15_000, "the window to close");
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  /* ── K1 ── */
  let c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Keychain");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  const token = await daemonToken(HOME);
  const api = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}`, tokenProtocols(token));
  await new Promise((r) => api.addEventListener("open", r));
  const spaces = await new Promise((resolve) => {
    api.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id === "s") resolve(msg.result); });
    api.send(JSON.stringify({ id: "s", method: "spaces.list", params: {} }));
  });
  api.close();
  const profileId = spaces[0].profileId;
  await evalIn(c, `window.realm.credentials.add(${js(profileId)}, { origin: "https://example.com", username: "ada", label: "Work", value: "kept-behind-the-keychain" }).then(() => true)`);
  const before = fs.readFileSync(path.join(HOME, "secrets.json"));
  check("K1 secrets.json holds a keyring and the saved row", JSON.parse(before).keyring !== "" && JSON.parse(before).credentials.length === 1);
  await quit(c);

  /* ── K2 ── */
  fs.writeFileSync(shutFlag, "");
  c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await palette(c, "Open settings");
  const tab = `[...document.querySelectorAll('label.settings-tab')].find((l) => l.textContent.trim() === 'Passwords')`;
  await until(() => evalIn(c, `!!${tab}`), 10_000, "settings rail");
  await evalIn(c, `${tab}.click(), true`);
  const notice = await until(() => evalIn(c, `document.querySelector('.passwords-keychain')?.textContent ?? null`), 10_000, "the notice");
  check("K2 Settings ▸ Passwords asks for Keychain access, with Try again", notice === `${NOTICE}Try again`, { notice });
  check("K2 and only that: no line about saving beside it", await evalIn(c, `!document.body.textContent.includes("isn't offering Realm an encryption key")`));
  check("K2 secrets.json is byte for byte what it was, and nothing was set aside",
    Buffer.compare(fs.readFileSync(path.join(HOME, "secrets.json")), before) === 0 && !fs.readdirSync(HOME).some((n) => n.startsWith("secrets.unreadable-")));
  await shot(c, "11-keychain-needed-dark");
  await setTheme(c, "light");
  await shot(c, "12-keychain-needed-light");
  await setTheme(c, "dark");

  /* ── K3 ── */
  fs.rmSync(shutFlag);
  await evalIn(c, `(() => { [...document.querySelectorAll('.passwords-keychain button')].find((b) => b.textContent === "Try again").click(); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('.passwords-keychain')`), 10_000, "the notice to lift");
  const row = await until(() => evalIn(c, `[...document.querySelectorAll('.creds-list .settings-row')].some((r) => r.textContent.includes("example.com")) || null`), 10_000, "the saved row");
  check("K3 Try again lifts the notice and the saved password is there", row === true);
  await shot(c, "13-keychain-open-again");
  await quit(c);
}

async function teardown() {
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(HOME);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
