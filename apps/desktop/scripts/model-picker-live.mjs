/**
 * Live check for the model picker (run with: node apps/desktop/scripts/model-picker-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch REALM_HOME and proves what a jsdom
 * test cannot, because each is a question about LAYOUT:
 *
 *  - the popover is one compact column — no detail pane beside the list;
 *  - every model is one line, and the five effort levels fit one row without truncating;
 *  - the strip under the list keeps ONE height whatever the highlighted model says, so the rows above
 *    it never move under the pointer (the popover grows upward from the chip);
 *  - the current model is in view the moment the list opens, however far down it is;
 *  - a model with several harnesses carries them on its row and the row still fits;
 *  - fast mode is on the surface for a brand-new Claude session, honest about what is known, and
 *    Codex's Fast tier is offered per model from the probe's catalog before anything has run.
 *
 * No real agent is ever asked anything. Every CLI is a stub: Claude answers `--version` and
 * `auth status`, Codex is the adapter's own fake app-server fixture, and the ACP agents are either
 * absent (the owner's Mac) or the fake ACP agent fixture (the long list, all thirteen installed).
 * No prompt is sent, so no session starts and nothing is billed.
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

/** The stub CLIs. `acp` decides whether the ACP agents are installed (the fake ACP agent) or not. */
function stubs(dir, { acp }) {
  fs.mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); return p; };
  const claude = write("claude", `#!/bin/bash\ncase "$1" in\n  --version) echo "2.1.281 (Claude Code)";;\n  auth) echo '{"loggedIn": true}';;\n  *) exit 1;;\nesac\n`);
  const fakeCodex = path.join(repoRoot, "packages/adapters/src/codex/fixtures/fake-codex-server.mjs");
  const codex = write("codex", `#!/bin/bash\ncase "$1" in\n  login) echo "Logged in using ChatGPT";;\n  *) exec "${node}" "${fakeCodex}" "$@";;\nesac\n`);
  const fakeAcp = path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs");
  const agent = acp
    ? write("acp-agent", `#!/bin/bash\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\nexec "${node}" "${fakeAcp}" "$@"\n`)
    : path.join(dir, "not-installed");
  return {
    REALM_CLAUDE_BIN: claude, REALM_CODEX_BIN: codex,
    ...Object.fromEntries(["CURSOR", "GEMINI", "OPENCODE", "COPILOT", "GOOSE", "QWEN", "GROK", "FX", "DEEPSEEK", "OPENHANDS", "HERMES"]
      .map((k) => [`REALM_${k}_BIN`, agent])),
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

/** The picker and its chip in one frame, with a margin of the surface around them. */
async function shootPicker(c, name) {
  const p = await box(c, ".model-picker"), k = await box(c, '.composer button[aria-label="Model"]');
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
  const k = await box(c, '.composer button[aria-label="Model"]');
  const at = { x: k.x + k.width / 2, y: k.y + k.height / 2 };
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
  await until(() => evalIn(c, `(() => { const p = document.querySelector('.model-picker'); return !!p && getComputedStyle(p).visibility === 'visible'; })()`), 5000, "picker");
  await sleep(350); // the arrival spring
};
const closePicker = async (c) => {
  await evalIn(c, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
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

/** Picks a row the way a person does — a click — so the renderer makes the change, not the daemon. */
const pickRow = async (c, label) => {
  await openPicker(c);
  const ok = await evalIn(c, `(() => { const o = [...document.querySelectorAll('.mp-row')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!o) return false; o.click(); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('.model-picker')`), 3000, "picker closed after a pick").catch(() => null);
  await sleep(500);
  return ok;
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
  const seg = [...document.querySelectorAll('.mp-seg-group[aria-label="Effort"] .mp-seg-opt')];
  return {
    picker: r(picker), win: { w: innerWidth, h: innerHeight },
    detailPane: !!document.querySelector('.mp-detail'),
    rows: rows.length,
    rowHeights: [...new Set(rows.map((o) => Math.round(o.getBoundingClientRect().height)))],
    overflowingRows: rows.filter((o) => o.scrollWidth > o.clientWidth + 1).map((o) => o.getAttribute('aria-label')),
    currentInView: !!cb && cb.top >= lb.top - 1 && cb.bottom <= lb.bottom + 1,
    current: current?.getAttribute('aria-label') ?? null,
    effort: seg.map((b) => b.textContent),
    effortLines: [...new Set(seg.map((b) => Math.round(b.getBoundingClientRect().top)))].length,
    effortTruncated: seg.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent),
    listScrolls: list.scrollHeight > list.clientHeight + 2,
    dissolve: list.getAttribute('data-dissolve'),
  };
})()`);

const aboutBox = (c) => evalIn(c, `(() => { const a = document.querySelector('.mp-about'), l = document.querySelector('.mp-list');
  return { h: Math.round(a.getBoundingClientRect().height), listTop: Math.round(l.getBoundingClientRect().top),
    note: document.querySelector('.mp-about-note')?.textContent ?? '', specs: document.querySelector('.mp-about-specs')?.textContent ?? '' }; })()`);

const fastRow = (c) => evalIn(c, `(() => { const g = document.querySelector('.mp-fast'); if (!g) return null;
  const s = g.querySelector('[role=switch]');
  return { state: g.dataset.state, switch: !!s, on: !!s?.checked, text: g.textContent, note: g.querySelector('.mp-fast-note')?.textContent ?? null }; })()`);

/** The owner's Mac: Claude signed in, Codex installed, no ACP agents. A brand-new Claude session. */
async function owner() {
  const { c, api, home, sessionId } = await boot(stubs(path.join(scratch, "bin-owner"), { acp: false }), "owner");
  try {
    await setTheme(c, api, "dark");
    for (const mode of ["dark", "light"]) {
      if (mode === "light") await setTheme(c, api, "light");
      const chip = await evalIn(c, `(() => { const b = document.querySelector('.composer button[aria-label="Model"]'); return { text: b.textContent, title: b.title }; })()`);
      check(`${mode}: the chip names the model the way the list does, and the harness in its tooltip`, chip.text.includes("Fable 5.1") && chip.title === "Claude Fable 5.1 through Claude", chip);
      await openPicker(c);
      const l = await layout(c);
      check(`${mode}: one compact column, no detail pane`, !l.detailPane && l.picker.w >= 360 && l.picker.w <= 380, { w: l.picker.w });
      check(`${mode}: inside the window`, l.picker.x >= 0 && l.picker.y >= 0 && l.picker.x + l.picker.w <= l.win.w && l.picker.y + l.picker.h <= l.win.h, l.picker);
      check(`${mode}: every row is one line and nothing in a row overflows it`, l.rowHeights.length === 1 && l.rowHeights[0] === 32 && l.overflowingRows.length === 0, { heights: l.rowHeights, overflowing: l.overflowingRows });
      check(`${mode}: the current model is ticked and in view`, l.current === "Claude Fable 5.1" && l.currentInView, { current: l.current });
      check(`${mode}: five effort levels on one line, none cut`, l.effort.length === 5 && l.effortLines === 1 && l.effortTruncated.length === 0, l);
      const fast = await fastRow(c);
      check(`${mode}: fast mode is on the surface for a brand-new session, and says the first turn checks it`, fast?.state === "unknown" && fast.switch && fast.note === "Checked on the first turn.", fast);
      await shootPicker(c, `after-${mode}-picker`);
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
      }
      await closePicker(c);
    }

    // The switch, flipped before the first message: the chip wears the bolt for the request.
    await openPicker(c);
    await evalIn(c, `document.querySelector('.mp-fast [role=switch]').click(); true`);
    await until(async () => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.id === sessionId)?.fastMode === true, 5000, "fast saved");
    check("flipping it keeps the picker open", await evalIn(c, `!!document.querySelector('.model-picker')`));
    await closePicker(c);
    const bolt = await evalIn(c, `!!document.querySelector('.composer .model-chip .chip-fast')`);
    check("the chip wears the bolt for the request", bolt);
    const k = await box(c, '.composer button[aria-label="Model"]');
    await shoot(c, "after-light-chip-fast", { x: k.x - 140, y: k.y - 12, width: k.width + 160, height: k.height + 24 });
    await api.call("sessions.setOptions", { id: sessionId, fastMode: false });

    // What one earlier Claude session would have filed for every model Claude lists.
    await api.call("settings.set", { key: "models.fastSupport", value: { "claude:": false, "claude:claude-fable-5-1": false, "claude:claude-opus-5-5": true, "claude:claude-sonnet-5": true } });
    for (const mode of ["light", "dark"]) {
      if (mode === "dark") await setTheme(c, api, "dark"); else await reload(c);
      await openPicker(c);
      const no = await fastRow(c);
      check(`${mode}: on a model Claude said cannot, no switch, and the ones that can by name`,
        no?.state === "unavailable" && !no.switch && /Not on Fable 5\.1/.test(no.text) && no.note === "Opus 5.5 and Sonnet 5 offer it.", no);
      await shootPicker(c, `after-${mode}-fast-unavailable`);
      await closePicker(c);
    }
    check("Opus 5.5 is a row to pick", await pickRow(c, "Claude Opus 5.5"));
    await openPicker(c);
    const yes = await fastRow(c);
    check("on a model Claude said can, a plain switch with nothing left to check", yes?.state === "offered" && yes.switch && yes.note === null, yes);
    const l = await layout(c);
    check("the newly picked model is the ticked one", l.current === "Claude Opus 5.5", { current: l.current });
    await shootPicker(c, "after-dark-fast-offered");
    await closePicker(c);

    // Codex, before any session has run on it: the Fast tier from the probe's own catalog.
    check("Codex's default is one click from a Claude session that has not run", await pickRow(c, "GPT-5.6"));
    await until(() => evalIn(c, `document.querySelector('.composer button[aria-label="Model"]').textContent.includes('GPT-5.6')`), 5000, "codex chip");
    await openPicker(c);
    const codexDefault = await fastRow(c);
    const codexEffort = await evalIn(c, `!!document.querySelector('.mp-seg-group[aria-label="Effort"]')`);
    check("Codex's default offers Fast from the catalog, and no effort control Codex would drop", codexDefault?.state === "offered" && !codexEffort, { fast: codexDefault, effort: codexEffort });
    await closePicker(c);
    check("GPT-5.6-Terra is a row to pick", await pickRow(c, "GPT-5.6-Terra"));
    await openPicker(c);
    const terra = await fastRow(c);
    check("a Codex model without the tier says so, and names the one that has it", terra?.state === "unavailable" && terra.note === "GPT-5.6-Sol offers it.", terra);
    await shootPicker(c, "after-dark-codex");
    await closePicker(c);

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

    // An agent that reports no models: its own group, its default ticked, nothing it cannot take.
    check("OpenHands is one row among the other agents", await pickRow(c, "OpenHands"));
    await until(() => evalIn(c, `document.querySelector('.composer button[aria-label="Model"]').textContent.includes('Default')`), 5000, "openhands chip");
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

process.on("SIGINT", () => { void stop(null).then(() => process.exit(130)); });
try {
  await owner();
  await longList();
} catch (e) {
  console.error("ERROR", e.message);
  process.exitCode = 1;
  await stop(null);
} finally {
  if (!process.env.LIVE_SHOTS) console.log(`screenshots in ${shots}`);
  fs.rmSync(path.join(scratch, "owner-home"), { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "long-home"), { recursive: true, force: true });
}
