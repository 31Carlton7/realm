/**
 * Live check for Undo after Approve, toasts' words selecting, and toasts above Review's decision bar —
 * run with:
 *   node apps/desktop/scripts/review-undo-live.mjs
 *
 * Boots the BUILT app (run `pnpm build` first) on a scratch home. Every role runs on the scripted
 * agent and the act adapter is the fake one (REALM_FAKE_ACT_ADAPTER=1), so nothing is billed and
 * nothing reaches a platform. In each face it:
 *
 *   U1  approves a note, then takes the yes back from the toast's Undo: the row folds back into
 *       Waiting for you, the reader goes back to it, and the log says so
 *   U2  drags across the toast's words: they select, its buttons do not, and nothing else happens
 *   U3  approves two posts and presses the first: Undo still stands while it only waits for its slot;
 *       once it has gone out the toast drops the offer and the server refuses with a plain line
 *   U4  in a narrow pane, approves, goes back to the inbox and opens another review: the toast
 *       moves above the decision bar that appears under it
 *
 * Posts are planned between 8 AM and 10 PM, so a press made outside those hours waits for 8 AM. U3
 * presses for real and then writes the act as the platform would leave it, so the check does not
 * depend on the hour; the act service's own path (done, acting, refused) is tested in
 * apps/server/src/team/review-undo.test.ts.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8823 / 9263). Screenshots go to LIVE_OUT. It touches only
 * its own scratch home, and kills only what holds its own two ports AND names its scratch home.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9263);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8823);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-review-undo-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-review-undo-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/** Kill what listens on `port` — only a process whose command line names this run's scratch home or
 *  this worktree, so another check's server, or the owner's Realm, is never the one that goes. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (!command.includes(repoRoot) && !command.includes(scratch)) { console.log(`LEFT ${pid} on ${port}: not this run's`); continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(re, root = document) { return [...root.querySelectorAll('button')].find((b) => new RegExp(re).test(b.textContent.trim()) && !b.disabled) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
  rect(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; },
  undoToast: () => [...document.querySelectorAll('.toast')].find((t) => !t.hasAttribute('data-leaving') && [...t.querySelectorAll('.toast-action')].some((b) => b.textContent.trim() === 'Undo')) ?? null,
  group: (id) => document.querySelector('[data-review="' + id + '"]')?.closest('.rv-group')?.dataset.group ?? null,
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception in ${expr.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A capture, cut to `clip` (with a margin) when given: the part of the window a claim is about. */
async function shot(c, tag, clip = null) {
  await sleep(500);
  const params = { format: "png" };
  if (clip) {
    const pad = 24;
    const vw = await evalIn(c, "({ w: innerWidth, h: innerHeight })");
    const x = Math.max(0, clip.x - pad), y = Math.max(0, clip.y - pad);
    params.clip = { x, y, width: Math.min(vw.w - x, clip.width + 2 * pad), height: Math.min(vw.h - y, clip.height + 2 * pad), scale: 1 };
  }
  const r = await c.send("Page.captureScreenshot", params);
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${out}`);
}

async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

const size = (c, width, height = 900) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
const mouse = (c, type, x, y, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", ...extra });

/* ── the scripted roles ─────────────────────────────────────────────────────────────────────────── */

const D = "drafts";
const NATHAN_TT = { channel: "TikTok", account: "@versed.nathan" };
const slides = (show, n) => Array.from({ length: n }, (_, i) => `${D}/slides/${show}-${i + 1}.png`);
const call = (input) => ({ kind: "call", tool: "realm-team__review_submit", input });
const PRODUCER = [
  { title: "Launch posts for Friday", kind: "slideshows", record: "nathan-beyenhof", items: [1, 2].map((n) => ({ files: slides(n, 3), body: `versed is live 🎉 part ${n}: a verse a day, read out loud with me #ad`, target: NATHAN_TT })) },
  { title: "Sunday recap slideshows", kind: "slideshows", record: "nathan-beyenhof", items: [3, 4].map((n) => ({ files: slides(n, 3), body: `this week's verses, in one place, part ${n - 2} #ad`, target: NATHAN_TT })) },
];
const ANALYST = [
  { title: "Does a 7-day streak predict retention?", label: "answer", items: [{ files: [], body: "# Short answer: yes, but not on its own\n\nPeople who keep a **7-day streak** in their first two weeks are still reading at day 30 at **2.3×** the rate of those who don't." }] },
  { title: "Retention report, week 41", label: "report", items: [{ files: [`${D}/retention-week-41.md`] }] },
  { title: "Reply to Dana at Acme", label: "replies", items: [{ files: [], body: "Hi Dana,\n\nThe pilot starts on Wednesday the 14th, as we agreed.\n\nCarlton", meta: { Subject: "Pilot start date" }, action: { connector: "mcp:gmail", tool: "send_message", verb: "send", account: "carlton@versed.app", to: "dana@acme.com" } }] },
];
const SCRIPT = [
  { on: "make the posts", emit: [...PRODUCER.map(call), { kind: "text", text: "Two batches are in Review." }] },
  { on: "write up retention", emit: [...ANALYST.map(call), { kind: "text", text: "Three drafts are in Review." }] },
];

