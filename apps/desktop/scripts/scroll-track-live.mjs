/**
 * Live check: the scroll track down a session pane's left edge
 * (run with: pnpm build && node apps/desktop/scripts/scroll-track-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and seeds, straight into its database, a session of forty
 * turns of every length — some of them with git's account of the files they changed — and one of three
 * hundred. Then, in the real window: a tick per prompt in the log's order, inside the track, the newest
 * lit at the end; the lit tick following the scroll; the card a hover brings up, naming the prompt, the
 * answer's opening and the time; a click, and ↑/↓ from the keyboard, bringing a prompt's row to the
 * log's top and lighting its tick, with the prompter keeping the keyboard through a click; the edit
 * marks; the ticks holding still while a scripted answer streams in; a narrow pane, a split, the
 * three-hundred-prompt log and what scrolling it costs in layout; a scheduled run's viewer; both faces.
 *
 * Ports: LIVE_SERVER_PORT (8811), LIVE_CDP_PORT (9251). Writes only under LIVE_SCRATCH (the OS temp dir
 * by default). Nothing is billed: the onboarding session is moved to the fake agent before anything is
 * sent, the seeded sessions and the scheduled task are on it, and the built server skips the titler
 * and the recap under the fake agent.
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
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-scroll-track-live-"));
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

/* ── What the seeded sessions say ─────────────────────────────────────────────────────────────── */
const ASKS = [
  "Fix the org access crash path when a member has been removed",
  "Why does the import job time out on large CSVs?",
  "Rename `getOrgMembership` to `membershipFor` everywhere",
  "Add a test for the invite expiry",
  "Make the settings page load the theme before first paint",
  "What does the compaction step drop from the context?",
  "Split the billing service into reads and writes",
  "Draft the release notes for 2.0",
  "Is the search index rebuilt on every deploy?",
  "Move the feature flags into one file",
  "Tighten the rate limiter on the login route",
  "Explain the retry ladder in the queue",
];
const ANSWERS = [
  "Done — renamed it, and the two call sites in the CLI now use the new name.",
  "The membership check ran **before** the organisation loaded, so a removed member hit a null. It now loads the org first and returns a 404 for anyone who is no longer in it.\n\nVerified:\n\n- `pnpm test orgs`: passes\n- `pnpm typecheck`: passes",
  "It times out because the parser buffers the whole file before it validates a row. Streaming it fixes that:\n\n```ts\nfor await (const row of parse(stream)) {\n  validate(row);\n  await batch.push(row);\n}\n```\n\nWith a 200 MB file the job now finishes in 41 seconds, and memory stays flat at about 90 MB the whole way through. The batch size of 500 was the fastest of the four I tried; anything above 2,000 starts to hold the write lock long enough that the dashboard's own reads queue behind it.\n\nOne thing to decide: rows that fail validation are currently skipped with a warning. Should they stop the import instead?",
  "Yes. The index is rebuilt by the `postdeploy` hook, which runs on every deploy, including the ones that change nothing it reads. Gating it on the migrations folder would save about four minutes a deploy.",
  "Here is the split:\n\n1. `billing/reads.ts` — invoices, usage and the plan lookup.\n2. `billing/writes.ts` — charges, refunds and plan changes, each in a transaction.\n3. `billing/index.ts` re-exports both, so nothing that imports billing changes.\n\nThe writes now share one `withLedger` helper, which is what made the split worth doing: the three places that each opened their own transaction were the source of the double-charge bug last month.",
  "The compaction step keeps the system prompt, the last eight turns and every tool result a later turn refers to by id. It drops tool results nothing refers to, and folds older turns into a summary written by the same model.",
  "Moved all eleven flags into `config/flags.ts`, typed, with their defaults beside them.",
  "The ladder is three tries: immediately, after two seconds, then after ten, and a job that fails all three goes to the dead-letter queue with the last error attached. Transient network errors climb the ladder; a validation error goes straight to the dead letters, because trying again cannot change the answer.",
];
const files = (n, stem) => Array.from({ length: n }, (_, i) => ({ path: `web/lib/${stem}${i ? `-${i}` : ""}.ts`, oldPath: null, status: i === 1 ? "added" : "modified", additions: 4 + i * 3, deletions: i }));

