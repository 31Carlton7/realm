/**
 * Live check for Teams, Phase 4 (run with: node apps/desktop/scripts/teams-handoffs-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js — run `pnpm build` first) on a scratch home with the
 * scripted agent standing in for Claude, so nothing is billed, and walks:
 *
 *   H1  Content Producer hands six slides to Creator Manager along its edge: Creator Manager wakes as a
 *       run of its own with the note, the record and the files; both role pages and the overview list
 *       the handoff, each Realmite wearing its role's state;
 *   H2  `@Creator Manager` picked from the prompter's @ list starts it as the session's sub-agent; the
 *       lead collects it with agent_wait; its page lists the mention;
 *   H3  Creator Manager is given a goal: the run outlives its first turn and stops on the goal loop's
 *       stall stop, the run and the goal both saying so;
 *   H4  a budget hit: Content Producer's run stops at its $3 cap and its week is spent, so its clock is
 *       skipped with the reason, and its meter is orange;
 *   H5  an engine's plan limit backs every team off: the banner, a queued run, and Try now;
 *   H6  every surface in dark, then light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8816 / 9256). Screenshots go to LIVE_OUT. It touches only its
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9256);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8816);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-teams-handoffs-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-handoffs-live-"));
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

const RESET = Date.now() + 95 * 60_000;
const SLIDES = [1, 2, 3, 4, 5, 6].map((n) => `content/slides/nathan/0${n}.png`);
const SCRIPT = [
  // Goal continuations first: the first entry that matches wins, and each continuation repeats the objective.
  { on: "Continue working towards this objective:\n\nKeep every creator's record current", emit: [{ kind: "idle", text: "Nothing has changed since the last turn." }] },
  { on: "Keep every creator's record current", emit: [
    { kind: "call", tool: "realm-team__record_list", input: {} },
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "text", text: "Checked Nathan's record against his deadlines; the record is current.", paceMs: 90 },
  ] },
  { on: "keep Nathan's record", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nathan Beyenhof" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "replace", path: "nathan-beyenhof", match: "Status:", entry: "Status: signed · contract v3" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "TikTok @versed.nathan · vault: tiktok.com/nathan · consent: contract §4" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deadlines", entry: "3 videos a week · 1 of 3 this week · behind" } },
    { kind: "usage", costUsd: 0.22 },
    { kind: "text", text: "Kept Nathan's record." },
  ] },
  { on: "make Nathan's slides and hand them over", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "usage", costUsd: 0.84 },
    { kind: "call", tool: "realm-team__team_handoff", input: { to: "Creator Manager", record: "nathan-beyenhof", files: SLIDES,
      note: "Six slideshows for Nathan are laid out in content/slides/nathan. Draft his weekly check-in around them and ask for two more posts by Thursday." } },
    { kind: "text", text: "Made six slideshows and handed them to Creator Manager for Nathan's check-in." },
  ] },
  { on: "handed you work", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "text", text: "Reading the slides Content Producer passed and drafting Nathan's check-in around the first one, slowly so the window can see me working.", paceMs: 260 },
    { kind: "usage", costUsd: 0.31 },
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "message", title: "Weekly check-in to Nathan", record: "nathan-beyenhof",
      items: [{ files: [SLIDES[0]], body: "Hi Nathan — six new slideshows are ready for you. Could you post two more by Thursday? Carlton", target: { channel: "Email" } }] } },
    { kind: "text", text: "Drafted Nathan's check-in from the handoff and sent it to Review." },
  ] },
  { on: "when is Nathan's next post due", emit: [
    { kind: "call", tool: "realm-agent__agent_wait", input: {} },
    { kind: "text", text: "Creator Manager says Nathan's next post is due Thursday — he is at 1 of 3 this week." },
  ] },
  { on: "mentioned you and asked", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "usage", costUsd: 0.06 },
    { kind: "text", text: "Nathan's next post is due Thursday; he has posted 1 of 3 this week." },
  ] },
  { on: "spend freely", emit: [
    { kind: "usage", costUsd: 4.2 },
    { kind: "text", text: "Pulling every week of numbers I can find, one dashboard after another", paceMs: 120 },
  ] },
  { on: "check the numbers", emit: [
    { kind: "rateLimit", payload: { subscriptionType: "max", organization: null, alert: "exceeded", alertWindow: "five_hour", unavailable: null, detail: null,
      windows: [{ id: "five_hour", label: "5-hour", utilization: 100, resetsAt: RESET }] } },
    { kind: "text", text: "The account is out of quota for now." },
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
      REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_STANDS_IN: "claude", REALM_FAKE_SCRIPT: scriptFile,
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

async function openTeamPage(c) {
  await evalIn(c, `__live.click(__live.named('^More for Versed$'))`);
  await until(() => evalIn(c, `!!__live.button('Team')`), 5_000, "menu row Team");
  await evalIn(c, `__live.click(__live.button('Team'))`);
  await until(() => evalIn(c, `!!__live.q('.sb-page-nav .page-rail')`), 8_000, "team page");
}

async function toTab(c, label) {
  if (label !== "Overview" && label !== "Activity" && !(await evalIn(c, `!!__live.tab(${JSON.stringify(label)})`))) {
    await evalIn(c, `__live.click(__live.tab('Roles'))`);
    await until(() => evalIn(c, `!!__live.tab(${JSON.stringify(label)})`), 5_000, `tab ${label}`);
  }
  await evalIn(c, `__live.click(__live.tab(${JSON.stringify(label)}))`);
  await sleep(300);
}

async function backToSpaces(c) {
  await evalIn(c, `__live.q('.sb-page-back') && __live.click(__live.q('.sb-page-back'))`).catch(() => {});
  await until(() => evalIn(c, `!!__live.named('^More for Versed$')`), 10_000, "spaces");
}

/** Every Realmite on screen in a list of lines, with the state it wears. */
const mites = (c, sel) => evalIn(c, `__live.qa(${JSON.stringify(sel)}).map((n) => n.getAttribute('data-state') ?? n.querySelector('[data-state]')?.getAttribute('data-state') ?? null)`);