function makeFiles(folder) {
  const dir = path.join(folder, D);
  fs.mkdirSync(path.join(dir, "slides"), { recursive: true });
  const product = path.join(repoRoot, "site/public/product");
  const caps = fs.readdirSync(product).filter((f) => f.endsWith("-1440.webp")).sort();
  let n = 0;
  for (let show = 1; show <= 4; show++) for (let s = 1; s <= 3; s++) {
    execFileSync("sips", ["-s", "format", "png", "-c", "900", "506", path.join(product, caps[n++ % caps.length]), "--out", path.join(dir, "slides", `${show}-${s}.png`)], { stdio: "ignore" });
  }
  fs.writeFileSync(path.join(dir, "retention-week-41.md"), "# Retention, week 41\n\nDay-7 retention held at 41%. Day-30 rose two points, to 18%.\n");
}

const NATHAN = ["# Nathan Beyenhof", "- Status: signed · contract v3", "", "## Accounts",
  "- TikTok @versed.nathan · vault: tiktok.com/nathan · device: Lab iPhone 2 · consent: contract §4", ""].join("\n");

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
  await until(() => evalIn(c, "!!document.documentElement").catch(() => false), 15_000, "document");
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  // The space's name, and nothing typed into onboarding's own session: its engine is a real one.
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await size(c, 1440);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

