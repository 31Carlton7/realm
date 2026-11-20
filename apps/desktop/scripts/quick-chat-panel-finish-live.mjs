/**
 * Live check for the quick chat panel's finishing pass (run with:
 * node apps/desktop/scripts/quick-chat-panel-finish-live.mjs; `pnpm build` first). The BUILT app on a
 * scratch home, quiet, with the scripted agent and a stand-in for the calendar helper, and the
 * renderer over http so the squircle worklet loads as it does in the app.
 *
 * Rows, in `rows-finish.txt` under LIVE_OUT_DIR:
 *
 *   open      key to visible on the first open after launch and on the next two, from the function
 *             the chord calls to the panel shown and to its prompter drawn. Three launches.
 *   bar       what the bar says before the first answer and after it
 *   save      ⌘Return with an empty prompter on a chat with one answer that was never saved, in the
 *             panel and in a Realm window's card (⌥⌘N): it ends saved in the space it ran in and open
 *             there in a Realm window
 *   picture   the panel in dark and light, Plain and Glass, empty and answered, each laid over a busy
 *             backdrop and a white one. The window's material is macOS's and is in no page capture,
 *             so the backdrop stands in for the worst of what could be behind it.
 *
 * Nothing here reaches the person at the Mac: the windows stay quiet's, no key is registered with
 * the system (quiet mode answers the registration without making it), and the check calls the
 * function the chord would have.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/quick-chat-panel-finish");
const LAUNCHES = Number(process.env.LIVE_LAUNCHES ?? 3);
const js = (v) => JSON.stringify(v);
const CHORD = "mod+ctrl+alt+shift+f19";
const ASK_PANEL = "what is this panel";
const ASK_CARD = "what is this card";
const REPLY = "A small window that holds the quick chat.";

const rows = [];
const row = (group, name, value, ok) => {
  if (ok === false) process.exitCode = 1;
  rows.push({ group, name, value, ok });
  console.log(`${ok === undefined ? "    " : ok ? "PASS" : "FAIL"} ${group.padEnd(9)} ${name}  ${js(value)}`);
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
const scriptFile = path.join(OUT_DIR, "fake-script.json");
fs.writeFileSync(scriptFile, js([ASK_PANEL, ASK_CARD].map((on) => ({ on, emit: [{ kind: "text", text: REPLY }] }))));

const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");
let current = null;
const watchdog = setTimeout(async () => {
  console.error("FAIL watchdog: the check ran for six minutes");
  await current?.app.stop().catch(() => {});
  current?.calendar.remove();
  web.kill();
  process.exit(9);
}, 360_000);

/** One launch: the app up on a space, the chord's function taken, and helpers bound to it. */
async function launch() {
  const calendar = noCalendar();
  // A home of its own as well as a Realm home: nothing the app or the scripted agent reads under ~ is the person's.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "realm-finish-home-"));
  const app = await launchLiveApp({ name: "quick-chat-panel-finish", inspect: true, rendererUrl,
    env: { ...calendar.env, HOME: home, REALM_FAKE_STANDS_IN: "claude,codex", REALM_FAKE_SCRIPT: scriptFile } });
  const stopApp = app.stop;
  app.stop = async () => { await stopApp(); fs.rmSync(home, { recursive: true, force: true }); };
  const api = rpc(app.ports.server, await daemonToken(app.home));
  try { return await ready({ app, api, calendar }); } catch (err) {
    console.error(`page at the failure: ${await app.page.eval(`document.body.innerText.slice(0, 400)`).catch(() => "?")}`);
    api.close(); await app.stop(); calendar.remove();
    throw err;
  }
}

async function ready({ app, api, calendar }) {
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const first = await api.call("spaces.create", { profileId: profile.id, name: "Panel check" });
  const other = await api.call("spaces.create", { profileId: profile.id, name: "Elsewhere" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: first.id });
  // Reloaded only once main's own load has finished: a reload under it aborts the load main awaits.
  await until(() => app.main.eval(`require("electron").BrowserWindow.getAllWindows().some((w) => w.isResizable() && !w.webContents.isLoading())`), 30_000, "the window's first load");
  await app.page.send("Page.reload");
  await until(() => app.page.eval(`document.readyState === "complete" && document.body.innerText.includes("Panel check")`), 30_000, "the window on its space");
  await app.main.eval(`(() => { const { globalShortcut } = require("electron"); const register = globalShortcut.register;
    globalShortcut.register = (accelerator, cb) => { globalThis.__quickChatChord = { press: cb }; return register(accelerator, cb); }; return true; })()`);
  await app.page.eval(`window.realm.quickChatPanel.setShortcut(${js(CHORD)})`);
  return { app, api, calendar, first, other };
}

