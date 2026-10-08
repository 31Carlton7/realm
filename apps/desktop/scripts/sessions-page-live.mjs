/**
 * Live check for a space's Sessions page (run with: pnpm build && LIVE_SEED_DB=<copy of a realm.db> \
 *   LIVE_SEED_SPACE=<space id in it> node apps/desktop/scripts/sessions-page-live.mjs)
 *
 * The owner, 10-08, of the page "Show more" opens: "redesign this viewer, it looks ugly". This boots
 * the built app twice on a scratch home. The first boot onboards a space and switches its session to
 * the scripted agent. Between the boots the seed space's sessions and their items are copied in from a
 * READ-ONLY database copy, with the times shifted so the newest is an hour old, so the page carries a
 * real space's shape — leads with sub-agents, archived rows, sessions nothing was sent in — with each
 * session's newest reply, for the line that says where it left off. The second
 * boot starts three scripted sessions (one asks, one fails, one keeps working), then measures the page
 * in both faces and drives it from the keyboard.
 *
 * Nothing is billed: every session is switched to (or created as) the scripted agent before anything
 * could reach it, and the seeded Claude sessions are made scripted too. Ports: LIVE_SERVER_PORT /
 * LIVE_CDP_PORT (8795 / 9235). Scratch under LIVE_SCRATCH, screenshots under LIVE_SHOTS. Kills only
 * what holds its own two ports, and only if it is this run's.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8795);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9235);
const SEED_DB = process.env.LIVE_SEED_DB;
const SEED_SPACE = process.env.LIVE_SEED_SPACE;
if (!SEED_DB || !SEED_SPACE) throw new Error("LIVE_SEED_DB and LIVE_SEED_SPACE are required");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1800, height: 1000 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-sessions-page-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "shots");
const home = path.join(scratch, "home");
const db = path.join(home, "realm.db");
let electron = null;
let api = null;
const daemonPids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

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
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

const HELPERS = `
globalThis.__s = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; },
  rows() { return [...document.querySelectorAll('.space-sessions-list > .space-sessions-item > .space-sessions-row')]; },
  open(label) { return [...document.querySelectorAll('.space-sessions-open')].find((b) => b.getAttribute('aria-label').startsWith(label)) ?? null; },
  count(view) { return Number(document.querySelector('.space-sessions-view input[value="' + view + '"]').closest('label').querySelector('.space-sessions-count').textContent); },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => console.log(`NOTE ${name} ${JSON.stringify(detail)}`);
const frames = (c) => evalIn(c, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: VIEW.height - 5 });
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);
const size = (c, width, height = VIEW.height) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });

const KEYS = { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Enter: 13, Backspace: 8, Escape: 27 };
async function press(c, key, meta = false) {
  const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], modifiers: meta ? 4 : 0 };
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(120);
}

/** A capture as a person would see it: laid over the face's page colour first (design.md). */
async function shot(c, tag, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const data = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(r.data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return data;
}

/**
 * The contrast of a run of text against what is behind it, from pixels: the ground is the commonest
 * colour in the box, the ink the pixel furthest from it. Read off the composited capture, never the
 * stylesheet — what an alpha comes to depends on the ground (design.md).
 */
async function inkContrast(c, selector) {
  const clip = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect();
    return { x: Math.floor(b.left) - 2, y: Math.floor(b.top), width: Math.ceil(b.width) + 4, height: Math.ceil(b.height) }; })()`);
  if (!clip) return null;
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const Y = (i) => 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
    const counts = new Map();
    for (let i = 0; i < px.length; i += 4) { const k = px[i] + ',' + px[i + 1] + ',' + px[i + 2]; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const groundKey = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
    const gi = (() => { for (let i = 0; i < px.length; i += 4) if (px[i] === groundKey[0] && px[i + 1] === groundKey[1] && px[i + 2] === groundKey[2]) return i; })();
    const yg = Y(gi);
    let best = gi, far = 0;
    for (let i = 0; i < px.length; i += 4) { const d = Math.abs(Y(i) - yg); if (d > far) { far = d; best = i; } }
    const yi = Y(best);
    const ratio = (Math.max(yi, yg) + 0.05) / (Math.min(yi, yg) + 0.05);
    return { ratio: +ratio.toFixed(2), ink: [px[best], px[best + 1], px[best + 2]], ground: groundKey };
  })()`);
}

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
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
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  await size(c, VIEW.width);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const daemon = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  if (daemon.pid) daemonPids.push(daemon.pid);
  return c;
}

