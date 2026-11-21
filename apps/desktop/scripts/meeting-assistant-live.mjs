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
    env: { ...calendar.env, HOME: home, REALM_VOICE_BIN: voiceBin, REALM_FAKE_SCRIPT: scriptFile, REALM_FAKE_STANDS_IN: "claude", REALM_REAL_LIVE_ANSWERS: "" } });
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
const closePanel = async (app) => { if (await panelVisible(app)) await press(app); await until(async () => !(await panelVisible(app)), 10_000, "the panel to close"); };
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

async function everyLook({ app, api }, page, state) {
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await closePanel(app); await openPanel(app);
    const shown = await until(() => page.eval(`(() => {
      if (document.documentElement.dataset.mode !== ${js(mode)}) return null;
      if (document.documentElement.hasAttribute("data-glass") === ${look === "glass"}) return { held: null };
      const held = ${look === "glass" ? PLAIN_REASON : "null"};
      return held ? { held } : null; })()`), 15_000, `the panel in ${mode} ${look}`);
    if (shown.held) {
      row("glass-held", `${state}, ${mode} glass drawn plain, so no picture`, shown.held);
      continue;
    }
    const file = `m3a-${state}-${mode}-${look}.png`;
    await picture(page, path.join(OUT_DIR, file));
    row("picture", `${state}, ${mode} ${look}`, file);
  }
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
  // On this document now, and on any the page loads after it.
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STAND_INS });
  await page.eval(STAND_INS);

  /* ── sheet ─────────────────────────────────────────────────────────────────────────────────── */
  await click(page, '.quick-chat-bar button[aria-label="Meeting assistant"]');
  await until(() => page.eval(`!!document.querySelector(".meeting-strip")`), 10_000, "the assistant view");
  const consentBefore = (await api.call("settings.get", { key: CONSENT_KEY })).value ?? null;
  await standInStill(page, "microphone");
  await clickByText(page, ".meeting-strip", "Start listening");
  await until(() => page.eval(`!!document.querySelector('.sheet[aria-label="Before you start listening"]')`), 10_000, "the first-run sheet");
  await sleep(600);
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
