/**
 * Live check for Teams v2's screens (run with: node apps/desktop/scripts/teammates-ui-live.mjs; `pnpm build` first).
 *
 * Boots the BUILT app on a scratch home with the scripted agent standing in for Claude, so nothing
 * reaches a real engine, in a scratch window that cannot take focus. Four teammates are made over
 * RPC — a Lead, cto, and a design engineer and research in a group — and then the screens are driven
 * as a person would: cto's row opens its chat with its computer beside it, a message typed into its
 * prompter makes it start a task session, that session hands work to the design engineer with
 * `team_message`, and the design engineer starts a session of its own that waits on a permission. So
 * the sidebar's states, the nesting and the computer's list all come from the production paths.
 *
 * Checks what jsdom cannot: that the rows, the head and the computer are laid out as drawn, and the
 * pictures — dark and light — of the sidebar, a teammate's page, the New teammate sheet. Writes the
 * screenshots to LIVE_OUT_DIR (default .verify/nov02/teams-ui/shots) and keeps its home under
 * .verify/nov02/teams-ui/home. Ports: LIVE_SERVER_PORT (8792), LIVE_CDP_PORT (9232),
 * LIVE_MAIN_INSPECT_PORT (9242). Stops its daemon and kills only what it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const verify = path.resolve(repoRoot, "../.verify/nov02/teams-ui");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8792);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9232);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9242);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.join(verify, "shots");
const scratch = path.join(verify, "run");
const home = path.join(verify, "home");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null, api = null;

/** What the scripted agent says and does, by the words in the message it is handed. */
const SCRIPT = [
  { on: "move search to SQLite", emit: [
    { kind: "text", text: "I'm starting a session for the SQLite search." },
    { kind: "call", tool: "realm-agent__agent_start", input: { title: "cto - sqlite search", goal: "SQLITE_TASK Move search onto SQLite's FTS5 index and keep the old API." } },
    { kind: "text", text: "It's running now. I'll come back with the numbers once the tests pass." },
  ] },
  { on: "SQLITE_TASK", emit: [
    { kind: "call", tool: "realm-team__team_message", input: { to: "design-engineer", message: "ICON_HANDOFF The search box needs an icon for the new index. Can you draw one?" } },
    { kind: "text", paceMs: 1500, text: "Reading the current search path. The index is rebuilt on every launch, which is where the time goes. Moving it into SQLite with FTS5 and keeping the query API as it is. Running the search tests next, then the benchmark against the old index." },
  ] },
  { on: "ICON_HANDOFF", emit: [
    { kind: "text", text: "On it — starting a session for the icon." },
    { kind: "call", tool: "realm-agent__agent_start", input: { title: "search icon", goal: "ICON_TASK Draw the search icon in the house style." } },
  ] },
  { on: "Check in on the team", emit: [
    { kind: "text", text: "cto is moving search onto SQLite, and the design engineer is waiting on you to run the UI tests for the new icon. Nothing else is in flight." },
  ] },
  { on: "ICON_TASK", emit: [
    { kind: "tool", name: "Bash", input: { command: "pnpm --filter @realm/ui test" }, needsPermission: true, result: "ok" },
  ] },
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

/** A picture, dark and light. The scratch banner steps out of frame for the instant of the capture only. */
async function shots(c, tag, clipJs) {
  for (const mode of ["dark", "light"]) {
    await setMode(c, mode);
    await sleep(350);
    const clip = clipJs ? await evalIn(c, clipJs) : null;
    await evalIn(c, `(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
    const shot = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    await evalIn(c, `(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
    const file = path.join(OUT_DIR, `${tag}-${mode}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
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
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scriptFile = path.join(scratch, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Claude is the scripted agent: every session, teammates' included, runs the script above.
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
  await mainC.send("Runtime.evaluate", { includeCommandLineAPI: true, expression: `(() => { const { BrowserWindow } = require("electron"); BrowserWindow.getAllWindows()[0].setContentSize(1440, 900); BrowserWindow.getAllWindows()[0].showInactive(); return true; })()` });

  // First run: a space, and the onboarding session moved onto the scripted agent before anything is sent.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])'); __live.setInput(input, "Realm"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdAwake(c);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  const spaceId = first.spaceId;

  const brief = (line) => `${line}\nFor real work, start a session for the task and keep the chat for decisions.`;
  const make = (input) => api.call("teammates.create", { spaceId, agentKind: "claude", ...input });
  const lead = await make({ name: "Lead", lead: true, icon: { shape: "circle", color: "graphite" }, brief: brief("You lead this team: route each ask to the teammate who fits.") });
  const cto = await make({ name: "cto", handle: "cto", icon: { shape: "hexagon", color: "blue" }, brief: brief("You own the architecture, the data and performance.") });
  const design = await make({ name: "design engineer", handle: "design-engineer", group: "Strat", icon: { shape: "flower", color: "pink" }, brief: brief("You build and polish the interface.") });
  await make({ name: "research", group: "Strat", icon: { shape: "cloud", color: "teal" }, brief: brief("You find things out and cite where.") });

  // ── The sidebar: the Team list at the top of the space ──
  await until(() => evalIn(c, `document.querySelectorAll('.sb-teammate').length === 4`), 15_000, "four teammate rows");
  const order = await evalIn(c, `[...document.querySelectorAll('.sb-team .item-title')].map((t) => t.textContent)`);
  check("the Team list leads with the Lead, then the rest, then the group", JSON.stringify(order) === JSON.stringify(["Lead", "cto", "Strat", "design engineer", "research"]), order);
  const geo = await evalIn(c, `(() => {
    const rows = [...document.querySelectorAll('.sb-teammate')];
    const icon = rows.map((r) => __live.rect(r.querySelector('svg[data-shape]')));
    const name = rows.map((r) => __live.rect(r.querySelector('.item-title')));
    const session = __live.rect(document.querySelector('.sb-section-clip > .item-list > .sb-row:not(.sb-caption-row) .item-title'));
    return { icon, name, session, heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)) };
  })()`);
  check("each teammate's icon is drawn at 16px", geo.icon.every((r) => r && Math.round(r.w) === 16 && Math.round(r.h) === 16), geo.icon.map((r) => r && [r.w, r.h]));
  check("top-level teammates' names stand on the titles' column the sessions use", Math.abs(geo.name[0].x - geo.session.x) < 1 && Math.abs(geo.name[1].x - geo.session.x) < 1, { teammate: geo.name[0].x, session: geo.session.x });
  check("teammate rows are the sidebar's row height", geo.heights.every((h) => h === 32), geo.heights);

  // ── cto's page: its chat, headed by it, with its computer beside it ──
  await clickAt(c, await evalIn(c, `__live.rect(__live.byLabel('.sb-teammate .item-row', 'cto'))`));
  await until(() => evalIn(c, `!!document.querySelector('.tm-head') && !!document.querySelector('.tm-computer')`), 15_000, "cto's page and computer");
  const head = await evalIn(c, `(() => { const h = document.querySelector('.tm-head'); return { name: h.querySelector('.tm-head-name').textContent, role: h.querySelector('.tm-head-role')?.textContent ?? "", icon: __live.rect(h.querySelector('svg[data-shape]')), bar: __live.rect(h.closest('.panel-bar')) }; })()`);
  check("the bar names the teammate and what it does, beside its 24px icon", head.name === "cto" && head.role.startsWith("You own the architecture") && Math.round(head.icon.w) === 24, head);
  check("the icon sits inside the bar's height", head.icon.y >= head.bar.y && head.icon.y + head.icon.h <= head.bar.y + head.bar.h, { icon: head.icon, bar: head.bar });
  const placeholder = await evalIn(c, `document.querySelector('.composer textarea')?.getAttribute('placeholder') ?? document.querySelector('.composer [placeholder]')?.getAttribute('placeholder')`);
  check("the prompter asks for a message to it by name", placeholder === "Message cto", placeholder);
  const tabs = await evalIn(c, `[...document.querySelectorAll('.pane-tab')].map((t) => t.textContent.trim())`);
  check("its computer is a tab of its chat's side panel", tabs.some((t) => t.includes("Computer")), tabs);

  // A message typed into its prompter, as a person sends one.
  await evalIn(c, `(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); __live.setInput(ta, "Can we move search to SQLite? It's slow on big spaces."); return true; })()`);
  await evalIn(c, `(() => { const ta = document.querySelector('.composer textarea'); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(async () => (await api.call("teammates.sessions", { id: design.id })).length > 0, 40_000, "the hand-off's session");
  const ctoSessions = await api.call("teammates.sessions", { id: cto.id });
  check("cto started a task session, titled for the task", ctoSessions.some((s) => s.title === "cto - sqlite search"), ctoSessions.map((s) => s.title));
  await until(() => evalIn(c, `[...document.querySelectorAll('.tm-session-title')].length >= 2`), 20_000, "the computer's sessions");
  const listed = await evalIn(c, `[...document.querySelectorAll('.tm-session')].map((r) => ({ title: r.querySelector('.tm-session-title').textContent, depth: getComputedStyle(r.parentElement).getPropertyValue('--tm-depth').trim(), handoffs: r.querySelector('.tm-handoffs')?.textContent ?? null }))`);
  check("its computer lists what it started, with the hand-off nested under it and counted", listed[0]?.title === "cto - sqlite search" && listed[0]?.handoffs === "↳ 1" && listed[1]?.depth === "1", listed);
  await until(() => evalIn(c, `/needs you/.test(__live.byLabel('.sb-teammate .item-row', 'design engineer')?.getAttribute('aria-label') ?? '')`), 30_000, "design engineer needs you");
  check("a teammate whose session waits on you says so on its row", true);
  await sleep(600);
  await shots(c, "teammate-page");
  await shots(c, "sidebar", `(() => { const s = document.querySelector('.sidebar').getBoundingClientRect(); return { x: s.x, y: s.y, width: s.width, height: Math.min(s.height, 520) }; })()`);
  await shots(c, "computer", `(() => { const p = document.querySelector('.tm-computer').closest('.panel') ?? document.querySelector('.tm-computer'); const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 560) }; })()`);

  // The sidebar's disclosure: cto's sessions under its row.
  await clickAt(c, await evalIn(c, `__live.rect(document.querySelector('.sb-team-caret[aria-label="Show cto\\'s sessions"]'))`));
  await until(() => evalIn(c, `document.querySelectorAll('.sb-team-sessions .sb-row').length >= 1`), 5_000, "cto's sessions in the sidebar");
  const nested = await evalIn(c, `[...document.querySelectorAll('.sb-team-sessions .item-title')].map((t) => t.textContent)`);
  check("cto's row unfolds to its sessions", nested.includes("cto - sqlite search"), nested);
  const loose = await evalIn(c, `[...document.querySelectorAll('.sb-section-clip > .item-list > .sb-row:not(.sb-caption-row) .item-title')].map((t) => t.textContent)`);
  check("no teammate's chat or task is also loose in the session list", !loose.some((t) => /sqlite|search icon|^cto$|^Lead$/.test(t)), loose);
  await shots(c, "sidebar-open", `(() => { const s = document.querySelector('.sidebar').getBoundingClientRect(); return { x: s.x, y: s.y, width: s.width, height: Math.min(s.height, 560) }; })()`);

  // The design engineer's chat: a message cto's session sent, signed with cto.
  await clickAt(c, await evalIn(c, `__live.rect(__live.byLabel('.sb-teammate .item-row', 'design engineer'))`));
  await until(() => evalIn(c, `document.querySelector('.tm-head-name')?.textContent === 'design engineer'`), 10_000, "design engineer's page");
  await until(() => evalIn(c, `!!document.querySelector('.msg-user-teammate')`), 10_000, "a signed message");
  const signed = await evalIn(c, `document.querySelector('.msg-user-teammate').textContent`);
  check("a message from cto is signed with cto, not drawn as the person's", signed === "cto", signed);
  await shots(c, "handoff-chat");

  // ── The Lead's clock: a weekday check-in, fired now, writes into its chat as the clock ──
  const clocked = await api.call("teammates.update", { id: lead.id, schedule: { cron: "0 9 * * 1-5", prompt: "Check in on the team and tell me what is moving." } });
  check("a clock set through teammates.update comes back on the teammate", clocked.schedule?.cron === "0 9 * * 1-5" && clocked.schedule.enabled, clocked.schedule);
  await api.call("schedules.runNow", { id: clocked.schedule.id });
  await clickAt(c, await evalIn(c, `__live.rect(__live.byLabel('.sb-teammate .item-row', 'Lead'))`));
  await until(() => evalIn(c, `document.querySelector('.tm-head-name')?.textContent === 'Lead'`), 10_000, "the Lead's page");
  const stamp = await until(() => evalIn(c, `[...document.querySelectorAll('.msg-user-from')].map((e) => e.textContent).find((t) => t.startsWith('Scheduled · ')) ?? null`), 20_000, "the clock's turn");
  check("the clock's turn says it came from the schedule, and when", /^Scheduled · \w+ /.test(stamp), stamp);
  await until(() => evalIn(c, `/Nothing else is in flight/.test(document.querySelector('.transcript')?.textContent ?? '')`), 20_000, "the Lead's report");
  await shots(c, "clock-turn");

  // The Lead's Edit sheet, opened from its bar's menu, with the check-in it now has.
  await evalIn(c, `(() => { document.querySelector('.panel-bar button[aria-label^="Pane menu for"]').click(); return true; })()`);
  await until(() => evalIn(c, `!![...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.includes('Edit…'))`), 5_000, "the bar's menu");
  await evalIn(c, `(() => { [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.includes('Edit…')).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.tm-clock')`), 5_000, "the Edit sheet");
  const clockRows = await evalIn(c, `({ on: document.querySelector('.tm-clock input[role=switch]').checked, repeat: document.querySelector('.tm-clock select[aria-label=Repeat]')?.value, next: document.querySelector('.sched-modal-when')?.textContent })`);
  check("the Edit sheet opens on its check-in: weekdays, and when the next one is", clockRows.on && clockRows.repeat === "weekdays" && /^Next check-in /.test(clockRows.next ?? ""), clockRows);
  await evalIn(c, `(() => { document.querySelector('.sheet .sheet-body').scrollTop = 10000; return true; })()`);
  await sleep(300);
  await shots(c, "edit-teammate", `(() => { const r = document.querySelector('.sheet').getBoundingClientRect(); return { x: r.x - 24, y: r.y - 24, width: r.width + 48, height: r.height + 48 }; })()`);
  await evalIn(c, `(() => { document.querySelector('.sheet .sheet-head .icon-btn').click(); return true; })()`);
  await sleep(200);

  // ── New teammate ──
  await evalIn(c, `(() => { const add = document.querySelector('.sb-caption-row .item-act[aria-label="Add a teammate"]'); add.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.tm-sheet')`), 5_000, "the sheet");
  await evalIn(c, `(() => { [...document.querySelectorAll('.tm-start')].find((b) => b.textContent === 'TPM').click(); return true; })()`);
  await sleep(300);
  const sheet = await evalIn(c, `(() => { const s = document.querySelector('.sheet'); const r = s.getBoundingClientRect();
    const preview = __live.rect(s.querySelector('.tm-preview')); const shapes = s.querySelectorAll('.tm-shape').length; const colors = s.querySelectorAll('.tm-colors .swatch').length;
    const primary = s.querySelectorAll('.btn.primary').length; const over = s.scrollHeight - s.clientHeight;
    return { r: { x: r.x, y: r.y, w: r.width, h: r.height }, preview, shapes, colors, primary, name: s.querySelector('.space-name').value }; })()`);
  check("the sheet makes the icon from a 64px preview, 8 shapes and 12 colours, with one primary button", Math.round(sheet.preview.w) === 64 && sheet.shapes === 8 && sheet.colors === 12 && sheet.primary === 1, sheet);
  check("a quick start fills the name", sheet.name === "TPM", sheet.name);
  await shots(c, "new-teammate", `(() => { const r = document.querySelector('.sheet').getBoundingClientRect(); return { x: r.x - 24, y: r.y - 24, width: r.width + 48, height: r.height + 48 }; })()`);
  await evalIn(c, `(() => { document.querySelector('.sheet .sheet-head .icon-btn').click(); return true; })()`);

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