/** Forty turns, every length of answer, and git's account of the files on every fifth one and two more. */
function longTurns(start) {
  return Array.from({ length: 40 }, (_, i) => ({
    at: start + i * 5 * 60_000,
    asked: ASKS[i % ASKS.length] + (i >= ASKS.length ? ` (${Math.floor(i / ASKS.length) + 1})` : ""),
    answer: ANSWERS[(i * 5) % ANSWERS.length],
    files: i % 5 === 1 || i === 22 || i === 38 ? files(1 + (i % 3), `turn${i}`) : null,
  }));
}
/** Three hundred short ones. */
function denseTurns(start) {
  return Array.from({ length: 300 }, (_, i) => ({ at: start + i * 60_000, asked: `Step ${i + 1}: ${ASKS[i % ASKS.length]}`, answer: ANSWERS[0], files: i % 7 === 0 ? files(1, `step${i}`) : null }));
}

function seed(sessionId, turns, root) {
  const ev = [];
  for (const t of turns) {
    ev.push([t.at, "user_message", { text: t.asked, attachments: [] }]);
    ev.push([t.at + 1_000, "status", { status: "running" }]);
    ev.push([t.at + 4_000, "assistant_text", { messageId: `m${t.at}`, text: t.answer }]);
    ev.push([t.at + 5_000, "status", { status: "idle" }]);
    if (t.files) ev.push([t.at + 5_500, "turn_changes", { checkpointId: `cp-${t.at}`, settledAt: t.at + 5_000, root, afterTree: "a".repeat(40), files: t.files, totalFiles: t.files.length }]);
  }
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const sql = ev.map(([ts, type, payload]) => `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(sessionId)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))});`);
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), `BEGIN;\n${sql.join("\n")}\nCOMMIT;`]);
}

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; },
  pane: (asked) => [...document.querySelectorAll(".session-pane")].find((p) => [...p.querySelectorAll(".msg-user")].some((m) => m.textContent.startsWith(asked))) ?? null,
  frames: (n = 2) => new Promise((r) => { const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step)); step(); }),
  /** The track of a pane, as measured: each tick's line, where it is and what it says. */
  track(pane) {
    const t = pane?.querySelector(".scroll-track"); if (!t) return null;
    const wrap = pane.querySelector(".transcript-wrap").getBoundingClientRect();
    const col = pane.querySelector(".transcript-col").getBoundingClientRect();
    const ticks = [...t.querySelectorAll(".track-tick")].map((k) => {
      const l = k.querySelector(".track-line").getBoundingClientRect();
      const dot = k.hasAttribute("data-edited") ? getComputedStyle(k.querySelector(".track-line"), "::after") : null;
      return { y: +(l.top + l.height / 2).toFixed(2), x: +(l.left - wrap.left).toFixed(2), w: +l.width.toFixed(2), right: +(l.right - wrap.left + (dot ? 1 + parseFloat(dot.width) : 0)).toFixed(2),
        current: k.hasAttribute("data-current"), edited: k.hasAttribute("data-edited"), near: k.getAttribute("data-near"), label: k.getAttribute("aria-label"), tab: k.tabIndex,
        ink: getComputedStyle(k.querySelector(".track-line")).backgroundColor };
    });
    return { box: __live.box(t), wrap: __live.box(pane.querySelector(".transcript-wrap")), colLeft: +(col.left - wrap.left).toFixed(2), ticks, current: ticks.findIndex((k) => k.current) };
  },
  card(pane) {
    const c = pane.querySelector(".track-card"); if (!c) return null;
    return { open: c.hasAttribute("data-open"), opacity: getComputedStyle(c).opacity, box: __live.box(c), title: c.querySelector(".track-card-title")?.textContent ?? null,
      reply: c.querySelector(".track-card-reply")?.textContent ?? null, at: c.querySelector("time")?.getAttribute("datetime") ?? null, time: c.querySelector("time")?.textContent ?? null,
      foot: c.querySelector(".track-card-foot")?.textContent ?? null };
  },
  /** Where a prompt's row sits in its scroller's viewport. */
  rowTop(pane, i) { const row = pane.querySelectorAll(".msg-user-row")[i]; const s = pane.querySelector(".transcript"); return Math.round(row.getBoundingClientRect().top - s.getBoundingClientRect().top); },
  /** The reader scrolling: a wheel (which is what hands the scroller back), then the offset. */
  async scrollTo(pane, top) { const s = pane.querySelector(".transcript"); s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 })); s.scrollTop = top; await __live.frames(3); return s.scrollTop; },
  tickAt(pane, i) { const l = pane.querySelectorAll(".scroll-track .track-line")[i]; const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) }; },
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
const KEYS = { ArrowDown: 40, ArrowUp: 38, End: 35, Home: 36, Tab: 9, Escape: 27 };
async function press(c, key, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: KEYS[key], modifiers });
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
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Org app");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const LONG_TITLE = "Org app work";
const DENSE_TITLE = "Three hundred steps";
const P = (asked) => JSON.stringify(asked);

