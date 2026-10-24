/**
 * Live check for teammates (run with: pnpm build && node apps/desktop/scripts/teammates-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for Claude and Codex,
 * so nothing reaches a real engine or an account. In a session on a git checkout, it adds two teammates
 * from the prompter's "+" — one on the session's own model in its folder, one on GPT-6 Luna in a worktree
 * of its own — and watches the row above the prompter:
 *
 *   1. With no agents, the prompter has no row (what changed alone on its strip).
 *   2. "+" offers Add teammate…, whose picker carries the prompter's model chip, a line for the brief and,
 *      on a git checkout, where it works.
 *   3. Both teammates appear on the row: one working (the sidebar's ring), one needing you.
 *   4. Answered, both settle to done, and the row says so; a chip's tooltip names it, its model, its state
 *      and time; its menu stops, messages and dismisses; the `@` list names both.
 *   5. Crowded past three, the row names two and folds the rest into "+N", whose menu lists them.
 *   6. Stop on the lead's turn stops the lead and leaves the teammates the person added working.
 *
 * Captured dark and light, at a normal and a narrow width. Ports: LIVE_SERVER_PORT (8809), LIVE_CDP_PORT
 * (9249). Screenshots go to LIVE_OUT_DIR. Kills only what listens on its own ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9249);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8809);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-teammates-live-"));
const home = path.join(scratch, "home");
const TITLE = "Release 2.4";
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 720, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `teammates-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The children's turns. A teammate's message opens with its brief, so the brief is the trigger; the
 *  lead's own entry goes last, because every teammate's message carries the lead's conversation too. */
