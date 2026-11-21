/**
 * Live check for Settings ▸ Keys with the quick chat's keys in one group, and for the panel made
 * ahead when the double-tap is the only key that opens it (run with:
 * node apps/desktop/scripts/keys-fold-live.mjs; `pnpm build` first). The BUILT app on a scratch home,
 * quiet, with the scripted agent, a stand-in for the calendar helper and one for the key helper, and
 * the renderer over http so the squircle worklet loads as it does in the app.
 *
 * Rows, in `rows.txt` under LIVE_OUT_DIR:
 *
 *   open      no chord, the double-tap on: whether the panel's window was made before the first
 *             double-tap, and the time from the helper's line to the panel shown, for the first open
 *             after launch and the next two. Three launches.
 *   made      how many panel windows there are with the double-tap on, then off, then on again, with
 *             no chord throughout
 *   knob      the computed fill of a lit switch's knob, Plain and Glass, dark and light
 *   picture   Settings ▸ Keys, its keys group, dark and light, Plain and Glass, laid over the theme's
 *             page colour
 *
 * The key helper is a stand-in that taps nothing: it says it is listening and repeats the lines this
 * script writes to its `say` file, so a double-tap here is a line, not a key anyone pressed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/keys-fold");
const LAUNCHES = Number(process.env.LIVE_LAUNCHES ?? 3);
const js = (v) => JSON.stringify(v);

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

/** A key helper that taps nothing: listening, and it prints each line written to `say`, noting when. */
const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
console.log(JSON.stringify({ ready: true, active: true }));
const say = path.join(__dirname, "say");
const said = path.join(__dirname, "said");
fs.writeFileSync(say, "");
let sent = 0;
setInterval(() => {
  const all = fs.readFileSync(say, "utf8");
  if (all.length === sent) return;
  process.stdout.write(all.slice(sent));
  fs.writeFileSync(said, String(Date.now()));
  sent = all.length;
}, 2);
process.stdin.on("end", () => process.exit(0)).resume();
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const tools = fs.mkdtempSync(path.join(os.tmpdir(), "realm-keys-fold-tools-"));
const standIn = path.join(tools, "realmkeys-stand-in.cjs");
fs.writeFileSync(standIn, STAND_IN, { mode: 0o755 });

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

/** One Realm home for every launch, so the chord cleared on the first is already cleared when the
 *  next one starts, as it is for someone who cleared it last week. */
const realmHome = fs.mkdtempSync(path.join(os.tmpdir(), "realm-keys-fold-realm-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "realm-keys-fold-home-"));
// And one userData, or every launch after the first reads as an update and opens What's new over the window.
const userData = path.join(realmHome, "userData");

/** One launch on that home: the window up on its space, the double-tap at its default (on). The
 *  first launch makes the space and clears the chord. */
async function launch({ seed = false } = {}) {
  const calendar = noCalendar();
  // A home of its own as well as a Realm home: nothing the app or the scripted agent reads under ~ is the person's.
  const app = await launchLiveApp({ name: "keys-fold", inspect: true, rendererUrl,
    env: { ...calendar.env, HOME: home, REALM_HOME: realmHome, LIVE_USER_DATA: userData, REALM_KEYS_BIN: standIn } });
  const stopApp = app.stop;
  app.stop = async () => { await stopApp(); await stopDaemons(realmHome); };
  const api = rpc(app.ports.server, await daemonToken(realmHome));
  try {
    await api.ready;
    if (seed) {
      const profile = (await api.call("profiles.list", {}))[0];
      const space = await api.call("spaces.create", { profileId: profile.id, name: "Keys check" });
      await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });
      await api.call("settings.set", { key: "quickChat.shortcut", value: "" });
    }
    await until(() => app.main.eval(`require("electron").BrowserWindow.getAllWindows().some((w) => w.isResizable() && !w.webContents.isLoading())`), 30_000, "the window's first load");
    if (seed) await app.page.send("Page.reload");
    await until(() => app.page.eval(`document.readyState === "complete" && document.body.innerText.includes("Keys check")`), 30_000, "the window on its space");
    return { app, api, calendar };
  } catch (err) {
    console.error(`page at the failure: ${await app.page.eval(`document.body.innerText.slice(0, 400)`).catch(() => "?")}`);
    api.close(); await app.stop(); calendar.remove();
    throw err;
  }
}
const stop = async () => { if (!current) return; current.api.close(); await current.app.stop(); current.calendar.remove(); current = null; };

