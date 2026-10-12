/**
 * Frame times while the sidebar scrolls, on a copy of a real home
 * (run with: node apps/desktop/scripts/sidebar-scroll-perf-live.mjs [outDir]).
 *
 * Boots the BUILT app on a scratch REALM_HOME holding a read-only copy of ~/Realm/realm.db
 * (`VACUUM INTO`, never the live file), with every session switched to the fake agent so nothing the
 * boot does can bill the account. Then, once per lens (Activity, then Spaces), it wheels the
 * sidebar's list down and back up in trackpad-sized steps while recording:
 *   - every frame's interval from requestAnimationFrame (p50/p95/p99/max, frames over 8.3/16.7 ms),
 *   - long animation frames and long tasks,
 *   - a devtools trace, summed into style / layout / paint / script on the renderer's main thread,
 *   - the number of composited layers.
 * `frameStates` is the compositor's verdict per frame (PipelineReporter); a `*` marks one that
 * counts against smoothness, so STATE_DROPPED* is the frame a person sees stutter.
 * Prints one JSON line per lens (`RESULT {...}`) and writes them to <outDir>/sidebar-scroll-perf.json.
 *
 * SCROLL_PERF_HOME   scratch home to reuse (default ~/.cache/realm-perf-scrollfix/home; seeded once)
 * SCROLL_PERF_LENSES comma list, default "recent,spaces"
 * SCROLL_PERF_BARS   macOS scroll bar style forced on the process: WhenScrolling (overlay) or Always
 * SCROLL_PERF_STREAM N: keep N of the latest sessions answering (the fake agent's "stream slowly")
 *                    for the whole scroll, as a working day has agents running while the list moves
 * SCROLL_PERF_EVAL   an expression run in the page before measuring, for trying a change in place
 * Ports: REALM_DEVTOOLS_PORT (9278), REALM_PORT (8838). Reaps only what holds its own two ports.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9278), SERVER_PORT = Number(process.env.REALM_PORT ?? 8838);
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "sidebar-scroll-perf"));
const HOME = path.resolve(process.env.SCROLL_PERF_HOME ?? path.join(os.homedir(), ".cache/realm-perf-scrollfix/home"));
const SCRATCH = path.dirname(HOME);
const DB = path.join(HOME, "realm.db");
const LENSES = (process.env.SCROLL_PERF_LENSES ?? "recent,spaces").split(",");
const BARS = process.env.SCROLL_PERF_BARS ?? null;
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
const seenPids = [];

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});
async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
  }
}
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map(), listeners = [];
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg); else for (const l of listeners) l(msg);
  });
  return {
    ready, on: (fn) => listeners.push(fn),
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const sql = (stmt) => execFileSync("sqlite3", [DB, stmt], { encoding: "utf8" });
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const setting = (key, value) => sql(`INSERT INTO settings (key, value_json) VALUES (${q(key)}, ${q(JSON.stringify(value))})
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);

function seed() {
  if (fs.existsSync(DB)) return;
  fs.mkdirSync(HOME, { recursive: true });
  // Read-only open of the real database: VACUUM INTO writes only the copy.
  execFileSync("sqlite3", [`file:${path.join(os.homedir(), "Realm/realm.db")}?mode=ro`, `VACUUM INTO ${q(DB)}`]);
}

async function boot() {
  const wrapper = path.join(SCRATCH, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const args = [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
  // NSArgumentDomain: the process alone sees this scroll bar style, the Mac's own setting is untouched.
  if (BARS) args.push("-AppleShowScrollBars", BARS);
  electron = spawn(electronBin, args, {
    env: {
      ...process.env, REALM_HOME: HOME, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(SCRATCH, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  seenPids.push(electron.pid);
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 90000, "renderer");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  // The window opens behind whoever is at the Mac: claim focus, or Realm goes quiet and stops drawing.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return c;
}

async function shutdown(c) {
  try { c?.close(); } catch { /* gone */ }
  electron?.kill("SIGKILL");
  await stopDaemons(HOME, seenPids);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  await sleep(800);
}

