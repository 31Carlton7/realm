/**
 * Live checks for the key helper (native/RealmKeys.swift) and what main and Settings do with it.
 *
 *   node apps/desktop/scripts/realm-keys-live.mjs taps       the helper alone, on real event taps
 *   node apps/desktop/scripts/realm-keys-live.mjs app        the built app: a double-tap opens the quick chat
 *   node apps/desktop/scripts/realm-keys-live.mjs settings   captures of Settings ▸ Keys ▸ From anywhere
 *
 * Whether a session tap delivers an event, whether returning nil keeps it from the next tap, and
 * whether main hears the helper are none of them things the suite can see: `realmkeys decide` and
 * realm-keys.test.ts hold the decisions, and this holds the wiring.
 *
 * SAFE WHILE SOMEONE TYPES. `taps` and `app` put two taps in the session for under 20 seconds: the
 * helper, started with --only-tagged so it returns every event that is not this run's untouched and
 * unread, and lib/realm-keys-proof.swift, which posts the tagged events and removes them again at
 * the tail (its header lists what it posts: F18 to F20 and modifiers, never a letter). Both end
 * themselves at 18 s and are killed from here at 20. Neither asks for a permission: without
 * Accessibility for whatever started this script, they say so and nothing is posted.
 * `settings` starts no tap at all: the app is given a stand-in helper that only prints.
 *
 * REBUILD FIRST for `app` and `settings` (`pnpm build`): they boot apps/desktop/out, not the sources.
 * LIVE_OUT names the folder the results and captures go to.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const part = process.argv[2];
const out = process.env.LIVE_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "realm-keys-out-"));
const tools = fs.mkdtempSync(path.join(os.tmpdir(), "realm-keys-tools-"));
const tag = randomInt(1 << 20, 2 ** 31);
/** Named for this run, so a process list can be asked about exactly this helper. */
const helperName = `realmkeys-live-${tag}`;
const helper = path.join(tools, helperName);
const proof = path.join(tools, "realm-keys-proof");
const F18 = 79, F19 = 80, FN = 63, SHIFT = 56, RIGHT_OPTION = 61;

const results = [];
const check = (name, ok, detail) => {
  if (!ok) process.exitCode = 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};

function buildTools() {
  execFileSync("swiftc", ["-O", "-o", helper, path.join(desktopRoot, "native/RealmKeys.swift")], { stdio: "inherit" });
  execFileSync("swiftc", ["-O", "-o", proof, path.join(desktopRoot, "scripts/lib/realm-keys-proof.swift")], { stdio: "inherit" });
}

/** A child's stdout as lines, each parsed, with a way to wait for the next one that matches. */
function lines(child) {
  const seen = [];
  const waiting = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      seen.push(line);
      for (const w of waiting.splice(0)) (w.match(line) ? w.resolve(line) : waiting.push(w));
    }
  });
  child.on("exit", (code) => { for (const w of waiting.splice(0)) w.reject(new Error(`exited with ${code} while waiting`)); });
  return { seen, next: (match) => new Promise((resolve, reject) => waiting.push({ match, resolve, reject })) };
}

/** Kills `children` at 20 s whatever this script is doing. Returns the way to stand it down. */
function watchdog(...children) {
  const timer = setTimeout(() => { for (const c of children) c.kill("SIGKILL"); }, 20_000);
  return () => clearTimeout(timer);
}

/** The proof tool: runs a scenario and answers with the tagged events that got past the helper. */
async function startProof() {
  const child = spawn(proof, [String(tag)], { stdio: ["pipe", "pipe", "inherit"] });
  const said = lines(child);
  const run = async (scenario) => {
    const answer = said.next((l) => l.scenario === scenario || l.error);
    child.stdin.write(`${scenario}\n`);
    const line = await answer;
    if (line.error) throw new Error(line.error);
    // Longer than the double-tap's gap, so one scenario's last tap cannot pair with the next one's first.
    await sleep(350);
    return line;
  };
  await run("canary");
  /** The event taps `pid` has installed, as the window server lists them. */
  const tapsOf = async (pid) => {
    const answer = said.next((l) => l.taps || l.error);
    child.stdin.write(`taps ${pid}\n`);
    return (await answer).taps;
  };
  return { child, run, tapsOf, end: () => new Promise((resolve) => { child.once("exit", resolve); child.stdin.end(); }) };
}

/** Every process running this run's helper, by pid and parent. Names only: never a command line. */
function helpersRunning() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")
    .filter((l) => l.trim().endsWith(helperName)).map((l) => { const [pid, ppid] = l.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid) }; });
}

