/**
 * Live check for Scheduled tasks in Codex's layout (run with: node apps/desktop/scripts/scheduled-tasks-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js — run `pnpm build` first) on a scratch home with
 * the scripted agent, and walks the page end to end the way a person would:
 *
 *   1. the empty page — the column, and the place to start a task;
 *   2. a task made in the Schedule a task modal, its main model the scripted agent;
 *   3. Run now from the task's card, and the run read in the viewer: the real session pane, the
 *      instructions as its first message, the card docked beside it;
 *   4. a run fired on the scheduler's path while the page shows another one — unread until opened;
 *   5. the card's pencil, editing the task in the same modal;
 *   6. a task an agent schedules from a session, through realm-schedule and the gateway, landing in
 *      the same column as the one made by hand;
 *
 * and screenshots of each in dark, then the viewer, the modal and the empty page in light.
 *
 * Nothing here is ever sent to a real engine. Onboarding's session runs whatever this Mac is signed
 * in to, so nothing is typed there; every run is fired from a task whose main model is the scripted
 * agent, and the script checks that over RPC before the first one fires.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8794 / 9234). Screenshots go to LIVE_OUT. It touches only
 * its own scratch home, and kills only what holds its own two ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9234);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8794);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-scheduled-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(OUT_DIR, "run-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

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
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  /* React listens on its own value setter, so the native one is called first or the change arrives
     with the old value and nothing re-renders. */
  set(sel, value, root = document) {
    const el = typeof sel === "string" ? root.querySelector(sel) : sel;
    if (!el) throw new Error('no element: ' + sel);
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  byLabel(label, root = document) { return root.querySelector('[aria-label="' + label + '"]'); },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) {
    return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null;
  },
  dialog(name) { return document.querySelector('[role=dialog][aria-label="' + name + '"]'); },
  rect(el) { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; },
  taskRow(name) { return [...document.querySelectorAll('.sched-task')].find((t) => t.querySelector('.sched-task-name')?.textContent === name) ?? null; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag, clip) {
  const params = { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) };
  const r = await c.send("Page.captureScreenshot", params);
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      // The app's menus are native OS menus, which CDP cannot click; this asks for drawn ones.
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
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

/** Unkeyed and unfocused, a Mac window greys its accent and Realm goes quiet; the run is treated as
 *  the key window, and held so in case focus moves while it measures. Again after every reload. */
async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

/** The page over the panes, with the spaces sidebar folded away — what the page-registry flag will
 *  do for it once that lands; until then the check folds it by hand. */
async function openPage(c) {
  await evalIn(c, `(() => {
    const fold = [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Hide sidebar'));
    fold?.click();
    const page = [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => b.getAttribute('aria-label') === 'Scheduled tasks');
    if (page.getAttribute('aria-pressed') !== 'true') page.click();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.schedules-page .sched-col')`), 15_000, "schedules page");
  await sleep(700);
}

async function fillModal(c, { name, goal }) {
  await until(() => evalIn(c, `!!__live.dialog("Schedule a task")`), 10_000, "modal");
  await evalIn(c, `(() => { const d = __live.dialog("Schedule a task");
    __live.set(__live.byLabel("Task name", d), ${JSON.stringify(name)});
    __live.set(__live.byLabel("Instructions", d), ${JSON.stringify(goal)});
    __live.set(__live.byLabel("Repeat", d), "weekly");
    return true; })()`);
  await sleep(150);
  await evalIn(c, `(() => { const d = __live.dialog("Schedule a task");
    __live.set(__live.byLabel("Day", d), "5");
    __live.set(__live.byLabel("Time", d), "16:00");
    return true; })()`);
  await sleep(200);
}

const sheetClip = (c, name) => evalIn(c, `(() => { const r = __live.rect(__live.dialog(${JSON.stringify(name)})); return { x: r.x - 24, y: r.y - 24, width: r.width + 48, height: r.height + 48 }; })()`);