async function theme(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.app-rail')`).catch(() => false), 30_000, "reload");
  await holdKey(c);
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === '${mode}'`).catch(() => false), 10_000, `${mode} face`);
}

const runsOf = (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);
async function runRole(role, message) {
  const before = (await runsOf(role.id)).length;
  await api.call("team.roleRun", { id: role.id, message });
  await until(async () => { const runs = await runsOf(role.id); return runs.length > before && runs.every(settled); }, 40_000, `${role.name} settles`);
}

async function openReview(c) {
  if (await evalIn(c, `!!__live.q('.rv')`)) return;
  await until(() => evalIn(c, `!!__live.q('[aria-label^="Review"]')`), 15_000, "review row");
  await evalIn(c, `__live.click(__live.q('[aria-label^="Review"]'))`);
  await until(() => evalIn(c, `!!__live.q('.rv')`), 15_000, "review pane");
}

/** Read one review: its row clicked, and its reader and dock drawn. */
async function read(c, id, title) {
  await evalIn(c, `__live.click(__live.q('[data-review="${id}"]'))`);
  await until(() => evalIn(c, `__live.text('.rv-title') === ${JSON.stringify(title)} && !!__live.q('.rv-dock')`), 15_000, `reading ${title}`);
  await sleep(500); // past the beat in which Approve is taken as the tail of a double click
}

const reviewsOf = async (spaceId) => (await api.call("team.space", { spaceId })).reviews;

async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  makeFiles(space.folderPath);
  await api.call("team.make", { spaceId: space.id, templates: [] });
  const role = (name, seed, brief) => api.call("team.roleCreate", { spaceId: space.id, name, brief, realmite: { seed }, agentKind: "fake", model: "sonnet", cron: "0 9 * * 1-5" });
  const producer = await role("Content Producer", "content-producer-32", "Make slideshows for each signed creator and send each batch to Review.");
  const analyst = await role("Analyst", "analyst-3", "Answer the team's questions and send each answer to Review.");
  await api.call("team.recordCreate", { spaceId: space.id, name: "Nathan Beyenhof" });
  await api.call("team.recordWrite", { spaceId: space.id, path: "creators/nathan-beyenhof.md", markdown: NATHAN });
  await runRole(producer, "Please make the posts.");
  await runRole(analyst, "Please write up retention.");
  const reviews = await reviewsOf(space.id);
  const by = (title) => reviews.find((r) => r.title === title);
  check("five reviews arrived, all waiting", reviews.length === 5 && reviews.every((r) => r.state === "waiting"), reviews.map((r) => `${r.title}:${r.state}`));
  await openReview(c);

  for (const mode of (process.env.LIVE_FACES ?? "dark,light").split(",")) {
    if (mode === "light") { await theme(c, "light"); await openReview(c); }
    await size(c, 1440);
    await until(() => evalIn(c, `__live.qa('[data-review]').length >= 5`), 15_000, "inbox rows");

    /* ── U1: approve a note, then Undo from its toast ────────────────────────────────────────────── */
    const note = by("Does a 7-day streak predict retention?");
    await read(c, note.id, note.title);
    await evalIn(c, `__live.click(__live.button('^Approve'))`);
    await until(() => evalIn(c, `!!__live.undoToast()`), 8_000, "approval toast with Undo");
    const decided = await evalIn(c, `({ title: __live.text('.rv-title'), group: __live.group(${JSON.stringify(note.id)}), toast: __live.undoToast().querySelector('.toast-text').textContent })`);
    check(`U1 ${mode}: the yes's toast offers Undo, and the reader moved on`, decided.group === "recent" && decided.title !== note.title && decided.toast === `Approved “${note.title}”.`, decided);

    /* ── U2: the toast's words select; its buttons do not; nothing else happens ──────────────────── */
    // Where the words are once the toast has finished rising: two reads a beat apart that agree.
    let box = null;
    await until(async () => {
      const a = await evalIn(c, `__live.rect(__live.undoToast().querySelector('.toast-text'))`);
      await sleep(150);
      box = await evalIn(c, `__live.rect(__live.undoToast().querySelector('.toast-text'))`);
      return a.y === box.y && a.x === box.x;
    }, 5_000, "toast settled");
    // The pointer comes in from the work, as a person's does: the synthetic pointer's place from
    // before the theme's reload is otherwise taken as already over the stack, and no enter is seen.
    await mouse(c, "mouseMoved", 700, 300);
    await sleep(100);
    await mouse(c, "mouseMoved", box.x + 2, box.y + 4);
    await sleep(100);
    await mouse(c, "mousePressed", box.x + 1, box.y + 4, { clickCount: 1 });
    await mouse(c, "mouseMoved", box.right - 1, box.bottom - 4, { button: "left", buttons: 1 });
    await mouse(c, "mouseReleased", box.right - 1, box.bottom - 4, { clickCount: 1 });
    const sel = await evalIn(c, `(() => { const t = __live.undoToast(); return {
      selected: getSelection().toString(), words: t?.querySelector('.toast-text').textContent ?? null,
      textSelect: getComputedStyle(t.querySelector('.toast-text')).userSelect,
      buttonSelect: [...t.querySelectorAll('button')].map((b) => getComputedStyle(b).userSelect),
      leaving: t.hasAttribute('data-leaving'), paused: t.hasAttribute('data-paused'),
      expanded: __live.q('.toasts').hasAttribute('data-expanded'), hover: __live.q('.toasts').matches(':hover'), toasts: __live.qa('.toast').length }; })()`);
    const stillApproved = (await api.call("team.review", { id: note.id })).state;
    check(`U2 ${mode}: the words select, the buttons don't, and the toast and its Undo are left alone`,
      sel.selected.length > 10 && sel.words.includes(sel.selected.trim()) && sel.textSelect === "text" && sel.buttonSelect.every((s) => s === "none")
        && !sel.leaving && sel.paused && stillApproved === "approved", { ...sel, stillApproved });
    await shot(c, `02-toast-selected-${mode}`, await evalIn(c, `__live.rect(__live.undoToast())`));
    await evalIn(c, `__live.click(__live.undoToast().querySelector('.toast-action'))`);
    await mouse(c, "mouseMoved", 700, 300);
    await until(async () => (await api.call("team.review", { id: note.id })).state === "waiting", 8_000, "undone on the server");
    await until(() => evalIn(c, `__live.text('.rv-title') === ${JSON.stringify(note.title)} && __live.group(${JSON.stringify(note.id)}) === 'waiting'`), 8_000, "reader back on it");
    const log = (await api.call("team.activity", { spaceId: space.id, limit: 50 })).filter((a) => a.verb === "undid_approval" && a.detail.reviewId === note.id);
    const dock = await evalIn(c, `({ approve: !!__live.button('^Approve', __live.q('.rv-dock')), pill: __live.text('.rv-pill') })`);
    check(`U1 ${mode}: Undo folds the row back into Waiting for you, the reader returns, and the log says so`,
      dock.approve && dock.pill === "Waiting for you" && log.length === (mode === "dark" ? 1 : 2), { ...dock, lines: log.length });
    await shot(c, `03-undone-${mode}`);

    /* ── U3: a post pressed, then gone out ───────────────────────────────────────────────────────── */
    const posts = by(mode === "dark" ? "Launch posts for Friday" : "Sunday recap slideshows");
    await read(c, posts.id, posts.title);
    await evalIn(c, `__live.click(__live.button('^Approve all 2'))`);
    await until(() => evalIn(c, `!!__live.undoToast()`), 8_000, "post approval toast");
    // The pointer on the stack holds every toast's clock while the post is pressed and goes out.
    const stack = await evalIn(c, `__live.rect(__live.q('.toasts'))`);
    await mouse(c, "mouseMoved", stack.x + stack.width / 2, stack.bottom - 12);
    await until(() => evalIn(c, `!!__live.button('^Post…')`), 8_000, "Post… button");
    await evalIn(c, `__live.click(__live.button('^Post…'))`);
    await until(() => evalIn(c, `!!__live.q('[role=dialog] .btn.primary') && !__live.q('[role=dialog] .btn.primary').disabled`), 5_000, "post sheet");
    const pressLabel = await evalIn(c, `__live.text('[role=dialog] .btn.primary')`);
    await evalIn(c, `__live.click(__live.q('[role=dialog] .btn.primary'))`);
    const ticketsOf = async () => (await api.call("team.tickets", { spaceId: space.id, reviewId: posts.id })).sort((a, b) => a.ord - b.ord);
    await until(async () => (await ticketsOf())[0]?.state === "scheduled" || (await ticketsOf())[0]?.state === "done", 8_000, "pressed");
    const first = (await ticketsOf())[0];
    await sleep(600);
    const pressedOffer = await evalIn(c, `!!__live.undoToast()`);
    check(`U3 ${mode}: pressed for its slot and not yet out, the Undo still stands`, first.state === "scheduled" && pressedOffer, { press: pressLabel, state: first.state, offer: pressedOffer });
    await shot(c, `04-pressed-undo-stands-${mode}`);
    // The platform's answer, written as the act leaves it: out, with its proof, and a line in the log.
    const proof = path.join(scratch, "proof.png");
    fs.copyFileSync(path.join(space.folderPath, D, "slides", "1-1.png"), proof);
    const at = Date.now();
    const url = `https://fake-platform.invalid/tiktok/versed.nathan/${first.id}`;
    const detail = JSON.stringify({ ticketId: first.id, reviewId: posts.id, kind: "post", channel: "TikTok", account: "@versed.nathan", url, screenshot: proof, hash: first.contentHash });
    execFileSync("sqlite3", [path.join(home, "realm.db"), `UPDATE team_act_tickets SET state = 'done', acted_at = ${at}, proof_url = '${url}', screenshot = '${proof}', updated_at = ${at} WHERE id = '${first.id}';
      INSERT INTO team_activity (id, space_id, ts, actor, run_id, session_id, verb, object, detail_json) VALUES ('live-acted-${mode}', '${space.id}', ${at}, 'realm', NULL, NULL, 'acted', '@versed.nathan', '${detail}');`]);
    // Rows written behind the server's back: a change to the team's week makes the window read it again.
    await api.call("team.setBudget", { spaceId: space.id, weekBudgetUsd: 60 });
    await until(() => evalIn(c, `/^Posted at /.test(__live.text('.rv-dock-note') ?? '')`), 8_000, "posted line");
    await until(() => evalIn(c, `!__live.undoToast()`), 8_000, "the Undo withdrawn");
    let refused = null;
    try { await api.call("team.reviewUndoApproval", { id: posts.id }); } catch (e) { refused = e.message; }
    const after = await api.call("team.review", { id: posts.id });
    check(`U3 ${mode}: once a post went out the toast drops its Undo, and the server refuses in a plain line`,
      refused === "team.reviewUndoApproval: It's too late to undo: a post already went out. Close stops whatever hasn't gone out." && after.state === "approved", { refused, state: after.state });
    await mouse(c, "mouseMoved", 700, 300);
    await shot(c, `05-posted-no-undo-${mode}`);

    /* ── U4: narrow — approve, back to the inbox, open another: the toast stands above the new bar ── */
    await size(c, 860);
    await sleep(400);
    const dana = by("Reply to Dana at Acme");
    // Not the review the reader moves on to after the yes (the report), so the bar is a new one in the DOM.
    const other = by("Does a 7-day streak predict retention?");
    if (await evalIn(c, `!!__live.button('All reviews')`)) await evalIn(c, `__live.click(__live.button('All reviews'))`);
    await read(c, dana.id, dana.title);
    await evalIn(c, `__live.click(__live.button('^Approve'))`);
    await until(() => evalIn(c, `!!__live.undoToast()`), 8_000, "narrow approval toast");
    await evalIn(c, `__live.click(__live.button('All reviews'))`);
    await sleep(400);
    await read(c, other.id, other.title);
    await sleep(600);
    const geo = await evalIn(c, `({ toast: __live.rect(__live.q('.toast[data-front]')), bar: __live.rect(__live.q('.rv-dock-card')), answers: __live.rect(__live.q('.rv-dock-actions')) })`);
    const overlaps = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    check(`U4 ${mode}: a decision bar that arrives under a toast takes it up above, never under`,
      !!geo.toast && !!geo.bar && !overlaps(geo.toast, geo.bar) && geo.toast.bottom <= geo.bar.y, geo);
    await shot(c, `06-narrow-toast-above-bar-${mode}`);
    // Undone over the socket, so the next face starts from the same inbox.
    await api.call("team.reviewUndoApproval", { id: dana.id });
    await size(c, 1440);
  }
  const sent = fs.existsSync(path.join(home, "fake-acts.jsonl")) ? fs.readFileSync(path.join(home, "fake-acts.jsonl"), "utf8").trim() : "";
  check("nothing reached even the fake platform: the act was written, not made", sent === "", sent.slice(0, 120));
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    killPort(SERVER_PORT); killPort(CDP_PORT);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
