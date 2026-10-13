/**
 * Live check for the model picker (run with: node apps/desktop/scripts/model-picker-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch REALM_HOME and proves what a jsdom
 * test cannot, because each is a question about LAYOUT:
 *
 *  - the popover is one compact column — no detail pane beside the list;
 *  - every model is one line;
 *  - the foot is Codex's effort card: the level by name over the model, a dot per level the model
 *    takes, evenly spaced on one line with the knob on the level in force, the reset only once the
 *    level has moved, and the fast-mode bolt beside it with its tooltip. ←/→ on the track, reached by
 *    Tab from the search field, step the level; a press lands on the nearest dot;
 *  - the strip under the list keeps ONE height whatever the highlighted model says, so the rows above
 *    it never move under the pointer (the popover grows upward from the chip);
 *  - the current model is in view the moment the list opens, however far down it is;
 *  - a model with several harnesses carries them on its row and the row still fits;
 *  - fast mode is on the surface for a brand-new Claude session, honest about what is known, and
 *    Codex's Fast tier and reasoning levels are offered per model from the probe's catalog before
 *    anything has run — and the level chosen reaches the fake app-server as `turn/start.effort`;
 *  - an ACP agent whose session offers a `thought_level` option gets the same track, in its names;
 *  - a pick leaves the picker open, so a model, its level (← → in the search) and fast mode are set
 *    in one visit with the box and the pressed row held still — across a harness and a card of
 *    another size too — and Escape or a click outside puts it away (`stay`);
 *  - the Schedule a task modal's Model row is the same chip and picker, and a run started from the
 *    task runs on the model, level, fast mode and permission it was given (`schedule`);
 *  - Code review's reviewer is the same picker and card from its review menu, the profile keeps the
 *    model, level and fast mode, and a review runs at them (`reviewer`).
 *
 * No real agent is ever asked anything. Every CLI is a stub: Claude answers `--version` and
 * `auth status`, Codex is the adapter's own fake app-server fixture, and the ACP agents are either
 * absent (the owner's Mac) or the fake ACP agent fixture (the long list, all thirteen installed;
 * OpenCode in the configOptions shape real opencode answers with). The one prompt sent goes to the
 * fake app-server, and REALM_ENABLE_FAKE_AGENT turns off the server's own billed title and recap.
 *
 * Env: LIVE_CDP_PORT / LIVE_SERVER_PORT (defaults 9341 / 8907), LIVE_SHOTS (where screenshots go,
 * default a temp dir), LIVE_TMP (where the scratch home goes, default the OS temp dir).
 */
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { buildFixture } from "../../server/scripts/fixtures/code-review-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9341), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8907);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_TMP ?? os.tmpdir(), "realm-picker-live-"));
const shots = process.env.LIVE_SHOTS ?? path.join(scratch, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
  }
}

/** The stub CLIs. `acp` decides whether the ACP agents are installed (the fake ACP agent) or not;
 *  `claudeCli` makes Claude the fake CLI that speaks the SDK's own protocol, so a session can run. */
function stubs(dir, { acp, claudeCli = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); return p; };
  const fakeClaude = path.join(repoRoot, "packages/adapters/src/claude/fixtures/fake-claude-cli.mjs");
  const claude = claudeCli
    ? write("claude", `#!/bin/bash\nexec "${node}" "${fakeClaude}" "$@"\n`)
    : write("claude", `#!/bin/bash\ncase "$1" in\n  --version) echo "2.1.281 (Claude Code)";;\n  auth) echo '{"loggedIn": true}';;\n  *) exit 1;;\nesac\n`);
  const fakeCodex = path.join(repoRoot, "packages/adapters/src/codex/fixtures/fake-codex-server.mjs");
  const codex = write("codex", `#!/bin/bash\ncase "$1" in\n  login) echo "Logged in using ChatGPT";;\n  *) exec "${node}" "${fakeCodex}" "$@";;\nesac\n`);
  const fakeAcp = path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs");
  const agent = acp
    ? write("acp-agent", `#!/bin/bash\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\nexec "${node}" "${fakeAcp}" "$@"\n`)
    : path.join(dir, "not-installed");
  // OpenCode answers session/new with configOptions, as the real one does — the shape that carries a
  // `thought_level` selector, so it is the agent whose levels the track should offer.
  const opencode = acp
    ? write("acp-opencode", `#!/bin/bash\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\nexport FAKE_ACP_CONFIGOPTIONS=1\nexec "${node}" "${fakeAcp}" "$@"\n`)
    : agent;
  return {
    REALM_CLAUDE_BIN: claude, REALM_CODEX_BIN: codex,
    ...Object.fromEntries(["CURSOR", "GEMINI", "OPENCODE", "COPILOT", "GOOSE", "QWEN", "GROK", "FX", "DEEPSEEK", "OPENHANDS", "HERMES"]
      .map((k) => [`REALM_${k}_BIN`, k === "OPENCODE" ? opencode : agent])),
  };
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
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
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
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const box = (c, sel) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip
    ? { format: "png", clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: clip.width, height: clip.height, scale: 2 } }
    : { format: "png" });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SHOT ${file}`);
}

/** Which prompter's chip the helpers below work through: the session pane's unless a phase says. */
let CHIP = '.composer button[aria-label="Model"]';

/** The picker and its chip in one frame, with a margin of the surface around them. */
async function shootPicker(c, name) {
  const p = await box(c, ".model-picker"), k = await box(c, CHIP);
  if (!p || !k) return;
  const x = Math.min(p.x, k.x) - 16, y = Math.min(p.y, k.y) - 16;
  await shoot(c, name, { x, y, width: Math.max(p.x + p.width, k.x + k.width) + 16 - x, height: Math.max(p.y + p.height, k.y + k.height) + 16 - y });
}

/** Holds the window "key": a live window opens behind the person's own and greys its accent. */
const keyWindow = (c) => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
  new MutationObserver(() => r.removeAttribute('data-window-inactive')).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);

/** Opens the picker with a real click on the chip, which also leaves the pointer resting there — as
 *  a person's would — rather than wherever an earlier hover put it. */
const openPicker = async (c) => {
  if (await evalIn(c, `!!document.querySelector('.model-picker')`)) return;
  const k = await box(c, CHIP);
  const at = { x: k.x + k.width / 2, y: k.y + k.height / 2 };
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
  await until(() => evalIn(c, `(() => { const p = document.querySelector('.model-picker'); return !!p && getComputedStyle(p).visibility === 'visible'; })()`), 5000, "picker");
  await sleep(350); // the arrival spring
};
/** A real Escape, to whatever has the keyboard — the picker's search field — so the picker answers it
 *  before anything behind it can: one dispatched on `window` reaches every window listener at once,
 *  and on the Code review page one of those closes the request. */
const closePicker = async (c) => {
  for (const type of ["rawKeyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector('.model-picker')`), 3000, "picker closed").catch(() => null);
  await sleep(200);
};
/** A real pointer over a row, so the hover is the browser's and not a synthesized React event. */
const hover = async (c, label) => {
  const b = await evalIn(c, `(() => { const o = [...document.querySelectorAll('.mp-row')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!o) return null; o.scrollIntoView({ block: 'nearest' }); const r = o.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!b) return false;
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
  await sleep(120);
  return true;
};

/** Where a row is, in view: its box and its middle, or null where the list has no such row. */
const rowAt = (c, label) => evalIn(c, `(() => { const o = [...document.querySelectorAll('.mp-row')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!o) return null; o.scrollIntoView({ block: 'nearest' }); const r = o.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);

/** Picks a row the way a person does — a real press and release on it, the pointer left there — so the
 *  renderer makes the change, not the daemon. The picker stays open after it, as it does for a person. */
const pickRow = async (c, label) => {
  await openPicker(c);
  const at = await rowAt(c, label);
  if (!at) return false;
  await clickAt(c, at.cx, at.cy);
  await sleep(500);
  return true;
};

/** Boots the built app on a fresh home, onboards one space, and hands back the page and the daemon. */
async function boot(env, label) {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const home = path.join(scratch, `${label}-home`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  // The window opens behind whatever the person is doing; these keep Chromium laying it out.
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, ...env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, `${label}-userData`), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json())
    .find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 40000, "onboarding");
  await evalIn(c, `(() => { const i = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Live'); i.dispatchEvent(new Event('input', { bubbles: true }));
    i.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer button[aria-label="Model"]')`), 40000, "composer");
  await keyWindow(c);
  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // The probe of every stub, and the public price catalog, land before anything is measured.
  await until(async () => (await api.call("agents.probe", { force: false })).length > 0, 30000, "probe");
  await sleep(2500);
  const [sess] = await api.call("sessions.listAll", { profileId: null });
  return { c, api, home, sessionId: sess.id };
}

/** A fresh renderer over the same home — how a settings row the store only reads at boot is re-read. */
async function reload(c) {
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer button[aria-label="Model"]')`), 30000, "composer after reload");
  await keyWindow(c);
  await sleep(1500);
}

async function setTheme(c, api, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await reload(c);
  check(`the window is in ${mode} mode`, (await evalIn(c, `document.documentElement.dataset.mode`)) === mode);
}

async function stop(home) {
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  if (home) await stopDaemons(home);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  await sleep(800);
}

/** Everything about the open picker's geometry that a jsdom test cannot see. */
const layout = (c) => evalIn(c, `(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const picker = document.querySelector('.model-picker'), list = document.querySelector('.mp-list');
  const rows = [...document.querySelectorAll('.mp-row')];
  const lb = list.getBoundingClientRect();
  const current = rows.find((o) => o.getAttribute('aria-selected') === 'true');
  const cb = current?.getBoundingClientRect();
  return {
    picker: r(picker), win: { w: innerWidth, h: innerHeight },
    detailPane: !!document.querySelector('.mp-detail'),
    rows: rows.length,
    rowHeights: [...new Set(rows.map((o) => Math.round(o.getBoundingClientRect().height)))],
    overflowingRows: rows.filter((o) => o.scrollWidth > o.clientWidth + 1).map((o) => o.getAttribute('aria-label')),
    currentInView: !!cb && cb.top >= lb.top - 1 && cb.bottom <= lb.bottom + 1,
    current: current?.getAttribute('aria-label') ?? null,
    listScrolls: list.scrollHeight > list.clientHeight + 2,
    dissolve: list.getAttribute('data-dissolve'),
  };
})()`);

const aboutBox = (c) => evalIn(c, `(() => { const a = document.querySelector('.mp-about'), l = document.querySelector('.mp-list');
  return { h: Math.round(a.getBoundingClientRect().height), listTop: Math.round(l.getBoundingClientRect().top),
    note: document.querySelector('.mp-about-note')?.textContent ?? '', specs: document.querySelector('.mp-about-specs')?.textContent ?? '' }; })()`);

