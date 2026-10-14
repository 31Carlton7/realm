/**
 * Live check for three small things the owner asked for in 2.3
 * (run with: pnpm build && node apps/desktop/scripts/v23-polish-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and, on the dark face and then the light one:
 *
 *   1. A switch that is ON, under the pointer: its track stays the accent — lighter on dark, deeper on
 *      light — where it used to fall to the off track's grey. An OFF switch under the pointer is
 *      unchanged. Read from the window's own pixels at the track's end, away from the knob.
 *   2. The Realm mark a browser pane shows while its first page is on its way: a shimmer crosses it.
 *      Frames are taken at a few moments of the sweep and the band is located in each, so a sweep
 *      that does not move — or is not drawn — fails.
 *   3. A transcript whose tool calls went to MCP servers: each row leads with its app's mark (Gmail,
 *      Calendar, Drive, Linear, Notion, PostHog, Stripe…), and Realm's own servers with the glyph of
 *      the pane they drive.
 *
 * Ports: REALM_PORT (8793), REALM_DEVTOOLS_PORT (9233), LIVE_MAIN_INSPECT_PORT (9293) and a slow page
 * on 127.0.0.1:LIVE_SITE_PORT (8894). Scratch under LIVE_SCRATCH_DIR, pictures under LIVE_SHOTS_DIR.
 * Nothing is billed: every session is moved to the scripted agent before anything is sent, the
 * window is made non-focusable, and only what listens on these ports is killed afterwards.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.REALM_PORT ?? 8793);
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9233);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9293);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8894);
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-v23-polish-live-"));
const home = path.join(scratch, "home");
const SHOTS = process.env.LIVE_SHOTS_DIR ?? path.join(os.tmpdir(), "realm-v23-polish-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const TITLE = "Polish live check";
const WINDOW = { width: 1500, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
const servers = [];
const daemonPids = [];

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The calls the scripted agent makes, as each harness names them on the wire. */
const MCP_CALLS = [
  ["mcp__claude_ai_Gmail__search_threads", { query: "from:billing@stripe.com invoice" }, "gmail"],
  ["mcp__claude_ai_Google_Calendar__list_events", { query: "Design review this week" }, "googleCalendar"],
  ["mcp__claude_ai_Google_Drive__search_files", { query: "Q3 planning" }, "googleDrive"],
  ["mcp__realm__realm-linear__save_issue", { title: "Invoice email links to the old portal" }, "linear"],
  ["mcp__claude_ai_Notion__notion-search", { query: "Billing runbook" }, "notion"],
  ["mcp__claude_ai_PostHog__query-run", { query: "checkout_started last 7 days" }, "posthog"],
  ["mcp__realm__stripe__list_invoices", { query: "status:open" }, "stripe"],
  ["mcp__realm__realm-browser__browser_open", { url: "https://dashboard.stripe.com/invoices" }, "browser"],
  ["mcp__realm__realm-terminal__terminal_write", { title: "pnpm test billing" }, "terminal"],
  ["mcp__realm__my-tools__frobnicate", { name: "something only this space has" }, "plug"],
];

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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A page that keeps the pane waiting: the connection is held open and never answered. */
const startSite = () => new Promise((resolve, reject) => {
  const server = http.createServer(() => { /* never answers */ });
  server.once("error", reject);
  server.listen(SITE_PORT, "127.0.0.1", () => { servers.push(server); resolve(server); });
});

async function launch(scriptFile) {
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
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
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
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  // Never takes the keyboard from the person at the Mac.
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) { w.setFocusable(false); w.setContentSize(${WINDOW.width}, ${WINDOW.height}); } return true; })()`);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");
  return { c, m };
}

/** Key and awake, as the window is for someone looking at it: not greyed, not quiet. */
const holdKey = (c) => evalIn(c, `(() => {
  const root = document.documentElement;
  const clear = () => { root.removeAttribute("data-window-inactive"); root.removeAttribute("data-quiet"); };
  clear();
  new MutationObserver(clear).observe(root, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] });
  return true;
})()`);

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 5000, `palette row ${label}`);
  await sleep(600);
}

async function shot(c, tag, clip, scale = 2) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale } } : {}) });
  fs.writeFileSync(path.join(SHOTS, `${tag}.png`), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${path.join(SHOTS, `${tag}.png`)}`);
  return data;
}

