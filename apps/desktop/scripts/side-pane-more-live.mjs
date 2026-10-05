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
 *   5. A blank tab shows the session's tools, and each one picked takes the tab's place: Terminal
 *      and Machine as tabs where it stood, Files through the ⌘P palette, and Documents — already
 *      open by then — by going to the tab that has it.
 *   6. Peek, from its row on the Notifications page, at a session in another space that is waiting on
 *      a card: a tab of the lead's side pane, eye and italic, its card answered in place, no prompter
 *      — never in the window's saved view. Peek from a sidebar row's menu, then Open session: the session takes the lead's place in the main view, from this space
 *      or another, with nothing switched. (What waits on you is the sidebar's Needs you list now —
 *      sidebar-rail-live measures it.)
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
      // The app draws its menus as native OS menus, which CDP cannot click; this asks for drawn ones.
      REALM_HTML_MENUS: "1",
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
    tabs: [...p.querySelectorAll('.pane-tabs [role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true' })),
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
  const tools = await until(() => evalIn(c, `(() => { const page = [...document.querySelectorAll('.new-tab')].find((p) => p.offsetParent !== null);
    return page ? [...page.querySelectorAll('.new-tab-row')].map((b) => b.textContent) : null; })()`), 5_000, "the new-tab page").catch(() => null);
  check("the blank tab shows the session's tools in place of an empty page, Files with ⌘P", tools?.join("|") === "Files⌘P|Terminal|Documents|Simulator|Machine", tools);
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
  await until(async () => (await panes()).length === 2, 5_000, "unfocused again").catch(() => {});

  // ── 5. The tools on a blank tab, each taking the tab's place ───────────────────────────────
  /** What the space holds, from the server: which blank tabs are gone, and what replaced them. */
  const listItems = () => api.call("items.list", { spaceId: space.id });
  const count = (list, kind) => list.filter((i) => i.kind === kind).length;
  const tabNames = async () => (await sidePane())?.tabs.map((t) => t.name) ?? [];
  /** Bring the i-th tab forward and pick one of its new-tab page's tools. */
  const pickTool = async (index, label) => {
    await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')][${index}].click(); return true; })()`);
    await until(() => evalIn(c, `[...document.querySelectorAll('.new-tab')].some((p) => p.offsetParent !== null)`), 5_000, `tab ${index}'s new-tab page`);
    await evalIn(c, `(() => { const page = [...document.querySelectorAll('.new-tab')].find((p) => p.offsetParent !== null);
      [...page.querySelectorAll('.new-tab-row')].find((b) => b.querySelector('.new-tab-row-label').textContent === ${JSON.stringify(label)}).click(); return true; })()`);
  };
  const columns = async () => (await panes()).length;
  const before = await listItems();
  note("tabs before the tools", await tabNames());

  await pickTool(4, "Terminal");
  const terminal = await until(async () => (await listItems()).find((i) => i.kind === "terminal"), 10_000, "the terminal item");
  const afterTerminal = await until(async () => { const t = await tabNames(); return t[4] === terminal.title ? t : null; }, 10_000, "the terminal tab").catch(() => tabNames());
  const k1 = await listItems();
  check("Terminal takes the fifth tab's place, and the blank browser is gone from the space",
    afterTerminal[4] === terminal.title && afterTerminal.length === 5 && count(k1, "browser") === count(before, "browser") - 1 && (await columns()) === 2,
    { tabs: afterTerminal, terminal: terminal.title, browsers: [count(before, "browser"), count(k1, "browser")] });
  await shot(c, "terminal-tab");

  // Files: the ⌘P palette, on a file in the lead's checkout, picked from the fourth tab.
  fs.writeFileSync(path.join(journal.newParams.cwd, "notes.md"), "# Notes\n\nWritten by the live check.\n");
  await pickTool(3, "Files");
  await until(() => evalIn(c, `document.querySelector('.palette input')?.placeholder === 'Open a file…'`), 5_000, "the file palette");
  await evalIn(c, `(() => { document.querySelector('.palette input').focus(); return true; })()`);
  await c.send("Input.insertText", { text: "notes" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.palette-opt')].some((o) => o.textContent.includes('notes.md'))`), 10_000, "notes.md in the palette");
  await shot(c, "files-palette");
  await evalIn(c, `(() => { [...document.querySelectorAll('.palette-opt')].find((o) => o.textContent.includes('notes.md')).click(); return true; })()`);
  const docs = await until(async () => (await listItems()).find((i) => i.kind === "documents"), 10_000, "the documents item");
  const afterFiles = await until(async () => {
    const t = await tabNames();
    const shut = await evalIn(c, `!document.querySelector('.palette')`);
    return shut && t[3] === docs.title ? t : null;
  }, 10_000, "the documents tab").catch(() => tabNames());
  const k2 = await listItems();
  check("the file picked takes the fourth tab's place as the documents pane, in the side pane, not a split",
    afterFiles[3] === docs.title && afterFiles.length === 5 && count(k2, "browser") === count(k1, "browser") - 1 && (await columns()) === 2,
    { tabs: afterFiles, documents: docs.title, columns: await columns() });
  await sleep(800);
  await shot(c, "documents-tab");

  // Documents from the third tab: the pane is one per checkout and already a tab, so it is gone to.
  await pickTool(2, "Documents");
  const afterDocs = await until(async () => { const t = await tabNames(); return t.length === 4 ? t : null; }, 10_000, "the third tab gone").catch(() => tabNames());
  const sel = (await sidePane())?.tabs.find((t) => t.selected)?.name;
  const k3 = await listItems();
  check("Documents, already open, is gone to — and the blank tab still goes", afterDocs.length === 4 && sel === docs.title
    && count(k3, "documents") === 1 && count(k3, "browser") === count(k2, "browser") - 1, { tabs: afterDocs, selected: sel });

  await pickTool(1, "Machine");
  const afterMachine = await until(async () => { const t = await tabNames(); return t[1] === "New machine" ? t : null; }, 10_000, "the machine tab").catch(() => tabNames());
  const k4 = await listItems();
  check("Machine takes the second tab's place, and the last blank browser is gone", afterMachine[1] === "New machine" && afterMachine.length === 4
    && count(k4, "browser") === 1, { tabs: afterMachine, browsers: count(k4, "browser") });
  await shot(c, "machine-tab");

  // ── 6. Peek ──────────────────────────────────────────────────────────────────────────────
  const space2 = await api.call("spaces.create", { profileId: space.profileId, name: "Homework" });
  const { session: other } = await api.call("sessions.create", { spaceId: space2.id, agentKind: "acp:gemini", title: "Peek target", permissionMode: "default" });
  await api.call("sessions.send", { id: other.id, text: "PERMIT", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: other.id })).status === "waiting_permission", 30_000, "the peek target waiting on a card");
  const otherItem = (await api.call("items.list", { spaceId: space2.id })).find((i) => i.refId === other.id);
  /** Every item the window's saved view names, on screen or kept in a side pane — what a relaunch
   *  would restore, as the profile's `ui.view:<id>` row has it. */
  const savedIds = async () => {
    const { value } = await api.call("settings.get", { key: `ui.view:${space.profileId}` });
    const walk = (n) => (n.type === "leaf" ? [...(n.tabs ?? []), ...(n.itemId ? [n.itemId] : [])] : n.children.flatMap(walk));
    const kept = Object.values(value?.sidePanes ?? {}).flatMap((p) => p.tabs);
    return [...new Set([...(value?.layout ? walk(value.layout) : []), ...kept])];
  };
  const peekTab = () => evalIn(c, `(() => { const t = document.querySelector('.pane-tab[data-peek] [role=tab]');
    return t ? { label: t.getAttribute('aria-label'), italic: getComputedStyle(t.querySelector('.pane-tab-title')).fontStyle, draggable: t.getAttribute('draggable') } : null; })()`);
  // The current space is the focused session's, which its pane's crumb names.
  const activeSpace = () => evalIn(c, `document.querySelector('.panel[data-focused] .panel-crumb')?.getAttribute('aria-label') ?? null`);
  const focusedTitle = () => evalIn(c, `document.querySelector('.panehost .panel[data-focused] .panel-title')?.textContent ?? null`);
  const openFeed = async () => {
    await evalIn(c, `(() => { [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Notifications')).click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('button[aria-label="Peek at Peek target"]')`), 10_000, "the notification row's peek on the target");
  };

  await intoLead();
  await openFeed();
  await shot(c, "feed-peek");
  await evalIn(c, `(() => { document.querySelector('button[aria-label="Peek at Peek target"]').click(); return true; })()`);
  const tab = await until(peekTab, 10_000, "the peek's tab").catch(() => null);
  const page = await evalIn(c, `!!document.querySelector('.notifications-page-pane')`);
  // Nothing switched: the lead's own pane is still on screen, its crumb naming Live. (The focus may be
  // in the side pane now, which carries no crumb.)
  const leadCrumb = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].find((p) => p.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)})?.querySelector('.panel-crumb')?.getAttribute('aria-label') ?? null`);
  check("Peek from a notification row opens another space's session as a tab of the lead's side pane, the page out of the way",
    tab?.label === "Peek: Peek target" && !page && (await leadCrumb()) === "Open Live", { tab, page, lead: await leadCrumb() });
  check("…marked as a peek: an eye and an italic title, and it does not drag", tab?.italic === "italic" && tab?.draggable === "false", tab);
  const peekPane = () => evalIn(c, `(() => { const p = document.querySelector('.session-pane[data-peek]');
    return p ? { card: p.querySelector('.permission-card')?.textContent?.slice(0, 80) ?? null, composer: !!p.querySelector('.composer'),
      bar: p.querySelector('.peek-bar')?.textContent ?? null } : null; })()`);
  const pane = await until(async () => { const p = await peekPane(); return p?.card ? p : null; }, 10_000, "the peek's card").catch(peekPane);
  check("the peek shows the waiting card and no prompter, and says which space it is from",
    !!pane?.card && pane.composer === false && pane.bar === "Peek · HomeworkOpen session", pane);
  await sleep(500);
  await shot(c, "peek");

  // The saved view: a layout write with the peek on screen, then what the server holds.
  await evalIn(c, `(() => { [...document.querySelectorAll('.pane-tabs [role=tab]')].find((t) => t.textContent === 'Job 1').click(); return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => { document.querySelector('.pane-tab[data-peek] [role=tab]').click(); return true; })()`);
  await sleep(800);
  const saved1 = await savedIds();
  check("the peek is never written into the window's saved view", saved1.length > 0 && !saved1.includes(otherItem.id), { saved: saved1, peek: otherItem.id });

  // The card, answered in the peek.
  await evalIn(c, `(() => { document.querySelector('.session-pane[data-peek] .permission-card button[aria-label="Allow"]').click(); return true; })()`);
  const answered = await until(async () => { const st = (await api.call("sessions.get", { id: other.id })).status; return st !== "waiting_permission" ? st : null; }, 10_000, "the card answered").catch(() => "waiting_permission");
  const cardGone = await until(async () => { const p = await peekPane(); return p && !p.card ? true : null; }, 5_000, "the card gone").catch(() => false);
  check("Allow in the peek answers the other space's card", answered !== "waiting_permission" && cardGone === true, { status: answered });

  // A same-space session, from its sidebar row's menu, then Open session: the tab stays, and is saved.
  const { session: second, itemId: secondItem } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: "Second session", permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item')].some((r) => r.textContent.includes('Second session'))`), 10_000, "Second session's row");
  await intoLead();
  await evalIn(c, `(() => { const row = [...document.querySelectorAll('.item-list .item')].find((r) => r.textContent.includes('Second session'));
    const b = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 20, clientY: b.y + 10 })); return true; })()`);
  const offered = await until(() => evalIn(c, `[...document.querySelectorAll('.menu [role=menuitem]')].map((b) => b.textContent)`), 5_000, "the row's menu");
  check("a session row's menu offers Peek for a session not on screen", offered.includes("Peek"), offered);
  await evalIn(c, `(() => { [...document.querySelectorAll('.menu [role=menuitem]')].find((b) => b.textContent === 'Peek').click(); return true; })()`);
  const tab2 = await until(peekTab, 10_000, "the second peek's tab").catch(() => null);
  check("…and peeks at it beside the lead", tab2?.label === "Peek: Second session", tab2);
  await evalIn(c, `(() => { [...document.querySelectorAll('.session-pane[data-peek] .peek-bar button')].find((b) => b.textContent === 'Open session').click(); return true; })()`);
  await sleep(800);
  const saved2 = await savedIds();
  const inFront = await focusedTitle();
  check("Open session on this space's peek takes the lead's place in the main view, saved with it",
    (await peekTab()) === null && inFront === "Second session" && saved2.includes(secondItem), { focused: inFront, saved: saved2.includes(secondItem) });
  void second;
  // Back to the lead for the next peek, the way a person would: its row.
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await until(async () => ((await focusedTitle()) === TITLE ? true : null), 10_000, "the lead in front again");

  // Another space's, Open session: that space, with the session in front.
  await intoLead();
  await openFeed();
  await evalIn(c, `(() => { document.querySelector('button[aria-label="Peek at Peek target"]').click(); return true; })()`);
  await until(peekTab, 10_000, "the third peek's tab");
  await evalIn(c, `(() => { [...document.querySelectorAll('.session-pane[data-peek] .peek-bar button')].find((b) => b.textContent === 'Open session').click(); return true; })()`);
  await until(async () => ((await focusedTitle()) === "Peek target" ? true : null), 10_000, "Peek target in front").catch(() => {});
  await sleep(600);
  const there = await evalIn(c, `(() => { const p = document.querySelector('.panehost .panel[data-focused]'); return p ? p.querySelector('.panel-title')?.textContent ?? [...p.querySelectorAll('.pane-tabs [role=tab][aria-selected=true]')].map((t) => t.textContent).join() : null; })()`);
  check("Open session on another space's peek brings it into the main view, in front, with nothing switched", (await activeSpace()) === "Open Homework" && there === "Peek target" && (await peekTab()) === null, { space: await activeSpace(), focused: there });
  await shot(c, "peek-opened");
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
