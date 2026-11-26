#!/usr/bin/env node
/**
 * How long a click on a sidebar row takes to draw that session's transcript, for sessions and for
 * teammates, cold (the first open since launch) and warm (opened before), on a home with real data.
 *
 *   pnpm build
 *   SWITCH_DB=<a copy of a realm.db> node apps/desktop/scripts/session-switch-live.mjs
 *
 * `SWITCH_DB` is copied (an APFS clone) into a scratch home for every launch, so each launch starts
 * from the same data. Never point it at a running app's database: take a copy with
 * `sqlite3 <db> "VACUUM INTO '<copy>'"`, and in the copy disable schedules and set running sessions
 * idle. The targets are named by `SWITCH_SESSIONS` (two session ids) and `SWITCH_TEAMMATES` (two
 * teammate names), long first. Without `SWITCH_DB` the check seeds its own fake sessions.
 *
 * Each click is timed in the page: `performance.now()` at the click, then every animation frame
 * until the focused pane's transcript stops changing. "First paint" is the first frame showing the
 * target's transcript, "drawn" the frame after the transcript reached its final state (the double
 * requestAnimationFrame). Beside them: the RPCs in flight, the long-animation-frame split of script
 * and style/layout, and when the pane and the composer were swapped.
 *
 * The check fails when a warm switch's median first paint is over `SWITCH_BUDGET_MS` (100). Set
 * `SWITCH_ASSERT=0` to only measure, `SWITCH_LAUNCHES` (5) and `SWITCH_ROUNDS` (2) for the sample,
 * `SWITCH_OUT` for a JSON of every run, and `SWITCH_FRAMES=<dir>` to also screencast one cold and one
 * warm switch, frame by frame.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { desktopRoot, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { stopDaemons } from "./lib/daemon-token.mjs";

const SOURCE_DB = process.env.SWITCH_DB ?? null;
const SESSIONS = (process.env.SWITCH_SESSIONS ?? "").split(",").filter(Boolean);
const TEAMMATES = (process.env.SWITCH_TEAMMATES ?? "").split(",").filter(Boolean);
const LAUNCHES = Number(process.env.SWITCH_LAUNCHES ?? 5);
const ROUNDS = Number(process.env.SWITCH_ROUNDS ?? 2);
const BUDGET_MS = Number(process.env.SWITCH_BUDGET_MS ?? 100);
const ASSERT = process.env.SWITCH_ASSERT !== "0";
const OUT = process.env.SWITCH_OUT ?? null;
const FRAMES = process.env.SWITCH_FRAMES ?? null;
const SCRATCH_HOME = process.env.SWITCH_HOME_DIR ?? null;
const PROFILE = process.env.SWITCH_PROFILE ?? null;

/* ── The renderer over http, so the paint worklet draws as it does in the real app ─────────── */

