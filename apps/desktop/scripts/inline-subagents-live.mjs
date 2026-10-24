/**
 * Live check for a session's sub-agents in its transcript (run with: pnpm build && node apps/desktop/scripts/inline-subagents-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for Claude. The
 * lead's script ("Restart the stalled agents") runs one blocking Task and starts two of the harness's
 * own background agents, then ends its turn while they work — the shape of the turn the owner
 * screenshotted. Checks, in the window:
 *
 *   1. Each launch is a sub-agent line in the transcript, not a generic tool card.
 *   2. After the turn has ended, the row over the prompter names all three — two working, one done —
 *      and nothing else does: no strip under the last message, no count in the session's bar.
 *   3. A click on a chip opens the session's Agents tab on that sub-agent's viewer.
 *   4. Once both background agents stop, every chip says done, and a chip opens the Agents tab again.
 *
 * Captured dark and light. Ports: LIVE_SERVER_PORT (8829), LIVE_CDP_PORT (9269). Screenshots go to
 * LIVE_OUT_DIR. Kills only what listens on its own ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9269);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8829);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-inline-subagents-live-"));
const home = path.join(scratch, "home");
const TITLE = "Release candidate";
const VIEWPORT = { width: 1560, height: 940 };
const OUT = (tag) => path.join(OUT_DIR, `inline-subagents-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** A button by its visible text inside `scope`. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Claude and Codex are the scripted agent here, so the onboarding session and every child
      // below run the script — nothing reaches a real engine or an account.
      REALM_FAKE_STANDS_IN: "claude,codex",
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });

  // A window the script opened behind someone's work is not key: Realm greys its accent and goes
  // quiet. Focus is emulated, and the inactive mark held off, so what is captured is the app awake.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // The probe the panes make on mount, asked for once here so its answer is cached: the stand-ins
  // report their catalogs (GPT-6 Luna on Codex).
  await api.call("agents.probe", { force: false });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", model: "claude-opus-5-5", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the lead alone, so every tab after this is one the check asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);


  // ── The turn: a blocking Task, two background agents, and the turn ends ────────────────────
  await api.call("sessions.send", { id: lead, text: "Restart the stalled agents.", attachments: [], mentions: [] });
  /** The row over the prompter: each chip's name and state. */
  const rowNow = () => evalIn(c, `[...document.querySelectorAll('.composer-overstrip .active-agent')].map((b) => ({ name: b.querySelector('.chip-label').textContent, state: b.dataset.state }))`);
  const states = async () => (await rowNow()).map((a) => a.state).sort().join(",");
  const clickChip = (name) => evalIn(c, `(() => { [...document.querySelectorAll('.composer-overstrip .active-agent')].find((b) => b.textContent.includes(${JSON.stringify(name)})).click(); return true; })()`);
  /** The lead's pane: its bar, the transcript down to its last line, and the row over the prompter. */
  const paneClip = () => evalIn(c, `(() => { const p = document.querySelector('.composer-dock').closest('.panel').getBoundingClientRect();
    return { x: p.left, y: p.top, width: p.width, height: p.height }; })()`);
  const leadStatus = async () => (await api.call("sessions.get", { id: lead }).catch(() => null))?.status ?? null;
  await until(async () => (await states()) === "done,working,working", 30_000, "row running").catch(async (e) => { note("row at timeout", await rowNow()); throw e; });
  await until(() => evalIn(c, `!document.querySelector('.msg-working')`), 15_000, "turn over");
  await sleep(1500);
  note("lead status after the turn", await leadStatus());

  const lines = await evalIn(c, `[...document.querySelectorAll('.transcript .delegation-line .tool-row')].map((b) => b.getAttribute('aria-label'))`);
  note("launch lines", lines);
  check("each launch is a sub-agent line", lines.length === 3 && lines.includes("Sub-agent working: Teams rule engine, general-purpose")
    && lines.includes("Sub-agent working: Realmite runner game, general-purpose") && lines.includes("Sub-agent finished: Check the policies page, Explore"), lines);
  check("no launch is left as a generic Agent card", await evalIn(c, `![...document.querySelectorAll('.transcript .tool-row')].some((b) => b.getAttribute('aria-label') === 'Agent tool call')`));
  const row = await rowNow();
  note("the row", row);
  check("the row names all three after the turn ended, two working and one done", row.length === 3
    && row.filter((r) => r.state === "working").length === 2 && row.some((r) => r.name === "Check the policies page" && r.state === "done"), row);
  check("nothing under the last message names them again", await evalIn(c, `!document.querySelector('.transcript [aria-label="Sub-agents"]')`));
  check("the session's bar names none of them", await evalIn(c, `![...document.querySelectorAll('.panel-bar')].some((b) => /working/.test(b.textContent) || b.querySelector('[aria-label*="working"]'))`));
  const geom = await evalIn(c, `(() => { const g = document.querySelector('.composer-overstrip .active-agents').getBoundingClientRect(), box = document.querySelector('.composer-input').getBoundingClientRect();
    return { rowTop: Math.round(g.top), rowBottom: Math.round(g.bottom), boxTop: Math.round(box.top), vh: innerHeight }; })()`);
  note("row geometry", geom);
  check("the row sits over the prompter, on screen", geom.rowBottom <= geom.boxTop && geom.rowTop >= 0, geom);
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(500);
    await shot(c, `1-row-running-${face}`, await paneClip());
  }
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);

  // ── A chip opens the Agents tab on its viewer ────────────────────────────────────────────────
  await clickChip("Teams rule engine");
  const lit = await until(() => evalIn(c, `document.querySelector('.subagent-view-title')?.textContent ?? null`), 10_000, "viewer").catch(() => null);
  check("a chip opens the Agents tab on that sub-agent's viewer", lit === "Teams rule engine", lit);
  const tabCards = await evalIn(c, `[...document.querySelectorAll('.subagent-switch-tab')].slice(1).map((t) => ({ task: t.textContent, state: t.dataset.state }))`);
  note("Agents tab switcher", tabCards);
  check("the Agents tab lists the lead's own background agents", tabCards.length === 3, tabCards);
  await shot(c, "2-agents-tab-focused-dark");
  await clickChip("Realmite runner game");
  await until(() => evalIn(c, `document.querySelector('.subagent-view-title')?.textContent === 'Realmite runner game'`), 10_000, "second viewer");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(400);
  await shot(c, "3-agents-tab-focused-light");
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  // Keyboard: the chips are buttons in the tab order, and Enter on one does what a click does.
  const keyboard = await evalIn(c, `(() => { const r = document.querySelector('.composer-overstrip .active-agent'); r.focus(); return document.activeElement === r && r.tagName === 'BUTTON'; })()`);
  check("a chip takes keyboard focus as a button", keyboard);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);

  // ── They finish: every chip says done ────────────────────────────────────────────────────────
  await until(async () => (await states()) === "done,done,done", 90_000, "row settled").catch(async (e) => { note("row at timeout", await rowNow()); throw e; });
  await sleep(600);
  const doneLines = await evalIn(c, `[...document.querySelectorAll('.transcript .delegation-line .tool-row')].map((b) => b.getAttribute('aria-label') + ' ' + (b.querySelector('.delegation-line-time')?.textContent ?? ''))`);
  note("launch lines once done", doneLines);
  check("the launch lines say finished, with how long", doneLines.filter((l) => l.startsWith("Sub-agent finished")).length === 3, doneLines);
  // Close the Agents tab's pane, so the click below has to bring it back.
  await evalIn(c, `(() => { document.querySelector('.pane-tab-close[aria-label="Close Agents"], .pane-tab-close[aria-label="Delete Agents"]')?.click(); return true; })()`);
  const closed = await until(() => evalIn(c, `!document.querySelector('.subagents')`), 5_000, "tab closed").then(() => true, () => false);
  check("the Agents tab is closed before a chip is clicked", closed);
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(500);
    await shot(c, `4-row-finished-${face}`, await paneClip());
  }
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  await clickChip("Teams rule engine");
  const back = await until(() => evalIn(c, `document.querySelector('.subagent-view-title')?.textContent ?? null`), 10_000, "tab back").catch(() => null);
  check("a finished agent's chip opens the Agents tab on it", back === "Teams rule engine", back);
  await sleep(500);
  await shot(c, "5-finished-agents-tab-dark");
}

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing and the PNG comes out see-through — measured: the sidebar at alpha 140. For the capture
 *  alone the root is painted with a ground that stands in for the material over a plain wallpaper,
 *  dark or light as the face is, and put back after. */
async function shot(c, tag, clip = null) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
