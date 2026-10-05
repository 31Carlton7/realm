/**
 * Live check: saving a turn from the scroll track, and finding it again in the Library
 * (run with: pnpm build && node apps/desktop/scripts/saved-turns-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and seeds, straight into its database, a session of
 * forty turns and, in a second space, one of sixteen. Then, in the real window: the bookmark on a tick's
 * card saves the turn and fills, the tick takes the accent, and the server holds the prompt's event
 * (read back over RPC and out of the database itself); S saves the turn the keyboard is on; ⌥↓ and
 * ⌥↑ step between saved turns and bring each one's row to the top; a reload keeps them; the Library's
 * Saved section lists every saved turn of both sessions, newest saved first, follows a save made
 * elsewhere while it is up, and a click opens its session AT the prompt, across spaces too; the ribbon
 * there unsaves, and so do S and the card's bookmark — and both faces are captured.
 *
 * Ports: LIVE_SERVER_PORT (8811), LIVE_CDP_PORT (9251). Writes only under LIVE_SCRATCH (the OS temp dir
 * by default). Nothing is billed: the onboarding session is moved to the fake agent before anything is
 * sent, nothing is sent at all, and the seeded sessions are on the fake agent.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9251);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8811);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-saved-turns-live-"));
const home = path.join(scratch, "home");
const OUTDIR = process.env.LIVE_OUT ?? path.join(scratch, "shots");
fs.mkdirSync(OUTDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
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

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
  });
  return {
    ready, errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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

const ASKS = [
  "Fix the org access crash path when a member has been removed",
  "Why does the import job time out on large CSVs?",
  "Rename the membership helper everywhere",
  "Add a test for the invite expiry",
  "Make the settings page load the theme before first paint",
  "What does the compaction step drop from the context?",
  "Split the billing service into reads and writes",
  "Draft the release notes for 2.0",
];
const ANSWERS = [
  "Done — renamed it, and the two call sites in the CLI now use the new name.",
  "The membership check ran **before** the organisation loaded, so a removed member hit a null. It now loads the org first and returns a 404 for anyone who is no longer in it.",
  "It times out because the parser buffers the whole file before it validates a row. Streaming it fixes that, and memory stays flat at about 90 MB the whole way through.",
  "Here is the split:\n\n1. `billing/reads.ts` — invoices, usage and the plan lookup.\n2. `billing/writes.ts` — charges, refunds and plan changes, each in a transaction.",
];
const turnsOf = (n, start, label) => Array.from({ length: n }, (_, i) => ({
  at: start + i * 5 * 60_000, asked: `${ASKS[i % ASKS.length]}${label ? ` — ${label} ${i + 1}` : ` (${i + 1})`}`, answer: ANSWERS[i % ANSWERS.length],
}));

function seed(sessionId, turns) {
  const ev = [];
  for (const t of turns) {
    ev.push([t.at, "user_message", { text: t.asked, attachments: [] }]);
    ev.push([t.at + 1_000, "status", { status: "running" }]);
    ev.push([t.at + 4_000, "assistant_text", { messageId: `m${t.at}`, text: t.answer }]);
    ev.push([t.at + 5_000, "status", { status: "idle" }]);
  }
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const sql = ev.map(([ts, type, payload]) => `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(sessionId)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))});`);
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), `BEGIN;\n${sql.join("\n")}\nCOMMIT;`]);
}
const savedRows = () => execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), "SELECT event_seq FROM saved_turns ORDER BY event_seq;"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean).map(Number);

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; },
  centre(el) { const b = __live.box(el); return b && { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) }; },
  pane: (asked) => [...document.querySelectorAll(".session-pane")].find((p) => p.getBoundingClientRect().width > 0 && [...p.querySelectorAll(".msg-user")].some((m) => m.textContent.startsWith(asked))) ?? null,
  frames: (n = 2) => new Promise((r) => { const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step)); step(); }),
  ticks: (pane) => [...(pane?.querySelectorAll(".scroll-track .track-tick") ?? [])],
  /** A pane's track: how many ticks, which is lit, which are saved, where the keyboard is, and each line's ink. */
  track(pane) {
    const ticks = __live.ticks(pane);
    return { n: ticks.length, current: ticks.findIndex((k) => k.hasAttribute("data-current")), saved: ticks.flatMap((k, i) => (k.hasAttribute("data-saved") ? [i] : [])),
      described: ticks.flatMap((k, i) => (k.getAttribute("aria-description") === "Saved" ? [i] : [])),
      focused: ticks.indexOf(document.activeElement), wrap: __live.box(pane?.querySelector(".transcript-wrap")),
      inks: ticks.map((k) => getComputedStyle(k.querySelector(".track-line")).backgroundColor) };
  },
  tickAt(pane, i) { const l = __live.ticks(pane)[i].querySelector(".track-line"); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) }; },
  card(pane) {
    const c = pane.querySelector(".track-card"); const b = c?.querySelector(".track-card-save");
    return c && { open: c.hasAttribute("data-open"), box: __live.box(c), title: c.querySelector(".track-card-title")?.textContent, foot: c.querySelector(".track-card-foot")?.textContent,
      save: b && { pressed: b.getAttribute("aria-pressed"), box: __live.box(b), at: __live.centre(b), fill: getComputedStyle(b.querySelector("svg path")).fill, colour: getComputedStyle(b).color,
        under: (() => { const m = __live.centre(b); return document.elementFromPoint(m.x, m.y)?.closest(".track-card-save") === b; })() } };
  },
  rowTop(pane, i) { const row = pane.querySelectorAll(".msg-user-row")[i]; const s = pane.querySelector(".transcript"); return Math.round(row.getBoundingClientRect().top - s.getBoundingClientRect().top); },
  saved() { return [...document.querySelectorAll(".saved-turn")].map((c) => ({ title: c.querySelector(".saved-turn-title")?.textContent, reply: c.querySelector(".saved-turn-reply")?.textContent ?? null,
    where: c.querySelector(".saved-turn-where")?.textContent, box: __live.box(c), ribbon: c.querySelector(".saved-turn-save")?.getAttribute("aria-pressed") })); },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const mouse = (c, type, at, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, ...extra });
