/**
 * Live check for Code review's Review with… control (run with: pnpm build && node apps/desktop/scripts/code-review-button-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch home, with the fake gh on the
 * fixture requests and the scripted agent standing in for Claude and Codex under their own names
 * (REALM_FAKE_STANDS_IN): the reviewer is "Claude", wears Claude's mark and plays the fixture's
 * review, and nothing is billed. What it proves is layout and the real pointer, which jsdom cannot:
 *
 *   1. one shape — the chevron sits in the body's end past a seam, the body is the one painted
 *      surface, and a press either side of the seam lands on its own target;
 *   2. hover per part — the body lights whole, the chevron its own disc with the body at rest;
 *   3. the keyboard — Tab reaches the body, then the chevron, each with its own ring;
 *   4. the menu — the chevron opens how to review, its model chip opens the prompter's own picker over
 *      it with every row under its harness's mark, a pick leaves the menu up, and Escape puts the
 *      picker away before the menu;
 *   5. running — "Reviewing…" under the reviewer's mark, the chevron still live and its menu's Save
 *      and run waiting with its reason; then the findings, each under the reviewer's mark;
 *   6. disabled — a request that changes no files, and one that could not be read;
 *
 * with screenshots of each, in both faces, under LIVE_OUT.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8815 / 9255). It touches only its own scratch home and
 * kills only what holds its own two ports. Every agent binary is a stub or absent, so no real CLI is
 * started, and REALM_ENABLE_FAKE_AGENT turns the server's own billed title and recap off.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { buildFixture } from "../../server/scripts/fixtures/code-review-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9255);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8815);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-code-review-button-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_TMP ?? OUT_DIR, "run-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = "Stream the tokenizer instead of buffering its input";
let electron = null;
let api = null;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/* The fake gh on the fixture, signed in from the start: the setup page is code-review-live's. */
const ghDir = path.join(scratch, "gh");
fs.mkdirSync(ghDir, { recursive: true });
const fixturePath = path.join(ghDir, "fixture.json");
fs.writeFileSync(fixturePath, JSON.stringify({ ...buildFixture(), auth: "ready" }));
const ghBin = path.join(ghDir, "gh");
fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${path.join(ghDir, "calls.jsonl")}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`);
fs.chmodSync(ghBin, 0o755);

/** Claude and Codex answer as installed and signed in, should anything ask their binaries; the
 *  sessions themselves run on the scripted agent standing in for them. Every other agent is absent. */
function stubs() {
  const dir = path.join(scratch, "bin");
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); return p; };
  const claude = write("claude", `#!/bin/bash\ncase "$1" in\n  --version) echo "2.1.281 (Claude Code)";;\n  auth) echo '{"loggedIn": true}';;\n  *) exit 1;;\nesac\n`);
  const codex = write("codex", `#!/bin/bash\ncase "$1" in\n  --version) echo "codex-cli 0.146.0";;\n  login) echo "Logged in using ChatGPT";;\n  *) exit 1;;\nesac\n`);
  const absent = path.join(dir, "not-installed");
  return {
    REALM_CLAUDE_BIN: claude, REALM_CODEX_BIN: codex,
    ...Object.fromEntries(["CURSOR", "GEMINI", "OPENCODE", "COPILOT", "GOOSE", "QWEN", "GROK", "FX", "DEEPSEEK", "OPENHANDS", "HERMES"].map((k) => [`REALM_${k}_BIN`, absent])),
  };
}

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
    await sleep(100);
  }
}

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  return { ws, ready, pending, errors, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready, errors: s.errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(String(i), (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel, root = document) => root.querySelector(sel),
  qa: (sel, root = document) => [...root.querySelectorAll(sel)],
  set(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  rect(el) { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; },
  dialog(name) { return document.querySelector('[role=dialog][aria-label="' + name + '"]'); },
  row(title) { return [...document.querySelectorAll('.cr-row')].find((r) => r.querySelector('.cr-row-title')?.textContent === title) ?? null; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(c, tag, clip) {
  const params = { format: "png", ...(clip ? { clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: clip.width, height: clip.height, scale: 2 } } : {}) };
  const r = await c.send("Page.captureScreenshot", params);
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

/** The box round some elements, with a margin — what a screenshot of them crops to. */
const around = (c, sels, pad = 20) => evalIn(c, `(() => {
  const rs = ${JSON.stringify(sels)}.map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
  const x = Math.min(...rs.map((r) => r.left)) - ${pad}, y = Math.min(...rs.map((r) => r.top)) - ${pad};
  return { x, y, width: Math.max(...rs.map((r) => r.right)) + ${pad} - x, height: Math.max(...rs.map((r) => r.bottom)) + ${pad} - y };
})()`);
/** The control alone, and the bar's end around it — Submit review beside it is the painted neighbour. */
const barClip = (c) => around(c, [".cr-review-with", ".cr-submit"], 14);

/* A real pointer and real keys, so hover, press and focus are the browser's own. */
const moveTo = (c, x, y) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
async function clickAt(c, x, y) {
  await moveTo(c, x, y);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
const KEYS = { Tab: 9, Enter: 13, Escape: 27 };
async function key(c, k, shift = false) {
  const mods = shift ? 8 : 0;
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, modifiers: mods, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
  if (k === "Enter") await c.send("Input.dispatchKeyEvent", { type: "char", key: k, text: "\r", unmodifiedText: "\r", modifiers: mods });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, modifiers: mods, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] });
}
/** Somewhere a pointer rests on nothing: the request's title. */
const rest = async (c) => { const t = await evalIn(c, `__live.rect(__live.q('.cr-title') ?? __live.q('.cr-empty'))`); await moveTo(c, t.x + 4, t.y + t.height / 2); await sleep(450); };
const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Everything about the control a screenshot is evidence for. */
const control = (c) => evalIn(c, `(() => {
  const g = __live.q('.cr-review-with'), body = g.querySelector('.cr-review-run'), more = g.querySelector('.cr-review-more');
  const bs = getComputedStyle(body), ms = getComputedStyle(more), seam = getComputedStyle(more, '::before');
  const b = __live.rect(body), m = __live.rect(more);
  const seamX = m.x + parseFloat(seam.left);
  const hit = (x) => document.elementFromPoint(x, b.y + b.height / 2)?.closest('button');
  return {
    body: b, more: m, seamX, seamTop: parseFloat(seam.top), seamBottom: parseFloat(seam.bottom), seamW: seam.width, ringW: getComputedStyle(document.documentElement).getPropertyValue('--hairline-w').trim(),
    painted: bs.backgroundImage.includes('paint('), bodyFill: bs.getPropertyValue('--sq-fill').trim(), moreFill: ms.backgroundColor,
    opacity: bs.opacity, labelOpacity: getComputedStyle(body.querySelector('.cr-review-label')).opacity,
    label: body.textContent, disabled: body.disabled, busy: body.getAttribute('aria-busy'), mark: body.querySelector('svg[data-brand]')?.getAttribute('data-brand') ?? null,
    title: body.getAttribute('title') || body.getAttribute('aria-description'), moreDisabled: more.disabled, expanded: more.getAttribute('aria-expanded'),
    hitRight: hit(seamX + 2) === more, hitLeft: hit(seamX - 3) === body, hitEnd: hit(b.right - 1) === more,
    fits: (() => { const bar = __live.q('.cr-bar'); return bar.scrollWidth <= bar.clientWidth + 1; })(),
  };
})()`);

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, ...stubs(),
      REALM_HOME: home, REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_GH_BIN: ghBin,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  // Onboarding makes the space. Its first session is never typed into.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // The reviewer and the question box both start on the last-used agent: Claude, standing in.
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "claude" });
  await until(async () => (await api.call("agents.probe", { force: false })).some((p) => p.kind === "codex" && p.models?.length), 30_000, "the stand-ins' probe");
  await reload(c);
  return c;
}

