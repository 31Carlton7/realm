/**
 * Live check that an agent in a space held at launch gets its browser pane (run with: pnpm build &&
 * node apps/desktop/scripts/held-window-agent-live.mjs)
 *
 * Boots the BUILT app twice on one scratch REALM_HOME and HOME under ~/realm-scratch, quietly
 * (`live-app.mjs`), with the scripted fake engine calling Realm's real browser tools (`kind: "call"`,
 * nothing billed). The first boot makes five spaces; windows.json then names a window for each, so the
 * second boot opens the three used last and holds the other two (`splitLaunch`). A session in held
 * Space 2 is kept working (a scripted Bash call held for minutes) with no pane, and a session in held
 * Space 1 opens a browser pane and reads it:
 *
 *   - the held window opens for the pane, unshown, and nothing is focused or shown over the person's
 *     windows;
 *   - Space 2, busy but with no pane, stays held: work alone opens no window;
 *   - the pane's view is in that window, not parked in the window of another space;
 *   - browser_snapshot reads the page, browser_list says it is open, and pane_show finds it mounted;
 *   - the pane mounts once: one webContents ever loads the page, the site is asked for it once, and a
 *     page the agent navigated and marked is still that page, unreloaded, after Space 1's window has
 *     booted.
 *
 * LIVE_REPO_ROOT boots another checkout's build (the control run on main). LIVE_OUT is where the
 * report and the pictures go. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT / LIVE_INSPECT_PORT /
 * LIVE_SITE_PORT (8817 / 9257 / 9258 / 18817), refused if taken.
 */
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { spawnLiveElectron } from "./lib/live-app.mjs";