const panelCount = (app) => app.main.eval(`require("electron").BrowserWindow.getAllWindows().filter((w) => !w.isResizable()).length`);

/** A double-tap from the stand-in, timed from the line leaving it to the panel shown, read in main. */
async function timedDoubleTap(app) {
  const madeBefore = (await panelCount(app)) > 0;
  const saidFile = path.join(tools, "said");
  fs.rmSync(saidFile, { force: true });
  fs.appendFileSync(path.join(tools, "say"), `${js({ t: "doubleTap" })}\n`);
  const shownAt = await app.main.eval(`(async () => {
    const { BrowserWindow } = require("electron");
    const t0 = Date.now();
    for (;;) {
      if (BrowserWindow.getAllWindows().find((w) => !w.isResizable())?.isVisible()) return Date.now();
      if (Date.now() - t0 > 20000) return null;
      await new Promise((r) => setTimeout(r, 2));
    }
  })()`);
  const saidAt = Number(fs.readFileSync(saidFile, "utf8"));
  return { madeBefore, shownMs: shownAt === null ? null : shownAt - saidAt };
}
async function doubleTapToClose(app) {
  fs.appendFileSync(path.join(tools, "say"), `${js({ t: "doubleTap" })}\n`);
  await until(() => app.main.eval(`!require("electron").BrowserWindow.getAllWindows().find((w) => !w.isResizable())?.isVisible()`), 10_000, "the panel to close");
}

async function openKeysSettings(app) {
  if (!(await app.page.eval(`!!document.querySelector('input[name="settings-page-tab"][value="keys"]')`))) await app.main.eval(`require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send("app:command", "settings.open")`);
  await until(() => app.page.eval(`!!document.querySelector('input[name="settings-page-tab"][value="keys"]')`), 10_000, "Settings");
  await app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="keys"]').click(); true`);
  await until(() => app.page.eval(`!!document.querySelector('[data-setting="keys-try"]')`), 10_000, "Settings ▸ Keys");
}