/** The foot's card, as drawn: the bolt, the level by name over the model, the reset, and the track. */
const runCard = (c) => evalIn(c, `(() => {
  const card = document.querySelector('.mp-run'); if (!card) return null;
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round((b.x + b.width / 2) * 10) / 10, cy: Math.round((b.y + b.height / 2) * 10) / 10 }; };
  const bolt = card.querySelector('.mp-bolt'), reset = card.querySelector('.mp-run-reset'), track = card.querySelector('[role=slider]');
  const level = card.querySelector('.mp-run-level');
  const dots = [...card.querySelectorAll('.mp-track-dot')].map(r);
  // The accent as this card resolves it, to compare the level's own colour against.
  const swatch = document.createElement('span'); swatch.style.color = 'var(--rl-accent)'; card.appendChild(swatch);
  const accent = getComputedStyle(swatch).color; swatch.remove();
  return {
    card: r(card), picker: r(document.querySelector('.model-picker')),
    bolt: bolt ? { pressed: bolt.getAttribute('aria-pressed'), disabled: bolt.getAttribute('aria-disabled'), title: bolt.title, box: r(bolt) } : null,
    level: level?.textContent ?? null, levelInAccent: !!level && getComputedStyle(level).color === accent,
    model: card.querySelector('.mp-run-model')?.textContent ?? null,
    reset: reset ? { title: reset.title, box: r(reset) } : null,
    track: track ? { box: r(track), now: Number(track.getAttribute('aria-valuenow')), max: Number(track.getAttribute('aria-valuemax')),
      text: track.getAttribute('aria-valuetext'), chosen: track.dataset.effort ?? null, focused: document.activeElement === track } : null,
    dots: dots.map((d) => d.cx), dotRows: [...new Set(dots.map((d) => d.cy))].length,
    knob: r(card.querySelector('.mp-track-knob')),
    // Held open beside a bolt, so an empty line is no note at all.
    note: card.querySelector('.mp-fast-note')?.textContent || null,
    overflowing: [...card.querySelectorAll('*')].filter((e) => !e.classList.contains('mp-run-model') && e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
  };
})()`);

/** What every card must be, whatever it says: the track's geometry, and the head's three columns. */
function cardIsDrawn(card) {
  if (!card?.track) return false;
  const gaps = card.dots.slice(1).map((x, i) => x - card.dots[i]);
  const t = card.track.box;
  return card.dots.length === card.track.max + 1 && card.dots.length >= 2 && card.dotRows === 1
    && Math.max(...gaps) - Math.min(...gaps) <= 1
    && card.dots[0] > t.x && card.dots.at(-1) < t.x + t.w
    && (!card.knob || Math.abs(card.knob.cx - card.dots[card.track.now]) <= 1.5)
    && card.card.x >= card.picker.x && card.card.x + card.card.w <= card.picker.x + card.picker.w
    && card.overflowing.length === 0;
}

const KEYS = { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Tab: 9 };
/** A real key, to whatever holds focus. */
const key = async (c, k) => {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
  await sleep(180);
};
/** A real press and release at a point — Chromium makes the pointer events from it. */
const clickAt = async (c, x, y) => {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(250);
};
const chipOf = (c) => evalIn(c, `(() => { const b = document.querySelector(${JSON.stringify(CHIP)});
  return { text: b.querySelector('.chip-label')?.textContent ?? '', effort: b.querySelector('.chip-effort')?.textContent ?? null, title: b.title,
    fast: !!b.querySelector('.chip-fast') }; })()`);
/** Tab from the search field, which the picker opens holding, until the track has the keyboard.
 *  Hands back where each Tab went, so a failure says which stop was in the way. */
const tabToTrack = async (c) => {
  const where = () => evalIn(c, `(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.className || a.tagName) : null; })()`);
  // From the search field, where the picker opens: a reload can leave the keyboard on the chip.
  await evalIn(c, `(() => { document.querySelector('.model-picker input[aria-label="Search models"]')?.focus(); return true; })()`);
  const path = [await where()];
  for (let i = 0; i < 6 && !(await evalIn(c, `document.activeElement?.getAttribute('role') === 'slider'`)); i++) {
    await key(c, "Tab");
    path.push(await where());
  }
  const ok = await evalIn(c, `document.activeElement?.getAttribute('role') === 'slider'`);
  if (!ok) console.log("TAB PATH", JSON.stringify(path));
  return ok;
};
/** The card and the tooltip over it, after a real hover on the bolt. */
const shootBoltTip = async (c, name) => {
  const card = await runCard(c);
  if (!card?.bolt) return null;
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: card.bolt.box.cx, y: card.bolt.box.cy });
  const tip = await until(() => evalIn(c, `(() => { const t = document.querySelector('.tooltip'); if (!t || getComputedStyle(t).opacity < 0.95) return null;
    const b = t.getBoundingClientRect(); return { text: t.textContent, x: b.x, y: b.y, w: b.width, h: b.height }; })()`), 4000, "bolt tooltip").catch(() => null);
  if (tip) {
    const x = Math.min(tip.x, card.card.x) - 16, y = Math.min(tip.y, card.card.y) - 16;
    await shoot(c, name, { x, y, width: Math.max(tip.x + tip.w, card.card.x + card.card.w) + 16 - x, height: Math.max(tip.y + tip.h, card.card.y + card.card.h) + 16 - y });
  }
  return tip;
};

