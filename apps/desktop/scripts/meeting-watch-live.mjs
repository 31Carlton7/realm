/**
 * Live check: Realm knows when a meeting or a call starts.
 *
 *   pnpm build && node apps/desktop/scripts/meeting-watch-live.mjs
 *
 * Takes about six minutes: a fixture meeting has to come two minutes away and then start. Boots the
 * built app quietly on a scratch home. Nothing is shown, played, asked for or opened:
 *
 * - The calendar is never read. The app's helper is a wrapper that runs the real `meetingwatch` on a
 *   file of fixture events (`calendar --events`), or prints a stubbed access where a row needs one.
 * - A meeting's link goes to quiet mode's `shell.openExternal`, which writes a line and opens nothing;
 *   the notification is a line in the same log.
 * - A call is a stand-in app (lib/meeting-standin.swift) that opens the default input and throws the
 *   samples away. It is known to Core Audio by Discord's bundle id with a suffix, which Realm maps
 *   to Discord the way it maps a browser's helper. The microphone is open for about 20 s in all.
 *   The Mac's real Microphone grant is needed (checked, never asked for).
 *
 * Rows: the helper alone (calls, the title rule on and off, the calendar's file mode), then the app
 * (helper running only while a setting needs it, the notification, the link opened once, nothing
 * with the setting off or without access, a call started and ended, nothing left after quit).
 * LIVE_OUT takes the Settings captures and `rows.txt`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-meeting-watch-live");
fs.mkdirSync(OUT, { recursive: true });
const js = (v) => JSON.stringify(v);
const rows = [];
const say = (line) => { rows.push(line); console.log(line); };
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  say(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + js(detail) : ""}`);
};

const helper = path.join(desktopRoot, "native/bin/meetingwatch");
if (!fs.existsSync(helper)) throw new Error(`${helper} is missing: run node apps/desktop/scripts/build-native.mjs`);

const rig = fs.mkdtempSync(path.join(os.tmpdir(), "realm-meeting-rig-"));
const MEET = "https://meet.google.com/abc-defg-hij";

/** The stand-in as an app bundle, so it has a bundle id. LSUIElement: no Dock icon. */
function buildStandin(name, bundleId) {
  const app = path.join(rig, `${name}.app`);
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.copyFileSync(path.join(rig, "standin"), path.join(app, "Contents/MacOS", name));
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
  execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
  return path.join(app, "Contents/MacOS", name);
}

/** Runs the stand-in to its end. */
function standin(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args.map(String), { stdio: ["ignore", "pipe", "inherit"] });
    let printed = "";
    child.stdout.on("data", (d) => { printed += d; });
    child.on("exit", (code) => (code === 0 ? resolve(printed) : reject(new Error(`the stand-in exited ${code}: ${printed.trim()}`))));
  });
}

/** The real helper, alone: its lines with the seconds since it started, until `during` settles. */
async function helperLines(args, during) {
  const child = spawn(helper, args, { stdio: ["pipe", "pipe", "inherit"] });
  const t0 = Date.now();
  const lines = [];
  let buffered = "";
  child.stdout.on("data", (d) => {
    buffered += d;
    for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
      lines.push({ t: (Date.now() - t0) / 1000, ...JSON.parse(buffered.slice(0, nl)) });
      buffered = buffered.slice(nl + 1);
    }
  });
  await sleep(500);
  const began = (Date.now() - t0) / 1000;
  await during();
  await sleep(1500);
  const gone = new Promise((resolve) => child.on("exit", resolve));
  child.stdin.end();
  await gone;
  return { lines, began };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const parentOf = (pid) => { try { return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch { return null; } };

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(String(msg.id))?.(msg); });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

