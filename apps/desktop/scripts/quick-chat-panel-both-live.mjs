/**
 * Live check for one quick chat shown in two places: a Realm window's card and the quick chat panel
 * (run with: node apps/desktop/scripts/quick-chat-panel-both-live.mjs; `pnpm build` first). The
 * BUILT app on a scratch home, quiet, with the scripted agent and a stand-in for the calendar helper.
 *
 * Rows, in `rows-followup.txt` under LIVE_OUT_DIR:
 *
 *   both      the same chat is up in the window's card and in the panel; the panel's trash deletes
 *             it, and the window's card comes down without a second delete
 *   both      the other way round: the window's trash deletes it, and the panel is put away
 *
 * Nothing here reaches the person at the Mac. The windows stay quiet's (no real key window, unlike
 * quick-chat-panel-live.mjs), and no key is registered with the system: quiet mode answers the
 * registration without making it, and the check calls the function the chord would have.
 */
import fs from "node:fs";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/quick-chat-panel");
const js = (v) => JSON.stringify(v);

const rows = [];
const row = (name, value, ok) => {
  if (ok === false) process.exitCode = 1;
  rows.push({ group: "both", name, value, ok });
  console.log(`${ok === undefined ? "    " : ok ? "PASS" : "FAIL"} both      ${name}  ${js(value)}`);
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

fs.mkdirSync(OUT_DIR, { recursive: true });
const calendar = noCalendar();
const app = await launchLiveApp({ name: "quick-chat-panel-both", inspect: true, env: { ...calendar.env, REALM_FAKE_STANDS_IN: "claude,codex" } });
const watchdog = setTimeout(() => { console.error("FAIL watchdog: the check ran for two minutes"); process.exit(9); }, 120_000);

const main = (body) => app.main.eval(`(() => { const { BrowserWindow, globalShortcut } = require("electron");
  const panel = BrowserWindow.getAllWindows().find((w) => !w.isResizable());
  ${body} })()`);
const panelVisible = () => main(`return panel?.isVisible() === true;`);
const press = () => main(`globalThis.__quickChatChord.press(); return true;`);

/** Every `sessions.delete` a page sends from here on is counted on that page. */
const countDeletes = (page) => page.eval(`(() => { const counting = window.__deletes !== undefined; window.__deletes = 0; if (counting) return true;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (frame) { if (typeof frame === "string" && frame.includes('"sessions.delete"')) window.__deletes++; return send.call(this, frame); };
  return true; })()`);
const deletes = (page) => page.eval(`window.__deletes`);
const hasCard = (page) => page.eval(`document.querySelector(".quick-chat") !== null`);
/** The chat's trash. A chat nothing was said in has nothing to lose, so it deletes without asking. */
const trash = (page) => page.eval(`(() => { document.querySelector('.quick-chat [aria-label="Close quick chat"]').click(); return true; })()`);
const exists = (id) => api.call("sessions.get", { id }).then((s) => s !== null, () => false);

let api = null;
let panelPage = null;
try {
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Panel check" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });

  await main(`const register = globalShortcut.register; globalShortcut.register = (accelerator, cb) => { globalThis.__quickChatChord = { press: cb }; return register(accelerator, cb); }; return true;`);
  await app.page.eval(`window.realm.quickChatPanel.setShortcut("mod+ctrl+alt+shift+f19")`);

  /** The panel open on a chat, and the same chat put up in the window's card with ⌥⌘N. */
  const openInBoth = async () => {
    await press();
    await until(panelVisible, 20_000, "the panel to open");
    panelPage ??= await until(async () => {
      for (const t of (await app.targets()).filter((x) => x.type === "page")) {
        const c = await cdp(t.webSocketDebuggerUrl);
        if (await c.eval(`window.realm?.surface === "quick-chat"`).catch(() => false)) return c;
        c.close();
      }
      return null;
    }, 20_000, "the panel's page");
    await until(() => hasCard(panelPage), 20_000, "the chat in the panel");
    const id = await until(async () => (await api.call("settings.get", { key: "ui.quickChat" })).value?.sessionId, 10_000, "the chat's session");
    for (const type of ["keyDown", "keyUp"]) await app.page.send("Input.dispatchKeyEvent", { type, key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 5 });
    await until(() => hasCard(app.page), 10_000, "the window's card");
    await sleep(400);
    const stored = (await api.call("settings.get", { key: "ui.quickChat" })).value?.sessionId;
    return { id, sameChat: stored === id && await hasCard(panelPage) && await panelVisible() };
  };

  /* ── the panel deletes it ────────────────────────────────────────────────────────────────── */
  const first = await openInBoth();
  await countDeletes(app.page);
  await countDeletes(panelPage);
  row("one chat is up in the window's card and in the panel", first, first.sameChat);
  await trash(panelPage);
  await until(async () => !(await exists(first.id)), 10_000, "the session to be deleted");
  const cardGone = await until(async () => !(await hasCard(app.page)), 5_000, "the window's card to come down").then(() => true, () => false);
  await sleep(500);
  const afterPanel = { windowCardGone: cardGone, panelPutAway: !(await panelVisible()), deletesFromPanel: await deletes(panelPage), deletesFromWindow: await deletes(app.page),
    windowSaidAnError: await app.page.eval(`document.querySelector(".toast[role=alert]") !== null`) };
  row("the panel's trash deleted it: the window's card is gone and it was deleted once", afterPanel,
    afterPanel.windowCardGone && afterPanel.deletesFromPanel === 1 && afterPanel.deletesFromWindow === 0 && !afterPanel.windowSaidAnError);

  /* ── the window deletes it ───────────────────────────────────────────────────────────────── */
  if (await hasCard(app.page)) { await trash(app.page); await until(async () => !(await hasCard(app.page)), 5_000, "the stale card to close"); }
  if (await panelVisible()) await press();
  await until(async () => !(await panelVisible()), 10_000, "the panel to close");
  const second = await openInBoth();
  await countDeletes(app.page);
  await countDeletes(panelPage);
  row("a new chat is up in both again", second, second.sameChat && second.id !== first.id);
  await trash(app.page);
  await until(async () => !(await exists(second.id)), 10_000, "the session to be deleted");
  const putAway = await until(async () => !(await panelVisible()), 5_000, "the panel to be put away").then(() => true, () => false);
  await sleep(500);
  const afterWindow = { panelPutAway: putAway, windowCardGone: !(await hasCard(app.page)), deletesFromWindow: await deletes(app.page), deletesFromPanel: await deletes(panelPage) };
  row("the window's trash deleted it: the panel is put away and it was deleted once", afterWindow,
    afterWindow.panelPutAway && afterWindow.windowCardGone && afterWindow.deletesFromWindow === 1 && afterWindow.deletesFromPanel === 0);
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows-followup.txt"), rows.map((r) => `${r.ok === undefined ? "    " : r.ok ? "PASS" : "FAIL"} ${r.group.padEnd(9)} ${r.name}  ${js(r.value)}`).join("\n") + "\n");
  panelPage?.close();
  api?.close();
  clearTimeout(watchdog);
  await app.stop();
  calendar.remove();
}
process.exit(process.exitCode ?? 0);