/** The owner's Mac: Claude signed in, Codex installed, no ACP agents. A brand-new Claude session. */
async function owner() {
  const { c, api, home, sessionId } = await boot(stubs(path.join(scratch, "bin-owner"), { acp: false }), "owner");
  const mine = async () => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sessionId);
  const effortIs = (want) => until(async () => ((await mine())?.effort ?? null) === want, 5000, `effort ${want}`).then(() => true, () => false);
  try {
    await setTheme(c, api, "dark");
    for (const mode of ["dark", "light"]) {
      if (mode === "light") await setTheme(c, api, "light");
      const chip = await chipOf(c);
      check(`${mode}: the chip names the model and the level it runs at, and the harness in its tooltip`,
        chip.text.includes("Fable 5.1") && chip.effort === "High" && chip.title === "Claude Fable 5.1 through Claude · High effort", chip);
      await openPicker(c);
      const l = await layout(c);
      check(`${mode}: one compact column, no detail pane`, !l.detailPane && l.picker.w >= 360 && l.picker.w <= 380, { w: l.picker.w });
      check(`${mode}: inside the window`, l.picker.x >= 0 && l.picker.y >= 0 && l.picker.x + l.picker.w <= l.win.w && l.picker.y + l.picker.h <= l.win.h, l.picker);
      check(`${mode}: every row is one line and nothing in a row overflows it`, l.rowHeights.length === 1 && l.rowHeights[0] === 32 && l.overflowingRows.length === 0, { heights: l.rowHeights, overflowing: l.overflowingRows });
      check(`${mode}: the current model is ticked and in view`, l.current === "Claude Fable 5.1" && l.currentInView, { current: l.current });
      const card = await runCard(c);
      check(`${mode}: the foot is the effort card — a dot per level on one line, evenly spaced, the knob on the level in force`, cardIsDrawn(card), card);
      check(`${mode}: it names the level over the model, in the accent, with no reset while nothing has moved`,
        card?.level === "High" && card.model === "Fable 5.1" && card.levelInAccent && card.reset === null && card.track?.chosen === null, card && { level: card.level, model: card.model, reset: card.reset });
      check(`${mode}: the bolt sits beside it, unpressed, with nothing under it until it is pressed`,
        card?.bolt?.pressed === "false" && card.bolt.disabled === null && !card.note, card?.bolt);
      check(`${mode}: the bolt's tooltip says what fast mode buys, and that the first turn checks this model`,
        /^Fast mode: .+\. The first turn checks whether Fable 5\.1 can run it\.$/.test(card?.bolt?.title ?? ""), card?.bolt?.title);
      await shootPicker(c, `after-${mode}-claude-picker`);
      await shoot(c, `after-${mode}-full`);

      // One height, whatever the line says: the rows above it must not move as the highlight does.
      const samples = [];
      for (const label of ["Claude Fable 5.1", "Claude Haiku 4.5", "GPT-5.6-Terra", "Cursor, Composer, not installed"]) {
        if (await hover(c, label)) samples.push({ label, ...(await aboutBox(c)) });
      }
      check(`${mode}: the strip keeps one height and the list does not move as the highlight walks`,
        samples.length >= 3 && new Set(samples.map((s) => s.h)).size === 1 && new Set(samples.map((s) => s.listTop)).size === 1, samples.map(({ label, h, listTop }) => ({ label, h, listTop })));
      if (mode === "dark") {
        check("the strip names a missing CLI rather than a price", /isn’t installed/.test(samples.find((s) => s.label.startsWith("Cursor"))?.note ?? ""), samples.at(-1));
        await hover(c, "Claude Fable 5.1");
        await shootPicker(c, "after-dark-hover-fable");
        const tip = await shootBoltTip(c, "after-dark-claude-bolt-tip");
        check("hovering the bolt shows its tooltip", !!tip && tip.text.startsWith("Fast mode:"), tip);
      }
      await closePicker(c);
    }

    // The keyboard: Tab from the search field reaches the track, and ←/→ step the level in place.
    await openPicker(c);
    check("Tab from the search field reaches the track", await tabToTrack(c));
    let card = await runCard(c);
    const atDefault = card.track.now;
    await key(c, "ArrowLeft");
    check("← steps the level down one and saves it on the session", await effortIs("medium"));
    card = await runCard(c);
    check("…the knob and the name follow, the picker stays open, and the reset appears", card?.level === "Medium" && card.track.now === atDefault - 1
      && card.track.chosen === "medium" && card.track.focused && !!card.reset && await evalIn(c, `!!document.querySelector('.model-picker')`), card);
    check("the reset's tooltip names the default it goes back to", card?.reset?.title === "Back to Fable 5.1’s default, High", card?.reset);
    check("the chip wears the level chosen", (await chipOf(c)).effort === "Medium");
    await shootPicker(c, "after-light-claude-chosen");
    await key(c, "ArrowRight"); await key(c, "ArrowRight");
    card = await runCard(c);
    check("→ steps up past the default", card?.track.now === atDefault + 1 && await effortIs(card.level.toLowerCase()), card?.track);
    await key(c, "End");
    card = await runCard(c);
    check("End goes to the model's heaviest level", card?.track.now === card?.track.max && await effortIs(card.level.toLowerCase()), card?.track);
    // The pointer: a press lands on the nearest dot.
    await clickAt(c, card.dots[0] + 3, card.track.box.cy);
    check("a press near the first dot picks the lightest level", await effortIs("low"));
    card = await runCard(c);
    check("…and the knob lands on that dot", cardIsDrawn(card) && card.track.now === 0, card?.knob);
    // The reset hands the level back to the model: no level of Realm's, not "high" by name.
    await clickAt(c, card.reset.box.cx, card.reset.box.cy);
    check("the reset clears the session's level", await effortIs(null));
    card = await runCard(c);
    check("…the model's default is back on the card, and the reset goes", card?.level === "High" && card.reset === null && card.track.chosen === null, card);
    await closePicker(c);

    // The bolt, pressed before the first message: a request, kept on the surface it was made on.
    await openPicker(c);
    card = await runCard(c);
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    await until(async () => (await mine())?.fastMode === true, 5000, "fast saved");
    card = await runCard(c);
    check("pressing the bolt asks for fast mode, and says the first turn checks it", card?.bolt?.pressed === "true" && card.note === "Fast mode is asked for — the first turn checks it.", card);
    check("pressing it keeps the picker open", await evalIn(c, `!!document.querySelector('.model-picker')`));
    await shootPicker(c, "after-light-claude-fast-asked");
    await closePicker(c);
    check("the chip wears the bolt for the request", (await chipOf(c)).fast);
    const k = await box(c, '.composer button[aria-label="Model"]');
    await shoot(c, "after-light-chip-fast", { x: k.x - 140, y: k.y - 12, width: k.width + 160, height: k.height + 24 });
    await api.call("sessions.setOptions", { id: sessionId, fastMode: false });

    // What one earlier Claude session would have filed for every model Claude lists.
    await api.call("settings.set", { key: "models.fastSupport", value: { "claude:": false, "claude:claude-fable-5-1": false, "claude:claude-opus-5-5": true, "claude:claude-sonnet-5": true } });
    for (const mode of ["light", "dark"]) {
      if (mode === "dark") await setTheme(c, api, "dark"); else await reload(c);
      await openPicker(c);
      const no = await runCard(c);
      check(`${mode}: on a model Claude said cannot, the bolt is there but cannot be pressed, and its tooltip names the ones that can`,
        no?.bolt?.disabled === "true" && no.bolt.pressed === "false" && no.bolt.title === "Fast mode isn’t offered on Fable 5.1 — Opus 5.5 and Sonnet 5 offer it." && !no.note, no?.bolt);
      if (mode === "dark") {
        await clickAt(c, no.bolt.box.cx, no.bolt.box.cy);
        await sleep(400);
        check("a press on it asks for nothing", (await mine())?.fastMode !== true);
      }
      await shootPicker(c, `after-${mode}-fast-unavailable`);
      await closePicker(c);
    }
    check("Opus 5.5 is a row to pick", await pickRow(c, "Claude Opus 5.5"));
    await openPicker(c);
    const yes = await runCard(c);
    check("on a model Claude said can, a plain bolt whose tooltip has nothing left to check", yes?.bolt?.disabled === null && /^Fast mode: [^.]+\.$/.test(yes.bolt.title) && !yes.note, yes?.bolt);
    check("…and the card follows the model", yes?.model === "Opus 5.5" && yes.level === "High", yes && { model: yes.model, level: yes.level });
    const l = await layout(c);
    check("the newly picked model is the ticked one", l.current === "Claude Opus 5.5", { current: l.current });
    await shootPicker(c, "after-dark-fast-offered");
    await closePicker(c);

    // Codex, before any session has run on it: the Fast tier and the levels from the probe's own catalog.
    check("Codex's default is one click from a Claude session that has not run", await pickRow(c, "GPT-5.6"));
    await until(() => evalIn(c, `document.querySelector('.composer button[aria-label="Model"]').textContent.includes('GPT-5.6')`), 5000, "codex chip");
    await openPicker(c);
    const codexDefault = await runCard(c);
    check("Codex's default takes the levels its catalog marks, from its own default", cardIsDrawn(codexDefault) && codexDefault.dots.length === 4 && codexDefault.level === "Medium", codexDefault && { dots: codexDefault.dots.length, level: codexDefault.level });
    check("…and the Fast tier, the bolt's tooltip in the tier's own words", codexDefault?.bolt?.disabled === null && codexDefault.bolt.title === "Fast mode: 1.5x speed, increased usage.", codexDefault?.bolt);
    await closePicker(c);
    check("GPT-5.6-Terra is a row to pick", await pickRow(c, "GPT-5.6-Terra"));
    await openPicker(c);
    const terra = await runCard(c);
    check("a Codex model with fewer levels gets fewer dots", cardIsDrawn(terra) && terra.dots.length === 3 && terra.model === "GPT-5.6-Terra", terra && { dots: terra.dots.length });
    check("a Codex model without the tier cannot press the bolt, and its tooltip names the one that has it", terra?.bolt?.disabled === "true" && terra.bolt.title === "Fast mode isn’t offered on GPT-5.6-Terra — GPT-5.6-Sol offers it.", terra?.bolt);
    await closePicker(c);
    check("GPT-5.6-Sol is a row to pick", await pickRow(c, "GPT-5.6-Sol"));
    await openPicker(c);
    check("Tab reaches the track on a Codex session too", await tabToTrack(c));
    await key(c, "ArrowRight");
    check("→ on Sol saves the level above its default", await effortIs("high"));
    const sol = await runCard(c);
    check("the card names it, with the way back to Sol's default", sol?.level === "High" && sol.model === "GPT-5.6-Sol" && sol.reset?.title === "Back to GPT-5.6-Sol’s default, Medium", sol && { level: sol.level, reset: sol.reset });
    await shootPicker(c, "after-dark-codex-picker");
    await closePicker(c);
    await setTheme(c, api, "light");
    check("the chip wears the Codex level", (await chipOf(c)).effort === "High");
    await openPicker(c);
    await shootPicker(c, "after-light-codex-picker");
    await shootBoltTip(c, "after-light-codex-bolt-tip");
    await closePicker(c);

    // The level reaching the turn: the fake app-server echoes the `turn/start` it was sent.
    await evalIn(c, `(() => { const t = document.querySelector('.composer textarea'); t.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'TURN_PARAMS');
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(250);
    await key(c, "Enter");
    const echoed = await until(async () => {
      const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0 });
      const text = evs.map((e) => e.event).filter((e) => e.type === "assistant_text").map((e) => e.payload.text).find((t) => t.includes('"threadId"'));
      return text ? JSON.parse(text) : null;
    }, 30000, "turn params echo").catch((e) => ({ error: e.message }));
    check("the level chosen reaches Codex as `turn/start.effort`", echoed?.effort === "high", { effort: echoed?.effort, model: echoed?.model, error: echoed?.error });
    const shown = await until(() => evalIn(c, `document.querySelector('.session-pane')?.textContent.includes('"effort":"high"') ? true : null`), 10000, "echo on screen").catch(() => false);
    check("…and the transcript shows the echo", shown);
    await sleep(600);
    await shoot(c, "after-light-codex-turn");

    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    await stop(home);
  }
}

/** Thirteen agents installed (the ACP ones are the fake ACP agent), and an agent that lists nothing. */
async function longList() {
  const { c, api, home } = await boot(stubs(path.join(scratch, "bin-long"), { acp: true }), "long");
  try {
    const probed = await api.call("agents.probe", { force: false });
    check("every agent probes as installed", probed.filter((p) => p.kind !== "fake").every((p) => p.available), probed.map((p) => [p.kind, p.available]));
    await openPicker(c);
    const l = await layout(c);
    check("the long list scrolls inside its own box, dissolving at the far end", l.listScrolls && /end/.test(l.dissolve ?? ""), { rows: l.rows, dissolve: l.dissolve });
    check("every row still one line", l.rowHeights.length === 1 && l.overflowingRows.length === 0, { heights: l.rowHeights, overflowing: l.overflowingRows });
    const groups = await evalIn(c, `[...document.querySelectorAll('.mp-group')].map((g) => g.getAttribute('aria-label'))`);
    console.log("GROUPS", JSON.stringify(groups));
    await shootPicker(c, "after-dark-long-top");
    // A model several harnesses can run: its harnesses on the row, and the row still fits.
    const multi = await evalIn(c, `(() => { const g = [...document.querySelectorAll('.mp-row')]; return g.map((o) => o.getAttribute('aria-label')); })()`);
    let ways = null;
    for (const label of multi) {
      await hover(c, label);
      ways = await evalIn(c, `(() => { const o = document.querySelector('.mp-row[data-active]'); const w = o?.querySelector('.mp-ways');
        return w ? { label: o.getAttribute('aria-label'), n: w.querySelectorAll('button').length, fits: o.scrollWidth <= o.clientWidth + 1 } : null; })()`);
      if (ways) break;
    }
    check("a model with several harnesses offers them on its row, and the row fits", !!ways && ways.n > 1 && ways.fits, ways);
    if (ways) await shootPicker(c, "after-dark-long-ways");
    await evalIn(c, `(() => { const l = document.querySelector('.mp-list'); l.scrollTop = l.scrollHeight; return true; })()`);
    await sleep(400);
    await shootPicker(c, "after-dark-long-bottom");
    await closePicker(c);

    // An ACP agent whose session offers a `thought_level` option (OpenCode's configOptions): its own
    // levels on the same track, and no bolt, because Realm cannot ask an ACP agent for fast mode.
    await openPicker(c);
    const fake = await evalIn(c, `[...document.querySelectorAll('.mp-row')].map((o) => o.getAttribute('aria-label')).find((x) => /^Fake 1/.test(x ?? '')) ?? null`);
    let routed = false;
    if (fake && await hover(c, fake)) {
      routed = await evalIn(c, `(() => { const b = [...document.querySelectorAll('.mp-row[data-active] .mp-way')].find((x) => /through OpenCode$/.test(x.getAttribute('aria-label') ?? ''));
        if (!b) return false; b.click(); return true; })()`);
    }
    check("Fake 1 can be run through OpenCode from its row", routed, { fake });
    await sleep(500);
    await openPicker(c);
    const acp = await runCard(c);
    check("OpenCode's session offers its own three levels, from its own default, with no bolt", cardIsDrawn(acp) && acp.dots.length === 3 && acp.level === "Medium" && acp.bolt === null, acp);
    check("Tab reaches OpenCode's track", await tabToTrack(c));
    await key(c, "ArrowRight");
    const acpAfter = await runCard(c);
    check("→ moves OpenCode's level", acpAfter?.level === "High" && !!acpAfter.reset, acpAfter && { level: acpAfter.level, reset: acpAfter.reset });
    await shootPicker(c, "after-dark-acp-effort");
    await closePicker(c);

    // An agent that reports no models: its own group, its default ticked, nothing it cannot take.
    check("OpenHands is one row among the other agents", await pickRow(c, "OpenHands"));
    await until(() => evalIn(c, `document.querySelector('.composer button[aria-label="Model"]').textContent.includes('Default')`), 5000, "openhands chip");
    // The pick left the picker open on the list it opened with; the next opening is laid out for the
    // harness the session is on now.
    await closePicker(c);
    await openPicker(c);
    const own = await evalIn(c, `(() => { const g = document.querySelector('.mp-group'); const o = g?.querySelector('.mp-row');
      return { group: g?.getAttribute('aria-label'), row: o?.getAttribute('aria-label'), selected: o?.getAttribute('aria-selected'),
        foot: !!document.querySelector('.mp-foot') }; })()`);
    check("an agent with no models leads under its own name, its default ticked, with no effort or fast mode to offer", own.group === "OpenHands" && own.row === "Default" && own.selected === "true" && !own.foot, own);
    await shootPicker(c, "after-dark-no-models");
    await closePicker(c);
    c.close(); api.close();
  } finally {
    await stop(home);
  }
}

/**
 * The owner's own session, as it was when the card would not answer them: a Claude session that has
 * RUN, on Opus 5.5 as their ⌘1 favourite, with the prompter docked under a transcript and narrow
 * enough to open the picker from a chip near the window's foot. The CLI is the fake that speaks the SDK's
 * protocol and answers with the real CLI's model list, so the session is live the way theirs was and
 * every change goes through the running CLI's flag layer.
 */
async function ownerReal() {
  const journalFile = path.join(scratch, "claude-journal.jsonl");
  const { c, api, home, sessionId } = await boot({ ...stubs(path.join(scratch, "bin-real"), { acp: false, claudeCli: true }), FAKE_CLAUDE_JOURNAL: journalFile }, "real");
  const mine = async () => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sessionId);
  const flagWrites = () => { try { return fs.readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.subtype === "apply_flag_settings").map((r) => r.settings); } catch { return []; } };
  const replies = async () => (await api.call("sessions.events", { id: sessionId, afterSeq: 0 })).map((e) => e.event)
    .filter((e) => e.type === "assistant_text").map((e) => e.payload.text);
  const send = async (text) => {
    const before = (await replies()).length;
    await evalIn(c, `(() => { const t = document.querySelector('.composer textarea'); t.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)});
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(200);
    await key(c, "Enter");
    return until(async () => { const r = await replies(); return r.length > before ? r.at(-1) : null; }, 20000, `reply to ${text}`).catch(() => null);
  };
  try {
    await setTheme(c, api, "dark");
    check("real: Opus 5.5 is a row to pick", await pickRow(c, "Claude Opus 5.5"));
    await openPicker(c);
    await hover(c, "Claude Opus 5.5");
    await evalIn(c, `(() => { document.querySelector('.mp-row[data-active] .mp-star')?.click(); return true; })()`);
    await sleep(300);
    await closePicker(c);
    const first = await send("hello");
    check("real: the session runs on the CLI, on Opus 5.5 at its default", /^Ran on claude-opus-5-5: effort high, fast off\./.test(first ?? ""), first);
    // Narrow, as the owner's was, and short enough that the picker opens up over the prompter from a
    // chip near the window's foot. The permission chip stays on the row at this width — it no longer
    // folds into the picker — so the card under the picker is the model's alone.
    const width = 600;
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 640, deviceScaleFactor: 2, mobile: false });
    await sleep(700);
    console.log("NARROW AT", width);
    check("real: the prompter is docked under the transcript", (await evalIn(c, `document.querySelector('.session-pane')?.dataset.composer`)) === "docked");
    check("real: the permission chip stays on the narrow row", await evalIn(c, `!!document.querySelector('.composer-opts [aria-label="Permission mode"]')`));
    const chipClosed = await box(c, CHIP);
    const composerClosed = await box(c, ".composer");
    await openPicker(c);
    const chipOpen = await box(c, CHIP);
    const composerOpen = await box(c, ".composer");
    console.log("CHIP", JSON.stringify({ closed: chipClosed, open: chipOpen, composerClosed, composerOpen,
      focus: await evalIn(c, `document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName`) }));
    let card = await runCard(c);
    check("real: the card is drawn, with no Permissions folded under it", cardIsDrawn(card) && !(await evalIn(c, `!!document.querySelector('.mp-foot .mp-seg-group[aria-label="Permissions"]')`)), card);
    // What a press at each control actually lands on.
    const hits = await evalIn(c, `(() => { const at = (x, y) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('.model-picker') ? 'picker:' + (e.className || e.tagName) : 'OUTSIDE:' + (e.closest('[class]')?.className ?? e.tagName)) : null; };
      const b = (s) => document.querySelector(s)?.getBoundingClientRect();
      const mid = (r) => r && at(r.x + r.width / 2, r.y + r.height / 2);
      const dots = [...document.querySelectorAll('.mp-track-dot')].map((d) => mid(d.getBoundingClientRect()));
      return { bolt: mid(b('.mp-bolt')), dots, perms: mid(b('.mp-foot .mp-seg-opt')) ?? null }; })()`);
    console.log("HITS", JSON.stringify(hits));
    check("real: a press on the bolt and on every dot lands on the card", /^picker:/.test(hits.bolt ?? "") && hits.dots.every((d) => /^picker:/.test(d ?? "")), hits);
    await shootPicker(c, "real-dark-picker");

    await clickAt(c, card.dots.at(-1), card.track.box.cy);
    check("real: a press on the last dot sets Max on the session", await until(async () => (await mine())?.effort === "max", 5000, "max").then(() => true, () => false), (await mine())?.effort);
    card = await runCard(c);
    check("real: the card names Max", card?.level === "Max" && card.track.now === card.track.max, card && { level: card.level, now: card.track.now });
    const beforeBolt = card.bolt.box, beforeChip = await box(c, CHIP), beforePicker = card.picker;
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    check("real: a press on the bolt asks for fast mode", await until(async () => (await mine())?.fastMode === true, 5000, "fast").then(() => true, () => false), (await mine())?.fastMode);
    await sleep(300);
    card = await runCard(c);
    check("real: the bolt shows it pressed", card?.bolt?.pressed === "true", card?.bolt);
    // The bolt has to be where the pointer left it: a second press there is how fast mode goes off.
    const afterChip = await box(c, CHIP);
    check("real: the bolt stays under the pointer that pressed it", card.bolt.box.x === beforeBolt.x && card.bolt.box.y === beforeBolt.y,
      { bolt: [beforeBolt, card.bolt.box], picker: [beforePicker, card.picker], chip: [beforeChip, afterChip] });
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    check("real: …so a second press there switches it off again", await until(async () => (await mine())?.fastMode === false, 5000, "fast off").then(() => true, () => false), (await mine())?.fastMode);
    check("real: …and changes nothing else", (await mine())?.effort === "max", (await mine())?.effort);
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    await until(async () => (await mine())?.fastMode === true, 5000, "fast on again").catch(() => null);
    await sleep(300);
    card = await runCard(c);
    check("real: every change reached the running CLI's flag layer, in order", JSON.stringify(flagWrites()) === JSON.stringify([{ effortLevel: "max" }, { fastMode: true }, { fastMode: false }, { fastMode: true }]), flagWrites());
    await shootPicker(c, "real-dark-max-fast");
    await closePicker(c);
    const second = await send("again");
    check("real: the next turn runs at Max with fast mode on", /effort max, fast on\./.test(second ?? ""), second);
    await setTheme(c, api, "light");
    await openPicker(c);
    await shootPicker(c, "real-light-max-fast");
    await closePicker(c);
    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("real: no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    await stop(home);
  }
}