/** Stop this boot: the daemon first (it outlives its Electron), then the app, then the ports. */
async function stop() {
  try { await api?.call("daemon.stop", {}); } catch { /* already going */ }
  try { api?.close(); } catch { /* gone */ }
  electron?.kill("SIGTERM");
  await sleep(1500);
  electron?.kill("SIGKILL");
  await stopDaemons(home, daemonPids);
  for (const port of [SERVER_PORT, CDP_PORT]) killPort(port);
  await until(async () => (await portFree(SERVER_PORT)) && (await portFree(CDP_PORT)), 15_000, "ports free");
}

const sql = (q) => execFileSync("sqlite3", ["-cmd", ".timeout 5000", db, q], { encoding: "utf8" }).trim();

/** The seed space's sessions and items, into the scratch space, times shifted to end an hour ago. */
function seed(spaceId, environmentId) {
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const src = q(SEED_SPACE);
  const newest = Number(execFileSync("sqlite3", ["-readonly", SEED_DB, `SELECT max(updated_at) FROM sessions WHERE space_id = ${src}`], { encoding: "utf8" }).trim());
  const delta = Date.now() - 3_600_000 - newest;
  sql(`ATTACH ${q(SEED_DB)} AS src;
    INSERT INTO sessions (id, space_id, project_id, agent_kind, model, effort, permission_mode, status, provider_session_id, title, last_event_seq,
      created_at, updated_at, terminal_item_id, environment_id, dispatched_by_kind, dispatched_by_session_id, fast_mode, seen_seq)
    SELECT id, ${q(spaceId)}, NULL, CASE WHEN agent_kind = 'claude' THEN 'fake' ELSE agent_kind END, NULL, NULL, permission_mode, 'idle', NULL, title, last_event_seq,
      created_at + ${delta}, updated_at + ${delta}, NULL, ${q(environmentId)}, dispatched_by_kind, dispatched_by_session_id, fast_mode, seen_seq
    FROM src.sessions WHERE space_id = ${src};
    INSERT INTO items (id, space_id, kind, title, sort_order, pinned, ref_id, created_at, updated_at, archived)
    SELECT id, ${q(spaceId)}, kind, title, sort_order, 0, ref_id, created_at + ${delta}, updated_at + ${delta}, archived
    FROM src.items WHERE kind = 'session' AND ref_id IN (SELECT id FROM src.sessions WHERE space_id = ${src});
    INSERT INTO session_events (session_id, ts, type, payload_json)
    SELECT session_id, ts + ${delta}, type, payload_json FROM src.session_events WHERE seq IN (
      SELECT max(seq) FROM src.session_events WHERE type = 'assistant_text' AND session_id IN (SELECT id FROM src.sessions WHERE space_id = ${src}) GROUP BY session_id);`);
  return Number(sql(`SELECT count(*) FROM items WHERE space_id = ${q(spaceId)} AND kind = 'session'`));
}

const SECTION = `[...document.querySelectorAll('.sb-section')].find((s) => s.getAttribute('aria-label') === 'Versed')`;

async function openPage(c) {
  await until(() => evalIn(c, `!!(${SECTION})?.querySelector('.sb-more')`), 20_000, "Show more");
  const more = await evalIn(c, `Number((${SECTION}).querySelector('.sb-more .item-count').textContent)`);
  const shown = await evalIn(c, `(${SECTION}).querySelectorAll('.item-list > .sb-row').length`);
  await evalIn(c, `(${SECTION}).querySelector('.sb-more').click()`);
  await until(() => evalIn(c, `__s.rows().length > 0`), 15_000, "the Sessions page");
  await park(c);
  await sleep(700);
  return { more, shown };
}

