/**
 * Live check for a session's terminal as a tab of its side pane, and for the ground it is drawn on
 * (run with: pnpm build && node apps/desktop/scripts/terminal-tab-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent, makes a fake session over RPC —
 * onboarding's own session runs this Mac's real engine and is never typed into — and checks, in the
 * real window:
 *
 *   1. The pane bar's terminal button opens the session's terminal as a tab of its side pane, with
 *      the keyboard, started in the session's checkout, and draws no dock over the transcript.
 *   2. A second press, ⌘J and View ▸ Show Terminal (clicked in main's menu) each go back to that one
 *      tab — bringing it in front of another — and never start a second shell.
 *   3. The terminal paints no ground of its own: an empty stretch of the terminal and an empty
 *      stretch of the transcript sample the same, in the dark face and the light, and with the old
 *      fill put back as the mutant they do not. On the light face its ink is the app's.
 *   4. Settings ▸ General ▸ Session terminal ▸ Bottom keeps the dock along the pane's foot: the
 *      button shows and hides it, no tab is made, and the shell sits on the dock card's own surface.
 *
 * Ports: LIVE_SERVER_PORT (8968), LIVE_CDP_PORT (9368), LIVE_MAIN_INSPECT_PORT (9468). Touches only a
 * scratch dir; kills only what is listening on its own ports. Nothing is billed: the session is on the
 * scripted agent, and REALM_ENABLE_FAKE_AGENT=1 turns the titler and recap off.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9368);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8968);
/** Main's own inspector — the menu bar lives there, and only there can a row of it be clicked. */
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9468);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-terminal-tab-live-"));
const home = path.join(scratch, "home");
const TITLE = "Terminal tab live check";
const WINDOW = { width: 1500, height: 900 };
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const OUT = (tag) => path.join(OUT_DIR, `realm-terminal-tab-${tag}.png`);
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