/**
 * The owner's own case: the question box under a pull request in Code review, a prompter with no
 * session behind it until the first question, on Opus 5.5. Its card was drawn and dropped every
 * press — the draft held the model picked and nothing else. Run against the fake gh and the fake
 * Claude CLI, so the question's answer says what the session it started actually ran at.
 */
async function review() {
  const ghDir = path.join(scratch, "gh");
  fs.mkdirSync(ghDir, { recursive: true });
  const fixturePath = path.join(ghDir, "fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify({ ...buildFixture(), auth: "ready" }));
  const ghBin = path.join(ghDir, "gh");
  fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${path.join(ghDir, "calls.jsonl")}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`);
  fs.chmodSync(ghBin, 0o755);
  const { c, api, home } = await boot({ ...stubs(path.join(scratch, "bin-review"), { acp: false, claudeCli: true }), REALM_GH_BIN: ghBin }, "review");
  const TITLE = "Stream the tokenizer instead of buffering its input";
  const openReview = async () => {
    await evalIn(c, `(() => { const b = [...document.querySelectorAll('.app-rail button')].find((x) => x.getAttribute('aria-label') === 'Code review');
      if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
    await until(() => evalIn(c, `[...document.querySelectorAll('.cr-row')].some((r) => r.textContent.includes(${JSON.stringify(TITLE)}))`), 20000, "the request's row");
    await evalIn(c, `(() => { [...document.querySelectorAll('.cr-row')].find((r) => r.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(CHIP)})`), 20000, "the question box");
    await sleep(800);
  };
  const thread = async () => (await api.call("codeReview.thread", { ref: { owner: "acme", repo: "widgets", number: 42 } })).sessionId;
  try {
    await setTheme(c, api, "dark");
    CHIP = '.cr-ask .composer button[aria-label="Model"]';
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 760, deviceScaleFactor: 2, mobile: false });
    await openReview();
    check("review: Opus 5.5 is a row to pick in the question box", await pickRow(c, "Claude Opus 5.5"));
    check("review: there is no session behind the box yet", (await thread()) === null);
    await openPicker(c);
    let card = await runCard(c);
    check("review: the box's picker draws the card", cardIsDrawn(card) && card.level === "High" && card.model === "Opus 5.5", card);
    await shootPicker(c, "review-dark-before");
    await clickAt(c, card.dots.at(-1), card.track.box.cy);
    card = await runCard(c);
    check("review: a press on the last dot moves the card to Max", card?.level === "Max" && card.track.now === card.track.max, card && { level: card.level, now: card.track.now });
    check("review: …and the chip wears it", (await chipOf(c)).effort === "Max", await chipOf(c));
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    card = await runCard(c);
    check("review: a press on the bolt asks for fast mode", card?.bolt?.pressed === "true" && card.note === "Fast mode is asked for — the first turn checks it.", card?.bolt);
    await shootPicker(c, "review-dark-after");
    await closePicker(c);
    await evalIn(c, `(() => { const t = document.querySelector('.cr-ask .composer textarea'); t.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Is the stream right?');
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(200);
    await key(c, "Enter");
    const sid = await until(thread, 20000, "the request's session").catch(() => null);
    const row = sid ? (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sid) : null;
    check("review: the first question starts its session at Max, fast, on Opus 5.5", row?.effort === "max" && row.fastMode === true && row.model === "claude-opus-5-5", row && { effort: row.effort, fastMode: row.fastMode, model: row.model });
    const reply = sid ? await until(async () => (await api.call("sessions.events", { id: sid, afterSeq: 0 })).map((e) => e.event)
      .filter((e) => e.type === "assistant_text").map((e) => e.payload.text).at(-1) ?? null, 20000, "the answer").catch(() => null) : null;
    check("review: …and its first turn ran that way", /^Ran on claude-opus-5-5: effort max, fast on\./.test(reply ?? ""), reply);
    await sleep(600);
    await shoot(c, "review-dark-answered");
    await setTheme(c, api, "light");
    await openReview();
    await openPicker(c);
    card = await runCard(c);
    check("review: carried on, the box's card reads the session's own Max and fast mode", card?.level === "Max" && card.bolt?.pressed === "true", card && { level: card.level, bolt: card.bolt });
    await shootPicker(c, "review-light-after");
    await closePicker(c);
    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("review: no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    CHIP = '.composer button[aria-label="Model"]';
    await stop(home);
  }
}

/**
 * Code review's reviewer, on the same fake CLI (the owner, 10-06: "The reviewer effort level can do
 * that as well"). The review menu's model chip opens the picker with its card; a pick leaves it open
 * and → in the search steps the model just picked; the menu's chip and the Review button say the
 * level and the bolt; the profile keeps them through a reload; and a review started at Opus 5.5
 * XHigh runs at xhigh, then fast — the CLI answers with what it ran under, and that answer is the
 * review's summary. A model the CLI says takes no level gives the remembered XHigh way: its review
 * is sent none, and Opus has XHigh back after it.
 */
async function reviewer() {
  const ghDir = path.join(scratch, "gh-reviewer");
  fs.mkdirSync(ghDir, { recursive: true });
  const fixturePath = path.join(ghDir, "fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify({ ...buildFixture(), auth: "ready" }));
  const ghBin = path.join(ghDir, "gh");
  fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${path.join(ghDir, "calls.jsonl")}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`);
  fs.chmodSync(ghBin, 0o755);
  const { c, api, home } = await boot({ ...stubs(path.join(scratch, "bin-reviewer"), { acp: false, claudeCli: true }), REALM_GH_BIN: ghBin }, "reviewer");
  const TITLE = "Stream the tokenizer instead of buffering its input";
  const ref = { owner: "acme", repo: "widgets", number: 42 };
  const MENU = '[role=dialog][aria-label="Review instructions"]';
  const { profileId } = (await api.call("spaces.list", {}))[0];
  const openRequest = async () => {
    await evalIn(c, `(() => { const b = [...document.querySelectorAll('.app-rail button')].find((x) => x.getAttribute('aria-label') === 'Code review');
      if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
    await until(() => evalIn(c, `[...document.querySelectorAll('.cr-row')].some((r) => r.textContent.includes(${JSON.stringify(TITLE)}))`), 20000, "the request's row");
    await evalIn(c, `(() => { [...document.querySelectorAll('.cr-row')].find((r) => r.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
    await until(() => evalIn(c, `(() => { const b = document.querySelector('.cr-review-run'); return !!b && !b.disabled; })()`), 20000, "Review with");
    await sleep(800);
  };
  const menuUp = () => evalIn(c, `(() => { const d = document.querySelector(${JSON.stringify(MENU)}); return !!d && !d.hasAttribute('data-closing') && getComputedStyle(d).visibility === 'visible'; })()`);
  const pickerUp = () => evalIn(c, `(() => { const p = document.querySelector('.model-picker'); return !!p && !p.hasAttribute('data-closing'); })()`);
  const openMenu = async () => {
    if (await menuUp()) return;
    const m = await box(c, ".cr-review-more");
    await clickAt(c, m.x + m.width / 2, m.y + m.height / 2);
    await until(async () => (await menuUp()) && evalIn(c, `!document.querySelector(${JSON.stringify(`${MENU} textarea`)}).disabled`), 10000, "the review menu");
    await sleep(350); // the arrival spring
  };
  const closeMenu = async () => {
    for (let i = 0; i < 3 && (await menuUp()); i++) {
      for (const type of ["rawKeyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(350);
    }
  };
  /** A real press on a picker row, the pointer left there. */
  const press = async (label) => { const at = await rowAt(c, label); if (!at) return false; await clickAt(c, at.cx, at.cy); await sleep(500); return true; };
  /** Everything about the body a screenshot of it is evidence for. */
  const body = () => evalIn(c, `(() => {
    const b = document.querySelector('.cr-review-run'), l = b.querySelector('.cr-review-label'), lv = b.querySelector('.cr-level'), bolt = b.querySelector('.cr-review-fast');
    const bar = document.querySelector('.cr-bar'), m = b.querySelector('.cr-review-model');
    // The level's ink over the body's own ground as WCAG measures it, read back through a canvas so an
    // oklch() or translucent ink is resolved by the browser itself.
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const px = (...fills) => { g.clearRect(0, 0, 1, 1); for (const f of fills) { g.fillStyle = f; g.fillRect(0, 0, 1, 1); } return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const probe = document.createElement('span'); probe.style.background = 'var(--surface)'; b.appendChild(probe);
    const ground = getComputedStyle(probe).backgroundColor; probe.remove();
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (ink) => { const [x, y] = [lum(px(ground, ink)), lum(px(ground))].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
    const lr = l.getBoundingClientRect(), br = bolt?.getBoundingClientRect();
    return { text: b.textContent, title: b.title, level: lv?.textContent ?? null, fast: !!bolt && getComputedStyle(bolt).display !== 'none',
      levelInk: lv ? getComputedStyle(lv).color : null, labelInk: getComputedStyle(l).color, levelContrast: lv ? ratio(getComputedStyle(lv).color) : null,
      boltOnLine: !br || br.width === 0 || (br.top >= lr.top - 1 && br.bottom <= lr.bottom + 1 && br.left > lr.left + 40),
      disabled: b.disabled, width: Math.round(b.getBoundingClientRect().width), cut: l.scrollWidth > l.clientWidth + 1,
      modelShown: !!m && m.getBoundingClientRect().width > 1, levelShown: !!lv && lv.getBoundingClientRect().width > 1,
      fits: bar.scrollWidth <= bar.clientWidth + 1,
      // What the bar needs: every item but the spacer, the gaps between all of them, and its padding.
      need: (() => { const cs = getComputedStyle(bar), kids = [...bar.children];
        return Math.ceil(kids.filter((k) => !k.classList.contains('cr-bar-spacer')).reduce((a, k) => a + k.getBoundingClientRect().width, 0)
          + (parseFloat(cs.columnGap) || 0) * (kids.length - 1) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)); })(),
      barWidth: Math.round(bar.clientWidth) }; })()`);
  const clipAround = (sels, pad = 16) => evalIn(c, `(() => {
    const rs = ${JSON.stringify(sels)}.map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left)) - ${pad}, y = Math.min(...rs.map((r) => r.top)) - ${pad};
    return { x, y, width: Math.max(...rs.map((r) => r.right)) + ${pad} - x, height: Math.max(...rs.map((r) => r.bottom)) + ${pad} - y }; })()`);
  const shootBar = async (name) => shoot(c, name, await clipAround([".cr-review-with", ".cr-submit"], 14));
  const shootMenu = async (name) => shoot(c, name, await clipAround([".cr-review-with", MENU, ".model-picker"], 16));
  /** Somewhere the pointer rests on nothing, so no shot carries a hover. */
  const rest = async () => {
    await evalIn(c, `(() => { document.activeElement?.blur?.(); return true; })()`);
    const t = await box(c, ".cr-title");
    if (t) await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: t.x + 4, y: t.y + t.height / 2 });
    await sleep(450);
  };
  const reviewOf = async () => (await api.call("codeReview.reviewGet", { ref })).review;
  const replyOf = async (sid) => (await api.call("sessions.events", { id: sid, afterSeq: 0 })).map((e) => e.event)
    .filter((e) => e.type === "assistant_text").map((e) => e.payload.text).at(-1) ?? null;
  const sessionOf = async (sid) => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sid) ?? null;
  /** A real press on the body, and the review it started once it has settled. */
  const runReview = async () => {
    const before = (await reviewOf())?.sessionId ?? null;
    const b = await box(c, ".cr-review-run");
    await clickAt(c, b.x + 30, b.y + b.height / 2);
    return until(async () => { const r = await reviewOf(); return r && r.sessionId !== before && r.state !== "running" ? r : null; }, 40000, "the review").catch(() => null);
  };
  const reloadOn = async () => {
    await c.send("Page.reload", {});
    await until(() => evalIn(c, `!!document.querySelector('.app-rail')`), 30000, "reload");
    await keyWindow(c);
    await sleep(1500);
    await openRequest();
  };
  try {
    await setTheme(c, api, "dark");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await openRequest();
    const atRest = await body();
    check("reviewer: at rest the body is Review with Fable 5.1 — no level asked for, none named", atRest.text === "Review with Fable 5.1" && atRest.level === null && !atRest.fast, atRest);

    // ── The menu's chip opens the picker with its card; a pick, then → in the search ──
    CHIP = `${MENU} button[aria-label="Model"]`;
    await openMenu();
    const chip0 = await chipOf(c);
    check("reviewer: the menu's chip is the prompter's — the model, and the level in force named while none is set", chip0.text === "Fable 5.1" && chip0.effort === "High", chip0);
    await openPicker(c);
    let card = await runCard(c);
    check("reviewer: the chip opens the picker with its card — the model's own levels, its default named, no reset, the bolt",
      cardIsDrawn(card) && card.level === "High" && card.model === "Fable 5.1" && card.reset === null && !!card.bolt, card);
    check("reviewer: Opus 5.5 is a row to pick", await press("Claude Opus 5.5"));
    check("reviewer: the pick leaves the picker open over the menu", (await pickerUp()) && (await menuUp()));
    card = await runCard(c);
    check("reviewer: …its card now Opus 5.5's, at its default", card?.level === "High" && card.model === "Opus 5.5", card && { level: card.level, model: card.model });
    await key(c, "ArrowRight");
    card = await runCard(c);
    check("reviewer: → in the search, straight after the pick, steps Opus 5.5 to XHigh, the reset beside it",
      card?.level === "XHigh" && card.track?.chosen === "xhigh" && card.reset !== null, card && { level: card.level, chosen: card.track?.chosen, reset: card.reset });
    const chip1 = await chipOf(c);
    check("reviewer: the menu's chip wears XHigh as the prompter's does", chip1.text === "Opus 5.5" && chip1.effort === "XHigh" && /XHigh effort/.test(chip1.title), chip1);
    const kept1 = (await api.call("codeReview.reviewerPick", { profileId })).pick;
    check("reviewer: the profile keeps the pick as it is made", JSON.stringify(kept1) === JSON.stringify({ agentKind: "claude", model: "claude-opus-5-5", effort: "xhigh", fastMode: false }), kept1);
    const placed = await layout(c);
    check("reviewer: the picker opens whole inside the window", placed.picker.x >= 0 && placed.picker.y >= 0 && placed.picker.x + placed.picker.w <= placed.win.w && placed.picker.y + placed.picker.h <= placed.win.h, placed.picker);
    await sleep(900); // the heavy level's light, running in the track
    await shootMenu("reviewer-dark-picker-card");
    await closePicker(c);
    check("reviewer: Escape puts the picker away and leaves the menu", await menuUp());
    await shoot(c, "reviewer-dark-menu", await clipAround([".cr-review-with", MENU], 16));
    await closeMenu();
    await rest();

    // ── The body says it, and the review runs at it ──
    const b1 = await body();
    check("reviewer: the body says the level as the chip does — Review with Opus 5.5 XHigh, the level a shade quieter, nothing cut, the bar whole",
      b1.text === "Review with Opus 5.5 XHigh" && b1.level === "XHigh" && b1.levelInk !== b1.labelInk && !b1.cut && b1.fits, b1);
    check("reviewer: the level's ink clears AA on the body's ground", b1.levelContrast >= 4.5, b1.levelContrast);
    check("reviewer: …and the tooltip says it in words", b1.title === "A read-only Opus 5.5 at XHigh effort reads the diff and leaves findings for you — nothing is posted", b1.title);
    await shootBar("reviewer-dark-button");
    const r1 = await runReview();
    const s1 = r1 ? await sessionOf(r1.sessionId) : null;
    const reply1 = r1 ? await replyOf(r1.sessionId) : null;
    check("reviewer: the review starts its session on Opus 5.5 at XHigh, read-only, not fast",
      s1?.model === "claude-opus-5-5" && s1.effort === "xhigh" && s1.fastMode === false && s1.permissionMode === "plan", s1 && { model: s1.model, effort: s1.effort, fastMode: s1.fastMode, permissionMode: s1.permissionMode });
    check("reviewer: …and the CLI ran it at xhigh", /^Ran on claude-opus-5-5: effort xhigh, fast off\./.test(reply1 ?? ""), reply1);
    check("reviewer: the review is kept with its level", r1?.state === "done" && r1.effort === "xhigh", r1 && { state: r1.state, effort: r1.effort });
    await until(() => evalIn(c, `!!document.querySelector('.cr-review[data-state=done]')`), 10000, "the panel").catch(() => null);
    const head1 = await evalIn(c, `(() => { const t = document.querySelector('.cr-review-title'); return { text: t?.textContent ?? null, level: t?.querySelector('.cr-level')?.textContent ?? null }; })()`);
    check("reviewer: its panel is headed Review by Opus 5.5 XHigh", head1.text === "Review by Opus 5.5 XHigh" && head1.level === "XHigh", head1);
    await rest();
    await shoot(c, "reviewer-dark-panel", await clipAround([".cr-review"], 12));

    // ── Fast mode: the bolt on the card, worn by the body, honoured by the run ──
    await openMenu();
    await openPicker(c);
    card = await runCard(c);
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    await sleep(500);
    card = await runCard(c);
    check("reviewer: a press on the bolt asks for fast mode", card?.bolt?.pressed === "true", card?.bolt);
    await sleep(500);
    await shootMenu("reviewer-dark-picker-fast");
    await closePicker(c);
    await closeMenu();
    await rest();
    const b2 = await body();
    check("reviewer: the body wears the bolt after the level on the same line, and says it in its name",
      b2.text === "Review with Opus 5.5 XHigh in fast mode" && b2.fast && b2.boltOnLine && b2.fits && !b2.cut, b2);
    await shootBar("reviewer-dark-button-fast");
    const r2 = await runReview();
    const s2 = r2 ? await sessionOf(r2.sessionId) : null;
    const reply2 = r2 ? await replyOf(r2.sessionId) : null;
    check("reviewer: with the bolt the review's session is fast, and the CLI ran it at xhigh, fast", s2?.fastMode === true && /^Ran on claude-opus-5-5: effort xhigh, fast on\./.test(reply2 ?? ""), { fastMode: s2?.fastMode, reply: reply2 });

    // ── The profile's, in the next window ──
    await reloadOn();
    const b3 = await body();
    check("reviewer: a new window reads the profile's reviewer — Opus 5.5, XHigh, the bolt", b3.text === "Review with Opus 5.5 XHigh in fast mode" && b3.fast, b3);

    // ── A model that takes no level: the remembered one gives way, and comes back ──
    await openMenu();
    await openPicker(c);
    card = await runCard(c);
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy); // off, so the run says only what the level did
    await sleep(300);
    check("reviewer: Haiku 4.5 is a row to pick", await press("Claude Haiku 4.5"));
    card = await runCard(c);
    check("reviewer: Haiku 4.5, which the CLI says takes no level, draws no track", !!card && card.track === null, card && { level: card.level, track: card.track });
    await closePicker(c);
    await closeMenu();
    await rest();
    const b4 = await body();
    check("reviewer: the body names no level for it", b4.text === "Review with Haiku 4.5" && b4.level === null, b4);
    const kept4 = (await api.call("codeReview.reviewerPick", { profileId })).pick;
    check("reviewer: …while the profile still holds XHigh, as a session's row would", kept4?.model === "claude-haiku-4-5" && kept4.effort === "xhigh" && kept4.fastMode === false, kept4);
    const r4 = await runReview();
    const s4 = r4 ? await sessionOf(r4.sessionId) : null;
    const reply4 = r4 ? await replyOf(r4.sessionId) : null;
    check("reviewer: its review is sent no level, and the CLI runs it at none", s4?.effort === null && /^Ran on claude-haiku-4-5: effort none, fast off\./.test(reply4 ?? ""), { effort: s4?.effort, reply: reply4 });
    await openMenu();
    await openPicker(c);
    await press("Claude Opus 5.5");
    await closePicker(c);
    await closeMenu();
    await rest();
    const b5 = await body();
    check("reviewer: back on Opus 5.5, XHigh is in force again", b5.text === "Review with Opus 5.5 XHigh" && b5.level === "XHigh", b5);

    // ── Narrow: the bar gives up the words before its controls ──
    // Fast mode on again, so the sweep is of the longest body.
    await openMenu();
    await openPicker(c);
    card = await runCard(c);
    await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
    await closePicker(c);
    await closeMenu();
    const widths = [];
    for (let w = 1240; w >= 1000; w -= 10) {
      await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 2, mobile: false });
      await sleep(350);
      const k = await body();
      widths.push({ w, main: await evalIn(c, `Math.round(document.querySelector('.cr-main').getBoundingClientRect().width)`), bar: k.barWidth, need: k.need,
        fits: k.fits, level: k.levelShown, bolt: k.fast, model: k.modelShown, cut: k.cut, body: k.width });
    }
    console.log("WIDTHS", JSON.stringify(widths));
    check("reviewer: at every width the bar fits and the body's words are never cut; narrowing, the level and the bolt go first, then the name",
      widths.every((x) => x.fits && !x.cut) && widths.some((x) => x.level && x.bolt && x.model) && widths.some((x) => !x.level && !x.bolt && x.model)
        && widths.some((x) => !x.model) && widths.every((x) => x.model || !x.level), widths.filter((x) => !x.fits || x.cut));
    const narrow = await body();
    check("reviewer: narrow, the tooltip still names the model, its level and fast mode", /^A read-only Opus 5\.5 at XHigh effort in fast mode reads/.test(narrow.title), narrow.title);
    await rest();
    await shootBar("reviewer-dark-button-narrow");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(500);

    // ── The light face ──
    await setTheme(c, api, "light");
    await openRequest();
    await openMenu();
    await openPicker(c);
    await sleep(900); // the heavy level's light, running in the track
    card = await runCard(c);
    check("light reviewer: the card reads XHigh with the bolt pressed", card?.level === "XHigh" && card.bolt?.pressed === "true", card && { level: card.level, bolt: card.bolt });
    await shootMenu("reviewer-light-picker-card");
    await closePicker(c);
    await shoot(c, "reviewer-light-menu", await clipAround([".cr-review-with", MENU], 16));
    await closeMenu();
    await rest();
    const l1 = await body();
    check("light reviewer: the body says Review with Opus 5.5 XHigh and wears the bolt on its line", l1.text === "Review with Opus 5.5 XHigh in fast mode" && l1.fast && l1.boltOnLine && l1.fits, l1);
    check("light reviewer: the level's ink clears AA on the body's ground", l1.levelContrast >= 4.5, l1.levelContrast);
    await shootBar("reviewer-light-button");
    const l2 = await runReview();
    const lreply = l2 ? await replyOf(l2.sessionId) : null;
    check("light reviewer: a review from the light face runs at xhigh, fast, too", /^Ran on claude-opus-5-5: effort xhigh, fast on\./.test(lreply ?? ""), lreply);
    await until(() => evalIn(c, `document.querySelector('.cr-review-title')?.textContent === 'Review by Opus 5.5 XHigh'`), 10000, "the light panel").catch(() => null);
    await rest();
    await shoot(c, "reviewer-light-panel", await clipAround([".cr-review"], 12));
    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("reviewer: no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    CHIP = '.composer button[aria-label="Model"]';
    await stop(home);
  }
}

/** `n` frames of a clip, `gapMs` apart, saved as `<name>-NN.png` for a contact sheet; the base64 of each. */
async function frames(c, name, clip, n, gapMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
    fs.writeFileSync(path.join(shots, `${name}-${String(i + 1).padStart(2, "0")}.png`), Buffer.from(data, "base64"));
    out.push(data);
    if (gapMs && i < n - 1) await sleep(gapMs);
  }
  console.log(`FRAMES ${name} ${n}`);
  return out;
}
/** What a frame holds, decoded in the page: how bright it is on average, how colourful its most
 *  saturated pixel, and — along one row — the column the light peaks at. */