async function setFace(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await c.send("Page.reload", {});
  // Mid-reload the document has no root yet, and asking it throws: that is "not yet", not a failure.
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === '${mode}' && !!document.querySelector('.sb-section')`).catch(() => false), 30_000, `the ${mode} face`);
  await holdKey(c);
  await sleep(600);
}

async function measure(c, mode) {
  const geo = await evalIn(c, `(() => {
    const rows = __s.rows();
    const col = document.querySelector('.space-sessions').getBoundingClientRect();
    // The scroller's content box, which a classic scrollbar narrows on the right.
    const sc = document.querySelector('.page-content');
    const page = sc.closest('.page').getBoundingClientRect();
    const pane = { left: page.left, right: page.right - (sc.offsetWidth - sc.clientWidth) };
    const titles = [...document.querySelectorAll('.space-sessions-list > .space-sessions-item > .space-sessions-row .space-sessions-title')].map((t) => +t.getBoundingClientRect().left.toFixed(2));
    // Idle and read: no state words in its second slot (a reply's line is not a state) and no unread mark.
    const idleRead = rows.filter((r) => { const w = r.querySelector('.space-sessions-snippet');
      return !r.hasAttribute('data-unread') && (!w || (!w.dataset.tone && w.textContent !== 'Working…' && !r.hasAttribute('data-empty'))); });
    return {
      heights: [...new Set(rows.map((r) => +r.getBoundingClientRect().height.toFixed(2)))],
      column: { l: +col.left.toFixed(1), r: +col.right.toFixed(1), w: +col.width.toFixed(1) }, pane: { l: +pane.left.toFixed(1), r: +pane.right.toFixed(1) },
      titleLefts: [...new Set(titles)],
      idleReadWithDot: idleRead.filter((r) => r.querySelector('.status-dot')).length, idleRead: idleRead.length,
      primaries: document.querySelectorAll('.page-overlay .btn.primary').length,
      h1: document.querySelector('.page-title h1').textContent, vantage: document.querySelector('.page-vantage').textContent,
      groups: [...document.querySelectorAll('.space-sessions-head')].map((h) => h.textContent),
      rowCount: rows.length,
    };
  })()`);
  note(`${mode}: geometry`, geo);
  check(`${mode}: every row is 40px tall`, geo.heights.length === 1 && geo.heights[0] === 40, geo.heights);
  check(`${mode}: the column is at most 1,100px and centred in the page`, geo.column.w <= 1100 && Math.abs((geo.column.l - geo.pane.l) - (geo.pane.r - geo.column.r)) <= 2, { column: geo.column, pane: geo.pane });
  check(`${mode}: every title starts on one line`, geo.titleLefts.length === 1, geo.titleLefts);
  check(`${mode}: no idle, read row wears a mark`, geo.idleReadWithDot === 0 && geo.idleRead > 0, { idleRead: geo.idleRead, withDot: geo.idleReadWithDot });
  check(`${mode}: no accent button on a populated page`, geo.primaries === 0, geo.primaries);
  check(`${mode}: the head names the section, with the space beside it`, geo.h1 === "Sessions" && geo.vantage === "Versed", { h1: geo.h1, vantage: geo.vantage });
  const time = await inkContrast(c, '.space-sessions-time');
  check(`${mode}: the time's ink clears 4.5:1 on its ground`, time && time.ratio >= 4.5, time);
  const needs = await inkContrast(c, '.space-sessions-snippet[data-tone="warning"]');
  check(`${mode}: "Needs you" clears 4.5:1 on its ground`, needs && needs.ratio >= 4.5, needs);
  const failed = await inkContrast(c, '.space-sessions-snippet[data-tone="danger"]');
  if (failed) check(`${mode}: "Failed" clears 4.5:1 on its ground`, failed.ratio >= 4.5, failed);
  else note(`${mode}: no failed row on screen to measure`, null);
  const dim = await inkContrast(c, '.space-sessions-row[data-empty] .space-sessions-title');
  check(`${mode}: an empty session's dimmed title clears 4.5:1`, dim && dim.ratio >= 4.5, dim);
  const replies = await evalIn(c, `__s.rows().filter((r) => { const t = r.querySelector('.space-sessions-snippet'); return t && !t.dataset.tone && !r.hasAttribute('data-empty') && t.textContent !== 'Working…'; }).length`);
  check(`${mode}: rows say where they left off`, replies > 10, replies);
}

