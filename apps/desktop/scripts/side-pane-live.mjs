/**
 * Live check for the session side pane (run with: pnpm build && node apps/desktop/scripts/side-pane-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, with the ACP stub agent standing in for a model (its
 * REVEAL turn hands back the session's own gateway, so this script calls tools AS that session), and
 * checks, in the real window:
 *
 *   1. Three `browser_open` calls are ONE side pane beside the session with three tabs — not three
 *      columns — the newest showing, and the keyboard still in the session.
 *   2. Only the tab showing has its native view on screen — asked of main, over its inspector — and
 *      every tab's page is live, so an agent can drive the ones behind it.
 *   3. A click on a tab brings that browser forward.
 *   4. An `agent_start` child gets no pane; the session's bar says "1 working", and a click in its
 *      list previews the child as a tab of the same side pane.
 *
 * Ports: LIVE_SERVER_PORT (8821), LIVE_CDP_PORT (9261), LIVE_SITE_PORT (8822), LIVE_MAIN_INSPECT_PORT (9262). Touches only a scratch
 * dir; kills only what is listening on its own ports. Browses nothing but its own 127.0.0.1 fixture.
 * Nothing is billed: the sessions are titled and on the stub agent, and REALM_ENABLE_FAKE_AGENT=1
 * turns the recap off.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9261);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8821);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8822);
/** Main's own inspector — the one place that knows which native view is on screen. */
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9262);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-side-pane-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TITLE = "Side pane live check";
const VIEWPORT = { width: 1500, height: 900 };
const OUT = (tag) => path.join(os.tmpdir(), `realm-side-pane-${tag}.png`);
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

