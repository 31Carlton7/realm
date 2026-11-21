/**
 * Live check for the meeting assistant in the quick chat panel (run with:
 * node apps/desktop/scripts/meeting-assistant-live.mjs; `pnpm build` first). The BUILT app on a
 * scratch home, quiet, with the scripted agent, the calendar stand-in, and the renderer over http.
 *
 * No microphone and no system audio: the speech helper is a stand-in (`REALM_VOICE_BIN`) that reads
 * its Me and Them lines from a file, main is told the microphone is granted so nothing asks, and the
 * panel's page gets a silent stream in place of `getUserMedia`. The clipboard is the page's stand-in
 * too, so "Tell the room" writes nothing to the Mac's own.
 *
 * Nothing is billed and nothing leaves the Mac. The quick chat model is Claude so the live answers
 * run, and under the scripted agent they are the server's scripted answer (`ScriptedLiveAnswers`): no
 * process, no request. `REALM_REAL_LIVE_ANSWERS` is cleared, never set. The fake stands in for Claude
 * (`REALM_FAKE_STANDS_IN`), so the summary turn is the scripted agent's, answered from a script.
 *
 * Rows, in `rows.txt` under LIVE_OUT_DIR:
 *
 *   sheet     a Start before the first-run sheet was accepted puts it up and listens to nothing
 *   listen    accepted: the Me and Them lines from the file, in order, the red mark in the panel's
 *             bar, and the menu bar's item (quiet mode keeps it out of the menu bar and records it)
 *   hidden    the panel hidden from screen sharing while it listens, and the mark still drawn
 *   room      "Tell the room" hands the notice to the clipboard
 *   answer    a typed question draws the scripted answer, streamed piece by piece
 *   stop      Stop takes both marks down and keeps the words
 *   notes     Stop writes the notes file: the panel names its path, and the file in the scratch home
 *             holds the transcript, the typed question and the scripted summary
 *   open      the path opens the file in a Realm window's Documents pane
 *   long      past 20,000 characters of custom info the prompter says every answer sends it, and
 *             the words still send
 *   reload    a reload of the panel's page while it listens stops the stand-in helper and takes the
 *             menu bar's mark down
 *   consent   the acceptance is kept as the setting M3c reads
 *   picture   the panel in dark and light, Plain and Glass, in each of the three states
 *
 * The assistant's keys (M3b), through a key helper stand-in (`REALM_KEYS_BIN`) that taps nothing: it
 * logs how main started it and what main told it, and says the chord lines this script writes.
 *
 *   register  no chord is registered, and no helper started able to swallow, before the sheet is
 *             accepted; after the accept every chord is, with no relaunch
 *   settings  Settings ▸ Keys: the switch says the keys wait on the first Start until then, and the
 *             rows in dark and light, Plain and Glass, before and after
 *   bar       the bar's title, mark, Auto-answer switch and mic button side by side at 380 pt, in
 *             dark and light, Plain and Glass
 *   keys      each chord does what it names: R shows the assistant and puts it away, G answers, T
 *             types, J and K scroll, , and . move the panel, L starts and stops; R, L and G leave the
 *             keyboard where it was and T takes it
 *   chat      the quick chat chord and a double-tap of Command open on the chat, after an assistant key
 *   heard     G after a reload says the assistant is not listening and names Fn L, and asks nothing
 *   reloaded  a key pressed after a reload reaches the reloaded page
 *
 * "Start the assistant when a call starts" (M3c), through a meetingwatch stand-in whose calls mode
 * says Zoom holds the microphone, or nothing does, as this script writes it:
 *
 *   auto      before the sheet is accepted a call starting changes nothing; after it, a call
 *             starting opens the panel without the keyboard and listens, with the mark up; after a
 *             Stop, the microphone let go and taken back starts nothing
 *   meetings  Settings ▸ General ▸ Meetings: the row's switch, its title saying a Stop holds, and the
 *             row in dark and light, Plain and Glass
 *   glass-held in place of a Glass picture, why the app draws chosen glass plain on this machine
 *             (Reduce Transparency, Low Power Mode, or no backdrop-filter url())
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/meeting-assistant");
const SCRIPTED_ANSWER = "Scripted answer: twelve seats to start, on the annual plan.";
const SUMMARY = "## Summary\n\nThe pilot runs four weeks with two teams, priced per seat.\n\n## Decisions\n\nNone\n\n## Action items\n\n- Me: send the pricing sheet.";
const js = (v) => JSON.stringify(v);
const CHORD = "mod+ctrl+alt+shift+f19";
const CONSENT_KEY = "meetings.assistantConsentAt";
/** The key codes the helper says for each chord (main/realm-keys.ts's CHORD_KEY_CODES). */
const CODES = { R: 15, L: 37, G: 5, T: 17, J: 38, K: 40, ",": 43, ".": 47 };

/** What the stand-in helper says, after the first audio arrives: `wait` ms after the line before. */
const LINES = [
  { source: "them", text: "Thanks for joining. Can you walk us through the pilot?", wait: 300 },
  { source: "me", text: "Sure. It runs for four weeks with two teams.", wait: 400 },
  { source: "them", text: "What does it cost after the pilot?", wait: 400 },
  { source: "me", text: "It is priced per seat. I can send the sheet after this.", wait: 400 },
];

