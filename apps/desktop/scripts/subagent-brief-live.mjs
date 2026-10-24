/**
 * Live check for the sub-agent viewer's report disclosure and brief (run with: pnpm build && node apps/desktop/scripts/subagent-brief-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, as a scratch window that cannot take focus, with the
 * scripted agent standing in for Claude and Codex, so the lead and its sub-agent run the script and
 * nothing reaches an account. The lead runs "Hand over a written brief" — one delegated child whose
 * goal is written in parts (where you work, read first, what to build, proof required). Then:
 *
 *   1. The brief: drawn in its parts, at a reading measure — its width measured in the window, and
 *      the characters on a line of its prose counted — with the files to read first as chips that
 *      open them in the documents pane.
 *   2. The report: its head opens and closes it by click and by the keyboard; the body's height
 *      moves over the size rung, and under Reduce motion it lands at once.
 *   3. Captures of the viewer, dark and light, report open and closed.
 *
 * Ports: REALM_PORT (8792) / REALM_DEVTOOLS_PORT (9232). Screenshots go to LIVE_OUT_DIR. Kills only
 * what listens on its own ports, and only a process started from this checkout.
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
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9232);
const SERVER_PORT = Number(process.env.REALM_PORT ?? 8792);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const TAG = process.env.LIVE_TAG ?? "brief";
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-subagent-brief-live-"));
const home = path.join(scratch, "home");
const TITLE = "Viewer work";
const VIEWPORT = { width: 1440, height: 900 };
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
    await sleep(200);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
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

/** Kill what listens on `port`, but only a process this checkout started. */
function killPort(port) {
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { return; }
  for (const pid of pids) {
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { continue; }
    if (!command.includes(repoRoot)) { note("left alone", { port, pid, command: command.slice(0, 120) }); continue; }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** The brief's measure, read off the laid-out page: the column's width and font, and the characters
 *  on each line of the longest paragraph, counted from where the line boxes break. */
const MEASURE = `(() => {
  const brief = document.querySelector('.subagent-view .subagent-brief');
  if (!brief) return null;
  const view = document.querySelector('.subagent-view');
  const longest = [...brief.querySelectorAll('.md p, .md li')].sort((a, b) => b.textContent.length - a.textContent.length)[0];
  const lines = [];
  if (longest) {
    const walk = document.createTreeWalker(longest, NodeFilter.SHOW_TEXT);
    let top = null, count = 0;
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      for (let i = 0; i < t.data.length; i++) {
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
        const b = r.getClientRects()[0]; if (!b) continue;
        if (top !== null && b.top > top + 4) { lines.push(count); count = 0; }
        top = b.top; count++;
      }
    }
    lines.push(count);
  }
  const cs = getComputedStyle(brief);
  return { viewer: Math.round(view.getBoundingClientRect().width), brief: Math.round(brief.getBoundingClientRect().width),
    maxWidth: cs.maxWidth, font: cs.fontSize, lines, heads: [...brief.querySelectorAll('.subagent-brief-head')].map((h) => h.textContent),
    chips: [...brief.querySelectorAll('.subagent-brief-chip')].map((c) => ({ text: c.textContent, button: c.tagName === 'BUTTON', h: Math.round(c.getBoundingClientRect().height) })) };
})()`;

const RESULT = `(() => {
  const res = document.querySelector('.subagent-view-result'); if (!res) return null;
  const t = res.querySelector('.subagent-view-result-toggle'), wrap = res.querySelector('.subagent-view-result-wrap');
  return { card: Math.round(res.getBoundingClientRect().height), body: Math.round(wrap.getBoundingClientRect().height), toggle: Math.round(t.getBoundingClientRect().height),
    expanded: t.getAttribute('aria-expanded'), transition: getComputedStyle(wrap).transitionDuration, inert: !!res.querySelector('.subagent-view-result-clip[inert]') };
})()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = () => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);
  await awake();

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await awake();

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  await api.call("agents.probe", { force: false });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", model: "claude-opus-5-5", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  await api.call("sessions.send", { id: lead, text: "Hand over a written brief.", attachments: [], mentions: [] });
  const [kid] = await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.length === 1 && k[0].outcome && k[0].report ? k : null; }, 60_000, "the child reported");
  // The files the brief says to read first, in the checkout the child works in, so the chips have
  // something real to open.
  const cwd = kid.session.cwd;
  note("child", { cwd, goal: kid.goal.slice(0, 60), report: kid.report.slice(0, 60) });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "design.md"), "# Design\n\nCalm, quiet surfaces.\n");
  fs.writeFileSync(path.join(cwd, "src/viewer.tsx"), "export function Viewer() { return null; }\n");
  await until(async () => (await api.call("sessions.get", { id: lead }))?.status !== "running", 30_000, "lead turn over");
  await until(() => evalIn(c, `[...document.querySelectorAll('.transcript .delegation-line .tool-row')].length >= 1`), 15_000, "the line");
  await evalIn(c, `(() => { document.querySelector('.transcript .delegation-line .tool-row').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.subagent-view .subagent-brief') && !!document.querySelector('.subagent-view-result')`), 15_000, "the viewer with its brief");
  await sleep(1200);

  // ── 1. The brief ──────────────────────────────────────────────────────────────────────────────
  const m = await evalIn(c, MEASURE);
  note("brief measure", m);
  check("the brief is drawn in its parts", JSON.stringify(m.heads) === JSON.stringify(["Where you work", "Read first", "What to build", "Proof required"]), m.heads);
  // The panel is narrower than the measure at this size; a wide window is where the cap has to hold.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const wide = await evalIn(c, MEASURE);
  note("brief measure, wide window", wide);
  check("in a wide panel the brief stops at its measure, not the panel's edge", wide.viewer > Number.parseFloat(wide.maxWidth) + 40 && Math.abs(wide.brief - Number.parseFloat(wide.maxWidth)) <= 1, { brief: wide.brief, max: wide.maxWidth, viewer: wide.viewer });
  check("…and its lines still read at 60–80 characters", wide.lines.slice(0, -1).every((n) => n >= 55 && n <= 85), wide.lines);
  await shotOf(c, ".subagent-view", "viewer-wide", "dark", { top: true });
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await sleep(800);
  const full = m.lines.slice(0, -1);
  check("a full line of its prose is 60–80 characters", full.length > 0 && full.every((n) => n >= 55 && n <= 85), m.lines);
  check("the files that exist are chips that open; the one that does not is named only",
    m.chips.filter((x) => x.button).map((x) => x.text).join("|").includes("design.md") && m.chips.some((x) => !x.button && x.text.includes("viewer.test.tsx")), m.chips);
  check("no bubble repeats the brief", await evalIn(c, `!document.querySelector('.subagent-view .msg-user')`));

  // ── 2. The disclosure ─────────────────────────────────────────────────────────────────────────
  const open = await evalIn(c, RESULT);
  note("report open", open);
  check("the report starts open", open.expanded === "true" && !open.inert && open.body > 20, open);
  check("its head is a 40px target", open.toggle >= 40, open.toggle);
  const at = await evalIn(c, `(() => { const r = document.querySelector('.subagent-view-result-toggle').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; })()`);
  const press = async (p) => { for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }); };
  // The body's height through the fold, sampled each frame: it moves, rather than jumping.
  const sampled = () => evalIn(c, `new Promise((done) => { const w = document.querySelector('.subagent-view-result-wrap'); const out = []; const t0 = performance.now();
    const tick = () => { out.push(Math.round(w.getBoundingClientRect().height)); if (performance.now() - t0 < 320) requestAnimationFrame(tick); else done(out); }; requestAnimationFrame(tick); })`);
  await press(at);
  const moving = await evalIn(c, `(() => { const w = document.querySelector('.subagent-view-result-wrap');
    return w.getAnimations().map((a) => ({ property: a.transitionProperty, duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing })); })()`);
  const frames = await sampled();
  note("fold: transitions running on the body, then its height by frame", { moving, frames });
  check("closing moves the body on the size rung", moving.some((a) => a.property === "grid-template-rows" && a.duration === 200), moving);
  const closed = await evalIn(c, RESULT);
  note("report closed", closed);
  check("closed, the card is its head and the body is gone from reading", closed.expanded === "false" && closed.body === 0 && closed.inert && closed.card <= 46, closed);
  for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".subagent-view", "viewer-closed", face, { top: true }); }
  await setFace(c, "dark");
  // The keyboard: Enter on the focused head opens it again, Space closes it.
  await evalIn(c, `document.querySelector('.subagent-view-result-toggle').focus(), true`);
  const key = async (k, code, text) => { await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: k === "Enter" ? 13 : 32, text }); await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: k === "Enter" ? 13 : 32 }); await sleep(400); };
  await key("Enter", "Enter", "\r");
  const byEnter = await evalIn(c, RESULT);
  check("Enter on the head opens it", byEnter.expanded === "true" && byEnter.body > 20, byEnter);
  await evalIn(c, `document.activeElement.blur(), true`);
  for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".subagent-view", "viewer-open", face, { top: true }); }
  await evalIn(c, `document.querySelector('.subagent-view-result-toggle').focus(), true`);
  await setFace(c, "dark");
  await key(" ", "Space", " ");
  check("Space on the head closes it", (await evalIn(c, RESULT)).expanded === "false");
  // Under Reduce motion the fold lands in the frame it was asked for.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(200);
  await press(at);
  const stillMoving = await evalIn(c, `document.querySelector('.subagent-view-result-wrap').getAnimations().length`);
  const still = await sampled();
  const reduced = await evalIn(c, RESULT);
  note("reduced motion, body height by frame", still);
  check("under Reduce motion it opens at once", reduced.expanded === "true" && reduced.transition === "0s" && stillMoving === 0 && still.every((h) => h === reduced.body), { transition: reduced.transition, stillMoving, still });
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  // ── The brief alone, both faces, and a chip opening its file ─────────────────────────────────
  for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".subagent-view", "viewer-reduced-open", face, { top: true }); }
  await setFace(c, "dark");
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-view button.subagent-brief-chip')].find((b) => b.textContent.includes('design.md')).click(); return true; })()`);
  const opened = await until(() => evalIn(c, `[...document.querySelectorAll('[role=tab], .panel-tab, .side-tab')].some((t) => /design\\.md|Documents/.test(t.textContent)) || null`), 10_000, "documents opened").catch(() => false);
  check("a chip opens its file in the documents pane", !!opened);
}

async function setFace(c, face) {
  await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
  await sleep(350);
}

/** A capture of one element and a margin round it, over a ground standing in for the window's
 *  material (which is not in the DOM, so a capture of the translucent grounds comes out see-through). */
async function shotOf(c, selector, what, face, { pad = 8, top = false } = {}) {
  // From the top of the log: the brief is the first thing in it, and a live log sits at its foot.
  if (top) { await evalIn(c, `(() => { const t = document.querySelector('.subagent-view .transcript'); if (t) t.scrollTop = 0; return true; })()`); await sleep(300); }
  const box = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  if (!box) { note(`nothing to capture for ${what}`, selector); return; }
  await evalIn(c, `(() => { const r = document.documentElement; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = 'none';
    r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; getSelection().removeAllRanges(); return true; })()`);
  const { x, y, w, h } = box;
  const clip = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(VIEWPORT.width, w + pad * 2), height: Math.min(VIEWPORT.height - Math.max(0, y - pad), h + pad * 2), scale: 1 };
  const file = path.join(OUT_DIR, `${TAG}-${what}-${face}.png`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${what}-${face} ${file}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = ''; return true; })()`);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
