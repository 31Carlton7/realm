/**
 * Live check for Settings ▸ Sign-ins ▸ Let agents finish sign-ins and the fill card that offers it
 * (run with: pnpm build && node apps/desktop/scripts/agent-signins-settings-live.mjs).
 *
 * The BUILT app, quiet, on a scratch REALM_HOME and a scratch HOME, through `launchLiveApp`, with the
 * renderer over http so the squircle worklet loads. The scripted fake engine calls Realm's real
 * browser tools (`kind: "call"`, nothing billed) against a localhost sign-in page; the saved password
 * is made up and sits on a mock keychain; the Touch ID stand-in (`REALM_LIVE_PRESENCE_LOG`) answers
 * the unlock. The calendar helper is the live helper's stand-in, and main's Security codes, computer
 * access, `mac` and unlock-policy handlers are stubbed in main, so no row reads this Mac's grants, no
 * button opens System Settings and no change of unlock asks macOS for the person.
 *
 *   card   with sign-ins off, a fill of the password on its own site raises one card: Allow once,
 *          Turn on sign-ins, Deny. Turn on sign-ins is pressed with the mouse; main's switch comes
 *          on, Security codes come on with it, the field is filled, the transcript says so, and no
 *          second card comes.
 *   rows   the group's rows, not granted and granted, the notifications row with Full Disk Access
 *          on but the notifications database unreadable, and the rows on a Mac with no Messages or
 *          notification history to read, which no grant would change.
 *
 * Every capture is taken dark and light, Plain; the group's switch row also in Glass, whose knob is
 * glass. PNGs go to LIVE_OUT_DIR.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/agent-signins-settings");
fs.mkdirSync(OUT_DIR, { recursive: true });
const js = (v) => JSON.stringify(v);
const check = (name, ok, detail) => {
  if (!ok) process.exitCode = 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${js(detail)}` : ""}`);
};

const scratch = fs.mkdtempSync(path.join(os.homedir(), "realm-scratch", "signins-settings-"));
const home = path.join(scratch, "home");
fs.mkdirSync(home, { recursive: true });
const presenceLog = path.join(scratch, "presence.log");
const codesFile = path.join(scratch, "codes.json");
fs.writeFileSync(codesFile, "[]");

/* ── the site, and the scripted agent ─────────────────────────────────────────────────────────── */

const SIGNIN = `<!doctype html><html><head><title>Sign in</title><style>body{font:15px -apple-system;margin:48px} input{display:block;width:260px;height:36px;margin:6px 0 14px}</style></head>
<body><h1>Sign in</h1><form onsubmit="return false"><label for="user">Email</label><input id="user" autocomplete="username">
<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"><button>Sign in</button></form></body></html>`;
const sitePort = await freePort();
const SITE = `http://127.0.0.1:${sitePort}`;
const site = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(SIGNIN); });
await new Promise((r) => site.listen(sitePort, "127.0.0.1", r));

const TOOLS = { Open: "realm-browser__browser_open", Snap: "realm-browser__browser_snapshot", Fill: "realm-browser__browser_fill_credential", Show: "realm-workspace__pane_show" };
const scriptFile = path.join(scratch, "script.json");
fs.writeFileSync(scriptFile, js(Object.entries(TOOLS).map(([on, tool]) => ({ on: `${on} {`, emit: [{ kind: "call", tool, input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }] }))));

const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");

function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) onEvent?.(msg.event, msg.payload);
  });
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

/* Main's grants, stood in: Security codes' sources, the computer-use grants and the `mac` CLI's.
   Each handler reads `globalThis.__stub`, which the script rewrites between captures. */
