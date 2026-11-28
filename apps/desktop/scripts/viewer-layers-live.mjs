/**
 * Live check: a viewer on a quiet Realm streams its browser pane as a layer of its own, and a press
 * reaches that pane (run with: pnpm build && node apps/desktop/scripts/viewer-layers-live.mjs).
 *
 * The BUILT app on a scratch home, in quiet mode, which lists each window's child views in its page
 * (src/main/quiet-child-views.ts). The scripted agent shows a browser pane on a page this script
 * serves: one big coloured block and a click counter. Then a ViewerService, run from the server's
 * source under tsx as devices-live.mjs runs its rig, is handed a HiddenApps holding this app's debug
 * port and pid, and opens a viewer on it. What it checks against real Chromium:
 *
 *   1. The layout names the pane by the same target id the app's /json/list gives it: main reads it
 *      from `Target.getTargetInfo`, the relay dials it as a /devtools/page/<id> socket.
 *   2. The pane's view screencasts at all: a frame comes for its layer, as well as the window's.
 *   3. A press naming the pane's layer, and one naming no layer at a point inside the pane (the
 *      topmost-rect fallback), each click the page: its counter is read through its own CDP target.
 *
 * The layout JSON, one JPEG per layer, one of the pane after the first press, and the presses go to
 * .out/viewer-layers/ (or --out <dir>).
 * Look at them: the pane's layer is the page, and the window's has a hole where the pane goes. The
 * window's frame would name this Mac at the prompter's foot, so that label reads "This Mac".
 *
 * Teardown is by pid: the app and its server (live-app.mjs's reap), the rig, the page server. Then
 * the app's server port, its debug port, the page server's port and the viewer's port must all be
 * free, and the scratch home gone. Bills nothing: the scripted agent stands in for Claude.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, launchLiveApp, repoRoot, sleep, until } from "./lib/live-app.mjs";

const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const OUT = path.resolve(flag("--out", path.join(repoRoot, ".out/viewer-layers")));
/** Lay out and paint a window that is covered or in the background (see browser-bench-live.mjs). */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const js = (v) => JSON.stringify(v);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${js(detail)}` : ""}`);
};
const note = (name, detail) => console.log(`INFO ${name} ${js(detail)}`);

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
      ws.send(js({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

function listening(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
}

/** The page the pane shows: one block filling it, a counter of clicks, and a slow pulse so the page
 *  keeps painting whatever the screencast's start does. */
const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>viewer layers</title>
<style>html,body{margin:0;height:100%}#block{position:fixed;inset:0;background:#1f9d6b;color:#fff;font:600 64px system-ui;display:grid;place-items:center}
#pulse{position:fixed;right:16px;bottom:16px;width:24px;height:24px;border-radius:50%;background:#fff;animation:p 1s infinite alternate}@keyframes p{to{opacity:.2}}</style>
<div id="block">clicks: <span id="n">0</span></div><div id="pulse"></div>
<script>window.clicks = []; addEventListener("click", (e) => { window.clicks.push({ x: e.clientX, y: e.clientY }); document.getElementById("n").textContent = window.clicks.length; });</script>`);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const sitePort = site.address().port;
const base = `http://127.0.0.1:${sitePort}`;

/* ── The viewer rig: the server's ViewerService and HiddenApps, under tsx, driven over stdin ──── */
const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "realm-viewer-layers-rig-"));
function startRig(windowTarget) {
  const file = path.join(rigDir, "viewer-rig.mts");
  const server = (rel) => js(path.join(repoRoot, "apps/server/src", rel));
  fs.writeFileSync(file, `import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { HiddenApps } from ${server("viewers/hidden-apps.ts")};
import { ViewerService } from ${server("viewers/service.ts")};
const { WebSocket } = createRequire(${js(path.join(repoRoot, "apps/server/package.json"))})("ws");
const { decodeViewerFrame } = await import(${server("../../../packages/contracts/src/viewer.ts")});
const [cdpPort, pid, targetId, out] = process.argv.slice(2);
const hiddenApps = new HiddenApps();
const recorded = hiddenApps.record({ cdpPort: Number(cdpPort), pid: Number(pid) });
const viewers = new ViewerService({ apps: hiddenApps });
const say = (tag: string, v: unknown) => console.log(tag + " " + JSON.stringify(v));
const viewer = await viewers.open({ kind: "electron", appId: recorded.id, targetId });
say("viewer", viewer);
const layouts: any[] = [];
const last = new Map<string, Buffer>();
const counts: Record<string, number> = {};
const layers = new WebSocket(viewer.layersUrl);
layers.on("message", (raw: Buffer, binary: boolean) => {
  if (!binary) { layouts.push(JSON.parse(String(raw))); return; }
  const frame = decodeViewerFrame(new Uint8Array(raw));
  if (!frame) return;
  last.set(frame.layer, Buffer.from(frame.jpeg));
  counts[frame.layer] = (counts[frame.layer] ?? 0) + 1;
});
const input = new WebSocket(viewer.inputUrl);
await Promise.all([layers, input].map((ws) => new Promise((r, j) => { ws.once("open", r); ws.once("error", j); })));
const handle = async (cmd: string, arg: string) => {
  if (cmd === "state") say("state", { layout: layouts.at(-1) ?? null, layouts: layouts.length, counts });
  if (cmd === "save") {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "layout.json"), JSON.stringify(layouts.at(-1), null, 2) + "\\n");
    const files: string[] = [];
    for (const [layer, jpeg] of last) { const f = path.join(out, layer + ".jpg"); fs.writeFileSync(f, jpeg); files.push(f); }
    say("saved", files);
  }
  if (cmd === "save-layer") {
    const { layer, name } = JSON.parse(arg);
    const f = path.join(out, name + ".jpg");
    fs.writeFileSync(f, last.get(layer)!);
    say("saved", [f]);
  }
  if (cmd === "press") {
    const p = JSON.parse(arg);
    for (const action of ["down", "up"]) input.send(JSON.stringify({ type: "pointer", action, ...p }));
    say("pressed", p);
  }
  if (cmd === "quit") { layers.close(); input.close(); await viewers.closeAll(); say("closed", true); process.exit(0); }
};
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, arg] = line.split("\\t");
  handle(cmd!, arg ?? "").catch((e) => say("error", cmd + " " + (e as Error).message));
}
`);
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  const child = spawn(tsx, [file, String(app.ports.cdp), String(app.electron.pid), windowTarget, OUT], { cwd: path.join(repoRoot, "apps/server"), stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const waiters = new Set();
  createInterface({ input: child.stdout }).on("line", (line) => { lines.push(line); for (const w of [...waiters]) w(); });
  child.stderr.on("data", (d) => process.stderr.write(`    [rig] ${d}`));
  const next = (tag, ms) => new Promise((resolve, reject) => {
    const scan = () => {
      const i = lines.findIndex((l) => l.startsWith(`${tag} `) || l.startsWith("error "));
      if (i < 0) return false;
      waiters.delete(scan); clearTimeout(timer);
      const line = lines.splice(i, 1)[0];
      if (line.startsWith("error ")) reject(new Error(`rig: ${line}`)); else resolve(JSON.parse(line.slice(tag.length + 1)));
      return true;
    };
    const timer = setTimeout(() => { waiters.delete(scan); reject(new Error(`rig: no ${tag} in ${ms} ms`)); }, ms);
    if (!scan()) waiters.add(scan);
  });
  const ask = (tag, cmd, arg) => { child.stdin.write(`${cmd}${arg === undefined ? "" : `\t${js(arg)}`}\n`); return next(tag, 15_000); };
  return { child, next, ask };
}

const scriptFile = path.join(rigDir, "fake-script.json");
fs.writeFileSync(scriptFile, js([
  { on: "Show the pane", emit: [{ kind: "call", tool: "realm-workspace__pane_show", input: {}, argsFromMessage: true }, { kind: "text", text: "Shown." }] },
]));
const app = await launchLiveApp({
  name: "viewer-layers", inspect: true, args: UNTHROTTLED,
  env: { REALM_LIVE_SCRATCH: "1", REALM_FAKE_STANDS_IN: "claude,codex", REALM_FAKE_SCRIPT: scriptFile },
});
let api = null, rig = null, viewerPort = null;
try {
  const ev = (expr) => app.page.eval(expr);
  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [lead] = await until(async () => { const all = await api.call("sessions.listAllFull", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  // The prompter's foot names this Mac; the frames go in a public PR, so the window says "This Mac".
  const { machineName } = await api.call("system.info", {});
  await ev(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(${js(machineName)})) n.nodeValue = n.nodeValue.replace(${js(machineName)}, "This Mac");
    return true; })()`);
  const { browserId } = await api.call("browsers.create", { spaceId: lead.spaceId, url: `${base}/pane` });
  await api.call("sessions.send", { id: lead.id, text: `Show the pane ${js({ browserId })}`, attachments: [], mentions: [] });
  const paneTarget = await until(async () => (await app.targets()).find((t) => t.type === "page" && t.url.startsWith(base)), 30_000, "the pane's page target");
  const paneView = await until(() => app.main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable());
    const v = w?.contentView.children.find((v) => v.webContents?.getURL().startsWith(${js(base)}));
    return v && v.getVisible() && v.getBounds().width > 0 ? v.getBounds() : null; })()`), 30_000, "the pane's view drawn");
  note("the pane's target in /json/list", { id: paneTarget.id, url: paneTarget.url });
  note("the pane's view bounds (DIPs)", paneView);

  // The main window's page, by id: the quick chat panel's page has the same file:// URL. It is the bigger.
  const windows = [];
  for (const t of (await app.targets()).filter((t) => t.type === "page" && t.url.startsWith("file://"))) {
    const c = await cdp(t.webSocketDebuggerUrl);
    windows.push({ id: t.id, area: await c.eval("innerWidth * innerHeight").catch(() => 0) });
    c.close();
  }
  const windowTarget = windows.sort((a, b) => b.area - a.area)[0].id;
  note("the window's page targets", windows);
  rig = startRig(windowTarget);
  const viewer = await rig.next("viewer", 30_000);
  viewerPort = Number(new URL(viewer.streamUrl).port);
  note("viewer", { kind: viewer.kind, status: viewer.status, pid: viewer.pid, title: viewer.title });

  // ── 1 and 2: the layout names the pane by its /json/list id, and both layers screencast ───────
  await until(async () => {
    const s = await rig.ask("state", "state");
    const pane = s.layout?.layers.find((l) => l.id !== "window");
    return pane && s.layout.layers[0].width > 0 && s.counts.window > 0 && s.counts[pane.id] > 0 ? s : null;
  }, 20_000, "a layout with the pane, and a frame on each layer").catch(async (err) => { note("last state", await rig.ask("state", "state")); throw err; });
  await sleep(1_500);
  const settled = await rig.ask("state", "state");
  const layout = settled.layout;
  const pane = layout.layers.find((l) => l.id !== "window");
  note("layout", layout);
  note("frames per layer", settled.counts);
  check("the layout names the pane by the id /json/list gives it", pane.id === paneTarget.id, { layout: pane.id, list: paneTarget.id });
  check("the pane's view screencasts: frames came on its layer", settled.counts[pane.id] > 0, settled.counts);
  check("…and on the window's", settled.counts.window > 0, settled.counts);
  check("the window names no machine in its frame", !(await ev(`document.body.innerText.includes(${js(machineName)})`)));
  const saved = await rig.ask("saved", "save");
  note("saved", saved);

  // ── 3: a press naming the pane's layer, and one naming no layer, each click the page ─────────
  const page = await cdp(paneTarget.webSocketDebuggerUrl);
  const clicks = () => page.eval("window.clicks");
  const win = layout.layers[0];
  const before = (await clicks()).length;
  const onLayer = { layer: pane.id, x: Math.round(pane.width / 2), y: Math.round(pane.height / 2) };
  await rig.ask("pressed", "press", onLayer);
  const afterLayer = await until(async () => { const c = await clicks(); return c.length > before ? c : null; }, 5_000, "the layer press").catch(() => clicks());
  check("a press naming the pane's layer clicks the page", afterLayer.length === before + 1, { sent: onLayer, clicks: afterLayer });
  // A pane frame painted after the press, so the picture shows the count it made.
  const shown = (await rig.ask("state", "state")).counts[pane.id];
  await until(async () => (await rig.ask("state", "state")).counts[pane.id] >= shown + 2, 10_000, "a pane frame after the press");
  note("saved after the press", await rig.ask("saved", "save-layer", { layer: pane.id, name: `${pane.id}-after-press` }));
  const fallback = { x: Math.round(pane.x + pane.width / 3), y: Math.round(pane.y + pane.height / 3), width: win.width, height: win.height };
  await rig.ask("pressed", "press", fallback);
  const afterPoint = await until(async () => { const c = await clicks(); return c.length > before + 1 ? c : null; }, 5_000, "the point press").catch(() => clicks());
  check("a press naming no layer, inside the pane's rect, clicks the page", afterPoint.length === before + 2, { sent: fallback, clicks: afterPoint });
  const want = { x: Math.round(pane.width / 3), y: Math.round(pane.height / 3) };
  const got = afterPoint.at(-1);
  check("…at the point under it, in the pane's own pixels", got && Math.abs(got.x - want.x) <= 1 && Math.abs(got.y - want.y) <= 1, { want, got });
  fs.writeFileSync(path.join(OUT, "presses.json"), `${js({ onLayer: { sent: onLayer, clicks: afterLayer }, noLayer: { sent: fallback, clicks: afterPoint } })}\n`);
  page.close();
} finally {
  api?.close();
  if (rig) {
    rig.child.stdin.write("quit\n");
    await rig.next("closed", 5_000).catch(() => {});
    if (rig.child.exitCode === null) { try { process.kill(rig.child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  const appPid = app.electron.pid;
  await app.stop();
  await new Promise((r) => { site.closeAllConnections(); site.close(r); });
  fs.rmSync(rigDir, { recursive: true, force: true });
  await sleep(500);
  let alive = false;
  try { process.kill(appPid, 0); alive = true; } catch { /* gone */ }
  check("teardown: the app is gone", !alive, { pid: appPid });
  const ports = { server: app.ports.server, debug: app.ports.cdp, inspect: app.ports.inspect, page: sitePort, viewer: viewerPort };
  const held = Object.fromEntries(Object.entries(ports).filter(([, p]) => p && listening(p)));
  check("teardown: no port is still listening", Object.keys(held).length === 0, { ports, held });
  check("teardown: the scratch home is gone", !fs.existsSync(app.scratch), { scratch: path.basename(app.scratch) });
}
