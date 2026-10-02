/**
 * Live check for what a person adds to a side pane (run with: pnpm build && node apps/desktop/scripts/side-pane-more-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, with the ACP stub agent standing in for a model (its
 * REVEAL turn hands back the session's own gateway, so this script opens a browser AS that session),
 * and checks, in the real window:
 *
 *   1. The side pane's "+" opens a menu that sits clear of the browser view under it — the view's
 *      bounds asked of main, over its inspector, never of the page.
 *   2. New tab adds a blank browser tab after the one showing, on screen, with the address field
 *      focused and the page behind it off screen.
 *   3. New tab in full view does the same and fills the host with the side pane.
 *   4. ⌘⇧B and ⌥⌘B do both from the keyboard.
 *
 * Ports: LIVE_SERVER_PORT (8964), LIVE_CDP_PORT (9364), LIVE_MAIN_INSPECT_PORT (9464), LIVE_SITE_PORT
 * (8974). Touches only a scratch dir; kills only what is listening on its own ports. Browses nothing
 * but its own 127.0.0.1 fixture. Nothing is billed: the sessions are titled and on the stub agent, and
 * REALM_ENABLE_FAKE_AGENT=1 turns the recap off. Nothing is ever typed into the onboarding session.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9364);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8964);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8974);
/** Main's own inspector — the one place that knows where a native view is and whether it shows. */
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9464);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-side-pane-more-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TITLE = "Side pane more live check";
/** The window's real content size. Set on the window itself rather than emulated: an emulated
 *  device scale factor moves the renderer's pixel ratio and not main's, and the native views — which
 *  main places from the renderer's rects — would land somewhere else than the DOM says they are. */