const stats = (c, b64, rowAt = 0.5, span = [0, 1]) => evalIn(c, `(async () => {
  const i = new Image(); i.src = "data:image/png;base64," + ${JSON.stringify(b64)}; await i.decode();
  const cv = document.createElement("canvas"); cv.width = i.width; cv.height = i.height;
  const x = cv.getContext("2d"); x.drawImage(i, 0, 0); const px = x.getImageData(0, 0, cv.width, cv.height).data;
  let sum = 0, chroma = 0; for (let k = 0; k < px.length; k += 4) { sum += 0.299 * px[k] + 0.587 * px[k+1] + 0.114 * px[k+2]; chroma = Math.max(chroma, Math.max(px[k], px[k+1], px[k+2]) - Math.min(px[k], px[k+1], px[k+2])); }
  const y = Math.round((cv.height - 1) * ${rowAt}); let peak = 0, at = 0;
  const k0 = Math.round(cv.width * ${span[0]}), k1 = Math.round(cv.width * ${span[1]});
  for (let k = k0; k < k1; k++) { const o = (y * cv.width + k) * 4; const l = px[o] + px[o+1] + px[o+2]; if (l > peak) { peak = l; at = k; } }
  return { mean: Math.round(sum / (px.length / 4)), chroma, peakAt: Math.round(at / cv.width * 100) };
})()`);
/** The share of pixels that differ between two frames of one clip, in percent. */
const changed = (c, a, b) => evalIn(c, `(async () => {
  const load = async (d) => { const i = new Image(); i.src = "data:image/png;base64," + d; await i.decode(); return i; };
  const [x, y] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
  const grab = (img) => { const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0); return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; };
  const [p, q] = [grab(x), grab(y)]; let diff = 0;
  for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i+1] - q[i+1]) + Math.abs(p[i+2] - q[i+2]) > 12) diff++;
  return Math.round((diff / (p.length / 4)) * 1000) / 10;
})()`);

