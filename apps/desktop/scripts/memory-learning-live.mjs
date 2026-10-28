/**
 * Live check for Realm learning from sessions (run with: pnpm build && node apps/desktop/scripts/memory-learning-live.mjs)
 *
 * The profile's Memory page draws the Learn from sessions switch, on, with the line saying what it
 * spends; switching it off writes the profile's setting, and the switch reads off again after a reload
 * and after the whole app is relaunched on the same home. Then the harness gate: under
 * REALM_ENABLE_FAKE_AGENT=1 a session on a real agent's name (the scripted agent standing in for
 * Claude) that talks twice and is archived is never read — no cursor row, no `[memory]` line in the
 * server's log, and no Claude transcript for this run in `~/.claude/projects`, which a model call
 * would have left. The built server is also read for the gate itself, first: the archive step is a
 * billed call if the gate is broken and the store's helpers are present, so it is not taken unless the
 * bundle carries the gate.
 *
 * Nothing is billed: every session runs the scripted agent (REALM_FAKE_STANDS_IN). Ports:
 * LIVE_SERVER_PORT / LIVE_CDP_PORT (8793 / 9233). Scratch under LIVE_SCRATCH (default: the OS temp
 * dir), screenshots under LIVE_SHOTS (default: the scratch's parent). Kills only what holds its own
 * two ports, and only if it is this run's.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8793);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9233);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1280, height: 820 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-memory-learning-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "memory-learning-shots");
const home = path.join(scratch, "home");
const startedAt = Date.now();
let electron = null;
let api = null;
const daemonPids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

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
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
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

const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1200, y: 780 });
/** Hold the window key: an unkeyed window greys its accent, and the live window opens behind. */
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);
const clickText = (sel, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`;
const SWITCH = 'input[role="switch"][aria-label="Learn from sessions"]';
const switchState = (c) => evalIn(c, `(() => { const s = document.querySelector('${SWITCH}'); return s ? { checked: s.checked, row: s.closest('.settings-row').textContent } : null; })()`);

/** Profile ▸ Profile settings… ▸ Memory, the way a person gets there. */
async function openProfileMemory(c) {
  await evalIn(c, `document.querySelector('.sb-profile').click(), true`);
  await until(() => evalIn(c, clickText('[role="menuitem"]', "Profile settings…")), 10_000, "Profile settings…");
  await until(() => evalIn(c, clickText(".page-rail .settings-tab", "Memory")), 10_000, "Memory section");
  await until(() => evalIn(c, `!!document.querySelector('${SWITCH}')`), 10_000, "the Learn from sessions switch");
  await park(c);
  await sleep(600);
}

async function setFace(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer') && document.documentElement.dataset.mode === '${mode}'`), 30_000, `the ${mode} face`);
  await holdKey(c);
}

/** The switch's group, as a person would see it: laid over the face's page colour first, since a
 *  capture holds the DOM's alpha and none of the window's material (design.md). */
async function shot(c, tag) {
  const sel = `.memory-page .settings-group:has(${SWITCH})`;
  await evalIn(c, `(() => { document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(500);
  const clip = await evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); const pad = 16;
    return { x: r.left - pad, y: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }; })()`);
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  const data = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(r.data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
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
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 2, mobile: false });
  await holdKey(c);
  return c;
}

async function dial() {
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const daemon = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  if (daemon.pid) daemonPids.push(daemon.pid);
}

/** Electron and its server down, the home kept: the next launch boots on the same `realm.db`. */
async function shutDown(c) {
  c.close();
  try { api?.close(); } catch { /* gone */ }
  api = null;
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home, daemonPids);
  for (const port of [SERVER_PORT, CDP_PORT]) killPort(port);
  await until(async () => (await portFree(SERVER_PORT)) && (await portFree(CDP_PORT)), 15_000, "ports released");
}

/** Transcript folders in `~/.claude/projects` touched during this run for a folder of this run's: a
 *  model call made from the server (whose cwd is this worktree) or in the scratch home leaves one.
 *  Matched exactly — peers' worktrees share this one's prefix, and their sessions write all the time. */
function claudeTranscriptsOfThisRun() {
  const dir = path.join(os.homedir(), ".claude", "projects");
  const encode = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => (n === encode(repoRoot) || n.startsWith(encode(scratch))) && fs.statSync(path.join(dir, n)).mtimeMs >= startedAt);
}

