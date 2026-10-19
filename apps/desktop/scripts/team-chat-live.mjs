/**
 * Live check for the team as a messenger (run with: node apps/desktop/scripts/team-chat-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js — run `pnpm build` first) on a scratch home with the
 * scripted agent standing in for every role, so nothing is billed, seeds a team whose roles have talked,
 * and walks the chats:
 *
 *   C1  the team opens on its chats: a row per teammate with its Realmite, newest line, time and state —
 *       working, needs you, unread;
 *   C2  Researcher's thread: the person's messages on the right, its reports on the left as Markdown, the
 *       draft it sent with Approve / Send back / Open in Review, a day head, grouped bubbles;
 *   C3  a message typed into the chat's prompter and sent with Return starts a run that continues the
 *       same session, and its answer lands in the thread;
 *   C4  Creator Manager's thread: the handoff it took, the record it kept, its draft; Ops' question card,
 *       answered from the prompter; Ava's run by the clock and its stop at the dollar limit;
 *   C5  a working teammate: the typing dots, in the list and the thread, and still under Reduce motion;
 *   C6  the whole run under a report, drawn by the transcript; the details drawer;
 *   C7  ↑/↓ move between chats; Approve on a draft card approves it;
 *   C8  a team with nobody on it;
 *   C9  dark, then light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8808 / 9248). Screenshots go to LIVE_OUT. It touches only its
 * own scratch home (a fresh temp dir), and kills only what holds its own two ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9248);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8808);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-team-chat-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-team-chat-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let liveC = null;

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
    for (const pid of pids) {
      // Only what this worktree started: the command line names it.
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!cmd.includes(repoRoot) && !cmd.includes(scratch)) { console.log(`SKIP pid ${pid} on :${port} is not ours`); continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  set(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  chat(name) { return [...document.querySelectorAll('.sb-page-nav .tc-chat-row')].find((l) => l.querySelector('.tc-chat-name')?.textContent === name) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag) {
  await ground(c);
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
  await evalIn(c, `(() => { const hide = () => document.getElementById('live-scratch-banner')?.remove(); hide();
    new MutationObserver(hide).observe(document.body, { childList: true }); return true; })()`);
  await ground(c);
}

/** A capture has no window material behind the translucent chrome, and what it composites the chrome
 *  over drifts while the window is hidden (the same DOM came out dark in one capture and washed grey in
 *  the next). Every capture stands a plain ground of its mode's own in for the material. */
async function ground(c) {
  const light = await evalIn(c, `document.documentElement.dataset.mode === 'light'`);
  await c.send("Emulation.setDefaultBackgroundColorOverride", { color: light ? { r: 236, g: 236, b: 238, a: 1 } : { r: 28, g: 28, b: 30, a: 1 } });
}

/** A solid-colour PNG, so the fixture slides are files of our own and nothing is copied from a real home. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

/* ── the scripted agent ─────────────────────────────────────────────────────────────────────────── */

