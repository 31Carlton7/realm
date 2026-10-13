/**
 * Live check for where a clicked link opens (run with: node apps/desktop/scripts/link-open-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME (run `pnpm build` first), puts a reply with a link to a
 * local test page in a fake session's transcript, and clicks it for real:
 *
 *   1. Setting = Default browser: a click reaches main's `shell.openExternal` (stubbed over main's
 *      inspector, so no browser is launched) and opens no pane; ⌘-click opens a Realm Browser tab.
 *   2. Setting = Realm Browser (picked in Settings ▸ General): a click opens a browser pane beside the
 *      session, on the link; ⌘-click goes to `shell.openExternal`.
 *   3. A right-click builds the menu (after Look Up, for the word it selects) with both browsers, the chosen one first; a mail link gets only
 *      the default browser. Main's `Menu.buildFromTemplate` is wrapped to read the template and not
 *      pop it; the Realm row is then clicked through the template.
 *
 * Screenshots the settings row in both faces into LIVE_SHOTS. Ports: env-overridable. Touches only a
 * scratch dir; stops only what it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9270);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8830);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9271);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8832);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SHOTS = process.env.LIVE_SHOTS ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-link-open-live-"));
const home = path.join(scratch, "home");
const PAGE = `http://127.0.0.1:${SITE_PORT}/page`;
const MAIL = "mailto:someone@example.com";
const WINDOW = { width: 1400, height: 880 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

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
    await sleep(120);
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
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

const HELPERS = `
globalThis.__live = {
  store() {
    if (globalThis.__liveStore) return globalThis.__liveStore;
    const el = document.querySelector('.app') ?? document.querySelector('#root > *');
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && 'linksOpenIn' in v.getState()) { globalThis.__liveStore = v; return v; }
    }
    return null;
  },
  st() { return __live.store().getState(); },
  box(el) { if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), l: r.left, t: r.top, w: r.width, h: r.height }; },
  link(href) { const all = [...document.querySelectorAll('.session-pane a[href="' + href + '"]')]; return all.at(-1) ?? null; },
  browsers() { return __live.st().items.filter((i) => i.kind === 'browser').length; },
  keepKey() {
    const root = document.documentElement;
    root.removeAttribute('data-window-inactive');
    if (!globalThis.__keepKey) {
      globalThis.__keepKey = new MutationObserver(() => { if (root.hasAttribute('data-window-inactive')) root.removeAttribute('data-window-inactive'); });
      globalThis.__keepKey.observe(root, { attributes: true, attributeFilter: ['data-window-inactive'] });
    }
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** A real click — the renderer's own mouse events, with ⌘ when asked (CDP modifier 4 = Meta). */
async function click(c, { x, y }, { meta = false, button = "left" } = {}) {
  const modifiers = meta ? 4 : 0;
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  await sleep(60);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1, modifiers });
}

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  } catch { /* nothing listening */ }
}

