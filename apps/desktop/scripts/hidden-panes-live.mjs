/**
 * Live check: hidden browser panes are counted across every window and kept loaded for a while, not
 * forever (run with: pnpm build && node apps/desktop/scripts/hidden-panes-live.mjs).
 *
 * The BUILT app on a scratch home, two windows each on a space of its own, with the age limit cut to
 * `KEEP_MS` (`REALM_LIVE_HIDDEN_KEEP_MS`) and Settings ▸ RAM at "discard after 1 minute, keep 1 loaded".
 * The scripted agent opens a browser in each space: window 2's is hidden from the start (its session is
 * not the one on screen there), and window 1's is hidden by switching that window to a third space.
 * Then the server's own clock sweeps, once a minute. Showing a page is an agent's op on it, so for
 * `AGENT_GRACE_MS` (5 minutes) neither may go; `KEEP_MS` is longer than that.
 *
 *   1. Past the minute, ONE hidden page is kept across both windows: window 2's, the older, goes.
 *      Counted per window, both would stay.
 *   2. Past the age limit, window 1's, kept as the most recently hidden, goes too.
 *   3. Back in its space, it comes back on its own address in a new renderer, in window 1.
 *
 * Main's own `webContents` list is what says which pages are loaded. Bills nothing: the scripted agent
 * stands in for Claude.
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const KEEP_MS = 7 * 60_000;
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

const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<title>${req.url}</title><body style="font:16px system-ui">${req.url}</body>`);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;

const scriptDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "realm-hidden-panes-"));
const scriptFile = path.join(scriptDir, "fake-script.json");
fs.writeFileSync(scriptFile, js([
  { on: "Show the pane", emit: [{ kind: "call", tool: "realm-workspace__pane_show", input: {}, argsFromMessage: true }, { kind: "text", text: "Shown." }] },
]));
const app = await launchLiveApp({
  name: "hidden-panes", inspect: true,
  env: { REALM_LIVE_SCRATCH: "1", REALM_LIVE_HIDDEN_KEEP_MS: String(KEEP_MS), REALM_FAKE_STANDS_IN: "claude,codex", REALM_FAKE_SCRIPT: scriptFile },
});
let api = null;
try {
  const ev = (expr) => app.page.eval(expr);
  /** The browser pages main has loaded, by path, with their renderer's pid. */
  const loaded = () => app.main.eval(`require("electron").webContents.getAllWebContents()
    .filter((w) => !w.isDestroyed() && w.getURL().startsWith(${js(base)}))
    .map((w) => ({ path: new URL(w.getURL()).pathname, pid: w.getOSProcessId() }))`);
  const paths = async () => (await loaded()).map((p) => p.path).sort();
  /** Each window's browser views: the page's path and whether the view is drawn. */
  const byWindow = () => app.main.eval(`require("electron").BrowserWindow.getAllWindows().filter((w) => w.isResizable())
    .map((w) => ({ id: w.id, title: w.getTitle(), views: w.contentView.children.filter((v) => v.webContents?.getURL().startsWith(${js(base)}))
      .map((v) => [new URL(v.webContents.getURL()).pathname, v.getVisible()]) }))`);

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  await api.call("settings.set", { key: "browser.discardHiddenMinutes", value: 1 });
  await api.call("settings.set", { key: "browser.keepHidden", value: 1 });

  const [lead] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  const one = (await api.call("spaces.list", {})).find((s) => s.id === lead.spaceId);
  const two = await api.call("spaces.create", { profileId: one.profileId, name: "Elsewhere", icon: "folder" });
  await ev(`window.realm.windows.openSpace(${js(two.id)}).then(() => true)`);
  await until(async () => (await app.main.eval(`require("electron").BrowserWindow.getAllWindows().filter((w) => w.isResizable()).length`)) >= 2 || null, 30_000, "the second window");
  const { session: other } = await api.call("sessions.create", { spaceId: two.id, agentKind: "claude", permissionMode: "default" });

  const show = async (sessionId, browserId) => {
    await api.call("sessions.send", { id: sessionId, text: `Show the pane ${js({ browserId })}`, attachments: [], mentions: [] });
  };
  /** A window's store, found from its DOM up, switched to another space: its panes unmount. A space
   *  just made is not in that window's list until it refreshes. */
  const selectSpace = (windowId, spaceId) => {
    const inPage = `(async () => {
      const el = document.querySelector('.app') ?? document.querySelector('#root > *');
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = el[key]; f; f = f.return) { const v = f.memoizedProps?.value;
        if (v && typeof v.getState === 'function' && 'selectSpace' in v.getState()) {
          await v.getState().refreshSpaces(); await v.getState().selectSpace(${js(spaceId)}); return v.getState().activeSpaceId === ${js(spaceId)}; } }
      return false; })()`;
    return app.main.eval(`require("electron").BrowserWindow.fromId(${windowId}).webContents.executeJavaScript(${js(inPage)})`);
  };
  const browsers = {};
  for (const [space, session, name] of [[two, other.id, "w2"], [one, lead.id, "w1"]]) {
    browsers[name] = (await api.call("browsers.create", { spaceId: space.id, url: `${base}/${name}` })).browserId;
    await show(session, browsers[name]);
    await until(async () => (await paths()).includes(`/${name}`) || null, 30_000, `${name} loaded`);
  }
  await sleep(2_000);
  const shownW1 = await byWindow();
  note("by window, both shown", shownW1);
  const holder = (w, name) => w.find((x) => x.views.some(([p]) => p === `/${name}`))?.id;
  const [w2Window, w1Window] = [holder(shownW1, "w2"), holder(shownW1, "w1")];
  check("each page is in a window of its own", w1Window !== undefined && w2Window !== undefined && w1Window !== w2Window, shownW1);
  // Window 2 leaves its space first, so its page is the older hidden one.
  for (const [windowId, name] of [[w2Window, "Fourth"], [w1Window, "Third"]]) {
    const away = await api.call("spaces.create", { profileId: one.profileId, name, icon: "folder" });
    // A session for the window to open there: an empty space opens on its Overview, a page over the
    // panes, which leaves them the ones showing.
    await api.call("sessions.create", { spaceId: away.id, agentKind: "claude", permissionMode: "default" });
    check(`window ${windowId} leaves its space for ${name}`, await selectSpace(windowId, away.id) === true);
    await sleep(2_000);
  }
  const hiddenAt = Date.now();
  await sleep(1_500);
  const before = await loaded();
  const windowsBefore = await byWindow();
  note("by window, both hidden", windowsBefore);
  check("before any sweep: both hidden pages have a renderer", js(before.map((p) => p.path).sort()) === js(["/w1", "/w2"]));
  check("…and neither is drawn", windowsBefore.every((w) => w.views.every(([, visible]) => !visible)), windowsBefore);

  // ── 1. One count across both windows ────────────────────────────────────────────────────────────
  await until(async () => !(await paths()).includes("/w2") || null, KEEP_MS, "the clock's sweep to take w2");
  const afterMinute = await paths();
  note(`loaded ${Math.round((Date.now() - hiddenAt) / 1000)} s after hiding`, afterMinute);
  check("past the minute, the older hidden page (window 2) is discarded", !afterMinute.includes("/w2"));
  check("…and the one most recently hidden across both windows is kept (window 1)", afterMinute.includes("/w1"), afterMinute);
  check("the kept one is still under the age limit", Date.now() - hiddenAt < KEEP_MS, { hiddenForMs: Date.now() - hiddenAt });

  // ── 2. The age limit ────────────────────────────────────────────────────────────────────────────
  await until(async () => !(await paths()).includes("/w1") || null, KEEP_MS + 120_000, "the age limit to take w1");
  const hiddenFor = Date.now() - hiddenAt;
  note(`loaded ${Math.round(hiddenFor / 1000)} s after hiding`, await paths());
  check("past the age limit, the most recently hidden page is discarded too", hiddenFor >= KEEP_MS, { hiddenForMs: hiddenFor });

  // ── 3. Shown again, it reloads ──────────────────────────────────────────────────────────────────
  const oldPid = before.find((p) => p.path === "/w1")?.pid;
  check("window 1 goes back to its space", await selectSpace(w1Window, one.id) === true);
  const back = await until(async () => (await loaded()).find((p) => p.path === "/w1") ?? null, 30_000, "w1 back");
  check("shown again, the page loads its own address in a new renderer", back.pid !== oldPid, { oldPid, newPid: back.pid });
  const windowsAfter = await until(async () => { const w = await byWindow(); return w.some((x) => x.views.some(([p, visible]) => p === "/w1" && visible)) ? w : null; }, 15_000, "w1 drawn").catch(() => byWindow());
  note("by window, w1 back", windowsAfter);
  check("…drawn in window 1 again", holder(windowsAfter, "w1") === w1Window, windowsAfter);
  const items = await api.call("items.list", { spaceId: one.id });
  check("its tab stayed in the space all along", items.some((i) => i.refId === browsers.w1), items.map((i) => [i.kind, i.refId]));
} finally {
  api?.close();
  await app.stop();
  site.close();
  fs.rmSync(scriptDir, { recursive: true, force: true });
}
