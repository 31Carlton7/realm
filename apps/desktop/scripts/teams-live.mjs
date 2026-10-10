/**
 * Live check for Teams, Phase 1 (run with: node apps/desktop/scripts/teams-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js — run `pnpm build` first) on a scratch home with
 * the scripted agent standing in for Claude, so nothing is ever billed, and walks the plan's S1–S6:
 *
 *   S0  the space page's Team tab, and "Make Versed a team" from it — the starters land on the Overview;
 *   S1  Creator Manager keeps Nathan's record; Content Producer's clock fires and sends six slideshows
 *       (the real forgot-it-by-lunch deck, copied into the space) to Review, and Creator Manager an
 *       email draft — the sidebar's Review row reads 2, and both are Needs you rows;
 *   S2  Approve from the Review pane — the state, an activity line, and no act;
 *   S3  Request changes on the email — the note reaches the run's session, and version 2 replaces it;
 *   S4  a run past its dollar cap is stopped, with the reason and the line in the log;
 *   S5  the record page draws the record, and an edit commits it under the person's name;
 *   S6  every surface in dark and light, for comparing beside the mocks;
 *   S7  choosing who is on the team: nothing picked for you, a teammate of your own written in the role
 *       sheet, Add teammate past the team's week and raising it, Duplicate, and Remove asking first.
 *
 * LIVE_SCRATCH is where the scratch home goes (default: LIVE_OUT). With LIVE_INSIDE_PROJECTS=1 the
 * home is meant to sit inside a folder one of the spaces works in — the owner's preview, whose home was
 * under the folder that is also a space — and the run proves the team's memory goes to the fallback
 * folder (REALM_MEMORY_FALLBACK_DIR, LIVE_FALLBACK) and, with nowhere allowed, that the page says why
 * and offers to choose a folder.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8809 / 9249). Screenshots go to LIVE_OUT. It touches only
 * its own scratch home, and kills only what holds its own two ports. The deck is copied, never moved.
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
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-teams-live");
const DECK = process.env.LIVE_DECK ?? path.join(os.homedir(), "Realm/work/versed/content/decks/forgot-it-by-lunch");
fs.mkdirSync(OUT_DIR, { recursive: true });
const SCRATCH_ROOT = process.env.LIVE_SCRATCH ?? OUT_DIR;
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, "run-"));
const INSIDE = process.env.LIVE_INSIDE_PROJECTS === "1";
const FALLBACK = process.env.LIVE_FALLBACK ?? path.join(OUT_DIR, "memory-fallback");
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
  set(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  tab(text) { return [...document.querySelectorAll('.sb-page-nav label.settings-tab')].find((l) => l.textContent.trim().startsWith(text)) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag) {
  // Past every entrance (the column's slide, a sheet's spring), so the frame is the surface at rest.
  await sleep(1100);
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

/* ── the scripted agent ─────────────────────────────────────────────────────────────────────────── */

const SLIDESHOWS = [
  { dir: "v3", caption: "highlighting feels like studying. it isn't 📖 #biblestudy #scripturememory #ad" },
  { dir: "v2", caption: "you read it this morning. can you say it back? #biblestudy #ad" },
  { dir: "v1", caption: "the verse you forgot by lunch, and the one trick that keeps it #ad" },
  { dir: "photos", caption: "read it out loud. twice. then cover a few words #scripturememory #ad" },
  { dir: "v3", caption: "phone face down. first letters only. #biblestudy #ad" },
  { dir: "v2", caption: "what you can say without looking is what stays #versed #ad" },
];
const slides = (dir) => [1, 2, 3, 4, 5, 6, 7].map((n) => `content/decks/forgot-it-by-lunch/${dir}/0${n}.png`);
const EMAIL = (v) => [
  "Hi Nathan,",
  "",
  v === 1
    ? "Quick weekly check-in: your first post went up Thursday and is at 4,812 views. Two more this week keeps us on the three-a-week pace in the contract."
    : "Hope your week's going well! Your first post went up Thursday and is already at 4,812 views — great start. Could you send two more by Thursday? That keeps us on the three-a-week pace.",
  "",
  "Carlton",
].join("\n");