const SLIDES = [1, 2, 3].map((n) => `content/slides/nathan/0${n}.png`);
const SLOW = "Laying out next week's six slideshows for Nathan: the hook for each, then the order of slides, then the captions, one at a time so they read as a set and not as six separate posts that happen to share a creator and a week";
const SCRIPT = [
  { on: "find three sources on the spring launch", emit: [
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "report", title: "Spring launch: three sources", items: [{ files: ["research/spring-launch.md"], body: "Three sources on the spring launch, with what each one rests on." }] } },
    { kind: "usage", costUsd: 0.38 },
    { kind: "text", text: "Found three solid sources on the spring launch:\n\n1. **The launch post** — dates, pricing and the two new plans.\n2. **The changelog** — what actually shipped, line by line.\n3. **A review from The Verge** — the first outside read, mostly positive on pricing.\n\nThe brief is in Review for your yes." },
  ] },
  { on: "which one is strongest", emit: [
    { kind: "text", text: "The changelog. It is the one primary source of the three — the post is marketing and the review is somebody else's read of the post." },
  ] },
  { on: "a fourth source", emit: [
    { kind: "text", text: "A fourth: the pricing page's archived copy from March, which shows the old plans side by side with the new ones." },
  ] },
  { on: "make Nathan's slides and hand them over", emit: [
    { kind: "usage", costUsd: 0.84 },
    { kind: "call", tool: "realm-team__team_handoff", input: { to: "Creator Manager", record: "nathan-beyenhof", files: SLIDES,
      note: "Three slideshows for Nathan are in content/slides/nathan. Draft his weekly check-in around them." } },
    { kind: "text", text: "Made three slideshows and handed them to Creator Manager for Nathan's check-in." },
  ] },
  { on: "handed you work", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deadlines", entry: "Weekly check-in · due Thursday" } },
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "message", title: "Weekly check-in to Nathan", record: "nathan-beyenhof",
      items: [{ files: [SLIDES[0]], body: "Hi Nathan — three new slideshows are ready for you. Could you post two by Thursday?", target: { channel: "Email" } }] } },
    { kind: "usage", costUsd: 0.31 },
    { kind: "text", text: "Drafted Nathan's check-in around the slides and sent it to Review. I noted Thursday's deadline on his record." },
  ] },
  { on: "keep Nathan's record", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nathan Beyenhof" } },
    { kind: "text", text: "Made Nathan's record." },
  ] },
  { on: "scheduled run. Do what", emit: [
    { kind: "usage", costUsd: 0.12 },
    { kind: "text", text: "Read the two drafts waiting in Review. Both are clean; one note on the check-in: \"two by Thursday\" could read as two slideshows or two posts." },
  ] },
  { on: "pull every number", emit: [
    { kind: "usage", costUsd: 4.2 },
    { kind: "text", text: "Pulling every week of numbers I can find, one dashboard after another", paceMs: 200 },
  ] },
  { on: "Go with the March ones", emit: [{ kind: "text", text: "Paid the March invoices first; April's two wait until the 30th." }] },
  { on: "sort out the invoices", emit: [
    { kind: "text", text: "Four invoices are open: two from March and two from April.\n\nNEEDS-HUMAN: Should I draft the March ones first, or all four at once?" },
  ] },
  { on: "next week's slides", emit: [{ kind: "text", text: SLOW, paceMs: 900 }] },
];

/* ── boot ───────────────────────────────────────────────────────────────────────────────────────── */

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
      REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_STANDS_IN: "claude", REALM_FAKE_SCRIPT: scriptFile, REALM_LIVE_SCRATCH: "1",
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory-fallback"),
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

const runsOf = async (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);
const teamOf = (spaceId) => api.call("team.space", { spaceId });
const quiet = (roleId, ms = 30_000) => until(async () => (await runsOf(roleId)).every(settled), ms, `settle ${roleId}`);

async function openTeam(c, spaceName) {
  await evalIn(c, `__live.click(__live.named('^More for ${spaceName}$'))`);
  const row = `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((b) => /^(Team|Make this a team…)$/.test(b.textContent.trim()))`;
  await until(() => evalIn(c, `!!${row}`), 5_000, "menu row Team");
  await evalIn(c, `__live.click(${row})`);
  await until(() => evalIn(c, `!!__live.q('.sb-page-nav .page-rail')`), 8_000, "team page");
}

async function toChat(c, name) {
  await until(() => evalIn(c, `!!__live.chat(${JSON.stringify(name)})`), 8_000, `chat row ${name}`);
  await evalIn(c, `__live.click(__live.chat(${JSON.stringify(name)}).querySelector('input'))`);
  await until(() => evalIn(c, `__live.text('.tc-head-name') === ${JSON.stringify(name)}`), 8_000, `chat ${name}`);
  await until(() => evalIn(c, `!__live.q('.tc-loading')`), 8_000, `thread ${name}`);
  await sleep(400);
}

async function backToSpaces(c) {
  await evalIn(c, `__live.q('.sb-page-back') && __live.click(__live.q('.sb-page-back'))`).catch(() => {});
  await until(() => evalIn(c, `!!__live.named('^More for Versed$')`), 10_000, "spaces");
}

/** Where the person's bubbles and the teammate's stand in the column: right edge and left edge. */
const sides = (c) => evalIn(c, `(() => {
  const col = __live.q('.tc-col').getBoundingClientRect();
  const of = (side) => __live.qa('.tc-row[data-side="' + side + '"] .tc-bubble').map((b) => b.getBoundingClientRect());
  return { colLeft: col.left, colRight: col.right, you: of('you').map((r) => Math.round(r.right)), them: of('them').map((r) => Math.round(r.left)) };
})()`);