/** Three job pages, each with its own title, so a tab names which one it is. */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const n = /^\/job-(\d)$/.exec(req.url ?? "")?.[1] ?? "0";
      res.writeHead(200, { "content-type": "text/html" });
      // Frames, counted: a view on screen is composited and ticks requestAnimationFrame; a hidden one
      // is not drawn and does not. `visibilityState` cannot tell them apart — the views run with
      // background throttling off, so a hidden page reads as visible to itself on purpose.
      res.end(`<!doctype html><title>Job ${n}</title><h1>Job ${n}</h1>`);
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

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
  // Chromium stops laying out a window macOS says is covered — and a window this script starts from
  // the background opens BEHIND whatever the person at the Mac has in front. The browser pane is a
  // native view sized from that layout, so it would get no bounds: every element offscreen and every
  // click lost (measured: the walk's first click "changed nothing" until these were passed).
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  // Cards, answered as a user would: allow every one.
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.event?.type !== "permission_request") return;
    void api.call("sessions.respondPermission", { id: payload.sessionId, requestId: payload.event.payload.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
  const sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  // One pane: the session alone, so every pane after this is one an agent asked for.
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);
  const panes = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel')].map((p) => ({ tabs: [...p.querySelectorAll('[role=tab]')].map((t) => ({ name: t.textContent, selected: t.getAttribute('aria-selected') === 'true' })), title: p.querySelector('.panel-title')?.textContent ?? null, focused: p.hasAttribute('data-focused'), width: Math.round(p.getBoundingClientRect().width) }))`);
  note("panes before", await panes());

  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "side-pane-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = async (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });

  // ── 1. Three browsers are one side pane with three tabs ────────────────────────────────────
  const ids = [];
  for (const n of [1, 2, 3]) {
    const r = await call("realm-browser__browser_open", { url: `${SITE}/job-${n}` });
    if (r.isError) throw new Error(`browser_open: ${text(r)}`);
    ids.push(/pane (\S+) at/.exec(text(r))?.[1]);
  }
  const after = await until(async () => {
    const ps = await panes();
    const s = ps.find((p) => p.tabs.length === 3);
    return s && s.tabs.every((t) => t.name.startsWith("Job")) ? ps : null;
  }, 20_000, "three tabs titled by their pages").catch(async (e) => { note("panes at timeout", await panes()); throw e; });
  note("panes after three browser_open", after);
  check("three agent-opened browsers are two panes, not four columns", after.length === 2, after.length);
  const sideP = after.find((p) => p.tabs.length === 3);
  check("the side pane holds them as three tabs, the newest showing", sideP.tabs.map((t) => t.selected).join() === "false,false,true", sideP.tabs);
  check("the keyboard stays in the session", after.find((p) => p.title === TITLE)?.focused === true, after.map((p) => p.focused));
  check("the side pane gets half the window, not a fifth", sideP.width > 500, sideP.width);
  await shot(c, "three-tabs");

  // ── 2. Only the tab showing is on screen ────────────────────────────────────────────────
  /** What main says about each fixture page's native view: shown or not, and where. Asked of the
   *  WebContentsView itself over main's inspector — a page cannot tell (the views run unthrottled, so
   *  a hidden page reads as visible, ticks frames, and keeps its last viewport size), and a capture
   *  of the window needs Screen Recording. */
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const mainC = cdp(mainTarget.webSocketDebuggerUrl); await mainC.ready;
  const views = async () => {
    const r = await mainC.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, expression: `(() => {
      const { BrowserWindow, WebContentsView } = require("electron");
      const out = {};
      for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
        if (!(v instanceof WebContentsView)) continue;
        const url = v.webContents.getURL();
        if (!url.startsWith(${JSON.stringify(SITE)})) continue;
        const b = v.getBounds();
        out[url.slice(${SITE.length})] = { shown: v.getVisible(), width: b.width };
      }
      return out;
    })()` });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const onScreen = (v) => Object.entries(v).filter(([, x]) => x.shown && x.width > 0).map(([k]) => k).sort();
  await sleep(800);
  const v3 = await views();
  note("views, Job 3's tab showing", v3);
  check("every tab's page is live — three views for three tabs", Object.keys(v3).length === 3, Object.keys(v3));
  check("only Job 3's view is on screen", onScreen(v3).join() === "/job-3", v3);

  // ── 3. A click brings a tab forward ─────────────────────────────────────────────────────
  await evalIn(c, `(() => { [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Job 1').click(); return true; })()`);
  await sleep(800);
  const v1 = await views();
  note("views, after clicking Job 1", v1);
  check("a click on a tab puts that view on screen and takes the other off", onScreen(v1).join() === "/job-1", v1);
  // And an agent can still drive a page behind another tab.
  const behind = await call("realm-browser__browser_snapshot", { browserId: ids[2] });
  check("an agent can snapshot the page on a tab behind another", !behind.isError && text(behind).includes("Job 3"), text(behind).slice(0, 160));
  // Back to the lead, as a person does by clicking in its prompter.
  await evalIn(c, `(() => { const p = [...document.querySelectorAll('.panehost .panel')].find((x) => x.querySelector('.panel-title')?.textContent === ${JSON.stringify(TITLE)}); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
  await sleep(200);

  // ── 4. A sub-agent gets no pane, a count in the bar, and a preview tab on request ───────────
  const started = await call("realm-agent__agent_start", { goal: "HANG", constraints: { agentKind: "acp:gemini" } });
  note("agent_start", text(started).slice(0, 200));
  const chip = await until(() => evalIn(c, `document.querySelector('.agents-chip')?.textContent ?? null`), 20_000, "running-agents chip");
  check("the session's bar says one agent is working", chip === "1 working", chip);
  await sleep(800);
  const withKid = await panes();
  check("the child opened no pane of its own", withKid.length === 2, withKid.map((p) => p.title ?? p.tabs.map((t) => t.name)));
  await evalIn(c, `(() => { document.querySelector('.agents-chip').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.agents-pop .delegation-item')`), 5_000, "agents list");
  await shot(c, "agents-list");
  await evalIn(c, `(() => { document.querySelector('.agents-pop .delegation-item').click(); return true; })()`);
  const preview = await until(async () => { const ps = await panes(); const s = ps.find((p) => p.tabs.length === 4); return s ? ps : null; }, 10_000, "preview tab").catch(() => panes());
  const s4 = preview.find((p) => p.tabs.length === 4);
  check("a click in the list previews the child as a fourth tab, on screen", !!s4 && s4.tabs.find((t) => t.name.startsWith("Agent"))?.selected && preview.length === 2, preview);
  check("…with the keyboard still in the lead", preview.find((p) => p.title === TITLE)?.focused === true);
  await sleep(500);
  const vKid = await views();
  check("no browser view paints over the preview", onScreen(vKid).length === 0, vKid);
  await shot(c, "child-preview");
}

/** The whole window as the renderer draws it. Native browser views are not in a DOM capture, so a
 *  tab's page shows as the pane's own ground; the strip and the bar are what this is for. */
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
