/**
 * Live check for Teams, Phase 3 — approve → act (run with: node apps/desktop/scripts/teams-post-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js — run `pnpm build` first) on a scratch home, with
 * the scripted agent standing in for every engine and the FAKE platform adapter
 * (REALM_FAKE_ACT_ADAPTER=1), which posts nowhere and writes one line per act to the home's
 * fake-acts.jsonl. Nothing here ever reaches TikTok, Instagram or a mail server.
 *
 *   P1  a role sends six slideshows; Approve all 6 issues six tickets, two hours apart, three a day;
 *   P2  the post sheet names the consequence — account, device, slot, caption, disclosure, sign-in —
 *       and its button says the action and the time;
 *   P3  an agent's attempts are refused: the RPC method called with the daemon's token and no press,
 *       and a tool call for a posting tool that does not exist;
 *   P4  one click on "Post now" → the fake platform gets exactly one act, and the ticket and the log
 *       keep its URL and screenshot; the next one, pressed, waits for its slot two hours later;
 *   P5  the kill switch takes the pressed one back, refuses a press while held, and lets go;
 *   P6  sixteen approved DMs are fifteen today and one tomorrow; with fifteen already out today, a
 *       16th pressed for today is refused and nothing goes;
 *   P7  the sheet and the proof in dark and light, for comparing beside mock 04.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8820 / 9260). Screenshots go to LIVE_OUT. It touches only
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9260);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8820);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-teams-post-live");
const SLIDES_FROM = process.env.LIVE_SLIDES ?? path.join(repoRoot, "../.verify/backlog-oct8/teams-mocks/img");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-teams-post-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3_600_000;
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
  const raw = (method, params) => new Promise((res) => {
    const i = String(s.next());
    s.pending.set(i, res);
    s.ws.send(JSON.stringify({ id: i, method, params }));
  });
  return {
    ready: s.ready,
    raw,
    call: async (method, params) => { const msg = await raw(method, params); if (!msg.ok) throw new Error(`${method}: ${msg.error?.message}`); return msg.result; },
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
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.textContent.trim()) && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  radio(n) { return [...document.querySelectorAll('.rv-stepper label')].find((l) => l.textContent.trim() === String(n))?.querySelector('input') ?? null; },
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

/* ── the scripted agent ─────────────────────────────────────────────────────────────────────────── */

const CAPTIONS = [
  "highlighting feels like studying. it isn't 📖 #biblestudy #scripturememory #ad",
  "you read it this morning. can you say it back? #biblestudy #ad",
  "the verse you forgot by lunch, and the one trick that keeps it #ad",
  "read it out loud. twice. then cover a few words #scripturememory #ad",
  "phone face down. first letters only. #biblestudy #ad",
  "what you can say without looking is what stays #versed #ad",
];
const DECK = "content/decks/forgot-it-by-lunch";
const slideFiles = (i) => [1, 2, 3, 4, 5, 6, 7].map((n) => `${DECK}/v${(i % 3) + 1}/0${n}.png`);

