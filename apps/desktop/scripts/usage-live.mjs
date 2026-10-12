/**
 * Live check: Settings ▸ Usage, on a copy of a real home (run with: pnpm build && node apps/desktop/scripts/usage-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME seeded from `LIVE_SEED_DB` — a realm.db prepared from a
 * `VACUUM INTO` copy, with its folders pointed into the scratch dir and everything that could start a
 * process (terminals, schedules, MCP servers, goals) removed — and reads the page in the real window:
 *
 *   1. Plan limits lead the page: each reporting engine's windows are meters whose accessible value
 *      states the percent and the reset in words, never colour alone.
 *   2. The hero figures, the chart, the breakdown and the heaviest sessions all draw from the summary,
 *      and a heaviest-session row opens its session.
 *   3. Nothing in the page is wider than the page, at a normal width and at a narrow one.
 *   4. Both faces at both widths, captured to `LIVE_OUT` for a person to look at.
 *
 * Ports: LIVE_SERVER_PORT (8837), LIVE_CDP_PORT (9277). Touches only a scratch dir. Nothing is billed:
 * no message is sent to any session, and the server runs with the fake agent enabled.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9277);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8837);
const SEED = process.env.LIVE_SEED_DB;
const OUT_DIR = process.env.LIVE_OUT ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-usage-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
/** Set once the ports were found free and this script took them: teardown reaps by port only then,
 *  so a run that refused to start never kills whatever else was listening there. */
let ownsPorts = false;

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
    await sleep(200);
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
  async openUsage() {
    if (!document.querySelector(".settings-page-pane")) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
      const input = document.querySelector(".palette input");
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      for (let i = 0; i < 40; i++) {
        const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
        if (hit) { hit.click(); break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    }
    document.querySelector('.settings-rail input[value="usage"]')?.click();
    for (let i = 0; i < 200 && !document.querySelector(".usage-panel [data-usage-ready], .usage-panel .usage-tiles"); i++) await new Promise((r) => setTimeout(r, 50));
    return !!document.querySelector(".usage-panel [data-usage-ready], .usage-panel .usage-tiles");
  },
  overflow() {
    const page = document.querySelector(".settings-page-pane .page-body") ?? document.querySelector(".usage-panel");
    const limit = page.getBoundingClientRect().right + 1;
    return [...document.querySelectorAll(".usage-panel *")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > limit; })
      .slice(0, 5).map((el) => el.className && String(el.className).slice(0, 60));
  },
  scroller() {
    let el = document.querySelector(".usage-panel");
    while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    return el;
  },
};`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** The whole page, top to bottom: the window is made as tall as the page so one capture holds it. */
async function shootPage(c, tag, width) {
  const height = await evalIn(c, `(() => { const s = __live.scroller(); return s ? Math.ceil(s.scrollHeight + s.getBoundingClientRect().top + 40) : 1400; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width, height: Math.min(6000, Math.max(900, height)), deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const clip = await evalIn(c, `(() => { const r = document.querySelector(".settings-page-pane").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
  const file = path.join(OUT_DIR, `usage-${tag}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${file}`);
}

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  ownsPorts = true;
  if (!SEED || !fs.existsSync(SEED)) throw new Error("LIVE_SEED_DB must name a prepared realm.db");
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(SEED, path.join(home, "realm.db"));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 90_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  api = rpc(SERVER_PORT, await daemonToken(home, { timeoutMs: 60_000 }));
  await api.ready;
  return c;
}

async function theme(c, value) {
  await evalIn(c, `(() => { document.querySelector('.settings-rail input[value="appearance"]').click(); return true; })()`);
  await sleep(300);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-theme"][value="${value}"]').click(); return true; })()`);
  await sleep(300);
  await until(() => evalIn(c, `__live.openUsage()`), 30_000, "usage page");
  await sleep(800);
}

async function main() {
  const c = await boot();
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until(() => evalIn(c, `!!document.querySelector('.sidebar, .app-sidebar, aside')`), 60_000, "app shell");
  await until(() => evalIn(c, `__live.openUsage()`), 30_000, "usage page");
  await sleep(1000);

  const plan = await evalIn(c, `(() => [...document.querySelectorAll('.usage-panel [role=meter]')].map((m) => ({ label: m.getAttribute('aria-label'), text: m.getAttribute('aria-valuetext') })))()`);
  check("every meter states its value in words", plan.length > 0 && plan.every((m) => m.label && m.text), plan);
  const order = await evalIn(c, `(() => [...document.querySelectorAll('.usage-panel > * h2, .usage-panel > * h3')].map((h) => h.textContent.trim()).slice(0, 6))()`);
  console.log(`INFO headings ${JSON.stringify(order)}`);
  const hero = await evalIn(c, `(() => [...document.querySelectorAll('.usage-figure')].map((f) => f.textContent.replace(/\\s+/g, ' ').trim()))()`);
  console.log(`INFO figures ${JSON.stringify(hero)}`);

  for (const face of ["dark", "light"]) {
    await theme(c, face);
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    check(`${face}: nothing wider than the page at 1400`, (await evalIn(c, `__live.overflow()`)).length === 0, await evalIn(c, `__live.overflow()`));
    await shootPage(c, `${face}-wide`, 1400);
    await c.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    check(`${face}: nothing wider than the page at 760`, (await evalIn(c, `__live.overflow()`)).length === 0, await evalIn(c, `__live.overflow()`));
    await shootPage(c, `${face}-narrow`, 760);
  }

  // A heaviest-session row opens its session.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const opened = await evalIn(c, `(async () => {
    const row = document.querySelector('.usage-sessions [data-session-id]');
    if (!row) return { none: true };
    const id = row.getAttribute('data-session-id');
    row.click();
    for (let i = 0; i < 60 && document.querySelector('.settings-page-pane'); i++) await new Promise((r) => setTimeout(r, 50));
    return { id, pageGone: !document.querySelector('.settings-page-pane') };
  })()`);
  check("a heaviest-session row opens its session", opened.none || opened.pageGone, opened);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  if (ownsPorts) for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
