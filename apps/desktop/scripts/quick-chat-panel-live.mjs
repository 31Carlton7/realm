/**
 * Live check for the quick chat panel (run with: node apps/desktop/scripts/quick-chat-panel-live.mjs;
 * `pnpm build` first). The BUILT app on a scratch home, quiet, with the scripted agent, so nothing is
 * billed and nothing of the person's is touched.
 *
 * What it measures, each as a row in `rows.txt` under LIVE_OUT_DIR:
 *
 *   open      the function the chord calls opens and closes the panel, with a Realm window and with
 *             none; the front app before, during and after; a key pressed while it is open reaches
 *             its page, and reaches the app in front again once it is put away
 *   stand-in  with a second app really in front, that app's page hears no `blur` and no
 *             `visibilitychange` while the panel has the keyboard (and does hear one when the front
 *             app really changes, which is the control)
 *   chat      a turn in the panel on the scripted agent
 *   place     the panel comes back where it was left
 *   capture   eight capture paths with "Hide the quick chat from screen sharing" on, and off as the
 *             control: a path counts only where the control read
 *   chord     the chord registered with the system and given back, and what registering says when
 *             another process already holds it. A person pressing it is not something this can do:
 *             a posted key event did not set the system's hot key off
 *
 * What the person at the Mac can notice while it runs, all printed with their durations:
 *   - the keyboard is away from their app while the panel is key and while the stand-in is the front
 *     app (a few seconds in all; nothing they type is read);
 *   - the panel, shrunk to a 96 pt square in the bottom-right corner, is at 5% opacity while the
 *     capture paths run (about seven seconds), because at quiet mode's 1/255 no path can read even
 *     an unprotected window;
 *   - F19 is posted a handful of times, alone and once as ⌘⌃⌥⇧F19. That chord is the one registered,
 *     and it is given back before the check ends.
 * No app is made full screen, no permission is asked for (each helper checks and stops), and the
 * Dock is never touched. Not measured here, because they need the screen: the panel over a
 * full-screen app, in Mission Control, inside Realm as a regular Dock app, and a real meeting share.
 *
 * Pictures (dark and light, Plain and Glass) go to LIVE_OUT_DIR. They are the page alone: the
 * window's material is macOS's and is in no page capture, so the Glass ones are laid over a stand-in
 * backdrop to show where the ground is see-through.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, desktopRoot, launchLiveApp, sleep, spawnLiveElectron, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/quick-chat-panel");
const SOURCES = path.join(desktopRoot, "scripts/quick-chat-panel");
const js = (v) => JSON.stringify(v);
/** ⌘⌃⌥⇧F19: nobody presses it by accident, and F19 does nothing where it lands by mistake. */
const CHORD = "mod+ctrl+alt+shift+f19";
const ACCELERATOR = "Command+Control+Alt+Shift+F19";
const F19 = "80";
const REPLY = "A small window that holds the quick chat.";