function serveRenderer() {
  const root = path.join(desktopRoot, "out/renderer");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(root, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* ── In the page ──────────────────────────────────────────────────────────────────────────── */

/** RPC timing and long-animation-frame entries, recorded from here on. A reply is matched to its
 *  call by the id at the front of the frame, without parsing the whole reply a second time. */
const INSTRUMENT = `(() => {
  if (window.__sw) return true;
  const sw = window.__sw = { rpc: [], loaf: [], open: new Map() };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (!this.__swHooked) {
      this.__swHooked = true;
      this.addEventListener("message", (e) => {
        const head = typeof e.data === "string" ? e.data.slice(0, 160) : "";
        const m = /^\\{"id":"(\\d+)"/.exec(head);
        const r = m && sw.open.get(Number(m[1]));
        if (r) { r.t1 = performance.now(); r.bytes = e.data.length; sw.open.delete(r.id); }
      });
    }
    if (typeof data === "string") {
      const m = /^\\{"id":"?(\\d+)"?,"method":"([^"]+)"/.exec(data);
      if (m) { const r = { id: Number(m[1]), method: m[2], t0: performance.now(), t1: null, bytes: 0 }; sw.rpc.push(r); sw.open.set(r.id, r); }
    }
    return send.call(this, data);
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) sw.loaf.push({ start: e.startTime, duration: e.duration, renderStart: e.renderStart, styleAndLayoutStart: e.styleAndLayoutStart,
      script: e.scripts.reduce((s, x) => s + x.duration, 0), forced: e.scripts.reduce((s, x) => s + x.forcedStyleAndLayoutDuration, 0) });
  }).observe({ type: "long-animation-frame", buffered: false });
  return true;
})()`;

/** Click the row whose accessible name starts with `label`, then watch every frame until the
 *  focused pane's transcript has held still for `QUIET_MS` with no RPC in flight. */
const MEASURE = (rowSelector, label) => `(async () => {
  const QUIET_MS = 1200, MAX_MS = 20000;
  const sw = window.__sw;
  const row = [...document.querySelectorAll(${JSON.stringify(rowSelector)})].find((b) => (b.getAttribute("aria-label") ?? "").startsWith(${JSON.stringify(label)}));
  if (!row) return { error: "no row for " + ${JSON.stringify(label)} };
  const read = () => {
    const pane = document.querySelector(".session-pane[data-focused]") ?? document.querySelector(".session-pane");
    const col = pane?.querySelector(".transcript-col");
    const last = col?.lastElementChild;
    const composer = pane?.querySelector("[contenteditable='true'], textarea") ?? null;
    return { pane, composer, n: col ? col.childElementCount : -1, h: col ? col.scrollHeight : -1,
      last: last ? last.textContent.length + ":" + last.textContent.slice(-48) : "" };
  };
  const before = read();
  const rpcFrom = sw.rpc.length;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  performance.mark("switch-start");
  const t0 = performance.now();
  row.click();
  const handler = performance.now() - t0;
  const frames = [];
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now(), s = read();
      frames.push({ t: now - t0, n: s.n, h: s.h, last: s.last, newPane: s.pane !== before.pane, newComposer: s.composer !== null && s.composer !== before.composer });
      const shown = frames.findIndex((f) => f.n > 0 && f.last !== before.last);
      const inFlight = sw.rpc.slice(rpcFrom).some((r) => r.t1 === null);
      let lastChange = 0;
      for (let i = 1; i < frames.length; i++) { const a = frames[i - 1], b = frames[i]; if (a.n !== b.n || a.h !== b.h || a.last !== b.last) lastChange = b.t; }
      if (now - t0 > MAX_MS || (shown >= 0 && !inFlight && frames.at(-1).t - lastChange > QUIET_MS)) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const fin = frames.at(-1);
  const same = (f) => f.n === fin.n && f.h === fin.h && f.last === fin.last;
  let settled = frames.length - 1;
  while (settled > 0 && same(frames[settled - 1])) settled--;
  const shown = frames.findIndex((f) => f.n > 0 && f.last !== before.last);
  const after = (i) => (frames[i + 1] ?? frames[i]).t;
  const tEnd = after(settled);
  performance.mark("switch-drawn");
  const rpc = sw.rpc.slice(rpcFrom).filter((r) => r.t0 - t0 <= tEnd).map((r) => ({ method: r.method, t0: r.t0 - t0, t1: r.t1 === null ? null : r.t1 - t0, bytes: r.bytes }));
  // The wall time some RPC was in flight before the transcript was drawn: the union of the intervals.
  let wait = 0, edge = 0;
  for (const r of [...rpc].sort((a, b) => a.t0 - b.t0)) { const a = Math.max(r.t0, edge), b = Math.min(r.t1 ?? tEnd, tEnd); if (b > a) { wait += b - a; edge = b; } }
  const loaf = sw.loaf.filter((e) => e.start + e.duration >= t0 && e.start <= t0 + tEnd);
  return {
    ok: row.closest(".item")?.hasAttribute("data-active") ?? null,
    handler, firstPaint: shown >= 0 ? after(shown) : null, drawn: tEnd,
    paneSwap: (() => { const i = frames.findIndex((f) => f.newPane); return i >= 0 ? frames[i].t : null; })(),
    composer: (() => { const i = frames.findIndex((f) => f.newComposer); return i >= 0 ? frames[i].t : null; })(),
    blocks: fin.n, rpcWait: wait, rpc,
    longFrames: loaf.length, script: loaf.reduce((s, e) => s + e.script, 0),
    styleLayout: loaf.reduce((s, e) => s + (e.start + e.duration - e.styleAndLayoutStart), 0),
    maxFrame: Math.max(0, ...loaf.map((e) => e.duration)),
  };
})()`;

/** The functions that took the most self time in a profile, and the time under each of a few
 *  callers that say which stage of a switch it was. */
function topSelf(profile, drawnMs) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(), stage = new Map();
  const STAGES = ["reduceTranscript", "openSession", "renderWithHooks", "commitRoot", "Markdown", "renderMarkdown", "highlightAuto", "sanitize", "(garbage collector)"];
  let t = profile.startTime;
  const until = profile.startTime + drawnMs * 1000 + 50_000;
  profile.samples.forEach((id, i) => {
    t += profile.timeDeltas[i];
    if (t > until) return;
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    const n = byId.get(id);
    const name = `${n.callFrame.functionName || "(anonymous)"} ${path.basename(n.callFrame.url || "")}`;
    self.set(name, (self.get(name) ?? 0) + dt);
    const seen = new Set();
    for (let p = id; p !== undefined; p = parent.get(p)) {
      const f = byId.get(p).callFrame.functionName;
      if (STAGES.includes(f) && !seen.has(f)) { seen.add(f); stage.set(f, (stage.get(f) ?? 0) + dt); }
    }
  });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `    ${v.toFixed(1).padStart(7)} ms  ${k}`).join("\n");
  const stages = [...stage].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ");
  return `${top}\n    under: ${stages}`;
}

