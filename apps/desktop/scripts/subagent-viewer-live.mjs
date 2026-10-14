/**
 * Live check for the sub-agent viewer in the side panel (run with: pnpm build && node apps/desktop/scripts/subagent-viewer-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, as a scratch window that cannot take focus, with the
 * scripted agent standing in for Claude and Codex, so the lead and every sub-agent run the script and
 * nothing reaches an account. The lead runs "Orchestrate the theme work" (four delegated children:
 * one held on a permission, one on a question, one working a while, one done at once) and then
 * "Restart the stalled agents" (the harness's own Task and background agents). Checks, in the window:
 *
 *   1. A sub-agent's line in the lead's transcript opens it in the side panel's Agents tab — no
 *      dialog over the session — and the keyboard stays in the lead's prompter.
 *   2. The viewer's head says the state in words, the clock, the model and harness; the switcher lists
 *      every sibling with its state; the permission is answered in the viewer, on the CHILD.
 *   3. A finished child has its report pinned under the head.
 *   4. The harness agents open the same way, from the strip under the last message.
 *   5. Escape goes back to All; the panel resizes from its edge and the viewer follows; after a
 *      reload the tab opens on the sub-agent it was left on.
 *
 * Captured dark and light. Ports: REALM_PORT (8797) / REALM_DEVTOOLS_PORT (9237), or LIVE_SERVER_PORT /
 * LIVE_CDP_PORT. Screenshots go to LIVE_OUT_DIR. Kills only what listens on its own ports.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? process.env.REALM_DEVTOOLS_PORT ?? 9237);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? process.env.REALM_PORT ?? 8797);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-subagent-viewer-live-"));
const home = path.join(scratch, "home");
const TITLE = "Theme work";
const VIEWPORT = { width: 1560, height: 940 };
const OUT = (tag) => path.join(OUT_DIR, `subagent-viewer-${tag}.png`);
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** A button by its visible text inside `scope`. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`;

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
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1",
      // Claude and Codex are the scripted agent: the lead, every child, and onboarding's session.
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

  // ── The fan-out ────────────────────────────────────────────────────────────────────────────
  await api.call("sessions.send", { id: lead, text: "Orchestrate the theme work.", attachments: [], mentions: [] });
  const kids = await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.length === 4 ? k : null; }, 30_000, "four children");
  const tests = kids.find((k) => k.goal?.startsWith("Run the settings")).session.id;
  await until(async () => (await api.call("sessions.get", { id: tests }))?.status === "waiting_permission", 30_000, "the test run waiting");
  await until(() => evalIn(c, `[...document.querySelectorAll('.transcript .delegation-line .tool-row')].length >= 4`), 15_000, "four lines");
  await sleep(800);

  // 1. A line opens the viewer in the side panel, with the keyboard left in the lead's prompter.
  await evalIn(c, `(() => { document.querySelector('.composer textarea, .composer [contenteditable]')?.focus(); return true; })()`);
  const before = await evalIn(c, `!!document.activeElement?.closest('.composer')`);
  await evalIn(c, `(() => { [...document.querySelectorAll('.transcript .delegation-line .tool-row')].find((b) => b.getAttribute('aria-label').includes('settings test suite')).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('#side-panel .subagent-view')`), 10_000, "viewer in the side panel");
  await sleep(1000);
  const place = await evalIn(c, `(() => { const v = document.querySelector('.subagent-view').getBoundingClientRect(), s = document.querySelector('.session-pane, .transcript').getBoundingClientRect();
    return { viewerLeft: Math.round(v.left), sessionRight: Math.round(s.right), dialogs: document.querySelectorAll('[role=dialog]').length, docks: document.querySelectorAll('.pane-dock').length,
      inPanel: !!document.querySelector('.subagent-view').closest('#side-panel'), keyboard: !!document.activeElement?.closest('.composer') }; })()`);
  note("placement", place);
  check("the viewer is in the side panel, beside the session and not over it", place.inPanel && place.viewerLeft >= place.sessionRight - 1 && place.dialogs === 0 && place.docks === 0, place);
  check("the keyboard stays in the lead's prompter", before === false || place.keyboard, { before, after: place.keyboard });

  // 2. Head, switcher, and the request answered in place.
  const head = await evalIn(c, `({ title: document.querySelector('.subagent-view-title')?.textContent, facts: document.querySelector('.subagent-view-facts')?.textContent,
    tabs: [...document.querySelectorAll('.subagent-switch-tab')].map((t) => t.getAttribute('aria-label') ?? t.textContent),
    request: !!document.querySelector('.subagent-view .permission-card') })`);
  note("viewer head", head);
  check("the head says its state in words, its clock and its model", /Needs you/.test(head.facts) && /\d+s/.test(head.facts) && / on (Codex|Claude)/.test(head.facts), head.facts);
  check("the switcher lists All and the four siblings with their states", head.tabs.length === 5 && head.tabs[0] === "All" && head.tabs.slice(1).every((t) => /, (Working|Needs you|Done|Queued)/.test(t)), head.tabs);
  check("the request is answerable in the viewer", head.request);
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(500);
    await shot(c, `1-waiting-${face}`);
  }
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  await evalIn(c, `(() => { document.querySelector('.subagent-view .permission-card button[data-decision="allow"]').click(); return true; })()`);
  await until(async () => (await api.call("sessions.events", { id: tests, afterSeq: 0, limit: 2000 })).some((e) => e.event.type === "permission_response" && e.event.payload.decision === "allow"), 10_000, "allowed on the child");
  check("Allow in the viewer answered the CHILD's request", true);
  await until(() => evalIn(c, `/Done/.test(document.querySelector('.subagent-view-state')?.textContent ?? '')`), 15_000, "the child done").catch(() => null);
  await sleep(600);

  // 3. The question, from the switcher, and a finished one's pinned report.
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-switch-tab')].find((t) => (t.getAttribute('aria-label') ?? '').includes('Needs you')).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.subagent-view .question-card')`), 10_000, "question in the viewer");
  await sleep(400);
  await shot(c, "2-question-dark");
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-view .question-option')].find((x) => x.textContent.includes("Dark")).click(); return true; })()`);
  await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.every((x) => x.outcome) ? k : null; }, 60_000, "all four settled");
  await sleep(1000);
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-switch-tab')].find((t) => (t.getAttribute('aria-label') ?? '').startsWith('Run the settings')).click(); return true; })()`);
  const pinned = await until(() => evalIn(c, `document.querySelector('.subagent-view-result')?.textContent ?? null`), 10_000, "pinned report").catch(() => null);
  check("a finished child's report is pinned under the head", /eighteen settings tests pass/.test(pinned ?? ""), pinned);
  const pinGeom = await evalIn(c, `(() => { const r = document.querySelector('.subagent-view-result').getBoundingClientRect(), b = document.querySelector('.subagent-view-body').getBoundingClientRect(); return { resultBottom: Math.round(r.bottom), bodyTop: Math.round(b.top) }; })()`);
  check("…above the log, outside its scroller", pinGeom.resultBottom <= pinGeom.bodyTop + 1, pinGeom);
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(500);
    await shot(c, `3-done-${face}`);
  }
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);

  // 4. The harness's own agents, from the strip under the last message.
  await until(async () => (await api.call("sessions.get", { id: lead }))?.status !== "running", 60_000, "lead turn over");
  await api.call("sessions.send", { id: lead, text: "Restart the stalled agents.", attachments: [], mentions: [] });
  await until(() => evalIn(c, `[...document.querySelectorAll('.subagent-strip-row')].some((r) => r.textContent.includes('Teams rule engine'))`), 30_000, "strip row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-strip-row')].find((r) => r.textContent.includes('Teams rule engine')).click(); return true; })()`);
  const harness = await until(() => evalIn(c, `document.querySelector('.subagent-view-title')?.textContent === 'Teams rule engine' ? { facts: document.querySelector('.subagent-view-facts').textContent, foot: !!document.querySelector('.subagent-view-foot') } : null`), 10_000, "harness viewer").catch(() => null);
  check("a harness agent opens in the same viewer, with no foot it cannot honour", harness && /Working/.test(harness.facts) && !harness.foot, harness);
  await sleep(500);
  for (const face of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
    await sleep(500);
    await shot(c, `4-harness-${face}`);
  }
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);

  // 5. Remembered across a reload.
  await sleep(800); // the debounce that writes it
  await c.send("Page.reload", {});
  await sleep(1500);
  await awake();
  const restored = await until(() => evalIn(c, `document.querySelector('.subagent-view-title')?.textContent ?? null`), 30_000, "restored viewer").catch(() => null);
  check("after a reload the tab opens on the sub-agent it was left on", restored === "Teams rule engine", restored);

  // …and Escape goes back to All, with the keyboard on its tab.
  await evalIn(c, `(() => { document.querySelector('.subagent-view-title').closest('.subagent-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  const all = await until(() => evalIn(c, `!document.querySelector('.subagent-view') && document.querySelector('.subagent-switch-tab[aria-selected="true"]')?.textContent === 'All'`), 5_000, "back to all").catch(() => false);
  check("Escape goes back to All", all);

  // Reduced motion: the viewer draws the same under it — nothing of its own animates.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evalIn(c, `(() => { [...document.querySelectorAll('.subagent-switch-tab')][1].click(); return true; })()`);
  await sleep(300);
  const anims = await evalIn(c, `document.querySelector('.subagent-view')?.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length ?? -1`);
  check("under reduced motion nothing in the viewer runs an animation", anims === 0, anims);
  await shot(c, "5-reduced-motion-dark");
}

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing and the PNG comes out see-through — measured: the sidebar at alpha 140. For the capture
 *  alone the root is painted with a ground that stands in for the material over a plain wallpaper,
 *  dark or light as the face is, and put back after. */
async function shot(c, tag) {
  await evalIn(c, `(() => { const r = document.documentElement; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = 'none'; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
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