/** An expression in main, with `require` — the Electron objects themselves, not what a page says. */
async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A chord as the window gets it from the keyboard: down and up, with the modifiers held. */
async function press(c, { key, code, keyCode, meta = false, shift = false, alt = false }) {
  const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

/**
 * Mean RGBA of each rect (CSS px) in a capture of the window. Decoded in the page, which already
 * has a PNG decoder and a canvas: the capture is the window's own pixels, alpha included, so a
 * surface that paints nothing over a translucent ground and one that paints the same colour opaquely
 * come out different even where their RGB agree.
 */
const SAMPLE = (b64, rects) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const k = img.width / window.innerWidth;
  return ${JSON.stringify(rects)}.map((r) => {
    const d = ctx.getImageData(Math.round(r.x * k), Math.round(r.y * k), Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k))).data;
    const sum = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let ch = 0; ch < 4; ch++) sum[ch] += d[i + ch];
    return sum.map((v) => +(v / (d.length / 4)).toFixed(1));
  });
})()`;
const maxDelta = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
/** A page-side function: any CSS colour as `rgb(r, g, b)`, through a canvas — a computed colour comes
 *  back as written (`oklch(…)`), and luminance is a fact about the sRGB channels. */
const SRGB = `((css) => { const g = document.createElement('canvas').getContext('2d'); g.fillStyle = css; g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data; return 'rgb(' + r + ', ' + gr + ', ' + b + ')'; })`;
/** WCAG relative luminance of an `rgb(…)` string. */
const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((v) => {
    const s = Number(v) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

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
      // The app's menus are the OS's otherwise, which a page-level click cannot reach.
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
  // The window opens behind whatever the user has in front; unfocused, Realm quiets itself.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl); await m.ready;
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  // A chat to stand the terminal beside, from the scripted agent: it answers with an echo.
  await api.call("sessions.send", { id: session.id, text: "Run the parser tests and tell me which ones fail.", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 })).some((e) => e.event.type === "assistant_text"), 20_000, "the agent's answer");
  const cwd = (await api.call("sessions.get", { id: session.id })).cwd;
  const folder = path.basename(cwd);
  note("the session's checkout", { cwd });

  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  const openRow = () => evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await openRow();
  await sleep(800);
  // One pane: this session alone, so every pane after this is one the checks asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.panehost .panel').length === 1 && !!document.querySelector('.session-pane .transcript')`), 10_000, "the session alone");

  const panes = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].map((p) => ({
    tabs: [...p.querySelectorAll('.pane-tabs [role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true' })),
    title: p.querySelector('.panel-title')?.textContent ?? null, focused: p.hasAttribute('data-focused'),
    left: Math.round(p.getBoundingClientRect().left), width: Math.round(p.getBoundingClientRect().width) }))`);
  const sidePane = async () => (await panes()).find((p) => p.tabs.length > 0) ?? null;
  const terminalItems = async () => (await api.call("items.list", { spaceId: space.id })).filter((i) => i.kind === "terminal");
  /** The keyboard into the session's pane, as a click there puts it, and then out of any text field. */
  const intoSession = async () => {
    await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
    await sleep(400);
    await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
    await sleep(100);
  };
  const button = (name) => `[...document.querySelectorAll('.panel-bar button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(name)})`;

  // ── 1. The button: a tab of the side pane, not a dock ──────────────────────────────────────
  const OPEN = `Open the terminal beside ${TITLE}`;
  const bar = await until(() => evalIn(c, `(() => { const b = ${button(OPEN)}; return b ? { pressed: b.getAttribute('aria-pressed'), popup: b.getAttribute('aria-haspopup') } : null; })()`), 10_000, "the terminal button");
  check("the pane bar's terminal button is a plain action, like the side-pane buttons beside it", bar.pressed === null && bar.popup === null, bar);
  await evalIn(c, `(() => { ${button(OPEN)}.click(); return true; })()`);
  const first = await until(async () => { const s = await sidePane(); return s?.tabs.length === 1 && s.tabs[0].name === folder ? s : null; }, 15_000, "the terminal's tab").catch(() => sidePane());
  const lead = (await panes()).find((p) => p.title === TITLE);
  check("the button opens the terminal as a tab of the session's side pane, to its right, with the keyboard",
    first?.tabs[0]?.name === folder && first.tabs[0].selected && first.focused && lead && first.left > lead.left, { side: first, lead });
  const dockDrawn = await evalIn(c, `!!document.querySelector('.terminal-dock')`);
  check("…and draws no dock over the transcript", dockDrawn === false);
  const terms1 = await terminalItems();
  const shellCwd = terms1.length === 1
    ? execFileSync("sqlite3", ["-readonly", path.join(home, "realm.db"), `select cwd from terminals where id = '${terms1[0].refId}'`], { encoding: "utf8" }).trim()
    : null;
  check("one shell, started in the session's checkout", terms1.length === 1 && shellCwd === cwd, { terminals: terms1.length, shellCwd, cwd });
  await until(() => evalIn(c, `!!document.querySelector('.panehost .terminal-pane .xterm-rows')`), 10_000, "the shell drawn").catch(() => {});

  // ── 2. Every way in goes back to that one tab ─────────────────────────────────────────────
  await intoSession();
  await evalIn(c, `(() => { ${button(OPEN)}.click(); return true; })()`);
  await sleep(800);
  const again = await sidePane();
  check("a second press goes to the same tab rather than starting another shell",
    again?.tabs.length === 1 && again.focused && (await terminalItems()).length === 1, { side: again });

  // Another tab in front of it: a blank one from the session, by ⌘⇧B.
  await intoSession();
  await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true });
  await until(async () => (await sidePane())?.tabs.length === 2, 10_000, "a blank tab in front");
  const front = async () => (await sidePane())?.tabs.find((t) => t.selected)?.name ?? null;
  note("in front after ⌘⇧B", await front());

  await intoSession();
  await press(c, { key: "j", code: "KeyJ", keyCode: 74, meta: true });
  const viaKey = await until(async () => ((await front()) === folder ? await sidePane() : null), 5_000, "⌘J's tab").catch(() => sidePane());
  check("⌘J brings the same terminal's tab to the front, with the keyboard, and starts no shell",
    viaKey?.tabs.find((t) => t.selected)?.name === folder && viaKey.focused && (await terminalItems()).length === 1, viaKey);

  // Blank tab in front again, then View ▸ Show Terminal from main's own menu.
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')].find((t) => t.textContent !== ${JSON.stringify(folder)}).click(); return true; })()`);
  await until(async () => (await front()) !== folder, 5_000, "the blank tab in front");
  await intoSession();
  const menu = await inMain(m, `(() => {
    const { Menu } = require("electron");
    const view = Menu.getApplicationMenu().items.find((i) => i.label === "View");
    const labels = view.submenu.items.map((i) => i.label).filter(Boolean);
    const row = view.submenu.items.find((i) => i.label === "Show Terminal");
    if (row) row.click();
    return { labels, clicked: !!row };
  })()`);
  const viaMenu = await until(async () => ((await front()) === folder ? await sidePane() : null), 5_000, "the menu's tab").catch(() => sidePane());
  check("View ▸ Show Terminal does the same", menu.clicked && !menu.labels.includes("Toggle Terminal")
    && viaMenu?.tabs.find((t) => t.selected)?.name === folder && viaMenu.focused && (await terminalItems()).length === 1, { menu, side: viaMenu });

  // ── 3. The ground: the terminal's is the transcript's ─────────────────────────────────────
  /** Empty stretches of each: the terminal's last rows, clear of its scrollbar, and the transcript's
   *  left padding, between the pane bar and the prompter. */
  const regions = () => evalIn(c, `(() => {
    const t = document.querySelector('.panehost .terminal-pane').getBoundingClientRect();
    const s = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}).querySelector('.session-pane').getBoundingClientRect();
    return { terminal: { x: t.right - 90, y: t.bottom - 60, width: 40, height: 30 }, transcript: { x: s.left + 3, y: s.top + 90, width: 9, height: 120 } };
  })()`);
  const capture = async () => (await c.send("Page.captureScreenshot", { format: "png" })).data;
  /** Put the old fill back — the pane's and xterm's — for the length of one capture: the mutant. */
  const withOldFill = async (fill, fn) => {
    await evalIn(c, `(() => { const s = document.createElement('style'); s.id = 'live-old-fill';
      s.textContent = '.terminal-pane, .terminal-pane .xterm-viewport { background-color: ${fill} !important; }'; document.head.append(s); return true; })()`);
    await sleep(300);
    try { return await fn(); } finally { await evalIn(c, `(() => { document.getElementById('live-old-fill')?.remove(); return true; })()`); await sleep(300); }
  };
  const measureFace = async (face, oldFill) => {
    await sleep(600);
    const css = await evalIn(c, `(() => {
      const pane = document.querySelector('.panehost .terminal-pane');
      const rows = pane.querySelector('.xterm-rows');
      return { pane: getComputedStyle(pane).backgroundColor, viewport: getComputedStyle(pane.querySelector('.xterm-viewport')).backgroundColor,
        ink: rows ? ${SRGB}(getComputedStyle(rows).color) : null, scheme: getComputedStyle(pane).colorScheme, mode: document.documentElement.dataset.mode ?? 'dark' };
    })()`);
    note(`${face}: the terminal as the engine resolved it`, css);
    check(`${face}: neither the terminal pane nor xterm paints a ground`, css.pane === "rgba(0, 0, 0, 0)" && /, 0\)$/.test(css.viewport), css);
    const r = await regions();
    const [term, chat] = await evalIn(c, SAMPLE(await capture(), [r.terminal, r.transcript]));
    note(`${face}: mean RGBA, terminal vs transcript`, { terminal: term, transcript: chat, regions: r });
    check(`${face}: an empty stretch of the terminal samples the same as the transcript's`, maxDelta(term, chat) <= 1, { terminal: term, transcript: chat });
    const [termOld, chatOld] = await withOldFill(oldFill, async () => evalIn(c, SAMPLE(await capture(), [r.terminal, r.transcript])));
    check(`${face}: …and with the old fill put back (the mutant) it does not`, maxDelta(termOld, chatOld) > 1, { terminal: termOld, transcript: chatOld });
    return css;
  };
  const oldDark = await evalIn(c, `getComputedStyle(document.documentElement).getPropertyValue('--rl-panel').trim()`);
  const dark = await measureFace("dark", oldDark);
  check("dark: the shell keeps xterm's own light ink", dark.ink !== null && luminance(dark.ink) > 0.8, dark.ink);
  await shot(c, "dark");

  /** Settings, on one of its tabs, then back to the workspace by the session's row. */
  const inSettings = async (tab, fn) => {
    await press(c, { key: ",", code: "Comma", keyCode: 188, meta: true });
    await until(() => evalIn(c, `!!document.querySelector('.settings-page-pane')`), 10_000, "settings");
    await evalIn(c, `(() => { [...document.querySelectorAll('.page-rail input')].find((r) => r.value === ${JSON.stringify(tab)}).click(); return true; })()`);
    await sleep(500);
    await fn();
    await sleep(400);
    await openRow();
    await until(() => evalIn(c, `!document.querySelector('.settings-page-pane')`), 10_000, "back to the workspace");
    await sleep(600);
  };
  const setTheme = (pref) => inSettings("appearance", async () => {
    await until(() => evalIn(c, `!!document.querySelector('input[name=settings-theme][value=${pref}]')`), 5_000, "the theme cards");
    await evalIn(c, `(() => { document.querySelector('input[name=settings-theme][value=${pref}]').click(); return true; })()`);
    await until(() => evalIn(c, `(document.documentElement.dataset.mode ?? 'dark') === ${JSON.stringify(pref)}`), 5_000, `the ${pref} face`);
  });

  await setTheme("light");
  // The terminal tab, in front, for the light face's measurement — the row click put the keyboard in the session.
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')].find((t) => t.textContent === ${JSON.stringify(folder)}).click(); return true; })()`);
  await sleep(500);
  const light = await measureFace("light", "#1c1d1f");
  const panel = await evalIn(c, `${SRGB}(getComputedStyle(document.documentElement).getPropertyValue('--rl-panel').trim())`);
  const ratio = light.ink ? (luminance(panel) + 0.05) / (luminance(light.ink) + 0.05) : 0;
  check("light: the shell's ink is the app's, and reads at AA on the pane's colour", light.ink !== null && luminance(light.ink) < 0.1 && ratio >= 4.5, { ink: light.ink, panel, ratio: +ratio.toFixed(2) });
  check("light: its colour scheme is the face's, so its scrollbar is too", light.scheme === "light" || light.scheme === "normal", light.scheme);
  await shot(c, "light");

  // ── 4. Bottom keeps the dock ─────────────────────────────────────────────────────────────
  await inSettings("general", async () => {
    await until(() => evalIn(c, `!!document.querySelector('input[name=settings-terminal-dock][value=bottom]')`), 5_000, "the Session terminal choice");
    await evalIn(c, `(() => { document.querySelector('input[name=settings-terminal-dock][value=bottom]').click(); return true; })()`);
  });
  await intoSession();
  const SHOW = `Show terminal for ${TITLE}`;
  const toggle = await until(() => evalIn(c, `(() => { const b = ${button(SHOW)}; return b ? b.getAttribute('aria-pressed') : null; })()`), 5_000, "the dock's toggle").catch(() => null);
  check("under Bottom the button is the dock's toggle again", toggle === "false", toggle);
  const tabsBefore = (await sidePane())?.tabs.length;
  await evalIn(c, `(() => { ${button(SHOW)}.click(); return true; })()`);
  // Measured once it has arrived: its entrance travels up from below the pane's foot.
  await until(() => evalIn(c, `(() => { const d = document.querySelector('.terminal-dock'); return !!d && d.getAnimations().length === 0; })()`), 10_000, "the dock settled").catch(() => {});
  const docked = await until(() => evalIn(c, `(() => { const d = document.querySelector('.terminal-dock'); if (!d || !d.querySelector('.terminal-pane')) return null;
    const r = d.getBoundingClientRect(); const s = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}).querySelector('.session-pane');
    const p = s.getBoundingClientRect();
    return { pinned: d.hasAttribute('data-pinned'), paneBottom: s.hasAttribute('data-dock-bottom'), bottomGap: Math.round(p.bottom - r.bottom), height: Math.round(r.height),
      left: Math.round(r.left - p.left), right: Math.round(p.right - r.right) }; })()`), 10_000, "the dock").catch(() => null);
  // Inset from the pane's foot and sides by the card's margin, the same 8px every docked card keeps.
  check("it docks along the pane's foot, pinned, the pane giving up its height", !!docked && docked.pinned && docked.paneBottom
    && docked.bottomGap > 0 && docked.bottomGap <= 16 && docked.left > 0 && docked.right > 0, docked);
  check("…and makes no tab", (await sidePane())?.tabs.length === tabsBefore && (await terminalItems()).length === 1, { tabs: (await sidePane())?.tabs });
  await until(() => evalIn(c, `!!document.querySelector('.terminal-dock .xterm-rows')`), 10_000, "the dock's shell").catch(() => {});
  await sleep(800);
  const dockRegions = await evalIn(c, `(() => {
    const t = document.querySelector('.terminal-dock .terminal-pane').getBoundingClientRect();
    const b = document.querySelector('.terminal-dock-bar').getBoundingClientRect();
    return { terminal: { x: t.right - 90, y: t.bottom - 40, width: 40, height: 20 }, bar: { x: b.left + b.width * 0.5, y: b.top + 1, width: 30, height: 3 } };
  })()`);
  const [dockTerm, dockBar] = await evalIn(c, SAMPLE(await capture(), [dockRegions.terminal, dockRegions.bar]));
  check("in the dock the shell sits on the card's own surface, the same as its bar", maxDelta(dockTerm, dockBar) <= 1, { terminal: dockTerm, bar: dockBar });
  await shot(c, "bottom-light");
  await evalIn(c, `(() => { ${button("Hide terminal for " + TITLE)}.click(); return true; })()`);
  const gone = await until(() => evalIn(c, `!document.querySelector('.terminal-dock')`), 5_000, "the dock hidden").catch(() => false);
  check("a second press hides the dock", gone === true);

  await setTheme("dark");
  await intoSession();
  await evalIn(c, `(() => { ${button(SHOW)}.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.terminal-dock .xterm-rows')`), 10_000, "the dock in dark").catch(() => {});
  await sleep(800);
  await shot(c, "bottom-dark");
}

/** The window as the renderer draws it, alpha and all — the macOS material behind it is not in a
 *  DOM capture, so its translucent ground comes out see-through. */
async function shot(c, tag) {
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