/* ── The home ─────────────────────────────────────────────────────────────────────────────── */

function freshHome() {
  const dir = SCRATCH_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), "realm-session-switch-home-"));
  const home = path.join(dir, "home");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  // An APFS clone: every launch starts from the same data and none of it costs disk.
  execFileSync("cp", ["-c", SOURCE_DB, path.join(home, "realm.db")]);
  const user = path.join(dir, "user");
  fs.mkdirSync(user, { recursive: true });
  return { dir, home, user };
}

const load = () => {
  const [one] = os.loadavg();
  const swap = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).match(/used = ([\d.]+)M/)?.[1];
  return { load1: Number(one.toFixed(2)), swapMB: Number(swap ?? NaN) };
};

/* ── One launch ───────────────────────────────────────────────────────────────────────────── */

async function oneLaunch(n, renderer, targets) {
  const where = SOURCE_DB ? freshHome() : null;
  const app = await launchLiveApp({
    name: "session-switch", rendererUrl: renderer, timeoutMs: 120_000,
    env: where ? { REALM_HOME: where.home, HOME: where.user } : {},
  });
  const runs = [];
  try {
    const { page } = app;
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await until(() => page.eval(`${JSON.stringify(targets.map((t) => [t.selector, t.label]))}.every(([s, l]) => [...document.querySelectorAll(s)].some((b) => (b.getAttribute("aria-label") ?? "").startsWith(l)))`), 120_000, "the sidebar rows");
    await page.eval(INSTRUMENT);
    const quiet = async () => {
      // Let the boot (and the last switch) finish its reads before the next click is timed.
      await until(() => page.eval(`(() => { const r = window.__sw.rpc; const open = r.some((x) => x.t1 === null); const last = Math.max(0, ...r.map((x) => x.t1 ?? 0)); return !open && performance.now() - last > 1500; })()`), 60_000, "the app to go quiet");
      await sleep(300);
    };
    await quiet();
    const click = async (t, phase) => {
      if (PROFILE) { await page.send("Profiler.enable"); await page.send("Profiler.setSamplingInterval", { interval: 200 }); await page.send("Profiler.start"); }
      const r = await page.eval(MEASURE(t.selector, t.label));
      if (r.error) throw new Error(r.error);
      if (PROFILE) {
        const { profile } = await page.send("Profiler.stop");
        const file = path.join(PROFILE, `${phase}-${t.kind}-${t.size}-${runs.length}.cpuprofile`);
        fs.mkdirSync(PROFILE, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(profile));
        console.log(`  profile ${file}\n${topSelf(profile, r.drawn)}`);
      }
      const row = { launch: n, phase, kind: t.kind, size: t.size, ...load(), ...r };
      runs.push(row);
      console.log(`  ${phase.padEnd(4)} ${t.kind.padEnd(8)} ${t.size.padEnd(5)} paint ${r.firstPaint?.toFixed(0).padStart(5)} ms  drawn ${r.drawn.toFixed(0).padStart(5)} ms  rpc ${r.rpcWait.toFixed(0).padStart(5)} ms  script ${r.script.toFixed(0).padStart(4)}  layout ${r.styleLayout.toFixed(0).padStart(4)}  blocks ${r.blocks}  load ${row.load1}`);
      await quiet();
    };
    // Rotate which target opens first, so no one target always pays the app's first-switch warm-up.
    const order = targets.map((_, i) => targets[(i + n) % targets.length]);
    for (const t of order) await click(t, "cold");
    for (let round = 0; round < ROUNDS; round++) for (const t of order) await click(t, "warm");
    if (FRAMES && n === 0) await captureFrames(app, targets);
  } finally {
    await app.stop();
    if (where) { await stopDaemons(where.home); if (!SCRATCH_HOME) fs.rmSync(where.dir, { recursive: true, force: true }); }
  }
  return runs;
}