async function reload(c) {
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.app-rail')`), 30_000, "reload");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // A live window opens behind the person's own and greys its accent; hold it key.
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await sleep(800);
}

async function openPage(c) {
  await evalIn(c, `(() => { const b = [...document.querySelectorAll('.app-rail button')].find((x) => x.getAttribute('aria-label') === 'Code review');
    if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
  await until(() => evalIn(c, `__live.qa('.cr-row').length >= 3`), 20_000, "the column");
}
async function openRequest(c, title) {
  await evalIn(c, `(__live.row(${JSON.stringify(title)}).click(), true)`);
  await until(() => evalIn(c, `__live.q('.cr-title')?.textContent === ${JSON.stringify(title)} && !!__live.q('.cr-review-with')`), 15_000, `request ${title}`);
  await sleep(500);
}
/** A request by its link, pasted in the column's search, as a person reaches one in no list. */
async function openLink(c, link, settled) {
  await evalIn(c, `(() => { const i = __live.q('.cr-col-search input'); i.focus(); return __live.set(i, ${JSON.stringify(link)}); })()`);
  await sleep(200);
  await key(c, "Enter");
  await until(() => evalIn(c, settled), 15_000, `link ${link}`);
  await evalIn(c, `(() => { const i = __live.q('.cr-col-search input'); __live.set(i, ''); i.blur(); return true; })()`);
  await sleep(500);
}

async function openMenu(c) {
  const k = await control(c);
  await clickAt(c, k.more.x + k.more.width / 2, k.more.y + k.more.height / 2);
  await until(() => evalIn(c, `(() => { const d = __live.dialog('Review instructions'); return !!d && getComputedStyle(d).visibility === 'visible' && !d.querySelector('textarea').disabled; })()`), 10_000, "the menu");
  await sleep(350); // the arrival spring
}
async function openPicker(c) {
  const chip = await evalIn(c, `__live.rect(__live.dialog('Review instructions').querySelector('button[aria-label="Model"]'))`);
  await clickAt(c, chip.x + chip.width / 2, chip.y + chip.height / 2);
  await until(() => evalIn(c, `(() => { const p = __live.q('.model-picker'); return !!p && getComputedStyle(p).visibility === 'visible'; })()`), 10_000, "the picker");
  await sleep(350);
}
/** A real click on a picker row, by its accessible name. */
async function pickRow(c, label) {
  const r = await evalIn(c, `(() => { const o = __live.qa('.mp-row').find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!o) return null; o.scrollIntoView({ block: 'nearest' }); return __live.rect(o); })()`);
  if (!r) return false;
  await clickAt(c, r.x + 40, r.y + r.height / 2);
  await sleep(400);
  return true;
}
const surfaces = (c) => evalIn(c, `({ menu: !!__live.dialog('Review instructions') && !__live.dialog('Review instructions').hasAttribute('data-closing'),
  picker: !!__live.q('.model-picker') && !__live.q('.model-picker').hasAttribute('data-closing') })`);
/** Puts away whatever is up, with real Escapes to whatever holds the keyboard. */
async function closeAll(c) {
  for (let i = 0; i < 3 && Object.values(await surfaces(c)).some(Boolean); i++) { await key(c, "Escape"); await sleep(300); }
}

/** The control in all its resting and pointer states, in one face. */
async function states(c, face) {
  await rest(c);
  let k = await control(c);
  check(`${face}: one shape — the chevron sits inside the body's end, and the body is the painted surface`,
    k.painted && k.more.right <= k.body.right - 2 && k.more.x > k.body.x + k.body.width / 2 && Math.round(k.more.height) === 24 && Math.round(k.body.height) === 30, k);
  check(`${face}: the seam is a hairline — the ring's width — inset from both ends, 3px before the disc`,
    Math.round(k.more.x - k.seamX) === 3 && k.seamTop > 0 && k.seamBottom > 0 && parseFloat(k.seamW) === parseFloat(k.ringW), { seamX: k.seamX, more: k.more.x, top: k.seamTop, bottom: k.seamBottom, w: k.seamW, ring: k.ringW });
  check(`${face}: a press either side of the seam lands on its own target, and the chevron's reaches the body's end`, k.hitLeft && k.hitRight && k.hitEnd, k);
  check(`${face}: at rest it reads Review with Fable 5.1 under Claude's mark`, k.label === "Review with Fable 5.1" && k.mark === "claude" && !k.disabled, k);
  check(`${face}: the bar fits its pane`, k.fits);
  const restFill = k.bodyFill;
  await shot(c, `${face}-01-rest`, await barClip(c));

  // The body under the pointer: the whole shape lights; the disc stays clear.
  await moveTo(c, k.body.x + 40, k.body.y + k.body.height / 2);
  await sleep(120);
  const onBody = await control(c);
  check(`${face}: hovering the body lights the whole shape and not the disc`, onBody.bodyFill !== restFill && onBody.moreFill === "rgba(0, 0, 0, 0)", { rest: restFill, hover: onBody.bodyFill, disc: onBody.moreFill });
  await shot(c, `${face}-02-hover-body`, await barClip(c));

  // The chevron under the pointer: its disc lights, and the body is at rest.
  await rest(c);
  await moveTo(c, k.more.x + k.more.width / 2, k.more.y + k.more.height / 2);
  await sleep(120);
  const onMore = await control(c);
  check(`${face}: hovering the chevron lights its disc and leaves the body at rest`, onMore.bodyFill === restFill && onMore.moreFill !== "rgba(0, 0, 0, 0)", { body: onMore.bodyFill, disc: onMore.moreFill });
  await shot(c, `${face}-03-hover-chevron`, await barClip(c));
  await sleep(400);
  const tip = await evalIn(c, `(() => { const t = __live.q('.tooltip[data-open]'); return t ? t.textContent : null; })()`);
  check(`${face}: the chevron's tooltip says what it opens`, tip === "How to review — the model and your instructions", tip);
  await shot(c, `${face}-04-chevron-tooltip`, await around(c, [".cr-review-with", ".tooltip[data-open]"], 14));

  // The keyboard: from the link before it, Tab is the body, then the chevron, each ringed.
  await rest(c);
  await evalIn(c, `(__live.q('.cr-bar a[aria-label="Open on GitHub"]').focus(), true)`);
  await key(c, "Tab");
  await sleep(450); // the ring draws in
  const f1 = await evalIn(c, `(() => { const a = document.activeElement; return { body: a?.classList.contains('cr-review-run'), visible: a?.matches(':focus-visible'),
    ring: getComputedStyle(a).getPropertyValue('--sq-ring-w').trim() }; })()`);
  check(`${face}: Tab reaches the body first, with the painted ring`, f1.body && f1.visible && f1.ring === "2px", f1);
  await shot(c, `${face}-05-focus-body`, await barClip(c));
  await key(c, "Tab");
  await sleep(450);
  const f2 = await evalIn(c, `(() => { const a = document.activeElement; const s = getComputedStyle(a); return { more: a?.classList.contains('cr-review-more'), visible: a?.matches(':focus-visible'),
    outline: s.outlineStyle + ' ' + s.outlineWidth, offset: s.outlineOffset }; })()`);
  check(`${face}: the next Tab is the chevron, ringed inside its own disc`, f2.more && f2.visible && f2.outline === "solid 2px" && f2.offset === "-2px", f2);
  await shot(c, `${face}-06-focus-chevron`, await barClip(c));
  // Return on the chevron opens the menu from the keyboard.
  await key(c, "Enter");
  await until(() => evalIn(c, `!!__live.dialog('Review instructions')`), 10_000, "the menu from the keyboard");
  check(`${face}: Return on the chevron opens the menu`, (await control(c)).expanded === "true");
  await sleep(400);
  await closeAll(c);
}

