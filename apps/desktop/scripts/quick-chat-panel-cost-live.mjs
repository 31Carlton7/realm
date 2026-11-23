/**
 * What the quick chat panel made ahead of time costs (run with:
 * node apps/desktop/scripts/quick-chat-panel-cost-live.mjs; `pnpm build` first). The BUILT app,
 * quiet, with the scripted agent and stand-ins for the calendar helper, on two scratch homes: one
 * with the double-tap on and no chord (the panel is made ahead), one with the double-tap off and no
 * chord (it is not).
 *
 * Rows, in `rows.txt` under LIVE_OUT_DIR, and each launch as a line of `launches.jsonl`:
 *
 *   launch    process start to the main window's prompter drawn: from this script spawning Electron,
 *             and from main's own time origin, to the first frame after the session's composer
 *             input is in the page and laid out. LIVE_LAUNCHES of each home, alternating, with the
 *             load average beside each, and for the prepared home when the panel's window was made.
 *   memory    on the last three launches of each home: `app.getAppMetrics()` and macOS's `footprint`
 *             for the panel's renderer (made ahead, never opened), the main window's renderer, and a
 *             browser pane's (a WebContentsView on a small local page), each found by its
 *             webContents' OS pid. On macOS `getAppMetrics()` has no `privateBytes`.
 *
 * The paint time is the page's own clock, not a poll: main runs a probe in each window's page as its
 * document commits, and the row says if the composer was already there (`composerAtInstall`).
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, freePort, mainEntry, reap, serverEntry, sleep, spawnLiveElectron, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/quick-chat-panel-cost");
const LAUNCHES = Number(process.env.LIVE_LAUNCHES ?? 6);
const SETTLE_MS = Number(process.env.LIVE_SETTLE_MS ?? 8000);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const js = (v) => JSON.stringify(v);

const rows = [];
const row = (group, name, value) => {
  rows.push(`${group.padEnd(8)} ${name}  ${js(value)}`);
  console.log(rows.at(-1));
};

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(js({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** Put in every page before its own scripts: the page's clock when the session's composer input is
 *  first in the page, and at the frame after it is laid out. */
const PAINT_PROBE = `(() => {
  if (window.top !== window || window.__cost) return;
  const now = () => performance.timeOrigin + performance.now();
  const find = () => [...document.querySelectorAll(".composer-input")].find((el) => !el.closest(".quick-chat"));
  const cost = (window.__cost = { installed: now(), composerAtInstall: !!find() });
  const frame = () => requestAnimationFrame(() => {
    const el = find();
    if (el && el.getBoundingClientRect().width > 0) { cost.drawn = now(); return; }
    frame();
  });
  const seen = new MutationObserver(() => {
    if (!find()) return;
    seen.disconnect();
    cost.inPage = now();
    frame();
  });
  if (cost.composerAtInstall) { cost.inPage = cost.installed; frame(); } else seen.observe(document, { childList: true, subtree: true });
})();`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "realm-panel-cost-"));
const wrapper = path.join(work, "wrapper.mjs");
fs.writeFileSync(wrapper, [
  'import { app } from "electron";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  `const probe = ${js(PAINT_PROBE)};`,
  // Run as the page's document commits, ahead of the composer: `composerAtInstall` says if it was not.
  'app.on("web-contents-created", (_e, contents) => {',
  '  if (contents.getType() !== "window") return;',
  '  (globalThis.__costMade ??= {})[contents.id] = Date.now();',
  '  contents.on("did-navigate", () => void contents.executeJavaScript(probe).catch(() => {}));',
  '});',
  `await import(${js(pathToFileURL(mainEntry).href)});`,
].join("\n"));
const script = path.join(work, "fake-script.json");
fs.writeFileSync(script, js([
  { on: "Show the pane", emit: [{ kind: "call", tool: "realm-workspace__pane_show", input: {}, argsFromMessage: true }, { kind: "text", text: "Shown." }] },
]));

