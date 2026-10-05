/**
 * Live check for Select in Realm, the element picker over Realm's own window
 * (run with: pnpm build && node apps/desktop/scripts/app-picker-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for Claude
 * (REALM_FAKE_STANDS_IN), so nothing reaches a real engine, and drives it with real input over CDP —
 * pointer moves and presses, and the chord — because the picker IS the input path. Checks:
 *
 *   1. The + menu's Select in Realm puts the picker up with its hint; hovering the send button
 *      outlines it in the web picker's language, named "Send button" by the component that drew it;
 *      the press picks it without sending, and the chip and its picture land in the prompter.
 *   2. ⌘⇧C does the same from a sidebar row, and from a switch on the Settings page.
 *   3. A browser pane: its own bar is pickable and its picture stops at the page's edge; main refuses
 *      to capture over the page's native view at all; and the page keeps the web picker — a click in
 *      it lands the page's element in the same prompter.
 *   4. Sent to the scripted agent, which echoes what it was handed: every chip's description, and the
 *      pictures on the message as image attachments.
 *
 * Ports: LIVE_SERVER_PORT (8808), LIVE_CDP_PORT (9248), LIVE_MAIN_INSPECT_PORT (9258), LIVE_SITE_PORT
 * (8818). Screenshots and the pictures go to LIVE_OUT_DIR, the scratch home to LIVE_SCRATCH_DIR (both
 * the system temp dir unless set). Kills only what listens on its own ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8808);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9248);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9258);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8818);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-app-picker-live-"));
const home = path.join(scratch, "home");
const OUT = (tag) => path.join(OUT_DIR, `app-picker-${tag}.png`);
const TITLE = "Polish the prompter";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;

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

/** A page for the browser pane: one button worth pointing at. */
function startSite() {
  const body = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
    <style>body { font: 16px -apple-system, sans-serif; margin: 48px; background: #fff; color: #111; }
    button { font: inherit; padding: 10px 18px; border-radius: 10px; border: 1px solid #ccc; background: #f4f4f5; }</style>
    <h1>Welcome back</h1><p>Sign in to continue.</p><button id="submit" type="button">Sign in</button>`;
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(body); });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** The React tree's store, found through the root's fiber — a harness's reach, used only to READ the
 *  draft's sidecar and the picker's state, which the screen shows only as paint. */
const FIND_STORE = `(() => {
  if (window.__liveStore) return true;
  const root = document.getElementById("root");
  const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  if (!key) return false;
  const stack = [root[key]];
  for (let n = 0; stack.length && n < 400000; n++) {
    const f = stack.pop();
    const v = f && f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.setState === "function" && v.getState() && "appPick" in v.getState()) { window.__liveStore = v; return true; }
    if (f && f.sibling) stack.push(f.sibling);
    if (f && f.child) stack.push(f.child);
  }
  return false; })()`;

/** The session's pane — every selector below is scoped to it. */
const PANE = `(() => { window.__pane = () => { const panes = [...document.querySelectorAll('.session-pane')];
  return panes.find((p) => (p.closest('.panel')?.textContent ?? "").includes(${JSON.stringify(TITLE)})) ?? panes[panes.length - 1]; }; return true; })()`;

const typeInto = (value) => `(() => {
  const el = window.__pane().querySelector('.composer-input');
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
  el.setSelectionRange(el.value.length, el.value.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value; })()`;

/** The window's material is not in the DOM, so a capture paints the root with a stand-in ground for
 *  the face on screen and puts it back after. `clip` crops to a region of the window. */
async function shot(c, tag, clip) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

const setMode = (c, mode) => evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
const holdAwake = (c) => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
  if (!window.__awake) { window.__awake = new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")); window.__awake.observe(r, { attributes: true }); } return true; })()`);

/** A rect in the window, as CSS px. */
const rectOf = (c, js) => evalIn(c, `(() => { const el = ${js}; if (!el) return null; const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
const mouse = (c, type, x, y, extra = {}) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra });
/** Aim, wait for the outline to settle, then report what the picker drew. */
async function aim(c, x, y) {
  await mouse(c, "mouseMoved", x - 6, y - 4);
  await sleep(60);
  await mouse(c, "mouseMoved", x, y);
  await sleep(350);
  return evalIn(c, `(() => { const box = document.querySelector('.app-picker-box'), label = document.querySelector('.app-picker-label');
    if (!box) return null; const b = box.getBoundingClientRect(), l = label.getBoundingClientRect();
    return { on: box.hasAttribute('data-on'), box: { x: b.x, y: b.y, w: b.width, h: b.height }, radius: getComputedStyle(box).borderTopLeftRadius,
      border: getComputedStyle(box).borderTopColor, fill: getComputedStyle(box).backgroundColor,
      name: document.querySelector('.app-picker-name').textContent, component: document.querySelector('.app-picker-component').textContent,
      label: { x: l.x, y: l.y, w: l.width, h: l.height, bg: getComputedStyle(label).backgroundColor } }; })()`);
}
async function press(c, x, y) {
  await mouse(c, "mousePressed", x, y);
  await sleep(40);
  await mouse(c, "mouseReleased", x, y);
}
/** ⌘⇧C, as a key a person presses: the keybinding layer reads it off the physical key. */
async function chord(c, key, code, modifiers) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  }
}
const selectChord = (c) => chord(c, "c", "KeyC", 4 | 8);
const picking = (c) => evalIn(c, `!!window.__liveStore.getState().appPick && !!document.querySelector('.app-picker-hint')`);
const draft = (c) => evalIn(c, `(() => { const s = window.__liveStore.getState(); const id = window.__sessionId;
  return { text: s.drafts[id] ?? "", chips: (s.draftElements[id] ?? []).map((ch) => ({ label: ch.label, app: !!ch.element.app, shot: ch.element.app ? ch.element.app.shot : null,
    webView: ch.element.app ? ch.element.app.webView : null, component: ch.element.app ? ch.element.app.components : null, selector: ch.element.selector, role: ch.element.role, name: ch.element.name })),
    files: (s.pendingAttachments[id] ?? []).map((a) => a.path) }; })()`);
const composerClip = (c) => evalIn(c, `(() => { const r = window.__pane().querySelector('.composer').getBoundingClientRect();
  const x = Math.max(0, r.left - 24), y = Math.max(0, r.top - 24);
  return { x, y, width: Math.min(innerWidth, r.right + 24) - x, height: Math.min(innerHeight, r.bottom + 24) - y }; })()`);
/** Around an element and its outline's label, for a close look at the hover. */
const around = (r, pad = 60) => ({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2 });

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Claude is the scripted agent here: every session runs the script, and nothing reaches a real engine.
      REALM_FAKE_STANDS_IN: "claude",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // Main's own inspector: where the window is sized for a fixed frame, and where the native view is.
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const mainC = cdp(mainTarget.webSocketDebuggerUrl); await mainC.ready;
  const mainEval = async (expr) => {
    const r = await mainC.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await mainEval(`(() => { const { BrowserWindow } = require("electron"); BrowserWindow.getAllWindows()[0].setContentSize(1440, 900); return true; })()`);
  const views = () => mainEval(`(() => { const { BrowserWindow, WebContentsView } = require("electron");
    return BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children.filter((v) => v instanceof WebContentsView)
      .map((v) => ({ url: v.webContents.getURL(), shown: v.getVisible(), bounds: v.getBounds() }))); })()`);
  await holdAwake(c);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Atlas");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdAwake(c);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", title: TITLE, permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(600);
  await holdAwake(c);
  await evalIn(c, PANE);
  check("the harness can read the renderer's store", await until(() => evalIn(c, FIND_STORE), 10_000, "store"));
  await evalIn(c, `(() => { window.__sessionId = ${JSON.stringify(session.id)}; return true; })()`);
  await evalIn(c, typeInto("Line these up: "));
  await sleep(300);

  // ── 1. The + menu's row, and the send button ──────────────────────────────────────────────────
  await evalIn(c, `(() => { window.__pane().querySelector('.composer-attach').click(); return true; })()`);
  const row = await until(() => evalIn(c, `(() => { const r = [...document.querySelectorAll('.plus-menu [role=menuitem]')].find((b) => b.querySelector('.menu-label')?.textContent === "Select in Realm");
    return r ? { name: r.textContent, noAgent: r.getAttribute('data-no-agent'), kbd: r.querySelector('.menu-kbd')?.textContent ?? null } : null; })()`), 5_000, "the row");
  note("the + menu's row", row);
  check("the + menu offers Select in Realm with its chord, and no agent may press it", row.kbd === "⌘⇧C" && row.noAgent === "element picker", row);
  for (const mode of ["dark", "light"]) {
    await setMode(c, mode); await sleep(250);
    await shot(c, `1-plus-menu-${mode}`, await evalIn(c, `(() => { const m = document.querySelector('.plus-menu').getBoundingClientRect(), p = window.__pane().querySelector('.composer').getBoundingClientRect();
      const x = Math.max(0, Math.min(m.left, p.left) - 24), y = Math.max(0, Math.min(m.top, p.top) - 24);
      return { x, y, width: Math.min(innerWidth, Math.max(m.right, p.right) + 24) - x, height: Math.min(innerHeight, Math.max(m.bottom, p.bottom) + 24) - y }; })()`));
  }
  await setMode(c, "dark");
  await evalIn(c, `(() => { [...document.querySelectorAll('.plus-menu [role=menuitem]')].find((b) => b.querySelector('.menu-label')?.textContent === "Select in Realm").click(); return true; })()`);
  await until(() => picking(c), 5_000, "picker up");
  const hint = await evalIn(c, `(() => { const h = document.querySelector('.app-picker-hint'); const r = h.getBoundingClientRect();
    return { text: h.textContent, role: h.getAttribute('role'), x: r.x, y: r.y, w: r.width, h: r.height, picking: document.documentElement.hasAttribute('data-app-picking') }; })()`);
  note("hint", hint);
  check("the hint says how to pick and how to leave, centred near the top", hint.text === "Click a part of Realm·Esc to cancel" && hint.picking && Math.abs(hint.x + hint.w / 2 - 720) < 4, hint);

  const send = await rectOf(c, `window.__pane().querySelector('.composer-send')`);
  const hover1 = await aim(c, send.cx, send.cy);
  note("hover over the send button", hover1);
  check("the send button is outlined a few pixels off its edge, rounded with it", hover1?.on && Math.abs(hover1.box.x - (send.x - 3)) < 1.5 && Math.abs(hover1.box.w - (send.w + 6)) < 1.5, { hover: hover1?.box, send });
  check("…and named by its name and role, with the component that drew it", hover1?.name === "Send button" && hover1?.component === "Composer", hover1);
  check("the app's own tooltip does not answer a pointer that is only aiming", !(await evalIn(c, `!!document.querySelector('.tooltip[data-open]')`)));
  for (const mode of ["dark", "light"]) {
    await setMode(c, mode); await sleep(250);
    await shot(c, `2-hover-send-${mode}`, around(send, 90));
    await shot(c, `2-window-armed-${mode}`);
  }
  await setMode(c, "dark");
  // The pane's bar is a window-drag region, which takes no pointer events at all; while picking it
  // stands down, so the bar is a thing to point at like any other.
  const bar = await rectOf(c, `window.__pane().closest('.panel').querySelector('.panel-bar')`);
  const region = await evalIn(c, `getComputedStyle(window.__pane().closest('.panel').querySelector('.panel-bar')).getPropertyValue('-webkit-app-region')`);
  const hoverBar = await aim(c, bar.x + bar.w * 0.55, bar.cy);
  note("hover over the pane bar's empty stretch", { region, hoverBar });
  check("the window's drag regions stand down while picking, so a pane's bar can be outlined", region === "no-drag" && hoverBar?.on, { region, name: hoverBar?.name, component: hoverBar?.component });
  await aim(c, send.cx, send.cy);
  await press(c, send.cx, send.cy);
  await until(async () => (await draft(c)).chips.length === 1, 10_000, "first chip");
  await sleep(600);
  const d1 = await draft(c);
  note("after the first pick", d1);
  const unsent = (await api.call("sessions.events", { id: session.id })).every((e) => e.event.type !== "user_message");
  check("the press picked the send button and SENT nothing", d1.text.startsWith("Line these up: @[Realm · Send button]") && unsent, { text: d1.text, unsent });
  check("the chip carries the component and its picture, attached beside it", d1.chips[0].app && d1.chips[0].component?.[0] === "Composer" && d1.chips[0].shot && d1.files.includes(d1.chips[0].shot), d1.chips[0]);
  check("the picker is put away", !(await picking(c)) && !(await evalIn(c, `document.documentElement.hasAttribute('data-app-picking')`)));

  // ── 2. ⌘⇧C: a sidebar row, then a switch on the Settings page ────────────────────────────────
  await selectChord(c);
  await until(() => picking(c), 5_000, "picker up by chord, to be put away");
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  check("Escape puts the picker away and adds nothing", !(await picking(c)) && (await draft(c)).chips.length === 1);
  await selectChord(c);
  await until(() => picking(c), 5_000, "picker up by chord");
  const rowRect = await rectOf(c, `[...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`);
  const hover2 = await aim(c, rowRect.x + 40, rowRect.cy);
  note("hover over the sidebar row", hover2);
  check("a sidebar row is outlined whole, named by its title", hover2?.on && hover2.name.startsWith(TITLE), hover2);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `3-hover-sidebar-row-${mode}`, around(rowRect, 70)); }
  await setMode(c, "dark");
  await press(c, rowRect.x + 40, rowRect.cy);
  await until(async () => (await draft(c)).chips.length === 2, 10_000, "second chip");
  const d2 = await draft(c);
  note("after the sidebar pick", d2.chips[1]);
  check("the sidebar row went in as its own chip, and the session it names was not opened again", d2.chips[1].label.startsWith(`Realm · ${TITLE}`), d2.chips[1]);

  await chord(c, ",", "Comma", 4);
  await until(() => evalIn(c, `[...document.querySelectorAll('input[role=switch]')].some((s) => s.getBoundingClientRect().width > 0)`), 10_000, "settings switches");
  await sleep(500);
  await holdAwake(c);
  await selectChord(c);
  await until(() => picking(c), 5_000, "picker up over Settings");
  const sw = await rectOf(c, `[...document.querySelectorAll('input[role=switch]')].find((s) => { const r = s.getBoundingClientRect(); return r.width > 0 && r.top > 80 && r.bottom < innerHeight - 40; })`);
  const hover3 = await aim(c, sw.cx, sw.cy);
  note("hover over a settings switch", hover3);
  check("a settings switch is outlined as a pill, named as a switch", hover3?.on && / switch$/.test(hover3.name) && parseFloat(hover3.radius) >= (sw.h + 6) / 2 - 1, hover3);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `4-hover-settings-switch-${mode}`, around(sw, 120)); }
  await setMode(c, "dark");
  const switchBefore = await evalIn(c, `[...document.querySelectorAll('input[role=switch]')].find((s) => { const r = s.getBoundingClientRect(); return Math.abs(r.x - ${sw.x}) < 1 && Math.abs(r.y - ${sw.y}) < 1; })?.checked`);
  await press(c, sw.cx, sw.cy);
  await until(async () => (await draft(c)).chips.length === 3, 10_000, "third chip");
  const switchAfter = await evalIn(c, `[...document.querySelectorAll('input[role=switch]')].find((s) => { const r = s.getBoundingClientRect(); return Math.abs(r.x - ${sw.x}) < 1 && Math.abs(r.y - ${sw.y}) < 1; })?.checked`);
  const d3 = await draft(c);
  note("after the settings pick", d3.chips[2]);
  check("the switch went in as a chip, and was not flipped by the press", / switch$/.test(d3.chips[2].label) && switchBefore === switchAfter, { label: d3.chips[2].label, switchBefore, switchAfter });
  await evalIn(c, `(() => { window.__liveStore.getState().closePageOverlay(); return true; })()`);
  await sleep(500);

  // ── 3. A browser pane: its own bar, the page's view, and the web picker inside it ─────────────
  await evalIn(c, `(() => { const b = document.querySelector('[aria-label=${JSON.stringify(`Open a browser beside ${TITLE}`)}]'); if (b) b.click(); return !!b; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.browser-pane input[aria-label=Address]')`), 10_000, "browser pane");
  await evalIn(c, `(() => { const input = document.querySelector('.browser-pane input[aria-label=Address]'); input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(`${SITE}/`)});
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  const view = await until(async () => (await views()).find((v) => v.url.startsWith(SITE) && v.shown && v.bounds.width > 0), 20_000, "page on screen");
  await sleep(800);
  await holdAwake(c);
  note("the page's native view", view);
  // Main itself, asked to photograph the view's rectangle: it refuses, and says that is why.
  const refused = await evalIn(c, `(async () => { const h = document.querySelector('.browser-view-host').getBoundingClientRect();
    window.realm.appPick.arm(true); const r = await window.realm.appPick.capture({ x: h.x + 20, y: h.y + 20, w: 200, h: 120 }, null, "realm-x.png"); window.realm.appPick.arm(false); return r; })()`);
  check("main never captures over a browser view, and says it is a web view", refused.file === null && refused.webView === true, refused);
  const idle = await evalIn(c, `(async () => window.realm.appPick.capture({ x: 10, y: 10, w: 40, h: 40 }, null, "realm-x.png"))()`);
  check("…nor anything at all while nobody is picking", idle.file === null && idle.webView === false, idle);

  await selectChord(c);
  await until(() => picking(c), 5_000, "picker up beside a page");
  const address = await rectOf(c, `document.querySelector('.browser-pane input[aria-label=Address]')`);
  const hover4 = await aim(c, address.cx, address.cy);
  note("hover over the address field", hover4);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `5-hover-browser-address-${mode}`, around(address, 90)); }
  await setMode(c, "dark");
  await press(c, address.cx, address.cy);
  await until(async () => (await draft(c)).chips.length === 4, 10_000, "fourth chip");
  const d4 = await draft(c);
  note("after the address pick", d4.chips[3]);
  const addressShot = d4.chips[3].shot;
  const dims = addressShot ? execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", addressShot], { encoding: "utf8" }) : "";
  const px = { w: Number(/pixelWidth: (\d+)/.exec(dims)?.[1]), h: Number(/pixelHeight: (\d+)/.exec(dims)?.[1]) };
  const scale = await evalIn(c, `window.devicePixelRatio`);
  const expectedBottom = Math.min(view.bounds.y, address.y + address.h + 24);
  const expectedTop = Math.max(0, address.y - 24);
  note("the address field's picture", { px, scale, expectedDipHeight: expectedBottom - expectedTop });
  check("the bar's picture keeps its margin above and stops at the page's edge below", addressShot && Math.abs(px.h / scale - (Math.floor(expectedBottom) - Math.ceil(expectedTop))) <= 1, { px, scale, view: view.bounds, address });

  // A pick that lands over the page's view. No real pointer reaches the DOM under a native view, so
  // the release is dispatched there by hand — what arrives is the case main exists to refuse: the
  // chip goes in, says it has no picture, and nothing is attached.
  await selectChord(c);
  await until(() => picking(c), 5_000, "picker up over the view");
  const filesBefore = (await draft(c)).files.length;
  await evalIn(c, `(() => { const h = document.querySelector('.browser-view-host').getBoundingClientRect();
    const at = document.elementFromPoint(h.x + h.width / 2, h.y + h.height / 2);
    at.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: h.x + h.width / 2, clientY: h.y + h.height / 2 })); return true; })()`);
  await until(async () => (await draft(c)).chips.length === 5, 10_000, "the view's chip");
  const dv = await draft(c);
  note("after a pick over the page's view", dv.chips[4]);
  check("a pick over a page's view goes in without a picture, and its chip says so", / \(no picture\)$/.test(dv.chips[4].label) && dv.chips[4].webView === true && dv.chips[4].shot === null && dv.files.length === filesBefore, dv.chips[4]);

  // The page keeps the web picker: armed with the app's, its outline is drawn by the page itself.
  await selectChord(c);
  await until(() => picking(c), 5_000, "picker up again");
  const pageTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(SITE)), 10_000, "page target");
  const pc = cdp(pageTarget.webSocketDebuggerUrl); await pc.ready;
  await pc.send("Runtime.enable");
  const btn = await until(() => evalIn(pc, `(() => { const r = document.getElementById('submit').getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, armed: !!window.__realmPicker }; })()`)
    .then((b) => (b.armed ? b : null)), 10_000, "web picker armed in the page");
  await pc.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.cx - 4, y: btn.cy, button: "none" });
  await sleep(80);
  await pc.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.cx, y: btn.cy, button: "none" });
  await sleep(400);
  try {
    const b64 = await mainEval(`(async () => { const { BrowserWindow, WebContentsView } = require("electron");
      for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children)
        if (v instanceof WebContentsView && v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) return (await v.webContents.capturePage()).toPNG().toString("base64");
      return null; })()`);
    if (b64) { fs.writeFileSync(OUT("6-page-keeps-web-picker"), Buffer.from(b64, "base64")); console.log(`SCREENSHOT 6-page-keeps-web-picker ${OUT("6-page-keeps-web-picker")}`); }
  } catch (e) { note("view screenshot failed", String(e)); }
  await pc.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.cx, y: btn.cy, button: "left", clickCount: 1 });
  await pc.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.cx, y: btn.cy, button: "left", clickCount: 1 });
  await until(async () => (await draft(c)).chips.length === 6, 15_000, "the page's chip");
  const d5 = await draft(c);
  note("after the page pick", d5.chips[5]);
  check("a click in the page lands the page's element in the same prompter, and the app's picker goes", d5.chips[5].label === 'button "Sign in"' && !(await picking(c)), d5.chips[5]);
  pc.close();
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `7-chips-${mode}`, await composerClip(c)); }
  await setMode(c, "dark");

  // ── 4. Send to the scripted agent, and read what it was handed ────────────────────────────────
  const files = (await draft(c)).files;
  for (const [i, f] of files.entries()) { fs.copyFileSync(f, path.join(OUT_DIR, `app-picker-picture-${i + 1}-${path.basename(f).replace(/^[0-9a-f]+-/, "")}`)); }
  await evalIn(c, `window.__pane().querySelector('.composer-send').click()`);
  await until(() => evalIn(c, `[...window.__pane().querySelectorAll('.msg-assistant')].some((e) => e.textContent.includes("echo:"))`), 20_000, "echo");
  await sleep(800);
  const events = await api.call("sessions.events", { id: session.id });
  const sent = events.map((e) => e.event).find((e) => e.type === "user_message");
  const echo = events.map((e) => e.event).filter((e) => e.type === "assistant_text").map((e) => e.payload.text).join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "app-picker-what-the-agent-received.txt"), `${echo}\n\n--- attachments ---\n${JSON.stringify(sent?.payload.attachments, null, 2)}\n`);
  note("user_message", sent?.payload);
  check("the message carries the four pictures as image attachments", sent?.payload.attachments.filter((a) => a.mime === "image/png").length === 4, sent?.payload.attachments);
  check("the agent was handed each part of Realm by its chip, component, selector and box",
    echo.includes("Parts of Realm's own window the user picked") && /@\[Realm · Send button\] — the attached [0-9a-f]+-realm-send-button\.png shows it/.test(echo)
      && echo.includes("component: Composer") && echo.includes("selector: button.composer-send") && /box: x=\d/.test(echo));
  check("…and the page's element in its own fenced block, as the web picker always sent it", echo.includes("Elements the user picked in Realm's browser pane") && echo.includes('@[button "Sign in"]'));
  check("…and told plainly why one of them came without a picture", echo.includes("no picture: it covers a browser pane's page, which a capture of Realm's window cannot see"));
  await evalIn(c, `(() => { const rows = window.__pane().querySelectorAll('.msg-user-row'); rows[rows.length - 1]?.scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(400);
  const bubbleClip = await evalIn(c, `(() => { const rows = window.__pane().querySelectorAll('.msg-user-row'); const r = rows[rows.length - 1].getBoundingClientRect(); const p = window.__pane().getBoundingClientRect();
    return { x: p.left, y: Math.max(p.top, r.top - 24), width: p.width, height: Math.min(r.height + 48 + 200, p.bottom - Math.max(p.top, r.top - 24)) }; })()`);
  for (const mode of ["dark", "light"]) { await setMode(c, mode); await sleep(250); await shot(c, `8-sent-${mode}`, bubbleClip); }
  await setMode(c, "dark");
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  site?.close();
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT, SITE_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