/** The menu and the picker over it, a pick, and Escape's order. */
async function menu(c, face) {
  await rest(c);
  await openMenu(c);
  check(`${face}: the open menu lights the chevron's disc`, (await control(c)).moreFill !== "rgba(0, 0, 0, 0)");
  const row = await evalIn(c, `(() => { const chip = __live.dialog('Review instructions').querySelector('button[aria-label="Model"]');
    return { mark: chip?.querySelector('svg[data-brand]')?.getAttribute('data-brand') ?? null, label: chip?.querySelector('.chip-label')?.textContent ?? null }; })()`);
  check(`${face}: the menu's model is the prompter's chip, Claude's mark beside Fable 5.1`, row.mark === "claude" && row.label === "Fable 5.1", row);
  await rest(c);
  await shot(c, `${face}-07-menu`, await around(c, [".cr-review-with", '[role=dialog][aria-label="Review instructions"]'], 16));
  await openPicker(c);
  const list = await evalIn(c, `(() => ({
    groups: __live.qa('.model-picker .mp-group').map((g) => g.getAttribute('aria-label')),
    rows: __live.qa('.model-picker .mp-row').map((r) => ({ name: r.getAttribute('aria-label'), mark: r.querySelector('.mp-row-mark')?.getAttribute('data-brand') ?? (r.querySelector('.mp-row-mark') ? 'glyph' : null) })),
  }))()`);
  check(`${face}: the picker lists the reviewers' models, every row under its harness's mark`,
    list.rows.length > 6 && list.rows.every((r) => r.mark !== null) && list.rows.some((r) => r.mark === "claude") && list.rows.some((r) => r.mark === "openai")
      && !list.groups.some((g) => /Cursor|Gemini|Other agents/.test(g ?? "")), list);
  await shot(c, `${face}-08-menu-picker`, await around(c, [".cr-review-with", '[role=dialog][aria-label="Review instructions"]', ".model-picker"], 16));
  // A pick leaves the menu up, and the body takes the model and its mark.
  check(`${face}: GPT-6 Luna is a row to pick`, await pickRow(c, "GPT-6 Luna"));
  const after = await surfaces(c);
  const k = await control(c);
  check(`${face}: the pick leaves the menu up`, after.menu, after);
  check(`${face}: the body reads Review with GPT-6 Luna under Codex's mark`, k.label === "Review with GPT-6 Luna" && k.mark === "openai", k);
  // Escape: the picker first, the menu on the next.
  if (!after.picker) await openPicker(c);
  await key(c, "Escape");
  await sleep(350);
  const one = await surfaces(c);
  check(`${face}: Escape puts the picker away and leaves the menu`, !one.picker && one.menu, one);
  await key(c, "Escape");
  await sleep(350);
  const two = await surfaces(c);
  check(`${face}: the next Escape puts the menu away`, !two.picker && !two.menu, two);
  await rest(c);
  await shot(c, `${face}-09-picked-codex`, await barClip(c));
  // Back to Claude for the run.
  await openMenu(c);
  await openPicker(c);
  await pickRow(c, "Claude Fable 5.1");
  await closeAll(c);
  check(`${face}: back on Fable 5.1 under Claude's mark`, (await control(c)).mark === "claude");
}