const SCRIPT = [
  { on: "mention Thursday", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "usage", costUsd: 0.12 },
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "message", title: "Weekly check-in to Nathan", record: "nathan-beyenhof", items: [{ files: [], body: EMAIL(2), target: { channel: "Email" } }] } },
    { kind: "text", text: "Rewrote the check-in warmer and asked for two more posts by Thursday. Sent version 2 to Review." },
  ] },
  { on: "keep Nathan's record", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nathan Beyenhof" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "replace", path: "nathan-beyenhof", match: "Status:", entry: "Status: signed · contract v3" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", entry: "Contact: Nathan.beyenhof@gmail.com · iMessage" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deal", entry: "Term: Thu 8 Oct – Sat 7 Nov" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deal", entry: "Rate: $5 per video + $2.50 CPM · paid by Venmo" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deal", entry: "Formats: Talk to camera, Bible journaling; new formats by approval" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deal", entry: "Creator code: NATHAN5" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "TikTok @versed.nathan · vault: tiktok.com/nathan · device: Lab iPhone 2 · consent: contract §4" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "Instagram @versed.nathan · vault: instagram.com/nathan · device: Lab iPhone 2 · consent: contract §4" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "YouTube Shorts: waiting on Nathan" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deadlines", entry: "First post goes up · Thu 8 Oct · contract §3 · done" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deadlines", entry: "3 videos a week · 1 of 3 this week · behind" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Content", entry: "“The fade” 1 of 3 · TikTok · posted Mon · 4,812 views" } },
    { kind: "usage", costUsd: 0.31 },
    { kind: "text", text: "Kept Nathan's record: deal, accounts with consent, deadlines and his first post." },
  ] },
  { on: "draft the weekly check-in", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "usage", costUsd: 0.18 },
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "message", title: "Weekly check-in to Nathan", record: "nathan-beyenhof", items: [{ files: [], body: EMAIL(1), target: { channel: "Email" } }] } },
    { kind: "text", text: "Drafted Nathan's weekly check-in and sent it to Review." },
  ] },
  { on: "Content Producer's scheduled run", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "text", text: "Reading Nathan's record and laying out six slideshows from the forgot-it-by-lunch deck.", paceMs: 20 },
    { kind: "usage", costUsd: 0.84 },
    { kind: "call", tool: "realm-team__review_submit", input: {
      kind: "slideshows", title: "6 slideshows for Nathan", record: "nathan-beyenhof",
      items: SLIDESHOWS.map((s) => ({ files: slides(s.dir), body: s.caption, target: { channel: "TikTok", account: "@versed.nathan" } })),
    } },
    { kind: "text", text: "Sent 6 slideshows for Nathan to Review." },
  ] },
  { on: "spend freely", emit: [
    { kind: "usage", costUsd: 4.2 },
    { kind: "text", text: "Pulling every week of numbers I can find, one dashboard after another", paceMs: 120 },
  ] },
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
      REALM_HOME: home,
      REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Claude's name runs the script too, so onboarding's own session can never reach a real engine.
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_MEMORY_FALLBACK_DIR: FALLBACK,
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

const runsOf = async (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);
const spaceOf = async () => (await api.call("spaces.list", {})).find((s) => s.name === "Versed");

async function openTeamPage(c, label) {
  // The space's ⋯ menu names the team's page; Escape any page first so the sidebar is the spaces.
  await evalIn(c, `__live.click(__live.named('^More for Versed$'))`);
  await until(() => evalIn(c, `!!__live.button(${JSON.stringify(label)})`), 5_000, `menu row ${label}`);
  await evalIn(c, `__live.click(__live.button(${JSON.stringify(label)}))`);
  await until(() => evalIn(c, `!!__live.q('.sb-page-nav .page-rail')`), 8_000, "team page");
}