async function main() {
  // The gate is in the built server, not only in the source: the bundle main.js boots says so.
  const bundle = fs.readFileSync(path.join(repoRoot, "apps/server/dist/main.js"), "utf8");
  const gate = bundle.match(/function billedGenerators[\s\S]{0,600}/)?.[0] ?? "";
  const gated = /REALM_ENABLE_FAKE_AGENT\s*===\s*"1"\s*\?\s*\{\}\s*:/.test(gate) && gate.includes("memoryLearning");
  check("the built server wires memory learning only when REALM_ENABLE_FAKE_AGENT is not 1", gated, gate.slice(0, 160));
  if (!gated) throw new Error("the built server does not carry the gate — refusing to run a check that could make a billed call");

  let c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Billing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  await dial();
  // Belt and braces over the stand-ins: every session there is runs the scripted agent.
  for (const s of await api.call("sessions.listAll", { profileId: null })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  const [profile] = await api.call("profiles.list", {});
  const key = `memory.learning:${profile.id}`;

  // 1. The switch renders, on, and says what it spends — in both faces.
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    await openProfileMemory(c);
    const s = await switchState(c);
    check(`${mode}: the switch is drawn on a profile nobody has switched, and it is on`, s?.checked === true, s);
    check(`${mode}: its line says it uses the same frontier model as your sessions, on your account`,
      s?.row.includes("same frontier model as your sessions, on your account") && !/small model/i.test(s?.row ?? ""));
    await shot(c, `learn-from-sessions-on-${mode}`);
  }
  check("nothing is stored until the person switches", (await api.call("settings.get", { key })).value === null);

  // 2. Off: the profile's setting, read back by the server.
  await setFace(c, "dark");
  await openProfileMemory(c);
  await evalIn(c, `document.querySelector('${SWITCH}').click(), true`);
  await until(async () => (await api.call("settings.get", { key })).value === false, 10_000, "the setting written");
  check("switching off writes the profile's setting", (await api.call("settings.get", { key })).value === false);
  await shot(c, "learn-from-sessions-off-dark");

  // 3. …and it stays off: after a reload, and after the app is relaunched on the same home.
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "reloaded");
  await holdKey(c);
  await openProfileMemory(c);
  check("off after a reload", (await switchState(c))?.checked === false);
  await shutDown(c);
  c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 60_000, "relaunched");
  await dial();
  await openProfileMemory(c);
  check("off after the app is relaunched on the same home", (await switchState(c))?.checked === false);
  await evalIn(c, `document.querySelector('${SWITCH}').click(), true`);
  await until(async () => (await api.call("settings.get", { key })).value === true, 10_000, "back on");
  check("on again — so the next step is the harness gate and not the switch", (await switchState(c))?.checked === true);

  // 4. The harness gate. A session under a real agent's name, which the learner would read, talks
  //    twice and is archived: under REALM_ENABLE_FAKE_AGENT=1 nothing reads it.
  const spaceId = (await api.call("sessions.listAll", { profileId: null }))[0].spaceId;
  const { session, itemId } = await api.call("sessions.create", { spaceId, agentKind: "claude" });
  for (const text of ["Dana owns billing; ask her before changing invoices.", "Invoices go out on the 1st."]) {
    await api.call("sessions.send", { id: session.id, text });
    await until(async () => (await api.call("sessions.get", { id: session.id })).status === "idle", 20_000, "the turn ends");
  }
  await api.call("items.update", { id: itemId, archived: true });
  // Long enough for a pass to have asked the machine's probe (which waits on every agent) and the model.
  await sleep(40_000);
  const db = path.join(home, "realm.db");
  const sql = (q) => execFileSync("sqlite3", ["-readonly", db, q], { encoding: "utf8" }).trim();
  check("the cursor table exists (the migration ran on this home)", sql("SELECT name FROM sqlite_master WHERE name = 'memory_learned'") === "memory_learned");
  check("…and no session was read: no cursor row", sql("SELECT COUNT(*) FROM memory_learned") === "0");
  const log = fs.existsSync(path.join(home, "logs", "server.log")) ? fs.readFileSync(path.join(home, "logs", "server.log"), "utf8") : "";
  check("the server's log has no [memory] line", !log.includes("[memory]"), log.split("\n").filter((l) => l.includes("[memory]")).slice(0, 3));
  const strays = claudeTranscriptsOfThisRun();
  check("no Claude transcript appeared for this run — no model was called", strays.length === 0, strays);
  c.close();
}

/** Kill whatever still listens on one of this run's ports, but only if it is this run's. */
function killPort(port) {
  const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
    if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home, daemonPids);
  for (const port of [SERVER_PORT, CDP_PORT]) killPort(port);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.stack ?? e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