// A small page for the browser pane, served from here: nothing leaves the machine.
const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Pane</title><body style=\"font:16px system-ui\"><p>An ordinary page.</p></body>"); });
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${site.address().port}/pane`;

/** A Realm home, a home of its own, and a userData that stays across its launches (or each launch
 *  after the first reads as an update and opens What's new over the window). */
function makeHome(label, settings) {
  const dir = fs.mkdtempSync(path.join(work, `${label}-`));
  return { label, settings, realm: path.join(dir, "realm"), home: path.join(dir, "home"), userData: path.join(dir, "userData") };
}
const homes = [
  makeHome("prepared", { "quickChat.shortcut": "", "keys.doubleTapCommand": true }),
  makeHome("not-prepared", { "quickChat.shortcut": "", "keys.doubleTapCommand": false }),
];
for (const h of homes) fs.mkdirSync(h.home, { recursive: true });

let current = null;
async function launch(h) {
  const calendar = noCalendar();
  const ports = { server: await freePort(), cdp: await freePort(), inspect: await freePort() };
  const log = fs.openSync(path.join(work, `${h.label}-electron.log`), "a");
  const spawnedAt = Date.now();
  const child = spawnLiveElectron([`--inspect=${ports.inspect}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, ...calendar.env,
      HOME: h.home, REALM_HOME: h.realm, LIVE_USER_DATA: h.userData,
      REALM_PORT: String(ports.server), REALM_DEVTOOLS_PORT: String(ports.cdp), REALM_SERVER_ENTRY: serverEntry,
      REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_STANDS_IN: "claude,codex", REALM_FAKE_SCRIPT: script,
    },
    stdio: ["ignore", log, log],
  });
  const app = { h, ports, child, calendar, spawnedAt, page: null, main: null, api: null };
  current = app;
  const page = await until(async () => (await fetch(`http://127.0.0.1:${ports.cdp}/json/list`).then((r) => r.json())).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "the main window's page");
  app.page = await cdp(page.webSocketDebuggerUrl);
  const m = await until(async () => (await fetch(`http://127.0.0.1:${ports.inspect}/json/list`).then((r) => r.json()))[0], 30_000, "main's inspector");
  app.main = await cdp(m.webSocketDebuggerUrl);
  await app.main.send("Runtime.enable");
  app.mainEval = (e) => app.main.eval(e, { includeCommandLineAPI: true });
  app.api = rpc(ports.server, await daemonToken(h.realm));
  await app.api.ready;
  return app;
}

async function stop(app) {
  app.page?.close(); app.main?.close(); app.api?.close();
  await stopDaemons(app.h.realm);
  reap({ child: app.child, ports: Object.values(app.ports), home: app.h.realm });
  await new Promise((r) => (app.child.exitCode !== null || app.child.signalCode !== null ? r() : app.child.once("exit", r)));
  app.calendar.remove();
  current = null;
}