/* ── taps: the helper alone ───────────────────────────────────────────────────────────────── */

/** One helper, one proof tool, a config, and scenarios with what each must do. */
async function tapsRun(title, steps, { swallow = false } = {}) {
  const child = spawn(helper, [...(swallow ? ["--swallow"] : []), "--only-tagged", String(tag), "--exit-after", "18"], { stdio: ["pipe", "pipe", "inherit"] });
  const said = lines(child);
  const ready = await said.next((l) => l.ready);
  const proofTool = await startProof();
  const standDown = watchdog(child, proofTool.child);
  console.log(`\n${title} (macOS ${ready.active ? "lets this helper swallow" : "DOES NOT let this helper swallow"})`);
  try {
    for (const step of steps) {
      if (step.installed) {
        const installed = await proofTool.tapsOf(child.pid);
        check(`${title}: ${step.as}`, JSON.stringify(installed) === JSON.stringify(step.installed), installed);
        continue;
      }
      if (step.config) { child.stdin.write(`${JSON.stringify({ doubleTap: true, maxHold: 0.25, maxGap: 0.3, hold: "fn", chords: [], reportHold: false, ...step.config })}\n`); await sleep(100); continue; }
      const from = said.seen.length;
      const { reached, slowestMs } = await proofTool.run(step.scenario);
      const heard = said.seen.slice(from);
      const got = { doubleTaps: heard.filter((l) => l.t === "doubleTap").length, chords: heard.filter((l) => l.t === "chord").map((l) => l.code), reached };
      const want = { doubleTaps: step.doubleTaps ?? 0, chords: step.chords ?? [], reached: step.reached };
      const ok = got.doubleTaps === want.doubleTaps && JSON.stringify(got.chords) === JSON.stringify(want.chords)
        && (typeof want.reached === "number" ? reached.length === want.reached : JSON.stringify(reached) === JSON.stringify(want.reached));
      check(`${title}: ${step.as ?? step.scenario}`, ok, ok ? { fired: got.doubleTaps, chords: got.chords, reachedApps: reached.length, slowestMs } : { got, want });
    }
  } finally {
    await proofTool.end();
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    standDown();
  }
  return ready.active;
}