let liveC = null;
async function main() {
  const c = await boot();
  liveC = c;
  const space = await spaceOf();
  check("onboarding made Versed", !!space, space?.name);

  /* The deck, copied into the space where a role would have saved it. */
  const into = path.join(space.folderPath, "content/decks/forgot-it-by-lunch");
  for (const dir of ["v1", "v2", "v3", "photos"]) {
    fs.mkdirSync(path.join(into, dir), { recursive: true });
    for (let n = 1; n <= 7; n++) fs.copyFileSync(path.join(DECK, dir, `0${n}.png`), path.join(into, dir, `0${n}.png`));
  }

  /* ── S0: the Team tab, choosing who is on the team, and making it ─────────────────────────────── */
  if (INSIDE) {
    // One of this person's spaces works in the folder Realm's home is inside (their preview's case).
    const p = (await api.call("profiles.list", {}))[0];
    const projects = await api.call("spaces.create", { profileId: p.id, name: "Projects", icon: "folder" });
    execFileSync("sqlite3", [path.join(home, "realm.db"), `UPDATE spaces SET folder_path = '${scratch.replace(/'/g, "''")}' WHERE id = '${projects.id}'`]);
    check("S0 Realm's home is inside a space's folder", home.startsWith(scratch + path.sep), { home, space: scratch });
  }
  await openTeamPage(c, "Make this a team…");
  await until(() => evalIn(c, `!!__live.q('[data-template="researcher"]')`), 8_000, "make team");
  const gallery = await evalIn(c, `({
    any: __live.qa('section[aria-label="For any team"] [data-template] .tp-card-name').map((n) => n.textContent),
    creators: __live.qa('section[aria-label="For work with creators"] .tp-card-name').map((n) => n.textContent),
    checked: __live.qa('.tp-pick input:checked').length,
    disabled: [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Make Versed a team')?.disabled,
  })`);
  const reach = await evalIn(c, `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Make Versed a team'); const r = b.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), height: innerHeight, inFoot: !!b.closest('.page-foot'), inColumn: !!b.closest('.page-content') }; })()`);
  check("S7 the button is on screen without scrolling, in the bar under the column", reach.inFoot && !reach.inColumn && reach.bottom <= reach.height, reach);
  check("S7 seven starters on two shelves, none picked for you", gallery.any.length === 5 && gallery.creators.join() === "Creator Manager,Content Producer" && gallery.checked === 0 && gallery.disabled === true, gallery);
  await shot(c, "00-make-team-dark");
  for (const id of ["creator-manager", "content-producer"]) await evalIn(c, `__live.click(__live.q('[data-template="${id}"] input'))`);
  await evalIn(c, `__live.click([...document.querySelectorAll('button.tp-card-custom')][0])`);
  await until(() => evalIn(c, `!!__live.q('[aria-modal=true] .rmt-maker')`), 5_000, "custom sheet");
  await evalIn(c, `(() => { const d = __live.q('[aria-modal=true]');
    __live.set([...d.querySelectorAll('label.field')].find((l) => l.textContent.startsWith('Name')).querySelector('input'), 'Podcast Booker');
    __live.set([...d.querySelectorAll('label.field')].find((l) => l.textContent.startsWith('What they do')).querySelector('textarea'), 'Find podcast hosts whose listeners would care about this space, and draft a short pitch to each. Send the pitches to Review; never send them yourself.');
    const budget = [...d.querySelectorAll('label.field')].find((l) => l.textContent.startsWith('A week')).querySelector('input'); __live.set(budget, '8');
    const mode = [...d.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === 'Mode').querySelector('select'); mode.value = 'plan'; mode.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
  await shot(c, "04b-custom-teammate-dark");
  await evalIn(c, `__live.click(__live.button('Add to the team', __live.q('[aria-modal=true]')))`);
  await until(() => evalIn(c, `!__live.q('[aria-modal=true]') && !!__live.q('[data-custom]')`), 5_000, "custom card");
  const picked = await evalIn(c, `__live.text('.tp-shares-line [role=status]')`);
  check("S7 the shares say what the picks come to", picked === "Shares come to $53 of the team's $60 a week", picked);
  await shot(c, "00a-make-team-picked-dark");
  await evalIn(c, `__live.click(__live.button('Make Versed a team'))`);
  await until(() => evalIn(c, `/Versed team/.test(__live.text('.page-head h1') ?? '')`), 15_000, "overview");
  let team = await api.call("team.space", { spaceId: space.id });
  check("S0 the starters are made, each with its clock, and the teammate written by hand", team.roles.map((r) => `${r.name}@${r.cron}`).join(", ") === "Creator Manager@0 9 * * 1-5, Content Producer@0 9 * * 1,4, Podcast Booker@null", team.roles.map((r) => r.name));
  const booker = team.roles.find((r) => r.name === "Podcast Booker");
  check("S7 the written teammate keeps what was written", booker?.permissionMode === "plan" && booker?.weekBudgetUsd === 8 && /podcast hosts/.test(booker?.brief ?? ""), booker && { mode: booker.permissionMode, budget: booker.weekBudgetUsd });
  check("S0 the space has its own memory repo for records", team.hasRepo === true);
  if (INSIDE) {
    check("S0 inside a project: the repo went to the fallback folder, not under the home", team.repoMoved === true && team.repoPath?.startsWith(FALLBACK) && !team.repoPath.startsWith(scratch), { repoPath: team.repoPath });
    const toast = await until(() => evalIn(c, `[...document.querySelectorAll('.toast, [class*=toast]')].map((t) => t.textContent).find((t) => /team's memory is in/.test(t)) ?? null`), 5_000, "moved toast").catch(() => null);
    check("S0 and the person is told where it went", !!toast && toast.includes(FALLBACK), toast);
    await shot(c, "00b-repo-moved-dark");
  } else {
    check("S0 outside any project: the repo is under Realm's home", team.repoMoved === false && team.repoPath?.startsWith(home), { repoPath: team.repoPath });
  }
  const cm = team.roles.find((r) => r.name === "Creator Manager");
  const cp = team.roles.find((r) => r.name === "Content Producer");
  // The fake by its own name, so its usage reports are read per turn and its dollars come out true.
  for (const r of [cm, cp]) await api.call("team.roleUpdate", { id: r.id, agentKind: "fake" });

  /* ── S1: a record kept, the clock fires, work arrives in Review ────────────────────────────── */
  await api.call("team.roleRun", { id: cm.id, message: "Please keep Nathan's record: he signed contract v3." });
  await until(async () => (await runsOf(cm.id)).every(settled), 30_000, "record run");
  const sched = (await api.call("schedules.list", { spaceId: space.id })).find((s) => s.roleId === cp.id);
  await api.call("schedules.runNow", { id: sched.id });
  await api.call("team.roleRun", { id: cm.id, message: "It's Wednesday: draft the weekly check-in for Nathan." });
  await until(async () => (await api.call("team.space", { spaceId: space.id })).reviews.filter((r) => r.state === "waiting").length === 2, 40_000, "two reviews");
  await until(async () => [...await runsOf(cm.id), ...await runsOf(cp.id)].every(settled), 30_000, "runs settle");
  const cpRun = (await runsOf(cp.id))[0];
  check("S1 the clock's run is the role's, woken on its schedule", cpRun.wokeOn === "schedule" && cpRun.state === "succeeded", { wokeOn: cpRun.wokeOn, state: cpRun.state });
  check("S1 its dollars are on the run", Math.abs((cpRun.costUsd ?? 0) - 0.84) < 1e-6, cpRun.costUsd);
  // Back to the spaces, where the sidebar shows what arrived.
  await evalIn(c, `__live.click(__live.q('.sb-page-back'))`);
  await until(() => evalIn(c, `!!__live.named('^Review — 2 waiting on you$')`), 10_000, "review row");
  const sidebar = await evalIn(c, `({
    review: __live.named('^Review — ')?.getAttribute('aria-label'),
    needs: __live.qa('.sb-needs .item-title').map((t) => t.textContent),
    roles: __live.qa('.sb-team-roles .item-title').map((t) => t.textContent),
    realmites: __live.qa('.sb-team-roles .sb-realmite svg').length,
  })`);
  check("S1 the Review row counts 2", sidebar.review === "Review — 2 waiting on you", sidebar.review);
  check("S1 each review is a Needs you row", sidebar.needs.includes("6 slideshows for Nathan") && sidebar.needs.includes("Weekly check-in to Nathan"), sidebar.needs);
  check("S1 the Team row folds to its roles, each a Realmite", sidebar.roles.join() === "Creator Manager,Content Producer,Podcast Booker,Add teammate" && sidebar.realmites === 3, sidebar);

  /* ── S2: the Review pane, and Approve ──────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.named('^6 slideshows for Nathan in Versed'))`);
  await until(() => evalIn(c, `__live.qa('.rv-slide img').length === 7 && __live.qa('.rv-slide img').every((i) => i.complete && i.naturalWidth > 0)`), 15_000, "slides drawn");
  const head = await evalIn(c, `({ h1: __live.text('.rv-head h1'), byline: __live.text('.rv-byline'), checks: __live.qa('.rv-checks li').map((l) => l.textContent), barOutside: !__live.q('.rv-decide').closest('.rv-detail-scroll') })`);
  check("S2 the batch reads with its record, role and dollars", /6 slideshows for Nathan — slideshow 1 of 6/.test(head.h1) && /For Nathan Beyenhof/.test(head.byline) && /\$0\.84/.test(head.byline), head);
  check("S2 Realm's own checks: consent on record, the disclosure", /Posts as @versed\.nathan/.test(head.checks[0] ?? "") && /Disclosed/.test(head.checks[1] ?? ""), head.checks);
  check("S2 the decision bar is outside the scroller", head.barOutside);
  await shot(c, "01-sidebar-and-review-dark");
  await evalIn(c, `__live.click(__live.qa('.rv-decide .btn.primary')[0])`);
  await until(() => evalIn(c, `/Approved by you/.test(__live.text('.rv-decide-note') ?? '')`), 8_000, "approved");
  const approved = (await api.call("team.space", { spaceId: space.id })).reviews.find((r) => r.title === "6 slideshows for Nathan");
  const detail = await api.call("team.review", { id: approved.id });
  check("S2 approve: the batch is approved, each item ready, nothing acted", approved.state === "approved" && detail.items.every((i) => i.actState === "ready" && i.approvedHash === i.contentHash), { state: approved.state });
  const log = await api.call("team.activity", { spaceId: space.id, limit: 100 });
  check("S2 the yes is a line in the log, with what was approved", log.some((a) => a.verb === "approved" && a.actor === "user" && Array.isArray(a.detail.hashes) && a.detail.hashes.length === 6));
  check("S2 no act happened", !log.some((a) => a.verb === "acted"));
  await shot(c, "01b-review-approved-dark");

  /* ── S3: Request changes on the email ───────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.q('[data-review]:not([data-selected])'))`);
  await until(() => evalIn(c, `/Weekly check-in/.test(__live.text('.rv-head h1') ?? '')`), 8_000, "email selected");
  await evalIn(c, `__live.click(__live.button('Request changes'))`);
  await evalIn(c, `__live.set(__live.q('.rv-ask-field'), 'Make it warmer and mention Thursday as the day for two more posts.')`);
  await shot(c, "01c-request-changes-dark");
  await evalIn(c, `__live.click(__live.q('.rv-ask .btn.primary'))`);
  const email = (await api.call("team.space", { spaceId: space.id })).reviews.find((r) => r.kind === "message");
  await until(async () => (await api.call("team.review", { id: email.id })).version === 2, 30_000, "version 2");
  const v2 = await api.call("team.review", { id: email.id });
  const reviewRun = (await runsOf(cm.id))[0];
  const events = await api.call("sessions.events", { id: reviewRun.sessionId, afterSeq: 0, limit: 500 }).catch(() => null);
  const userTexts = (events ?? []).filter((e) => e.event.type === "user_message").map((e) => e.event.payload.text);
  check("S3 the note woke the role in the run's own session", reviewRun.wokeOn === "review" && userTexts.some((t) => t.includes("mention Thursday")), { wokeOn: reviewRun.wokeOn });
  check("S3 the revision replaced the review in place, version 1 one step back", v2.state === "waiting" && v2.previous.length === 1 && /Thursday/.test(v2.items[0].body), { version: v2.version });
  await until(() => evalIn(c, `/Version 2/.test(__live.text('.rv-version') ?? '')`), 8_000, "v2 drawn");
  await shot(c, "01d-email-version-2-dark");

  /* ── S4: the dollar cap ──────────────────────────────────────────────────────────────────────── */
  const ga = await api.call("team.roleCreate", { spaceId: space.id, name: "Growth Analyst", brief: "Read RevenueCat, PostHog and each post's views; report Mondays.", realmite: { seed: "growth-analyst-372" }, agentKind: "fake", model: "sonnet", cron: "0 8 * * 1", weekBudgetUsd: 5 });
  await api.call("team.roleRun", { id: ga.id, message: "This week, spend freely on the numbers." });
  await until(async () => (await runsOf(ga.id)).every(settled), 30_000, "cap run");
  const capped = (await runsOf(ga.id))[0];
  check("S4 the run stopped at its $3 cap, with the reason", capped.state === "cancelled" && capped.stoppedAtCap === "usd" && /\$3 run limit/.test(capped.error ?? ""), { state: capped.state, error: capped.error });
  const log2 = await api.call("team.activity", { spaceId: space.id, limit: 100 });
  check("S4 the stop is a line in the log", log2.some((a) => a.verb === "stopped_at_cap" && a.detail.cap === "usd"));

  /* ── the pages: Overview, a role, Creators and the record (S5) ─────────────────────────────── */
  await openTeamPage(c, "Team");
  await until(() => evalIn(c, `__live.qa('.tp-role-card').length === 4`), 8_000, "role cards");
  await shot(c, "02-team-home-dark");
  await evalIn(c, `__live.click(__live.tab('Roles'))`);
  await until(() => evalIn(c, `!!__live.tab('Creator Manager')`), 5_000, "roles unfold");
  await evalIn(c, `__live.click(__live.tab('Creator Manager'))`);
  await until(() => evalIn(c, `__live.qa('.tp-table tbody tr').length >= 3`), 8_000, "role runs");
  await shot(c, "03-role-page-dark");
  await evalIn(c, `__live.click(__live.tab('Creators'))`);
  await until(() => evalIn(c, `!!__live.tab('Nathan Beyenhof')`), 8_000, "creators unfold");
  await evalIn(c, `__live.click(__live.tab('Nathan Beyenhof'))`);
  await until(() => evalIn(c, `__live.qa('.tp-props > div').length >= 8`), 8_000, "record drawn");
  const rec = await evalIn(c, `({ props: __live.qa('.tp-props > div').map((d) => d.textContent), file: __live.text('.tp-file'), chips: __live.qa('.settings-list .tp-chip').map((c) => c.textContent) })`);
  check("S5 the record page draws the deal from the file", rec.props.includes("Rate") && rec.props.some((p) => /\$5 per video/.test(p)), rec.props);
  check("S5 accounts say consent; deadlines their state", rec.chips.includes("Consented") && rec.chips.includes("Done"), rec.chips);
  check("S5 the file line names who last changed it", /last changed by Creator Manager/.test(rec.file ?? ""), rec.file);
  await shot(c, "05-creator-record-dark");
  // The record's own Edit, in its page head: Review's open batch draws an Edit on each item's text too.
  await evalIn(c, `__live.click(__live.button('Edit', [...document.querySelectorAll('.page-head')].find((h) => h.textContent.includes('Nathan Beyenhof'))))`);
  await evalIn(c, `__live.set(__live.q('.tp-record-source'), __live.q('.tp-record-source').value.replace('## Content', '- Sends from: carlton@charmtechnologies.co\\n\\n## Content'))`);
  await evalIn(c, `__live.click(__live.button('Save'))`);
  await until(() => evalIn(c, `/last changed by (?!Creator Manager)/.test(__live.text('.tp-file') ?? '')`), 8_000, "edit committed");
  const repo = (await api.call("team.record", { spaceId: space.id, path: "nathan-beyenhof" }));
  const author = execFileSync("git", ["-C", path.dirname(path.dirname(repo.absPath)), "log", "-1", "--format=%an|%s", "--", "creators/nathan-beyenhof.md"], { encoding: "utf8" }).trim();
  check("S5 the edit committed, under the person rather than a role", repo.markdown.includes("Sends from: carlton@charmtechnologies.co") && !author.startsWith("Creator Manager|"), author);
  await evalIn(c, `__live.click(__live.tab('Activity'))`);
  await until(() => evalIn(c, `__live.qa('.tp-feed li').length > 5`), 8_000, "activity");
  await shot(c, "07-activity-dark");
  await evalIn(c, `__live.click(__live.tab('Overview'))`);
  await until(() => evalIn(c, `!!__live.button('Add teammate')`), 5_000, "overview again");

  /* ── S7: Add teammate past the week, Duplicate, Remove ─────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.button('Add teammate'))`);
  await until(() => evalIn(c, `!!__live.q('[aria-modal=true] [data-template="researcher"]')`), 5_000, "add sheet");
  const lit = await evalIn(c, `__live.qa('[aria-modal=true] [data-there] .tp-card-name').map((n) => n.textContent)`);
  check("S7 the starters on the team stand lit, not offered again", lit.join() === "Growth Analyst,Creator Manager,Content Producer", lit);
  await evalIn(c, `__live.click(__live.q('[aria-modal=true] [data-template="researcher"] input'))`);
  const overLine = await evalIn(c, `__live.text('[aria-modal=true] .tp-shares-line [role=status]')`);
  const held = await evalIn(c, `[...__live.q('[aria-modal=true]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add 1 teammate')?.disabled`);
  check("S7 past the week, the sheet says by how much and holds Add", /\$68 of the team's \$60 a week — \$8 over/.test(overLine ?? "") && held === true, { overLine, held });
  await shot(c, "04-add-teammates-over-dark");
  await evalIn(c, `__live.click([...__live.q('[aria-modal=true]').querySelectorAll('button')].find((b) => /^Raise the team's week/.test(b.textContent)))`);
  await evalIn(c, `__live.click(__live.button('Add 1 teammate', __live.q('[aria-modal=true]')))`);
  await until(() => evalIn(c, `/Researcher/.test(__live.text('.page-head h1') ?? '')`), 8_000, "researcher page");
  team = await api.call("team.space", { spaceId: space.id });
  check("S7 Researcher is on the team, the week raised to fit", team.roles.some((r) => r.name === "Researcher") && team.weekBudgetUsd === 68 && team.sharesUsd === 68, { week: team.weekBudgetUsd, shares: team.sharesUsd });
  await shot(c, "06-new-teammate-page-dark");
  await evalIn(c, `__live.click(__live.named('^More for Researcher$'))`);
  const menuRow = (start) => `[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.startsWith(${JSON.stringify(start)}))`;
  await until(() => evalIn(c, `!!${menuRow("Duplicate")}`), 5_000, "role menu");
  await shot(c, "06a-role-menu-dark");
  await evalIn(c, `__live.click(${menuRow("Duplicate")})`);
  await until(() => evalIn(c, `/Duplicate Researcher/.test(__live.q('[aria-modal=true]')?.textContent ?? '')`), 5_000, "duplicate sheet");
  const dupName = await evalIn(c, `[...__live.q('[aria-modal=true]').querySelectorAll('label.field')].find((l) => l.textContent.startsWith('Name')).querySelector('input').value`);
  const dupNote = await evalIn(c, `__live.text('[aria-modal=true] .tp-shares-line')`);
  check("S7 Duplicate starts from its fields under a free name, and says the copy would pass the week", dupName === "Researcher 2" && /\$78 of the team's \$68 a week — \$10 over/.test(dupNote ?? ""), { dupName, dupNote });
  await shot(c, "06b-duplicate-dark");
  await evalIn(c, `__live.click(__live.button('Cancel', __live.q('[aria-modal=true]')))`);
  await evalIn(c, `__live.click(__live.button('Remove Researcher from the team…'))`);
  await until(() => evalIn(c, `/Remove Researcher from the team\?/.test(__live.q('[aria-modal=true]')?.textContent ?? '')`), 5_000, "remove sheet");
  await shot(c, "06c-remove-dark");
  check("S7 Remove asked first: nothing removed yet", (await api.call("team.space", { spaceId: space.id })).roles.some((r) => r.name === "Researcher"));
  await evalIn(c, `__live.click(__live.button('Remove Researcher', __live.q('[aria-modal=true]')))`);
  await until(async () => !(await api.call("team.space", { spaceId: space.id })).roles.some((r) => r.name === "Researcher"), 8_000, "removed");
  const log3 = await api.call("team.activity", { spaceId: space.id, limit: 200 });
  check("S7 the removal is a line in the log, and the role's earlier lines stay", log3.some((a) => a.verb === "archived_role" && a.object === "Researcher") && log3.some((a) => a.verb === "made_role" && a.object === "Researcher"));
  if (INSIDE) {
    // Now with nowhere allowed: a space whose folder is the fallback, and a second space made a team.
    const p = (await api.call("profiles.list", {}))[0];
    const blocker = await api.call("spaces.create", { profileId: p.id, name: "Elsewhere", icon: "folder" });
    fs.mkdirSync(FALLBACK, { recursive: true });
    execFileSync("sqlite3", [path.join(home, "realm.db"), `UPDATE spaces SET folder_path = '${FALLBACK.replace(/'/g, "''")}' WHERE id = '${blocker.id}'`]);
    const qa = await api.call("spaces.create", { profileId: p.id, name: "QA Lab", icon: "folder" });
    await api.call("spaces.list", {});
    await evalIn(c, `__live.click(__live.q('.sb-page-back'))`).catch(() => {});
    await until(() => evalIn(c, `!!__live.named('^More for QA Lab$')`), 10_000, "qa lab row");
    await evalIn(c, `__live.click(__live.named('^More for QA Lab$'))`);
    await until(() => evalIn(c, `!!__live.button('Make this a team…')`), 5_000, "qa menu");
    await evalIn(c, `__live.click(__live.button('Make this a team…'))`);
    await until(() => evalIn(c, `!!__live.q('[data-template="editor"]')`), 8_000, "qa gallery");
    await evalIn(c, `__live.click(__live.q('[data-template="editor"] input'))`);
    await evalIn(c, `__live.click(__live.button('Make QA Lab a team'))`);
    const refusal = await until(() => evalIn(c, `__live.q('.tp-refusal')?.textContent ?? null`), 8_000, "refusal");
    check("S0 with nowhere allowed, the page says why and offers to choose a folder", /Choose a folder outside your projects/.test(refusal) && /Choose a folder…/.test(refusal), refusal);
    await shot(c, "00c-memory-refused-dark");
    execFileSync("sqlite3", [path.join(home, "realm.db"), `DELETE FROM spaces WHERE id = '${blocker.id}'`]);
    void qa;
    await openTeamPage(c, "Team");
  }

  /* ── S6: light ─────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await until(() => evalIn(c, `!!__live.named('^Weekly check-in to Nathan in Versed')`), 15_000, "needs you in light");
  await evalIn(c, `__live.click(__live.named('^Weekly check-in to Nathan in Versed'))`);
  await until(() => evalIn(c, `!!__live.q('.rv-head h1')`), 8_000, "review in light");
  await until(() => evalIn(c, `!!__live.q('[data-review="${approved.id}"]')`), 8_000, "slideshows card in light");
  await evalIn(c, `__live.click(__live.q('[data-review="${approved.id}"]'))`);
  await until(() => evalIn(c, `__live.qa('.rv-slide img').length === 7 && __live.qa('.rv-slide img').every((i) => i.complete && i.naturalWidth > 0)`), 15_000, "slides in light");
  await shot(c, "01-sidebar-and-review-light");
  await openTeamPage(c, "Team");
  await until(() => evalIn(c, `__live.qa('.tp-role-card').length >= 4`), 8_000, "cards in light");
  await shot(c, "02-team-home-light");
  await evalIn(c, `__live.click(__live.tab('Roles'))`);
  await until(() => evalIn(c, `!!__live.tab('Creator Manager')`), 5_000, "roles light");
  await evalIn(c, `__live.click(__live.tab('Creator Manager'))`);
  await until(() => evalIn(c, `__live.qa('.tp-table tbody tr').length >= 3`), 8_000, "role light");
  await shot(c, "03-role-page-light");
  await evalIn(c, `__live.click(__live.tab('Creators'))`);
  await until(() => evalIn(c, `!!__live.tab('Nathan Beyenhof')`), 8_000, "creators light");
  await evalIn(c, `__live.click(__live.tab('Nathan Beyenhof'))`);
  await until(() => evalIn(c, `__live.qa('.tp-props > div').length >= 8`), 8_000, "record light");
  await shot(c, "05-creator-record-light");
  await evalIn(c, `__live.click(__live.tab('Activity'))`);
  await until(() => evalIn(c, `__live.qa('.tp-feed li').length > 5`), 8_000, "activity light");
  await shot(c, "07-activity-light");
  // The picker on a space that is not a team yet, in light.
  const pl = (await api.call("profiles.list", {}))[0];
  await api.call("spaces.create", { profileId: pl.id, name: "Studio", icon: "folder" });
  await evalIn(c, `__live.click(__live.q('.sb-page-back'))`).catch(() => {});
  await until(() => evalIn(c, `!!__live.named('^More for Studio$')`), 10_000, "studio row");
  await evalIn(c, `__live.click(__live.named('^More for Studio$'))`);
  await until(() => evalIn(c, `!!__live.button('Make this a team…')`), 5_000, "studio menu");
  await evalIn(c, `__live.click(__live.button('Make this a team…'))`);
  await until(() => evalIn(c, `!!__live.q('[data-template="researcher"]')`), 8_000, "studio gallery");
  await evalIn(c, `__live.click(__live.q('[data-template="researcher"] input'))`);
  await evalIn(c, `__live.click(__live.q('[data-template="editor"] input'))`);
  await shot(c, "00-make-team-light");
  await evalIn(c, `__live.click(__live.q('.sb-page-back'))`);
  await until(() => evalIn(c, `!!__live.named('^More for Versed$')`), 10_000, "spaces again");
  await openTeamPage(c, "Team");
  await evalIn(c, `__live.click(__live.tab('Overview'))`);
  await until(() => evalIn(c, `!!__live.button('Add teammate')`), 5_000, "overview light");
  await evalIn(c, `__live.click(__live.button('Add teammate'))`);
  await until(() => evalIn(c, `!!__live.q('[aria-modal=true] [data-template="researcher"]')`), 5_000, "add sheet light");
  await evalIn(c, `__live.click(__live.q('[aria-modal=true] [data-template="editor"] input'))`);
  await shot(c, "04-add-teammates-light");
  await evalIn(c, `__live.click(__live.q('[aria-modal=true] button.tp-card-custom'))`);
  await until(() => evalIn(c, `!!__live.q('[aria-modal=true] .rmt-maker')`), 5_000, "custom light");
  await shot(c, "04b-custom-teammate-light");
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    // What the window said when it stopped: its alerts and toasts, and a picture.
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