async function main() {
  const c = await boot();
  const space = (await api.call("spaces.list", {}))[0];
  await openPage(c);

  /* ── 1. The empty page ─────────────────────────────────────────────────────────────────────── */
  const empty = await evalIn(c, `(() => ({
    title: __live.q('.sched-col-title')?.textContent,
    heading: __live.q('.sched-empty-title')?.textContent,
    button: !!__live.button('New task', __live.q('.sched-main')),
    suggestions: [...document.querySelectorAll('.sched-suggestion-name')].map((n) => n.textContent),
    column: __live.rect(__live.q('.sched-col')),
  }))()`);
  check("the page opens on its own column and the place to start a task",
    empty.title === "Scheduled" && empty.heading === "Schedule a task" && empty.button && empty.suggestions.length === 3, empty);
  await shot(c, "01-empty-dark");

  /* ── 2. A task made in the modal ───────────────────────────────────────────────────────────── */
  const GOAL = "Draft this week's release notes from what merged to main. Plan the sections first, then have GPT-6 Luna write each one with sub-agents.\n\nKeep the draft in docs/release-notes.md.";
  await evalIn(c, `__live.click(__live.q('.sched-new'))`);
  await fillModal(c, { name: "Release notes", goal: GOAL });
  const top = await evalIn(c, `(() => { const d = __live.dialog("Schedule a task");
    return { create: !__live.button('Create', d), when: d.querySelector('.sched-modal-when')?.textContent }; })()`);
  check("the modal reads the first run back before anything is saved", /^First run /.test(top.when ?? ""), top);
  await shot(c, "02-modal-top-dark", await sheetClip(c, "Schedule a task"));
  await evalIn(c, `__live.click(__live.button('Advanced', __live.dialog("Schedule a task")))`);
  await until(() => evalIn(c, `!!__live.dialog("Schedule a task").querySelector('[aria-label="Model"] option[value="fake|fake"]')`), 45_000, "the scripted agent offered as a model");
  await evalIn(c, `(() => { const d = __live.dialog("Schedule a task");
    __live.set(__live.byLabel("Model", d), "fake|fake");
    __live.set(__live.byLabel("Effort", d), "medium");
    const body = d.querySelector('.sheet-body'); body.scrollTop = body.scrollHeight; return true; })()`);
  await sleep(400);
  await shot(c, "03-modal-advanced-dark", await sheetClip(c, "Schedule a task"));
  await evalIn(c, `__live.click(__live.button('Create', __live.dialog("Schedule a task")))`);
  await until(() => evalIn(c, `!__live.dialog("Schedule a task") && __live.q('.sched-empty-title')?.textContent === 'No runs yet'`), 15_000, "task created");
  const made = (await api.call("schedules.list", { spaceId: space.id })).find((s) => s.title === "Release notes");
  check("the modal wrote the task it showed: instructions verbatim, weekly at four, the scripted agent at medium",
    made && made.goal === GOAL && made.cron === "0 16 * * 5" && made.constraints?.agentKind === "fake" && made.constraints?.effort === "medium"
      && made.newSessionPerRun === true && made.archiveSucceeded === false, made);
  // Nothing fires from a task that would reach a real engine.
  if (made?.constraints?.agentKind !== "fake") throw new Error("the task is not on the scripted agent — refusing to fire it");
  await sleep(400);
  await shot(c, "04-task-no-runs-dark");

  /* ── 3. Run now, and the run read in the viewer ────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.byLabel("More for Release notes"))`);
  await until(() => evalIn(c, `!![...document.querySelectorAll('[role^=menuitem]')].find((m) => m.textContent.trim() === 'Run now')`), 5000, "menu");
  await evalIn(c, `__live.click([...document.querySelectorAll('[role^=menuitem]')].find((m) => m.textContent.trim() === 'Run now'))`);
  await until(() => evalIn(c, `!!__live.q('.sched-view .session-pane .msg-user')`), 30_000, "the run's session in the viewer");
  const firstRun = await until(async () => {
    const runs = (await api.call("runs.list", { spaceId: space.id, scheduleId: made.id })).runs;
    return runs.length === 1 && runs[0].state === "succeeded" ? runs[0] : null;
  }, 30_000, "the run settling");
  await until(() => evalIn(c, `[...document.querySelectorAll('.sched-view .msg-assistant, .sched-view .md')].length > 0`), 15_000, "the agent's reply");
  await sleep(800);
  const viewer = await evalIn(c, `(() => {
    const first = __live.q('.sched-view .msg-user');
    const card = __live.q('.sched-card'), session = __live.q('.sched-view-session'), composer = __live.q('.sched-view .composer');
    return {
      first: first?.innerText ?? null,
      cardWhen: card?.querySelector('.sched-card-when')?.textContent,
      model: [...card.querySelectorAll('.sched-card-fact')].map((f) => f.textContent).find((t) => t.includes('Fake')),
      card: __live.rect(card), session: __live.rect(session), composer: composer ? __live.rect(composer) : null,
      runRows: [...document.querySelectorAll('.sched-run')].length,
      activeRun: !!__live.q('.sched-run[data-active]'),
    };
  })()`);
  check("the run's first message is the task's instructions, as written", (viewer.first ?? "").startsWith(GOAL.split("\n")[0]), viewer.first?.slice(0, 160));
  check("the card says when and on what", viewer.cardWhen === "Fridays at 4:00 PM" && viewer.model === "Fake agent · Fake · Medium", viewer);
  check("the card is docked beside the run, never over it, and the prompter is under the run",
    viewer.card.x >= viewer.session.right && viewer.composer !== null && viewer.composer.right <= viewer.session.right, viewer);
  check("the run is listed under its task and lit as the one on screen", viewer.runRows === 1 && viewer.activeRun, viewer);
  await shot(c, "05-run-viewer-dark");

  /* ── 4. A run fired on the scheduler's path while another is on screen ─────────────────────── */
  const fired = await api.call("schedules.runNow", { id: made.id });
  await until(async () => (await api.call("runs.list", { spaceId: space.id, scheduleId: made.id })).runs.filter((r) => r.state === "succeeded").length === 2, 30_000, "second run");
  await until(() => evalIn(c, `[...document.querySelectorAll('.sched-run')].length === 2`), 15_000, "second run listed");
  const unread = await until(() => evalIn(c, `(() => {
    const rows = [...document.querySelectorAll('.sched-run')];
    const marked = rows.filter((r) => r.querySelector('.status-dot[data-status="unseen"]'));
    return marked.length === 1 ? { marked: marked.length, top: rows[0].querySelector('.status-dot[data-status="unseen"]') !== null } : null; })()`), 15_000, "the new run's unread mark");
  check("the run nobody has looked at wears the unread mark, the one on screen does not", unread.marked === 1 && unread.top, unread);
  const colClip = await evalIn(c, `(() => { const r = __live.rect(__live.q('.sched-col')); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 560) }; })()`);
  await shot(c, "06-unread-run-dark", colClip);
  await evalIn(c, `__live.click(document.querySelectorAll('.sched-run')[0])`);
  await until(() => evalIn(c, `!document.querySelector('.sched-run .status-dot[data-status="unseen"]')`), 15_000, "opening the run reads it");
  check("opening the run reads it", true, { run: fired.lastRunId });

  /* ── 5. The pencil edits the task in the same modal ────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.byLabel("Edit Release notes"))`);
  await until(() => evalIn(c, `!!__live.dialog("Edit task")`), 10_000, "edit modal");
  const editing = await evalIn(c, `(() => { const d = __live.dialog("Edit task");
    return { name: __live.byLabel("Task name", d).value, repeat: __live.byLabel("Repeat", d).value, day: __live.byLabel("Day", d).value, time: __live.byLabel("Time", d).value }; })()`);
  check("the edit opens on what the task holds", editing.name === "Release notes" && editing.repeat === "weekly" && editing.day === "5" && editing.time === "16:00", editing);
  await evalIn(c, `__live.set(__live.byLabel("Time", __live.dialog("Edit task")), "17:00")`);
  await sleep(200);
  await shot(c, "07-edit-dark", await sheetClip(c, "Edit task"));
  await evalIn(c, `__live.click(__live.button('Save', __live.dialog("Edit task")))`);
  await until(() => evalIn(c, `!__live.dialog("Edit task") && __live.q('.sched-card-when')?.textContent === 'Fridays at 5:00 PM'`), 10_000, "edit saved");
  check("the edit is on the card", true);

  /* ── 6. A task an agent schedules from a session ───────────────────────────────────────────── */
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Planning" });
  await api.call("sessions.send", { id: session.id, text: "Please schedule the weekly review for Fridays." });
  const viaTool = await until(async () => (await api.call("schedules.list", { spaceId: space.id })).find((s) => s.title === "Weekly review") ?? null, 20_000, "the tool's task");
  check("the tool wrote the same row the modal writes, on the asking session's agent",
    viaTool.cron === "0 16 * * 5" && viaTool.constraints?.agentKind === "fake" && viaTool.newSessionPerRun === true && viaTool.archiveSucceeded === false, viaTool);
  await until(() => evalIn(c, `!!__live.taskRow("Weekly review")`), 15_000, "the tool's task in the column");
  await evalIn(c, `__live.click(__live.taskRow("Weekly review").querySelector('.sched-task-hit'))`);
  await until(() => evalIn(c, `__live.q('.sched-card-name')?.textContent === 'Weekly review'`), 10_000, "the tool's task selected");
  const toolCard = await evalIn(c, `(() => ({ when: __live.q('.sched-card-when')?.textContent, line: __live.taskRow("Weekly review").querySelector('.sched-task-line').textContent }))()`);
  check("it reads like any other task", toolCard.when === "Fridays at 4:00 PM" && / · Weekly$/.test(toolCard.line), toolCard);
  await sleep(400);
  await shot(c, "08-tool-task-dark");

  /* ── Light ─────────────────────────────────────────────────────────────────────────────────── */
  // Set the way the Settings switch sets it and read back after a reload, so the capture is the
  // app's own light theme rather than an attribute flipped under a dark one. A fresh page is an empty one.
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await openPage(c);
  await shot(c, "09-empty-light");
  await evalIn(c, `__live.click(__live.taskRow("Release notes").querySelector('.sched-task-hit'))`);
  await until(() => evalIn(c, `!!__live.q('.sched-view .session-pane .msg-user')`), 15_000, "viewer in light");
  await sleep(900);
  await shot(c, "10-run-viewer-light");
  await evalIn(c, `__live.click(__live.q('.sched-new'))`);
  await fillModal(c, { name: "Morning brief", goal: "Give me a short start-of-day brief for this space's repository." });
  await shot(c, "11-modal-top-light", await sheetClip(c, "Schedule a task"));
  await evalIn(c, `__live.click(__live.button('Advanced', __live.dialog("Schedule a task")))`);
  await evalIn(c, `(() => { const b = __live.dialog("Schedule a task").querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; return true; })()`);
  await sleep(300);
  await shot(c, "12-modal-advanced-light", await sheetClip(c, "Schedule a task"));
  await evalIn(c, `__live.click(__live.button('Cancel', __live.dialog("Schedule a task")))`);
  c.close();
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    // The daemon is a second process that outlives the Electron this kills, holding the server port.
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    killPort(SERVER_PORT); killPort(CDP_PORT);
    process.exit(process.exitCode ?? 0);
  });
