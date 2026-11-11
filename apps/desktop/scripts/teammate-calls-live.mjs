/**
 * Live check for a message to a teammate as the sender's transcript draws it (run with:
 * node apps/desktop/scripts/teammate-calls-live.mjs; `pnpm build` first).
 *
 * Boots the BUILT app on a scratch home with the scripted agent standing in for Claude, so nothing
 * reaches a real engine, in a window that cannot take focus. A Lead and two teammates are made over
 * RPC and the Lead is asked to ship search: it messages cto, who keeps working, and research, who
 * answers the Lead with team_message (repeating its own "From @research:") and goes idle. The Lead's
 * chat is then pictured, dark and light, to LIVE_OUT_DIR as `<LIVE_TAG>-lead-chat-<mode>.png`.
 * Ports: LIVE_SERVER_PORT (8831), LIVE_CDP_PORT (9261), LIVE_MAIN_INSPECT_PORT (9271). Stops its
 * daemon and kills only what it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8831);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9261);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9271);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(repoRoot, "../.verify/teammate-calls");
const TAG = process.env.LIVE_TAG ?? "after";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-calls-"));
const home = path.join(scratch, "home");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null, api = null;

const SLOW = "Reading how the docs folder is walked today. Every launch walks it again and tokenizes each file, which is where the time goes on a big space. ".repeat(12);

/** What the scripted agent says and does, by the words in the message it is handed. */
const SCRIPT = [
  { on: "Ship the new search", emit: [
    { kind: "text", text: "Splitting it between cto and research." },
    { kind: "call", tool: "realm-team__team_message", input: { to: "@cto", message: "From @lead: Move the docs index onto SQLite FTS5 and keep the query API as it is. Report the benchmark against the old index." } },
    { kind: "call", tool: "realm-team__team_message", input: { to: "research", message: "Which search engines do the other desktop apps in this space use? A line each is enough." } },
    { kind: "text", text: "Both have it. I'll come back with the numbers." },
  ] },
  { on: "Move the docs index", emit: [{ kind: "text", paceMs: 120, text: SLOW }] },
  { on: "Which search engines", emit: [
    { kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "From @research: Two of them use SQLite FTS5 and one uses Tantivy. None of them rebuild the index on launch." } },
    { kind: "text", text: "Sent the Lead the answer." },
  ] },
  { on: "Two of them use SQLite", emit: [{ kind: "text", text: "Noted: FTS5 is the common choice, so cto's plan matches." }] },
];

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(120);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
  });
  return {
    ready, errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    // Only a process this check started: its command line names this worktree's build or its scratch home.
    for (const pid of pids) {
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      const env = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (cmd.includes(repoRoot) || env.includes(home)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  } catch { /* nothing listening */ }
}

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  byLabel: (sel, label) => [...document.querySelectorAll(sel)].find((el) => (el.getAttribute("aria-label") ?? "").startsWith(label)),
  rect(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: `${HELPERS};\n${expr}`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

const setMode = (c, mode) => evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
/** A scratch window is never key, and an unkeyed window greys its accent; the pictures are of a window in use. */
const holdAwake = (c) => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
  if (!window.__awake) { window.__awake = new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")); window.__awake.observe(r, { attributes: true }); } return true; })()`);

/** A picture, dark and light. The scratch banner steps out of frame for the instant of the capture only.
 *  A capture holds the DOM's alpha and none of the window's material, so it is laid over the face's
 *  page colour first: unlaid, a viewer puts the dark face's translucent ground over white, and the
 *  whole window reads as veiled. */
async function shots(c, tag, clipJs) {
  for (const mode of ["dark", "light"]) {
    await setMode(c, mode);
    await sleep(350);
    const clip = clipJs ? await evalIn(c, clipJs) : null;
    await evalIn(c, `(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
    const shot = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    await evalIn(c, `(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
    const data = await evalIn(c, `(async () => {
      const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(shot.data)}; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, 0, 0);
      return cv.toDataURL("image/png").split(",")[1];
    })()`);
    const file = path.join(OUT_DIR, `${tag}-${mode}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SHOT ${file}`);
  }
  await setMode(c, "dark");
}

const mouse = (c, type, x, y) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
async function clickAt(c, r) { await mouse(c, "mouseMoved", r.cx, r.cy); await mouse(c, "mousePressed", r.cx, r.cy); await mouse(c, "mouseReleased", r.cx, r.cy); }

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scriptFile = path.join(scratch, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.3.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_LIVE_SCRATCH: "1",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()))[0], 20_000, "main inspector");
  const mainC = cdp(mainTarget.webSocketDebuggerUrl); await mainC.ready;
  await mainC.send("Runtime.evaluate", { includeCommandLineAPI: true, expression: `(() => { const { BrowserWindow } = require("electron"); const w = BrowserWindow.getAllWindows()[0]; w.setFocusable(false); w.setContentSize(1280, 820); w.showInactive(); return true; })()` });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])'); __live.setInput(input, "Realm"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdAwake(c);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  const spaceId = first.spaceId;

  const make = (input) => api.call("teammates.create", { spaceId, agentKind: "claude", ...input });
  const lead = await make({ name: "Lead", lead: true, icon: { shape: "circle", color: "graphite" }, brief: "You lead this team: route each ask to the teammate who fits." });
  const cto = await make({ name: "cto", handle: "cto", icon: { shape: "hexagon", color: "blue" }, brief: "You own the architecture, the data and performance." });
  const research = await make({ name: "research", handle: "research", icon: { shape: "cloud", color: "teal" }, brief: "You find things out and cite where." });

  await until(() => evalIn(c, `document.querySelectorAll('.sb-teammate').length === 3`), 15_000, "three teammate rows");
  await clickAt(c, await evalIn(c, `__live.rect(__live.byLabel('.sb-teammate .item-row', 'Lead'))`));
  await until(() => evalIn(c, `document.querySelector('.tm-head-name')?.textContent === 'Lead'`), 10_000, "the Lead's page");
  await api.call("teammates.message", { id: lead.id, text: "Ship the new search: the docs index is too slow on big spaces." });

  const state = async (id) => (await api.call("teammates.get", { id })).state;
  await until(async () => /Noted: FTS5/.test(await evalIn(c, `document.querySelector('.transcript')?.textContent ?? ''`)), 40_000, "the Lead's note on research's answer");
  await until(async () => (await state(research.id)) === "idle" && (await state(lead.id)) === "idle", 20_000, "research and the Lead settled");
  check("cto is still working", (await state(cto.id)) === "working");
  const rows = await evalIn(c, `[...document.querySelectorAll('.teammate-call')].map((r) => ({ state: r.dataset.state, label: r.querySelector('.tool-row').getAttribute('aria-label') }))`);
  console.log("ROWS", JSON.stringify(rows));
  if (TAG === "after") {
    check("the call to cto says Working, the one to research says Done", rows.length === 2 && rows[0].state === "working" && rows[1].state === "done", rows);
    const reply = await evalIn(c, `(() => { const r = document.querySelector('.msg-teammate-row'); return r && { head: r.querySelector('.msg-teammate-head').textContent, words: r.querySelector('.msg-assistant').textContent.trim() }; })()`);
    check("research's reply is under its name, with neither \"From @research:\"", reply?.head === "research" && reply.words.startsWith("Two of them"), reply);
  }
  await evalIn(c, `(() => { const t = document.querySelector('.transcript'); t.scrollTop = 0; return true; })()`);
  await sleep(500);
  await shots(c, `${TAG}-lead-chat`, `(() => { const r = document.querySelector('.transcript-col').getBoundingClientRect(); return { x: r.x - 24, y: Math.max(0, r.y - 16), width: r.width + 48, height: Math.min(r.height + 32, 640) }; })()`);
  if (TAG === "after") {
    await clickAt(c, await evalIn(c, `__live.rect(document.querySelector('.teammate-call .tool-row'))`));
    await until(() => evalIn(c, `document.querySelector('.tm-head-name')?.textContent === 'cto'`), 10_000, "cto's chat");
    check("a click on the call opens cto's chat", true);
  }
  const errs = c.errors.filter((e) => !/Autofill|ResizeObserver/.test(e));
  check("no renderer errors", errs.length === 0, errs.slice(0, 5));
  c.close(); mainC.close();
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(600);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