/** First launch on a home: onboarding makes the space and its session, then the home's settings. */
async function seed(h) {
  const app = await launch(h);
  try {
    await until(() => app.page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
    await app.page.eval(`(() => {
      const input = document.querySelector('.onboarding input:not([type=radio])');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Cost");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form").requestSubmit(); return true; })()`);
    await until(() => app.page.eval(`!!document.querySelector('.composer-input')`), 30_000, "the composer after onboarding");
    for (const [key, value] of Object.entries(h.settings)) await app.api.call("settings.set", { key, value });
    await sleep(2000);
  } finally {
    await stop(app);
  }
}

const panelWindows = `require("electron").BrowserWindow.getAllWindows().filter((w) => !w.isResizable()).length`;

/** One timed launch: spawn to the prompter drawn, then the panel's state once settled. */
async function timed(h, n) {
  const load = os.loadavg().map((x) => Math.round(x * 100) / 100);
  const app = await launch(h);
  try {
    const cost = await until(() => app.page.eval(`window.__cost?.drawn ? window.__cost : null`), 60_000, "the prompter drawn");
    const mainOrigin = await app.mainEval(`performance.timeOrigin`);
    await sleep(SETTLE_MS);
    const panel = await app.mainEval(`(() => { const p = require("electron").BrowserWindow.getAllWindows().find((w) => !w.isResizable());
      return p ? { made: true, visible: p.isVisible(), madeAt: globalThis.__costMade?.[p.webContents.id] ?? null } : { made: false }; })()`);
    if (panel.madeAt) panel.madeAfterDrawnMs = Math.round(panel.madeAt - cost.drawn);
    delete panel.madeAt;
    const out = {
      home: h.label, n, load,
      fromSpawnMs: Math.round(cost.drawn - app.spawnedAt),
      fromMainOriginMs: Math.round(cost.drawn - mainOrigin),
      inPageToDrawnMs: Math.round(cost.drawn - cost.inPage),
      composerAtInstall: cost.composerAtInstall, probeInstalledMs: Math.round(cost.installed - app.spawnedAt),
      panel, panelWindows: await app.mainEval(panelWindows),
    };
    fs.appendFileSync(path.join(OUT_DIR, "launches.jsonl"), js(out) + "\n");
    row("launch", `${h.label} #${n}`, out);
    return { app, out };
  } catch (err) {
    const seen = await app.page.eval(`({ cost: window.__cost ?? null, composers: [...document.querySelectorAll(".composer-input")].map((el) => el.getBoundingClientRect().width),
      text: document.body.innerText.slice(0, 300) })`).catch((e) => String(e));
    console.error(`page at the failure: ${js(seen)}`);
    await stop(app);
    throw err;
  }
}

/** Each of the app's renderers by its webContents' OS pid, with `getAppMetrics()`'s memory for it (KB). */
const METRICS = (pageUrl) => `(() => {
  const { app, BrowserWindow, webContents } = require("electron");
  const metrics = new Map(app.getAppMetrics().map((p) => [p.pid, p]));
  const of = (wc, what) => { if (!wc) return null; const pid = wc.getOSProcessId(); const p = metrics.get(pid);
    return { what, pid, type: p?.type ?? null, memoryKB: p?.memory ?? null, sharesPidWith: null }; };
  const wins = BrowserWindow.getAllWindows();
  const rows = [
    of(wins.find((w) => !w.isResizable())?.webContents, "panel (made ahead, never opened)"),
    of(wins.find((w) => w.isResizable())?.webContents, "main window"),
    of(webContents.getAllWebContents().find((wc) => wc.getURL() === ${js(pageUrl)}), "browser pane (WebContentsView)"),
  ].filter(Boolean);
  for (const r of rows) r.sharesPidWith = rows.filter((o) => o !== r && o.pid === r.pid).map((o) => o.what);
  const all = app.getAppMetrics();
  return { rows, total: { processes: all.length, workingSetKB: all.reduce((n, p) => n + p.memory.workingSetSize, 0),
    byType: all.map((p) => [p.type, p.pid, p.memory.workingSetSize]) } };
})()`;

/** macOS's own measure of a process's memory (`footprint`), in KB. */
function footprintKB(pid) {
  try {
    const m = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(execFileSync("footprint", [String(pid)], { encoding: "utf8" }));
    return m ? Math.round(Number(m[1]) * { KB: 1, MB: 1024, GB: 1024 ** 2 }[m[2]]) : null;
  } catch { return null; }
}
const withFootprints = (m) => { for (const r of m.rows) r.footprintKB = footprintKB(r.pid); return m; };

async function memory(app) {
  const before = withFootprints(await app.mainEval(METRICS(pageUrl)));
  const [space] = await app.api.call("spaces.list", {});
  const lead = (await app.api.call("items.list", { spaceId: space.id })).find((i) => i.kind === "session").refId;
  const { browserId } = await app.api.call("browsers.create", { spaceId: space.id, url: pageUrl });
  await app.api.call("sessions.send", { id: lead, text: `Show the pane ${js({ browserId })}`, attachments: [], mentions: [] });
  await until(() => app.mainEval(`require("electron").webContents.getAllWebContents().some((wc) => wc.getURL() === ${js(pageUrl)} && !wc.isLoading())`), 30_000, "the browser pane's page");
  await sleep(SETTLE_MS);
  const after = withFootprints(await app.mainEval(METRICS(pageUrl)));
  const panelVisible = await app.mainEval(`require("electron").BrowserWindow.getAllWindows().find((w) => !w.isResizable())?.isVisible() ?? null`);
  return { load: os.loadavg().map((x) => Math.round(x * 100) / 100), beforePane: before, withPane: after, panelVisible };
}

const watchdog = setTimeout(async () => {
  console.error("FAIL watchdog: the check ran for twenty minutes");
  if (current) await stop(current).catch(() => {});
  process.exit(9);
}, 20 * 60_000);

const summary = (xs) => { const s = [...xs].sort((a, b) => a - b); const mid = s.length >> 1;
  return { n: s.length, median: s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2), min: s[0], max: s.at(-1) }; };

try {
  fs.rmSync(path.join(OUT_DIR, "launches.jsonl"), { force: true });
  for (const h of homes) await seed(h);
  const runs = [];
  for (let n = 1; n <= LAUNCHES; n++) {
    for (const h of n % 2 ? homes : [...homes].reverse()) {
      const { app, out } = await timed(h, n);
      runs.push(out);
      if (n > LAUNCHES - 3) row("memory", `${h.label} #${n}`, await memory(app));
      await stop(app);
    }
  }
  for (const h of homes) {
    const mine = runs.filter((r) => r.home === h.label);
    row("summary", h.label, { fromSpawnMs: summary(mine.map((r) => r.fromSpawnMs)), fromMainOriginMs: summary(mine.map((r) => r.fromMainOriginMs)),
      panelMade: mine.map((r) => r.panel.made), loadAvg1m: mine.map((r) => r.load[0]) });
  }
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows.txt"), rows.join("\n") + "\n");
  if (current) await stop(current).catch(() => {});
  site.close();
  if (!process.env.LIVE_KEEP) fs.rmSync(work, { recursive: true, force: true });
  clearTimeout(watchdog);
}
process.exit(process.exitCode ?? 0);