const STUBS = `(() => {
  const { ipcMain } = require("electron");
  const row = (id, label, state) => ({ id, label, state, detail: "", canPrompt: state !== "granted", needsSettings: state !== "granted",
    askExplanation: state === "granted" ? null : "macOS opens System Settings.", stale: false, canRepair: false, repairExplanation: null, settingsPlace: "Privacy & Security ▸ Accessibility" });
  globalThis.__stub = { codes: { enabled: false, sources: null }, codesSets: [], accessibility: "denied", unlock: { kind: "touch-id" }, opened: [] };
  const computer = () => ({ hostName: "Realm", packaged: true, signed: true, helperAvailable: true,
    rows: [row("accessibility", "Accessibility", globalThis.__stub.accessibility), row("screenRecording", "Screen Recording", "granted")] });
  for (const ch of ["codes:status", "codes:set-enabled", "computer:status", "computer:request", "computer:repair", "mac:status", "mac:grant", "mac:open-settings", "mac:reveal-app",
    "credentials:unlock-policy", "credentials:set-unlock-policy"]) ipcMain.removeHandler(ch);
  // The unlock too: loosening it asks macOS for the person, which no check may raise on this Mac.
  ipcMain.handle("credentials:unlock-policy", () => ({ policy: globalThis.__stub.unlock, sessionUntil: null }));
  ipcMain.handle("credentials:set-unlock-policy", (_e, _profileId, policy) => { globalThis.__stub.unlock = policy; return { ok: true, status: { policy, sessionUntil: null } }; });
  ipcMain.handle("codes:status", () => globalThis.__stub.codes);
  ipcMain.handle("codes:set-enabled", (_e, on) => { globalThis.__stub.codesSets.push(on); globalThis.__stub.codes = on === true ? { ...globalThis.__stub.codes, enabled: true } : { enabled: false, sources: null }; return globalThis.__stub.codes; });
  ipcMain.handle("computer:status", computer);
  ipcMain.handle("computer:request", (_e, id) => { globalThis.__stub.opened.push("computer:" + id); return computer(); });
  ipcMain.handle("computer:repair", computer);
  ipcMain.handle("mac:status", () => ({ cli: { present: false, searched: ["(stub)"] }, rows: [], host: { name: "Realm", packaged: true } }));
  ipcMain.handle("mac:grant", () => ({ cli: { present: false, searched: ["(stub)"] }, rows: [], host: { name: "Realm", packaged: true } }));
  ipcMain.handle("mac:open-settings", (_e, id) => { globalThis.__stub.opened.push("mac:" + id); });
  ipcMain.handle("mac:reveal-app", () => { globalThis.__stub.opened.push("reveal"); });
  return true;
})()`;

let app = null, api = null;
const watchdog = setTimeout(() => { console.error("FAIL watchdog: six minutes"); void teardown().finally(() => process.exit(9)); }, 360_000);