async function surfaces(c, mode, ids) {
  await openTeamPage(c);
  await toTab(c, "Overview");
  await until(() => evalIn(c, `__live.qa('.tp-handoffs li').length >= 1`), 8_000, `overview ${mode}`);
  await shot(c, `10-team-home-${mode}`);
  await evalIn(c, `__live.q('.page-scroll, .page-content')?.scrollBy?.(0, 10000)`).catch(() => {});
  await evalIn(c, `[...document.querySelectorAll('.settings-head')].find((h) => h.textContent === 'Budget')?.scrollIntoView({ block: 'start' })`);
  await shot(c, `11-team-budget-${mode}`);
  await toTab(c, "Creator Manager");
  await until(() => evalIn(c, `!!__live.q('.tp-goal')`), 8_000, `cm ${mode}`);
  await shot(c, `12-role-creator-manager-${mode}`);
  await evalIn(c, `[...document.querySelectorAll('.settings-head')].find((h) => h.textContent === 'Handoffs')?.scrollIntoView({ block: 'start' })`);
  await shot(c, `13-role-creator-manager-handoffs-${mode}`);
  await toTab(c, "Content Producer");
  await until(() => evalIn(c, `!!__live.q('.tp-edges')`), 8_000, `cp ${mode}`);
  await evalIn(c, `[...document.querySelectorAll('.settings-head')].find((h) => h.textContent === 'Runs on')?.scrollIntoView({ block: 'center' })`);
  await shot(c, `14-role-content-producer-budget-${mode}`);
  await toTab(c, "Activity");
  await until(() => evalIn(c, `__live.qa('.tp-feed li').length > 5`), 8_000, `activity ${mode}`);
  await shot(c, `15-activity-${mode}`);
  await backToSpaces(c);
  // The lead session, with the teammate chip and its sub-agent.
  await evalIn(c, `__live.click([...document.querySelectorAll('.item-row')].find((b) => /Nathan's next post/.test(b.textContent)) ?? null)`).catch(() => {});
  await sleep(600);
  await shot(c, `16-mention-session-${mode}`);
  void ids;
}

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  const colours = [[214, 120, 90], [96, 140, 210], [120, 180, 120], [200, 170, 80], [160, 110, 200], [90, 170, 170]];
  fs.mkdirSync(path.join(space.folderPath, "content/slides/nathan"), { recursive: true });
  SLIDES.forEach((f, i) => fs.writeFileSync(path.join(space.folderPath, f), png(90, 160, colours[i])));

  /* ── the team: the two creator starters, on the scripted agent, at their own default model ── */
  let team = await api.call("team.make", { spaceId: space.id, templates: ["creator-manager", "content-producer"] });
  const cm = team.roles.find((r) => r.name === "Creator Manager");
  const cp = team.roles.find((r) => r.name === "Content Producer");
  check("H1 the starters hand off where their templates say", cp.handsOffTo.includes(cm.id) && cm.handsOffTo.includes(cp.id), { cp: cp.handsOffTo, cm: cm.handsOffTo });
  for (const r of [cm, cp]) await api.call("team.roleUpdate", { id: r.id, agentKind: "fake", model: null });
  await api.call("team.roleRun", { id: cm.id, message: "Please keep Nathan's record: he signed contract v3." });
  await until(async () => (await runsOf(cm.id)).every(settled), 30_000, "record");

  /* ── H1: the handoff ── */
  await api.call("team.roleRun", { id: cp.id, message: "Please make Nathan's slides and hand them over." });
  await until(async () => (await runsOf(cm.id)).some((r) => r.wokeOn === "handoff" && r.state === "running"), 30_000, "cm woke on handoff");
  const woken = (await runsOf(cm.id)).find((r) => r.wokeOn === "handoff");
  check("H1 Creator Manager woke as a run of its own, from Content Producer, with the note", woken.wokeBy === "Content Producer" && /Six slideshows/.test(woken.wokeNote ?? ""), { wokeBy: woken.wokeBy });
  team = await teamOf(space.id);
  check("H1 the team lists the handoff, working, with its record and six files", team.handoffs[0]?.state === "working" && team.handoffs[0]?.recordPath === "creators/nathan-beyenhof.md" && team.handoffs[0]?.files.length === 6, team.handoffs[0]);
  // While Creator Manager is still working: the overview's handoff line and the receiving Realmite's face.
  await openTeamPage(c);
  await until(() => evalIn(c, `__live.qa('.tp-handoffs li').length >= 1`), 8_000, "handoff line");
  const faces = await mites(c, ".tp-handoffs li .tp-handoff-pair > svg, .tp-handoffs li .tp-handoff-pair > span");
  const line = await evalIn(c, `__live.text('.tp-handoffs li')`);
  check("H1 the overview's line names both roles and its state", /Content Producer handed work to Creator Manager/.test(line ?? "") && /Working/.test(line ?? ""), line);
  check("H1 the receiving Realmite wears working", faces.includes("working"), faces);
  await shot(c, "01-handoff-working-dark");
  await until(async () => (await runsOf(cm.id)).every(settled), 40_000, "cm settles");
  team = await teamOf(space.id);
  check("H1 the handoff is done once the run is, and its work is in Review", team.handoffs[0]?.state === "done" && team.reviews.some((r) => r.title === "Weekly check-in to Nathan"), team.handoffs[0]?.state);
  await backToSpaces(c);

  /* ── H2: @Creator Manager from the prompter ── */
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", permissionMode: "acceptEdits", title: "Nathan's next post" });
  await api.call("team.roleUpdate", { id: cm.id, permissionMode: "plan" });
  await until(() => evalIn(c, `!![...document.querySelectorAll('.item-row')].find((b) => /Nathan's next post/.test(b.textContent))`), 10_000, "lead row");
  await evalIn(c, `__live.click([...document.querySelectorAll('.item-row')].find((b) => /Nathan's next post/.test(b.textContent)))`);
  await until(() => evalIn(c, `!!__live.q('.composer textarea')`), 8_000, "lead composer");
  await evalIn(c, `(() => { const t = __live.q('.composer textarea'); t.focus(); __live.set(t, '@creator'); t.setSelectionRange(8, 8); t.dispatchEvent(new Event('select', { bubbles: true })); return true; })()`);
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "r", code: "KeyR" });
  await until(() => evalIn(c, `!!__live.q('.mention-row[data-kind="role"]')`), 8_000, "role in @ list");
  const row = await evalIn(c, `({ name: __live.text('.mention-row[data-kind="role"] .mention-row-name'), desc: __live.text('.mention-row[data-kind="role"] .mention-row-desc') })`);
  check("H2 the @ list offers Creator Manager as a teammate", row.name === "Creator Manager" && /^Teammate · Starts as a sub-agent/.test(row.desc ?? ""), row);
  await shot(c, "02-mention-picker-dark");
  await evalIn(c, `__live.click(__live.q('.mention-row[data-kind="role"]'))`);
  await until(() => evalIn(c, `/@\\[Creator Manager\\]/.test(__live.q('.composer textarea').value)`), 5_000, "chip in draft");
  await evalIn(c, `(() => { const t = __live.q('.composer textarea'); __live.set(t, t.value + 'when is Nathan\\'s next post due?'); return true; })()`);
  await evalIn(c, `__live.click(__live.named('^Send$'))`);
  await until(async () => (await teamOf(space.id)).handoffs.some((h) => h.kind === "mention"), 15_000, "mention made");
  const mention = (await teamOf(space.id)).handoffs.find((h) => h.kind === "mention");
  const child = await api.call("sessions.get", { id: mention.sessionId }).catch(() => null);
  check("H2 the mention started a sub-agent of this session, in the tighter mode (plan under Accept edits)", (child?.session ?? child)?.permissionMode === "plan", (child?.session ?? child)?.permissionMode);
  await until(async () => (await teamOf(space.id)).handoffs.find((h) => h.kind === "mention")?.state === "done", 30_000, "mention done");
  const cmRuns = await runsOf(cm.id);
  check("H2 Creator Manager's page lists the mention among its runs", cmRuns.some((r) => r.wokeOn === "mention" && r.state === "succeeded"), cmRuns.map((r) => r.wokeOn));
  await until(() => evalIn(c, `/next post is due Thursday/.test(document.body.textContent)`), 20_000, "lead answered");
  await shot(c, "03-mention-session-dark");

  /* ── H3: a goal ── */
  await api.call("team.roleUpdate", { id: cm.id, permissionMode: "default" });
  const goalRun = await api.call("team.roleGoal", { id: cm.id, objective: "Keep every creator's record current through Friday" });
  check("H3 the goal is a run woken on a goal", goalRun.wokeOn === "goal");
  await until(async () => (await teamOf(space.id)).roles.find((r) => r.id === cm.id).goal?.status === "active", 15_000, "goal active");
  await openTeamPage(c);
  await toTab(c, "Creator Manager");
  await until(() => evalIn(c, `!!__live.q('.tp-goal')`), 8_000, "goal drawn");
  await shot(c, "04-goal-active-dark");
  await until(async () => settled((await runsOf(cm.id)).find((r) => r.id === goalRun.id)), 60_000, "goal run settles");
  const goalDone = (await runsOf(cm.id)).find((r) => r.id === goalRun.id);
  const goal = (await teamOf(space.id)).roles.find((r) => r.id === cm.id).goal;
  check("H3 the run outlived its first turn and stopped on the stall stop", goalDone.state === "cancelled" && /no progress/.test(goalDone.error ?? "") && goal.status === "blocked" && goal.turns >= 3, { state: goalDone.state, turns: goal.turns, error: goalDone.error });
  await shot(c, "05-goal-stopped-dark");

  /* ── H4: a budget hit ── */
  await api.call("team.roleUpdate", { id: cp.id, weekBudgetUsd: 4 });
  await api.call("team.roleRun", { id: cp.id, message: "Please spend freely on this one." });
  await until(async () => (await runsOf(cp.id)).every(settled), 30_000, "cap stop");
  const capped = (await runsOf(cp.id))[0];
  check("H4 the run stopped at its $3 cap", capped.stoppedAtCap === "usd" && /\$3 run limit/.test(capped.error ?? ""), { cap: capped.stoppedAtCap, error: capped.error });
  const sched = (await api.call("schedules.list", { spaceId: space.id })).find((s) => s.roleId === cp.id);
  await api.call("schedules.runNow", { id: sched.id }).catch(() => null);
  team = await teamOf(space.id);
  const cpNow = team.roles.find((r) => r.id === cp.id);
  check("H4 its week is spent: the role is paused, saying why", cpNow.state === "paused" && /spent its \$4/.test(cpNow.pausedWhy ?? ""), { state: cpNow.state, why: cpNow.pausedWhy });
  const log = await api.call("team.activity", { spaceId: space.id, limit: 100 });
  check("H4 the clock was skipped with the reason", log.some((a) => a.verb === "paused" && /spent its/.test(a.detail.why ?? "")));
  await toTab(c, "Content Producer");
  await until(() => evalIn(c, `!!__live.q('.tp-budget-row .tp-meter[data-high]')`), 8_000, "orange meter");
  await evalIn(c, `[...document.querySelectorAll('.settings-head')].find((h) => h.textContent === 'Runs on')?.scrollIntoView({ block: 'center' })`);
  await shot(c, "06-budget-hit-dark");

  /* ── H5: an engine's limit backs every team off ── */
  await api.call("team.roleUpdate", { id: cp.id, weekBudgetUsd: 25 });
  await api.call("team.roleRun", { id: cp.id, message: "Please check the numbers." });
  await until(async () => (await teamOf(space.id)).limits.backoff.length === 1, 20_000, "backoff");
  await until(async () => (await runsOf(cp.id)).every(settled), 20_000, "limit run settles");
  await api.call("team.roleRun", { id: cm.id, message: "Please keep Nathan's record: one more look." });
  await sleep(800);
  team = await teamOf(space.id);
  check("H5 the back-off names the reset, and a new run waits", team.limits.backoff[0]?.until === RESET && (await runsOf(cm.id))[0].state === "queued", { backoff: team.limits.backoff[0], queued: team.limits.teamQueued });
  await toTab(c, "Overview");
  await until(() => evalIn(c, `!!__live.q('.tp-banner')`), 8_000, "banner");
  const banner = await evalIn(c, `__live.text('.tp-banner')`);
  check("H5 the overview says it, in words", /plan limit\. Team runs on it wait until/.test(banner ?? ""), banner);
  await shot(c, "07-backoff-dark");

  /* ── H6: every surface, dark then light ── */
  await surfaces(c, "dark");
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await surfaces(c, "light");
  await openTeamPage(c);
  await toTab(c, "Overview");
  await evalIn(c, `__live.click(__live.button('Try now'))`);
  await until(async () => (await teamOf(space.id)).limits.backoff.length === 0, 8_000, "lifted");
  await until(async () => (await runsOf(cm.id))[0].state !== "queued", 10_000, "queued run goes");
  check("H5 Try now lifts the back-off and the queued run goes", true);
  await shot(c, "08-backoff-lifted-light");
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
