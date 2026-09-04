/**
 * Live power check (run with: node apps/desktop/scripts/power-live.mjs)
 *
 * Boots the REAL app (built out/main against the built realm-server) on a scratch REALM_HOME and
 * measures what a streaming agent actually costs, in renderer CPU seconds and in frames, rather
 * than reasoning about it.
 *
 * The claim under test is the one the delta-coalescing change rests on: an agent streaming into a
 * window nobody can see should cost nothing, because Chromium stops servicing requestAnimationFrame
 * for a window that is hidden. That is a Chromium behaviour, not ours, so it is measured here.
 *
 *   1. rAF liveness — a page-side frame counter, sampled with the window visible and again with the
 *      app hidden (⌘H via System Events). Visible must run at display rate; hidden must be ~0.
 *   2. Streaming cost — the fake agent (one delta PER CHARACTER, the worst case any real adapter
 *      can produce) is driven straight over realm-server's RPC at a fixed cadence, so the load is
 *      identical across runs. Renderer CPU is sampled from the OS, and the transcript's DOM
 *      mutations are counted page-side, with the window visible and then hidden.
 *
 * Ports: 9223 (CDP), 8788 (realm-server). Refuses to run if either is taken. Touches only a scratch
 * dir (REALM_HOME + userData); kills only the processes it started.
 *
 * `--label <name>` tags the JSON summary, so a run against a build with the coalescing reverted can
 * be compared against one with it in place.
 */
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = 9223, SERVER_PORT = 8788;
const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "current";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-power-live-"));
const results = {};
let electron = null, rpc = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The stream under test. 24 messages at 250ms is ~6s of continuous streaming — long enough for a
   CPU sample to mean something, and paced so the run is reproducible rather than a single burst. */
const MESSAGES = 24, MESSAGE_GAP_MS = 250;
const PROMPT = "Explain the change. ".repeat(30); // ~600 chars echoed back one delta per character

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

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => { results[name] = { detail }; console.log(`   • ${name} ${JSON.stringify(detail)}`); };

/** Minimal CDP client over the renderer page's websocket. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push("EXC " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 200));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return { ready, send, close: () => ws.close(), errors };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A realm-server RPC client, so the stream is driven at a cadence this script owns. */
function rpcClient(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.ok ? resolve(m.result) : reject(new Error(`${m.error.code}: ${m.error.message}`)); }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const mid = String(++id);
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ready, call, close: () => ws.close() };
}

/* ── CPU sampling ───────────────────────────────────────────────────────────────────────────────
   `ps -o time=` is cumulative CPU time for a process, so the difference across a window is CPU
   SECONDS SPENT in that window — which is what a battery drains for. Instantaneous %cpu would be a
   sample of whatever the scheduler happened to be doing. The renderer is the helper process whose
   command line carries --type=renderer; the browser-pane WebContentsViews are renderers too, but
   this run never opens one. */
const pidsUnder = (rootPid) => {
  const out = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n");
  const rows = out.map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null; }).filter(Boolean);
  const kept = new Set([rootPid]);
  for (let i = 0; i < 6; i++) for (const r of rows) if (kept.has(r.ppid)) kept.add(r.pid);
  return rows.filter((r) => kept.has(r.pid));
};
const rendererPid = (rootPid) => pidsUnder(rootPid).find((r) => r.cmd.includes("--type=renderer"))?.pid ?? null;
/** Cumulative CPU seconds for a pid, from `ps` TIME (`[[dd-]hh:]mm:ss[.ff]`). */
const cpuSeconds = (pid) => {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const [hms, frac = "0"] = t.split(".");
  const parts = hms.split(/[-:]/).map(Number);
  const secs = parts.reverse().reduce((a, v, i) => a + v * [1, 60, 3600, 86400][i], 0);
  return secs + Number(`0.${frac}`);
};
const rssMb = (pid) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;

/* ── Window visibility ──────────────────────────────────────────────────────────────────────────
   ⌘H, via System Events, on the process this script started — the real thing a user does when they
   switch away mid-run, and the case Chromium is supposed to stop painting for. */