const panelOf = `require("electron").BrowserWindow.getAllWindows().find((w) => !w.isResizable())`;
const panelVisible = (app) => app.main.eval(`${panelOf}?.isVisible() === true`);

/** The chord's function, timed in main from the press to the panel shown and to its prompter drawn. */
const timedPress = (app) => app.main.eval(`(async () => {
  // Bound now: the inspector's \`require\` is gone by the time a callback below runs.
  const { BrowserWindow } = require("electron");
  const panel = () => BrowserWindow.getAllWindows().find((w) => !w.isResizable());
  const madeBefore = !!panel();
  const t0 = performance.now();
  globalThis.__quickChatChord.press();
  const wait = async (fn) => { for (;;) { if (await fn()) return Math.round(performance.now() - t0); if (performance.now() - t0 > 20000) return null;
    await new Promise((r) => setTimeout(r, 2)); } };
  const shown = await wait(() => panel()?.isVisible() === true);
  const drawn = await wait(() => panel().webContents.executeJavaScript('!!document.querySelector(".quick-chat .composer-input")'));
  return { madeBefore, shownMs: shown, drawnMs: drawn };
})()`);
const closePanel = async (app) => {
  if (!(await panelVisible(app))) return;
  await app.main.eval(`globalThis.__quickChatChord.press(); true`);
  await until(async () => !(await panelVisible(app)), 10_000, "the panel to close");
};

async function attachPanel(app) {
  return until(async () => {
    for (const t of (await app.targets()).filter((x) => x.type === "page")) {
      const c = await cdp(t.webSocketDebuggerUrl);
      if (await c.eval(`window.realm?.surface === "quick-chat"`).catch(() => false)) { await c.send("Runtime.enable"); return c; }
      c.close();
    }
    return null;
  }, 20_000, "the panel's page");
}