/** The fields from the one holding the chord row to the one holding Try it, laid over the theme's page colour. */
async function shoot(app, file) {
  const { clip, page: [r, g, b] } = await app.page.eval(`(() => {
    const fields = ['quick-chat-shortcut', 'quick-chat-hide', 'double-tap-command', 'keys-try']
      .map((s) => document.querySelector('[data-setting="' + s + '"]').closest('.field').getBoundingClientRect());
    const top = fields.reduce((a, f) => (f.top < a.top ? f : a));
    const bottom = Math.max(...fields.map((f) => f.bottom));
    const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--page');
    ctx.fillRect(0, 0, 1, 1);
    return { clip: { x: Math.round(top.left) - 24, y: Math.round(top.top) - 24, width: Math.round(top.width) + 48, height: Math.round(bottom - top.top) + 48, scale: 1 },
      page: [...ctx.getImageData(0, 0, 1, 1).data] };
  })()`);
  // The key window, as the Mac would have it with Settings in front: a window that is not key greys its accent.
  await app.main.eval(`require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send("window:key", true); true`);
  await app.page.eval(`document.activeElement?.blur(); true`);
  await app.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await sleep(400);
  const { data } = await app.page.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
  // The window is see-through, so the capture keeps the panes' alpha: laid here over the page colour.
  const flat = await app.page.eval(`(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    const g = cv.getContext("2d");
    g.fillStyle = "rgb(${r} ${g} ${b})"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  fs.writeFileSync(file, Buffer.from(flat, "base64"));
  return { page: [r, g, b], inactive: await app.page.eval(`document.documentElement.hasAttribute("data-window-inactive")`) };
}

try {
  /* ── open: no chord, the double-tap on ───────────────────────────────────────────────────── */
  current = await launch({ seed: true });
  await stop();
  for (let n = 1; n <= LAUNCHES; n++) {
    current = await launch();
    const { app } = current;
    await sleep(6000);
    const chord = await app.page.eval(`window.realm.quickChatPanel.shortcut()`);
    const times = [];
    for (let i = 0; i < 3; i++) {
      times.push(await timedDoubleTap(app));
      await sleep(400);
      await doubleTapToClose(app);
      await sleep(600);
    }
    row("open", `launch ${n}: no chord ${js(chord)}, double-tap on; first, second and third open`, times,
      chord.chord === null && times[0].madeBefore && times.every((t) => t.shownMs !== null));
    if (n < LAUNCHES) await stop();
  }

  const { app, api } = current;
  /* ── made: the double-tap off, then on, with no chord ────────────────────────────────────── */
  const made = { on: await panelCount(app) };
  await app.page.eval(`window.realm.keys.setDoubleTap(false)`);
  await sleep(500);
  made.off = await panelCount(app);
  await app.page.eval(`window.realm.keys.setDoubleTap(true)`);
  made.onAgain = await until(async () => (await panelCount(app)) || null, 5000, "the panel made again").catch(() => 0);
  row("made", "panel windows with the double-tap on, off, on again (no chord)", made, made.on === 1 && made.off === 0 && made.onAgain === 1);

  /* ── knob and pictures ───────────────────────────────────────────────────────────────────── */
  await app.page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1400, deviceScaleFactor: 2, mobile: false });
  await app.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await openKeysSettings(app);
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    // The theme and the look are the store's, read when the page loads: changed here the way Settings changes them.
    await app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="appearance"]').click(); true`);
    await until(() => app.page.eval(`!!document.querySelector('input[name="settings-look"][value=${js(look)}]')`), 10_000, "Settings ▸ Appearance");
    await app.page.eval(`document.querySelector('input[name="settings-look"][value=${js(look)}]').click(); true`);
    await app.page.eval(`document.querySelector('input[name="settings-theme"][value=${js(mode)}]').click(); true`);
    await openKeysSettings(app);
    await until(() => app.page.eval(`document.documentElement.dataset.mode === ${js(mode)} && document.documentElement.hasAttribute("data-glass") === ${look === "glass"}`), 15_000, `Settings in ${mode} ${look}`);
    await sleep(500);
    const knob = await app.page.eval(`(() => { const s = document.querySelector('[data-setting="double-tap-command"] .switch');
      const after = getComputedStyle(s, '::after'); return { checked: s.checked, track: getComputedStyle(s).backgroundColor, knob: after.backgroundColor }; })()`);
    row("knob", `${mode} ${look}`, knob);
    const groups = await app.page.eval(`[...document.querySelectorAll('.settings-panel > .field')].filter((f) => f.querySelector('[data-setting]'))
      .map((f) => ({ heading: f.querySelector(':scope > span')?.textContent ?? null, rows: [...f.querySelectorAll('[data-setting]')].map((r) => r.dataset.setting) }))`);
    if (mode === "dark" && look === "plain") row("groups", "Settings ▸ Keys, the fields holding a setting", groups);
    const file = `settings-keys-${mode}-${look}.png`;
    row("picture", `${mode} ${look}`, { file, ...(await shoot(app, path.join(OUT_DIR, file))) });
  }
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
  console.error(`windows: ${js(await current?.app.main.eval(`require("electron").BrowserWindow.getAllWindows().map((w) => ({ id: w.id, resizable: w.isResizable(), url: w.webContents.getURL(), visible: w.isVisible() }))`).catch((e) => e.message))}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows.txt"), rows.map((r) => `${r.ok === undefined ? "    " : r.ok ? "PASS" : "FAIL"} ${r.group.padEnd(9)} ${r.name}  ${js(r.value)}`).join("\n") + "\n");
  await stop().catch(() => {});
  await stopDaemons(realmHome).catch(() => {});
  for (const dir of [realmHome, home]) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tools, { recursive: true, force: true });
  web.kill();
  clearTimeout(watchdog);
}
process.exit(process.exitCode ?? 0);