/** The colour of the window's own capture at CSS points, through a canvas in the renderer. */
async function pixels(c, at) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
    const k = img.naturalWidth / window.innerWidth;
    return ${JSON.stringify(at)}.map(([x, y]) => Array.from(g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)));
  })()`);
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

const hover = (c, x, y) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

async function openSettings(c) {
  await evalIn(c, `(async () => {
    if (document.querySelector(".settings-page-pane")) return true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  })()`);
  await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 10_000, "settings");
  await sleep(500);
}

/** A visible switch in the given state, scrolled into view, and where its track's free end is. */
const findSwitch = (c, on) => evalIn(c, `(() => {
  const sw = [...document.querySelectorAll(".settings-page-pane input.switch")].find((s) => s.checked === ${on} && !s.disabled && s.offsetParent !== null);
  if (!sw) return null;
  sw.scrollIntoView({ block: "center" });
  const r = sw.getBoundingClientRect();
  // The end of the track the knob is NOT at: right for off, left for on.
  return { x: r.x, y: r.y, w: r.width, h: r.height, free: [${on} ? r.x + 5 : r.right - 5, r.y + r.height / 2], centre: [r.x + r.width / 2, r.y + r.height / 2] };
})()`);

async function switchFace(c, face) {
  await openSettings(c);
  // A page of settings with switches on it; General has several, some on by default.
  // Each is found (and scrolled to) just before it is read: finding the other one scrolls the page.
  const on = await until(() => findSwitch(c, true), 5000, "an on switch").catch(() => null);
  const off = await until(() => findSwitch(c, false), 5000, "an off switch").catch(() => null);
  check(`${face}: settings shows a switch that is on, and one that is off`, !!on && !!off, { on, off });
  if (!on || !off) return;
  Object.assign(on, await findSwitch(c, true));
  await sleep(300);
  await hover(c, 5, 5);
  await sleep(400);
  const [onRest] = await pixels(c, [on.free]);
  await hover(c, ...on.centre);
  await sleep(400);
  const [onHover] = await pixels(c, [on.free]);
  await shot(c, `switch-on-hover-${face}`, { x: on.x - 220, y: on.y - 14, width: on.w + 240, height: on.h + 28 }, 4);
  const offNow = await findSwitch(c, false);
  await hover(c, 5, 5);
  await sleep(400);
  const [offRest] = await pixels(c, [offNow.free]);
  await hover(c, ...offNow.centre);
  await sleep(400);
  const [offHover] = await pixels(c, [offNow.free]);
  await shot(c, `switch-off-hover-${face}`, { x: offNow.x - 220, y: offNow.y - 14, width: offNow.w + 240, height: offNow.h + 28 }, 4);
  await hover(c, 5, 5);
  note(`${face} switch pixels`, { onRest, onHover, offRest, offHover });
  check(`${face}: an ON switch under the pointer stays the accent — still saturated, not the off track's grey`,
    chroma(onHover) > 0.7 * chroma(onRest) && chroma(onHover) > 60, { onRest, onHover });
  const step = lum(onHover) - lum(onRest);
  check(`${face}: …and moves ${face === "dark" ? "lighter" : "deeper"}`, face === "dark" ? step > 4 : step < -4, { step });
  check(`${face}: an OFF switch still answers the pointer on its neutral track`, chroma(offHover) < 30 && Math.abs(lum(offHover) - lum(offRest)) > 1, { offRest, offHover });
}

const PANE = `[...document.querySelectorAll('.browser-pane')].find((p) => p.offsetParent !== null)`;