async function shot(c, tag) {
  const clip = await evalIn(c, `(() => { const r = document.querySelector('[data-setting="open-links-in"]'); r.scrollIntoView({ block: 'center' });
    const b = r.getBoundingClientRect(); return { x: b.left - 16, y: b.top - 40, width: b.width + 32, height: b.height + 56 }; })()`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, `open-links-in-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Link target</title><h1>Link target</h1>"); });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);

  // Main's two exits, watched: openExternal records instead of launching a browser, and a text menu's
  // template is kept instead of popped (the app menu bar still builds as it always does).
  await inMain(m, `(() => {
    const { shell, Menu } = require("electron");
    globalThis.__opened = [];
    shell.openExternal = async (url) => { globalThis.__opened.push(url); };
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (t) => {
      if (!t.some((i) => i.label === "Copy Link")) return build(t);
      globalThis.__menu = t;
      return { popup() {} };
    };
    return true; })()`);
  const opened = () => inMain(m, `globalThis.__opened.slice()`);
  const paneUrls = () => inMain(m, `require("electron").webContents.getAllWebContents().map((w) => w.getURL())`);

  // Onboarding, and its session onto the fake agent, which echoes what it is sent.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer-input')`), 30_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const [sess] = await api.call("sessions.list", { spaceId: space.id });
  await api.call("sessions.setAgent", { id: sess.id, agentKind: "fake" });
  await evalIn(c, `__live.keepKey()`);
  await until(() => evalIn(c, `!!__live.store()`), 10_000, "the store");
  await evalIn(c, `(async () => { await __live.st().setThemePref("dark"); return true; })()`);
  await api.call("sessions.send", { id: sess.id, text: `Read [the test page](${PAGE}) or [write to us](${MAIL}).`, attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!__live.link(${JSON.stringify(PAGE)}) && !!__live.link(${JSON.stringify(MAIL)})`), 20_000, "the reply's links");
  await sleep(400);
  const link = () => evalIn(c, `__live.box(__live.link(${JSON.stringify(PAGE)}))`);
  check("the setting starts at Default browser", (await evalIn(c, `__live.st().linksOpenIn`)) === "default");

  /* ── 1. Default browser ─────────────────────────────────────────────────────────────────────── */
  let before = await evalIn(c, `__live.browsers()`);
  await click(c, await link());
  await until(async () => (await opened()).length > 0, 5000, "openExternal").catch(() => {});
  await sleep(500);
  check("Default: a click hands the link to the default browser", JSON.stringify(await opened()) === JSON.stringify([PAGE]), await opened());
  check("Default: …and opens no browser pane", (await evalIn(c, `__live.browsers()`)) === before);

  await click(c, await link(), { meta: true });
  const tabOpened = await until(async () => (await paneUrls()).includes(PAGE), 10_000, "a browser pane on the page").catch(() => false);
  check("Default: ⌘-click opens it in a Realm Browser tab instead", tabOpened === true && (await opened()).length === 1, { panes: await paneUrls(), opened: await opened() });
  const beside = await evalIn(c, `(() => { const st = __live.st(); const b = st.items.filter((i) => i.kind === 'browser').at(-1);
    return { browsers: __live.browsers(), sessionShown: !!document.querySelector('.session-pane'), browserPane: !!document.querySelector('.browser-pane, [data-kind="browser"]'), focusedIsBrowser: !!b && JSON.stringify(st.layout).includes(b.id) }; })()`);
  check("Default: …beside the session, which stays on screen", beside.browsers === before + 1 && beside.sessionShown && beside.focusedIsBrowser, beside);

  /* ── 3a. The right-click menu, Default first ─────────────────────────────────────────────────── */
  await click(c, await link(), { button: "right" });
  await until(() => inMain(m, `!!globalThis.__menu`), 5000, "the link menu");
  let labels = await inMain(m, `globalThis.__menu.filter((i) => i.label && !i.label.startsWith("Look Up")).map((i) => i.label)`);
  check("Menu (Default): both browsers, the default first, then Copy Link",
    JSON.stringify(labels.slice(0, 3)) === JSON.stringify(["Open Link in Default Browser", "Open Link in Realm Browser", "Copy Link"]), labels);
  await inMain(m, `(globalThis.__menu = null, true)`);
  await click(c, await evalIn(c, `__live.box(__live.link(${JSON.stringify(MAIL)}))`), { button: "right" });
  await until(() => inMain(m, `!!globalThis.__menu`), 5000, "the mail link menu");
  labels = await inMain(m, `globalThis.__menu.filter((i) => i.label && !i.label.startsWith("Look Up")).map((i) => i.label)`);
  check("Menu: a mail link gets no Realm Browser row", labels.includes("Open Link in Default Browser") && !labels.includes("Open Link in Realm Browser"), labels);
  await inMain(m, `(globalThis.__menu = null, true)`);

  /* ── 2. Realm Browser, chosen in Settings ───────────────────────────────────────────────────── */
  await evalIn(c, `(() => { __live.st().openSettingsPage("general"); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="open-links-in"]')`), 10_000, "the settings row");
  await sleep(400);
  const radio = await evalIn(c, `(() => { const l = [...document.querySelectorAll('[data-setting="open-links-in"] label')].find((x) => x.textContent.includes('Realm Browser')); return __live.box(l); })()`);
  await click(c, radio);
  await until(() => evalIn(c, `__live.st().linksOpenIn === 'realm'`), 5000, "the pick");
  await sleep(300);
  await shot(c, "dark");
  const stored = await api.call("settings.get", { key: "links.openIn" });
  check("Settings: the pick is stored", JSON.stringify(stored).includes("realm"), stored);
  await evalIn(c, `(() => { __live.st().closePageOverlay(); return true; })()`);
  await until(() => evalIn(c, `!!__live.link(${JSON.stringify(PAGE)})`), 10_000, "the transcript again");
  await sleep(400);

  before = await evalIn(c, `__live.browsers()`);
  await click(c, await link());
  const realmTab = await until(async () => (await evalIn(c, `__live.browsers()`)) === before + 1, 10_000, "a new Realm Browser tab").catch(() => false);
  await sleep(1500);
  const pages = (await paneUrls()).filter((u) => u === PAGE).length;
  check("Realm: a click opens a Realm Browser tab on the link", realmTab === true && pages === 2, { browsers: await evalIn(c, `__live.browsers()`), pagesOnLink: pages });
  check("Realm: …and nothing goes to the default browser", (await opened()).length === 1, await opened());

  await click(c, await link(), { meta: true });
  await until(async () => (await opened()).length === 2, 5000, "openExternal on ⌘").catch(() => {});
  check("Realm: ⌘-click hands it to the default browser", (await opened()).at(-1) === PAGE && (await evalIn(c, `__live.browsers()`)) === before + 1, await opened());

  /* ── 3b. The right-click menu, Realm first, and its row works ───────────────────────────────── */
  await click(c, await link(), { button: "right" });
  await until(() => inMain(m, `!!globalThis.__menu`), 5000, "the link menu (realm)");
  labels = await inMain(m, `globalThis.__menu.filter((i) => i.label && !i.label.startsWith("Look Up")).map((i) => i.label)`);
  check("Menu (Realm): Realm Browser first",
    JSON.stringify(labels.slice(0, 3)) === JSON.stringify(["Open Link in Realm Browser", "Open Link in Default Browser", "Copy Link"]), labels);
  before = await evalIn(c, `__live.browsers()`);
  await inMain(m, `(globalThis.__menu.find((i) => i.label === "Open Link in Realm Browser").click(), true)`);
  const fromMenu = await until(async () => (await evalIn(c, `__live.browsers()`)) === before + 1, 10_000, "a tab from the menu").catch(() => false);
  check("Menu: Open Link in Realm Browser opens a tab", fromMenu === true);

  /* ── The light face of the row ──────────────────────────────────────────────────────────────── */
  await evalIn(c, `(async () => { await __live.st().setThemePref("light"); __live.st().openSettingsPage("general"); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="open-links-in"]') && document.documentElement.dataset.mode === 'light'`), 10_000, "light settings");
  await sleep(600);
  await shot(c, "light");
  await evalIn(c, `(async () => { await __live.st().setThemePref("dark"); return true; })()`);
  c.close(); m.close();
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
  site?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(async () => { await teardown(); process.exit(process.exitCode ?? 0); });
