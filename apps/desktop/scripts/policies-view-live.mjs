/**
 * Live check for the team's Policies page, dynamic Teams PR 3 (run with: pnpm build && node apps/desktop/scripts/policies-view-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch home with the scripted agent standing
 * in for every engine, so nothing is billed, and the stub stdio MCP server serving its four risk tools:
 *
 *   P1  team.policies over the wire classes them: read_thing reads (its server's label), save_thing can
 *       be undone, send_thing is unclassified and treated as can't be taken back, and send_quietly —
 *       labelled read-only by its server — reads as can't be taken back, because Realm reads "send";
 *   P2  the Policies row sits between Roles and Vault in the team column, and the page draws the four
 *       kinds of action with today's behaviour, Realm's tools as one connection and the stub as another;
 *   P3  the stub unfolds to its four tools, riskiest first, each saying who classed it;
 *   P4  nothing on the page writes: no switch, no field, no menu;
 *   P5  the page in dark and light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8825 / 9265), refused if taken and reaped by port.
 * Screenshots go to LIVE_OUT.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9265);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8825);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-policies-view-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-policies-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
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
function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(String(msg.id))?.(msg); });
  return { ws, ready, pending, next: () => ++id };
}
function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(String(i), (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}
function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button, [role=switch]')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  tab(text) { return [...document.querySelectorAll('.sb-page-nav label.settings-tab')].find((l) => l.textContent.trim().startsWith(text)) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
};
void 0`;
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: `${HELPERS};\n${expr}`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(c, tag) {
  await sleep(1100); // past the column's slide and a sheet's spring, so the frame is the surface at rest
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

/** The scripted agent never runs here: the page reads, and no role is started. */
const SCRIPT = [];

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.commandLine.appendSwitch("use-mock-keychain");', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude", REALM_FAKE_SCRIPT: scriptFile,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
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
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}


async function openPolicies(c) {
  if (!(await evalIn(c, `!!__live.tab('Policies')`))) {
    await evalIn(c, `__live.click(__live.named('^More for Versed$'))`);
    const row = `[...document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] button')].find((b) => b.textContent.trim() === 'Team')`;
    await until(() => evalIn(c, `!!${row}`), 5_000, "menu row Team");
    await evalIn(c, `__live.click(${row})`);
    await until(() => evalIn(c, `!!__live.tab('Policies')`), 8_000, "team column");
  }
  await evalIn(c, `__live.click(__live.tab('Policies'))`);
  await until(() => evalIn(c, `__live.text('.page-head h1') === 'Policies' && __live.qa('.tv-name').some((n) => n.textContent === 'stub')`), 20_000, "policies page");
}

const unfoldStub = (c) => evalIn(c, `(() => { const b = __live.qa('.tp-row-button').find((x) => x.querySelector('.tv-name')?.textContent === 'stub');
  if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);
const toTop = (c) => evalIn(c, `(() => { document.querySelector('.page-head').scrollIntoView({ block: 'start' }); return true; })()`);
const toStub = (c) => evalIn(c, `(() => { __live.qa('.tv-name').find((n) => n.textContent === 'stub').closest('li').scrollIntoView({ block: 'start' }); return true; })()`);

let liveC = null;
async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  await api.call("team.make", { spaceId: space.id, templates: ["creator-manager", "content-producer"], roles: [] });
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  const stub = await api.call("mcp.add", { spaceId: space.id, name: "stub", transport: "stdio", command: tsx,
    args: [path.join(repoRoot, "apps/server/src/mcp/fixtures/stub-stdio.ts")], env: { PATH: process.env.PATH ?? "", STUB_TOOLS: "risk" } });

  /* ── P1: the classes, over the wire ─────────────────────────────────────────────────────────── */
  const view = await api.call("team.policies", { spaceId: space.id });
  const s = view.connectors.find((x) => x.connector === `mcp:${stub.id}`);
  const got = Object.fromEntries((s?.tools ?? []).map((t) => [t.tool, `${t.class}/${t.source}/${t.floor ?? "-"}`]));
  check("P1 the stub's four tools are classed by label and by name", JSON.stringify(got) === JSON.stringify({
    read_thing: "read/server/-", save_thing: "reversible-external/server/-", send_thing: "irreversible-external/unclassified/-", send_quietly: "irreversible-external/server/send",
  }), got);
  check("P1 every Realm tool is classed by Realm", view.connectors.filter((x) => x.kind === "realm").every((x) => x.tools.every((t) => t.source === "realm")), view.connectors.filter((x) => x.kind === "realm").map((x) => x.name));

  /* ── P2–P4: the page, dark ──────────────────────────────────────────────────────────────────── */
  await openPolicies(c);
  const rail = await evalIn(c, `__live.qa('.sb-page-nav label.settings-tab').map((l) => l.textContent.trim().replace(/\\d+$/, ''))`);
  const ri = rail.indexOf("Policies");
  check("P2 Policies sits between Roles and Vault", ri > 0 && rail[ri - 1].startsWith("Roles") && rail[ri + 1] === "Vault", rail);
  const classes = await evalIn(c, `__live.qa('li[data-class]:not(.tpol-tool)').map((li) => [li.querySelector('.settings-row-name').textContent, li.querySelector('.tpol-value').textContent])`);
  check("P2 four kinds of action, each with today's behaviour", classes.length === 4 && classes.every(([, v]) => v.length > 0), classes);
  const conns = await evalIn(c, `__live.qa('.tv-name').map((n) => n.textContent)`);
  check("P2 Realm's tools are one connection, before the stub", conns[0] === "Realm" && conns.includes("stub") && !conns.includes("Documents"), conns);
  await toTop(c);
  await shot(c, "01-policies-dark");
  await unfoldStub(c);
  const tools = await evalIn(c, `__live.qa('.tpol-tool').map((li) => [li.querySelector('.settings-row-name').textContent, li.querySelector('.settings-row-detail').textContent, li.querySelector('.tpol-value').textContent])`);
  check("P3 the stub unfolds riskiest first, each saying who classed it", JSON.stringify(tools.map((t) => t[0])) === JSON.stringify(["send quietly", "send thing", "save thing", "read thing"])
    && /Realm reads “send”/.test(tools[0][1]) && /No label/.test(tools[1][1]) && tools[3][2] === "Reads", tools);
  check("P4 nothing on the page writes", await evalIn(c, `(() => { const f = document.querySelector('.form'); return f.querySelectorAll('input, select, textarea, [role=switch], [role=combobox]').length === 0; })()`), null);
  await toStub(c);
  await shot(c, "02-policies-stub-dark");

  /* ── P5: light ──────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await until(() => evalIn(c, `!!__live.named('^More for Versed$') || !!__live.tab('Policies')`), 15_000, "sidebar in light");
  await openPolicies(c);
  await toTop(c);
  await shot(c, "03-policies-light");
  await unfoldStub(c);
  await toStub(c);
  await shot(c, "04-policies-stub-light");
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { console.log("ALERTS", JSON.stringify(await evalIn(liveC, `[...document.querySelectorAll('[role=alert], .toast, [class*=toast]')].map((t) => t.textContent)`))); await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    killPort(SERVER_PORT); killPort(CDP_PORT);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