/** A review, running and then done. */
async function running(c, face) {
  const k = await control(c);
  await clickAt(c, k.body.x + 40, k.body.y + k.body.height / 2);
  const busy = await until(async () => { const s = await control(c); return s.busy === "true" ? s : null; }, 5000, "running").catch(() => null);
  check(`${face}: pressed, the body is the review running: Reviewing… under Claude's mark, busy`, busy?.label === "Reviewing…" && busy.mark === "claude" && busy.disabled, busy);
  await rest(c);
  await shot(c, `${face}-10-running`, await barClip(c));
  const s = await control(c);
  check(`${face}: while it runs the chevron stays live`, s.busy === "true" ? !s.moreDisabled : true, { busy: s.busy, chevronDisabled: s.moreDisabled });
  if (s.busy === "true") {
    await openMenu(c);
    const run = await evalIn(c, `(() => { const b = [...__live.dialog('Review instructions').querySelectorAll('button')].find((x) => x.textContent === 'Save and run');
      return { disabled: b.disabled, title: b.getAttribute('title') }; })()`);
    check(`${face}: …its menu opens, and Save and run waits with its reason`, run.disabled && /is running/.test(run.title ?? ""), run);
    await shot(c, `${face}-11-running-menu`, await around(c, [".cr-review-with", '[role=dialog][aria-label="Review instructions"]'], 16));
    await closeAll(c);
  } else console.log(`INFO ${face}: the review finished before the menu could be opened over it`);
  await until(() => evalIn(c, `!!__live.q('.cr-review[data-state=done]')`), 30_000, "findings");
  await sleep(500);
  const done = await control(c);
  check(`${face}: done, the body is Review with Fable 5.1 again`, done.label === "Review with Fable 5.1" && !done.disabled, done);
  const head = await evalIn(c, `(() => { const h = __live.q('.cr-review-head'); return { text: h.querySelector('.cr-review-title').textContent, mark: h.querySelector('svg[data-brand]')?.getAttribute('data-brand') ?? null }; })()`);
  check(`${face}: the summary's run is headed by Claude's mark and Review by Fable 5.1`, head.text === "Review by Fable 5.1" && head.mark === "claude", head);
  await shot(c, `${face}-12-review-panel`, await around(c, [".cr-review"], 12));
}