/**
 * Realm's light at the heavy levels, and fast mode's moment, recorded rather than described: frames
 * of the card at Max, XHigh and High in both faces, the moment slowed down through the DevTools
 * animation clock so a 480 ms pass can be seen frame by frame, and the light held still for Reduce
 * motion and for Low power.
 */
async function lightPhase() {
  const { c, api, home, sessionId } = await boot(stubs(path.join(scratch, "bin-light"), { acp: false }), "light");
  const mine = async () => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sessionId);
  const trackClip = async () => { const t = (await runCard(c)).track.box; return { x: t.x + 2, y: t.y + 2, width: t.w - 4, height: t.h - 4 }; };
  // The run every level fills — the first two-fifths — so a brightness there compares light with light.
  const filledClip = async () => { const t = (await runCard(c)).track.box; return { x: t.x + 4, y: t.y + 4, width: Math.round(t.w * 0.4), height: t.h - 8 }; };
  const cardClip = async () => { const k = (await runCard(c)).card; return { x: k.x - 12, y: k.y - 10, width: k.w + 24, height: k.h + 20 }; };
  try {
    for (const mode of ["dark", "light"]) {
      await setTheme(c, api, mode);
      await openPicker(c);
      check(`light ${mode}: Tab reaches the track`, await tabToTrack(c));
      await key(c, "End");
      await until(async () => (await mine())?.effort === "max", 5000, "max");
      await sleep(700);
      const lit = await evalIn(c, `["mp-track-facets", "mp-track-flow", "mp-track-core", "mp-track-shine"].filter((k) => document.querySelector("." + k))`);
      check(`light ${mode}: Max carries all four layers of the light`, lit.length === 4, lit);
      const maxFrames = await frames(c, `light-${mode}-max`, await cardClip(), 10, 160);
      const maxTrack = await frames(c, `track-${mode}-max`, await trackClip(), 2, 700);
      const maxFilled = await frames(c, `filled-${mode}-max`, await filledClip(), 4, 220);
      const maxMove = await changed(c, maxTrack[0], maxTrack[1]);
      check(`light ${mode}: at Max the light moves`, maxMove > 3, { changed: maxMove });
      await key(c, "ArrowLeft");
      await until(async () => (await mine())?.effort === "xhigh", 5000, "xhigh");
      await sleep(700);
      await frames(c, `light-${mode}-xhigh`, await cardClip(), 10, 160);
      const xTrack = await frames(c, `track-${mode}-xhigh`, await trackClip(), 2, 700);
      const xFilled = await frames(c, `filled-${mode}-xhigh`, await filledClip(), 4, 220);
      const xMove = await changed(c, xTrack[0], xTrack[1]);
      check(`light ${mode}: at XHigh it moves too, and less of it`, xMove > 0.5, { changed: xMove });
      await key(c, "ArrowLeft");
      await until(async () => (await mine())?.effort === "high", 5000, "high");
      await sleep(500);
      const hTrack = await frames(c, `track-${mode}-high`, await trackClip(), 2, 700);
      const hFilled = await frames(c, `filled-${mode}-high`, await filledClip(), 4, 220);
      const hMove = await changed(c, hTrack[0], hTrack[1]);
      check(`light ${mode}: at High the track is the plain control it always was`, hMove === 0 && !(await evalIn(c, `!!document.querySelector(".mp-track-flow")`)), { changed: hMove });
      const meanOf = async (fs) => { let t = 0; for (const f of fs) t += (await stats(c, f)).mean; return Math.round(t / fs.length); };
      const [sMax, sX, sH] = [{ mean: await meanOf(maxFilled) }, { mean: await meanOf(xFilled) }, { mean: await meanOf(hFilled) }];
      check(`light ${mode}: the light scales with the level — brighter at Max than at XHigh, and either over plain High`, sMax.mean > sX.mean && sX.mean > sH.mean, { max: sMax, xhigh: sX, high: sH });
      await key(c, "End");
      await until(async () => (await mine())?.effort === "max", 5000, "max again");
      await sleep(500);
      if ((await mine())?.fastMode) { await clickAt(c, (await runCard(c)).bolt.box.cx, (await runCard(c)).bolt.box.cy); await sleep(400); }
      // Fast mode's moment, slowed twenty times, so its passes can be seen frame by frame — once over
      // the card, then again over the chip, each its own small clip so the frames come quickly.
      const card = await runCard(c), chipBox = await box(c, CHIP);
      const cardOnly = { x: card.card.x - 14, y: card.card.y - 12, width: card.card.w + 28, height: card.card.h + 24 };
      const chipOnly = { x: chipBox.x - 10, y: chipBox.y - 8, width: chipBox.width + 20, height: chipBox.height + 16 };
      await c.send("Animation.enable");
      await c.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
      await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
      const during = await evalIn(c, `({ charge: document.querySelector(".mp-bolt")?.hasAttribute("data-charge"), glint: !!document.querySelector(".mp-track-glint"),
        chip: document.querySelector(${JSON.stringify(CHIP)})?.getAttribute("data-sweep") ?? null })`);
      check(`fast ${mode}: switching it on charges the bolt, glints the track and glints the chip`, during.charge && during.glint && during.chip === "fast", during);
      // Where the pass is, read off the animation itself between batches of frames: the light's own
      // streams are as bright as the glint, so the brightest column in a frame says nothing.
      const glintAt = () => evalIn(c, `(() => { const g = document.querySelector(".mp-track-glint"); return g ? Math.round(parseFloat(getComputedStyle(g).backgroundPosition)) : null; })()`);
      const at = [await glintAt()];
      await frames(c, `fast-${mode}-card`, cardOnly, 5, 420);
      at.push(await glintAt());
      await frames(c, `fast-${mode}-card-late`, cardOnly, 5, 420);
      at.push(await glintAt());
      check(`fast ${mode}: the glint runs along the track, left to right`, at.every((p, i) => p !== null && (i === 0 || p < at[i - 1])), at);
      await c.send("Animation.setPlaybackRate", { playbackRate: 1 });
      const marks = () => evalIn(c, `({ charge: document.querySelector(".mp-bolt")?.hasAttribute("data-charge"), sweep: document.querySelector(${JSON.stringify(CHIP)})?.getAttribute("data-sweep") ?? null,
        running: document.getAnimations().map((a) => a.animationName ?? a.id).filter(Boolean) })`);
      const left = await until(async () => { const m = await marks(); return !m.charge && m.sweep === null ? m : null; }, 4000, "marks off").catch(async () => marks());
      check(`fast ${mode}: …and each comes off again once its pass is over`, !left.charge && left.sweep === null, left);
      // Off, quietly, and on again for the chip's frames.
      await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
      await sleep(500);
      await c.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
      await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
      const words = await evalIn(c, `(() => { const k = document.querySelector(${JSON.stringify(CHIP)}); const l = getComputedStyle(k.querySelector(".chip-label"));
        return { sweep: k.getAttribute("data-sweep"), image: l.backgroundImage.startsWith("linear-gradient"), clip: l.backgroundClip, fill: l.webkitTextFillColor, anim: l.animationName }; })()`);
      check(`fast ${mode}: the chip's words carry the light, past the squircle painter that owns its ground`,
        words.sweep === "fast" && words.image && words.clip === "text" && words.anim === "rl-chip-sweep", words);
      await frames(c, `fast-${mode}-chip`, chipOnly, 10, 420);
      await c.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await sleep(700);
      await shootPicker(c, `light-${mode}-picker-max-fast`);
      // Off is quiet — pressed where the bolt was, which is where it still is.
      const now = await runCard(c);
      check(`fast ${mode}: the bolt is still where it was pressed`, now.bolt.box.x === card.bolt.box.x && now.bolt.box.y === card.bolt.box.y, { before: card.bolt.box, after: now.bolt.box });
      await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
      await sleep(80);
      const off = await evalIn(c, `({ charge: document.querySelector(".mp-bolt")?.hasAttribute("data-charge"), chip: document.querySelector(${JSON.stringify(CHIP)})?.getAttribute("data-sweep") ?? null })`);
      check(`fast ${mode}: switching it off plays nothing`, !off.charge && off.chip === null, off);
      await closePicker(c);
    }

    // Held still: Reduce motion stops the light where it stands, and so does Low power.
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await openPicker(c);
    await sleep(500);
    const still = await frames(c, "track-reduced-max", await trackClip(), 2, 900);
    const stillMove = await changed(c, still[0], still[1]);
    check("reduced: the light holds still, and is still there", stillMove === 0 && await evalIn(c, `!!document.querySelector(".mp-track-flow")`), { changed: stillMove });
    await shootPicker(c, "light-reduced-picker");
    await closePicker(c);
    await c.send("Emulation.setEmulatedMedia", { features: [] });
    await api.call("settings.set", { key: "ui.lowPower", value: true });
    await reload(c);
    await openPicker(c);
    await sleep(500);
    const quiet = await frames(c, "track-lowpower-max", await trackClip(), 2, 900);
    const quietMove = await changed(c, quiet[0], quiet[1]);
    check("low power: the light holds still", quietMove === 0 && (await evalIn(c, `document.documentElement.dataset.quiet`)) === "always", { changed: quietMove });
    await closePicker(c);
    await api.call("settings.set", { key: "ui.lowPower", value: false });
    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("light: no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    await stop(home);
  }
}