const rows = [];
const row = (group, name, value, ok) => {
  if (ok === false) process.exitCode = 1;
  rows.push({ group, name, value, ok });
  console.log(`${ok === undefined ? "    " : ok ? "PASS" : "FAIL"} ${group.padEnd(8)} ${name}  ${js(value)}`);
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
const tools = fs.mkdtempSync(path.join(os.tmpdir(), "realm-meeting-live-tools-"));
const linesFile = path.join(tools, "lines.json");
fs.writeFileSync(linesFile, js(LINES));
const scriptFile = path.join(tools, "fake-script.json");
fs.writeFileSync(scriptFile, js([{ on: "You are writing the notes for a meeting that has just ended.", emit: [{ kind: "text", text: SUMMARY }] }]));
const voiceBin = path.join(tools, "realmvoice");
/** The continuous stand-in's pid, written as it starts, so a row can tell whether it is still running. */
const helperPidFile = path.join(tools, "helper.pid");
fs.writeFileSync(voiceBin, `#!${process.execPath}
// A stand-in for realmvoice: continuous mode's wire, with lines read from a file.
const fs = require("node:fs");
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
if (process.argv[2] !== "continuous") { out({ t: "ready", stt: "none" }); process.stdin.resume(); return; }
const lines = JSON.parse(fs.readFileSync(${js(linesFile)}, "utf8"));
fs.writeFileSync(${js(helperPidFile)}, String(process.pid));
const startedAt = Date.now();
out({ t: "ready", stt: "analyzer", startedAt, systemAudio: "granted" });
let fed = false, at = 0;
const timers = [];
const feed = () => {
  let wait = 0;
  for (const l of lines) {
    wait += l.wait;
    timers.push(setTimeout(() => {
      const start = Date.now() - startedAt;
      out({ t: "partial", source: l.source, text: l.text.split(" ").slice(0, 3).join(" "), start });
      timers.push(setTimeout(() => out({ t: "line", source: l.source, text: l.text, start, end: start + 200, at: startedAt + start }), 120));
    }, wait));
  }
};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.t === "tap") out({ t: "tap", state: "capturing" });
    if (e.t === "audio" && !fed) { fed = true; feed(); }
    if (e.t === "stop") { for (const t of timers) clearTimeout(t); out({ t: "stopped" }); process.exit(0); }
  }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });

/** A stand-in for realmkeys: no tap. It logs its arguments and each line main sends, says it may
 *  swallow, and writes out whatever is added to `say` after it started. */
const keysDir = path.join(tools, "keys");
fs.mkdirSync(keysDir);
const keysBin = path.join(keysDir, "realmkeys");
const keysSay = path.join(keysDir, "say");
const keysLog = path.join(keysDir, "log.jsonl");
fs.writeFileSync(keysSay, "");
fs.writeFileSync(keysBin, `#!${process.execPath}
const fs = require("node:fs");
const log = (e) => fs.appendFileSync(${js(keysLog)}, JSON.stringify(e) + "\\n");
log({ argv: process.argv.slice(2) });
console.log(JSON.stringify({ ready: true, active: true }));
let said = fs.readFileSync(${js(keysSay)}, "utf8").length;
setInterval(() => { const all = fs.readFileSync(${js(keysSay)}, "utf8"); process.stdout.write(all.slice(said)); said = all.length; }, 100);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { log({ config: JSON.parse(line) }); } catch {} }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
const keysLogged = () => (fs.existsSync(keysLog) ? fs.readFileSync(keysLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const chord = (key) => fs.appendFileSync(keysSay, `${js({ t: "chord", code: CODES[key] })}\n`);
const doubleTap = () => fs.appendFileSync(keysSay, `${js({ t: "doubleTap" })}\n`);

/** A stand-in for meetingwatch: its calendar mode says access was never asked for, and its calls mode
 *  says the last line of `holders` every half second, as the helper says who holds the microphone. */
const watchDir = path.join(tools, "watch");
fs.mkdirSync(watchDir);
const watchBin = path.join(watchDir, "meetingwatch");
const watchHolders = path.join(watchDir, "holders");
const watchLog = path.join(watchDir, "log.jsonl");
fs.writeFileSync(watchHolders, `${js({ holders: [], titled: [] })}\n`);
fs.writeFileSync(watchBin, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${js(watchLog)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
if (process.argv[2] === "calls") {
  setInterval(() => process.stdout.write(fs.readFileSync(${js(watchHolders)}, "utf8").trim().split("\\n").at(-1) + "\\n"), 500);
} else {
  console.log(JSON.stringify({ access: "notDetermined" }));
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
const watchModes = () => (fs.existsSync(watchLog) ? fs.readFileSync(watchLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv[0]) : []);
/** Zoom takes the microphone, or nothing holds it. */
const zoomHolds = (on) => fs.appendFileSync(watchHolders, `${js({ holders: on ? ["us.zoom.xos"] : [], titled: [] })}\n`);
/** Main says a call started after `CALL_START_MS` (3 s) of holding, and ended after `CALL_END_MS` (5 s) of not. */
const CALL_SETTLE_MS = 8000;

let web = null;
let rendererUrl = null;
let current = null;
const watchdog = setTimeout(async () => {
  console.error("FAIL watchdog: the check ran for five minutes");
  await current?.app.stop().catch(() => {});
  current?.calendar.remove();
  web?.kill();
  process.exit(9);
}, 300_000);

async function launch() {
  const calendar = noCalendar();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "realm-meeting-home-"));
  const app = await launchLiveApp({ name: "meeting-assistant", inspect: true, rendererUrl,
    env: { ...calendar.env, REALM_MEETINGWATCH_BIN: watchBin, HOME: home, REALM_KEYS_BIN: keysBin, REALM_VOICE_BIN: voiceBin, REALM_FAKE_SCRIPT: scriptFile, REALM_FAKE_STANDS_IN: "claude", REALM_REAL_LIVE_ANSWERS: "" } });
  const stopApp = app.stop;
  app.stop = async () => { await stopApp(); fs.rmSync(home, { recursive: true, force: true }); };
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Stub space" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });
  await api.call("settings.set", { key: "quickChatModel", value: { agentKind: "claude", model: "claude-haiku-5-5" } });
  const { root } = await api.call("documents.spaceRoot", { spaceId: space.id });
  await until(() => app.main.eval(`require("electron").BrowserWindow.getAllWindows().some((w) => w.isResizable() && !w.webContents.isLoading())`), 30_000, "the window's first load");
  await app.page.send("Page.reload");
  await until(() => app.page.eval(`document.readyState === "complete" && document.body.innerText.includes("Stub space")`), 30_000, "the window on its space");
  // The microphone reads as granted, so nothing asks; the page never reaches the real one (below).
  await app.main.eval(`(() => { const { systemPreferences, globalShortcut } = require("electron");
    systemPreferences.getMediaAccessStatus = () => "granted";
    const register = globalShortcut.register;
    globalShortcut.register = (accelerator, cb) => { globalThis.__quickChatChord = { press: cb }; return register(accelerator, cb); }; return true; })()`);
  await app.page.eval(`window.realm.quickChatPanel.setShortcut(${js(CHORD)})`);
  return { app, api, calendar, root };
}

const panelOf = `require("electron").BrowserWindow.getAllWindows().find((w) => !w.isResizable())`;
const panelVisible = (app) => app.main.eval(`${panelOf}?.isVisible() === true`);
const press = (app) => app.main.eval(`globalThis.__quickChatChord.press(); true`);
const openPanel = async (app) => { if (!(await panelVisible(app))) await press(app); await until(() => panelVisible(app), 10_000, "the panel to open"); };
/** The panel's own Escape path: the quick chat chord turns a panel on the assistant to the chat. */
const closePanel = async (app, page) => {
  if (await panelVisible(app)) await page.eval(`window.realm.quickChatPanel.hide(); true`);
  await until(async () => !(await panelVisible(app)), 10_000, "the panel to close");
};
const onAssistant = (page) => page.eval(`!!document.querySelector(".meeting-strip")`);
/** The quick chat keys open on the chat; the mic button turns it back to the assistant. */
const showAssistant = async (page) => {
  if (!(await onAssistant(page))) await page.eval(`document.querySelector('.quick-chat-bar button[aria-label="Meeting assistant"]').click(); true`);
  await until(() => onAssistant(page), 10_000, "the assistant view");
};
/** Counts main's calls that give the panel the keyboard, on the panel's own window and page. */
const countFocus = (app) => app.main.eval(`(() => { const w = ${panelOf};
  if (!w.__focusCounted) {
    w.__focusCounted = true;
    const focus = w.focus.bind(w), pageFocus = w.webContents.focus.bind(w.webContents);
    w.focus = () => { globalThis.__panelFocus++; return focus(); };
    w.webContents.focus = () => { globalThis.__panelFocus++; return pageFocus(); };
  }
  globalThis.__panelFocus = 0; return true; })()`);
const focusCalls = (app) => app.main.eval(`globalThis.__panelFocus`);
const panelX = (app) => app.main.eval(`${panelOf}.getPosition()[0]`);
const workArea = (app) => app.main.eval(`(() => { const w = ${panelOf}; return require("electron").screen.getDisplayMatching(w.getBounds()).workArea; })()`);
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const quietTray = (app) => app.main.eval(`globalThis[Symbol.for("realm.quietTrays")]?.listening ?? null`);

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

/** The page's capture laid over a busy backdrop and over a white one, side by side (as #609's check). */
async function picture(page, file) {
  await sleep(500);
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const out = await page.eval(`(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const w = img.width, h = img.height, gap = 16;
    const cv = document.createElement("canvas"); cv.width = w * 2 + gap; cv.height = h;
    const g = cv.getContext("2d");
    const bands = ["#1d2b53", "#ffd6a5", "#7e2553", "#9bf6ff", "#008751", "#ffffff", "#ab5236", "#000000"];
    bands.forEach((c, i) => { g.fillStyle = c; g.fillRect(0, (i * h) / bands.length, w, h / bands.length + 1); });
    g.font = "600 15px Inter, sans-serif";
    for (let y = 14, n = 0; y < h; y += 19, n++) { g.fillStyle = n % 2 ? "#000" : "#fff"; g.fillText("A busy window behind the panel, with its own words in it", (n % 3) * -40, y); }
    g.fillStyle = "#ffffff"; g.fillRect(w + gap, 0, w, h);
    g.clearRect(w, 0, gap, h);
    g.drawImage(img, 0, 0); g.drawImage(img, w + gap, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  fs.writeFileSync(file, Buffer.from(out, "base64"));
}

/** Why the page draws chosen glass plain: the conditions `plainReason` reads, in its order, read as
 *  use-look.ts reads them. */
const PLAIN_REASON = `(() => {
  if (window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) return "reduce-transparency";
  if (document.documentElement.hasAttribute("data-low-power-mode")) return "low-power-mode";
  if (!(typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("backdrop-filter", "url(#a)"))) return "no-backdrop-url";
  return null; })()`;

/** Waits for the page to draw `look` in `mode`. When it draws chosen glass plain, writes a glass-held
 *  row naming why and returns true, so the caller skips that look's picture. */
async function lookHeld(page, mode, look, what, waiting) {
  const shown = await until(() => page.eval(`(() => {
    if (document.documentElement.dataset.mode !== ${js(mode)}) return null;
    if (document.documentElement.hasAttribute("data-glass") === ${look === "glass"}) return { held: null };
    const held = ${look === "glass" ? PLAIN_REASON : "null"};
    return held ? { held } : null; })()`), 15_000, waiting).catch(async (err) => {
    const had = await page.eval(`({ mode: document.documentElement.dataset.mode ?? null, glass: document.documentElement.hasAttribute("data-glass"),
      visibility: document.visibilityState, plainReason: ${PLAIN_REASON} })`).catch((e) => ({ unread: e.message }));
    throw new Error(`${err.message}; the root had ${js(had)}`);
  });
  if (shown.held) row("glass-held", `${what} glass drawn plain, so no picture`, shown.held);
  return !!shown.held;
}

async function everyLook({ app, api }, page, state) {
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await closePanel(app, page); await openPanel(app); await showAssistant(page);
    if (await lookHeld(page, mode, look, `${state}, ${mode}`, `the panel in ${mode} ${look}`)) continue;
    const file = `m3a-${state}-${mode}-${look}.png`;
    await picture(page, path.join(OUT_DIR, file));
    row("picture", `${state}, ${mode} ${look}`, file);
  }
}

/** The bar at the panel's width: the title, the mark, the Auto-answer switch and the mic button each
 *  whole, side by side and inside it, and a capture of the bar alone. */
async function barLooks({ app, api }, page) {
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await closePanel(app, page); await openPanel(app); await showAssistant(page);
    if (await lookHeld(page, mode, look, `the bar, ${mode}`, `the bar in ${mode} ${look}`)) continue;
    await sleep(400);
    const fit = await page.eval(`(() => {
      const bar = document.querySelector(".quick-chat-bar"), b = bar.getBoundingClientRect();
      const parts = { title: ".quick-chat-title", mark: ".meeting-mark", auto: ".meeting-auto", mic: 'button[aria-label="Meeting assistant"]' };
      // An icon button's scroll box takes in its ::after hit area (styles.css), so it is measured by its icon.
      const clipped = (el, r) => { const icon = el.matches(".icon-btn") ? el.querySelector("svg")?.getBoundingClientRect() : null;
        return icon ? icon.left < r.left || icon.right > r.right || icon.top < r.top || icon.bottom > r.bottom : el.scrollWidth > el.clientWidth; };
      const rects = Object.fromEntries(Object.entries(parts).map(([k, sel]) => { const el = bar.querySelector(sel); const r = el?.getBoundingClientRect();
        return [k, r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), clipped: clipped(el, r) } : null]; }));
      const order = ["title", "mark", "auto", "mic"].map((k) => rects[k]);
      const inside = order.every((r) => r && r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom);
      const apart = order.every((r, i) => i === 0 || (r && order[i - 1] && order[i - 1].right <= r.left));
      return { width: Math.round(window.innerWidth), bar: { x: b.left, y: b.top, width: b.width, height: b.height }, rects, inside, apart };
    })()`);
    const file = `m3b-bar-${mode}-${look}.png`;
    const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { ...fit.bar, scale: 2 } });
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(data, "base64"));
    row("bar", `title, mark, Auto-answer and mic at ${fit.width} pt, ${mode} ${look}`, { ...fit, file },
      fit.width === 380 && fit.inside && fit.apart && Object.values(fit.rects).every((r) => r && !r.clipped));
  }
}

/** Reloads the Realm window, which comes back on its space or on the Settings it was showing. */
async function reloadWindow(app) {
  await app.page.send("Page.reload");
  await until(() => app.page.eval(`document.readyState === "complete" && (document.body.innerText.includes("Stub space") || !!document.querySelector('input[name="settings-page-tab"]'))`), 30_000, "the window back after its reload")
    .catch(async (error) => {
      const shown = await app.page.eval(`document.readyState + ": " + document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 300)`).catch(() => "unread");
      throw new Error(`${error.message}; the window showed ${js(shown)}`);
    });
}

/** Settings ▸ Keys in the Realm window: the assistant's rows, read and captured in each look. */
async function settingsLooks({ app, api }, state, waiting) {
  const openKeys = async () => {
    await app.main.eval(`require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send("app:command", "settings.open"); true`);
    await until(() => app.page.eval(`!!document.querySelector('input[name="settings-page-tab"][value="keys"]')`), 10_000, "Settings");
    await app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="keys"]').click(); true`);
    await until(() => app.page.eval(`!!document.querySelector('[data-setting="assistant-chord:."]')`), 10_000, "Settings ▸ Keys");
    // The note shows once Settings has read the acceptance; with no note to wait on, the read is given a moment.
    if (waiting) await until(() => app.page.eval(`document.querySelector('[data-setting="assistant-chords"]').innerText.includes(${js(waiting)})`), 5000, "the note that the keys wait").catch(() => {});
    else await sleep(1000);
  };
  await openKeys();
  const said = await app.page.eval(`document.querySelector('[data-setting="assistant-chords"]').innerText.replace(/\\s+/g, " ").trim()`);
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await reloadWindow(app);
    await openKeys();
    if (await lookHeld(app.page, mode, look, `Settings ▸ Keys, ${state}, ${mode}`, `Settings in ${mode} ${look}`)) continue;
    await sleep(400);
    const clip = await app.page.eval(`(() => { const first = document.querySelector('[data-setting="assistant-chords"]'); first.scrollIntoView({ block: "start" });
      const a = first.getBoundingClientRect(), z = document.querySelector('[data-setting="assistant-chord:."]').getBoundingClientRect();
      return { x: a.left, y: a.top, width: a.width, height: z.bottom - a.top }; })()`);
    const file = `m3b-settings-${state}-${mode}-${look}.png`;
    const { data } = await app.page.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(data, "base64"));
    row("picture", `Settings ▸ Keys, ${state}, ${mode} ${look}`, file);
  }
  await app.page.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await until(() => app.page.eval(`!document.querySelector('input[name="settings-page-tab"]')`), 10_000, "Settings to close").catch(() => {});
  return said;
}