const SCRIPT = [
  // First: the lead's message carries the note naming its teammates, briefs and all.
  { on: "Keep planning", emit: [
    { kind: "text", paceMs: 400, text: "Going through the release checklist line by line: the migration, the parser, the docs, the flag, the version, the changelog, the release notes and the store listing, in that order." },
  ] },
  { on: "Write the parser tests", emit: [
    { kind: "text", paceMs: 450, text: "Reading the parser and the tests beside it first, then adding the cases nobody covered yet: empty input, a trailing comma, a nested list, a list that never closes, and the two error messages the parser prints for them." },
    { kind: "text", text: "Added six parser tests. All of them pass." },
  ] },
  { on: "Check the migration", emit: [
    { kind: "tool", name: "Bash", input: { command: "pnpm db:check --migration 0042" }, needsPermission: true, result: "0042 is reversible; 2 columns gain defaults." },
    { kind: "text", paceMs: 300, text: "The migration is reversible, and both new columns have defaults, so nothing reads a null." },
    { kind: "text", text: "Checked migration 0042: safe to ship." },
  ] },
  ...["Survey the docs", "Rename the flag", "Bump the version"].map((on) => ({ on, emit: [
    { kind: "text", paceMs: 600, text: "Working through it one file at a time, reading each before changing anything, and keeping a list of what is left to do as I go, then checking the list again before calling it done." },
    { kind: "text", text: "Done." },
  ] })),
  { on: "Plan the 2.4 release", emit: [{ kind: "text", text: "Here is the plan: land migration 0042, cover the parser, then cut the release candidate." }] },
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
    for (const pid of pids) {
      // Only ever this worktree's own processes: a port is a number, and a number can be reused.
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!cmd.includes(repoRoot) && !cmd.includes(scratch)) { note("left a process it did not start", { pid, cmd: cmd.slice(0, 120) }); continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* nothing listening */ }
}

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** The first element under `scope` whose text includes `text`, clicked. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`;
const rowNow = (c) => evalIn(c, `[...document.querySelectorAll('.composer-overstrip .active-agent')].map((b) => ({ name: b.textContent, state: b.dataset.state,
  ring: b.querySelector('.status-dot')?.dataset.status ?? null, title: b.getAttribute('title') }))`);

async function addTeammate(c, { brief, model, worktree, shots }) {
  await evalIn(c, `(() => { document.querySelector('.composer-attach').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.plus-menu')`), 5_000, "plus menu");
  if (shots) await shot(c, "2-plus-menu-dark", { pad: 360 });
  check("+ offers Add teammate…", await evalIn(c, clickText(".plus-menu [role=menuitem]", "Add teammate…")));
  await until(() => evalIn(c, `!!document.querySelector('.teammate-pop')`), 5_000, "picker");
  await sleep(400);
  if (model) {
    await evalIn(c, `(() => { document.querySelector('.teammate-pop .model-chip').click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.mp-row')`), 5_000, "model list");
    check(`the picker lists ${model}`, await evalIn(c, `(() => { const r = [...document.querySelectorAll('.mp-row')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(model)})); if (!r) return false; r.click(); return true; })()`));
    await sleep(300);
    await evalIn(c, `(() => { document.querySelector('.teammate-pop .model-chip').click(); return true; })()`);
    await until(() => evalIn(c, `!document.querySelector('.mp-row')`), 5_000, "model list closed");
  }
  await evalIn(c, fill(".teammate-pop input[type=text]", brief));
  if (worktree) check("a git checkout offers its own worktree", await evalIn(c, clickText(".teammate-pop .seg-opt", "Its own worktree")));
  await sleep(300);
  if (shots === true) {
    for (const face of ["dark", "light"]) {
      await mode(c, face);
      await shot(c, `3-picker-${face}`, { pad: 420 });
    }
    await mode(c, "dark");
  } else if (shots) await shot(c, shots, { pad: 420 });
  await evalIn(c, clickText(".teammate-pop button", "Add teammate"));
  await until(() => evalIn(c, `!document.querySelector('.teammate-pop')`), 10_000, "picker closed");
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
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
      // Claude and Codex are the scripted agent: the lead, the onboarding session and both teammates
      // run the script above, and nothing reaches a real engine or an account.
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_FAKE_SCRIPT: scriptFile,
      // Drawn in the page, where CDP can see and click them.
      REALM_HTML_MENUS: "1",
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...WIDE, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`;
  await evalIn(c, awake);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // A git checkout, so what changed has a pill and a teammate can have a worktree of its own.
  const git = (...args) => execFileSync("git", ["-c", "user.email=live@example.com", "-c", "user.name=live", "-c", "commit.gpgsign=false", ...args], { cwd: space.folderPath, encoding: "utf8" });
  git("init", "-b", "main");
  fs.writeFileSync(path.join(space.folderPath, "parser.ts"), "export const parse = (s: string) => s.split(',');\n");
  git("add", "."); git("commit", "-m", "init");
  // Something changed, so the what-changed pill heads the strip the row joins.
  fs.writeFileSync(path.join(space.folderPath, "parser.ts"), "export const parse = (s: string) => s.split(',').map((x) => x.trim());\n");
  await api.call("agents.probe", { force: false });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", model: "claude-opus-5-5", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // ── The lead has a conversation for its teammates to be handed ──────────────────────────────
  await api.call("sessions.send", { id: lead, text: "Plan the 2.4 release.", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: lead })).status === "idle" && await evalIn(c, `!!document.querySelector('.msg-assistant')`), 20_000, "lead replied");
  await until(() => evalIn(c, `!!document.querySelector('.composer-overstrip .what-changed')`), 20_000, "what-changed pill").catch(() => null);
  check("what changed heads the strip", await evalIn(c, `!!document.querySelector('.composer-overstrip .what-changed')`));
  await sleep(600);
  check("with no agents the prompter has no row", await evalIn(c, `document.querySelectorAll('.active-agents').length === 0`));
  await shot(c, "1-quiet-dark", { pad: 120 });

  // ── Two teammates from the "+" ──────────────────────────────────────────────────────────────
  await addTeammate(c, { brief: "Write the parser tests", shots: true });
  await addTeammate(c, { brief: "Check the migration", model: "GPT-6 Luna", worktree: true, shots: "3-picker-luna-worktree-dark" });
  const kids = await until(async () => { const r = await api.call("delegation.children", { sessionId: lead }); return r.children.length === 2 ? r.children : null; }, 15_000, "two children");
  const byTitle = Object.fromEntries(kids.map((k) => [k.session.title, k.session]));
  note("children", kids.map((k) => ({ title: k.session.title, kind: k.session.agentKind, model: k.session.model, mode: k.session.permissionMode, cwd: k.session.cwd, dispatchedBy: k.session.dispatchedBy })));
  const parser = byTitle["Write the parser tests"], migration = byTitle["Check the migration"];
  check("the first works in the lead's folder, on its model", parser && parser.cwd === session.cwd && parser.agentKind === "claude" && parser.model === "claude-opus-5-5", parser);
  check("the second runs on GPT-6 Luna in a worktree of its own", migration && migration.agentKind === "codex" && migration.model === "gpt-6-luna" && migration.cwd !== session.cwd, migration);
  const running = (await api.call("delegation.running", { sessionId: lead })).running;
  check("both are runs the lead's agent can wait on", running.length === 2 && running.every((r) => r.owned && r.detached), running);

  await until(async () => { const r = await rowNow(c); return r.length === 2 && r.some((x) => x.state === "waiting") && r.some((x) => x.state === "working"); }, 20_000, "row working");
  const working = await rowNow(c);
  note("row while working", working);
  check("the row leads with the one that needs you, ringed as the sidebar rings it", working[0]?.state === "waiting" && working[0]?.ring === "waiting_permission" && working[1]?.ring === "running", working);
  await capture(c, "4-row-working");

  // The tooltip: what a hover says.
  const at = await evalIn(c, `(() => { const r = document.querySelectorAll('.composer-overstrip .active-agent')[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await until(() => evalIn(c, `!!document.querySelector('.tooltip[data-open]')`), 5_000, "tooltip").catch(() => null);
  await sleep(300);
  const tip = await evalIn(c, `document.querySelector('.tooltip[data-open]')?.textContent ?? null`);
  check("a chip's tooltip names it, its model, where it stands and for how long", /^Write the parser tests · Claude · Opus 5\.5 · Working, \d+s/.test(tip ?? ""), tip);
  // Hovered again just before the capture: the tooltip is the app's own layer, and it is only in the
  // picture while it is up.
  for (let i = 0; i < 3; i++) {
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + 1 + i, y: at.y });
    if (await until(() => evalIn(c, `!!document.querySelector('.tooltip[data-open]')`), 2_000, "tooltip again").catch(() => false)) break;
  }
  note("tooltip box", await evalIn(c, `(() => { const t = document.querySelector('.tooltip'); if (!t) return null; const r = t.getBoundingClientRect(), d = document.querySelector('.composer-dock').getBoundingClientRect();
    return { open: t.hasAttribute('data-open'), side: t.dataset.side ?? null, opacity: getComputedStyle(t).opacity, visibility: getComputedStyle(t).visibility, top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), dockTop: Math.round(d.top) }; })()`));
  await shot(c, "5-tooltip-dark", { pad: 120 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 });

  // ── The one that needs you is answered; both finish ─────────────────────────────────────────
  const events = await api.call("sessions.events", { id: migration.id, afterSeq: 0, limit: 500 });
  const ask = (events.events ?? events).map((e) => e.event ?? e).find((e) => e.type === "permission_request");
  await api.call("sessions.respondPermission", { id: migration.id, requestId: ask.payload.requestId, decision: "allow" });
  await until(async () => (await rowNow(c)).every((x) => x.state === "done"), 60_000, "row done").catch(async (e) => { note("row at timeout", await rowNow(c)); throw e; });
  await sleep(500);
  const done = await rowNow(c);
  note("row once done", done);
  check("both settle to done, with no ring", done.length === 2 && done.every((x) => x.ring === null), done);
  await capture(c, "6-row-done");

  // ── The menu, the @ list, and a dismissal ──────────────────────────────────────────────────
  const m = await evalIn(c, `(() => { const b = document.querySelector('.composer-overstrip .active-agent'); const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 8, clientY: r.top + 4 })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.menu [role=menuitem]')`), 5_000, "chip menu");
  const items = await evalIn(c, `[...document.querySelectorAll('.menu [role=menuitem] .menu-label')].map((x) => x.textContent)`);
  check("a finished teammate's menu opens, messages and dismisses it — no Stop", m && JSON.stringify(items) === JSON.stringify(["Open in Agents tab", "Message", "Dismiss"]), items);
  await shot(c, "7-menu-dark", { pad: 220 });
  await evalIn(c, clickText(".menu [role=menuitem]", "Message"));
  await sleep(400);
  const draft = await evalIn(c, `document.querySelector('.composer textarea')?.value ?? null`);
  check("Message names it in the prompter", /^@\[(Check the migration|Write the parser tests)\] $/.test(draft ?? ""), draft);
  await evalIn(c, `(() => { const t = document.querySelector('.composer textarea'); t.focus(); return true; })()`);
  await evalIn(c, fill(".composer textarea", "@"));
  await evalIn(c, `(() => { const t = document.querySelector('.composer textarea'); t.setSelectionRange(1, 1); t.dispatchEvent(new Event('select', { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[role=listbox]')`), 5_000, "mention list").catch(() => null);
  await sleep(300);
  const listed = await evalIn(c, `[...document.querySelectorAll('[role=listbox] [role=option]')].map((o) => o.textContent).slice(0, 4)`);
  check("the @ list names both teammates first", listed.filter((x) => x.includes("Write the parser tests") || x.includes("Check the migration")).length === 2, listed);
  await shot(c, "8-mention-dark", { pad: 300 });
  await evalIn(c, fill(".composer textarea", ""));
  await sleep(200);
  await evalIn(c, `(() => { const b = document.querySelector('.composer-overstrip .active-agent'); const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 8, clientY: r.top + 4 })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.menu [role=menuitem]')`), 5_000, "chip menu again");
  await evalIn(c, clickText(".menu [role=menuitem]", "Dismiss"));
  await until(async () => (await rowNow(c)).length === 1, 5_000, "dismissed");
  check("dismiss takes it off the row and leaves the other", (await rowNow(c)).length === 1);
  const dismissed = (await api.call("delegation.children", { sessionId: lead })).dismissed;
  check("the server keeps the dismissal for every window", dismissed.length === 1, dismissed);
  await shot(c, "9-dismissed-dark", { pad: 120 });

  // ── Crowded: three more, by the same RPC the picker sends ──────────────────────────────────
  for (const brief of ["Survey the docs", "Rename the flag", "Bump the version"]) await api.call("delegation.addTeammate", { sessionId: lead, brief });
  await until(async () => (await rowNow(c)).length === 2 && await evalIn(c, `!!document.querySelector('.active-agents-more')`), 15_000, "crowded");
  const crowded = { named: (await rowNow(c)).map((x) => `${x.name} (${x.state})`), more: await evalIn(c, `document.querySelector('.active-agents-more').textContent`) };
  note("crowded row", crowded);
  check("past three the row names two and folds the rest into +N", crowded.named.length === 2 && crowded.more === "+2", crowded);
  await capture(c, "10-crowded");
  await evalIn(c, `(() => { document.querySelector('.active-agents-more').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.menu [role=menuitem]')`), 5_000, "more menu");
  const folded = await evalIn(c, `[...document.querySelectorAll('.menu [role=menuitem] .menu-label')].map((x) => x.textContent)`);
  check("+N opens a menu of the folded ones", folded.length === 2, folded);
  await shot(c, "11-more-menu-dark", { pad: 200 });
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);

  // ── Stop on the lead's turn: the lead stops, the person's teammates keep working ─────────────
  await api.call("sessions.send", { id: lead, text: "Keep planning.", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: lead })).status === "running", 15_000, "lead running");
  const workingBefore = (await rowNow(c)).filter((x) => x.state === "working").map((x) => x.name);
  await until(() => evalIn(c, `document.querySelector('.composer-send')?.dataset.state === 'stop'`), 10_000, "stop button");
  await evalIn(c, `(() => { document.querySelector('.composer-send').click(); return true; })()`);
  await until(async () => (await api.call("sessions.get", { id: lead })).status === "idle", 15_000, "lead stopped");
  await sleep(1500);
  const kidsAfter = (await api.call("delegation.children", { sessionId: lead })).children;
  const stillWorking = kidsAfter.filter((k) => k.session.status === "running").map((k) => k.session.title);
  note("after Stop", { workingBefore, stillWorking, row: (await rowNow(c)).map((x) => `${x.name} (${x.state})`) });
  check("Stop on the lead's turn leaves the person's teammates working", stillWorking.length >= 2 && (await rowNow(c)).every((x) => x.state === "working"), stillWorking);
  await capture(c, "12-after-stop");
}