/** The open picker as the pointer meets it: its box, its groups and rows in order, the ticked one,
 *  where the keyboard is and what of the search is selected, and the foot's box. */
const held = (c) => evalIn(c, `(() => { const p = document.querySelector('.model-picker'); if (!p) return null;
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const field = p.querySelector('.mp-search input');
  return { picker: r(p), held: p.hasAttribute('data-held'), closing: p.hasAttribute('data-closing'),
    groups: [...p.querySelectorAll('.mp-group')].map((g) => g.getAttribute('aria-label')),
    rows: [...p.querySelectorAll('.mp-row')].map((o) => o.getAttribute('aria-label')),
    ticked: p.querySelector('.mp-row[aria-selected="true"]')?.getAttribute('aria-label') ?? null,
    focus: document.activeElement === field, selected: field ? [field.selectionStart, field.selectionEnd, field.value.length] : null,
    foot: r(p.querySelector('.mp-foot')), card: p.querySelector('.mp-run-model')?.textContent ?? null,
    level: p.querySelector('.mp-run-level')?.textContent ?? null, dots: p.querySelectorAll('.mp-track-dot').length }; })()`);
const sameBox = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * The owner, 10-05: "if I change the model, the modal always closes … so I can change model and then
 * also change … the effort level and also … fast mode all in one shot." One visit to the picker, with
 * real presses and real keys: a model, then the level by ← → in the search the keyboard was left in,
 * then the bolt — the picker open throughout, its box and the pressed row where they were — then a
 * model on another harness, one with no card at all, and back. A frame of the same clip after each.
 */
async function stayOpen() {
  const { c, api, home, sessionId } = await boot(stubs(path.join(scratch, "bin-stay"), { acp: true }), "stay");
  const mine = async () => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sessionId);
  const becomes = (fn, tag) => until(async () => fn(await mine()), 5000, tag).then(() => true, () => false);
  try {
    for (const mode of ["dark", "light"]) {
      await setTheme(c, api, mode);
      await openPicker(c);
      const start = await held(c), chip = await box(c, CHIP);
      // One clip for every frame, so the sequence lines up: the picker and its chip — above or below
      // it, wherever the prompter sits — and a margin.
      const left = Math.min(start.picker.x, chip.x) - 16, top = Math.min(start.picker.y, chip.y) - 16;
      const clip = { x: left, y: top, width: Math.max(start.picker.x + start.picker.w, chip.x + chip.width) + 16 - left,
        height: Math.max(start.picker.y + start.picker.h, chip.y + chip.height) + 16 - top };
      let n = 0;
      const frame = (what) => shoot(c, `stay-${mode}-${String(++n).padStart(2, "0")}-${what}`, clip);
      await frame("open");

      const opus = await rowAt(c, "Claude Opus 5.5");
      await clickAt(c, opus.cx, opus.cy);
      check(`stay ${mode}: a click on Opus 5.5 puts the session on it`, await becomes((s) => s?.model === "claude-opus-5-5", "opus"));
      await sleep(250);
      let now = await held(c);
      await frame("model");
      check(`stay ${mode}: …and the picker stays open, its box and the row pressed where they were`,
        !!now && !now.closing && sameBox(now.picker, start.picker) && sameBox(await rowAt(c, "Claude Opus 5.5"), opus) && now.ticked === "Claude Opus 5.5", { now, start: start.picker, opus });
      check(`stay ${mode}: the card is the new model's, and the chip behind it says so already`,
        now?.card === "Opus 5.5" && (await chipOf(c)).text.includes("Opus 5.5"), { card: now?.card, chip: await chipOf(c) });
      check(`stay ${mode}: the keyboard is still in the search`, !!now?.focus, now);

      await key(c, "ArrowRight");
      check(`stay ${mode}: → in the search steps the picked model's level up, to XHigh`, await becomes((s) => s?.effort === "xhigh", "xhigh"));
      await sleep(250);
      await frame("xhigh");
      await key(c, "ArrowRight");
      check(`stay ${mode}: …and again, to Max`, await becomes((s) => s?.effort === "max", "max"));
      await sleep(600);
      await frame("max");
      now = await held(c);
      check(`stay ${mode}: the level moved and nothing else did`, now?.level === "Max" && sameBox(now.picker, start.picker) && (await chipOf(c)).effort === "Max", now);

      const card = await runCard(c);
      await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
      check(`stay ${mode}: the bolt asks for fast mode, in the same visit`, await becomes((s) => s?.fastMode === true, "fast"));
      await sleep(700);
      await frame("fast");
      now = await held(c);
      check(`stay ${mode}: still open, still in place, and the chip wears the level and the bolt`,
        !!now && !now.closing && sameBox(now.picker, start.picker) && (await chipOf(c)).fast && (await chipOf(c)).effort === "Max", { now, chip: await chipOf(c) });

      // A model on another harness: the session moves to Codex, and the list must not re-sort under the pointer.
      const sol = await rowAt(c, "GPT-5.6-Sol");
      await clickAt(c, sol.cx, sol.cy);
      check(`stay ${mode}: a click on GPT-5.6-Sol moves the session to Codex`, await becomes((s) => s?.agentKind === "codex" && s.model === "gpt-5.6-sol", "codex"));
      await sleep(400);
      await frame("codex");
      now = await held(c);
      check(`stay ${mode}: the list holds still — every group and row where it was, the pressed row under the pointer`,
        JSON.stringify(now?.groups) === JSON.stringify(start.groups) && JSON.stringify(now?.rows) === JSON.stringify(start.rows) && sameBox(await rowAt(c, "GPT-5.6-Sol"), sol) && now.ticked === "GPT-5.6-Sol",
        { groups: [start.groups, now?.groups], sol: [sol, await rowAt(c, "GPT-5.6-Sol")] });
      check(`stay ${mode}: …and the card turns to Codex's levels for Sol`, now?.card === "GPT-5.6-Sol" && now.dots === 4 && sameBox(now.picker, start.picker), now);

      // A model whose card is another size — none at all — and back: the box holds, the list gives.
      const hands = await rowAt(c, "OpenHands");
      await clickAt(c, hands.cx, hands.cy);
      check(`stay ${mode}: a click on OpenHands moves the session to it`, await becomes((s) => s?.agentKind === "acp:openhands", "openhands"));
      await sleep(400);
      await frame("no-card");
      now = await held(c);
      check(`stay ${mode}: with no card to show, the box keeps its height and the list takes the room`,
        !!now && now.held && now.foot === null && sameBox(now.picker, start.picker) && sameBox(await rowAt(c, "OpenHands"), hands), { now, hands });
      const fable = await rowAt(c, "Claude Fable 5.1");
      await clickAt(c, fable.cx, fable.cy);
      check(`stay ${mode}: and back to Claude`, await becomes((s) => s?.agentKind === "claude", "claude again"));
      await sleep(400);
      await frame("back");
      now = await held(c);
      check(`stay ${mode}: the card comes back inside the same box, the row pressed where it was`,
        !!now?.foot && now.card === "Fable 5.1" && sameBox(now.picker, start.picker) && sameBox(await rowAt(c, "Claude Fable 5.1"), fable), { now, fable });

      await closePicker(c);
      check(`stay ${mode}: Escape puts it away`, await evalIn(c, `!document.querySelector('.model-picker')`));
      await openPicker(c);
      const out = await box(c, ".session-pane");
      await clickAt(c, out.x + 40, out.y + 120);
      await until(() => evalIn(c, `!document.querySelector('.model-picker')`), 3000, "closed by a click outside").catch(() => null);
      check(`stay ${mode}: a click outside puts it away`, await evalIn(c, `!document.querySelector('.model-picker')`));
      // The next face starts from the same place: a fresh Claude session on its defaults.
      await api.call("sessions.setOptions", { id: sessionId, effort: null, fastMode: false });
      await sleep(300);
    }
    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("stay: no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    await stop(home);
  }
}