async function findings(c, face) {
  await evalIn(c, `(() => { const l = [...document.querySelectorAll('.cr-tabs .seg-opt')].find((x) => x.textContent.startsWith('Changes')); l.querySelector('input').click(); return true; })()`);
  await until(() => evalIn(c, `__live.qa('.cr-note').length >= 2`), 15_000, "inline findings");
  await evalIn(c, `(() => { __live.q('.cr-file[data-file="src/tokenizer.ts"] .cr-note').scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(400);
  const by = await evalIn(c, `__live.qa('.cr-note:not([data-own]) .cr-note-by').map((b) => ({ text: b.textContent, mark: b.querySelector('svg[data-brand]')?.getAttribute('data-brand') ?? null }))`);
  check(`${face}: each finding under its line is headed by Claude's mark and Fable 5.1`, by.length >= 2 && by.every((b) => b.text === "Fable 5.1" && b.mark === "claude"), by);
  await shot(c, `${face}-13-finding`, await around(c, ['.cr-file[data-file="src/tokenizer.ts"] .cr-note'], 24));
  const ask = await evalIn(c, `(() => { const chip = __live.q('.cr-ask .composer button[aria-label="Model"]');
    return { mark: chip?.querySelector('svg[data-brand]')?.getAttribute('data-brand') ?? null, label: chip?.querySelector('.chip-label')?.textContent ?? null }; })()`);
  check(`${face}: the Ask box names its model beside Claude's mark`, ask.mark === "claude" && ask.label === "Fable 5.1", ask);
  await shot(c, `${face}-14-ask-box`, await around(c, [".cr-ask"], 12));
  await evalIn(c, `(() => { const l = [...document.querySelectorAll('.cr-tabs .seg-opt')].find((x) => x.textContent.startsWith('Summary')); l.querySelector('input').click(); return true; })()`);
  await sleep(400);
}

async function disabled(c, face) {
  await openLink(c, "acme/widgets#43", `__live.q('.cr-title')?.textContent === 'Bring the release branch up to date'`);
  await rest(c);
  const k = await control(c);
  check(`${face}: a request that changes no files cannot be reviewed, and says why; its chevron still opens`,
    k.disabled && k.title === "This pull request changes no files, so there is nothing to review" && !k.moreDisabled && k.label === "Review with Fable 5.1", k);
  check(`${face}: disabled, the body keeps its fill and ring and greys only its words`, k.painted && k.opacity === "1" && k.labelOpacity === "0.45", { opacity: k.opacity, label: k.labelOpacity, fill: k.bodyFill });
  await shot(c, `${face}-15-disabled-no-diff`, await barClip(c));
  await moveTo(c, k.body.x + 40, k.body.y + k.body.height / 2);
  await sleep(700);
  const tip = await evalIn(c, `(() => { const t = __live.q('.tooltip[data-open]'); return t ? t.textContent : null; })()`);
  check(`${face}: …and its tooltip says so under the pointer`, tip === "This pull request changes no files, so there is nothing to review", tip);
  await shot(c, `${face}-16-disabled-tooltip`, await around(c, [".cr-review-with", ".tooltip[data-open]"], 14));
  await openLink(c, "acme/widgets#999", `!!__live.q('.cr-empty-title') && __live.q('.cr-empty-title').textContent.includes('could not be read')`);
  await rest(c);
  const gone = await control(c);
  check(`${face}: a request that could not be read cannot be reviewed either`, gone.disabled && gone.title === "Nothing to review until the pull request has been read", gone);
  await shot(c, `${face}-17-disabled-unread`, await barClip(c));
}

async function narrow(c, face) {
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1020, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  const k = await evalIn(c, `(() => { const b = __live.q('.cr-review-run'), l = b.querySelector('.cr-review-label'), m = l.querySelector('.cr-review-model');
    return { width: Math.round(b.getBoundingClientRect().width), cut: l.scrollWidth > l.clientWidth + 1, model: m ? Math.round(m.getBoundingClientRect().width) : null,
      main: Math.round(__live.q('.cr-main').getBoundingClientRect().width), text: b.textContent,
      inside: __live.q('.cr-review-more').getBoundingClientRect().right <= b.getBoundingClientRect().right }; })()`);
  check(`${face}: narrow, the body keeps its verb beside the mark and gives the model's name to the tooltip — nothing cut mid-word`,
    k.main < 720 && !k.cut && k.model !== null && k.model <= 1 && k.inside && k.text === "Review with Fable 5.1", k);
  await shot(c, `${face}-18-narrow`, await around(c, [".cr-bar"], 6));
  const body = await evalIn(c, `__live.rect(__live.q('.cr-review-run'))`);
  await moveTo(c, body.x + 30, body.y + body.height / 2);
  await sleep(700);
  const tip = await evalIn(c, `(() => { const t = __live.q('.tooltip[data-open]'); return t ? t.textContent : null; })()`);
  check(`${face}: …and its tooltip names the model`, /Fable 5\.1/.test(tip ?? ""), tip);
  await shot(c, `${face}-19-narrow-tooltip`, await around(c, [".cr-review-with", ".tooltip[data-open]"], 14));
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await rest(c);
}

async function main() {
  const c = await boot();
  for (const face of ["dark", "light"]) {
    if (face === "light") {
      await api.call("settings.set", { key: "ui.theme", value: "light" });
      await reload(c);
      check("the window is in light mode", (await evalIn(c, `document.documentElement.dataset.mode`)) === "light");
    }
    await openPage(c);
    await openRequest(c, TITLE);
    await states(c, face);
    await menu(c, face);
    await running(c, face);
    await findings(c, face);
    await narrow(c, face);
    await disabled(c, face);
    await evalIn(c, `(() => { const b = [...document.querySelectorAll('.app-rail button')].find((x) => x.getAttribute('aria-label') === 'Code review');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); return true; })()`);
    await sleep(500);
  }
  const errs = c.errors.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

const stop = async () => {
  try { await api?.call("daemon.stop", {}); } catch {}
  try { api?.close(); } catch {}
  electron?.kill("SIGTERM");
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch {}
  await stopDaemons(home);
  killPort(SERVER_PORT); killPort(CDP_PORT);
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void stop().then(() => process.exit(130)); });

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => { await stop(); process.exit(process.exitCode ?? 0); });