async function taps() {
  buildTools();
  // `reached` is how many of the posted events got past the helper: all of them, since it only
  // ever swallows a registered chord.
  const listenOnly = [{ options: "listenOnly", keys: true, pointer: true }];
  await tapsRun("double-tap", [
    { installed: listenOnly, as: "started for the double-tap alone, its one tap cannot hold a key" },
    { config: {} },
    { scenario: "two taps 120 ms apart", doubleTaps: 1, reached: 4 },
    { scenario: "left then right Command", doubleTaps: 1, reached: 4 },
    { scenario: "three taps", doubleTaps: 1, reached: 6 },
    { scenario: "Command and a key, then a tap", reached: 6 },
    { scenario: "a tap, then Command and a key", reached: 6 },
    { scenario: "Command and a key, twice", reached: 8 },
  ]);
  await tapsRun("double-tap, holds and modifiers", [
    { config: {} },
    { scenario: "Command held 600 ms, then a tap", reached: 4 },
    { scenario: "a tap, then Command held 600 ms", reached: 4 },
    { scenario: "two taps 500 ms apart", reached: 4 },
    { scenario: "Command-Shift, then a tap", reached: 6 },
    { scenario: "both Command keys overlapping", reached: 4 },
  ]);
  await tapsRun("double-tap, pointer", [
    { config: {} },
    { scenario: "Command-click, then a tap", reached: 5 },
    { scenario: "a tap, a click, a tap", reached: 5 },
    { scenario: "Command-scroll, then a tap", reached: 5 },
    { scenario: "a tap, a scroll, a tap", reached: 5 },
    // The same taps with nothing between still fire: the rows above are not a helper gone deaf.
    { scenario: "two taps 120 ms apart", as: "control: two taps after the pointer rows", doubleTaps: 1, reached: 4 },
    { config: { doubleTap: false } },
    { scenario: "two taps 120 ms apart", as: "two taps with the double-tap off", reached: 4 },
  ]);
  // What the helper's taps cost an event on its way through: the same scenarios with no helper.
  const alone = await startProof();
  const standDown = watchdog(alone.child);
  for (const scenario of ["two taps 120 ms apart", "a tap, a click, a tap", "a tap, a scroll, a tap"]) {
    const { reached, slowestMs } = await alone.run(scenario);
    check(`no helper running: ${scenario}`, reached.length === (scenario.includes("120") ? 4 : 5), { reachedApps: reached.length, slowestMs });
  }
  await alone.end();
  standDown();

  const fnOnly = [`flagsChanged:${FN}`, `flagsChanged:${FN}`];
  const active = await tapsRun("chords", [
    { installed: [{ options: "listenOnly", keys: false, pointer: true }, { options: "default", keys: true, pointer: false }], as: "started to swallow, its key tap is active and its pointer tap is not" },
    { config: {} },
    { scenario: "Fn and the registered key", as: "no chord registered: Fn and a key", reached: [fnOnly[0], `keyDown:${F19}`, `keyUp:${F19}`, fnOnly[1]] },
    { config: { chords: [F19] } },
    { scenario: "Fn and the registered key", chords: [F19], reached: fnOnly },
    { scenario: "Fn and an unregistered key", reached: [fnOnly[0], `keyDown:${F18}`, `keyUp:${F18}`, fnOnly[1]] },
    { scenario: "the registered key alone", reached: [`keyDown:${F19}`, `keyUp:${F19}`] },
    { scenario: "the registered key with the Fn flag and no Fn key", reached: [`keyDown:${F19}`, `keyUp:${F19}`] },
    { scenario: "Fn, Shift and the registered key", reached: [fnOnly[0], `flagsChanged:${SHIFT}`, `keyDown:${F19}`, `keyUp:${F19}`, `flagsChanged:${SHIFT}`, fnOnly[1]] },
    { scenario: "Right Option and the registered key", as: "Right Option and the registered key, while Fn is the held key",
      reached: [`flagsChanged:${RIGHT_OPTION}`, `keyDown:${F19}`, `keyUp:${F19}`, `flagsChanged:${RIGHT_OPTION}`] },
    { config: { chords: [F19], hold: "rightOption" } },
    { scenario: "Right Option and the registered key", as: "Right Option and the registered key, as the held key", chords: [F19], reached: [`flagsChanged:${RIGHT_OPTION}`, `flagsChanged:${RIGHT_OPTION}`] },
    { scenario: "Fn and the registered key", as: "Fn and the registered key, while Right Option is the held key", reached: [fnOnly[0], `keyDown:${F19}`, `keyUp:${F19}`, fnOnly[1]] },
  ], { swallow: true });
  check("macOS lets this helper swallow, so the swallow rows mean something", active);
  // Without --swallow the same registered chord is reported and reaches the app: a listen-only tap.
  await tapsRun("chords, started without --swallow", [
    { installed: listenOnly, as: "back to no chords, its one tap cannot hold a key" },
    { config: { chords: [F19] } },
    { scenario: "Fn and the registered key", chords: [F19], reached: [fnOnly[0], `keyDown:${F19}`, `keyUp:${F19}`, fnOnly[1]] },
  ]);
}

/* ── the built app ────────────────────────────────────────────────────────────────────────── */

/** The first-run sheet answered, so the window is a space with a prompter. */
async function throughOnboarding(page) {
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 20_000, "the prompter");
}

async function openKeysSettings(app) {
  await app.main.eval(`require("electron").BrowserWindow.getAllWindows()[0].webContents.send("app:command", "settings.open")`);
  await until(() => app.page.eval(`!!document.querySelector('input[name="settings-page-tab"][value="keys"]')`), 10_000, "Settings");
  await app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="keys"]').click(); true`);
  await until(() => app.page.eval(`!!document.querySelector('[data-setting="keys-try"]')`), 10_000, "Settings ▸ Keys");
}
const leaveKeysSettings = (app) => app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="general"]').click(); true`);

/**
 * A capture of `selector` (or the `closest` ancestor of it), with a margin, laid over the theme's
 * page colour: the panes are see-through, and a capture that keeps their alpha reads as whatever a
 * viewer puts behind it.
 */