const setAppHidden = (pid, hidden) => {
  execFileSync("osascript", ["-e",
    `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to ${hidden ? "false" : "true"}`]);
};

/** Roll a CDP CPU profile up to self-time per function, hottest first — where the renderer's
 *  milliseconds actually went, by sample count rather than by inspection. */
function topSelfTime(profile, n) {
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const self = new Map();
  for (const id of profile.samples ?? []) self.set(id, (self.get(id) ?? 0) + 1);
  const total = (profile.samples ?? []).length || 1;
  const rows = [...self.entries()].map(([id, hits]) => {
    const cf = byId.get(id)?.callFrame ?? {};
    const where = (cf.url ?? "").split("/").pop() ?? "";
    return { fn: `${cf.functionName || "(anonymous)"}${where ? " @" + where : ""}`, pct: +((hits / total) * 100).toFixed(1) };
  });
  return rows.sort((a, b) => b.pct - a.pct).slice(0, n);
}

/** Page-side instruments: a rAF counter and a transcript mutation counter, both cumulative. */
const INSTRUMENT = `(() => {
  if (window.__power) return "already";
  const st = { frames: 0, mutations: 0 };
  const tick = () => { st.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const obs = new MutationObserver((rs) => { st.mutations += rs.length; });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  window.__power = st;
  return "installed";
})()`;