const rows = [];
const row = (group, name, value, ok) => {
  if (ok === false) process.exitCode = 1;
  rows.push({ group, name, value, ok });
  console.log(`${ok === undefined ? "    " : ok ? "PASS" : "FAIL"} ${group.padEnd(9)} ${name}  ${typeof value === "string" ? value : js(value)}`);
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const scriptFile = path.join(OUT_DIR, "fake-script.json");
fs.writeFileSync(scriptFile, js([{ on: "what is this panel", emit: [{ kind: "text", text: REPLY }] }]));

const calendar = noCalendar();
const app = await launchLiveApp({
  name: "quick-chat-panel", inspect: true,
  env: { ...calendar.env, REALM_FAKE_STANDS_IN: "claude,codex", REALM_HTML_MENUS: "1", REALM_FAKE_SCRIPT: scriptFile, REALM_QUIET_REAL_KEY: "1", REALM_QUIET_GLOBAL_SHORTCUT: ACCELERATOR },
});
const watchdog = setTimeout(() => { console.error("FAIL watchdog: the check ran for five minutes"); process.exit(9); }, 300_000);

/* ── Helpers: built once into the scratch dir, each read-only or a single key press ─────────── */
const bin = path.join(app.scratch, "bin");
fs.mkdirSync(bin);
for (const tool of ["front", "sck", "post-key"]) execFileSync("swiftc", ["-O", "-o", path.join(bin, tool), path.join(SOURCES, `${tool}.swift`)], { stdio: ["ignore", "ignore", "inherit"] });
const tool = (name, ...args) => {
  try { return JSON.parse(execFileSync(path.join(bin, name), args.map(String), { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) { try { return JSON.parse(e.stdout); } catch { return { error: String(e.message).slice(0, 200) }; } }
};
const front = (...pids) => tool("front", "state", ...pids);
const frontApp = () => { const f = front().front; return f ? `${f.bundle} (${f.pid})` : "none"; };
const pressKey = (...args) => tool("post-key", ...args);

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

/** A child that answers one JSON line per line it is sent. */
function lines(child) {
  const it = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await it.next()).value);
  return { next, tell: async (cmd) => { child.stdin.write(`${typeof cmd === "string" ? cmd : js(cmd)}\n`); return next(); } };
}

/* ── Main, over its inspector ─────────────────────────────────────────────────────────────── */
const main = (body) => app.main.eval(`(() => { const { BrowserWindow, globalShortcut, screen } = require("electron");
  const real = Object.getPrototypeOf(BrowserWindow.prototype);
  const panel = BrowserWindow.getAllWindows().find((w) => !w.isResizable());
  const windows = BrowserWindow.getAllWindows().filter((w) => w.isResizable());
  ${body} })()`);
const panelState = () => main(`return panel ? { visible: panel.isVisible(), key: real.isFocused.call(panel), title: panel.getTitle(), bounds: panel.getBounds(),
  onTop: panel.isAlwaysOnTop(), protected: panel.isContentProtected(), id: Number(panel.getMediaSourceId().split(":")[1]) } : null;`);
const panelVisible = async () => (await panelState())?.visible === true;
/** The function the chord calls, taken from main's own registration below. */
const press = () => main(`globalThis.__quickChatChord.press(); return true;`);
const open = async () => { await press(); await until(panelVisible, 20_000, "the panel to open"); await sleep(250); };
const close = async () => { await press(); await until(async () => !(await panelVisible()), 10_000, "the panel to close"); await sleep(150); };

let panelPage = null;
/** CDP on the panel's page: the one page whose preload says it is the quick chat surface. */
async function attachPanel() {
  panelPage?.close();
  panelPage = await until(async () => {
    for (const t of (await app.targets()).filter((x) => x.type === "page")) {
      const c = await cdp(t.webSocketDebuggerUrl);
      if (await c.eval(`window.realm?.surface === "quick-chat"`).catch(() => false)) return c;
      c.close();
    }
    return null;
  }, 20_000, "the panel's page");
  await panelPage.eval(`(() => { window.__keys = []; window.addEventListener("keydown", (e) => window.__keys.push(e.key), true); return true; })()`);
  return panelPage;
}
const panelKeys = () => panelPage.eval(`window.__keys.splice(0)`);

let api = null;
let standin = null;
let holder = null;
const before = front();
try {
  // Behind the lock screen nothing can take the keyboard and no app is in front, so no row here would mean anything.
  // LIVE_BEHIND_LOCK=1 runs anyway, for the rows that need neither: the chat, the place, the pictures.
  const locked = before.front?.bundle === "com.apple.loginwindow";
  if (locked && process.env.LIVE_BEHIND_LOCK !== "1") throw new Error("the screen is locked: unlock the Mac and run this again");
  if (locked) row("open", "THE SCREEN IS LOCKED: rows about the front app, the keyboard and the display are not measurements", "LIVE_BEHIND_LOCK=1");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Panel check" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });

  /* ── chord: registered through the Settings bridge, and main's own callback kept ─────────── */
  await main(`const register = globalShortcut.register; globalShortcut.register = (accelerator, cb) => { globalThis.__quickChatChord = { accelerator, press: cb }; return register(accelerator, cb); }; return true;`);
  const shortcut = await app.page.eval(`window.realm.quickChatPanel.setShortcut(${js(CHORD)})`);
  row("chord", "Settings records ⌘⌃⌥⇧F19 and main registers it", { ...shortcut, isRegistered: await main(`return globalShortcut.isRegistered(${js(ACCELERATOR)});`) },
    shortcut.registered === true && (await main(`return globalThis.__quickChatChord.accelerator;`)) === ACCELERATOR);

  // Settings ▸ Keys as it stands now, reached as a person does (⌘K, Open settings), laid over the page
  // colour because the capture keeps the pane's alpha.
  await app.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
  await app.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
  const keysTab = await (async () => {
    await until(() => app.page.eval(`!!document.querySelector(".palette input")`), 5_000, "the palette");
    await app.page.eval(`(() => { const input = document.querySelector(".palette input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Open settings");
      input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await sleep(300);
    await app.page.eval(`[...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.includes("Open settings"))?.click(); true`);
    return until(() => app.page.eval(`(() => { const row = [...document.querySelectorAll(".page-rail button, .page-rail [role=tab], .page-rail label, .sidebar button")].find((b) => b.textContent.trim() === "Keys"); if (!row) return false; row.click(); return true; })()`), 10_000, "Settings' Keys page");
  })().catch(() => false);
  const rowsBox = keysTab && await until(() => app.page.eval(`(() => { const r = document.querySelector('[data-setting="quick-chat-shortcut"]')?.closest(".field")?.getBoundingClientRect(); return r ? { x: r.x - 16, y: r.y - 12, width: r.width + 32, height: r.height + 24 } : null; })()`), 10_000, "the quick chat rows").catch(() => null);
  if (rowsBox) {
    await sleep(300);
    const { data } = await app.page.send("Page.captureScreenshot", { format: "png", clip: { ...rowsBox, scale: 2 } });
    const flat = await app.page.eval(`(async () => { const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim() || "#111"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0);
      return cv.toDataURL("image/png").split(",")[1]; })()`);
    fs.writeFileSync(path.join(OUT_DIR, "settings-keys-quick-chat.png"), Buffer.from(flat, "base64"));
  }
  row("picture", "Settings ▸ Keys, the quick chat rows", rowsBox ? "settings-keys-quick-chat.png" : "not captured", rowsBox ? true : undefined);

  /* ── open: with a Realm window ───────────────────────────────────────────────────────────── */
  row("open", "front app before", frontApp());
  row("open", "Realm windows open, panel made", await main(`return { windows: windows.length, panel: !!panel };`));
  let t0 = Date.now();
  console.log("KEYBOARD TAKEN (the panel is key)");
  await open();
  await attachPanel();
  const shown = await panelState();
  const during = front(app.electron.pid);
  row("open", "panel after the chord's function", shown, shown.visible && shown.key && shown.title === "" && shown.onTop);
  row("open", "front app while the panel is key", frontApp(), during.front?.pid === before.front?.pid);
  row("open", "the panel as the window server lists it", during.apps?.[app.electron.pid]?.windows?.find((w) => w.id === shown.id) ?? null);
  row("open", "Realm's process while the panel is key", { policy: during.apps?.[app.electron.pid]?.policy, active: during.apps?.[app.electron.pid]?.active }, during.apps?.[app.electron.pid]?.active === false);
  row("open", "Realm's own window was not made key", await main(`return windows.map((w) => real.isFocused.call(w));`), (await main(`return windows.every((w) => !real.isFocused.call(w));`)) === true);
  const posted = pressKey(F19);
  await sleep(250);
  const typed = await panelKeys();
  row("open", "F19 pressed while it is open reaches the panel's page", { posted, panelSaw: typed }, typed.includes("F19"));
  await close();
  console.log(`KEYBOARD BACK after ${Date.now() - t0} ms`);
  pressKey(F19);
  await sleep(250);
  const after = await panelKeys();
  row("open", "F19 pressed after it is put away does not reach it", { panelSaw: after }, after.length === 0);
  row("open", "front app after", frontApp(), front().front?.pid === before.front?.pid);

  /* ── stand-in: a second app really in front ──────────────────────────────────────────────── */
  const child = spawnLiveElectron([path.join(SOURCES, "standin.cjs")], {
    frontApp: "the page in front has to be really key to be told anything",
    env: { ...process.env, STANDIN_USER_DATA: path.join(app.scratch, "standin") }, stdio: ["pipe", "pipe", "ignore"],
  });
  standin = lines(child);
  const s = await standin.next();
  t0 = Date.now();
  console.log("KEYBOARD TAKEN (the stand-in is the front app)");
  const activated = await standin.tell({ do: "activate", wait: 400 });
  row("stand-in", "stand-in made the front app", { front: frontApp(), page: activated.page }, front().front?.pid === s.pid);
  await open();
  await attachPanel();
  const told = await standin.tell({ do: "noop", wait: 100 });
  row("stand-in", "front app while the panel is key", frontApp(), front().front?.pid === s.pid);
  row("stand-in", "what the stand-in's page was told", told.page,
    !told.page.log.some((l) => l === "blur" || l.startsWith("visibility")) && told.page.hasFocus === true && told.page.visibility === "visible");
  row("stand-in", "its window's own answer to isFocused()", told.windowFocused);
  pressKey(F19);
  await sleep(250);
  const toPanel = await panelKeys();
  const notToStandin = await standin.tell({ do: "noop", wait: 50 });
  row("stand-in", "F19 goes to the panel, not the page in front", { panelSaw: toPanel, standinSaw: notToStandin.page.log }, toPanel.includes("F19") && !notToStandin.page.log.includes("keydown F19"));
  await close();
  pressKey(F19);
  const back = await standin.tell({ do: "noop", wait: 250 });
  row("stand-in", "after the panel is put away F19 reaches the page in front again", { standinSaw: back.page.log, panelSaw: await panelKeys() }, back.page.log.includes("keydown F19"));
  // The control: when the front app really changes, the same page is told.
  tool("front", "activate", before.front.pid);
  const left = await standin.tell({ do: "noop", wait: 500 });
  row("stand-in", "control: told when the front app really changes", { front: frontApp(), page: left.page.log, app: left.appEvents }, left.page.log.includes("blur"));
  console.log(`KEYBOARD BACK after ${Date.now() - t0} ms`);
  await standin.tell({ do: "quit" }).catch(() => {});
  standin = null;
  if (front().front?.pid !== before.front?.pid) { tool("front", "activate", before.front.pid); await sleep(300); }
  row("stand-in", "front app at the end", frontApp(), front().front?.pid === before.front?.pid);

  /* ── chat: a turn in the panel ───────────────────────────────────────────────────────────── */
  t0 = Date.now();
  await open();
  await until(() => panelPage.eval(`!!document.querySelector(".quick-chat .composer-input")`), 20_000, "the panel's prompter");
  row("chat", "the prompter has the keyboard when the panel opens", await panelPage.eval(`document.activeElement?.className ?? ""`), (await panelPage.eval(`document.activeElement?.classList.contains("composer-input") === true`)));
  await panelPage.eval(`(() => { const el = document.querySelector(".quick-chat .composer-input");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "what is this panel");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(() => panelPage.eval(`document.querySelector(".quick-chat .transcript")?.textContent.includes(${js(REPLY)}) === true`), 30_000, "the scripted reply in the panel");
  const quick = (await api.call("settings.get", { key: "ui.quickChat" })).value;
  const session = await api.call("sessions.get", { id: quick.sessionId });
  const listed = (await api.call("items.list", { spaceId: space.id })).some((i) => i.refId === session.id);
  row("chat", "a turn in the panel on the scripted agent", { asked: "what is this panel", answered: REPLY, agent: session.agentKind, space: session.spaceId === space.id, listedInSidebar: listed, markedPanel: quick.panel === true },
    session.spaceId === space.id && !listed && quick.panel === true);
  row("chat", "the Realm window put up no card for it", await app.page.eval(`document.querySelector(".quick-chat") === null`), (await app.page.eval(`document.querySelector(".quick-chat") === null`)));

  /* ── pictures ────────────────────────────────────────────────────────────────────────────── */
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await close();
    await open();
    await until(() => panelPage.eval(`document.documentElement.dataset.mode === ${js(mode)} && document.documentElement.hasAttribute("data-glass") === ${look === "glass"}`), 15_000, `the panel in ${mode} ${look}`);
    await sleep(400);
    const { data } = await panelPage.send("Page.captureScreenshot", { format: "png" });
    const flat = await panelPage.eval(`(async () => {
      const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext("2d");
      const raw = document.createElement("canvas"); raw.width = img.width; raw.height = img.height;
      raw.getContext("2d").drawImage(img, 0, 0);
      const ground = raw.getContext("2d").getImageData(Math.round(img.width / 2), 8, 1, 1).data;
      // Standing in for the material: bands of colour, so a see-through ground shows them and a solid one does not.
      const bands = ${js(mode === "dark" ? ["#1d2b53", "#7e2553", "#008751", "#ab5236"] : ["#ffd6a5", "#caffbf", "#9bf6ff", "#ffc6ff"])};
      bands.forEach((c, i) => { g.fillStyle = c; g.fillRect(0, (i * cv.height) / bands.length, cv.width, cv.height / bands.length + 1); });
      g.drawImage(img, 0, 0);
      return { png: cv.toDataURL("image/png").split(",")[1], groundAlpha: ground[3], size: [img.width, img.height] };
    })()`);
    const file = path.join(OUT_DIR, `panel-${mode}-${look}.png`);
    fs.writeFileSync(file, Buffer.from(flat.png, "base64"));
    row("picture", `${mode} ${look}`, { file: path.basename(file), groundAlpha: flat.groundAlpha, size: flat.size }, look === "plain" ? flat.groundAlpha === 255 : flat.groundAlpha < 255);
  }
  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  await api.call("settings.set", { key: "ui.look", value: "plain" });
  await close();
  console.log(`KEYBOARD BACK after ${Date.now() - t0} ms (the panel was key for the chat and the pictures)`);

  /* ── open: with no Realm window ──────────────────────────────────────────────────────────── */
  await main(`for (const w of windows) w.close(); return true;`);
  await until(async () => (await main(`return windows.length;`)) === 0, 10_000, "Realm's window to close");
  const resident = await until(async () => (await api.call("system.info", {})).detachedSince, 10_000, "Realm to go resident beside the panel");
  row("open", "last Realm window closed with the panel made: Realm went resident", { detachedSince: resident }, typeof resident === "number");
  t0 = Date.now();
  await open();
  const alone = await panelState();
  row("open", "panel with no Realm window open", { windows: await main(`return windows.length;`), ...alone, front: frontApp() }, alone.visible && alone.key && front().front?.pid === before.front?.pid);
  await close();
  row("open", "and put away by the same function", (await panelState()).visible, (await panelState()).visible === false);

  /* ── place ───────────────────────────────────────────────────────────────────────────────── */
  const display = await main(`return screen.getPrimaryDisplay().workArea;`);
  const dragged = { x: display.x + 137, y: display.y + 211 };
  await open();
  await main(`panel.setPosition(${dragged.x}, ${dragged.y}); return true;`);
  await sleep(700);
  await close();
  await main(`panel.destroy(); return true;`);
  await open();
  await attachPanel();
  const again = await panelState();
  row("place", "a new panel opens where the last one was left, with no Realm window", { leftAt: dragged, opensAt: { x: again.bounds.x, y: again.bounds.y }, windows: await main(`return windows.length;`) },
    again.bounds.x === dragged.x && again.bounds.y === dragged.y);
  console.log(`KEYBOARD BACK after ${Date.now() - t0} ms`);

  /* ── capture: the eight paths, setting on, and off as the control ────────────────────────── */
  const whole = await main(`return screen.getPrimaryDisplay().bounds;`);
  const size = 96;
  const corner = { x: display.x + display.width - size - 6, y: display.y + display.height - size - 6 };
  await main(`panel.setMinimumSize(${size}, ${size}); panel.setBounds({ x: ${corner.x}, y: ${corner.y}, width: ${size}, height: ${size} }); panel.blur(); return true;`);
  await panelPage.eval(`(() => { const d = document.createElement("div"); d.id = "capture-cover"; d.style.cssText = "position:fixed;inset:0;z-index:2147483647"; document.body.append(d); return true; })()`);
  const id = (await panelState()).id;
  const fraction = [(corner.x - whole.x + size / 4) / whole.width, (corner.y - whole.y + size / 4) / whole.height, size / 2 / whole.width, size / 2 / whole.height];
  const LABELS = [["shotDisplay", "SCScreenshotManager, display"], ["shotWindow", "SCScreenshotManager, the window alone"], ["streamDisplay", "SCStream frame, display"],
    ["streamWindow", "SCStream frame, the window alone"], ["legacyDisplay", "CGWindowListCreateImage, display rectangle"], ["legacyWindow", "CGWindowListCreateImage, the window alone"]];
  const tmp = path.join(app.scratch, "capture");
  fs.mkdirSync(tmp);
  const capture = {};
  let raisedMs = 0;
  for (const hidden of [false, true]) {
    await panelPage.eval(`window.realm.quickChatPanel.setHideFromSharing(${hidden})`);
    await until(async () => (await panelState()).protected === hidden, 5_000, `content protection ${hidden}`);
    const colours = {};
    for (const [pass, colour] of [["red", "#ff0000"], ["blue", "#0000ff"], ["red again", "#ff0000"]]) {
      await panelPage.eval(`document.getElementById("capture-cover").style.background = ${js(colour)}`);
      await sleep(150);
      const t = Date.now();
      await main(`panel.setOpacity(0.05); return true;`);
      await sleep(150);
      const seen = {};
      const shot = (args, file) => { try { execFileSync("/usr/sbin/screencapture", [...args, file], { stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 }); return fs.existsSync(file) ? null : "no file written"; } catch (e) { return `${e.stderr ?? e.message}`.trim().slice(0, 120); } };
      const windowFile = path.join(tmp, "window.png"), displayFile = path.join(tmp, "display.png");
      const windowError = shot(["-x", "-o", "-l", String(id)], windowFile);
      seen["screencapture -l, the window"] = windowError ? { error: windowError } : tool("sck", "png", windowFile);
      const displayError = shot(["-x", "-D", "1"], displayFile);
      seen["screencapture -D 1, display"] = displayError ? { error: displayError } : tool("sck", "png", displayFile, ...fraction);
      const sck = tool("sck", "all", id, id);
      for (const [key, label] of LABELS) seen[label] = sck.control?.[key] ?? { error: sck.error ?? sck.control?.error ?? "no result" };
      seen.listed = { inShareableContent: sck.control?.inShareableContent, serverSharingState: sck.control?.serverSharingState };
      await main(`panel.setOpacity(1 / 255); return true;`);
      raisedMs += Date.now() - t;
      for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f));
      colours[pass] = seen;
    }
    capture[hidden] = colours;
  }
  /* A path reads the panel when its colour moves from red to blue. The third pass, red again, is
     what tells the panel moving it from the screen behind moving it: if red and red again differ,
     something else in that corner changed while the check ran, and the path is not judged. */
  const between = (a, b) => Math.max(...[0, 1, 2].map((c) => Math.abs(a.rgba[c] - b.rgba[c])));
  const reads = (hidden, label) => {
    const [red, blue, again] = ["red", "blue", "red again"].map((pass) => capture[hidden][pass][label]);
    const error = red.error ?? blue.error ?? again.error;
    if (error) return { reads: false, error };
    if ([red, blue, again].every((c) => (c.rgba[3] ?? 255) === 0)) return { reads: false, diff: 0, note: "a fully transparent image" };
    const diff = between(red, blue), drift = between(red, again);
    return drift >= 3 ? { reads: null, diff, drift, note: "the screen behind changed during the check" } : { reads: diff >= 3, diff, drift };
  };
  row("capture", "the panel was at 5% opacity, 96 pt, bottom-right, for", `${raisedMs} ms`);
  for (const label of ["screencapture -l, the window", "screencapture -D 1, display", ...LABELS.map((l) => l[1])]) {
    const control = reads(false, label), hidden = reads(true, label);
    row("capture", label, { settingOff: control, settingOn: hidden }, control.reads === true && hidden.reads !== null ? !hidden.reads : undefined);
  }
  row("capture", "still listed to capturing apps with the setting on", capture.true.red.listed);
  row("capture", "the window's title, as listed", js((await panelState()).title), (await panelState()).title === "");
  await close();
  await main(`panel.destroy(); return true;`);

  /* ── chord: given back, and held by another process ─────────────────────────────────────── */
  await open();
  await attachPanel();
  // Not a person's press: an event posted with the four modifier flags, which the system's hot keys
  // may not take for the chord. Whatever it does is written down, and judged as nothing.
  const synthetic = pressKey(F19, "command", "control", "option", "shift");
  await sleep(800);
  row("chord", "a posted ⌘⌃⌥⇧F19 (no person pressed it): did the panel close", { posted: synthetic, closed: !(await panelVisible()) });
  if (!(await panelVisible())) await open();
  await panelPage.eval(`window.realm.quickChatPanel.setShortcut(null)`);
  row("chord", "cleared in Settings: given back to the system", { isRegistered: await main(`return globalShortcut.isRegistered(${js(ACCELERATOR)});`) }, (await main(`return globalShortcut.isRegistered(${js(ACCELERATOR)});`)) === false);
  const holderChild = spawnLiveElectron([path.join(SOURCES, "holder.cjs")], { env: { ...process.env, REALM_QUIET_GLOBAL_SHORTCUT: ACCELERATOR }, stdio: ["pipe", "pipe", "ignore"] });
  holder = lines(holderChild);
  const held = await holder.next();
  const second = await panelPage.eval(`window.realm.quickChatPanel.setShortcut(${js(CHORD)})`);
  row("chord", "registering it while another process holds it", { holderRegistered: held.registered, realmToldRegistered: second.registered });
  await holder.tell("quit").catch(() => {});
  holder = null;
  await panelPage.eval(`window.realm.quickChatPanel.setShortcut(null)`);
  await close();
  row("chord", "nothing left registered at the end", { isRegistered: await main(`return globalShortcut.isRegistered(${js(ACCELERATOR)});`) }, (await main(`return globalShortcut.isRegistered(${js(ACCELERATOR)});`)) === false);
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  await standin?.tell({ do: "quit" }).catch(() => {});
  await holder?.tell("quit").catch(() => {});
  if (before.front && front().front?.pid !== before.front.pid) tool("front", "activate", before.front.pid);
  row("end", "front app when the check ended", frontApp(), front().front?.pid === before.front?.pid);
  fs.writeFileSync(path.join(OUT_DIR, "rows.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "rows.txt"), rows.map((r) => `${r.ok === undefined ? "    " : r.ok ? "PASS" : "FAIL"} ${r.group.padEnd(9)} ${r.name}  ${typeof r.value === "string" ? r.value : js(r.value)}`).join("\n") + "\n");
  fs.rmSync(scriptFile, { force: true });
  panelPage?.close();
  api?.close();
  clearTimeout(watchdog);
  await app.stop();
  calendar.remove();
}
process.exit(process.exitCode ?? 0);
