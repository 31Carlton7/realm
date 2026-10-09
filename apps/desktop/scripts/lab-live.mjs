/**
 * Live check for the lab (Teams Phase 5). Run `pnpm build` first, then: node apps/desktop/scripts/lab-live.mjs
 *
 * Boots the REAL app on a scratch home with the scripted agent standing in for Claude (nothing is
 * billed), makes Versed a team with one role, and walks Settings ▸ Lab:
 *
 *   L1  the checklist reads THIS Mac with read-only probes, and shows admin fixes as commands only —
 *       nothing on the page runs one, and a development build offers no login-item switch;
 *   L2  devices: one added by hand for the team, an account added from the page, the team chosen;
 *   L3  the update window: lab mode on, an update reported ready (standing in for main's updater,
 *       which a development build never runs), Update now with a role's run working — the line says
 *       it is waiting, a second run stays queued, the window installs once it is quiet (main is told;
 *       the dev updater has nothing to install), and the app coming back on the new version lets the
 *       held run go;
 *   L4  reach: this Mac's name for the laptop's Machine pane;
 *   L5  every part in dark and light.
 *
 * It never changes this Mac: the probes only read, and it clicks neither the login-item switch nor
 * the keep-awake one. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8817 / 9257). Screenshots go to
 * LIVE_OUT. It touches only its own scratch home and kills only what holds its own two ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9257);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8817);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-lab-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-lab-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let liveC = null;

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
    await sleep(150);
  }
}

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
    else events.push(msg);
  });
  return { ws, ready, pending, events, next: () => ++id };
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
    events: s.events,
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
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  setValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return true;
  },
  check(id) { return document.querySelector('[data-check="' + id + '"]'); },
  head(text) { return [...document.querySelectorAll('h3.settings-head')].find((h) => h.textContent.trim() === text) ?? null; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag) {
  await sleep(900);
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

const SCRIPT = [
  { on: "take your time", emit: [{ kind: "text", text: "Laying out this week's slides one at a time, then checking every caption against the record before sending anything to Review.", paceMs: 450 }] },
  { on: "quick one", emit: [{ kind: "text", text: "Done." }] },
];

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
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
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory-fallback"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
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
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const openLab = `(async () => {
  if (!document.querySelector(".settings-page-pane")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
  }
  const tab = document.querySelector('input[name="settings-page-tab"][value="lab"]');
  if (!tab) return false;
  tab.click();
  return true;
})()`;

/** Scroll the page so a section's head is at the top of the column. */
const scrollTo = (head) => `(async () => { const h = __live.head(${JSON.stringify(head)}); if (!h) return false; h.scrollIntoView({ block: "start" }); await new Promise((r) => setTimeout(r, 300)); return true; })()`;

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space, space?.name);
  await api.call("team.make", { spaceId: space.id, templates: [] });
  const role = await api.call("team.roleCreate", { spaceId: space.id, name: "Content Producer", brief: "Make this week's slideshows.", realmite: { seed: "cp" }, agentKind: "fake" });
  const before = await api.call("settings.get", { key: "power.preventSleep" });

  /* ── L1: the checklist ── */
  await until(() => evalIn(c, openLab), 20_000, "settings ▸ lab");
  await until(() => evalIn(c, `__live.qa('.lab-check').length >= 11`), 40_000, "checks");
  const checks = await evalIn(c, `__live.qa('.lab-check').map((li) => ({ id: li.dataset.check, label: li.getAttribute('aria-label'), cmd: li.querySelector('.install-cmd code')?.textContent ?? null, buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim() || b.getAttribute('aria-label')), switches: [...li.querySelectorAll('[role=switch]')].map((s) => s.getAttribute('aria-label') ?? s.parentElement.textContent.trim()) }))`);
  console.log("CHECKS", JSON.stringify(checks.map((x) => x.label)));
  check("L1 every check of the plan is on the page", ["sleep", "power-failure", "filevault", "auto-login", "display", "disk", "network", "power-backup", "screen-sharing", "touch-id", "login-item"].every((id) => checks.some((x) => x.id === id)), checks.map((x) => x.id));
  const pm = execFileSync("/usr/bin/pmset", ["-g"], { encoding: "utf8" });
  const sleeps = !/^\s*sleep\s+0\b/m.test(pm) && !/SleepDisabled\s+1/.test(pm);
  const sleepRow = checks.find((x) => x.id === "sleep");
  check("L1 the sleep row agrees with pmset on this Mac", sleeps ? /Needs attention/.test(sleepRow.label) && sleepRow.cmd === "sudo pmset -a sleep 0 disksleep 0" : /Ready/.test(sleepRow.label), sleepRow);
  const fv = /FileVault is On/.test(execFileSync("/usr/bin/fdesetup", ["status"], { encoding: "utf8" }));
  check("L1 the FileVault row agrees with fdesetup", /Needs attention/.test(checks.find((x) => x.id === "filevault").label) === fv, checks.find((x) => x.id === "filevault"));
  check("L1 a laptop's restart-after-power-failure does not apply", /Doesn't apply/.test(checks.find((x) => x.id === "power-failure").label) || /autorestart/.test(pm), checks.find((x) => x.id === "power-failure"));
  const runners = checks.flatMap((x) => x.buttons).filter((b) => /pmset|sudo|Run|Fix|Turn on/.test(b));
  check("L1 no button runs an admin fix", runners.length === 0, runners);
  check("L1 a development build offers no login-item switch", checks.find((x) => x.id === "login-item").switches.length === 0, checks.find((x) => x.id === "login-item"));
  await evalIn(c, `(() => { document.querySelector('.settings-page-pane .page-scroll, .settings-page-pane [data-page-scroll]')?.scrollTo?.(0, 0); return true; })()`);
  await shot(c, "01-lab-ready-dark");
  await evalIn(c, `(async () => { __live.check('touch-id').scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 300)); return true; })()`);
  await shot(c, "01b-lab-ready-rest-dark");

  /* ── L2: devices ── */
  await api.call("lab.deviceAdd", { kind: "iphone", udid: "00008150-001A2B3C4D5E6F70", name: "Lab iPhone 1", spaceId: space.id,
    accounts: [{ service: "TikTok", handle: "@versed.nathan" }, { service: "Instagram", handle: "@versed.nathan" }] });
  await api.call("lab.deviceAdd", { kind: "iphone", udid: "00008150-001A2B3C4D5E6F71", name: "Lab iPhone 2", spaceId: null, accounts: [] });
  await until(() => evalIn(c, `__live.qa('.lab-device').length === 2`), 10_000, "devices listed");
  // From the page: give phone 2 to Versed, and an account.
  await evalIn(c, `__live.setValue(document.querySelector('select[aria-label="Team for Lab iPhone 2"]'), ${JSON.stringify(space.id)})`);
  await evalIn(c, `__live.setValue(document.querySelector('input[aria-label="Service for an account on Lab iPhone 2"]'), "TikTok")`);
  await evalIn(c, `__live.setValue(document.querySelector('input[aria-label="Handle for an account on Lab iPhone 2"]'), "@versed.mia")`);
  await evalIn(c, `__live.click([...document.querySelectorAll('.lab-device')].find((li) => /Lab iPhone 2/.test(li.getAttribute('aria-label'))).querySelector('.lab-account-add button[type=submit]'))`);
  const devs = await until(async () => {
    const d = await api.call("lab.devices", {});
    const p2 = d.devices.find((x) => x.name === "Lab iPhone 2");
    return p2?.spaceId === space.id && p2.accounts.length === 1 ? d : null;
  }, 10_000, "device 2 saved");
  check("L2 a device's team and account reach the registry", devs.devices.find((x) => x.name === "Lab iPhone 2").accounts[0].handle === "@versed.mia", devs.devices.map((d) => [d.name, d.spaceName, d.accounts.length]));
  const rows = execFileSync("sqlite3", [path.join(home, "realm.db"), "SELECT name, space_id IS NOT NULL, accounts_json FROM lab_devices ORDER BY created_at"], { encoding: "utf8" }).trim();
  check("L2 rows are in lab_devices (v48)", rows.split("\n").length === 2 && rows.includes("@versed.mia"), rows);
  const version = execFileSync("sqlite3", [path.join(home, "realm.db"), "SELECT MAX(version) FROM schema_version"], { encoding: "utf8" }).trim();
  check("L2 the scratch database is at v48", version === "48", version);
  await evalIn(c, scrollTo("Devices"));
  await shot(c, "03-lab-devices-dark");

  /* ── L3: the update window ── */
  await evalIn(c, `__live.click(document.querySelector('[role=switch][aria-label="This Mac is a lab"]'))`);
  await until(async () => (await api.call("lab.status", {})).enabled, 5_000, "lab on");
  const first = await api.call("team.roleRun", { id: role.id, message: "take your time" });
  await until(async () => (await api.call("team.roleRuns", { id: role.id, limit: 10 })).find((r) => r.id === first.id)?.state === "running", 15_000, "first run working");
  // What main's updater would report on a lab; a development build's updater is disabled.
  await api.call("lab.updateReady", { version: "9.9.9", from: "2.0.3" });
  await evalIn(c, scrollTo("Update window"));
  await until(() => evalIn(c, `/installs at/.test(__live.q('.lab-update-status')?.textContent ?? '')`), 5_000, "waiting line");
  const waitingLine = await evalIn(c, `__live.q('.lab-update-status .settings-row-desc').textContent`);
  check("L3 the line says when it installs", /^Realm v9\.9\.9 is ready\. It installs at 4:00 AM, once team runs have finished\.$/.test(waitingLine), waitingLine);
  await shot(c, "02a-lab-update-waiting-dark");
  await evalIn(c, `__live.click(__live.button('Update now'))`);
  await until(() => evalIn(c, `/Waiting for 1 run to finish/.test(__live.q('.lab-update-status')?.textContent ?? '')`), 5_000, "draining line");
  const second = await api.call("team.roleRun", { id: role.id, message: "quick one" });
  await sleep(1500);
  const held = (await api.call("team.roleRuns", { id: role.id, limit: 10 })).find((r) => r.id === second.id);
  check("L3 a run woken while the window is open stays queued", held?.state === "queued", held?.state);
  await shot(c, "02b-lab-update-draining-dark");
  await until(async () => (await api.call("team.roleRuns", { id: role.id, limit: 10 })).find((r) => r.id === first.id)?.state === "succeeded", 60_000, "first run done");
  // The window ticks every 15 s and installs after 10 s of quiet.
  await until(async () => (await api.call("lab.status", {})).update.kind === "installing", 45_000, "installing");
  check("L3 main was told to install", api.events.some((e) => e.event === "lab.install" && e.payload?.version === "9.9.9"), api.events.filter((e) => e.event?.startsWith("lab.")).map((e) => e.event));
  const stillHeld = (await api.call("team.roleRuns", { id: role.id, limit: 10 })).find((r) => r.id === second.id);
  check("L3 the held run is still queued while installing", stillHeld?.state === "queued", stillHeld?.state);
  await until(() => evalIn(c, `/Installing v9\\.9\\.9/.test(__live.q('.lab-update-status')?.textContent ?? '')`), 5_000, "installing line");
  await shot(c, "02c-lab-update-installing-dark");
  // The relaunched app says its version, as main does on every connect.
  await api.call("lab.appVersion", { version: "9.9.9" });
  await until(async () => (await api.call("team.roleRuns", { id: role.id, limit: 10 })).find((r) => r.id === second.id)?.state === "succeeded", 30_000, "held run ran");
  check("L3 the held run ran once the app was back", true);
  await until(() => evalIn(c, `/Updated to v9\\.9\\.9/.test(__live.q('.lab-update-status')?.textContent ?? '')`), 5_000, "resumed line");
  const resumedLine = await evalIn(c, `__live.q('.lab-update-status .settings-row-desc').textContent`);
  check("L3 the line says how it went", /^Updated to v9\.9\.9 at \d{1,2}:\d{2} [AP]M\. Team runs were held for \d+ minutes? and have started again\.$/.test(resumedLine), resumedLine);
  await shot(c, "02d-lab-update-resumed-dark");

  /* ── L4: reach ── */
  const host = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
  await evalIn(c, scrollTo("Reach this Mac"));
  const reach = await evalIn(c, `__live.q('.lab-reach')?.textContent ?? ''`);
  check("L4 the reach row names this Mac for the Machine pane", reach.includes(`${host}.local`) && /choose Another Mac/.test(reach), reach.slice(0, 160));
  await shot(c, "04-lab-reach-dark");

  /* ── L5: light ── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await until(() => evalIn(c, openLab), 20_000, "settings ▸ lab light");
  await until(() => evalIn(c, `__live.qa('.lab-check').length >= 11`), 40_000, "checks light");
  await shot(c, "01-lab-ready-light");
  await evalIn(c, `(async () => { __live.check('touch-id').scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 300)); return true; })()`);
  await shot(c, "01b-lab-ready-rest-light");
  await evalIn(c, scrollTo("Update window"));
  await shot(c, "02d-lab-update-resumed-light");
  await evalIn(c, scrollTo("Devices"));
  await shot(c, "03-lab-devices-light");
  await evalIn(c, scrollTo("Reach this Mac"));
  await shot(c, "04-lab-reach-light");

  const after = await api.call("settings.get", { key: "power.preventSleep" });
  check("nothing clicked Realm's keep-awake switch", JSON.stringify(after) === JSON.stringify(before), { before, after });
  check("this Mac's pmset is as it was", execFileSync("/usr/bin/pmset", ["-g"], { encoding: "utf8" }).replace(/\(.*\)/g, "") === pm.replace(/\(.*\)/g, ""));
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
    process.exit(process.exitCode ?? 0);
  });