async function shoot(app, file, selector, closest = null) {
  const { clip, page: [r, g, b] } = await app.page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const box = (${JSON.stringify(closest)} ? el.closest(${JSON.stringify(closest)}) : el).getBoundingClientRect();
    const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--page');
    ctx.fillRect(0, 0, 1, 1);
    return { clip: { x: Math.round(box.left) - 24, y: Math.round(box.top) - 24, width: Math.round(box.width) + 48, height: Math.round(box.height) + 48 }, page: [...ctx.getImageData(0, 0, 1, 1).data] };
  })()`);
  await app.page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r, g, b, a: 1 } });
  await app.screenshot(file, clip);
  await app.page.send("Emulation.setDefaultBackgroundColorOverride", {});
  return file;
}

const keysState = (page) => page.eval(`window.realm.keys.state()`);
const quickChatOpen = (page) => page.eval(`!!document.querySelector('.quick-chat')`);
const tryRow = (page) => page.eval(`[...document.querySelectorAll('.keys-try-key')].map((el) => el.textContent)`);

async function appPart() {
  buildTools();
  // What the app starts as its helper: the real one, acting only on this run's events.
  const wrapper = path.join(tools, "realmkeys-wrapper.sh");
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec "${helper}" --only-tagged ${tag} --exit-after 18\n`, { mode: 0o755 });
  const app = await launchLiveApp({ name: "realm-keys", inspect: true, env: { REALM_KEYS_BIN: wrapper } });
  let stopped = false;
  try {
    await throughOnboarding(app.page);
    // A helper started now, so its 18 seconds cover what follows whatever the boot took.
    const restartHelper = async () => {
      await app.page.eval(`window.realm.keys.setDoubleTap(false).then(() => window.realm.keys.setDoubleTap(true))`);
      return until(async () => ["active", "listening"].includes(await keysState(app.page)) && keysState(app.page), 5000, "the helper to say which tap it got");
    };
    // Nothing has touched the setting yet: this is main reading an unset key as on.
    check("on a fresh home main started one helper by itself", helpersRunning().length === 1, { state: await keysState(app.page), helpers: helpersRunning().length });
    await restartHelper();

    let proofTool = await startProof();
    let standDown = watchdog(proofTool.child);
    const installed = await proofTool.tapsOf(helpersRunning()[0].pid);
    check("the app's helper holds no active tap: nothing has registered a chord", JSON.stringify(installed) === JSON.stringify([{ options: "listenOnly", keys: true, pointer: true }]), installed);
    check("before any tap, no quick chat is open", !(await quickChatOpen(app.page)));
    await proofTool.run("two taps 500 ms apart");
    await sleep(600);
    check("two taps 500 ms apart open nothing", !(await quickChatOpen(app.page)));
    await proofTool.run("two taps 120 ms apart");
    const opened = await until(() => quickChatOpen(app.page), 5000, "the quick chat").then(() => true, () => false);
    check("a double-tap of Command opens the quick chat", opened);
    check("main brought its window forward for it (quiet mode's record of focus; nothing is raised on screen)", await app.main.eval(`require("electron").BrowserWindow.getAllWindows()[0].isFocused()`));
    // The quick chat alone: the prompter behind it names this Mac, which carries its owner's name.
    await shoot(app, path.join(out, "app-quick-chat-after-double-tap.png"), ".quick-chat");
    await proofTool.end();
    standDown();

    await app.page.eval(`document.querySelector('.quick-chat [aria-label="Close quick chat"]').click(); true`);
    await until(async () => !(await quickChatOpen(app.page)), 5000, "the quick chat to close");

    await restartHelper();
    await openKeysSettings(app);
    await app.page.eval(`document.querySelector('[data-setting="double-tap-command"] input').click(); true`);
    await until(() => app.page.eval(`!document.querySelector('[data-setting="double-tap-command"] input').checked`), 3000, "the switch to read off");
    await sleep(300);
    proofTool = await startProof();
    standDown = watchdog(proofTool.child);
    await proofTool.run("two taps 120 ms apart");
    await until(async () => (await tryRow(app.page))[0]?.includes("Seen") && !(await tryRow(app.page))[0].includes("Not"), 3000, "Try it to show the double-tap").catch(() => {});
    const shown = await tryRow(app.page);
    check("with the setting off, Settings' Try it still shows the double-tap", shown[0] === "⌘⌘Seen", shown);
    await sleep(600);
    check("with the setting off, the double-tap opens nothing", !(await quickChatOpen(app.page)));
    await shoot(app, path.join(out, "app-settings-try-it-after-double-tap.png"), '[data-setting="double-tap-command"]', ".field");
    await proofTool.end();
    standDown();

    await leaveKeysSettings(app);
    await until(async () => (await keysState(app.page)) === "off", 5000, "main to stop the helper");
    await until(async () => helpersRunning().length === 0, 3000, "the helper process to go").catch(() => {});
    check("with the setting off and Settings closed, no helper is running", helpersRunning().length === 0, { state: await keysState(app.page), helpers: helpersRunning() });

    await restartHelper();
    const before = helpersRunning();
    check("control: turned on again, one helper is running", before.length === 1, before);
    await app.stop();
    stopped = true;
    await until(async () => helpersRunning().length === 0, 5000, "the helper to go with the app").catch(() => {});
    check("after quit no helper is left, under launchd or anywhere", helpersRunning().length === 0, helpersRunning());
  } finally {
    if (!stopped) await app.stop();
    for (const { pid } of helpersRunning()) process.kill(pid, "SIGKILL");
  }
}