/** A screencast of a warm switch (between the two long targets already opened) — run after the
 *  measured clicks, so every target has been opened once. A cold one comes from the next launch. */
async function captureFrames(app, targets, label = "warm") {
  const { page } = app;
  const dir = path.join(FRAMES, label);
  fs.mkdirSync(dir, { recursive: true });
  const [a, b] = targets;
  // Land on the other target first, so the click below is a switch.
  await page.eval(MEASURE(b.selector, b.label));
  await sleep(800);
  const frames = [];
  page.on("Page.screencastFrame", (f) => { frames.push(f); page.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await page.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await sleep(400);
  const t0 = await page.eval("Date.now() / 1000");
  const r = await page.eval(MEASURE(a.selector, a.label));
  await sleep(300);
  await page.send("Page.stopScreencast");
  let i = 0;
  for (const f of frames) {
    const ms = Math.round((f.metadata.timestamp - t0) * 1000);
    if (ms < -100) continue;
    fs.writeFileSync(path.join(dir, `${String(i++).padStart(3, "0")}_${ms >= 0 ? "+" : ""}${ms}ms.png`), Buffer.from(f.data, "base64"));
  }
  fs.writeFileSync(path.join(dir, "measure.json"), JSON.stringify(r, null, 2));
  console.log(`  frames: ${i} in ${dir} (paint ${r.firstPaint?.toFixed(0)} ms, drawn ${r.drawn.toFixed(0)} ms)`);
}

async function coldFrames(renderer, targets) {
  const where = SOURCE_DB ? freshHome() : null;
  const app = await launchLiveApp({ name: "session-switch", rendererUrl: renderer, timeoutMs: 120_000, env: where ? { REALM_HOME: where.home, HOME: where.user } : {} });
  try {
    const { page } = app;
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await until(() => page.eval(`[...document.querySelectorAll(${JSON.stringify(targets[0].selector)})].some((b) => (b.getAttribute("aria-label") ?? "").startsWith(${JSON.stringify(targets[0].label)}))`), 120_000, "the sidebar rows");
    await page.eval(INSTRUMENT);
    await sleep(4000);
    const dir = path.join(FRAMES, "cold");
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    page.on("Page.screencastFrame", (f) => { frames.push(f); page.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
    await page.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await sleep(400);
    const t0 = await page.eval("Date.now() / 1000");
    const r = await page.eval(MEASURE(targets[0].selector, targets[0].label));
    await sleep(300);
    await page.send("Page.stopScreencast");
    let i = 0;
    for (const f of frames) {
      const ms = Math.round((f.metadata.timestamp - t0) * 1000);
      if (ms < -100) continue;
      fs.writeFileSync(path.join(dir, `${String(i++).padStart(3, "0")}_${ms >= 0 ? "+" : ""}${ms}ms.png`), Buffer.from(f.data, "base64"));
    }
    fs.writeFileSync(path.join(dir, "measure.json"), JSON.stringify(r, null, 2));
    console.log(`  frames: ${i} in ${dir} (paint ${r.firstPaint?.toFixed(0)} ms, drawn ${r.drawn.toFixed(0)} ms)`);
  } finally {
    await app.stop();
    if (where) { await stopDaemons(where.home); if (!SCRATCH_HOME) fs.rmSync(where.dir, { recursive: true, force: true }); }
  }
}

/* ── Main ─────────────────────────────────────────────────────────────────────────────────── */

if (!SOURCE_DB) {
  console.error("SWITCH_DB is required: a VACUUM INTO copy of a realm.db, with SWITCH_SESSIONS and SWITCH_TEAMMATES naming the targets");
  process.exit(2);
}
const titles = JSON.parse(execFileSync("sqlite3", ["-json", `file:${SOURCE_DB}?mode=ro`, `select id, title from sessions where id in (${SESSIONS.map((s) => `'${s.replace(/'/g, "")}'`).join(",")})`], { encoding: "utf8" }) || "[]");
const titleOf = Object.fromEntries(titles.map((r) => [r.id, r.title]));
const targets = [
  { kind: "session", size: "long", selector: ".sb-row:not(.sb-teammate) .item-row", label: titleOf[SESSIONS[0]] },
  { kind: "teammate", size: "long", selector: ".sb-teammate .item-row", label: TEAMMATES[0] },
  { kind: "session", size: "short", selector: ".sb-row:not(.sb-teammate) .item-row", label: titleOf[SESSIONS[1]] },
  { kind: "teammate", size: "short", selector: ".sb-teammate .item-row", label: TEAMMATES[1] },
];
if (targets.some((t) => !t.label)) { console.error("a target has no title:", targets); process.exit(2); }

const server = await serveRenderer();
const renderer = `http://127.0.0.1:${server.address().port}/`;
const all = [];
console.log(`session-switch-live: ${LAUNCHES} launches, ${ROUNDS} warm rounds, start ${JSON.stringify(load())}`);
try {
  for (let n = 0; n < LAUNCHES; n++) {
    console.log(`launch ${n + 1}/${LAUNCHES}`);
    all.push(...await oneLaunch(n, renderer, targets));
  }
  if (FRAMES) await coldFrames(renderer, targets);
} finally {
  server.close();
}

const stat = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length ? { median: s[Math.floor((s.length - 1) / 2)], min: s[0], max: s.at(-1), n: s.length } : null;
};
const summary = {};
for (const phase of ["cold", "warm"]) for (const t of targets) {
  const rs = all.filter((r) => r.phase === phase && r.kind === t.kind && r.size === t.size);
  const key = `${phase} ${t.kind} ${t.size}`;
  summary[key] = { firstPaint: stat(rs.map((r) => r.firstPaint)), drawn: stat(rs.map((r) => r.drawn)), rpcWait: stat(rs.map((r) => r.rpcWait)),
    script: stat(rs.map((r) => r.script)), styleLayout: stat(rs.map((r) => r.styleLayout)), paneSwap: stat(rs.map((r) => r.paneSwap)), composer: stat(rs.map((r) => r.composer)),
    load1: stat(rs.map((r) => r.load1)), swapMB: stat(rs.map((r) => r.swapMB)), landed: rs.every((r) => r.ok !== false) };
}
console.log("\ncase                     | first paint med/min/max | drawn med/min/max     | rpc med | load1 | swap MB");
for (const [k, v] of Object.entries(summary)) {
  const f = (s) => (s ? `${s.median.toFixed(0)}/${s.min.toFixed(0)}/${s.max.toFixed(0)}` : "-");
  console.log(`${k.padEnd(24)} | ${f(v.firstPaint).padEnd(23)} | ${f(v.drawn).padEnd(21)} | ${(v.rpcWait?.median ?? 0).toFixed(0).padStart(7)} | ${v.load1?.median ?? "-"} | ${v.swapMB?.median ?? "-"}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), launches: LAUNCHES, rounds: ROUNDS, summary, runs: all }, null, 2));

const notLanded = Object.entries(summary).filter(([, v]) => !v.landed).map(([k]) => k);
if (notLanded.length) { console.error(`FAIL: a click did not land on its row: ${notLanded.join(", ")}`); process.exit(1); }
if (ASSERT) {
  const over = Object.entries(summary).filter(([k, v]) => k.startsWith("warm") && (v.firstPaint?.median ?? Infinity) > BUDGET_MS);
  if (over.length) { console.error(`FAIL: warm switch first paint over ${BUDGET_MS} ms: ${over.map(([k, v]) => `${k} ${v.firstPaint?.median.toFixed(0)} ms`).join(", ")}`); process.exit(1); }
  console.log(`ok: every warm switch paints within ${BUDGET_MS} ms (median)`);
}