async function clickAt(c, at) {
  await mouse(c, "mouseMoved", at);
  for (const type of ["mousePressed", "mouseReleased"]) await mouse(c, type, at, { button: "left", clickCount: 1 });
}
const KEYS = { ArrowDown: 40, ArrowUp: 38, s: 83 };
async function press(c, key, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key, code: key === "s" ? "KeyS" : key, windowsVirtualKeyCode: KEYS[key], modifiers, ...(type === "keyDown" && key === "s" ? { text: "s" } : {}) });
}
async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: clip.scale ?? 2 } } : {}) });
  const out = path.join(OUTDIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
}
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

async function attach() {
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}
async function steady(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
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
      REALM_HOME: home, REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const c = await attach();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Org app");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await steady(c);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const LONG = "Org app work";
const OTHER = "Billing split";
const P = (s) => JSON.stringify(s);
const openRow = (c, title) => evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes(${P(title)})); row?.click(); return !!row; })()`);
/** The Library, on its Saved section, read once it lists something. */
async function openLibrary(c) {
  await evalIn(c, `(() => { const b = [...document.querySelectorAll('.app-rail .rail-btn')].find((x) => x.getAttribute('aria-label') === 'Library'); if (b?.getAttribute('aria-pressed') !== 'true') b?.click(); return !!b; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.library-page-pane')`), 15_000, "the Library");
  await evalIn(c, `(() => { const tab = [...document.querySelectorAll('.page-rail-tab')].find((t) => t.textContent.trim() === 'Saved'); tab?.querySelector('input')?.click(); return !!tab; })()`);
  return until(() => evalIn(c, `(() => { const s = __live.saved(); return document.querySelector('.library-page-pane h1')?.textContent === 'Saved' && s.length > 0 ? s : null; })()`), 15_000, "the Saved section");
}
/** Point at a tick, then cross to its card's bookmark the way a hand does — off the track, over the gap. */
async function toBookmark(c, pane, i, restShot = null) {
  await mouse(c, "mouseMoved", await evalIn(c, `__live.tickAt(${pane}, ${i})`));
  await sleep(450);
  const card = await evalIn(c, `__live.card(${pane})`);
  if (restShot) {
    const w = (await evalIn(c, `__live.track(${pane})`)).wrap;
    await shoot(c, restShot, { x: w.x, y: card.box.y - 30, w: card.box.r - w.x + 20, h: card.box.h + 60, scale: 3 });
  }
  await mouse(c, "mouseMoved", { x: card.box.x - 4, y: card.save.at.y });
  await sleep(60);
  await mouse(c, "mouseMoved", { x: card.box.x + 6, y: card.save.at.y });
  await sleep(60);
  await mouse(c, "mouseMoved", card.save.at);
  await sleep(80);
  return card;
}

async function main() {
  let c = await boot();
  const [onboarding] = await api.call("sessions.listAll", {});
  // Before anything else: the onboarding session runs a REAL engine.
  await api.call("sessions.setAgent", { id: onboarding.id, agentKind: "fake" });
  fs.mkdirSync(onboarding.cwd, { recursive: true });
  const start = Date.now() - 4 * 3600_000;
  const longTurns = turnsOf(40, start);
  const billTurns = turnsOf(16, start + 3600_000, "billing");
  const { session: long } = await api.call("sessions.create", { spaceId: onboarding.spaceId, agentKind: "fake", title: LONG });
  seed(long.id, longTurns);
  const profileId = (await api.call("spaces.list", {})).find((s) => s.id === onboarding.spaceId).profileId;
  const billing = await api.call("spaces.create", { profileId, name: "Billing", icon: "folder" });
  const { session: other } = await api.call("sessions.create", { spaceId: billing.id, agentKind: "fake", title: OTHER });
  seed(other.id, billTurns);
  const seqsOf = async (id) => (await api.call("sessions.events", { id, afterSeq: 0, limit: 2000 })).filter((e) => e.event.type === "user_message").map((e) => e.seq);
  const longSeqs = await seqsOf(long.id), otherSeqs = await seqsOf(other.id);
  await sleep(300);
  await openRow(c, LONG);
  const pane = `__live.pane(${P(longTurns[0].asked)})`;
  const billPane = `__live.pane(${P(billTurns[0].asked)})`;
  await until(() => evalIn(c, `(async () => { await __live.frames(3); return __live.track(${pane}).n === 40; })()`), 20_000, "the long session's track");
  await sleep(700);
  const away = async () => { const w = (await evalIn(c, `__live.track(${pane})`)).wrap; await mouse(c, "mouseMoved", { x: w.x + 360, y: w.y + 300 }); await sleep(450); };

  // ── The bookmark on the card ──
  const before = await toBookmark(c, pane, 5, "card-bookmark-rest-dark");
  const w = (await evalIn(c, `__live.track(${pane})`)).wrap;
  check("a tick's card carries the bookmark at its top right, not pressed, beside the prompt's first line",
    before.open && before.title === longTurns[5].asked && before.save?.pressed === "false" && before.save.fill === "none"
      && before.save.box.r >= before.box.r - 16 && before.save.box.y <= before.box.y + 16, before);
  const crossed = await evalIn(c, `__live.card(${pane})`);
  check("the card stays up while the pointer crosses from the track to its bookmark", crossed.open && crossed.save.under, crossed.save);
  await shoot(c, "card-bookmark-hover-dark", { x: w.x, y: before.box.y - 30, w: before.box.r - w.x + 20, h: before.box.h + 60, scale: 3 });
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await mouse(c, "mousePressed", before.save.at, { button: "left", clickCount: 1 });
  await mouse(c, "mouseReleased", before.save.at, { button: "left", clickCount: 1 });
  await sleep(400);
  const after = await evalIn(c, `(() => ({ card: __live.card(${pane}), track: __live.track(${pane}), keyboard: document.activeElement === document.body ? "body" : document.activeElement?.className ?? null }))()`);
  const serverSet = (await api.call("sessions.saved", { id: long.id })).seqs;
  check("pressing it saves the turn: the ribbon fills, the card stays up, and the bookmark takes no focus",
    after.card.open && after.card.save.pressed === "true" && after.card.save.fill !== "none" && after.keyboard === "body", { save: after.card.save, keyboard: after.keyboard });
  check("the server keeps the prompt's own event — the database row is its seq, not its words",
    JSON.stringify(serverSet) === JSON.stringify([longSeqs[5]]) && JSON.stringify(savedRows()) === JSON.stringify([longSeqs[5]]), { serverSet, rows: savedRows(), seq: longSeqs[5] });
  await shoot(c, "card-saved-dark", { x: w.x, y: after.card.box.y - 30, w: after.card.box.r - w.x + 20, h: after.card.box.h + 60, scale: 3 });
  await away();
  const marked = await evalIn(c, `__live.track(${pane})`);
  note("inks at rest", { saved: marked.inks[5], rest: marked.inks[6], current: marked.inks[marked.current] });
  check("the saved turn's tick is marked, at rest, in an ink of its own, and says so to a screen reader",
    JSON.stringify(marked.saved) === JSON.stringify([5]) && JSON.stringify(marked.described) === JSON.stringify([5]) && marked.inks[5] !== marked.inks[6] && marked.inks[5] !== marked.inks[marked.current], marked.saved);

  // ── S, both ways, and ⌥↓ / ⌥↑ ──
  for (const i of [20, 32, 12]) {
    await evalIn(c, `(() => { __live.ticks(${pane})[${i}].focus(); return true; })()`);
    await press(c, "s");
    await sleep(250);
  }
  const keyed = await evalIn(c, `__live.track(${pane})`);
  await press(c, "s"); // 12 again: off
  await sleep(250);
  const toggled = await evalIn(c, `__live.track(${pane})`);
  check("S saves the turn the keyboard is on, and S again unsaves it", JSON.stringify(keyed.saved) === JSON.stringify([5, 12, 20, 32]) && JSON.stringify(toggled.saved) === JSON.stringify([5, 20, 32]),
    { keyed: keyed.saved, toggled: toggled.saved });
  await evalIn(c, `(() => { __live.ticks(${pane})[0].focus(); return true; })()`);
  const stops = [];
  for (let k = 0; k < 4; k++) {
    await press(c, "ArrowDown", 1);
    await sleep(900);
    stops.push(await evalIn(c, `(() => { const t = __live.track(${pane}); return { focused: t.focused, current: t.current, rowTop: t.focused >= 0 ? __live.rowTop(${pane}, t.focused) : null }; })()`));
  }
  check("⌥↓ steps through the saved turns alone, bringing each one's row to the top, and stops at the last",
    JSON.stringify(stops.map((s) => s.focused)) === JSON.stringify([5, 20, 32, 32]) && stops.slice(0, 3).every((s) => s.current === s.focused && Math.abs(s.rowTop - 44) <= 2), stops);
  await press(c, "ArrowUp", 1);
  await sleep(900);
  const back = await evalIn(c, `(() => { const t = __live.track(${pane}); return { focused: t.focused, current: t.current, rowTop: __live.rowTop(${pane}, 20) }; })()`);
  check("⌥↑ steps back to the saved turn before", back.focused === 20 && back.current === 20 && Math.abs(back.rowTop - 44) <= 2, back);
  await shoot(c, "track-saved-keyboard-dark", { x: w.x, y: w.y, w: 420, h: w.h });
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await away();
  await shoot(c, "track-saved-marks-zoom-dark", { x: w.x, y: w.y + 40, w: 80, h: w.h - 80, scale: 4 });

  // ── A reload keeps them ──
  await c.send("Page.reload", { ignoreCache: false });
  c.close();
  await sleep(1500);
  c = await attach();
  const quiet = (expr) => evalIn(c, expr).catch(() => null);
  await until(() => quiet(`!!document.querySelector('.composer')`), 30_000, "the window again");
  await steady(c);
  if (!(await quiet(`!!${pane}`))) await openRow(c, LONG);
  await until(() => quiet(`(async () => { await __live.frames(3); return __live.track(${pane}).n === 40; })()`), 20_000, "the track again");
  await sleep(600);
  const reloaded = await evalIn(c, `__live.track(${pane})`);
  check("a reload keeps them: the same three turns are saved, read back from the server", JSON.stringify(reloaded.saved) === JSON.stringify([5, 20, 32]), reloaded.saved);

  // ── Another space's session, and the Library ──
  await api.call("sessions.setSaved", { id: other.id, seq: otherSeqs[2], saved: true });
  const listed = await openLibrary(c);
  check("the Library's Saved section lists every saved turn of the profile, newest saved first: the prompt, its answer's opening, whose session",
    listed.length === 4 && listed[0].title === billTurns[2].asked && listed[0].where.startsWith(`${OTHER} · Billing · `)
      && listed[1].title === longTurns[32].asked && listed[2].title === longTurns[20].asked && listed[3].title === longTurns[5].asked
      && listed[3].where.startsWith(`${LONG} · `) && listed.every((e) => (e.reply ?? "").length > 10 && e.ribbon === "true"),
    listed.map((e) => ({ title: e.title, where: e.where, reply: e.reply?.slice(0, 30) })));
  // Another window saves one, and unsaves it, while the list is up: the server's word reaches it each time.
  await api.call("sessions.setSaved", { id: other.id, seq: otherSeqs[5], saved: true });
  const grew = await until(() => evalIn(c, `(() => { const s = __live.saved(); return s.length === 5 ? s : null; })()`), 10_000, "a save from elsewhere");
  await api.call("sessions.setSaved", { id: other.id, seq: otherSeqs[5], saved: false });
  const shrank = await until(() => evalIn(c, `(() => { const s = __live.saved(); return s.length === 4 ? s : null; })()`), 10_000, "an unsave from elsewhere");
  check("a save or an unsave made anywhere else reaches the open list", grew[0].title === billTurns[5].asked && shrank.every((e) => e.title !== billTurns[5].asked),
    { grew: grew[0].title, shrank: shrank.map((e) => e.title) });
  await mouse(c, "mouseMoved", { x: 1100, y: 900 });
  await sleep(300);
  await shoot(c, "library-saved-dark");
  // A click goes to that prompt, in its session.
  await clickAt(c, await evalIn(c, `__live.centre([...document.querySelectorAll('.saved-turn-open')][2])`));
  await until(() => evalIn(c, `!document.querySelector('.library-page-pane') && !!${pane}`), 15_000, "the session, from the Library");
  await sleep(900);
  const landed = await evalIn(c, `(() => { const t = __live.track(${pane}); return { current: t.current, rowTop: __live.rowTop(${pane}, 20) }; })()`);
  check("a saved turn opens its session AT its prompt — the row at the top, its tick lit", landed.current === 20 && Math.abs(landed.rowTop - 44) <= 2, landed);
  await shoot(c, "opened-at-saved-dark");
  // …and one in another space brings that space forward, then that prompt.
  await openLibrary(c);
  await clickAt(c, await evalIn(c, `__live.centre([...document.querySelectorAll('.saved-turn-open')][0])`));
  await until(() => evalIn(c, `(async () => { await __live.frames(2); return !document.querySelector('.library-page-pane') && __live.track(${billPane}).n === 16; })()`), 20_000, "the other space's session, from the Library");
  await sleep(900);
  const far = await evalIn(c, `(() => { const t = __live.track(${billPane}); return { current: t.current, saved: t.saved, rowTop: __live.rowTop(${billPane}, 2), long: !!${pane} }; })()`);
  check("one from another space opens there, at its prompt, with its own tick marked", far.current === 2 && Math.abs(far.rowTop - 44) <= 2 && JSON.stringify(far.saved) === JSON.stringify([2]) && !far.long, far);
  await shoot(c, "opened-other-space-dark");

  // ── Unsaving, everywhere ──
  await openLibrary(c);
  await clickAt(c, await evalIn(c, `__live.centre([...document.querySelectorAll('.saved-turn-save')][0])`));
  const fewer = await until(() => evalIn(c, `(() => { const s = __live.saved(); return s.length === 3 ? s : null; })()`), 10_000, "the list after an unsave");
  check("the ribbon in the Library unsaves: the turn leaves the list and the server", fewer.every((e) => !e.title.includes("billing")) && (await api.call("sessions.saved", { id: other.id })).seqs.length === 0,
    fewer.map((e) => e.title));
  // Back to the long session by its saved turn — the list is the way there now.
  await clickAt(c, await evalIn(c, `__live.centre([...document.querySelectorAll('.saved-turn-open')][0])`));
  await until(() => evalIn(c, `(async () => { await __live.frames(2); return !document.querySelector('.library-page-pane') && __live.track(${pane}).n === 40; })()`), 20_000, "the long session, from the Library");
  await sleep(900);
  const home32 = await evalIn(c, `(() => { const t = __live.track(${pane}); return { current: t.current, rowTop: __live.rowTop(${pane}, 32), bill: !!${billPane} }; })()`);
  check("and back across the spaces to the long session, at prompt 33", home32.current === 32 && Math.abs(home32.rowTop - 44) <= 2 && !home32.bill, home32);
  const savedCard = await toBookmark(c, pane, 32);
  await mouse(c, "mousePressed", savedCard.save.at, { button: "left", clickCount: 1 });
  await mouse(c, "mouseReleased", savedCard.save.at, { button: "left", clickCount: 1 });
  await sleep(500);
  const unsaved = await evalIn(c, `(() => ({ was: ${P(savedCard.save.pressed)}, card: __live.card(${pane}).save.pressed, track: __live.track(${pane}).saved }))()`);
  check("the card's filled ribbon unsaves too, on the track and on the server",
    unsaved.was === "true" && unsaved.card === "false" && JSON.stringify(unsaved.track) === JSON.stringify([5, 20])
      && JSON.stringify((await api.call("sessions.saved", { id: long.id })).seqs) === JSON.stringify([longSeqs[5], longSeqs[20]]) && JSON.stringify(savedRows()) === JSON.stringify([longSeqs[5], longSeqs[20]]),
    unsaved);

  // ── The light face ──
  await away();
  await paletteRow(c, "Theme: Light");
  await sleep(800);
  await toBookmark(c, pane, 20);
  const light = await evalIn(c, `__live.card(${pane})`);
  check("the light face draws the same saved card", light.open && light.save.pressed === "true" && light.save.fill !== "none", light.save);
  const lw = (await evalIn(c, `__live.track(${pane})`)).wrap;
  await shoot(c, "card-saved-light", { x: lw.x, y: light.box.y - 30, w: light.box.r - lw.x + 20, h: light.box.h + 60, scale: 3 });
  await shoot(c, "track-saved-hover-light", { x: lw.x, y: lw.y, w: 420, h: lw.h });
  await away();
  const lightRest = await evalIn(c, `__live.track(${pane})`);
  note("light inks at rest", { saved: lightRest.inks[5], rest: lightRest.inks[6], current: lightRest.inks[lightRest.current] });
  check("and marks the saved ticks in their own ink there too", lightRest.inks[5] !== lightRest.inks[6], { saved: lightRest.inks[5], rest: lightRest.inks[6] });
  await shoot(c, "track-saved-marks-zoom-light", { x: lw.x, y: lw.y + 40, w: 80, h: lw.h - 80, scale: 4 });
  await openLibrary(c);
  await mouse(c, "mouseMoved", { x: 1100, y: 900 });
  await sleep(400);
  await shoot(c, "library-saved-light");
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  check("no uncaught renderer exceptions", c.errors.length === 0, c.errors.slice(0, 3));
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  await stopDaemons(home).catch(() => {});
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