const SCRIPT = [
  { on: "keep Nathan's record", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nathan Beyenhof" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "replace", path: "nathan-beyenhof", match: "Status:", entry: "Status: signed · contract v3" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "TikTok @versed.nathan · vault: tiktok.com/nathan · device: Lab iPhone 2 · consent: contract §4" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "Instagram @versed.nathan · vault: instagram.com/nathan · device: Lab iPhone 2 · consent: contract §4" } },
    { kind: "text", text: "Kept Nathan's record, with his accounts and his consent." },
  ] },
  { on: "Content Producer's scheduled run", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "usage", costUsd: 0.84 },
    { kind: "call", tool: "realm-team__review_submit", input: {
      kind: "slideshows", title: "6 slideshows for Nathan", record: "nathan-beyenhof",
      items: CAPTIONS.map((caption, i) => ({ files: slideFiles(i), body: caption, target: { channel: "TikTok", account: "@versed.nathan" } })),
    } },
    { kind: "text", text: "Sent 6 slideshows for Nathan to Review." },
  ] },
  { on: "draft the outreach DMs", emit: [
    { kind: "call", tool: "realm-team__review_submit", input: {
      kind: "message", title: "16 outreach DMs from Nathan's account", record: "nathan-beyenhof",
      items: Array.from({ length: 16 }, (_, i) => ({ body: `Hey! Loved your verse-memory video. Want to try Versed's 7-day challenge? (${i + 1})`, target: { channel: "Instagram", account: "@versed.nathan", to: `@reader${i + 1}` } })),
    } },
    { kind: "text", text: "Drafted 16 DMs for Review." },
  ] },
  // An agent trying to post on its own: there is no tool for it.
  { on: "post the first slideshow yourself", emit: [
    { kind: "call", tool: "realm-team__ticket_post", input: { id: "anything" } },
    { kind: "call", tool: "realm-team__review_act", input: { id: "anything" } },
    { kind: "text", text: "I could not post it; there is no tool for that." },
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
      REALM_FAKE_STANDS_IN: "claude",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_FAKE_ACT_ADAPTER: "1",
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

const runsOf = async (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);
const actsLog = () => path.join(home, "fake-acts.jsonl");
const actsSent = () => (fs.existsSync(actsLog()) ? fs.readFileSync(actsLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

async function openReview(c, title) {
  await until(() => evalIn(c, `!!__live.q('[data-review]')`), 10_000, "review list");
  await evalIn(c, `__live.click(__live.qa('[data-review]').find((b) => b.querySelector('.rv-title')?.textContent === ${JSON.stringify(title)}))`);
  await until(() => evalIn(c, `(__live.text('.rv-head h1') ?? '').startsWith(${JSON.stringify(title)})`), 8_000, `reading ${title}`);
}

async function step(c, n) {
  await evalIn(c, `__live.click(__live.radio(${n}))`);
  await until(() => evalIn(c, `/ ${n} of /.test(__live.text('.rv-head h1') ?? '')`), 5_000, `step ${n}`);
}

async function openSheet(c) {
  await evalIn(c, `__live.click(__live.button('^(Post|Send|Send DM)…$'))`);
  await until(() => evalIn(c, `!!__live.q('[role=dialog] .ps')`), 5_000, "post sheet");
}

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  for (let v = 1; v <= 3; v++) {
    const dir = path.join(space.folderPath, DECK, `v${v}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= 7; n++) fs.copyFileSync(path.join(SLIDES_FROM, `s0${((n + v - 2) % 7) + 1}.png`), path.join(dir, `0${n}.png`));
  }

  /* ── P1: six slideshows arrive; Approve all 6 issues six paced tickets ─────────────────────── */
  let team = await api.call("team.make", { spaceId: space.id, templates: ["creator-manager", "content-producer"] });
  const cm = team.roles.find((r) => r.name === "Creator Manager");
  const cp = team.roles.find((r) => r.name === "Content Producer");
  for (const r of [cm, cp]) await api.call("team.roleUpdate", { id: r.id, agentKind: "fake" });
  await api.call("team.roleRun", { id: cm.id, message: "Please keep Nathan's record: he signed contract v3." });
  await until(async () => (await runsOf(cm.id)).every(settled), 30_000, "record run");
  const sched = (await api.call("schedules.list", { spaceId: space.id })).find((s) => s.roleId === cp.id);
  await api.call("schedules.runNow", { id: sched.id });
  await api.call("team.roleRun", { id: cm.id, message: "Please draft the outreach DMs from Nathan's account." });
  await until(async () => (await api.call("team.space", { spaceId: space.id })).reviews.filter((r) => r.state === "waiting").length === 2, 40_000, "two reviews");
  await until(async () => [...await runsOf(cm.id), ...await runsOf(cp.id)].every(settled), 30_000, "runs settle");

  await until(() => evalIn(c, `!!__live.named('^6 slideshows for Nathan in Versed')`), 10_000, "needs you row");
  await evalIn(c, `__live.click(__live.named('^6 slideshows for Nathan in Versed'))`);
  await until(() => evalIn(c, `__live.qa('.rv-slide img').length === 7 && __live.qa('.rv-slide img').every((i) => i.complete && i.naturalWidth > 0)`), 15_000, "slides drawn");
  await evalIn(c, `__live.click(__live.button('^Approve all 6$'))`);
  await until(() => evalIn(c, `/Approved by you/.test(__live.text('.rv-decide-note') ?? '')`), 8_000, "approved");
  const reviews = (await api.call("team.space", { spaceId: space.id })).reviews;
  const slideshows = reviews.find((r) => r.title === "6 slideshows for Nathan");
  let tickets = (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).sort((a, b) => a.ord - b.ord);
  const at = tickets.map((t) => t.slotAt).sort((a, b) => a - b);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  const perDay = Object.values(at.reduce((m, t) => { const k = new Date(t).toDateString(); m[k] = (m[k] ?? 0) + 1; return m; }, {}));
  check("P1 six tickets, one per slideshow, each ready and bound to its approved hash", tickets.length === 6 && tickets.every((t) => t.state === "ready" && t.kind === "post" && /^[0-9a-f]{64}$/.test(t.contentHash)));
  check("P1 paced at least two hours apart", gaps.every((g) => g >= 2 * H), gaps.map((g) => g / H));
  check("P1 at most three a day", perDay.every((n) => n <= 3), perDay);
  check("P1 between 8 AM and 10 PM", at.every((t) => new Date(t).getHours() >= 8 && new Date(t).getHours() < 22), at.map((t) => new Date(t).toString().slice(0, 21)));
  check("P1 the yes sent nothing", actsSent().length === 0);
  const card = await evalIn(c, `__live.text('[data-review="${slideshows.id}"] .rv-state')`);
  check("P1 the card counts what went out", card === "Approved by you · 0 of 6 posted", card);

  /* ── P2: the post sheet ─────────────────────────────────────────────────────────────────────── */
  await step(c, 2);
  await openSheet(c);
  const sheet2 = await evalIn(c, `({
    title: __live.q('[role=dialog]').getAttribute('aria-label'),
    lede: __live.text('.ps-lede'),
    rows: Object.fromEntries(__live.qa('.ps-rows > div').map((r) => [r.querySelector('dt').textContent, r.querySelector('dd').textContent])),
    button: __live.qa('[role=dialog] .btn.primary')[0]?.textContent,
    foot: __live.text('.ps-foot-note'),
    guarded: !!__live.q('[role=dialog] .btn.primary').closest('[data-no-agent]') && !!__live.q('.ps').closest('[data-no-agent]'),
  })`);
  check("P2 the sheet asks the question", sheet2.title === "Post slideshow 2 to TikTok?", sheet2.title);
  check("P2 it names the consequence before the button", /^Realm posts it from Lab iPhone 2, signed in as Nathan Beyenhof's managed account\. It cannot be taken back from Realm; delete it on TikTok\.$/.test(sheet2.lede ?? ""), sheet2.lede);
  check("P2 account, device, slot, caption, disclosure and sign-in", sheet2.rows.Account === "@versed.nathan · TikTok" && sheet2.rows.From === "Lab iPhone 2"
    && /· the next slot for this account(, 2 hours after the one before)?$/.test(sheet2.rows.When ?? "") && /^you read it this morning/.test(sheet2.rows.Caption ?? "")
    && sheet2.rows.Disclosure === "Paid partnership · #ad in the caption" && /the agent never receives it$/.test(sheet2.rows["Sign-in"] ?? ""), sheet2.rows);
  check("P2 the button says the action and the time, not 'now'", /^Post at \d{1,2}:\d{2}\s?[AP]M$|^Post tomorrow at /.test(sheet2.button ?? ""), sheet2.button);
  check("P2 the sheet and its button are out of an agent's reach (data-no-agent)", sheet2.guarded);
  await shot(c, "04-post-sheet-dark");
  await evalIn(c, `__live.click(__live.button('^Cancel$', __live.q('[role=dialog]')))`);
  await until(() => evalIn(c, `!__live.q('[role=dialog]')`), 5_000, "sheet closed");

  /* ── P3: an agent cannot fire a ticket ──────────────────────────────────────────────────────── */
  // What an agent with a shell would do: read the daemon's token and call the method itself.
  const forged = await api.raw("team.ticketPost", { id: tickets[0].id });
  check("P3 the RPC method, called with the token and no press, is refused", !forged.ok && /Only a person's click/.test(forged.error?.message ?? ""), forged.error?.message);
  await api.call("team.roleRun", { id: cp.id, message: "Please post the first slideshow yourself." });
  await until(async () => (await runsOf(cp.id)).every(settled), 20_000, "agent attempt");
  const attempt = (await runsOf(cp.id))[0];
  const ev = await api.call("sessions.events", { id: attempt.sessionId, afterSeq: 0, limit: 500 }).catch(() => []);
  const results = ev.filter((e) => e.event.type === "tool_result").map((e) => JSON.stringify(e.event.payload));
  check("P3 a role asked to post has no tool for it — each call is an unknown tool", results.length >= 2 && results.every((r) => /unknown tool/.test(r)), results.map((r) => r.slice(0, 120)));
  tickets = (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).sort((a, b) => a.ord - b.ord);
  check("P3 nothing went out, and every ticket still waits for its press", actsSent().length === 0 && tickets.every((t) => t.state === "ready"));
  const refusals = (await api.call("team.activity", { spaceId: space.id, limit: 200 })).filter((a) => a.verb === "refused" && a.detail.why === "no_press");
  check("P3 the refusal is a line in the team's log", refusals.length >= 1);

  /* ── P4: one click → one fake post, with proof ─────────────────────────────────────────────── */
  await step(c, 1);
  await openSheet(c);
  const now1 = await evalIn(c, `__live.qa('[role=dialog] .btn.primary')[0]?.textContent`);
  check("P4 the first slot is now", now1 === "Post now", now1);
  await shot(c, "04b-post-sheet-now-dark");
  await evalIn(c, `__live.click(__live.qa('[role=dialog] .btn.primary')[0])`);
  await until(async () => (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).some((t) => t.state === "done"), 15_000, "posted");
  const done = (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).find((t) => t.ord === 0);
  check("P4 one click, one act on the fake platform", actsSent().length === 1 && actsSent()[0].ticketId === done.id && actsSent()[0].files === 7, actsSent().map((a) => a.ticketId));
  check("P4 the ticket keeps its URL and screenshot", /^https:\/\/fake-platform\.invalid\/tiktok\//.test(done.proofUrl ?? "") && !!done.screenshot && fs.existsSync(done.screenshot), { url: done.proofUrl, shot: done.screenshot });
  const acted = (await api.call("team.activity", { spaceId: space.id, limit: 200 })).find((a) => a.verb === "acted");
  check("P4 and so does the log", acted?.detail.url === done.proofUrl && acted?.detail.screenshot === done.screenshot && acted?.detail.hash === done.contentHash, acted?.detail);
  await until(() => evalIn(c, `/^Posted at /.test(__live.text('.rv-decide-note') ?? '')`), 8_000, "posted line");
  const proofUi = await evalIn(c, `({ note: __live.text('.rv-decide-note'), link: __live.q('.rv-decide a.btn')?.getAttribute('href'), shot: !!__live.button('Screenshot'), card: __live.text('[data-review="${slideshows.id}"] .rv-state') })`);
  check("P4 the bar says it went out, with the post and its screenshot", proofUi.link === done.proofUrl && proofUi.shot, proofUi);
  await shot(c, "05-posted-proof-dark");

  await step(c, 2);
  await openSheet(c);
  await evalIn(c, `__live.click(__live.qa('[role=dialog] .btn.primary')[0])`);
  await until(async () => (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).find((t) => t.ord === 1)?.state === "scheduled", 8_000, "scheduled");
  const second = (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).find((t) => t.ord === 1);
  check("P4 the second, pressed, waits for its slot two hours after the first", second.state === "scheduled" && second.slotAt - done.actedAt >= 2 * H - 60_000 && actsSent().length === 1, { slot: new Date(second.slotAt).toString().slice(0, 21) });
  await until(() => evalIn(c, `/^Posts at /.test(__live.text('.rv-decide-note') ?? '')`), 8_000, "scheduled line");
  await shot(c, "06-scheduled-dark");

  /* ── P5: the kill switch ────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.button('Hold posting'))`);
  await until(() => evalIn(c, `/Posting is held/.test(__live.text('.rv-held') ?? '')`), 8_000, "held");
  const held = (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).find((t) => t.ord === 1);
  check("P5 holding takes the pressed post back to waiting", held.state === "ready" && (await api.call("team.space", { spaceId: space.id })).actsHeld === true, held.state);
  const heldPress = await evalIn(c, `window.realm.team.pressTicket(${JSON.stringify({ ticketId: held.id, contentHash: held.contentHash, slotAt: held.slotAt, label: false })})`);
  const heldPost = await api.raw("team.ticketPost", { id: held.id });
  check("P5 a press while held is refused", heldPress === true && !heldPost.ok && /held/.test(heldPost.error?.message ?? ""), heldPost.error?.message);
  await shot(c, "07-held-dark");
  await evalIn(c, `__live.click(__live.button('^Let go$'))`);
  await until(async () => !(await api.call("team.space", { spaceId: space.id })).actsHeld, 8_000, "let go");
  const after = (await api.call("team.tickets", { spaceId: space.id, reviewId: slideshows.id })).find((t) => t.ord === 1);
  check("P5 letting go acts on nothing by itself", after.state === "ready" && actsSent().length === 1);

  /* ── P6: the DM cap ─────────────────────────────────────────────────────────────────────────── */
  const dmReview = reviews.find((r) => r.kind === "message");
  await api.call("team.reviewApprove", { id: dmReview.id });
  let dms = (await api.call("team.tickets", { spaceId: space.id, reviewId: dmReview.id })).sort((a, b) => a.slotAt - b.slotAt);
  const today = Date.now();
  const dmToday = dms.filter((t) => sameDay(t.slotAt, today));
  check("P6 sixteen DMs: at most fifteen planned for a day, three minutes apart", dms.length === 16 && Object.values(dms.reduce((m, t) => { const k = new Date(t.slotAt).toDateString(); m[k] = (m[k] ?? 0) + 1; return m; }, {})).every((n) => n <= 15)
    && dms.slice(1).every((t, i) => t.slotAt - dms[i].slotAt >= 3 * 60_000), { today: dmToday.length, last: new Date(dms[15].slotAt).toString().slice(0, 21) });
  // Fifteen went out earlier today (seeded, as if sent through Realm), and the last DM is pressed for
  // today on a sheet that showed "now" — the cap holds at the press, and nothing is sent.
  const fifteen = dms.slice(0, 15);
  const sql = fifteen.map((t, i) => `UPDATE team_act_tickets SET state = 'done', acted_at = ${today - (15 - i) * 4 * 60_000}, proof_url = 'seeded' WHERE id = '${t.id}';`).join("\n");
  execFileSync("sqlite3", [path.join(home, "realm.db"), sql]);
  const sixteenth = dms[15];
  await evalIn(c, `window.realm.team.pressTicket(${JSON.stringify({ ticketId: sixteenth.id, contentHash: sixteenth.contentHash, slotAt: Date.now(), label: false })})`);
  const dm16 = await api.raw("team.ticketPost", { id: sixteenth.id });
  check("P6 a 16th DM for today is refused at the press, and nothing is sent", !dm16.ok && /15 DMs for the day/.test(dm16.error?.message ?? "") && actsSent().length === 1, dm16.error?.message);
  const dm16After = (await api.call("team.tickets", { spaceId: space.id, reviewId: dmReview.id })).find((t) => t.id === sixteenth.id);
  check("P6 it waits for a slot tomorrow instead", dm16After.state === "ready" && !sameDay(dm16After.slotAt, today), new Date(dm16After.slotAt).toString().slice(0, 21));
  await openReview(c, "16 outreach DMs from Nathan's account");
  await step(c, 16);
  await openSheet(c);
  const dmSheet = await evalIn(c, `({ title: __live.q('[role=dialog]').getAttribute('aria-label'), when: __live.qa('.ps-rows > div').find((r) => r.querySelector('dt').textContent === 'When')?.querySelector('dd').textContent, button: __live.qa('[role=dialog] .btn.primary')[0]?.textContent })`);
  check("P6 its sheet says tomorrow, and why", /^Send this DM to @reader16\?$/.test(dmSheet.title) && /tomorrow · this account's 15 DMs for the day are taken$/.test(dmSheet.when ?? "") && /^Send tomorrow at /.test(dmSheet.button ?? ""), dmSheet);
  await shot(c, "08-dm-sheet-tomorrow-dark");
  await evalIn(c, `__live.click(__live.button('^Cancel$', __live.q('[role=dialog]')))`);

  /* ── P7: light ──────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await until(() => evalIn(c, `!!__live.q('[data-review]')`), 15_000, "review in light");
  await openReview(c, "6 slideshows for Nathan");
  await until(() => evalIn(c, `__live.qa('.rv-slide img').length === 7 && __live.qa('.rv-slide img').every((i) => i.complete && i.naturalWidth > 0)`), 15_000, "slides in light");
  await step(c, 2);
  await openSheet(c);
  await shot(c, "04-post-sheet-light");
  await evalIn(c, `__live.click(__live.button('^Cancel$', __live.q('[role=dialog]')))`);
  await until(() => evalIn(c, `!__live.q('[role=dialog]')`), 5_000, "sheet closed light");
  await step(c, 1);
  await until(() => evalIn(c, `/^Posted at /.test(__live.text('.rv-decide-note') ?? '')`), 8_000, "posted light");
  await shot(c, "05-posted-proof-light");
  await evalIn(c, `__live.click(__live.button('Hold posting'))`);
  await until(() => evalIn(c, `!!__live.q('.rv-held')`), 8_000, "held light");
  await shot(c, "07-held-light");
  await evalIn(c, `__live.click(__live.button('^Let go$'))`);
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