/* ── Settings captures ────────────────────────────────────────────────────────────────────── */

/** A helper that taps nothing: it reports the state its folder names and repeats what `say` is given. */
const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = fs.readFileSync(path.join(__dirname, "state"), "utf8").trim();
if (state === "denied") process.exit(2);
console.log(JSON.stringify({ ready: true, active: state === "active" }));
const say = path.join(__dirname, "say");
fs.writeFileSync(say, "");
let said = 0;
setInterval(() => {
  const all = fs.readFileSync(say, "utf8");
  process.stdout.write(all.slice(said));
  said = all.length;
}, 150);
process.stdin.on("end", () => process.exit(0)).resume();
`;

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); });
  return {
    ready: new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); }),
    call: (method, params) => new Promise((resolve, reject) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? resolve(msg.result) : reject(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function settingsPart() {
  const standIn = path.join(tools, "realmkeys-stand-in.cjs");
  fs.writeFileSync(standIn, STAND_IN, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "state"), "active");
  const app = await launchLiveApp({ name: "realm-keys-settings", inspect: true, env: { REALM_KEYS_BIN: standIn } });
  try {
    await throughOnboarding(app.page);
    const api = rpc(app.ports.server, await daemonToken(app.home));
    await api.ready;
    // Main's switch off, and only main's: the stand-in then runs for the page alone, so leaving the
    // page ends it and coming back starts it in the next state. The row still reads the default, on.
    await app.page.eval(`window.realm.keys.setDoubleTap(false)`);
    await app.page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });

    const states = [
      { name: "denied", state: "denied", say: [] },
      { name: "listening", state: "listening", say: [] },
      { name: "active", state: "active", say: [] },
      { name: "active-seen", state: "active", say: ['{"t":"doubleTap"}', '{"t":"hold","down":true}'] },
    ];
    for (const look of ["plain", "glass"]) {
      await api.call("settings.set", { key: "ui.look", value: look });
      await app.page.send("Page.reload", {});
      await until(() => app.page.eval(`!!document.querySelector('.composer')`), 20_000, "the prompter after a reload");
      await app.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await openKeysSettings(app);
      for (const s of states) {
        await leaveKeysSettings(app);
        await until(async () => (await keysState(app.page)) === "off", 5000, "the stand-in to stop");
        fs.writeFileSync(path.join(tools, "state"), s.state);
        await app.page.eval(`document.querySelector('input[name="settings-page-tab"][value="keys"]').click(); true`);
        await until(async () => (await keysState(app.page)) === s.state, 5000, `the page's helper to be ${s.state}`);
        for (const line of s.say) fs.appendFileSync(path.join(tools, "say"), `${line}\n`);
        await sleep(700);
        const rows = await app.page.eval(`[...document.querySelectorAll('[data-setting="double-tap-command"], [data-setting="assistant-hold-key"], [data-setting="keys-access"], [data-setting="keys-try"]')].map((el) => el.dataset.setting + ': ' + el.innerText.replace(/\\s+/g, ' ').trim())`);
        for (const mode of ["dark", "light"]) {
          await app.page.eval(`document.documentElement.dataset.mode = ${JSON.stringify(mode)}; true`);
          await sleep(350);
          const file = await shoot(app, path.join(out, `settings-${s.name}-${look}-${mode}.png`), '[data-setting="double-tap-command"]', ".field");
          console.log(`SHOT ${file}`);
        }
        results.push({ name: `settings rows, ${look}, ${s.name}`, ok: true, detail: rows });
        console.log(`ROWS ${look} ${s.name} ${JSON.stringify(rows)}`);
      }
    }
    api.close();
  } finally {
    await app.stop();
  }
}

const parts = { taps, app: appPart, settings: settingsPart };
if (!parts[part]) {
  console.error("usage: node apps/desktop/scripts/realm-keys-live.mjs taps|app|settings");
  process.exit(64);
}
try {
  fs.mkdirSync(out, { recursive: true });
  await parts[part]();
} finally {
  fs.rmSync(tools, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, `${part}-results.json`), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${results.filter((r) => !r.ok).length} failed of ${results.length}. Results in ${out}`);
}
process.exit(process.exitCode ?? 0);