const pct = (sorted, p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : 0;

async function measure(c, lens) {
  await until(() => evalIn(c, `(() => { const b = document.querySelector('.space-body'); return !!b && b.scrollHeight - b.clientHeight > 600; })()`), 60000, `list ${lens}`);
  await evalIn(c, `(() => { document.documentElement.removeAttribute('data-window-inactive');
    new MutationObserver(() => document.documentElement.removeAttribute('data-window-inactive')).observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await sleep(4000);
  if (process.env.SCROLL_PERF_EVAL) log("eval", await evalIn(c, process.env.SCROLL_PERF_EVAL));
  const facts = await evalIn(c, `(() => { const b = document.querySelector('.space-body'); b.scrollTop = 0; const r = b.getBoundingClientRect();
    return { rows: b.querySelectorAll('.item').length, nodes: b.getElementsByTagName('*').length, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }, overlay: document.documentElement.hasAttribute('data-overlay-scrollbars'),
      lowPower: document.documentElement.getAttribute('data-quiet') }; })()`);
  log(lens, JSON.stringify(facts));
  await sleep(800);

  let layers = 0;
  await c.send("LayerTree.enable");
  c.on((m) => { if (m.method === "LayerTree.layerTreeDidChange" && m.params.layers) layers = Math.max(layers, m.params.layers.length); });
  const events = [];
  c.on((m) => { if (m.method === "Tracing.dataCollected") events.push(...m.params.value); });
  const traced = new Promise((res) => c.on((m) => { if (m.method === "Tracing.tracingComplete") res(); }));
  const streaming = STREAM > 0 ? await startStreaming() : null;
  const profiling = !!process.env.SCROLL_PERF_PROFILE;
  if (profiling) { await c.send("Profiler.enable"); await c.send("Profiler.setSamplingInterval", { interval: 250 }); await c.send("Profiler.start"); }
  await c.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel,benchmark,graphics.pipeline", transferMode: "ReportEvents" });
  await evalIn(c, `(() => { window.__frames = []; window.__loaf = []; window.__long = []; let last = performance.now(); window.__run = true;
    const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__run) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ d: e.duration, scripts: (e.scripts || []).map((s) => ({ f: s.sourceFunctionName, inv: s.invoker, d: Math.round(s.duration) })) }); }).observe({ type: 'long-animation-frame' });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask' });
    return true; })()`);
  const x = facts.rect.x + facts.rect.w / 2, y = facts.rect.y + facts.rect.h / 2;
  const t0 = Date.now();
  /* One continuous gesture per pass, the way a trackpad delivers one: a begin, a stream of updates at
     the display's cadence, an end — not a separate gesture per wheel tick, which would put a fresh
     hit test on the main thread for every step and measure the harness. Down most of the list and
     back, twice. */
  const travel = Math.min(5000, facts.scrollHeight - facts.clientHeight - 40);
  for (const dir of [-1, 1, -1, 1]) {
    await c.send("Input.synthesizeScrollGesture", { x: Math.round(x), y: Math.round(y), yDistance: dir * travel, speed: 2500, gestureSourceType: "mouse", preventFling: false });
  }
  const wheelMs = Date.now() - t0;
  await streaming?.stop();
  let profileTop = null;
  if (profiling) {
    const { profile } = await c.send("Profiler.stop");
    const byId = new Map(profile.nodes.map((n) => [n.id, n])), parent = new Map();
    for (const n of profile.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
    const label = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
    const self = new Map(), total = new Map();
    profile.samples.forEach((sid, i) => {
      const dt = (profile.timeDeltas[i] ?? 0) / 1000;
      let n = byId.get(sid);
      self.set(label(n), (self.get(label(n)) ?? 0) + dt);
      const seen = new Set();
      for (; n; n = byId.get(parent.get(n.id))) { const k = label(n); if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + dt); } }
    });
    const top = (m, n) => [...m].filter(([k]) => !/^\((idle|program|root|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v)]);
    profileTop = { self: top(self, 15), total: top(total, 30) };
  }
  await sleep(300);
  const page = await evalIn(c, `(() => { window.__run = false; return { frames: window.__frames.slice(2), loaf: window.__loaf, long: window.__long,
    scrolled: document.querySelector('.space-body').scrollTop }; })()`);
  await c.send("Tracing.end");
  await traced;
  await c.send("LayerTree.disable");
  if (process.env.SCROLL_PERF_TRACE) fs.writeFileSync(path.join(OUT, `trace-${lens}${process.env.SCROLL_PERF_TAG ? "-" + process.env.SCROLL_PERF_TAG : ""}.json`), JSON.stringify({ traceEvents: events }));

  const f = [...page.frames].sort((a, b) => a - b);
  const main = (() => {
    // The renderer's main thread: the one carrying the frame's style and layout.
    const counts = new Map();
    for (const e of events) if (e.name === "UpdateLayoutTree" || e.name === "Layout" || e.name === "Paint") counts.set(`${e.pid}:${e.tid}`, (counts.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  })();
  const onMain = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X" && e.dur);
  const sum = (...names) => Math.round(onMain.filter((e) => names.includes(e.name)).reduce((a, e) => a + e.dur, 0) / 1000);
  const scripts = {};
  for (const l of page.loaf) for (const s of l.scripts) { const k = `${s.inv ?? ""} | ${s.f ?? "?"}`; scripts[k] = (scripts[k] ?? 0) + s.d; }
  const tasks = onMain.filter((e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask").map((e) => e.dur / 1000);
  // The compositor's own verdict on each frame, which a main-thread rAF cannot see.
  const reporters = events.filter((e) => e.name === "PipelineReporter" && e.ph === "b");
  const states = {};
  for (const e of reporters) {
    const r = e.args?.frame_reporter ?? {};
    if (r.state === "STATE_NO_UPDATE_DESIRED") continue;
    const k = `${r.state}${r.affects_smoothness ? "*" : ""}`;
    states[k] = (states[k] ?? 0) + 1;
  }
  const result = {
    lens, overlay: facts.overlay, rows: facts.rows, nodes: facts.nodes, wheelMs, frames: f.length,
    p50: pct(f, 0.5), p95: pct(f, 0.95), p99: pct(f, 0.99), max: f.length ? +f[f.length - 1].toFixed(1) : 0,
    over8: f.filter((d) => d > 8.6).length, over16: f.filter((d) => d > 17).length, over33: f.filter((d) => d > 34).length,
    longTasks: page.long.length, longTaskMs: Math.round(page.long.reduce((a, d) => a + d, 0)),
    loafs: page.loaf.length, loafMs: Math.round(page.loaf.reduce((a, l) => a + l.d, 0)),
    mainMs: { style: sum("UpdateLayoutTree"), layout: sum("Layout"), prePaint: sum("PrePaint"), paint: sum("Paint"), layerize: sum("Layerize"),
      script: sum("FunctionCall", "EvaluateScript", "TimerFire", "FireAnimationFrame", "EventDispatch", "V8.Execute"), tasksOver16: tasks.filter((d) => d > 16).length },
    layers, frameStates: states,
    profileTop,
    topScripts: Object.entries(scripts).sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
  console.log("RESULT", JSON.stringify(result));
  return result;
}

const STREAM = Number(process.env.SCROLL_PERF_STREAM ?? 0);
/** N sessions answering on a loop, over the server's socket, until stopped. */
async function startStreaming() {
  const ids = sql(`SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ${STREAM}`).trim().split("\n").filter(Boolean);
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}`, tokenProtocols(await daemonToken(HOME)));
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let id = 0, on = true;
  const send = (sid) => ws.send(JSON.stringify({ id: String(++id), method: "sessions.send", params: { id: sid, text: "stream slowly", attachments: [], mentions: [] } }));
  const loops = ids.map(async (sid, i) => { await sleep(i * 300); while (on) { send(sid); await sleep(5000); } });
  await sleep(1500);
  return { stop: async () => { on = false; await Promise.allSettled(loops); ws.close(); } };
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  seed();
  // Every engine is the fake one: a boot that resumes, titles or recaps anything bills nobody.
  sql(`UPDATE sessions SET agent_kind = 'fake' WHERE agent_kind <> 'fake'`);
  const results = [];
  for (const lens of LENSES) {
    setting("ui.sidebarLens", lens);
    log("boot", lens);
    const c = await boot();
    try { results.push(await measure(c, lens)); } finally { await shutdown(c); }
  }
  fs.writeFileSync(path.join(OUT, `sidebar-scroll-perf${process.env.SCROLL_PERF_TAG ? "-" + process.env.SCROLL_PERF_TAG : ""}.json`), JSON.stringify(results, null, 2));
}

main().catch(async (e) => { console.log("FAIL", e.message); process.exitCode = 1; await shutdown(null); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void shutdown(null).then(() => process.exit(1)); });