async function teardown() {
  clearTimeout(watchdog);
  api?.close();
  await app?.stop().catch(() => {});
  web.kill();
  await new Promise((r) => site.close(() => r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}

const HELPERS = `globalThis.__live = { box: (n) => { const b = n.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; } }; void 0`;
const evalIn = (expr) => app.page.eval(`${HELPERS};\n${expr}`);

async function press(find) {
  const b = await evalIn(`(() => { const n = ${find}; if (!n) return null; n.scrollIntoView({ block: 'center' }); return __live.box(n); })()`);
  if (!b) throw new Error(`nothing to press: ${find}`);
  const at = { x: b.x + b.w / 2, y: b.y + b.h / 2, button: "left", clickCount: 1 };
  await app.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await app.page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
  await app.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
}

async function setFace(mode, look) {
  await openSettings("appearance");
  await evalIn(`document.querySelector('input[name="settings-look"][value=${js(look)}]').click(), document.querySelector('input[name="settings-theme"][value=${js(mode)}]').click(), true`);
  await until(() => evalIn(`document.documentElement.dataset.mode === ${js(mode)} && document.documentElement.hasAttribute("data-glass") === ${look === "glass"}`), 15_000, `${mode} ${look}`);
  // The face eases in; a capture taken mid-change is of neither.
  await sleep(900);
}

async function openSettings(tab) {
  const has = () => evalIn(`!!document.querySelector('input[name="settings-page-tab"][value=${js(tab)}]')`);
  if (!(await has())) await app.main.eval(`require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable()).webContents.send("app:command", "settings.open")`);
  await until(has, 10_000, "Settings");
  await evalIn(`document.querySelector('input[name="settings-page-tab"][value=${js(tab)}]').click(), true`);
}

/** Leave Sign-ins and come back, so the group reads main's stubs afresh, and wait for `ready`. */
async function reopenSignins(ready) {
  await openSettings("keys");
  await sleep(200);
  await openSettings("signins");
  await until(() => evalIn(ready), 10_000, `Sign-ins: ${ready}`);
  await sleep(500);
}

/** One capture per face around `sel`, `pad` of its ground round it. */
async function shots(tag, sel, { looks = ["plain"], pad = 16, after } = {}) {
  await app.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  const out = [];
  for (const look of looks) for (const mode of ["dark", "light"]) {
    await setFace(mode, look);
    await after?.();
    const look1 = () => evalIn(`(() => { const n = document.querySelector(${js(sel)}); if (!n) return null; n.scrollIntoView({ block: 'center' }); return __live.box(n); })()`);
    let b = await look1();
    for (let i = 0; i < 20; i++) { await sleep(150); const again = await look1(); if (js(again) === js(b)) break; b = again; }
    if (!b) throw new Error(`nothing to capture: ${sel}`);
    const clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + pad * 2, height: b.h + pad * 2, scale: 2 };
    // The page is clear over the window's material, which a DOM capture does not hold: laid over the
    // theme's page colour, as the window shows it.
    const page = await evalIn(`(() => { const n = document.createElement('div'); n.style.background = 'var(--page)'; document.body.append(n);
      const x = document.createElement('canvas').getContext('2d'); x.fillStyle = getComputedStyle(n).backgroundColor; n.remove();
      x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); })()`);
    await app.page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: page[0], g: page[1], b: page[2], a: 1 } });
    const r = await app.page.send("Page.captureScreenshot", { format: "png", clip });
    await app.page.send("Emulation.setDefaultBackgroundColorOverride", {});
    const file = path.join(OUT_DIR, `${tag}-${mode}${looks.length > 1 ? `-${look}` : ""}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log(`SCREENSHOT ${file}`);
    out.push(file);
  }
  return out;
}

async function main() {
  app = await launchLiveApp({
    name: "signins-settings", inspect: true, rendererUrl, timeoutMs: 60_000,
    args: ["--use-mock-keychain", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
    env: { HOME: home, REALM_FAKE_SCRIPT: scriptFile, REALM_LIVE_SCRATCH: "1", REALM_LIVE_CODES: codesFile, REALM_LIVE_PRESENCE_LOG: presenceLog },
  });
  await app.main.eval(STUBS);
  const cards = [];
  let sessionId = null;
  api = rpc(app.ports.server, await daemonToken(app.home), (event, payload) => {
    if (event === "session.event" && payload.sessionId === sessionId && payload.event?.type === "permission_request") cards.push(payload.event.payload);
  });
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Sign-ins check" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });
  await until(() => app.main.eval(`require("electron").BrowserWindow.getAllWindows().some((w) => w.isResizable() && !w.webContents.isLoading())`), 30_000, "the window's first load");
  await app.page.send("Page.reload");
  await until(() => evalIn(`document.readyState === "complete" && document.body.innerText.includes("Sign-ins check")`), 30_000, "the window on its space");
  await app.page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 2, mobile: false });
  await app.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(`(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive'); hold();
    new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] });
    const banner = () => document.getElementById('live-scratch-banner')?.remove(); banner(); new MutationObserver(banner).observe(document.body, { childList: true }); return true; })()`);

  const ipc = (expr) => evalIn(`(async () => { const v = window.realm.credentials; ${expr} })()`);
  await ipc(`await v.add(${js(space.profileId)}, { origin: ${js(SITE)}, username: "ada", label: "Fixture", value: "fixture-" + crypto.randomUUID() }); return true;`);
  const credentialId = (await ipc(`return (await v.list(${js(space.profileId)})).find((r) => r.origin === ${js(SITE)})?.id;`));
  check("a made-up password is saved for the fixture site", typeof credentialId === "string");
  check("agent sign-ins start off", (await ipc(`return (await v.signinsStatus()).enabled;`)) === false);

  /* ── the card ───────────────────────────────────────────────────────────────────────────────── */
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Sign-in card check", permissionMode: "bypassPermissions" });
  sessionId = session.id;
  const row = `[...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Sign-in card check"))`;
  await until(() => evalIn(`!!${row}`), 20_000, "the session's row");
  await evalIn(`${row}.click(), true`);
  await sleep(800);
  const events = () => api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 5000 });
  const say = async (verb, args) => {
    const seen = (await events()).length;
    await api.call("sessions.send", { id: sessionId, text: `${verb} ${js(args)}`, attachments: [], mentions: [] });
    return seen;
  };
  const resultAfter = (seen, what) => until(async () => (await events()).slice(seen).find((e) => e.event.type === "tool_result")?.event.payload, 60_000, what);
  const settled = (seen) => until(async () => (await events()).slice(seen).some((e) => e.event.type === "status" && e.event.payload.status === "idle"), 30_000, "the turn to settle");

  let seen = await say("Open", { url: `${SITE}/signin` });
  const opened = await resultAfter(seen, "browser_open");
  await settled(seen);
  const browserId = /pane (\S+) at/.exec(opened.content)?.[1];
  check("the agent opens a pane on the sign-in page", !!browserId, opened.content);
  seen = await say("Show", { browserId });
  await resultAfter(seen, "pane_show");
  await settled(seen);
  await until(async () => (await app.targets()).some((t) => t.type === "page" && t.url.startsWith(SITE)), 20_000, "the pane's page");
  await sleep(800);
  seen = await say("Snap", { browserId });
  const snap = await resultAfter(seen, "browser_snapshot");
  await settled(seen);
  const ref = Number(/\[ref=(\d+)\] textbox "Password"/.exec(snap.content)?.[1]);

  seen = await say("Fill", { browserId, ref, credentialId });
  await until(async () => cards.length > 0, 30_000, "the fill card");
  await until(() => evalIn(`!!document.querySelector('.permission-card')`), 15_000, "the card drawn");
  const options = await evalIn(`[...document.querySelectorAll('.permission-card .permission-option')].map((b) => b.getAttribute('aria-label'))`);
  check("with sign-ins off, one card with three choices", cards.length === 1 && js(options) === js(["Allow once", "Turn on sign-ins", "Deny"]), { cards: cards.map((c) => c.toolName), options });
  check("no invitation beside it", !cards.some((c) => c.toolName === "agent_signins"));
  const toSession = async (sel) => { await evalIn(`${row}.click(), true`); await until(() => evalIn(`!!document.querySelector(${js(sel)})?.offsetParent`), 15_000, sel); };
  await shots("card", ".permission-card", { pad: 24, after: () => toSession(".permission-card") });
  // Back to the session, to answer it as a person does: Turn on sign-ins, with the mouse.
  await setFace("dark", "plain");
  await toSession(".permission-card");
  await press(`document.querySelector('.permission-card .permission-option[aria-label="Turn on sign-ins"]')`);
  const filled = await resultAfter(seen, "the fill's result");
  await settled(seen);
  check("Turn on sign-ins fills, with no second card", !filled.isError && cards.length === 1, { text: filled.content, cards: cards.length });
  check("main's switch is on", (await ipc(`return (await v.signinsStatus()).enabled;`)) === true);
  check("Turn on sign-ins turned Security codes on too", js(await app.main.eval(`globalThis.__stub.codesSets`)) === js([true]), await app.main.eval(`globalThis.__stub.codesSets`));
  const note = (await events()).slice(seen).find((e) => e.event.type === "signin_filled")?.event.payload.note;
  check("the transcript says what was filled, and where", note === `Realm filled a saved password on 127.0.0.1:${sitePort}`, note);
  check("the unlock still ran (the Touch ID stand-in was asked)", fs.existsSync(presenceLog) && fs.readFileSync(presenceLog, "utf8").trim().length > 0);
  await until(() => evalIn(`!!document.querySelector('[data-signin-filled]')`), 10_000, "the fill's line");
  await shots("line-after-turn-on", "[data-signin-filled]", { pad: 40, after: () => toSession("[data-signin-filled]") });
  seen = await say("Fill", { browserId, ref, credentialId });
  const again = await resultAfter(seen, "a second fill");
  await settled(seen);
  check("the next fill needs no card at all", !again.isError && cards.length === 1, { cards: cards.length });

  /* ── the group's rows ───────────────────────────────────────────────────────────────────────── */
  const G = ".agent-signins";
  const rowSel = (name) => `${G} [aria-label^=${js(`${name}: `)}]`;
  const ROWS = { codes: "Read sign-in codes from Messages and Mail", notifications: "Codes from notifications on this Mac", apps: "Use apps on this Mac for a sign-in", unlock: "Unlock passwords for agents" };
  const labelOf = (name) => evalIn(`document.querySelector(${js(rowSel(name))})?.getAttribute('aria-label')`);
  const capture = async (state) => {
    await shots(`group-${state}`, G, { after: () => reopenSignins(`!!document.querySelector(${js(G)})`) });
    for (const [key, name] of Object.entries(ROWS)) await shots(`row-${key}-${state}`, rowSel(name), { pad: 8, after: () => reopenSignins(`!!document.querySelector(${js(rowSel(name))})`) });
  };

  await app.main.eval(`globalThis.__stub.codes = { enabled: true, sources: { Messages: "no_access", Mail: "ok", Notifications: "no_access" } }, true`);
  await reopenSignins(`!!document.querySelector(${js(G)})`);
  const notGranted = Object.fromEntries(await Promise.all(Object.values(ROWS).map(async (n) => [n, await labelOf(n)])));
  check("not granted: each row says what is missing", notGranted[ROWS.codes].endsWith("Needs Full Disk Access") && notGranted[ROWS.notifications].endsWith("Needs Full Disk Access")
    && notGranted[ROWS.apps].endsWith("Not granted") && notGranted[ROWS.unlock].endsWith("Touch ID"), notGranted);
  await capture("not-granted");
  await press(`[...document.querySelectorAll(${js(`${rowSel(ROWS.codes)} button`)})].find((b) => b.textContent === "Open System Settings")`);
  await press(`[...document.querySelectorAll(${js(`${rowSel(ROWS.apps)} button`)})].find((b) => b.textContent === "Allow in System Settings")`);
  check("the rows' steps reach main (stubbed: nothing opened)", js(await app.main.eval(`globalThis.__stub.opened`)) === js(["mac:fullDiskAccess", "computer:accessibility"]), await app.main.eval(`globalThis.__stub.opened`));

  await app.main.eval(`globalThis.__stub.codes = { enabled: true, sources: { Messages: "ok", Mail: "ok", Notifications: "no_access" } }, true`);
  await reopenSignins(`!!document.querySelector(${js(G)})`);
  const locked = await evalIn(`document.querySelector(${js(rowSel(ROWS.notifications))}).textContent`);
  check("Full Disk Access on, notifications unreadable: says Realm can't read them", locked.includes("Realm can't read notifications on this Mac.") && !locked.includes("Full Disk Access"), locked);
  await shots("row-notifications-locked", rowSel(ROWS.notifications), { pad: 8, after: () => reopenSignins(`!!document.querySelector(${js(rowSel(ROWS.notifications))})`) });

  // No Messages history and no notification history: nothing a grant would change, so no row sends
  // the person to Full Disk Access.
  const textOf = (name) => evalIn(`document.querySelector(${js(rowSel(name))}).textContent`);
  await app.main.eval(`globalThis.__stub.codes = { enabled: true, sources: { Messages: "missing", Mail: "ok", Notifications: "missing" } }, true`);
  await reopenSignins(`!!document.querySelector(${js(G)})`);
  const mailOnly = await textOf(ROWS.codes), noNotes = await textOf(ROWS.notifications);
  check("no Messages history, Mail readable: codes Granted, Mail only, no Full Disk Access", mailOnly.includes("Granted") && mailOnly.includes("Only Mail can be read here.") && !mailOnly.includes("Full Disk Access"), mailOnly);
  check("no notification history: says so, no Full Disk Access", noNotes.includes("Nothing to read") && noNotes.includes("This Mac has no notification history to read.") && !noNotes.includes("Full Disk Access"), noNotes);
  await shots("row-codes-mail-only", rowSel(ROWS.codes), { pad: 8, after: () => reopenSignins(`!!document.querySelector(${js(rowSel(ROWS.codes))})`) });
  await shots("row-notifications-missing", rowSel(ROWS.notifications), { pad: 8, after: () => reopenSignins(`!!document.querySelector(${js(rowSel(ROWS.notifications))})`) });
  await app.main.eval(`globalThis.__stub.codes = { enabled: true, sources: { Messages: "missing", Mail: "missing", Notifications: "missing" } }, true`);
  await reopenSignins(`!!document.querySelector(${js(G)})`);
  const nothing = await textOf(ROWS.codes);
  check("no Messages history and no mail: Nothing to read, no Full Disk Access", nothing.includes("Nothing to read") && !nothing.includes("Full Disk Access"), nothing);
  await shots("row-codes-nothing", rowSel(ROWS.codes), { pad: 8, after: () => reopenSignins(`!!document.querySelector(${js(rowSel(ROWS.codes))})`) });

  await app.main.eval(`globalThis.__stub.codes = { enabled: true, sources: { Messages: "ok", Mail: "ok", Notifications: "ok" } }, globalThis.__stub.accessibility = "granted", true`);
  await reopenSignins(`!!document.querySelector(${js(G)})`);
  await press(`[...document.querySelectorAll(${js(`${rowSel(ROWS.unlock)} button`)})].find((b) => b.textContent === "Unlock for 8 hours")`);
  await until(async () => (await labelOf(ROWS.unlock))?.endsWith("For 8 hours"), 15_000, "the 8-hour unlock");
  const granted = Object.fromEntries(await Promise.all(Object.values(ROWS).map(async (n) => [n, await labelOf(n)])));
  check("granted: every row says so", Object.values(granted).every((l) => /: (Granted|For 8 hours)$/.test(l)), granted);
  await capture("granted");

  await shots("switch", `${G} > .settings-row:first-child`, { looks: ["plain", "glass"], pad: 8, after: () => reopenSignins(`!!document.querySelector(${js(G)})`) });
  const cli = await evalIn(`document.body.innerText.includes("Finishing sign-ins")`);
  check("the old per-space name is gone from the window", cli === false);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch(async (e) => {
  process.exitCode = 1;
  console.error(`FAIL ${e?.stack ?? e}`);
  console.error(`page: ${await app?.page.eval(`document.body.innerText.slice(0, 600)`).catch(() => "?")}`);
}).finally(teardown);