const ask = (page, text) => page.eval(`(() => { const el = document.querySelector(".quick-chat .composer-input");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${js(text)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
const answered = (page) => until(() => page.eval(`document.querySelector(".quick-chat .transcript")?.textContent.includes(${js(REPLY)}) === true
  && !!document.querySelector(".quick-chat-save")`), 30_000, "the scripted reply");
const barTitle = (page) => page.eval(`document.querySelector(".quick-chat-title")?.textContent ?? null`);
const cmdReturn = async (page) => {
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 });
};

/** Where a ⌘Return left the chat: its space, whether it is listed there, and a Realm window showing it in a pane. */
async function landed({ app, api, first }, sessionId, asked) {
  const settled = await until(async () => {
    const session = await api.call("sessions.get", { id: sessionId });
    const listed = (await api.call("items.list", { spaceId: first.id })).some((i) => i.refId === sessionId);
    return session && listed ? { session, listed } : null;
  }, 15_000, "the chat to be saved").catch(() => null);
  const shownIn = await until(async () => {
    for (const t of (await app.targets()).filter((x) => x.type === "page")) {
      const c = await cdp(t.webSocketDebuggerUrl);
      const v = await c.eval(`(() => { if (window.realm?.surface === "quick-chat") return null;
        const pane = [...document.querySelectorAll(".session-pane")].find((p) => !p.closest(".quick-chat") && p.textContent.includes(${js(asked)}));
        return pane ? { space: document.querySelector(".sidebar-head, .sidebar-header, [data-space-name]")?.textContent?.trim() ?? null, card: !!document.querySelector(".quick-chat") } : null; })()`).catch(() => null);
      c.close();
      if (v) return v;
    }
    return null;
  }, 15_000, "a Realm window showing it").catch(() => null);
  const quick = (await api.call("settings.get", { key: "ui.quickChat" })).value ?? null;
  // A chat other than this one in the setting is a new one something started: say what it is.
  if (quick?.sessionId && quick.sessionId !== sessionId) {
    const s = await api.call("sessions.get", { id: quick.sessionId }).catch(() => null);
    console.log(`    note: ui.quickChat now ${js({ ...quick, title: s?.title, space: s?.spaceId === first.id ? "first space" : s?.spaceId })}`);
  }
  return { savedIn: settled?.session.spaceId === first.id ? "first space" : settled?.session.spaceId ?? null, listedThere: settled?.listed ?? false,
    openInAWindow: shownIn !== null, windowCardLeft: shownIn?.card ?? null, quickChatAfter: quick?.sessionId === sessionId ? "still this chat" : quick?.sessionId ? "another" : "none" };
}

/** The page's capture laid over a busy backdrop and over a white one, side by side. */
async function picture(page, file) {
  await sleep(500);
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const out = await page.eval(`(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const w = img.width, h = img.height, gap = 16;
    const cv = document.createElement("canvas"); cv.width = w * 2 + gap; cv.height = h;
    const g = cv.getContext("2d");
    const raw = document.createElement("canvas"); raw.width = w; raw.height = h; raw.getContext("2d").drawImage(img, 0, 0);
    const ground = raw.getContext("2d").getImageData(Math.round(w / 2), Math.round(h / 3), 1, 1).data[3];
    // Busy: saturated bands with black and white type running across them, a window full of something.
    const bands = ["#1d2b53", "#ffd6a5", "#7e2553", "#9bf6ff", "#008751", "#ffffff", "#ab5236", "#000000"];
    bands.forEach((c, i) => { g.fillStyle = c; g.fillRect(0, (i * h) / bands.length, w, h / bands.length + 1); });
    g.font = "600 15px Inter, sans-serif";
    for (let y = 14, n = 0; y < h; y += 19, n++) { g.fillStyle = n % 2 ? "#000" : "#fff"; g.fillText("A busy window behind the panel, with its own words in it", (n % 3) * -40, y); }
    g.fillStyle = "#ffffff"; g.fillRect(w + gap, 0, w, h);
    g.clearRect(w, 0, gap, h);
    g.drawImage(img, 0, 0); g.drawImage(img, w + gap, 0);
    return { png: cv.toDataURL("image/png").split(",")[1], groundAlpha: ground };
  })()`);
  fs.writeFileSync(file, Buffer.from(out.png, "base64"));
  return out.groundAlpha;
}

try {
  /* ── open: key to visible, three launches ────────────────────────────────────────────────── */
  for (let n = 1; n <= LAUNCHES; n++) {
    current = await launch();
    const { app } = current;
    // Realm up and settled: the window has drawn its prompter, then a pause for anything made after.
    await sleep(6000);
    const times = [];
    for (let i = 0; i < 3; i++) {
      times.push(await timedPress(app));
      await sleep(400);
      await closePanel(app);
      await sleep(600);
    }
    row("open", `launch ${n}: first, second and third open`, times, times.every((t) => t.shownMs !== null && t.drawnMs !== null));
    if (n < LAUNCHES) { current.api.close(); await app.stop(); current.calendar.remove(); current = null; }
  }

  const { app, api } = current;
  /* ── bar and pictures ────────────────────────────────────────────────────────────────────── */
  await timedPress(app);
  const panelPage = await attachPanel(app);
  await until(() => panelPage.eval(`!!document.querySelector(".quick-chat .composer-input")`), 20_000, "the panel's prompter");
  const empty = await barTitle(panelPage);
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await closePanel(app); await timedPress(app);
    await until(() => panelPage.eval(`document.documentElement.dataset.mode === ${js(mode)} && document.documentElement.hasAttribute("data-glass") === ${look === "glass"}`), 15_000, `the panel in ${mode} ${look}`);
    const alpha = await picture(panelPage, path.join(OUT_DIR, `panel-${mode}-${look}-empty.png`));
    row("picture", `${mode} ${look}, empty`, { file: `panel-${mode}-${look}-empty.png`, groundAlpha: alpha }, look === "plain" ? alpha === 255 : alpha < 255);
  }
  await ask(panelPage, ASK_PANEL);
  const asking = await barTitle(panelPage);
  await answered(panelPage);
  const after = await barTitle(panelPage);
  row("bar", "before the first answer, and after it", { empty, asking, answered: after },
    empty === "Quick chat" && after !== "New session");
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await closePanel(app); await timedPress(app);
    await until(() => panelPage.eval(`document.documentElement.dataset.mode === ${js(mode)} && document.documentElement.hasAttribute("data-glass") === ${look === "glass"}`), 15_000, `the panel in ${mode} ${look}`);
    const alpha = await picture(panelPage, path.join(OUT_DIR, `panel-${mode}-${look}-answered.png`));
    row("picture", `${mode} ${look}, answered`, { file: `panel-${mode}-${look}-answered.png`, groundAlpha: alpha }, look === "plain" ? alpha === 255 : alpha < 255);
  }
  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  await api.call("settings.set", { key: "ui.look", value: "plain" });

  /* ── save: ⌘Return in the panel ──────────────────────────────────────────────────────────── */
  const panelChat = (await api.call("settings.get", { key: "ui.quickChat" })).value?.sessionId;
  const panelBefore = { keptIn: (await api.call("settings.get", { key: "ui.quickChat" })).value?.keptIn ?? null,
    prompter: await panelPage.eval(`document.querySelector(".quick-chat .composer-input").value`),
    listed: (await api.call("items.list", { spaceId: current.first.id })).some((i) => i.refId === panelChat) };
  await cmdReturn(panelPage);
  const panelAfter = await landed(current, panelChat, ASK_PANEL);
  row("save", "panel: one answer, not saved, empty prompter, ⌘Return", { before: panelBefore, after: { ...panelAfter, panelPutAway: !(await panelVisible(app)) } },
    panelBefore.keptIn === null && panelBefore.prompter === "" && !panelBefore.listed
    && panelAfter.savedIn === "first space" && panelAfter.listedThere && panelAfter.openInAWindow);
  panelPage.close();

  /* ── save: ⌘Return in a Realm window's card ──────────────────────────────────────────────── */
  // ⌥⌘N is a key for when nothing is being typed in, and the session just opened has its prompter focused.
  await app.page.eval(`document.activeElement?.blur(); true`);
  for (const type of ["keyDown", "keyUp"]) await app.page.send("Input.dispatchKeyEvent", { type, key: "n", code: "KeyN", windowsVirtualKeyCode: 78, modifiers: 5 });
  await until(() => app.page.eval(`!!document.querySelector(".quick-chat .composer-input")`), 10_000, "the window's card");
  const cardChat = await until(async () => {
    const id = (await api.call("settings.get", { key: "ui.quickChat" })).value?.sessionId;
    return id && id !== panelChat ? id : null;
  }, 10_000, "the card's chat");
  await ask(app.page, ASK_CARD);
  await answered(app.page);
  const cardBefore = { keptIn: (await api.call("settings.get", { key: "ui.quickChat" })).value?.keptIn ?? null,
    prompter: await app.page.eval(`document.querySelector(".quick-chat .composer-input").value`),
    listed: (await api.call("items.list", { spaceId: current.first.id })).some((i) => i.refId === cardChat) };
  await cmdReturn(app.page);
  const cardAfter = await landed(current, cardChat, ASK_CARD);
  row("save", "window card (⌥⌘N): one answer, not saved, empty prompter, ⌘Return", { before: cardBefore, after: cardAfter },
    cardBefore.keptIn === null && cardBefore.prompter === "" && !cardBefore.listed
    && cardAfter.savedIn === "first space" && cardAfter.listedThere && cardAfter.openInAWindow && cardAfter.windowCardLeft === false);
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows-finish.txt"), rows.map((r) => `${r.ok === undefined ? "    " : r.ok ? "PASS" : "FAIL"} ${r.group.padEnd(9)} ${r.name}  ${js(r.value)}`).join("\n") + "\n");
  fs.rmSync(scriptFile, { force: true });
  if (current) {
    await current.app.page.eval(`window.realm.quickChatPanel.setShortcut(null)`).catch(() => {});
    current.api.close();
    await current.app.stop();
    current.calendar.remove();
  }
  web.kill();
  clearTimeout(watchdog);
}
process.exit(process.exitCode ?? 0);