/** Settings ▸ General ▸ Meetings in the Realm window: "Start the assistant when a call starts" turned
 *  on by its own switch, its title read, and the row captured in each look. */
async function meetingsLooks({ app, api }) {
  const ROW = '[data-setting="start-assistant"]';
  const openGeneral = async () => {
    await app.main.eval(`require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send("app:command", "settings.open"); true`);
    await until(() => app.page.eval(`!!document.querySelector('input[name="settings-page-tab"][value="general"]')`), 10_000, "Settings");
    await app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="general"]').click(); true`);
    await until(() => app.page.eval(`!!document.querySelector(${js(ROW)})`), 10_000, "Settings ▸ General ▸ Meetings");
  };
  await openGeneral();
  const before = await app.page.eval(`document.querySelector(${js(ROW + " input")}).checked`);
  if (!before) await app.page.eval(`document.querySelector(${js(ROW + " input")}).click(); true`);
  const on = await until(async () => (await api.call("settings.get", { key: "meetings.startAssistantWithCall" })).value === true || null, 10_000, "the switch to be kept").catch(() => false);
  const title = await app.page.eval(`document.querySelector(${js(ROW)}).title`);
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await reloadWindow(app);
    await openGeneral();
    if (await lookHeld(app.page, mode, look, `Settings ▸ General ▸ Meetings, ${mode}`, `Settings in ${mode} ${look}`)) continue;
    await sleep(400);
    const clip = await app.page.eval(`(() => { const r = document.querySelector(${js(ROW)}); r.scrollIntoView({ block: "center" });
      const b = r.closest(".settings-list").getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
    const file = `m3c-settings-${mode}-${look}.png`;
    const { data } = await app.page.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(data, "base64"));
    row("picture", `Settings ▸ General ▸ Meetings, ${mode} ${look}`, file);
  }
  await app.page.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await until(() => app.page.eval(`!document.querySelector('input[name="settings-page-tab"]')`), 10_000, "Settings to close").catch(() => {});
  return { before, on, title };
}

/** No real microphone: a silent stream stands in for it. No real clipboard: the page keeps what it is
 *  given. Each stand-in is marked, so a check can tell it is still the one in place. */
const STAND_INS = `(() => {
  const getUserMedia = async () => { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    g.gain.value = 0; const d = ctx.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start(); return d.stream; };
  getUserMedia.realmStandIn = true;
  navigator.mediaDevices.getUserMedia = getUserMedia;
  window.__copied = [];
  const writeText = async (t) => { window.__copied.push(t); };
  writeText.realmStandIn = true;
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return true; })()`;
const STAND_IN_CHECKS = {
  microphone: `navigator.mediaDevices.getUserMedia.realmStandIn === true`,
  clipboard: `navigator.clipboard?.writeText?.realmStandIn === true`,
};
/** Before a click that could reach the Mac's own microphone or clipboard: the run stops if the stand-in is gone. */
async function standInStill(page, what) {
  if (!(await page.eval(STAND_IN_CHECKS[what]))) throw new Error(`the ${what} stand-in is gone from the panel's page`);
}

