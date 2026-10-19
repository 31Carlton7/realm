/**
 * Live check for Reject and Close in Review (Realm 2.3) — run with:
 *   node apps/desktop/scripts/review-close-live.mjs
 *
 * Boots the BUILT app (run `pnpm build` first) on a scratch home, in the unfocusable scratch window,
 * with the scripted agent standing in for Claude and the fake act adapter for the platforms, so
 * nothing is billed and nothing is sent anywhere, and:
 *
 *   C1  a role sends three batches: two emails to send, a report, and a DM;
 *   C2  the emails are approved, then closed from the dock after the yes: it says what Close takes
 *       back first, and after it the batch is closed with both sends cancelled;
 *   C3  the report is rejected with a reason: the review holds it, and the role is woken with it;
 *   C4  the inbox keeps both under Recent, each with its state — dark and light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8796 / 9236). Screenshots go to LIVE_OUT. It touches only
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9236);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8796);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-review-close-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const SCRATCH_ROOT = process.env.LIVE_SCRATCH ?? OUT_DIR;
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, "run-"));
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


/** The scratch window's red banner says what it is to a person; the captures are of the product. */
async function dropBanner(c) {
  await evalIn(c, `(() => { const hide = () => document.getElementById('live-scratch-banner')?.remove(); hide();
    new MutationObserver(hide).observe(document.body, { childList: true }); return true; })()`);
}

/* ── the scripted agent ─────────────────────────────────────────────────────────────────────────── */

const EMAILS = { label: "replies", title: "Replies to Dana and Lee", items: ["dana@acme.com", "lee@vbv.fm"].map((to) => ({
  files: [], body: `Hi ${to.split("@")[0][0].toUpperCase()}${to.split("@")[0].slice(1)},\n\nThe pilot starts on the 14th. The contract comes from legal on Friday.\n\nCarlton`,
  meta: { Subject: "The pilot's start date" }, action: { connector: "channel:email", verb: "email", account: "carlton@versed.app", to } })) };
const REPORT = { label: "report", title: "Weekly retention report", items: [{ files: [], body: "# Week 41\n\nRetention held at 41%. Streak users retained at 2.3× the rest." }] };
const DM = { label: "DM", title: "Thank-you DM to @reader", items: [{ files: [], body: "thank you for the repost!", action: { connector: "channel:instagram", verb: "dm", account: "@versed.nathan", to: "@reader" } }] };