async function scrollTo(c, label) {
  await evalIn(c, `(() => { __s.open(${JSON.stringify(label)}).scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(300);
}

async function main() {
  // ——— Boot 1: a space, its session made scripted, and the ids to seed into. ———
  let c = await launch();
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Versed');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  const first = await api.call("sessions.listAll", { profileId: null });
  for (const s of first) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  const spaceId = first[0].spaceId;
  const environmentId = first[0].environmentId;
  c.close();
  await stop();

  // ——— Seed. ———
  const seeded = seed(spaceId, environmentId);
  note("seeded session items", seeded);

  // ——— Boot 2. ———
  c = await launch();
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.sb-section')`), 30_000, "sidebar");
  // Live states, all on the scripted agent: one asks, one fails, one keeps working.
  const live = {};
  for (const [name, text] of [["asks", "ask me"], ["fails", "hit the limit"], ["works", "keep working"]]) {
    const { session } = await api.call("sessions.create", { spaceId, agentKind: "fake", title: `Live: ${name}` });
    await api.call("sessions.send", { id: session.id, text });
    live[name] = session.id;
  }
  await sleep(2500);
  const states = await api.call("sessions.listAll", { profileId: null });
  note("the live sessions' states", Object.fromEntries(Object.entries(live).map(([k, id]) => [k, states.find((s) => s.id === id)?.status])));
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    const { more, shown } = await openPage(c);
    const active = await evalIn(c, `__s.count('active')`);
    check(`${mode}: the sidebar's ${shown} rows + Show more ${more} is the page's Active count`, shown + more === active, { shown, more, active });
    await measure(c, mode);
    await evalIn(c, `document.querySelector('.page-content').scrollTop = 0`);
    await sleep(300);
    await shot(c, `page-${mode}`);
    // The rows' states, cropped: the first group holds the live ones.
    const first = await evalIn(c, `__s.box(document.querySelector('.space-sessions-group'))`);
    await shot(c, `row-states-${mode}`, { x: first.l - 8, y: first.t - 4, width: first.w + 16, height: Math.min(first.h + 8, 420) });
    // A lead, folded and unfolded.
    await scrollTo(c, "bible app quiz");
    const lead = await evalIn(c, `__s.box(__s.open('bible app quiz').closest('.space-sessions-item'))`);
    await shot(c, `lead-folded-${mode}`, { x: lead.l - 8, y: lead.t - 90, width: lead.w + 16, height: 220 });
    await evalIn(c, `(() => { __s.open('bible app quiz').closest('.space-sessions-row').querySelector('.space-sessions-agents').click(); return true; })()`);
    await sleep(400);
    const opened = await evalIn(c, `(() => { const li = __s.open('bible app quiz').closest('.space-sessions-item'); return { box: __s.box(li), kids: li.querySelectorAll('.space-sessions-children .space-sessions-row').length }; })()`);
    check(`${mode}: the lead unfolds to its agents`, opened.kids === 6, opened.kids);
    await shot(c, `lead-unfolded-${mode}`, { x: opened.box.l - 8, y: opened.box.t - 90, width: opened.box.w + 16, height: opened.box.h + 180 });
    await evalIn(c, `(() => { __s.open('bible app quiz').closest('.space-sessions-row').querySelector('.space-sessions-agents').click(); return true; })()`);
    await evalIn(c, `document.querySelector('.page-content').scrollTop = 0`);
    await sleep(300);
    // Hover on a row: its actions.
    const hov = await evalIn(c, `__s.box(__s.rows()[1])`);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hov.l + 300, y: hov.t + hov.h / 2 });
    await sleep(300);
    await shot(c, `row-hover-${mode}`, { x: hov.l - 8, y: hov.t - 8, width: hov.w + 16, height: hov.h + 16 });
    await park(c);
    // Archived.
    await evalIn(c, `document.querySelector('.space-sessions-view input[value="archived"]').click()`);
    await sleep(500);
    await evalIn(c, `document.querySelector('.page-content').scrollTop = 0`);
    await sleep(300);
    await shot(c, `archived-${mode}`);
    await evalIn(c, `document.querySelector('.space-sessions-view input[value="active"]').click()`);
    // Search.
    await evalIn(c, `(() => { const f = document.querySelector('.space-sessions-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'paywall'); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(400);
    const hits = await evalIn(c, `__s.rows().map((r) => r.querySelector('.space-sessions-title').textContent)`);
    note(`${mode}: search "paywall"`, hits);
    check(`${mode}: search "paywall" narrows the list`, hits.length >= 1 && hits.length < 5, hits);
    await shot(c, `search-${mode}`, { x: 0, y: 0, width: VIEW.width, height: 420 });
    await evalIn(c, `(() => { const f = document.querySelector('.space-sessions-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    if (mode === "dark") {
      // Narrow: the pane at about 600px — the state words give way, the title keeps its room.
      await size(c, 900);
      await sleep(600);
      const narrow = await evalIn(c, `(() => { const r = __s.rows().find((x) => x.querySelector('.space-sessions-snippet'));
        return { pane: __s.box(document.querySelector('.page')), snippet: r ? getComputedStyle(r.querySelector('.space-sessions-snippet')).display : null,
          title: r ? __s.box(r.querySelector('.space-sessions-title')).w : null }; })()`);
      check("narrow: the state words yield before the title", narrow.snippet === "none" && narrow.title > 60, narrow);
      await shot(c, "narrow-dark");
      await size(c, VIEW.width);
      await sleep(500);
    }
    await evalIn(c, `document.querySelector('.app-rail .rail-btn[aria-label^="Home"]')?.click()`);
    await sleep(500);
  }

  // ——— Drive, in the light face. ———
  await openPage(c);
  const beforeArchived = await evalIn(c, `__s.count('archived')`);
  await evalIn(c, `(() => { document.querySelector('.space-sessions-search input').focus(); return true; })()`);
  await press(c, "ArrowDown");
  await press(c, "ArrowDown");
  const second = await evalIn(c, `document.activeElement.getAttribute('aria-label')`);
  const secondTitle = await evalIn(c, `document.activeElement.querySelector('.space-sessions-title').textContent`);
  note("↓↓ lands on", second);
  // ⌘⌫ archives it, and the keyboard stays on the list.
  await press(c, "Backspace", true);
  await sleep(800);
  const afterArchived = await evalIn(c, `__s.count('archived')`);
  check("⌘⌫ archives: Archived goes up by one", afterArchived === beforeArchived + 1, { beforeArchived, afterArchived });
  check("…and the keyboard lands on the next row", await evalIn(c, `document.activeElement.classList.contains('space-sessions-open')`), await evalIn(c, `document.activeElement.getAttribute('aria-label')`));
  // ↩ opens the row the keyboard is on.
  const target = await evalIn(c, `document.activeElement.querySelector('.space-sessions-title').textContent`);
  await press(c, "Enter");
  await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 8_000, "page put away by the open");
  await sleep(600);
  const bar = await evalIn(c, `[...document.querySelectorAll('.panel-title')].map((e) => e.textContent).join(' | ')`);
  check("↩ opens the session the keyboard is on", bar.includes(target.slice(0, 20)), { target, bar: bar.slice(0, 300) });
  // Archived: ⌘⌫ twice deletes the one just archived.
  await openPage(c);
  await evalIn(c, `document.querySelector('.space-sessions-view input[value="archived"]').click()`);
  await sleep(400);
  await evalIn(c, `(() => { __s.open(${JSON.stringify(secondTitle)}).focus(); return true; })()`);
  await press(c, "Backspace", true);
  const armed = await evalIn(c, `document.activeElement.closest('.space-sessions-row').textContent`);
  check("Archived: the first ⌘⌫ asks", armed.includes("Press ⌘⌫ again"), armed.slice(0, 120));
  await shot(c, "delete-armed-light", await evalIn(c, `(() => { const b = __s.box(document.activeElement.closest('.space-sessions-row')); return { x: b.l - 8, y: b.t - 8, width: b.w + 16, height: b.h + 16 }; })()`));
  await press(c, "Backspace", true);
  // A delete stops the session's engine first, so the count moves when the server has answered.
  const gone = await until(async () => { const n = await evalIn(c, `__s.count('archived')`); return n === afterArchived - 1 ? n : false; }, 8_000, "delete").catch(() => afterArchived);
  check("…and the second deletes it", gone === afterArchived - 1, { afterArchived, gone });
  // → unfolds a lead to its six agents, reachable by ↓.
  await evalIn(c, `document.querySelector('.space-sessions-view input[value="active"]').click()`);
  await sleep(400);
  await evalIn(c, `(() => { __s.open('bible app quiz').focus(); return true; })()`);
  await press(c, "ArrowRight");
  await press(c, "ArrowDown");
  const kid = await evalIn(c, `document.activeElement.getAttribute('aria-label')`);
  check("→ unfolds the lead and ↓ goes into its agents", /, agent(,|$)/.test(kid), kid);
  c.close();
}

/** Kill whatever still listens on one of this run's ports, but only if it is this run's. */
function killPort(port) {
  const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
    if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
}

async function teardown() {
  await stop().catch(() => {});
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.stack ?? e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