const WINDOW = { width: 1500, height: 900 };
const OUT = (tag) => path.join(os.tmpdir(), `realm-side-pane-more-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;

const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

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

function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
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

/** Job pages, each with its own title, so a tab names which one it is. */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const n = /^\/job-(\d)$/.exec(req.url ?? "")?.[1] ?? "0";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Job ${n}</title><body style="margin:0;background:#fff"><h1>Job ${n}</h1></body>`);
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A chord as the window gets it from the keyboard: down and up, with the modifiers held. */
async function press(c, { key, code, keyCode, meta = false, shift = false, alt = false }) {
  const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
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
      REALM_GEMINI_BIN: agent,
      REALM_ENABLE_FAKE_AGENT: "1",
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

  // The lead's cards, answered as a user would: allow. Only the lead's — other sessions' cards are
  // what the later checks answer through the UI.
  let leadId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.event?.type !== "permission_request" || payload.sessionId !== leadId) return;
    void api.call("sessions.respondPermission", { id: payload.sessionId, requestId: payload.event.payload.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
  leadId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the lead alone, so every pane after this is one the checks asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  await api.call("sessions.send", { id: leadId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: leadId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "side-pane-more-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = async (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });

  const panes = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].map((p) => ({
    leaf: p.dataset.leafId,
    tabs: [...p.querySelectorAll('[role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true' })),
    title: p.querySelector('.panel-title')?.textContent ?? null, focused: p.hasAttribute('data-focused'),
    width: Math.round(p.getBoundingClientRect().width) }))`);
  const sidePane = async () => (await panes()).find((p) => p.tabs.length > 0) ?? null;
  /** Every fixture page's native view, as main has it: shown or not, and where. */
  const views = () => inMain(m, `(() => {
    const { BrowserWindow, WebContentsView } = require("electron");
    const out = {};
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
      if (!(v instanceof WebContentsView)) continue;
      const url = v.webContents.getURL();
      if (!url.startsWith(${JSON.stringify(SITE)})) continue;
      out[url.slice(${SITE.length})] = { shown: v.getVisible(), ...v.getBounds() };
    }
    return out;
  })()`);
  const onScreen = (v) => Object.entries(v).filter(([, x]) => x.shown && x.width > 0).map(([k]) => k).sort();
  /** The keyboard into the lead's pane, as a click there puts it, and then out of any text field. */
  const intoLead = async () => {
    await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
    await sleep(400);
    await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
    await sleep(100);
  };

  // ── The lead's agent opens a browser: a side pane with one tab, its view on screen ────────────
  const opened = await call("realm-browser__browser_open", { url: `${SITE}/job-1` });
  if (opened.isError) throw new Error(`browser_open: ${text(opened)}`);
  await until(async () => (await sidePane())?.tabs[0]?.name === "Job 1", 20_000, "Job 1's tab");
  await sleep(1000);
  const v0 = await views();
  note("views with Job 1 showing", v0);
  check("the agent's browser is a side pane tab whose view is on screen", onScreen(v0).join() === "/job-1", v0);

  // ── 1. The + opens a menu clear of the view ────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.pane-tabs-add').click(); return true; })()`);
  const menu = await until(() => evalIn(c, `(() => { const el = document.querySelector('.menu[aria-label="New tab"]');
    if (!el || getComputedStyle(el).visibility !== 'visible') return null;
    const r = el.getBoundingClientRect(); const a = document.querySelector('.pane-tabs-add').getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, anchor: { x: a.x, y: a.y, width: a.width, height: a.height },
      items: [...el.querySelectorAll('[role=menuitem]')].map((b) => b.textContent) }; })()`), 5_000, "the + menu");
  await sleep(250); // the 140ms entrance, so the capture shows the menu at rest
  const view = (await views())["/job-1"];
  note("the + menu, its anchor, and the view under the strip", { menu: menu.rect, anchor: menu.anchor, view });
  check("the + offers New tab and New tab in full view, with their chords", menu.items.join("|") === "New tab⌘⇧B|New tab in full view⌘⌥B", menu.items);
  const natural = { x: menu.anchor.x, y: menu.anchor.y + menu.anchor.height + 4, width: menu.rect.width, height: menu.rect.height };
  check("a menu hung straight off the + would have covered the view — the case this guards", intersects(natural, view), { natural, view });
  check("the + menu sits clear of the browser view (main's bounds, not the page's)", view.shown && !intersects(menu.rect, view), { menu: menu.rect, view });
  check("…and clear of the + itself, so the control that opened it stays in sight", !intersects(menu.rect, menu.anchor), { menu: menu.rect, anchor: menu.anchor });
  await shot(c, "plus-menu");

  // ── 2. New tab: a blank tab after the one showing, the address field focused ───────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('.menu[aria-label="New tab"] [role=menuitem]')][0].click(); return true; })()`);
  const two = await until(async () => { const s = await sidePane(); return s?.tabs.length === 2 ? s : null; }, 10_000, "a second tab");
  check("New tab adds a tab after the one showing, and shows it", two.tabs[0].name === "Job 1" && two.tabs[1].selected, two.tabs);
  check("…with the keyboard in the side pane", two.focused === true, two);
  /* Measured, not read off the stylesheet: the "+" after the tabs is what sized the strip from them,
     and the first build of it squeezed every tab to the width of its words. */
  const titles = await evalIn(c, `[...document.querySelectorAll('.pane-tab')].map((t) => { const n = t.querySelector('.pane-tab-title');
    return { name: n.textContent, tab: Math.round(t.getBoundingClientRect().width), clipped: n.scrollWidth > n.clientWidth }; })`);
  check("each tab keeps its whole name with room to spare in the strip", titles.every((t) => !t.clipped && t.tab >= 170), titles);
  const focus = await until(() => evalIn(c, `document.activeElement?.getAttribute('aria-label') === 'Address' ? 'Address' : null`), 5_000, "the address field focused").catch(() => evalIn(c, `document.activeElement?.outerHTML.slice(0, 120) ?? null`));
  check("…and the address field focused, as a fresh tab's is", focus === "Address", focus);
  await sleep(600);
  const v2 = await views();
  check("Job 1's view is off screen behind the new tab, and still live", onScreen(v2).length === 0 && "/job-1" in v2, v2);
  await shot(c, "new-tab");

  // ── 3. New tab in full view: the side pane fills the host ──────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.pane-tabs-add').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label="New tab"]')`), 5_000, "the + menu again");
  await evalIn(c, `(() => { [...document.querySelectorAll('.menu[aria-label="New tab"] [role=menuitem]')][1].click(); return true; })()`);
  const full = await until(async () => {
    const ps = await panes();
    const zoomed = await evalIn(c, `document.querySelector('.panehost')?.hasAttribute('data-zoomed') ?? false`);
    return zoomed && ps.length === 1 && ps[0].tabs.length === 3 ? ps : null;
  }, 10_000, "full view").catch(async () => ({ timeout: true, panes: await panes() }));
  check("New tab in full view adds a third tab and the side pane alone fills the host", Array.isArray(full) && full[0].tabs[2].selected && full[0].width >= WINDOW.width - 400, full);
  await shot(c, "full-view");

  // ── 4. The same from the keyboard ─────────────────────────────────────────────────────────
  // ⌘⇧F, back from full view — from outside the new tab's address field, which a chord typed into is
  // the field's.
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await press(c, { key: "F", code: "KeyF", keyCode: 70, meta: true, shift: true });
  await until(async () => (await panes()).length === 2, 5_000, "unfocused").catch(() => {});
  // Into the lead, then out of any field: a ⌘⇧B typed into a text box is the box's. The blur waits
  // for the pane to settle — a pane taking focus hands its prompter the caret a render later.
  await intoLead();
  await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true });
  const four = await until(async () => { const s = await sidePane(); return s?.tabs.length === 4 ? s : null; }, 10_000, "⌘⇧B's tab").catch(() => sidePane());
  check("⌘⇧B from the lead opens a fourth tab in its side pane", four?.tabs.length === 4 && four.tabs.some((t) => t.selected), four?.tabs);
  await intoLead();
  await press(c, { key: "∫", code: "KeyB", keyCode: 66, meta: true, alt: true });
  const five = await until(async () => {
    const ps = await panes();
    const zoomed = await evalIn(c, `document.querySelector('.panehost')?.hasAttribute('data-zoomed') ?? false`);
    return zoomed && ps.length === 1 && ps[0].tabs.length === 5 ? ps : null;
  }, 10_000, "⌥⌘B's full view").catch(async () => ({ timeout: true, panes: await panes() }));
  check("⌥⌘B opens a fifth tab with the side pane filling the host", Array.isArray(five), five);
  await evalIn(c, `(() => { document.activeElement?.blur(); return true; })()`);
  await press(c, { key: "F", code: "KeyF", keyCode: 70, meta: true, shift: true });
  await sleep(300);
}

/** The window as the renderer draws it. Native browser views are not in a DOM capture, so a tab's
 *  page shows as the pane's own ground; where the view IS comes from main's bounds instead. */
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
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