async function mode(c, face) {
  await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
  await sleep(400);
}

/** The row in both faces at both widths. */
async function capture(c, tag) {
  for (const [w, size] of [["wide", WIDE], ["narrow", NARROW]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2, mobile: false });
    await sleep(600);
    const geom = await evalIn(c, `(() => { const s = document.querySelector('.composer-overstrip'), card = document.querySelector('.composer');
      if (!s) return null; const r = s.getBoundingClientRect(), k = card.getBoundingClientRect();
      const chips = [...s.querySelectorAll('.ghost-chip')].map((b) => { const q = b.getBoundingClientRect(); return { l: Math.round(q.left), r: Math.round(q.right), h: Math.round(q.height) }; });
      return { strip: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }, card: { l: Math.round(k.left), r: Math.round(k.right), t: Math.round(k.top) }, chips }; })()`);
    note(`${tag} ${w} geometry`, geom);
    check(`${tag} ${w}: every chip stays inside the strip, which tucks under the card`, geom && geom.chips.every((q) => q.l >= geom.strip.l && q.r <= geom.strip.r && q.h === 22) && geom.strip.b > geom.card.t, geom);
    for (const face of ["dark", "light"]) {
      await mode(c, face);
      await shot(c, `${tag}-${face}-${w}`, { pad: 120 });
    }
  }
  await mode(c, "dark");
  await c.send("Emulation.setDeviceMetricsOverride", { ...WIDE, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
}

/** The prompter and `pad` CSS pixels above it, the window's material stood in for by a plain ground
 *  (it is not in the DOM, so a capture would come out see-through). */
async function shot(c, tag, { pad }) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const box = await evalIn(c, `(() => { const d = document.querySelector('.composer-dock').getBoundingClientRect(); return { x: Math.max(0, d.left - 24), y: Math.max(0, d.top - ${pad}), w: Math.min(innerWidth, d.width + 48), h: Math.min(innerHeight, d.bottom + 16) - Math.max(0, d.top - ${pad}) }; })()`);
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
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