async function openRow(c, title) {
  await evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes(${P(title)})); row?.click(); return !!row; })()`);
}

async function main() {
  const c = await boot();
  const [onboarding] = await api.call("sessions.listAll", {});
  // Before anything else: the onboarding session runs a REAL engine.
  await api.call("sessions.setAgent", { id: onboarding.id, agentKind: "fake" });
  fs.mkdirSync(onboarding.cwd, { recursive: true });

  const start = Date.now() - 4 * 3600_000;
  const longTurnsSeeded = longTurns(start);
  const { session: long } = await api.call("sessions.create", { spaceId: onboarding.spaceId, agentKind: "fake", title: LONG_TITLE });
  seed(long.id, longTurnsSeeded, long.cwd);
  const { session: dense } = await api.call("sessions.create", { spaceId: onboarding.spaceId, agentKind: "fake", title: DENSE_TITLE });
  seed(dense.id, denseTurns(start - 24 * 3600_000), dense.cwd);
  await sleep(400);
  await openRow(c, LONG_TITLE);
  const FIRST = longTurnsSeeded[0].asked;
  const pane = `__live.pane(${P(FIRST)})`;
  await until(() => evalIn(c, `(async () => { await __live.frames(3); const t = __live.track(${pane}); return t && t.ticks.length === 40 ? t : null; })()`), 20_000, "the long session's track");
  await sleep(700); // the prompter docks once the log has loaded, on a 320ms move, and the lit tick fades in
  const t0 = await evalIn(c, `__live.track(${pane})`);

  // ── The ticks ──
  const edited = longTurnsSeeded.flatMap((t, i) => (t.files ? [i] : []));
  check("one tick per prompt, in the log's order, each named by its prompt's first line, as typed",
    t0.ticks.map((k) => k.label).join("|") === longTurnsSeeded.map((t) => t.asked).join("|"), t0.ticks.slice(0, 3).map((k) => k.label));
  const ys = t0.ticks.map((k) => k.y);
  const gaps = ys.slice(1).map((y, i) => +(y - ys[i]).toFixed(2));
  check("the ticks run down the track in order, inside it, never nearer each other than the pitch while there is room",
    gaps.every((g) => g >= 9.5) && ys[0] >= t0.box.y && ys.at(-1) <= t0.box.b, { box: t0.box, first: ys[0], last: ys.at(-1), minGap: Math.min(...gaps), maxGap: Math.max(...gaps) });
  // The gap below a tick is its turn: the import answer (a code block and two paragraphs) against the one-liners.
  const gapsAfter = (answer) => gaps.filter((_, i) => longTurnsSeeded[i].answer === answer && !longTurnsSeeded[i].files);
  const longGaps = gapsAfter(ANSWERS[2]), shortGaps = gapsAfter(ANSWERS[0]);
  check("the gaps follow the turns: a long answer opens a longer gap than a one-liner, which keeps the pitch",
    Math.min(...longGaps) > Math.max(...shortGaps) && shortGaps.every((g) => Math.abs(g - 10) < 0.5), { longGaps, shortGaps });
  check("a log opens at its end, and the newest prompt's tick is the lit one, the only one that takes Tab",
    t0.current === 39 && t0.ticks.filter((k) => k.tab === 0).length === 1 && t0.ticks[39].tab === 0, { current: t0.current });
  check("the turns git measured, and only those, carry the edit mark", JSON.stringify(t0.ticks.flatMap((k, i) => (k.edited ? [i] : []))) === JSON.stringify(edited),
    { marked: t0.ticks.flatMap((k, i) => (k.edited ? [i] : [])), seeded: edited });
  const rest = t0.ticks.find((k, i) => !k.current && i !== 1);
  note("at rest", { trackX: t0.ticks[0].x, rest: { w: rest.w, ink: rest.ink }, current: { w: t0.ticks[39].w, ink: t0.ticks[39].ink }, colLeft: t0.colLeft, wrap: t0.wrap });
  check("the lit tick is longer and darker than the rest", t0.ticks[39].w > rest.w && t0.ticks[39].ink !== rest.ink, { lit: t0.ticks[39], rest });
  const trackClip = async (tag, pad = 0) => {
    const t = await evalIn(c, `__live.track(${pane})`);
    await shoot(c, tag, { x: t.wrap.x, y: t.wrap.y, w: 420 + pad, h: t.wrap.h });
  };
  await trackClip("track-rest-dark");

  // ── The lit tick follows the reader ──
  const top = await evalIn(c, `(async () => { await __live.scrollTo(${pane}, 0); return __live.track(${pane}).current; })()`);
  const mid = await evalIn(c, `(async () => { const p = ${pane}; const s = p.querySelector(".transcript"); const row = p.querySelectorAll(".msg-user-row")[18];
    await __live.scrollTo(p, s.scrollTop + row.getBoundingClientRect().top - s.getBoundingClientRect().top - 44); return { current: __live.track(p).current, rowTop: __live.rowTop(p, 18) }; })()`);
  check("the lit tick follows the scroll: the first prompt at the top, the one whose row the reader brought up in the middle", top === 0 && mid.current === 18, { top, mid });

  // ── Hover: the lens, and the card ──
  await mouse(c, "mouseMoved", await evalIn(c, `__live.tickAt(${pane}, 12)`));
  await sleep(450);
  const hover = await evalIn(c, `(() => { const p = ${pane}; return { track: __live.track(p), card: __live.card(p) }; })()`);
  const lens = hover.track.ticks.slice(9, 16).map((k) => k.near);
  check("under the pointer the tick lengthens into a lens, and its neighbours with it", JSON.stringify(lens) === JSON.stringify(["3", "2", "1", "0", "1", "2", "3"])
    && hover.track.ticks[12].w > hover.track.ticks[11].w && hover.track.ticks[11].w > hover.track.ticks[10].w, { lens, widths: hover.track.ticks.slice(9, 16).map((k) => k.w) });
  const asked12 = longTurnsSeeded[12];
  check("the card names the prompt, opens the answer and says when it was sent",
    hover.card.open && hover.card.opacity === "1" && hover.card.title === asked12.asked && (hover.card.reply ?? "").startsWith(asked12.answer.replace(/\*\*|`/g, "").split("\n")[0].slice(0, 30))
      && hover.card.at === new Date(asked12.at).toISOString() && hover.card.time.length > 3, hover.card);
  const tick12 = hover.track.ticks[12];
  check("the card stands clear of the lens, centred on its tick and inside the log",
    hover.card.box.x > hover.track.wrap.x + tick12.x + tick12.w && Math.abs(hover.card.box.y + hover.card.box.h / 2 - tick12.y) <= 2
      && hover.card.box.y >= hover.track.wrap.y && hover.card.box.b <= hover.track.wrap.b && hover.card.box.r <= hover.track.wrap.r, { card: hover.card.box, tick: tick12, wrap: hover.track.wrap });
  await trackClip("track-hover-dark");
  await shoot(c, "track-hover-zoom-dark", { x: hover.track.wrap.x, y: Math.max(hover.track.wrap.y, hover.card.box.y - 30), w: hover.card.box.r - hover.track.wrap.x + 20, h: hover.card.box.h + 60, scale: 3 });
  // An edited turn's card says so.
  await mouse(c, "mouseMoved", await evalIn(c, `__live.tickAt(${pane}, 22)`));
  await sleep(120);
  const editedCard = await evalIn(c, `__live.card(${pane})`);
  check("along the track the card follows at once, and an edited turn's card says how many files it changed",
    editedCard.open && editedCard.title === longTurnsSeeded[22].asked && editedCard.foot === `Edited ${longTurnsSeeded[22].files.length} file${longTurnsSeeded[22].files.length === 1 ? "" : "s"}`, editedCard);
  const ed = await evalIn(c, `__live.track(${pane})`);
  await shoot(c, "track-edit-marks-zoom-dark", { x: ed.wrap.x, y: ed.ticks[18].y - 14, w: 140, h: ed.ticks[26].y - ed.ticks[18].y + 28, scale: 4 });
  // Off the track, it goes.
  const away = { x: ed.wrap.x + 360, y: ed.wrap.y + 300 };
  await mouse(c, "mouseMoved", away);
  await sleep(350);
  const gone = await evalIn(c, `(() => { const p = ${pane}; return { card: __live.card(p), near: __live.track(p).ticks.filter((k) => k.near !== null).length }; })()`);
  check("leaving the track puts the card away and the lens back", !gone.card.open && gone.near === 0, gone);

  // ── A click goes there, and the prompter keeps the keyboard ──
  await evalIn(c, `(() => { ${pane}.querySelector(".composer-input")?.focus(); return true; })()`);
  await clickAt(c, await evalIn(c, `__live.tickAt(${pane}, 5)`));
  await sleep(1000);
  const clicked = await evalIn(c, `(() => { const p = ${pane}; return { rowTop: __live.rowTop(p, 5), current: __live.track(p).current,
    keyboard: document.activeElement?.className ?? null, inComposer: !!document.activeElement?.closest(".composer") }; })()`);
  check("a click brings the prompt's row to rest at the log's top padding and lights its tick", Math.abs(clicked.rowTop - 44) <= 2 && clicked.current === 5, clicked);
  check("and the keyboard stays in the prompter", clicked.inComposer, clicked);
  await mouse(c, "mouseMoved", away);

  // ── The keyboard ──
  await press(c, "Tab", 8);
  const tabbed = await evalIn(c, `(() => { const a = document.activeElement; return { tick: a?.classList.contains("track-tick") ?? false, label: a?.getAttribute("aria-label") ?? a?.className ?? null }; })()`);
  note("shift-tab from the prompter lands on", tabbed);
  await evalIn(c, `(() => { ${pane}.querySelector('.track-tick[tabindex="0"]').focus(); return true; })()`);
  await press(c, "ArrowDown");
  await sleep(1000);
  const down = await evalIn(c, `(() => { const p = ${pane}; const ticks = [...p.querySelectorAll(".track-tick")]; return { focused: ticks.indexOf(document.activeElement), rowTop: __live.rowTop(p, 6),
    current: __live.track(p).current, card: __live.card(p) }; })()`);
  check("↓ moves the keyboard to the next prompt's tick, goes there, and shows that prompt's card",
    down.focused === 6 && Math.abs(down.rowTop - 44) <= 2 && down.current === 6 && down.card.open && down.card.title === longTurnsSeeded[6].asked, down);
  await trackClip("track-keyboard-dark");
  await press(c, "End");
  await sleep(1000);
  const end = await evalIn(c, `(() => { const p = ${pane}; const ticks = [...p.querySelectorAll(".track-tick")]; return { focused: ticks.indexOf(document.activeElement), current: __live.track(p).current }; })()`);
  await press(c, "Escape");
  const esc = await evalIn(c, `(() => { const p = ${pane}; const ticks = [...p.querySelectorAll(".track-tick")]; return { focused: ticks.indexOf(document.activeElement), card: __live.card(p).open }; })()`);
  check("End goes to the newest prompt, and Escape puts the card away with the keyboard still on the track", end.focused === 39 && end.current === 39 && esc.focused === 39 && !esc.card, { end, esc });

  // ── A turn streaming in moves nothing ──
  await evalIn(c, `(() => { document.activeElement?.blur(); const s = ${pane}.querySelector(".transcript"); s.scrollTop = s.scrollHeight; return true; })()`);
  await api.call("sessions.send", { id: long.id, text: "Write the migration that stores the theme choice", attachments: [], mentions: [] });
  const arrived = await until(() => evalIn(c, `(async () => { await __live.frames(2); const t = __live.track(${pane}); return t && t.ticks.length === 41 ? t : null; })()`), 15_000, "the sent prompt's tick");
  await until(() => evalIn(c, `!!${pane}.querySelector('.msg-assistant-row[data-state="streaming"]')`), 20_000, "the answer streaming");
  // Sampled until the turn settles: the prose streams in, then its tool calls land, then more prose.
  const samples = [];
  for (let i = 0; i < 60; i++) {
    const s = await evalIn(c, `(() => { const p = ${pane}; const t = __live.track(p); return { ys: t.ticks.map((k) => k.y), current: t.current, height: p.querySelector(".transcript").scrollHeight,
      settled: p.querySelectorAll(".msg-run").length === 41 }; })()`);
    samples.push(s);
    if (s.settled) break;
    await sleep(400);
  }
  check("a new prompt gets its tick, lit while the log follows its answer", arrived.ticks[40].label === "Write the migration that stores the theme choice" && samples.every((s) => s.current === 40), samples.map((s) => s.current));
  check("while the answer streams in and the log grows, no tick moves",
    samples.at(-1).height > samples[0].height && samples.every((s) => JSON.stringify(s.ys) === JSON.stringify(samples[0].ys)),
    { samples: samples.length, heights: [...new Set(samples.map((s) => s.height))], moved: samples.filter((s) => JSON.stringify(s.ys) !== JSON.stringify(samples[0].ys)).length });
  await sleep(1000);

  // ── Narrow ──
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(700);
  const narrow = await evalIn(c, `(() => { const t = __live.track(${pane}); return { trackX: t.ticks[0].x, colLeft: t.colLeft, wrapW: t.wrap.w,
    rightmost: Math.max(...t.ticks.map((k) => k.right)), current: t.ticks[t.current] }; })()`);
  check("in a narrow pane the track sits in the transcript's own padding: no resting mark reaches the column", narrow.trackX <= 4 && narrow.rightmost <= narrow.colLeft - 1, narrow);
  await mouse(c, "mouseMoved", await evalIn(c, `__live.tickAt(${pane}, 30)`));
  await sleep(450);
  const narrowCard = await evalIn(c, `(() => { const p = ${pane}; return { card: __live.card(p), wrap: __live.track(p).wrap }; })()`);
  check("and the card still fits beside it", narrowCard.card.open && narrowCard.card.box.r <= narrowCard.wrap.r && narrowCard.card.box.x >= narrowCard.wrap.x, narrowCard);
  await trackClip("track-narrow-dark", 120);
  await mouse(c, "mouseMoved", away);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  const wide = await evalIn(c, `__live.track(${pane}).ticks[0].x`);
  check("where the column leaves a wide margin the track moves out to Codex's place", wide >= 12, { wide });

  // ── A split: the dense log beside the long one ──
  await paletteRow(c, "Split right");
  await sleep(500);
  await openRow(c, DENSE_TITLE);
  const DENSE_FIRST = "Step 1: ";
  const densePane = `__live.pane(${P(DENSE_FIRST)})`;
  const both = await until(() => evalIn(c, `(async () => { await __live.frames(3); const a = __live.track(${pane}), b = __live.track(${densePane});
    return a && b && b.ticks.length === 300 ? { long: a.ticks.length, dense: b.ticks.length, denseBox: b.box, denseYs: b.ticks.map((k) => k.y), denseCurrent: b.current } : null; })()`), 30_000, "both tracks");
  const dg = both.denseYs.slice(1).map((y, i) => y - both.denseYs[i]);
  await sleep(400);
  both.denseCurrent = await evalIn(c, `__live.track(${densePane}).current`);
  check("a split shows each pane's own track", both.long === 41 && both.dense === 300, { long: both.long, dense: both.dense });
  check("three hundred prompts fill the room, evenly, in order, inside the track",
    Math.min(...dg) > 0 && Math.max(...dg) - Math.min(...dg) < 0.6 && both.denseYs[0] >= both.denseBox.y && both.denseYs.at(-1) <= both.denseBox.b && both.denseCurrent === 299,
    { minGap: Math.min(...dg), maxGap: Math.max(...dg), box: both.denseBox, first: both.denseYs[0], last: both.denseYs.at(-1), current: both.denseCurrent });
  await shoot(c, "split-dark");
  await mouse(c, "mouseMoved", await evalIn(c, `__live.tickAt(${densePane}, 150)`));
  await sleep(450);
  const dcard = await evalIn(c, `__live.card(${densePane})`);
  // At a 2px pitch a pixel of late layout moves the tick under a still pointer, so the claim is the
  // card's: it names exactly the prompt the pointer is on, and that is the one aimed at or a neighbour.
  const under = await evalIn(c, `(() => { const t = __live.track(${densePane}); const i = t.ticks.findIndex((k) => k.near === "0"); return { i, label: t.ticks[i]?.label ?? null }; })()`);
  check("a pointer on the dense track lands on one prompt, and the card is that prompt's",
    dcard.open && dcard.title === under.label && Math.abs(under.i - 150) <= 3, { under, title: dcard.title });
  const dt = await evalIn(c, `__live.track(${densePane})`);
  await shoot(c, "track-dense-hover-dark", { x: dt.wrap.x, y: dt.wrap.y, w: 420, h: dt.wrap.h });
  await shoot(c, "track-dense-zoom-dark", { x: dt.wrap.x, y: dcard.box.y - 40, w: 60, h: dcard.box.h + 80, scale: 4 });
  await mouse(c, "mouseMoved", away);

  // What scrolling the dense log costs: layouts and script time across a sweep of frames.
  await c.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await c.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await metrics();
  const swept = await evalIn(c, `(async () => { const s = ${densePane}.querySelector(".transcript"); const steps = 90; const by = (s.scrollHeight - s.clientHeight) / steps;
    s.scrollTop = 0; await __live.frames(2); const t0 = performance.now();
    for (let i = 0; i < steps; i++) { s.scrollTop += by; await __live.frames(1); }
    return { steps, ms: Math.round(performance.now() - t0), current: __live.track(${densePane}).current }; })()`);
  const after = await metrics();
  const cost = { frames: swept.steps, ms: swept.ms, layouts: after.LayoutCount - before.LayoutCount, styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000), scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000) };
  note("scrolling the 300-prompt log", cost);
  check("scrolling three hundred prompts lays out at most once a frame, and keeps the lit tick with the reader",
    cost.layouts <= swept.steps + 10 && swept.current === 299, { ...cost, current: swept.current });
  check("and costs a few milliseconds of script a frame, not a re-render of the log", cost.scriptMs / swept.steps < 8, { perFrame: +(cost.scriptMs / swept.steps).toFixed(1) });

  // ── A scheduled run's viewer ──
  const sched = await api.call("schedules.create", { spaceId: onboarding.spaceId, title: "Morning triage", goal: "Triage the overnight issues and list the three that need a person.",
    cron: "0 9 * * 1", constraints: { agentKind: "fake" } });
  if (sched.constraints?.agentKind !== "fake") throw new Error("the task is not on the scripted agent — refusing to fire it");
  await api.call("schedules.runNow", { id: sched.id });
  const run = await until(async () => (await api.call("runs.list", { spaceId: onboarding.spaceId, scheduleId: sched.id })).runs.find((r) => r.state === "succeeded" && r.sessionId) ?? null, 30_000, "the run");
  await api.call("sessions.send", { id: run.sessionId, text: "Which of the three is oldest?", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: run.sessionId, afterSeq: 0, limit: 500 })).filter((e) => e.event.type === "status" && e.event.payload.status === "idle").length >= 2, 20_000, "the run's second turn");
  await evalIn(c, `(() => { const page = [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => b.getAttribute('aria-label') === 'Scheduled tasks'); if (page.getAttribute('aria-pressed') !== 'true') page.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.schedules-page .sched-col')`), 15_000, "schedules page");
  await evalIn(c, `(() => { document.querySelector('.sched-task-hit')?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.sched-run')`), 15_000, "the run listed");
  await evalIn(c, `(() => { document.querySelector('.sched-run')?.click(); return true; })()`);
  const viewer = await until(() => evalIn(c, `(async () => { await __live.frames(3); const p = document.querySelector('.sched-view .session-pane'); const t = p && __live.track(p);
    return t && t.ticks.length === 2 ? { labels: t.ticks.map((k) => k.label), current: t.current, box: t.box } : null; })()`), 20_000, "the run viewer's track");
  check("a scheduled run's viewer has the track too", viewer.labels[0].startsWith("Triage the overnight issues") && viewer.labels[1] === "Which of the three is oldest?", viewer);
  await shoot(c, "run-viewer-dark");

  // ── The light face ──
  await paletteRow(c, "Theme: Light");
  await sleep(800);
  await shoot(c, "run-viewer-light");
  // Back to the panes: the page's own Back, or its rail button again.
  await evalIn(c, `(() => { const back = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Back" || b.getAttribute("aria-label") === "Back");
    if (back) { back.click(); return "back"; }
    [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => b.getAttribute('aria-label') === 'Scheduled tasks')?.click(); return "rail"; })()`);
  await sleep(600);
  await until(() => evalIn(c, `!!__live.track(${pane})`), 15_000, "the long session again");
  await evalIn(c, `(async () => { await __live.scrollTo(${pane}, 0); return true; })()`);
  await sleep(300);
  const light = await evalIn(c, `__live.track(${pane})`);
  note("light at rest", { rest: light.ticks[3].ink, current: light.ticks[light.current]?.ink });
  await trackClip("track-rest-light");
  await mouse(c, "mouseMoved", await evalIn(c, `__live.tickAt(${pane}, 2)`));
  await sleep(450);
  const lightCard = await evalIn(c, `__live.card(${pane})`);
  check("the light face draws the same card", lightCard.open && lightCard.title === longTurnsSeeded[2].asked, lightCard);
  await trackClip("track-hover-light");
  await shoot(c, "window-light");
  await mouse(c, "mouseMoved", away);
  await paletteRow(c, "Theme: Dark");
  await sleep(700);
  await shoot(c, "window-dark");

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