/** Every text an element matching `selector` shows from now on, in order, read by a MutationObserver. */
const watchTexts = (page, key, selector) => page.eval(`(() => { const seen = window[${js(key)}] = [];
  const read = () => { const t = document.querySelector(${js(selector)})?.textContent ?? null; if (t !== null && seen.at(-1) !== t) seen.push(t); };
  new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true }); read(); return true; })()`);
const setDraft = (page, text) => page.eval(`(() => { const el = document.querySelector(".quick-chat .composer-input");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${js(text)});
  el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const click = (page, selector) => page.eval(`(() => { const b = document.querySelector(${js(selector)}); if (!b) return false; b.click(); return true; })()`);
const clickByText = (page, scope, text) => page.eval(`(() => { const b = [...document.querySelectorAll(${js(scope)} + " button")].find((x) => x.textContent.trim() === ${js(text)}); if (!b) return false; b.click(); return true; })()`);
const typeAndSend = (page, text) => page.eval(`(() => { const el = document.querySelector(".quick-chat .composer-input");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${js(text)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);

try {
  const httpPort = await freePort();
  web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
  rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
  await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");
  current = await launch();
  const { app, api } = current;
  await sleep(3000);
  await openPanel(app);
  const page = await attachPanel(app);
  await until(() => page.eval(`!!document.querySelector(".quick-chat .composer-input")`), 20_000, "the panel's prompter");
  // On this document now, and on any the page loads after it. A page agent not enabled runs no script on a new document.
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await page.eval(STAND_INS);

  /* ── register, settings: before the sheet is accepted ─────────────────────────────────────── */
  const WAITING = "They start working after your first Start in the meeting assistant.";
  const saidBefore = await settingsLooks(current, "before-consent", WAITING);
  row("settings", "before the first Start, the switch says the keys wait on it", saidBefore, saidBefore.includes(WAITING));
  const unregistered = keysLogged();
  row("register", "before the sheet is accepted: no chord registered, no helper able to swallow", unregistered,
    unregistered.length > 0 && unregistered.every((e) => (e.argv ? !e.argv.includes("--swallow") : e.config.chords.length === 0)));

  /* ── meetings, auto: before the sheet is accepted ───────────────────────────────────────────── */
  const meetingsRow = await meetingsLooks(current);
  const watching = await until(async () => watchModes().includes("calls") || null, 10_000, "the calls helper").catch(() => false);
  row("meetings", "the switch turns it on, and the microphone is watched only then", { ...meetingsRow, watching, modes: watchModes() },
    meetingsRow.before === false && meetingsRow.on === true && watching === true);
  row("meetings", "the row's title says a Stop holds", meetingsRow.title, /After you stop it, it does not start again for that call or meeting\./.test(meetingsRow.title));
  await closePanel(app, page);
  await standInStill(page, "microphone");
  zoomHolds(true);
  await sleep(CALL_SETTLE_MS);
  const unaccepted = { visible: await panelVisible(app), mark: await page.eval(`!!document.querySelector(".meeting-mark")`), tray: await quietTray(app),
    sheet: await page.eval(`!!document.querySelector('.sheet[aria-label="Before you start listening"]')`),
    consent: (await api.call("settings.get", { key: CONSENT_KEY })).value ?? null };
  row("auto", "before the sheet is accepted, a call starting changes nothing", unaccepted,
    !unaccepted.visible && !unaccepted.mark && unaccepted.tray === null && !unaccepted.sheet && unaccepted.consent === null);
  zoomHolds(false);
  await sleep(CALL_SETTLE_MS);
  // Off until the accepted rows at the end, so the runs between have no call to hold.
  await api.call("settings.set", { key: "meetings.startAssistantWithCall", value: false });
  await app.page.eval(`window.realm.meetings.setStartAssistantWithCall(false)`);
  await openPanel(app);

  /* ── sheet ─────────────────────────────────────────────────────────────────────────────────── */
  await click(page, '.quick-chat-bar button[aria-label="Meeting assistant"]');
  await until(() => page.eval(`!!document.querySelector(".meeting-strip")`), 10_000, "the assistant view");
  const consentBefore = (await api.call("settings.get", { key: CONSENT_KEY })).value ?? null;
  await standInStill(page, "microphone");
  await clickByText(page, ".meeting-strip", "Start listening");
  await until(() => page.eval(`!!document.querySelector('.sheet[aria-label="Before you start listening"]')`), 10_000, "the first-run sheet");
  await sleep(600);
  const sheetKeys = await page.eval(`[...document.querySelectorAll(".meeting-consent li")].at(-1).textContent`);
  row("sheet", "the sheet names the keys with the held key, and where to turn them off", sheetKeys,
    sheetKeys === "From any app, Fn R shows the assistant, Fn L listens, Fn G answers and Fn T asks. Turn them off in Settings ▸ Keys.");
  const sheetState = { consentBefore, mark: await page.eval(`!!document.querySelector(".meeting-mark")`), tray: await quietTray(app),
    text: await page.eval(`document.querySelector(".meeting-consent").innerText`) };
  row("sheet", "Start before acceptance: the sheet, and nothing listening", sheetState,
    consentBefore === null && !sheetState.mark && sheetState.tray === null && /your job/.test(sheetState.text) && /California/.test(sheetState.text)
    && /any question you typed/.test(sheetState.text) && /Nothing else leaves the Mac\./.test(sheetState.text));
  await everyLook(current, page, "sheet");

  /* ── listen ────────────────────────────────────────────────────────────────────────────────── */
  await standInStill(page, "microphone");
  await clickByText(page, ".sheet", "Start listening");
  await until(() => page.eval(`document.querySelectorAll(".meeting-line:not([data-partial])").length === ${LINES.length}`), 20_000, "every line from the file");
  // The other side's questions are answered on their own; let those settle before the typed one.
  await sleep(1500);
  await click(page, '.meeting-strip input[value="context"]');
  await typeAndSend(page, "They care about the price after the pilot.");
  await click(page, '.meeting-strip input[value="ask"]');
  await watchTexts(page, "__answers", ".meeting-answer-text");
  await typeAndSend(page, "How many seats should I offer?");
  await until(() => page.eval(`document.querySelector(".meeting-answer")?.dataset.state === "done"`), 15_000, "the typed question's answer");
  const streamed = await page.eval(`window.__answers`);
  // The watch starts on the answer already up (the other side's question); the typed one starts at "Answering…".
  const pieces = streamed.slice(streamed.lastIndexOf("Answering…") + 1);
  const answer = { streamed, asked: await page.eval(`[...document.querySelectorAll(".meeting-asked")].map((q) => q.textContent)`) };
  row("answer", "a typed question draws the scripted answer, streamed", answer,
    pieces.at(-1) === SCRIPTED_ANSWER && pieces.length >= 3 && pieces.slice(0, -1).every((t) => SCRIPTED_ANSWER.startsWith(t) && t.length < SCRIPTED_ANSWER.length)
    && answer.asked.includes("How many seats should I offer?"));
  const listening = {
    lines: await page.eval(`[...document.querySelectorAll(".meeting-line")].map((l) => l.querySelector(".meeting-who").textContent + ": " + l.querySelector(".meeting-words").textContent)`),
    mark: await page.eval(`document.querySelector(".quick-chat-bar .meeting-mark")?.textContent ?? null`),
    tray: await quietTray(app).then((t) => t && { title: t.title, toolTip: t.toolTip, menu: t.menu, destroyed: t.destroyed }),
  };
  row("listen", "Me and Them from the file, the mark in the bar and in the menu bar", listening,
    js(listening.lines) === js(LINES.map((l) => `${l.source === "me" ? "Me" : "Them"}: ${l.text}`)) && listening.mark === "Listening"
    && listening.tray?.title === "Listening" && listening.tray.menu.includes("Stop listening") && listening.tray.destroyed === false);
  const registered = await until(async () => {
    const log = keysLogged();
    const swallows = log.some((e) => e.argv?.includes("--swallow"));
    const chords = log.filter((e) => e.config).at(-1)?.config.chords ?? [];
    return swallows && chords.length === Object.keys(CODES).length ? { swallows, chords } : null;
  }, 10_000, "the chords registered after the accept").catch(() => null);
  row("register", "after the accept, every chord registered, with no relaunch", registered,
    !!registered && Object.values(CODES).every((c) => registered.chords.includes(c)));
  await barLooks(current, page);

  /* ── keys: R, the quick chat keys, G and T ──────────────────────────────────────────────────── */
  await closePanel(app, page);
  await countFocus(app);
  chord("R");
  await until(() => panelVisible(app), 10_000, "R to open the panel");
  await until(() => onAssistant(page), 10_000, "R to show the assistant");
  const rFocus = await focusCalls(app);
  row("keys", "R opens the panel on the assistant, keyboard left where it was", { focus: rFocus }, rFocus === 0);
  chord("R");
  const rAway = await until(async () => !(await panelVisible(app)), 10_000, "R to put the panel away").catch(() => false);
  row("keys", "R from the assistant puts the panel away", { hidden: rAway }, rAway === true);

  await countFocus(app);
  await press(app);
  await until(() => panelVisible(app), 10_000, "the quick chat chord to open the panel");
  await sleep(300);
  const chatAfterKey = { assistant: await onAssistant(page), focus: await focusCalls(app) };
  row("chat", "after an assistant key, the quick chat chord opens on the chat, with the keyboard", chatAfterKey, !chatAfterKey.assistant && chatAfterKey.focus > 0);
  chord("R");
  await until(() => onAssistant(page), 10_000, "R to turn the chat to the assistant");
  const rOnChat = await panelVisible(app);
  row("keys", "R turns a panel open on the chat to the assistant, and leaves it open", { visible: rOnChat }, rOnChat);
  await press(app);
  await until(async () => !(await onAssistant(page)), 10_000, "the quick chat chord to turn the assistant to the chat");
  const chatOnAssistant = await panelVisible(app);
  row("chat", "the quick chat chord turns a panel on the assistant to the chat, and leaves it open", { visible: chatOnAssistant }, chatOnAssistant);
  await closePanel(app, page);
  chord("G");
  await until(() => panelVisible(app), 10_000, "G to open the panel");
  await closePanel(app, page);
  doubleTap();
  await until(() => panelVisible(app), 10_000, "a double-tap to open the panel");
  await sleep(300);
  const tapOnAssistant = await onAssistant(page);
  row("chat", "after an assistant key, a double-tap of Command opens on the chat", { assistant: tapOnAssistant }, !tapOnAssistant);

  await closePanel(app, page);
  await click(page, ".meeting-answer-dismiss");
  await countFocus(app);
  chord("G");
  await until(() => panelVisible(app), 10_000, "G to open the panel");
  const gAnswer = await until(() => page.eval(`document.querySelector(".meeting-answer")?.dataset.state ?? null`), 15_000, "G's answer").catch(() => null);
  const gState = { assistant: await onAssistant(page), answer: gAnswer, focus: await focusCalls(app) };
  row("keys", "G opens on the assistant and answers from what was heard, keyboard left where it was", gState,
    gState.assistant && !!gState.answer && gState.focus === 0);

  await closePanel(app, page);
  await click(page, '.meeting-strip input[value="context"]');
  await countFocus(app);
  chord("T");
  await until(() => panelVisible(app), 10_000, "T to open the panel");
  await until(() => page.eval(`document.activeElement?.classList.contains("composer-input") === true`), 10_000, "T to focus the prompter").catch(() => {});
  const tState = { focus: await focusCalls(app), prompter: await page.eval(`document.activeElement?.classList.contains("composer-input") === true`),
    ask: await page.eval(`document.querySelector('.meeting-strip input[value="ask"]')?.checked === true`) };
  row("keys", "T opens the panel with the keyboard, the prompter focused and set to Ask", tState, tState.focus > 0 && tState.prompter && tState.ask);

  const trayPng = await quietTray(app).then((t) => t?.png);
  if (trayPng) fs.writeFileSync(path.join(OUT_DIR, "m3a-tray-mark.png"), Buffer.from(trayPng, "base64"));
  const hidden = { contentProtected: await app.main.eval(`${panelOf}.isContentProtected?.() ?? null`),
    mark: await page.eval(`!!document.querySelector(".quick-chat-bar .meeting-mark")`) };
  row("hidden", "hidden from screen sharing while listening, and the mark still drawn", hidden, hidden.contentProtected === true && hidden.mark);
  await everyLook(current, page, "listening");
  // After the pictures: its toast would stand over the strip in them.
  await standInStill(page, "clipboard");
  await clickByText(page, ".meeting-strip", "Tell the room");
  await sleep(200);
  const copied = await page.eval(`window.__copied`);
  row("room", "Tell the room puts the notice on the clipboard", copied, copied.length === 1 && /transcribe this call/.test(copied[0]));

  /* ── stop ──────────────────────────────────────────────────────────────────────────────────── */
  await watchTexts(page, "__notes", ".meeting-notes > span");
  await clickByText(page, ".meeting-strip", "Stop");
  await until(() => page.eval(`!document.querySelector(".meeting-mark")`), 10_000, "the mark to come down");
  const stopped = { lines: await page.eval(`document.querySelectorAll(".meeting-line").length`),
    tray: await quietTray(app).then((t) => t && { destroyed: t.destroyed }),
    again: await page.eval(`[...document.querySelectorAll(".meeting-strip button")].some((b) => b.textContent === "Start again")`) };
  row("stop", "Stop takes both marks down and keeps the words", stopped, stopped.lines === LINES.length && stopped.tray?.destroyed === true && stopped.again);
  await until(() => page.eval(`document.querySelector(".meeting-notes > span")?.textContent === "Notes saved."`), 30_000, "the notes to be saved").catch(() => {});
  const notesSaid = await page.eval(`window.__notes`);
  const shownPath = await page.eval(`document.querySelector(".meeting-notes-path")?.textContent ?? null`);
  const file = shownPath ? path.join(current.root, shownPath) : null;
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const notes = { said: notesSaid, path: shownPath, file, inScratch: !!file && file.startsWith(os.tmpdir()) && !file.startsWith(path.join(os.homedir(), "Realm")),
    transcript: LINES.every((l) => text.includes(l.text)), question: text.includes("How many seats should I offer?"), summary: text.includes("priced per seat"),
    head: text.split("\n").slice(0, 3) };
  row("notes", "Stop writes the notes: the panel names the path, the file has the transcript", notes,
    /^meetings\/\d{4}-\d{2}-\d{2} \d{4} Meeting\.md$/.test(shownPath ?? "") && notes.inScratch && notes.transcript && notes.question && notes.summary
    && text.includes("## Transcript") && text.includes("## Notes"));
  const consent = (await api.call("settings.get", { key: CONSENT_KEY })).value;
  row("consent", "the acceptance kept as the setting", consent, typeof consent === "number" && consent > 0);
  await until(() => page.eval(`!document.querySelector(".toast")`), 20_000, "the toast to leave").catch(() => {});
  await everyLook(current, page, "stopped");

  /* ── open ──────────────────────────────────────────────────────────────────────────────────── */
  await click(page, ".meeting-notes-path");
  const name = path.basename(shownPath ?? "");
  const opened = await until(async () => {
    const tabs = await app.page.eval(`[...document.querySelectorAll(".documents-tab-label[title]")].map((t) => t.title)`);
    return name && tabs.some((t) => t.endsWith(name)) ? tabs : null;
  }, 20_000, "the file in a Documents pane").catch(() => null);
  const panelAway = !(await panelVisible(app));
  row("open", "the path opens the file in a Realm window's Documents pane", { tabs: opened, panelAway }, !!opened && panelAway);

  /* ── long ──────────────────────────────────────────────────────────────────────────────────── */
  await openPanel(app);
  await showAssistant(page);
  await click(page, '.meeting-strip input[value="context"]');
  // The draft counts with what is already kept, joined by a newline: this brings the whole to 20,000 exactly.
  const keptBefore = await page.eval(`[...document.querySelectorAll(".meeting-context > p")].map((p) => p.textContent).join("\\n").length`);
  await setDraft(page, "x".repeat(20_000 - keptBefore - 1));
  await sleep(200);
  const atLimit = await page.eval(`document.querySelector(".meeting-long")?.textContent ?? null`);
  await setDraft(page, "Background. ".repeat(1_700));
  await sleep(200);
  const past = await page.eval(`document.querySelector(".meeting-long")?.textContent ?? null`);
  const longPicture = "m3a-long.png";
  await picture(page, path.join(OUT_DIR, longPicture));
  await page.eval(`document.querySelector(".quick-chat .composer-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  await sleep(300);
  const kept = await page.eval(`document.querySelector(".meeting-context")?.textContent.length ?? 0`);
  const after = await page.eval(`document.querySelector(".meeting-long")?.textContent ?? null`);
  row("long", "past 20,000 characters the prompter warns, and the words still send", { atLimit, past, kept, after, picture: longPicture },
    atLimit === null && /^Every answer sends all 20,\d{3} characters of custom info\.$/.test(past ?? "") && kept > 20_000 && after !== null);

  /* ── keys: J and K, , and . ─────────────────────────────────────────────────────────────────── */
  await page.eval(`document.querySelector(".meeting-feed").scrollTop = 0; true`);
  const top = () => page.eval(`Math.round(document.querySelector(".meeting-feed").scrollTop)`);
  const onePage = await page.eval(`document.querySelector(".meeting-feed").clientHeight`);
  chord("J");
  // Wrapped, as `until` waits on while it reads 0, the top of the words and the left of the display.
  const afterJ = await until(async () => { const t = await top(); return t > 0 ? { t } : null; }, 5000, "J to scroll down").then((v) => v.t, () => 0);
  chord("K");
  const afterK = await until(async () => { const t = await top(); return t < afterJ ? { t } : null; }, 5000, "K to scroll up").then((v) => v.t, () => afterJ);
  row("keys", "J scrolls the words a page down and K a page up", { page: onePage, afterJ, afterK }, afterJ > 0 && afterK < afterJ);
  const area = await workArea(app);
  const x0 = await panelX(app);
  chord(",");
  const afterComma = await until(async () => { const x = await panelX(app); return x !== x0 ? { x } : null; }, 5000, ", to move the panel").then((v) => v.x, () => x0);
  chord(".");
  const afterDot = await until(async () => { const x = await panelX(app); return x !== afterComma ? { x } : null; }, 5000, ". to move the panel").then((v) => v.x, () => afterComma);
  row("keys", ", moves the panel left and . moves it right, along its display", { area, x0, afterComma, afterDot },
    afterComma < x0 && afterComma >= area.x && afterDot > afterComma && afterDot + 380 <= area.x + area.width);

  /* ── reload ────────────────────────────────────────────────────────────────────────────────── */
  fs.rmSync(helperPidFile, { force: true });
  await standInStill(page, "microphone");
  await clickByText(page, ".meeting-strip", "Start again");
  await until(() => page.eval(`!!document.querySelector(".quick-chat-bar .meeting-mark")`), 10_000, "listening again");
  const pid = await until(async () => (fs.existsSync(helperPidFile) ? Number(fs.readFileSync(helperPidFile, "utf8")) || null : null), 10_000, "the stand-in helper");
  const reloadBefore = { running: running(pid), tray: await quietTray(app).then((t) => t && { destroyed: t.destroyed }) };
  await page.send("Page.reload");
  const gone = await until(async () => !running(pid), 15_000, "the stand-in helper to go").catch(() => false);
  // A quiet tray's record stays once made; the mark is down when this run's record says destroyed.
  const reloadAfter = { running: running(pid), tray: await quietTray(app).then((t) => t && { destroyed: t.destroyed }) };
  row("reload", "a reload while listening stops the helper and takes the menu bar's mark down", { pid, before: reloadBefore, after: reloadAfter },
    reloadBefore.running && reloadBefore.tray?.destroyed === false && gone && !reloadAfter.running
    && (reloadAfter.tray === null || reloadAfter.tray.destroyed === true));

  /* ── heard, reloaded, keys: L ──────────────────────────────────────────────────────────────── */
  await until(() => page.eval(`!!document.querySelector(".quick-chat .composer-input")`), 20_000, "the reloaded panel's prompter");
  await closePanel(app, page);
  await countFocus(app);
  chord("G");
  await until(() => panelVisible(app), 10_000, "G to open the reloaded panel");
  const heard = await until(() => page.eval(`document.querySelector(".meeting-notice")?.textContent ?? null`), 10_000, "the notice").catch(() => null);
  await sleep(1000);
  const heardState = { notice: heard, answer: await page.eval(`!!document.querySelector(".meeting-answer")`),
    asked: await page.eval(`document.querySelectorAll(".meeting-asked").length`), focus: await focusCalls(app) };
  row("heard", "G after a reload says the assistant is not listening and Fn L starts it, and asks nothing", heardState,
    heard === "The assistant is not listening. Fn L starts it." && !heardState.answer && heardState.asked === 0 && heardState.focus === 0);
  row("reloaded", "a key pressed after a reload reaches the reloaded page", { notice: heard }, heard !== null);

  await closePanel(app, page);
  await standInStill(page, "microphone");
  await countFocus(app);
  chord("L");
  await until(() => panelVisible(app), 10_000, "L to open the panel");
  const lStarted = await until(() => page.eval(`!!document.querySelector(".quick-chat-bar .meeting-mark")`), 10_000, "L to start listening").catch(() => false);
  const lFocus = await focusCalls(app);
  row("keys", "L opens the panel and starts listening, keyboard left where it was", { listening: lStarted, focus: lFocus }, lStarted === true && lFocus === 0);
  await closePanel(app, page);
  chord("L");
  const lStopped = await until(() => page.eval(`!document.querySelector(".meeting-mark")`), 10_000, "L to stop").catch(() => false);
  await sleep(500);
  const lVisible = await panelVisible(app);
  row("keys", "L while listening stops the run and leaves the panel put away", { stopped: lStopped, visible: lVisible }, lStopped === true && !lVisible);

  /* ── settings: after the accept ─────────────────────────────────────────────────────────────── */
  const saidAfter = await settingsLooks(current, "after-consent", null);
  row("settings", "after the first Start, the switch no longer says the keys wait", saidAfter, !saidAfter.includes(WAITING));

  /* ── auto: after the accept ─────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "meetings.startAssistantWithCall", value: true });
  await app.page.eval(`window.realm.meetings.setStartAssistantWithCall(true)`);
  await closePanel(app, page);
  await standInStill(page, "microphone");
  await countFocus(app);
  zoomHolds(true);
  const autoStarted = await until(() => page.eval(`!!document.querySelector(".quick-chat-bar .meeting-mark")`), 20_000, "a call starting to start listening").catch(() => false);
  const accepted = { listening: autoStarted, visible: await panelVisible(app), focus: await focusCalls(app),
    focused: await app.main.eval(`${panelOf}.isFocused()`), assistant: await onAssistant(page),
    tray: await quietTray(app).then((t) => t && { title: t.title, destroyed: t.destroyed }) };
  row("auto", "accepted: a call starting opens the panel without the keyboard, listening, with the mark up", accepted,
    accepted.listening === true && accepted.visible && accepted.focus === 0 && !accepted.focused && accepted.assistant
    && accepted.tray?.title === "Listening" && accepted.tray.destroyed === false);
  const autoPicture = "m3c-auto-started.png";
  await picture(page, path.join(OUT_DIR, autoPicture));
  row("picture", "the panel a call starting opened", autoPicture);

  await clickByText(page, ".meeting-strip", "Stop");
  await until(() => page.eval(`!document.querySelector(".meeting-mark")`), 10_000, "Stop to take the mark down");
  await closePanel(app, page);
  // The app lets go of the microphone long enough for the call to end, and takes it back.
  zoomHolds(false);
  await sleep(CALL_SETTLE_MS);
  zoomHolds(true);
  await sleep(CALL_SETTLE_MS);
  const afterStop = { visible: await panelVisible(app), mark: await page.eval(`!!document.querySelector(".meeting-mark")`),
    tray: await quietTray(app).then((t) => t && { destroyed: t.destroyed }) };
  row("auto", "after a Stop, the microphone let go and taken back starts nothing", afterStop,
    !afterStop.visible && !afterStop.mark && afterStop.tray?.destroyed === true);
  zoomHolds(false);
  page.close();
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows.txt"), rows.map((r) => `${r.ok === undefined ? "    " : r.ok ? "PASS" : "FAIL"} ${r.group.padEnd(8)} ${r.name}  ${js(r.value)}`).join("\n") + "\n");
  if (current) {
    await current.app.page.eval(`window.realm.quickChatPanel.setShortcut(null)`).catch(() => {});
    current.api.close();
    await current.app.stop();
    current.calendar.remove();
  }
  fs.rmSync(tools, { recursive: true, force: true });
  web?.kill();
  clearTimeout(watchdog);
}
process.exit(process.exitCode ?? 0);