/**
 * The owner, 10-05: "Update the schedule modal as well." The Schedule a task modal's Model row is the
 * prompter's chip and picker: Opus 5.5 at XHigh with fast mode and Accept edits, set in one visit; the
 * task's card and its row name it in the chip's words; and Run now starts a session on exactly that —
 * the fake Claude CLI answers with what its flag layer holds, so the reply says what the run ran at.
 */
async function schedulePhase() {
  const { c, api, home } = await boot(stubs(path.join(scratch, "bin-sched"), { acp: false, claudeCli: true }), "sched");
  const SHEET = '[role=dialog][aria-label="Schedule a task"]';
  const sheetClip = async (name = "Schedule a task") => { const b = await box(c, `[role=dialog][aria-label="${name}"]`); return { x: b.x - 24, y: b.y - 24, width: b.width + 48, height: b.height + 48 }; };
  const openPage = async () => {
    await evalIn(c, `(() => { const b = document.querySelector('.app-rail button[aria-label="Scheduled tasks"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.schedules-page')`), 15000, "the Scheduled page");
    await sleep(700);
  };
  const press = async (sel) => { const b = await box(c, sel); await clickAt(c, b.x + b.width / 2, b.y + b.height / 2); };
  const chipText = (sel) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? { text: e.textContent, fast: !!e.querySelector('.chip-fast'), title: e.getAttribute('title') } : null; })()`);
  try {
    for (const mode of ["dark", "light"]) {
      await setTheme(c, api, mode);
      await openPage();
      if (mode === "dark") {
        await evalIn(c, `(() => { document.querySelector('.sched-new').click(); return true; })()`);
        await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(SHEET)})`), 10000, "the modal");
        await evalIn(c, `(() => { const d = document.querySelector(${JSON.stringify(SHEET)});
          const set = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
          set(d.querySelector('[aria-label="Task name"]'), 'Release notes');
          set(d.querySelector('[aria-label="Instructions"]'), 'Draft this week’s release notes from what merged to main.');
          [...d.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Advanced')).click(); return true; })()`);
        await sleep(500);
      } else {
        await evalIn(c, `(() => { [...document.querySelectorAll('.sched-task-hit')].find((b) => b.textContent.startsWith('Release notes')).click(); return true; })()`);
        await sleep(600);
        await evalIn(c, `(() => { document.querySelector('button[aria-label="Edit Release notes"]').click(); return true; })()`);
        await until(() => evalIn(c, `!!document.querySelector('[role=dialog][aria-label="Edit task"]')`), 10000, "the edit modal");
        await evalIn(c, `(() => { [...document.querySelector('[role=dialog][aria-label="Edit task"]').querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Advanced')).click(); return true; })()`);
        await sleep(500);
      }
      const sheet = mode === "dark" ? SHEET : '[role=dialog][aria-label="Edit task"]';
      CHIP = `${sheet} button[aria-label="Model"]`;
      const row = await evalIn(c, `(() => { const d = document.querySelector(${JSON.stringify(sheet)});
        return { effortRow: !!d.querySelector('[aria-label="Effort"]'), modelRows: [...d.querySelectorAll('.settings-row-name')].filter((n) => n.textContent === 'Model').length,
          chip: !!d.querySelector('.sched-model-row .model-chip') }; })()`);
      check(`schedule ${mode}: Model and Effort are one row, holding the prompter's chip`, !row.effortRow && row.modelRows === 1 && row.chip, row);
      await openPicker(c);
      await shootPicker(c, `schedule-${mode}-picker-open`);
      await shoot(c, `schedule-${mode}-modal-picker-open`, await sheetClip(mode === "dark" ? "Schedule a task" : "Edit task"));
      if (mode === "dark") {
        const start = await held(c);
        const card0 = await runCard(c);
        check("schedule: the card names Claude's default while the task names none, over the model's own five levels",
          card0?.level === "High" && card0.dots.length === 5 && !card0.reset, card0 && { level: card0.level, dots: card0.dots.length });
        check("schedule: the permission row offers what a run can start in, and no Full access",
          JSON.stringify(await evalIn(c, `[...document.querySelectorAll('.mp-foot .mp-seg-group[aria-label="Permissions"] .mp-seg-opt')].map((b) => b.textContent)`)) === JSON.stringify(["Ask each time", "Accept edits"]));
        check("schedule: the scripted agent is offered here, as the checks that drive the app need", !!(await rowAt(c, "Fake")));
        await pickRow(c, "Claude Opus 5.5");
        await key(c, "ArrowRight");
        await sleep(300);
        const card = await runCard(c);
        await clickAt(c, card.bolt.box.cx, card.bolt.box.cy);
        await sleep(500);
        await press('.mp-foot .mp-seg-group[aria-label="Permissions"] .mp-seg-opt:nth-child(2)');
        await sleep(500);
        const set = await held(c);
        check("schedule: a pick, a level, the bolt and the permission in one visit, the picker open and unmoved throughout",
          !!set && !set.closing && sameBox(set.picker, start.picker) && set.card === "Opus 5.5" && set.level === "XHigh"
            && (await runCard(c))?.bolt?.pressed === "true" && await evalIn(c, `document.querySelector('.mp-foot .mp-seg-opt[aria-pressed="true"]')?.textContent === 'Accept edits'`),
          { set, start: start.picker });
        await shootPicker(c, "schedule-dark-picker-set");
        const chip = await chipText(CHIP);
        check("schedule: the chip in the row says it as it happens", /Opus 5\.5XHigh/.test(chip?.text ?? "") && chip.fast, chip);
        await closePicker(c);
        check("schedule: Escape puts the picker away and leaves the modal", await evalIn(c, `!document.querySelector('.model-picker') && !!document.querySelector(${JSON.stringify(SHEET)})`));
        await evalIn(c, `(() => { const b = document.querySelector(${JSON.stringify(SHEET)}).querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; return true; })()`);
        await sleep(300);
        await shoot(c, "schedule-dark-modal-set", await sheetClip());
        await evalIn(c, `(() => { [...document.querySelector(${JSON.stringify(SHEET)}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create').click(); return true; })()`);
        await until(() => evalIn(c, `!document.querySelector(${JSON.stringify(SHEET)}) && document.querySelector('.sched-empty-title')?.textContent === 'No runs yet'`), 15000, "the task made");
        const space = (await api.call("spaces.list", {}))[0];
        const made = (await api.call("schedules.list", { spaceId: space.id })).find((t) => t.title === "Release notes");
        check("schedule: the task holds what the picker set", JSON.stringify(made?.constraints) === JSON.stringify({ agentKind: "claude", model: "claude-opus-5-5", effort: "xhigh", fastMode: true, permissionMode: "acceptEdits" }), made?.constraints);
        await sleep(400);
        const line = await chipText('.sched-task .sched-model'), fact = await chipText('.sched-card .sched-model');
        check("schedule: its row and its card name it in the chip's words — model, level and bolt", line?.text === "Opus 5.5XHigh" && line.fast && fact?.text === line.text && fact.fast
          && line.title === "Claude Opus 5.5 through Claude · XHigh effort · fast mode", { line, fact });
        await shoot(c, "schedule-dark-task");
        await evalIn(c, `(() => { [...document.querySelectorAll('.sched-main button')].find((b) => b.textContent.trim() === 'Run now').click(); return true; })()`);
        const runs = await until(async () => {
          const r = (await api.call("runs.list", { spaceId: space.id, scheduleId: made.id })).runs;
          return r.length === 1 && r[0].state === "succeeded" ? r : null;
        }, 40000, "the run settling").catch(() => null);
        const sid = runs?.[0]?.sessionId;
        const ran = sid ? (await api.call("sessions.listAll", { profileId: null })).find((x) => x.id === sid) : null;
        check("schedule: Run now starts a session on Opus 5.5 at XHigh, fast, accepting edits",
          ran?.model === "claude-opus-5-5" && ran.effort === "xhigh" && ran.fastMode === true && ran.permissionMode === "acceptEdits", ran && { model: ran.model, effort: ran.effort, fastMode: ran.fastMode, permissionMode: ran.permissionMode });
        const reply = sid ? (await api.call("sessions.events", { id: sid, afterSeq: 0 })).map((e) => e.event).filter((e) => e.type === "assistant_text").map((e) => e.payload.text).at(-1) : null;
        check("schedule: …and the CLI ran its turn that way", /^Ran on claude-opus-5-5: effort xhigh, fast on\./.test(reply ?? ""), reply);
        await until(() => evalIn(c, `!!document.querySelector('.sched-view .session-pane') && document.querySelector('.sched-view .session-pane').textContent.includes('effort xhigh, fast on')`), 15000, "the run on screen").catch(() => null);
        await sleep(800);
        const prompter = await evalIn(c, `(() => { const b = document.querySelector('.sched-view .composer button[aria-label="Model"]'); return b ? { text: b.querySelector('.chip-label')?.textContent, effort: b.querySelector('.chip-effort')?.textContent ?? null, fast: !!b.querySelector('.chip-fast') } : null; })()`);
        check("schedule: the run's own prompter says what it ran with", prompter?.text === "Opus 5.5" && prompter.effort === "XHigh" && prompter.fast, prompter);
        await shoot(c, "schedule-dark-run");
      } else {
        await closePicker(c);
        await evalIn(c, `(() => { [...document.querySelector('[role=dialog][aria-label="Edit task"]').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click(); return true; })()`);
        await sleep(500);
        await evalIn(c, `(() => { document.querySelector('.sched-run')?.click(); return true; })()`);
        await until(() => evalIn(c, `!!document.querySelector('.sched-view .session-pane')`), 15000, "the run in light").catch(() => null);
        await sleep(900);
        await shoot(c, "schedule-light-run");
      }
    }
    const errs = c.errors.filter((e) => !e.includes("Autofill"));
    check("schedule: no renderer console errors", errs.length === 0, errs.slice(0, 5));
    c.close(); api.close();
  } finally {
    CHIP = '.composer button[aria-label="Model"]';
    await stop(home);
  }
}

process.on("SIGINT", () => { void stop(null).then(() => process.exit(130)); });
const only = (process.env.LIVE_ONLY ?? "").split(",").filter(Boolean);
const wanted = (name) => only.length === 0 || only.includes(name);
try {
  if (wanted("owner")) await owner();
  if (wanted("long")) await longList();
  if (wanted("real")) await ownerReal();
  if (wanted("review")) await review();
  if (wanted("reviewer")) await reviewer();
  if (wanted("light")) await lightPhase();
  if (wanted("stay")) await stayOpen();
  if (wanted("schedule")) await schedulePhase();
} catch (e) {
  console.error("ERROR", e.message);
  process.exitCode = 1;
  await stop(null);
} finally {
  if (!process.env.LIVE_SHOTS) console.log(`screenshots in ${shots}`);
  fs.rmSync(path.join(scratch, "owner-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "long-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "real-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "review-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "reviewer-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "light-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "stay-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "sched-home"), { recursive: true, force: true });
}