let app = null;
try {
  execFileSync("swiftc", ["-O", "-o", path.join(rig, "standin"), path.join(desktopRoot, "scripts/lib/meeting-standin.swift")], { stdio: "inherit" });
  const DISCORD = "com.hnc.Discord.realm-live-check";
  const CHROME = "com.google.Chrome.realm-live-check";
  const caller = buildStandin("CallStandin", DISCORD);
  const browser = buildStandin("BrowserStandin", CHROME);

  // ── The helper alone ─────────────────────────────────────────────────────────────────────────
  say("# The helper alone");
  {
    const { lines, began } = await helperLines(["calls"], () => standin(caller, [3, 1, 2]));
    const held = lines.filter((l) => l.t > began).map((l) => ({ t: l.t - began, holding: l.holders.includes(DISCORD) }));
    say(`  stand-in: known 1.5 s, input open 3 s, closed 1 s, open 2 s. The helper saw it holding: ${held.map((h) => `${h.holding ? "yes" : "no"} at ${h.t.toFixed(2)} s`).join(", ")}`);
    check("the helper reports the stand-in when it opens the input, and again each time it lets go or takes it back",
      held.map((h) => h.holding).join() === "true,false,true,false", held);
    check("a start is seen within half a second", held[0]?.t - 1.5 < 0.5, held[0]?.t - 1.5);
    check("a stop is seen within a second and a half (no listener fires for it while another process holds the input, so the list is read each second)",
      held[1]?.t - 4.5 < 1.5, held[1]?.t - 4.5);
  }
  for (const answer of ["granted", "denied"]) {
    const { lines } = await helperLines(["calls", "--screen-recording", answer], () => standin(browser, ["--title", "Meet - abc-defg-hij - Google Chrome", 3]));
    const titled = lines.some((l) => l.titled.some((t) => t.app === CHROME && t.service === "Google Meet"));
    const holding = lines.some((l) => l.holders.includes(CHROME));
    check(`Screen Recording stubbed ${answer}: a window titled like a Meet call ${answer === "granted" ? "names its app and the service" : "is not read"}`,
      holding && titled === (answer === "granted"), { holding, titled });
    check("no line carries a title", lines.every((l) => !js(l).includes("abc-defg-hij")));
  }
  {
    const now = Date.now();
    const file = path.join(rig, "helper-events.json");
    fs.writeFileSync(file, js([
      { id: "FIX-1", title: "Fixture: design review", start: now + 600_000, end: now + 2_400_000, location: MEET },
      { id: "FIX-2", title: "Fixture: offsite", start: now + 3_600_000, end: now + 90_000_000, allDay: true, url: "https://acme.zoom.us/j/91234567890" },
      { id: "FIX-3", title: "Fixture: declined sync", start: now + 7_200_000, end: now + 9_000_000, participation: "declined", notes: "Join: <https://teams.microsoft.com/l/meetup-join/19%3ameeting_fixture%40thread.v2/0>" },
    ]));
    const { lines } = await helperLines(["calendar", "--events", file], () => sleep(300));
    const events = lines.find((l) => l.events)?.events ?? [];
    check("the calendar mode prints fixture events from a file through EventKit's own event",
      lines[0]?.access === "full" && events.length === 3 && events[0].location === MEET && events[1].allDay === true && events[2].participation === "declined",
      events.map((e) => ({ id: e.id, allDay: e.allDay, participation: e.participation, url: e.url, location: e.location })));
  }

  // ── The app ──────────────────────────────────────────────────────────────────────────────────
  say("# The built app, hidden, on fixture events");
  const wrapper = path.join(rig, "meetingwatch");
  fs.writeFileSync(wrapper, `#!/bin/bash
# Stands in for meetingwatch in meeting-watch-live.mjs: the real helper on fixture events, or a
# stubbed calendar access with the commands main sends written down.
echo "$$ $1" >> "$MW_RIG/pids"
if [ "$1" = calls ]; then exec "$MW_HELPER" calls; fi
read -r access < "$MW_RIG/access"
if [ "$access" = full ]; then exec "$MW_HELPER" calendar --events "$MW_RIG/events.json"; fi
printf '{"access":"%s"}\\n' "$access"
while IFS= read -r command; do echo "$command" >> "$MW_RIG/commands"; done
`, { mode: 0o755 });
  const pids = (mode) => { try { return fs.readFileSync(path.join(rig, "pids"), "utf8").trim().split("\n").map((l) => l.split(" ")).filter((l) => l[1] === mode).map((l) => Number(l[0])); } catch { return []; } };
  const setAccess = (access) => fs.writeFileSync(path.join(rig, "access"), `${access}\n`);
  const setEvents = (events) => fs.writeFileSync(path.join(rig, "events.json"), js(events));

  const booted = Date.now();
  const FIRST = { id: "LIVE-1", title: "Fixture: design review", start: booted + 200_000, end: booted + 2_000_000, location: MEET };
  setAccess("full");
  setEvents([
    FIRST,
    { id: "LIVE-2", title: "Fixture: offsite", start: booted + 150_000, end: booted + 90_000_000, allDay: true, url: "https://acme.zoom.us/j/91234567890" },
    { id: "LIVE-3", title: "Fixture: declined sync", start: booted + 150_000, end: booted + 2_000_000, participation: "declined", notes: "https://acme.webex.com/meet/fixture" },
  ]);
  app = await launchLiveApp({ name: "meeting-watch", inspect: true, env: { REALM_MEETINGWATCH_BIN: wrapper, MW_RIG: rig, MW_HELPER: helper } });
  const page = app.page;
  const ev = (expr) => page.eval(expr);
  const log = path.join(app.scratch, "electron.log");
  /** Quiet mode's lines: each notification's title and each link handed to the system. */
  const quiet = () => {
    const text = fs.readFileSync(log, "utf8");
    return {
      notified: [...text.matchAll(/^\[quiet-windows\] notification (.*)$/gm)].map((m) => JSON.parse(m[1])),
      opened: [...text.matchAll(/^\[quiet-windows\] open external (.*)$/gm)].map((m) => JSON.parse(m[1])),
    };
  };
  // When the first notification and the first link were seen, whatever the check is busy with then.
  const firstSeen = { notified: null, opened: null };
  const watching = setInterval(() => {
    const now = quiet();
    if (firstSeen.notified === null && now.notified.length > 0) firstSeen.notified = Date.now();
    if (firstSeen.opened === null && now.opened.length > 0) firstSeen.opened = Date.now();
  }, 100);

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;

  const ROW = '[data-setting="open-meetings"]';
  const openSettings = async () => {
    await ev(`(() => { if (!document.querySelector('.settings-page-pane')) window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, bubbles: true })); return true; })()`);
    await until(() => ev(`!!document.querySelector(${js(ROW)})`), 10_000, "the Meetings row");
    await ev(`(() => { document.querySelector(${js(ROW)}).scrollIntoView({ block: "center" }); return true; })()`);
  };
  const rowSays = () => ev(`(() => { const row = document.querySelector(${js(ROW)}); return { detail: row.querySelector('.settings-row-detail').textContent, button: row.querySelector('button')?.textContent ?? null, on: row.querySelector('input.switch').checked }; })()`);
  const flipSwitch = () => ev(`(() => { document.querySelector(${js(ROW)} + ' input.switch').click(); return true; })()`);
  /** Restart the app's calendar helper on a stubbed access: the wrapper reads it when it starts. */
  const restartCalendarWith = async (access) => {
    setAccess(access);
    await openSettings();
    if ((await rowSays()).on) { await flipSwitch(); await until(async () => !(await rowSays()).on, 5_000, "the switch off"); }
    const before = pids("calendar").length;
    await flipSwitch();
    await until(async () => pids("calendar").length > before, 5_000, "a new calendar helper");
  };

  const firstCalendar = await until(async () => pids("calendar")[0], 15_000, "the calendar helper");
  check("with the setting on (the default) the app runs one calendar helper, as its own child, and no calls helper",
    alive(firstCalendar) && parentOf(firstCalendar) === app.electron.pid && pids("calendar").length === 1 && pids("calls").length === 0,
    { calendarHelpers: pids("calendar").length, callsHelpers: pids("calls").length, childOfApp: parentOf(firstCalendar) === app.electron.pid });

  // Calls: nothing in the app listens yet, so the check stands in for the assistant. Main's module
  // scope is reached with a breakpoint that never pauses, set on a handler the page can call.
  await app.main.send("Debugger.enable");
  const built = fs.readFileSync(path.join(desktopRoot, "out/main/index.js"), "utf8").split("\n");
  const handler = built.findIndex((l) => l.includes('ipcMain.handle("meetings:calendar-access"'));
  const lineNumber = built.findIndex((l, i) => i >= handler && l.includes("meetingWatch.checkCalendar()"));
  const columnNumber = built[lineNumber].indexOf("meetingWatch.checkCalendar()");
  const { breakpointId } = await app.main.send("Debugger.setBreakpointByUrl", { urlRegex: "out/main/index\\.js$", lineNumber, columnNumber,
    condition: `(globalThis.__calls = [], meetingWatch.on("callStarted", (a) => __calls.push({ said: "started", app: a.name, at: Date.now() })), meetingWatch.on("callEnded", (a) => __calls.push({ said: "ended", app: a.name, at: Date.now() })), meetingWatch.watchCalls(true), false)` });
  await ev(`window.realm.meetings.calendarAccess()`);
  await app.main.send("Debugger.removeBreakpoint", { breakpointId });
  await app.main.send("Debugger.disable");
  const callsHelper = await until(async () => pids("calls")[0], 5_000, "the calls helper");
  check("once something wants calls the app runs the calls helper too", alive(callsHelper) && parentOf(callsHelper) === app.electron.pid);
  const calls = () => app.main.eval(`JSON.stringify(globalThis.__calls)`).then(JSON.parse);

  await standin(caller, [1.5]);
  await sleep(6_000);
  check("an input held for 1.5 s, as a permission preview is, starts no call", (await calls()).length === 0, await calls());

  const opened = Date.now() + 1500;
  await standin(caller, [5, 1, 3]);
  const closed = Date.now() - 500;
  await sleep(7_000);
  const said = await calls();
  say(`  stand-in: input open 5 s, closed 1 s, open 3 s. callStarted ${((said[0]?.at - opened) / 1000).toFixed(2)} s after it opened, callEnded ${((said[1]?.at - closed) / 1000).toFixed(2)} s after it closed for good`);
  check("a call starts about 3 s after the stand-in opens the input, named as the app its helper belongs to",
    said[0]?.said === "started" && said[0].app === "Discord" && Math.abs(said[0].at - opened - 3000) < 1200, said[0]);
  check("the 1 s gap ends nothing, and the call ends about 5 s after the stand-in lets go for good, once",
    said.length === 2 && said[1].said === "ended" && Math.abs(said[1].at - closed - 5000) < 1800, said);

  // The meeting: its notification two minutes before, its link at the start.
  await until(async () => firstSeen.notified, Math.max(0, FIRST.start - 120_000 - Date.now()) + 5_000, "the notification");
  const notifiedAt = firstSeen.notified;
  say(`  notification ${((FIRST.start - notifiedAt) / 1000).toFixed(1)} s before the start`);
  check("the notification comes two minutes before the meeting, with its title", Math.abs(FIRST.start - notifiedAt - 120_000) < 2_500, quiet().notified);
  check("nothing is opened before the start", Date.now() >= FIRST.start || quiet().opened.length === 0, quiet().opened);

  const shots = [];
  const shot = async (name) => {
    await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
    await sleep(400);
    const box = await ev(`(() => { const row = document.querySelector(${js(ROW)}).getBoundingClientRect();
      const head = [...document.querySelectorAll('.settings-head')].find((h) => h.textContent === "Meetings").getBoundingClientRect();
      return { x: row.x - 24, y: head.y - 20, width: row.width + 48, height: row.bottom - head.y + 40 }; })()`);
    const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
    // The capture keeps the DOM's alpha and none of the window's material: lay it on the page colour.
    const flat = await ev(`(async () => { const img = new Image(); img.src = "data:image/png;base64," + ${js(data)}; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim() || "#808080"; g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, 0, 0); return cv.toDataURL("image/png").split(",")[1]; })()`);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(flat, "base64"));
    shots.push(`${name}.png`);
  };
  // The store reads the theme and the look at boot, so a change over RPC lands with a reload.
  const shootAll = async (state) => {
    for (const look of ["plain", "glass"]) {
      for (const mode of ["dark", "light"]) {
        await api.call("settings.set", { key: "ui.look", value: look });
        await api.call("settings.set", { key: "ui.theme", value: mode });
        await page.send("Page.reload", {});
        await until(() => ev(`document.documentElement.dataset.mode === ${js(mode)} && !!document.querySelector('.composer')`), 20_000, `${look} ${mode}`);
        await openSettings();
        await sleep(500);
        const drawn = await ev(`document.documentElement.hasAttribute("data-glass") ? "glass" : "plain"`);
        if (drawn !== look) say(`  ${look} ${mode}: drawn ${drawn} (Glass is held back on this Mac)`);
        await shot(`settings-${state}-${look}-${mode}`);
      }
    }
  };

  await openSettings();
  check("Settings, with access: the row says what else it does and has no button",
    js(await rowSays()) === js({ detail: "With a notification two minutes before", button: null, on: true }), await rowSays());
  await shootAll("access-full");

  await sleep(Math.max(0, FIRST.start - Date.now()));
  await until(async () => firstSeen.opened, 5_000, "the link opened");
  clearInterval(watching);
  const openedAt = firstSeen.opened;
  say(`  link handed to the system ${((openedAt - FIRST.start) / 1000).toFixed(1)} s after the start`);
  check("at the start the meeting's link goes to the system", quiet().opened[0] === MEET && openedAt - FIRST.start < 2_500, quiet().opened);
  // The store changing reprints the events; so does the page asking.
  await ev(`window.realm.meetings.calendarAccess()`);
  await sleep(20_000);
  check("20 s later it has been opened once, and the all-day and declined fixtures never were",
    js(quiet()) === js({ notified: [FIRST.title], opened: [MEET] }), quiet());

  // Off: no helper, and a meeting that comes due is left alone.
  const before = quiet();
  await openSettings();
  await flipSwitch();
  await until(async () => !alive(pids("calendar").at(-1)), 5_000, "the calendar helper gone");
  check("with the setting off the calendar helper is gone", pids("calendar").every((pid) => !alive(pid)));
  setEvents([{ id: "LIVE-4", title: "Fixture: with the setting off", start: Date.now() + 15_000, end: Date.now() + 2_000_000, location: MEET }]);
  await sleep(25_000);
  check("with the setting off a meeting 15 s away gets no notification and is not opened", js(quiet()) === js(before), quiet());

  // No access: the helper reports it and prints no events, so nothing can come due.
  await restartCalendarWith("notDetermined");
  await until(async () => (await rowSays()).button === "Ask macOS", 5_000, "the Ask macOS button");
  check("Settings, not asked yet: the row says what is missing beside Ask macOS", /has not asked macOS for your calendar yet/.test((await rowSays()).detail), await rowSays());
  const commands = () => { try { return fs.readFileSync(path.join(rig, "commands"), "utf8").trim().split("\n"); } catch { return []; } };
  check("the page opening asks macOS for nothing", !commands().includes("ask"), commands());
  await ev(`(() => { document.querySelector(${js(ROW)} + ' button').click(); return true; })()`);
  await until(async () => commands().includes("ask"), 5_000, "the ask command");
  check("the button sends the helper its one ask command", commands().filter((c) => c === "ask").length === 1, commands());
  await shootAll("not-asked");
  check("without access nothing was notified or opened", js(quiet()) === js(before), quiet());

  await restartCalendarWith("denied");
  await until(async () => (await rowSays()).button === "Open System Settings", 5_000, "the Open System Settings button");
  check("Settings, denied: the row says so beside Open System Settings, and never offers to ask", /not letting Realm read your calendar/.test((await rowSays()).detail), await rowSays());
  await ev(`(() => { document.querySelector(${js(ROW)} + ' button').click(); return true; })()`);
  await until(async () => quiet().opened.length === 2, 5_000, "System Settings handed to the system");
  check("its button hands the Calendars privacy pane to the system", quiet().opened[1] === "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars", quiet().opened[1]);
  await shootAll("denied");
  say(`  captures: ${shots.join(" ")}`);

  // Quit: both helpers go, and neither is left to launchd.
  const running = [...pids("calendar"), ...pids("calls")].filter(alive);
  check("before quitting, one calendar helper and one calls helper are running", running.length === 2, running.length);
  // The app menu's Quit Realm and Stop Agents: a plain quit leaves Realm in the menu bar, still watching.
  const exited = new Promise((resolve) => app.electron.once("exit", resolve));
  void ev(`window.realm.quitAndStopAgents()`).catch(() => {});
  await Promise.race([exited, sleep(15_000)]);
  await sleep(1_000);
  check("after quit no helper is left running, none adopted by launchd", running.every((pid) => !alive(pid)), running.map((pid) => ({ alive: alive(pid), parent: parentOf(pid) })));
  api.close();
} finally {
  await app?.stop();
  fs.rmSync(rig, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, "rows.txt"), `${rows.join("\n")}\n`);
}