/** Run the stream for `MESSAGES` messages, sampling the renderer's CPU across exactly that window. */
async function measure(c, sessionId, rPid, phase) {
  await evalIn(c, `(() => { window.__power.frames = 0; window.__power.mutations = 0; return 1; })()`);
  const cpu0 = cpuSeconds(rPid), t0 = Date.now();
  const sendErrors = [];
  for (let i = 0; i < MESSAGES; i++) {
    await rpc.call("sessions.send", { id: sessionId, text: `${PROMPT} #${i}`, attachments: [], mentions: [] })
      .catch((e) => sendErrors.push(e.message));
    await sleep(MESSAGE_GAP_MS);
  }
  await sleep(600); // let the last echo settle
  const wallMs = Date.now() - t0;
  const cpuMs = Math.round((cpuSeconds(rPid) - cpu0) * 1000);
  const { frames, mutations } = await evalIn(c, `({ frames: window.__power.frames, mutations: window.__power.mutations })`);
  return { phase, wallMs, rendererCpuMs: cpuMs, cpuPercent: +((cpuMs / wallMs) * 100).toFixed(1), frames, mutations, rssMb: +rssMb(rPid).toFixed(1), sendErrors: sendErrors.slice(0, 3) };
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");

  // Onboarding → first space.
  try {
    await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  } catch (e) {
    // What the window is actually showing beats guessing at a selector that stopped matching.
    console.error("onboarding never appeared; page shows:", await evalIn(c, `document.body.innerHTML.slice(0, 1200)`));
    throw e;
  }
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(input, "Power"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 20000, "first pane");

  // A fake-agent session, made server-side so this script owns the stream's cadence.
  rpc = rpcClient(`ws://127.0.0.1:${SERVER_PORT}`);
  await rpc.ready;
  const spaces = await rpc.call("spaces.list", {});
  const spaceId = spaces[0].id;
  // A distinctive title, because onboarding already left a session in the sidebar and clicking the
  // FIRST row opens that one — measuring an app whose streaming transcript is not even on screen.
  const TITLE = "PowerProbe";
  const created = await rpc.call("sessions.create", { spaceId, agentKind: "fake", title: TITLE });
  const sessionId = created.session.id;

  // Open ITS pane in the renderer, so the transcript is genuinely rendering.
  const clickProbeRow = `(() => {
    const row = [...document.querySelectorAll('.item-row')].find((r) => r.querySelector('.item-title')?.textContent === ${JSON.stringify(TITLE)});
    if (!row) return false; row.click(); return true; })()`;
  await until(() => evalIn(c, clickProbeRow), 10000, "probe session row");
  await until(() => evalIn(c, `!!document.querySelector('.transcript')`), 10000, "session pane open");

  // Prove the OPEN pane is this session's before measuring anything: one warm-up message must show up
  // in the transcript. Without this the CPU numbers silently describe an app rendering nothing.
  await rpc.call("sessions.send", { id: sessionId, text: "warm up", attachments: [], mentions: [] });
  await until(() => evalIn(c, `document.querySelectorAll('.msg-assistant').length >= 1`), 15000, "warm-up echo rendered");
  check("the streaming session's transcript is the pane on screen", true);

  // ── 0. What startup costs ────────────────────────────────────────────────────────────────────
  // Navigation Timing from the renderer itself, so "is the bundle worth splitting further" is a
  // number rather than an opinion. `scriptEvalMs` is the window between the HTML being parsed and
  // the app being interactive — the part more code-splitting could actually move.
  note("renderer startup", await evalIn(c, `(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const js = performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js"))
      .map((r) => ({ file: r.name.split("/").pop(), ms: +r.duration.toFixed(0), kb: +((r.encodedBodySize || 0) / 1024).toFixed(0) }))
      .sort((a, b) => b.ms - a.ms).slice(0, 4);
    return {
      domContentLoadedMs: +nav.domContentLoadedEventEnd.toFixed(0),
      loadEventMs: +nav.loadEventEnd.toFixed(0),
      scriptEvalMs: +(nav.domContentLoadedEventEnd - nav.responseEnd).toFixed(0),
      js,
    }; })()`));

  await evalIn(c, INSTRUMENT);
  const rPid = await until(async () => rendererPid(electron.pid), 10000, "renderer pid");
  note("renderer pid", rPid);

  // ── 0b. What the app costs doing NOTHING ─────────────────────────────────────────────────────
  // The battery question most of a day answers: an open Realm with no agent running. Every process
  // in the tree, because a renderer at 0% means little if the server or the GPU process is spinning.
  const treeCpu = () => pidsUnder(electron.pid).map((r) => ({ pid: r.pid, cpu: cpuSeconds(r.pid) }));
  const idleBefore = treeCpu();
  await sleep(10000);
  const idleAfter = new Map(treeCpu().map((r) => [r.pid, r.cpu]));
  const idleMs = idleBefore.reduce((a, r) => a + Math.max(0, (idleAfter.get(r.pid) ?? r.cpu) - r.cpu), 0) * 1000;
  check("an idle app with no agent running is near-zero CPU", idleMs / 10000 < 0.05,
    { wholeTreeCpuPercent: +((idleMs / 10000) * 100).toFixed(1), processes: idleBefore.length });

  // ── 1. rAF liveness, visible vs hidden ────────────────────────────────────────────────────────
  const frameRate = async (ms) => {
    const a = await evalIn(c, `window.__power.frames`);
    await sleep(ms);
    const b = await evalIn(c, `window.__power.frames`);
    return +(((b - a) / ms) * 1000).toFixed(1);
  };
  const fpsVisible = await frameRate(2000);
  check("frames run at display rate while the window is visible", fpsVisible > 20, { fps: fpsVisible });

  setAppHidden(electron.pid, true);
  await sleep(1200); // let the hide settle before sampling
  const fpsHidden = await frameRate(3000);
  // THE claim the coalescing rests on: no frames means no delta work at all.
  check("frames STOP while the app is hidden (so coalesced deltas cost nothing)", fpsHidden < 1, { fps: fpsHidden });
  setAppHidden(electron.pid, false);
  await sleep(1200);

  // ── 2. Streaming cost, visible vs hidden ─────────────────────────────────────────────────────
  // A CPU profile across the visible phase, so "what is the renderer still spending time on" is
  // answered by samples rather than by guessing at the code.
  await c.send("Profiler.enable");
  await c.send("Profiler.setSamplingInterval", { interval: 200 });
  await c.send("Profiler.start");
  const visible = await measure(c, sessionId, rPid, "visible");
  const { profile } = await c.send("Profiler.stop");
  note("top self-time in the renderer while streaming", topSelfTime(profile, 12));
  note("streaming, window visible", visible);

  setAppHidden(electron.pid, true);
  await sleep(1200);
  const hidden = await measure(c, sessionId, rPid, "hidden");
  setAppHidden(electron.pid, false);
  await sleep(800);
  note("streaming, app hidden", hidden);

  // Rate, not total: the two phases do not take the same wall time, so CPU SECONDS are not comparable
  // between them while CPU-per-second-of-streaming is.
  check("hiding the app cuts renderer CPU for the same stream", hidden.cpuPercent < visible.cpuPercent,
    { visiblePercent: visible.cpuPercent, hiddenPercent: hidden.cpuPercent,
      saved: `${(100 - (hidden.cpuPercent / Math.max(0.1, visible.cpuPercent)) * 100).toFixed(0)}%` });

  // The transcript must still be CORRECT after a stream the window never painted: every echo landed,
  // because the persisted assistant_text does not depend on a frame ever running.
  const expected = MESSAGES * 2 + 1; // + the warm-up turn
  await until(() => evalIn(c, `document.querySelectorAll('.msg-assistant').length >= ${expected}`), 20000, "echoes")
    .catch(() => {}); // a short count is the finding, not a harness failure
  const rendered = await evalIn(c, `document.querySelectorAll('.msg-assistant').length`);
  const persisted = (await rpc.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 100000 }))
    .filter((e) => e.event.type === "assistant_text").length;
  // Two different questions. `persisted` asks whether the SERVER recorded every turn; `rendered` asks
  // whether the transcript shows them. Coalescing may only ever affect the second.
  check("every message streamed while hidden is rendered once the window returns",
    rendered >= expected && persisted >= expected, { expected, rendered, persisted, sendErrors: [...visible.sendErrors, ...hidden.sendErrors] });

  // ── 3. What a closed pane still holds ────────────────────────────────────────────────────────
  // `transcripts` is only ever pruned when an item is DELETED, so every session opened in the app's
  // lifetime keeps its blocks — every message and every full tool result — for as long as the window
  // lives. Closing a pane is the user saying they are done with it; this measures what that costs.
  await c.send("HeapProfiler.enable");
  const heapAfterGc = async () => {
    for (let i = 0; i < 3; i++) { await c.send("HeapProfiler.collectGarbage"); await sleep(250); }
    return +((await c.send("Runtime.getHeapUsage")).usedSize / 1048576).toFixed(2);
  };
  const heapOpen = await heapAfterGc();
  await evalIn(c, `(() => {
    const btn = [...document.querySelectorAll('.item-close')].find((b) => b.getAttribute('aria-label') === 'Close ${TITLE}');
    if (!btn) return false; btn.click(); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('.transcript')`), 10000, "pane closed");
  const heapClosed = await heapAfterGc();
  const blocks = (await rpc.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 100000 })).length;
  note("heap held after closing the pane", {
    heapOpenMb: heapOpen, heapClosedMb: heapClosed, freedMb: +(heapOpen - heapClosed).toFixed(2),
    persistedEvents: blocks,
  });

  check("no renderer exceptions during the run", c.errors.length === 0, c.errors.slice(0, 3));

  results.__summary = { label: LABEL, fpsVisible, fpsHidden, visible, hidden };
  console.log("\n" + JSON.stringify(results.__summary, null, 2));
}

main()
  .catch((e) => { console.error("FAIL harness:", e.message); process.exitCode = 1; })
  .finally(async () => {
    try { rpc?.close(); } catch { /* already closed */ }
    if (electron) {
      try { setAppHidden(electron.pid, false); } catch { /* gone */ }
      // The whole tree, children first. Killing only the root re-parents realm-server to init, where
      // it keeps the RPC port and makes the NEXT run refuse to start — collected before the root dies
      // because a dead root makes its children unfindable by ppid.
      const tree = pidsUnder(electron.pid).map((r) => r.pid).reverse();
      for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
    await sleep(500);
    fs.rmSync(scratch, { recursive: true, force: true });
    const outFile = path.join(os.tmpdir(), `realm-power-${LABEL}.json`);
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`\nwrote ${outFile}`);
  });