const repoRoot = process.env.LIVE_REPO_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8817);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9257);
const INSPECT_PORT = Number(process.env.LIVE_INSPECT_PORT ?? 9258);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 18817);
const scratchRoot = path.join(os.homedir(), "realm-scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "held-window-"));
const OUT_DIR = process.env.LIVE_OUT ?? path.join(scratchRoot, "held-window-out");
fs.mkdirSync(OUT_DIR, { recursive: true });
const home = path.join(scratch, "home");
const userHome = path.join(scratch, "user-home");
const userData = path.join(scratch, "userData");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  const line = `${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`;
  report.push(line);
  console.log(line);
};
const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});
async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(200);
  }
}
function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  const send = (body) => new Promise((res) => {
    const i = ++id;
    pending.set(String(i), res);
    ws.send(JSON.stringify({ ...body, id: typeof body.method === "string" && protocols ? String(i) : i }));
  });
  return { ready, send, close: () => ws.close() };
}
const cdp = (wsUrl) => {
  const s = socket(wsUrl);
  return { ready: s.ready, close: s.close, send: (method, params) => s.send({ method, params }).then((m) => { if (m.error) throw new Error(m.error.message); return m.result; }) };
};
const rpc = (port, token) => {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return { ready: s.ready, close: s.close, call: (method, params) => s.send({ method, params }).then((m) => { if (!m.ok) throw new Error(`${method}: ${m.error?.message}`); return m.result; }) };
};
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error(`exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const text = (r) => (typeof r === "string" ? r : (r ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"));

const PAGE = `<!doctype html><html><head><title>Held space fixture</title><style>
  body{font:15px -apple-system,system-ui;margin:48px} @media (prefers-color-scheme: dark){body{background:#1c1d21;color:#e8e8ea}}
</style></head><body><h1>Held space fixture</h1><p>An agent in a held space opened this page.</p></body></html>`;
/** GET requests the fixture site served, by path: a page loaded again is asked for again. */
const gets = {};
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET") gets[req.url] = (gets[req.url] ?? 0) + 1;
      res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

const SCRIPT = [
  { on: "Open {", emit: [{ kind: "call", tool: "realm-browser__browser_open", input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }] },
  { on: "Nav {", emit: [{ kind: "call", tool: "realm-browser__browser_navigate", input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }] },
  { on: "Snap {", emit: [{ kind: "call", tool: "realm-browser__browser_snapshot", input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }] },
  { on: "List {", emit: [{ kind: "call", tool: "realm-browser__browser_list", input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }] },
  { on: "Show {", emit: [{ kind: "call", tool: "realm-workspace__pane_show", input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }] },
  { on: "Busy {", emit: [{ kind: "tool", name: "Bash", input: { command: "sleep 600" }, result: "done", holdMs: 600_000 }, { kind: "text", text: "Done." }] },
];

const WRAPPER = [
  'import { app } from "electron";',
  'app.commandLine.appendSwitch("use-mock-keychain");',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "await import(process.env.LIVE_MAIN);",
].join("\n");

let electron = null, api = null, site = null;
const appOutput = [];
const step = (what) => console.log(`… ${what}`);
const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);

function boot(inspect) {
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error(`${mainEntry} is missing (run \`pnpm build\` first)`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const child = spawnLiveElectron([...(inspect ? [`--inspect=${INSPECT_PORT}`] : []), wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, HOME: userHome, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: path.join(scratch, "script.json"),
      REALM_LIVE_SCRATCH: "1", LIVE_USER_DATA: userData, LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => appOutput.push(String(d))); child.stdout.on("data", (d) => appOutput.push(String(d)));
  return child;
}

async function quit() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  api = null;
  electron?.kill("SIGKILL");
  electron = null;
  await sleep(800);
  await stopDaemons(home);
}

async function main() {
  for (const p of [SERVER_PORT, CDP_PORT, INSPECT_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use, refusing to run`);
  console.log(`build under test: ${repoRoot}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(scratch, "script.json"), JSON.stringify(SCRIPT));
  site = await startSite();

  /* ── first boot: five spaces ──────────────────────────────────────────────────────────────── */
  electron = boot(false);
  const first = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c1 = cdp(first.webSocketDebuggerUrl);
  await c1.ready;
  await c1.send("Runtime.enable");
  await until(() => evalIn(c1, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c1, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Space 1");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c1, `!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [one] = await api.call("spaces.list", {});
  for (const n of [2, 3, 4, 5]) await api.call("spaces.create", { profileId: one.profileId, name: `Space ${n}` });
  const spaces = await api.call("spaces.list", {});
  check("the first boot has five spaces", spaces.length === 5, spaces.map((s) => s.name));
  c1.close();
  await quit();

  // A window for each space, the one used longest ago first: the next boot opens Spaces 3-5 and
  // holds Spaces 1 and 2.
  const ordered = [1, 2, 3, 4, 5].map((n) => spaces.find((s) => s.name === `Space ${n}`));
  fs.writeFileSync(path.join(userData, "windows.json"), JSON.stringify({ windows: ordered.map((s) => ({ profileId: s.profileId, spaceId: s.id, showing: s.id })) }));
  step("windows.json written for five spaces");

  /* ── second boot: two spaces held ─────────────────────────────────────────────────────────── */
  electron = boot(true);
  const inspector = await until(async () => (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 60_000, "main's inspector");
  const m = cdp(inspector.webSocketDebuggerUrl);
  await m.ready;
  await m.send("Runtime.enable");
  const mainEval = (expr) => evalIn(m, `(async () => { const { BrowserWindow, nativeTheme, webContents } = require("electron"); ${expr} })()`);
  const realmWindows = `BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().startsWith("file://") && !w.webContents.getURL().includes("quick-chat") && w.isResizable())`;
  const describeWindows = () => mainEval(`return ${realmWindows}.map((w) => ({ id: w.id, title: w.getTitle().replace(/ \u2014 SCRATCH.*$/, ""), visible: w.isVisible(), focused: w.isFocused() }));`);
  await until(async () => (await describeWindows().catch(() => [])).length >= 3, 60_000, "three windows");
  await sleep(1500);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const before = await describeWindows();
  check("the relaunch opens the three windows used last, and holds Spaces 1 and 2", JSON.stringify(before.map((w) => w.title).sort()) === JSON.stringify(["Space 3", "Space 4", "Space 5"]), before);
  const focusedTitle = () => mainEval(`return BrowserWindow.getFocusedWindow()?.getTitle().replace(/ \u2014 SCRATCH.*$/, "") ?? null;`);
  const focusedBefore = await focusedTitle();
  // Every webContents that ever commits a fixture page, from before the agent opens one.
  await mainEval(`globalThis.__fixtureLoads = new Set();
    require("electron").app.on("web-contents-created", (_e, wc) => wc.on("did-navigate", (_ev, url) => { if (url.startsWith(${JSON.stringify(SITE)})) globalThis.__fixtureLoads.add(wc.id); }));
    return true;`);

  step("a session in Space 2 (held) starts work that opens no pane");
  const { session: busy } = await api.call("sessions.create", { spaceId: ordered[1].id, agentKind: "fake", title: "Busy agent", permissionMode: "bypassPermissions" });
  await api.call("sessions.send", { id: busy.id, text: "Busy {}", attachments: [], mentions: [] });
  const busyStatus = async () => (await api.call("sessions.listAll", {})).find((s) => s.id === busy.id)?.status;
  await until(async () => (await busyStatus()) === "running", 30_000, "Space 2's session running");
  await sleep(3000);
  const whileBusy = await describeWindows();
  check("Space 2, working with no pane, stays held: no window opens for it", !whileBusy.some((w) => w.title === "Space 2"), whileBusy.map((w) => w.title));

  const held = ordered[0];
  const { session } = await api.call("sessions.create", { spaceId: held.id, agentKind: "fake", title: "Held space agent", permissionMode: "bypassPermissions" });
  const events = () => api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 5000 });
  const agent = async (verb, args) => {
    const seen = (await events()).length;
    await api.call("sessions.send", { id: session.id, text: `${verb} ${JSON.stringify(args)}`, attachments: [], mentions: [] });
    const result = await until(async () => (await events()).slice(seen).find((e) => e.event.type === "tool_result")?.event.payload, 150_000, `${verb} result`);
    await until(async () => (await events()).slice(seen).some((e) => e.event.type === "status" && e.event.payload.status === "idle"), 60_000, `${verb} settles`);
    return { text: text(result.content), isError: Boolean(result.isError) };
  };

  step("the agent in Space 1 (held) opens a browser pane");
  const t0 = Date.now();
  const opened = await agent("Open", { url: `${SITE}/held` });
  const browserId = /pane (\S+) at/.exec(opened.text)?.[1];
  check("browser_open answers with a pane", !!browserId && !opened.isError, opened.text);
  const snap = await agent("Snap", { browserId });
  const snapMs = Date.now() - t0;
  check("browser_snapshot reads the page in the held space's pane", !snap.isError && snap.text.includes("Held space fixture"), { ms: snapMs, text: snap.text.slice(0, 300) });

  step("the agent navigates the pane on, and the page is marked");
  const navigated = await agent("Nav", { browserId, url: `${SITE}/second` });
  check("browser_navigate takes the pane to a second page", !navigated.isError, navigated.text);
  const fixturePage = `webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(${JSON.stringify(SITE)}))`;
  // Not thrown on: a page taken over and loaded again fails the checks below, with what was found.
  await until(() => mainEval(`const wc = ${fixturePage}; return !!wc && wc.getURL().endsWith("/second") && !wc.isLoading();`), 30_000, "second page loaded").catch(() => {});
  await mainEval(`const wc = ${fixturePage}; return wc ? wc.executeJavaScript("window.__heldMarker = 'kept'") : null;`);
  const booted = (title) => mainEval(`const w = ${realmWindows}.find((x) => x.getTitle().startsWith(${JSON.stringify(title)}));
    return !!w && !w.webContents.isLoading() && await w.webContents.executeJavaScript("(() => { const b = document.getElementById('boot'); return !b || b.hasAttribute('data-done'); })()");`);
  await until(() => booted("Space 1"), 60_000, "Space 1's window booted");
  await sleep(5000);
  const kept = await mainEval(`const wc = ${fixturePage}; return wc ? { url: wc.getURL(), marker: await wc.executeJavaScript("window.__heldMarker ?? null") } : null;`);
  check("after Space 1's window booted, the page is still the one the agent navigated and marked", kept?.url === `${SITE}/second` && kept?.marker === "kept", kept);
  const loads = await mainEval(`return globalThis.__fixtureLoads.size;`);
  check("the pane mounted once: one webContents ever loaded the fixture", loads === 1, { webContents: loads });
  check("the site was asked for each page once: no reload", gets["/held"] === 1 && gets["/second"] === 1, gets);

  const listed = await agent("List", {});
  check("browser_list says the pane is open in the app", !listed.isError && listed.text.includes(`browserId: ${browserId} \u2014 open`), listed.text);
  const t1 = Date.now();
  const shown = await agent("Show", { browserId });
  check("pane_show finds the pane mounted, rather than timing out", !shown.isError && shown.text.includes("back in your side pane"), { ms: Date.now() - t1, text: shown.text });

  const after = await describeWindows();
  const opener = after.find((w) => w.title === "Space 1");
  check("the held window for Space 1 opened for the work", !!opener, after);
  check("it opened unshown and unfocused, over nothing the person was doing", !!opener && !opener.visible && !opener.focused, opener);
  const focusedAfter = await focusedTitle();
  check("the window in front is the one that was in front", focusedAfter === focusedBefore, { before: focusedBefore, after: focusedAfter });
  check("Space 2 is still working, and still held after Space 1's pane opened", (await busyStatus()) === "running" && !after.some((w) => w.title === "Space 2"), { status: await busyStatus(), windows: after.map((w) => w.title) });
  const mounted = await mainEval(`return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().startsWith(${JSON.stringify(SITE)})).map((wc) => wc.getURL());`);
  check("the pane's page is loaded in a view", mounted.length === 1, mounted);
  const hosts = await mainEval(`return ${realmWindows}.map((w) => ({ title: w.getTitle().replace(/ \u2014 SCRATCH.*$/, ""), views: w.contentView.children.map((v) => v.webContents?.getURL?.() ?? null).filter((u) => u && u.startsWith(${JSON.stringify(SITE)})) }));`);
  check("the pane's view is in Space 1's own window, not another space's", JSON.stringify(hosts.filter((h) => h.views.length > 0).map((h) => h.title)) === JSON.stringify(["Space 1"]), hosts);

  /* ── pictures of the held window and its pane, light and dark ─────────────────────────────── */
  if (opener) {
    for (const mode of ["light", "dark"]) {
      await mainEval(`nativeTheme.themeSource = ${JSON.stringify(mode)}; return true;`);
      await sleep(1500);
      const shots = await mainEval(`
        const win = BrowserWindow.fromId(${opener.id});
        const pane = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(${JSON.stringify(SITE)}));
        const grab = async (wc) => { try { const img = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(() => r(null), 8000))]); return img && !img.isEmpty() ? img.toPNG().toString("base64") : null; } catch { return null; } };
        return { window: await grab(win.webContents), pane: pane ? await grab(pane) : null, mode: await win.webContents.executeJavaScript("document.documentElement.dataset.mode ?? null") };`);
      for (const [what, data] of Object.entries({ window: shots.window, pane: shots.pane })) {
        if (!data) { console.log(`NO PICTURE ${what} ${mode}`); continue; }
        const file = path.join(OUT_DIR, `held-${what}-${mode}.png`);
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        console.log(`FRAME ${what} ${mode} (data-mode=${shots.mode}) ${file}`);
      }
    }
  }
  m.close();
}

async function teardown() {
  if (process.exitCode) console.log(`APP OUTPUT (tail) ${appOutput.join("").slice(-3000)}`);
  fs.writeFileSync(path.join(OUT_DIR, "report.txt"), `${report.join("\n")}\n`);
  await quit();
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); report.push(`FAIL ${e?.message ?? e}`); }).finally(teardown);