const SCRIPT = [
  { on: "send the three batches", emit: [
    ...[EMAILS, REPORT, DM].map((s) => ({ kind: "call", tool: "realm-team__review_submit", input: s })),
    { kind: "usage", costUsd: 0.12 },
    { kind: "text", text: "Sent three reviews." },
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
      REALM_LIVE_SCRATCH: "1",
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
  await dropBanner(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const runsOf = async (roleId) => api.call("team.roleRuns", { id: roleId, limit: 30 });
const settled = (r) => !["queued", "running", "blocked"].includes(r.state);

/** The Review pane, from the sidebar's Review row. */
async function openReview(c) {
  await until(() => evalIn(c, `!!__live.named('^Review — ')`), 15_000, "review row");
  await evalIn(c, `__live.click(__live.named('^Review — '))`);
  await until(() => evalIn(c, `!!__live.q('.rv-list')`), 10_000, "review pane");
}

/** Read one review: its row chosen, its reader and dock drawn, and past the beat in which Approve
 *  ignores a press (the tail of a double click aimed at the review before). */
async function select(c, id) {
  await evalIn(c, `__live.click(__live.q('[data-review="${id}"]'))`);
  await until(() => evalIn(c, `__live.q('[data-review="${id}"]')?.hasAttribute('data-selected') && !!__live.q('.rv-detail[aria-labelledby="rv-title-${id}"] .rv-dock')`), 8_000, `select ${id}`);
  await sleep(400);
}

/** The decision dock: what it says, what it asks while a Close or a Reject is open, and its buttons. */
const bar = (c) => evalIn(c, `({ note: __live.text('.rv-dock-note'), ask: __live.text('.rv-dock[data-asking] .rv-dock-ask'), buttons: __live.qa('.rv-dock button').map((b) => b.textContent.trim()) })`);
const dockButton = (text) => `__live.button('${text}', __live.q('.rv-dock'))`;

let liveC = null;
async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  check("onboarding made Versed", !!space);
  await api.call("team.make", { spaceId: space.id, templates: [] });
  const role = await api.call("team.roleCreate", { spaceId: space.id, name: "Content Producer", brief: "Make what the team asks for and send it to Review.", realmite: { seed: "content-producer-32" }, agentKind: "fake", model: "sonnet" });

  /* ── C1 ── */
  await api.call("team.roleRun", { id: role.id, message: "Please send the three batches for the close check." });
  await until(async () => (await runsOf(role.id)).length > 0 && (await runsOf(role.id)).every(settled), 40_000, "run settles");
  const team = await api.call("team.space", { spaceId: space.id });
  const byTitle = Object.fromEntries(team.reviews.map((r) => [r.title, r]));
  check("C1 three batches arrived, all waiting", team.reviews.length === 3 && team.reviews.every((r) => r.state === "waiting"), team.reviews.map((r) => `${r.title}:${r.state}`));
  const mail = byTitle[EMAILS.title], report = byTitle[REPORT.title], dm = byTitle[DM.title];

  await openReview(c);
  await select(c, report.id);
  const waitingBar = await bar(c);
  check("C1 a waiting batch offers Close, Reject…, Send back… and Approve", ["Close", "Reject…", "Send back…", "Approve"].every((b) => waitingBar.buttons.includes(b)), waitingBar);
  await shot(c, "01-waiting-bar-dark");

  /* ── C2: approve the emails, then close them before they go ── */
  await select(c, mail.id);
  await evalIn(c, `__live.click(__live.q('.rv-dock .rv-approve'))`);
  await until(() => evalIn(c, `/Approved by you/.test(__live.text('.rv-dock-note') ?? '')`), 8_000, "approved");
  const issued = (await api.call("team.review", { id: mail.id })).tickets;
  check("C2 the yes issued two email tickets, each waiting for its press", issued.length === 2 && issued.every((t) => t.kind === "email" && t.state === "ready"), issued.map((t) => `${t.kind}:${t.state}`));
  await shot(c, "02-approved-dark");
  await evalIn(c, `__live.click(${dockButton("Close")})`);
  await until(() => evalIn(c, `!!__live.q('.rv-dock[data-asking="close"]')`), 5_000, "close strip");
  const strip = await bar(c);
  check("C2 the dock says what Close takes back before it does", /Takes back all 2 not sent yet/.test(strip.ask ?? ""), strip);
  await shot(c, "03-close-strip-dark");
  await evalIn(c, `__live.click(__live.button('Close', __live.q('.rv-dock[data-asking="close"]')))`);
  await until(async () => (await api.call("team.review", { id: mail.id })).state === "closed", 8_000, "closed");
  const closed = await api.call("team.review", { id: mail.id });
  const ticketRows = closed.tickets;
  check("C2 closed: no ticket left to press", ticketRows.length === 0, ticketRows.map((t) => t.state));
  // Out of Waiting for you, the reader moves on to the next one waiting, as Mail does after an archive.
  await until(() => evalIn(c, `!__live.q('.rv-detail[aria-labelledby="rv-title-${mail.id}"]')`), 8_000, "moved on");
  await select(c, mail.id);
  await until(() => evalIn(c, `/You closed it/.test(__live.text('.rv-dock-note') ?? '')`), 8_000, "closed line");
  const after = await bar(c);
  check("C2 a closed batch's dock offers no decision, and says nothing goes out", after.buttons.length === 0 && /Nothing of it goes out/.test(after.note ?? ""), after);
  await shot(c, "04-closed-dark");

  /* ── C3: reject the report, with a reason ── */
  await select(c, report.id);
  await evalIn(c, `__live.click(${dockButton("Reject…")})`);
  await until(() => evalIn(c, `!!__live.q('.rv-dock[data-asking="reject"] textarea')`), 5_000, "reject strip");
  await evalIn(c, `__live.set(__live.q('.rv-dock[data-asking="reject"] textarea'), 'We stopped tracking retention weekly; send it monthly.')`);
  await shot(c, "05-reject-strip-dark");
  await evalIn(c, `__live.click(${dockButton("Reject and tell Content Producer")})`);
  await until(async () => (await api.call("team.review", { id: report.id })).state === "rejected", 8_000, "rejected");
  const rej = await api.call("team.review", { id: report.id });
  check("C3 rejected, the reason kept", rej.note === "We stopped tracking retention weekly; send it monthly.", rej.note);
  const woke = (await api.call("team.activity", { spaceId: space.id, limit: 40 })).filter((a) => a.verb === "woke" && a.detail.wokeOn === "review");
  check("C3 the role was woken with the reason", woke.some((a) => /monthly/.test(a.detail.note ?? "")), woke.map((a) => a.detail.note));
  await until(() => evalIn(c, `!__live.q('.rv-detail[aria-labelledby="rv-title-${report.id}"]')`), 8_000, "moved on from the report");
  await select(c, report.id);
  await until(() => evalIn(c, `/You rejected it/.test(__live.text('.rv-dock-note') ?? '')`), 8_000, "rejected line");
  await shot(c, "06-rejected-dark");
  await until(async () => (await runsOf(role.id)).every(settled), 40_000, "woken run settles");

  /* ── C4: history, dark then light ── */
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.app-rail')`).catch(() => false), 30_000, "reload");
  await holdKey(c); await dropBanner(c);
  await openReview(c);
  const recent = await evalIn(c, `__live.qa('.rv-group[data-group="recent"] [data-review]').map((r) => r.dataset.review)`);
  const states = await evalIn(c, `Object.fromEntries(__live.qa('.rv-row[data-review]').map((row) => [row.dataset.review, row.querySelector('.rv-row-what').textContent]))`);
  check("C4 the inbox keeps a week of what was let go, under Recent", recent.includes(mail.id) && recent.includes(report.id) && states[mail.id] === "Closed by you"
    && states[report.id] === "Rejected · “We stopped tracking retention weekly; send it monthly.”", { recent, states });
  await select(c, mail.id);
  await shot(c, "07-history-closed-dark");

  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c); await dropBanner(c);
  await openReview(c);
  await select(c, mail.id);
  await shot(c, "07-history-closed-light");
  await select(c, report.id);
  await shot(c, "06-rejected-light");
  await select(c, dm.id);
  await evalIn(c, `__live.click(${dockButton("Close")})`);
  await until(() => evalIn(c, `!!__live.q('.rv-dock[data-asking="close"]')`), 5_000, "close strip light");
  await shot(c, "03-close-strip-light");
  await evalIn(c, `__live.click(${dockButton("Cancel")})`);
  await evalIn(c, `__live.click(${dockButton("Reject…")})`);
  await until(() => evalIn(c, `!!__live.q('.rv-dock[data-asking="reject"] textarea')`), 5_000, "reject strip light");
  await shot(c, "05-reject-strip-light");
  check("C4 the DM, never decided, is still waiting", (await api.call("team.review", { id: dm.id })).state === "waiting");
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