async function shimmerFace(c, face) {
  await until(() => evalIn(c, `!!${PANE}?.querySelector('.browser-connecting .reach-mark[data-busy]')`), 15_000, "the waiting mark");
  // The mark is held back 600ms and then fades up; let it arrive.
  await sleep(1200);
  const box = await evalIn(c, `(() => { const r = ${PANE}.querySelector('.browser-connecting .reach-mark').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  // Where the sweep's brightest point is across the mark, at a few moments of one pass.
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const xs = Array.from({ length: 13 }, (_, k) => box.x + 2 + (k * (box.w - 4)) / 12);
    // The mark's middle band — clear of the doorway, which runs from the centre to the lower right.
    const row = await pixels(c, xs.map((x) => [x, box.y + box.h * 0.3]));
    const l = row.map(lum);
    samples.push({ peakAt: l.indexOf(Math.max(...l)), spread: Math.round(Math.max(...l) - Math.min(...l)) });
    if (i < 3) await shot(c, `shimmer-${face}-${i}`, { x: box.x - 16, y: box.y - 16, width: box.w + 32, height: box.h + 32 }, 6);
    await sleep(190);
  }
  note(`${face} shimmer`, samples);
  check(`${face}: a light crosses the mark while the page is on its way`, samples.some((s) => s.spread > 25), samples);
  check(`${face}: …and it moves`, new Set(samples.map((s) => s.peakAt)).size >= 3, samples);
  const pane = await evalIn(c, `(() => { const r = ${PANE}.closest('.panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await shot(c, `connecting-pane-${face}`, pane, 1);
}

async function toolRowsFace(c, face) {
  await evalIn(c, `(() => { for (const g of document.querySelectorAll('.session-pane .tool-group-row[aria-expanded="false"]')) g.click(); return true; })()`);
  await sleep(500);
  const drawn = await evalIn(c, `[...document.querySelectorAll('.session-pane .tool-card .tool-status [data-glyph]')].map((g) => ({ glyph: g.dataset.glyph, brand: g.querySelector('svg')?.getAttribute('data-brand') ?? null }))`);
  note(`${face} tool glyphs`, drawn);
  const want = MCP_CALLS.map(([, , g]) => g);
  check(`${face}: every MCP call leads with its app's mark, Realm's own with its pane's glyph`, JSON.stringify(drawn.map((d) => d.glyph)) === JSON.stringify(want), { drawn: drawn.map((d) => d.glyph), want });
  check(`${face}: …drawn as the vendor's own mark`, ["gmail", "googleCalendar", "googleDrive", "linear", "notion", "posthog", "stripe"].every((b) => drawn.some((d) => d.brand === b)), drawn);
  const clip = await evalIn(c, `(() => {
    const cards = [...document.querySelectorAll('.session-pane .tool-card')];
    const rs = cards.map((x) => x.getBoundingClientRect());
    const top = Math.min(...rs.map((r) => r.top)), bottom = Math.max(...rs.map((r) => r.bottom));
    const left = Math.min(...rs.map((r) => r.left)), right = Math.max(...rs.map((r) => r.right));
    return { x: left - 12, y: top - 12, width: Math.min(right - left, 760) + 24, height: bottom - top + 24 };
  })()`);
  await shot(c, `mcp-tool-rows-${face}`, clip, 2);
}

async function shutDown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  api = null;
  electron?.kill("SIGKILL");
  electron = null;
  await sleep(500);
  daemonPids.push(...(await stopDaemons(home, daemonPids)));
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
}

async function main() {
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  await startSite();
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify([{ on: "Find the open invoice", emit: [
    ...MCP_CALLS.map(([name, input]) => ({ kind: "tool", name, input, result: "ok" })),
    { kind: "text", text: "The open invoice is INV-2041, sent to the old portal link." },
  ] }]));
  const { c } = await launch(scriptFile);

  // Onboarding makes the space. Its first session runs a REAL engine, so it goes to the scripted
  // agent before anything else, and nothing is ever typed into it.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  await api.call("sessions.send", { id: session.id, text: "Find the open invoice", attachments: [], mentions: [] });
  await until(async () => {
    const evs = await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 2000 });
    return evs.some((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("INV-2041"));
  }, 30_000, "the scripted turn");
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.session-pane .tool-group, .session-pane .tool-card').length > 0`), 15_000, "the tool rows");
  await sleep(800);

  // A browser tab in the session's side panel, on a page that never answers.
  await evalIn(c, `(() => { document.querySelector('.session-pane')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.activeElement?.blur(); return true; })()`);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4 | 8, key: "B", code: "KeyB", windowsVirtualKeyCode: 66 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4 | 8, key: "B", code: "KeyB", windowsVirtualKeyCode: 66 });
  await until(() => evalIn(c, `!!${PANE}?.querySelector('.browser-address input')`), 10_000, "a browser tab");
  await evalIn(c, `(() => {
    const input = ${PANE}.querySelector('.browser-address input'); input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "http://127.0.0.1:${SITE_PORT}/search?q=invoice");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);

  for (const face of ["dark", "light"]) {
    if (face === "light") await paletteRow(c, "Theme: Light");
    await shimmerFace(c, face);
    await toolRowsFace(c, face);
    await switchFace(c, face);
    // Back to the session for the next face.
    await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)}))?.click(); return true; })()`);
    await sleep(800);
  }
  // Reduced motion: the mark is simply drawn, nothing crosses it.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(400);
  const still = await evalIn(c, `(() => { const g = ${PANE}?.querySelector('.reach-mark-glint, .reach-mark-shine'); return g ? getComputedStyle(g).display : "absent"; })()`);
  check("reduced motion: no light crosses the mark", still === "none" || still === "absent", still);
}

try {
  await main();
} catch (e) {
  console.log(`FAIL run ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  await shutDown();
  for (const s of servers) s.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`shots in ${SHOTS}`);
}