async function surfaces(c, mode, ids) {
  await openTeam(c, "Versed");
  await shot(c, `01-chats-${mode}`);
  await toChat(c, "Researcher");
  await shot(c, `02-thread-researcher-${mode}`);
  await toChat(c, "Creator Manager");
  await shot(c, `03-thread-handoff-${mode}`);
  await toChat(c, "Ops");
  await shot(c, `04-thread-ask-${mode}`);
  await toChat(c, "Ava");
  await shot(c, `05-thread-schedule-cap-${mode}`);
  await toChat(c, "Researcher");
  await evalIn(c, `__live.click(__live.named('^Researcher, in detail$'))`);
  await until(() => evalIn(c, `!!__live.q('.tc-drawer .tc-who')`), 5_000, "drawer");
  await shot(c, `06-drawer-${mode}`);
  await evalIn(c, `__live.click(__live.named('^Close the details$'))`);
  await sleep(500);
  await backToSpaces(c);
  await openTeam(c, "Studio");
  await until(() => evalIn(c, `!!__live.q('.tc-empty-team')`), 8_000, "empty team");
  await shot(c, `08-empty-team-${mode}`);
  await backToSpaces(c);
  void ids;
}

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  fs.mkdirSync(path.join(space.folderPath, "content/slides/nathan"), { recursive: true });
  fs.mkdirSync(path.join(space.folderPath, "research"), { recursive: true });
  SLIDES.forEach((f, i) => fs.writeFileSync(path.join(space.folderPath, f), png(90, 160, [[214, 120, 90], [96, 140, 210], [120, 180, 120]][i])));
  fs.writeFileSync(path.join(space.folderPath, "research/spring-launch.md"), "# Spring launch\n\n1. The launch post\n2. The changelog\n3. The Verge's review\n");

  /* ── the team: five starters, every one on the scripted agent ── */
  let team = await api.call("team.make", { spaceId: space.id, templates: ["researcher", "editor", "content-producer", "creator-manager", "ops"], weekBudgetUsd: 80 });
  const role = (name) => team.roles.find((r) => r.name === name);
  const ids = { researcher: role("Researcher").id, editor: role("Editor").id, cp: role("Content Producer").id, cm: role("Creator Manager").id, ops: role("Ops").id };
  for (const id of Object.values(ids)) await api.call("team.roleUpdate", { id, agentKind: "fake", model: null, permissionMode: "acceptEdits" });
  // A teammate the person named: an Editor called Ava, so the chat says what she was made as.
  await api.call("team.roleUpdate", { id: ids.editor, name: "Ava" });
  check("every role runs on the scripted agent", (await teamOf(space.id)).roles.every((r) => r.agentKind === "fake"));

  /* ── seeded history ── */
  await api.call("team.roleMessage", { id: ids.cm, text: "Please keep Nathan's record: he signed this week." });
  await quiet(ids.cm);
  await api.call("team.roleMessage", { id: ids.researcher, text: "Could you find three sources on the spring launch?" });
  await quiet(ids.researcher);
  await api.call("team.roleMessage", { id: ids.researcher, text: "Thanks — which one is strongest?" });
  await quiet(ids.researcher);
  const rr = await runsOf(ids.researcher);
  check("C3 the second message continued the first run's session", rr.length === 2 && rr[0].sessionId === rr[1].sessionId, rr.map((r) => r.sessionId));
  await api.call("team.roleMessage", { id: ids.cp, text: "Please make Nathan's slides and hand them over." });
  await quiet(ids.cp);
  await until(async () => (await runsOf(ids.cm)).some((r) => r.wokeOn === "handoff"), 20_000, "cm woke on handoff");
  await quiet(ids.cm);
  const sched = (await api.call("schedules.list", { spaceId: space.id })).find((s) => s.roleId === ids.editor);
  await api.call("schedules.runNow", { id: sched.id });
  await until(async () => (await runsOf(ids.editor)).length === 1, 10_000, "scheduled run");
  await quiet(ids.editor);
  await api.call("team.roleMessage", { id: ids.editor, text: "Please pull every number from last quarter." });
  await quiet(ids.editor);
  check("C4 Ava's second run stopped at its dollar cap", (await runsOf(ids.editor))[0].stoppedAtCap === "usd");
  await api.call("team.roleMessage", { id: ids.ops, text: "Please sort out the invoices." });
  await until(async () => (await runsOf(ids.ops))[0]?.state === "blocked", 20_000, "ops asks");
  team = await teamOf(space.id);
  check("C1 seeded: two drafts waiting, a handoff, Ops waiting on the person",
    team.reviews.filter((r) => r.state === "waiting").length === 2 && team.handoffs.some((h) => h.kind === "handoff") && team.roles.find((r) => r.id === ids.ops).state === "waiting",
    { reviews: team.reviews.map((r) => `${r.title}:${r.state}`), ops: team.roles.find((r) => r.id === ids.ops).state });

  // A second space whose team has nobody left on it.
  const profileId = space.profileId;
  const studio = await api.call("spaces.create", { profileId, name: "Studio", icon: "folder" });
  const made = await api.call("team.make", { spaceId: studio.id, templates: ["researcher"] });
  await api.call("team.roleArchive", { id: made.roles[0].id });

  /* ── C1/C2: the chats, and a thread ── */
  await openTeam(c, "Versed");
  const rows = await evalIn(c, `__live.qa('.sb-page-nav .tc-chat-row').map((l) => ({ name: l.querySelector('.tc-chat-name')?.textContent, preview: l.querySelector('.tc-chat-preview-text')?.textContent,
    needs: !!l.querySelector('.status-dot[data-status="waiting_permission"]'), lit: l.hasAttribute('data-selected'), mite: !!l.querySelector('svg') }))`);
  check("C1 a chat row per teammate, each with its Realmite and a line", rows.length === 5 && rows.every((r) => r.mite && r.preview), rows);
  check("C1 Ops says its question in its row and is marked as needing you", /^Asks: Should I draft the March ones first/.test(rows.find((r) => r.name === "Ops")?.preview ?? "") && rows.find((r) => r.name === "Ops")?.needs, rows.find((r) => r.name === "Ops"));
  check("C1 the team opens on a chat that needs you", ["Ops", "Researcher", "Creator Manager"].includes(rows.find((r) => r.lit)?.name), rows.find((r) => r.lit)?.name);
  await toChat(c, "Researcher");
  const thread = await evalIn(c, `({ you: __live.qa('.tc-row[data-side="you"] .tc-bubble').map((b) => b.textContent), them: __live.qa('.tc-said').length,
    strong: __live.qa('.tc-said strong').length, draft: __live.text('.tc-draft .tc-card-title'), actions: __live.qa('.tc-draft button').map((b) => b.textContent),
    days: __live.qa('.tc-day').map((d) => d.textContent), head: __live.text('.tc-head-line'), placeholder: __live.q('.tc-composer textarea')?.placeholder })`);
  check("C2 the person's two messages and its two reports, the report drawn as Markdown", thread.you.length === 2 && thread.them === 2 && thread.strong >= 3, thread);
  check("C2 the draft card carries Approve, Send back and Open in Review", thread.draft === "Spring launch: three sources" && ["Approve", "Send back", "Open in Review"].every((a) => thread.actions.includes(a)), thread.actions);
  check("C2 a day head and the prompter's name", thread.days.includes("Today") && thread.placeholder === "Message Researcher…", { days: thread.days, placeholder: thread.placeholder });
  const s = await sides(c);
  check("C2 the person's bubbles stand on the right edge, the teammate's on the left beside its avatar",
    s.you.every((x) => Math.abs(x - (s.colRight - 24)) <= 2) && s.them.every((x) => x - (s.colLeft + 24) >= 36 && x - (s.colLeft + 24) <= 44), s);

  /* ── C3: send from the prompter with Return ── */
  await evalIn(c, `(() => { const t = __live.q('.tc-composer textarea'); t.focus(); __live.set(t, 'And a fourth source?'); return true; })()`);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until(async () => (await runsOf(ids.researcher)).length === 3, 8_000, "third run");
  await quiet(ids.researcher);
  await until(() => evalIn(c, `/archived copy from March/.test(__live.q('.tc-thread')?.textContent ?? '')`), 10_000, "answer in thread");
  const r3 = await runsOf(ids.researcher);
  check("C3 Return in the chat's prompter started a run with the words, in the same session", r3[0].wokeNote === "And a fourth source?" && r3[0].sessionId === r3[1].sessionId, { note: r3[0].wokeNote });
  check("C3 the field is empty after the send", (await evalIn(c, `__live.q('.tc-composer textarea').value`)) === "");

  /* ── C6: the whole run under a report ── */
  await evalIn(c, `__live.click(__live.qa('.tc-run-toggle')[0])`);
  await until(() => evalIn(c, `!!__live.q('.tc-runlog .transcript') && __live.qa('.tc-runlog .tool-card, .tc-runlog .tool-group, .tc-runlog [class*="tool"]').length > 0`), 10_000, "run log");
  await evalIn(c, `__live.q('.tc-runlog').scrollIntoView({ block: 'center' })`);
  await shot(c, "07-run-expanded-dark");
  await evalIn(c, `__live.click(__live.qa('.tc-run-toggle')[0])`);

  /* ── C4: answer Ops' question from its chat ── */
  await toChat(c, "Ops");
  check("C4 Ops' question is a card in its thread", /Should I draft the March ones first/.test((await evalIn(c, `__live.text('.tc-ask')`)) ?? ""));
  await toChat(c, "Creator Manager");
  const cmThread = await evalIn(c, `({ handoff: __live.text('.tc-handoff .tc-card-kicker'), record: __live.text('.tc-record .tc-card-kicker'), draft: __live.text('.tc-draft .tc-card-title') })`);
  check("C4 Creator Manager's thread: the handoff it took, the record it kept, its draft",
    /Content Producer handed over work/.test(cmThread.handoff ?? "") && /Nathan Beyenhof's record/.test(cmThread.record ?? "") && cmThread.draft === "Weekly check-in to Nathan", cmThread);
  await toChat(c, "Ava");
  const avaThread = await evalIn(c, `__live.qa('.tc-note').map((n) => n.textContent)`);
  check("C4 Ava's thread: a run by the clock, and a stop at the dollar limit", avaThread.some((t) => /^Ran on schedule · /.test(t)) && avaThread.some((t) => /Stopped at its \$3 limit/.test(t)), avaThread);

  /* ── C7: ↑/↓ between chats, and Approve on a card ── */
  await evalIn(c, `__live.chat('Ava').querySelector('input').focus()`);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await until(() => evalIn(c, `__live.text('.tc-head-name') !== 'Ava'`), 5_000, "arrow moved");
  const afterDown = await evalIn(c, `__live.text('.tc-head-name')`);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
  await until(() => evalIn(c, `__live.text('.tc-head-name') === 'Ava'`), 5_000, "arrow back");
  check("C7 ↓ opens the next chat and ↑ the one before", afterDown === "Content Producer", afterDown);

  await toChat(c, "Creator Manager");
  await evalIn(c, `__live.click(__live.button('Approve', __live.q('.tc-draft')))`);
  await until(async () => (await teamOf(space.id)).reviews.find((r) => r.title === "Weekly check-in to Nathan")?.state === "approved", 8_000, "approved");
  await until(() => evalIn(c, `!__live.button('Approve', __live.q('.tc-draft'))`), 5_000, "card settles");
  check("C7 Approve on the draft card approved it through Review's action", true);

  /* ── C5: a teammate at work ── */
  await api.call("team.roleMessage", { id: ids.cp, text: "Please lay out next week's slides." });
  await until(async () => (await runsOf(ids.cp))[0].state === "running", 10_000, "cp working");
  await toChat(c, "Content Producer");
  await until(() => evalIn(c, `!!__live.q('.tc-typing') && !!__live.chat('Content Producer')?.querySelector('.tc-dots')`), 8_000, "typing");
  const anim = await evalIn(c, `getComputedStyle(__live.q('.tc-typing i')).animationName`);
  check("C5 the typing dots in the thread and the row, and they move", anim === "tc-dot", anim);
  await shot(c, "09-working-dark");
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(200);
  const still = await evalIn(c, `({ anim: getComputedStyle(__live.q('.tc-typing i')).animationName, shown: !!__live.q('.tc-typing') })`);
  check("C5 under Reduce motion the dots hold still and stay drawn", still.anim === "none" && still.shown, still);
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await backToSpaces(c);

  /* ── C8/C9: every surface, dark then light ── */
  await surfaces(c, "dark", ids);
  await quiet(ids.cp, 120_000);
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await surfaces(c, "light", ids);
  check("C8 the empty team offers Add teammate", true);
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
    if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
