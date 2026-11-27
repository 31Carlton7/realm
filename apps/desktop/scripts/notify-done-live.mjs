/**
 * Live check: a session finishing tells you once its work is done, not after every turn — unless
 * Settings ▸ Notifications says "After every turn".
 *
 *   pnpm build && node apps/desktop/scripts/notify-done-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent. A lead starts a sub-agent
 * through the real `agent_start` and ends its turn; the sub-agent holds a tool call for a few seconds,
 * then finishes. Every session runs the scripted agent, so no engine is billed.
 *
 * What is counted, per row, and only from what happened during that row:
 *   - toasts: main's `new Notification` + `show()`, through main's inspector. Quiet mode already stubs
 *     `show`, so nothing reaches the screen; the check also stands `isSupported` and the window's focus
 *     up so main's notifier gets as far as `create`. `show` stays a counter, never the real banner.
 *   - surfaced rows: `notifications.changed` carrying a `session_done` row, over RPC. The server hands
 *     exactly these to the relay (iMessage, Slack, phone push), so this count is the relay's. No relay
 *     destination is set, so nothing leaves the Mac.
 *
 * Rows go to results.json in LIVE_OUT_DIR / LIVE_OUT, with the Settings row captured in light and
 * dark, Plain and Glass (settings-<mode>-<look>.png).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const outs = [...new Set([process.env.LIVE_OUT_DIR, process.env.LIVE_OUT].filter(Boolean))];
if (outs.length === 0) outs.push(path.join(os.tmpdir(), "realm-notify-done-live"));
for (const dir of outs) fs.mkdirSync(dir, { recursive: true });
const OUT = outs[0];

const rows = [];
const writeRows = () => { for (const dir of outs) fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(rows, null, 2)); };
const row = (name, pass, observed) => {
  rows.push({ name, pass, observed });
  if (!pass) process.exitCode = 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(observed)}`);
  writeRows();
};

const SCRIPT = [
  { on: "ND lead starts a sub-agent", emit: [
    { kind: "call", tool: "realm-agent__agent_start", input: { title: "ND changelog", goal: "ND sub-agent works", constraints: { agentKind: "fake" } } },
    { kind: "text", text: "Started a sub-agent." },
  ] },
  { on: "ND sub-agent works", emit: [
    { kind: "tool", name: "Bash", input: { command: "pnpm test" }, result: "ok", holdMs: 6_000 },
    { kind: "text", text: "The changelog is written." },
  ] },
  { on: "ND plain turn", emit: [{ kind: "text", text: "Done with that." }] },
  { on: "ND breaks", emit: [{ kind: "fail", message: "ND: the build broke" }] },
];

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
    else if (msg.event) for (const l of [...listeners]) l(msg.event, msg.payload);
  });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    on: (l) => listeners.add(l),
    close: () => ws.close(),
  };
}

const FIND_STORE = `(() => {
  if (window.__liveStore) return true;
  const root = document.getElementById("root");
  const k = root && Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
  if (!k) return false;
  const stack = [root[k]];
  for (let n = 0; stack.length && n < 400000; n++) {
    const f = stack.pop();
    const v = f && f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.getState().applyAgentSettled === "function") { window.__liveStore = v; return true; }
    if (f && f.sibling) stack.push(f.sibling);
    if (f && f.child) stack.push(f.child);
  }
  return false; })()`;

const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "realm-notify-done-script-")), "script.json");
fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
// Over http, as the other checks that read data-glass are: from file:// the window falls back to plain.
const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
process.on("exit", () => { web.kill(); fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true }); });
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");
const app = await launchLiveApp({ name: "notify-done", rendererUrl, inspect: true, env: { REALM_FAKE_SCRIPT: scriptFile } });
const page = app.page;

try {
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 30_000, "composer");
  await until(() => page.eval(FIND_STORE), 10_000, "the renderer's store");

  /* Main's notifier, made to reach `create` and counted there. `show` is replaced by a counter, so a
     toast that main decides to post is recorded and never drawn. */
  await app.main.eval(`(() => {
    const { BrowserWindow, Notification } = require("electron");
    globalThis.__toasts = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.__toasts.push({ title: this.title, body: this.body }); };
    BrowserWindow.getFocusedWindow = () => null;
    return true; })()`);
  const toasts = () => app.main.eval(`globalThis.__toasts.length`);

  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const surfaced = [];
  const status = {};
  /** Every status a session reported, in order, so a wait can ask about the turn it just started. */
  const history = {};
  let opened = null;
  api.on((event, p) => {
    if (event === "notifications.changed" && p.notification?.category === "session_done") surfaced.push({ sessionId: p.notification.sessionId, body: p.notification.body });
    if (event === "session.status") { status[p.sessionId] = p.status; (history[p.sessionId] ??= []).push(p.status); }
    if (event === "session.agentOpened") opened = p.sessionId;
  });
  await api.call("settings.set", { key: "sessions.defaultPermissionMode", value: "bypassPermissions" });
  await api.call("settings.set", { key: "notifications.sound", value: false });
  const space = (await api.call("spaces.list", {}))[0];
  const newSession = async () => (await api.call("sessions.create", { spaceId: space.id, agentKind: "fake" })).session.id;
  const sentAt = {};
  const send = (id, text) => { sentAt[id] = history[id]?.length ?? 0; return api.call("sessions.send", { id, text, attachments: [] }); };
  /** The turn sent last settled in `to`: it ran, and then reported `to`. */
  const settles = (id, to = "idle", ms = 30_000) => until(async () => {
    const after = (history[id] ?? []).slice(sentAt[id] ?? 0);
    const ran = after.indexOf("running");
    return ran !== -1 && after.slice(ran + 1).includes(to);
  }, ms, `${id} ${to}`);
  /** What a row's own stretch produced: counted from marks taken when the row began. */
  const mark = async () => ({ rows: surfaced.length, toasts: await toasts() });
  const since = async (m) => ({ rows: surfaced.slice(m.rows), toasts: (await toasts()) - m.toasts });
  const readAll = () => api.call("notifications.markRead", { ids: [], all: true });
  const quiet = () => sleep(1_500);

  // ── "When the work is done", the default ─────────────────────────────────────────────────────
  const lead = await newSession();
  let m = await mark();
  opened = null;
  await send(lead, "ND lead starts a sub-agent");
  await until(async () => opened !== null, 20_000, "the sub-agent");
  const child = opened;
  await settles(lead);
  await quiet();
  let seen = await since(m);
  row("done: the lead settling while its sub-agent runs tells nothing", status[child] === "running" && seen.rows.length === 0 && seen.toasts === 0,
    { childStatus: status[child], ...seen });

  m = await mark();
  await settles(child);
  await quiet();
  seen = await since(m);
  row("done: the sub-agent finishing ends the lead's work, told once, for the lead",
    seen.rows.length === 1 && seen.rows[0].sessionId === lead && seen.toasts === 1, { lead, child, ...seen });

  await page.eval(`window.__liveStore.getState().refreshSubagents(${JSON.stringify(lead)}).then(() => true)`);
  const card = await page.eval(`(() => {
    const s = window.__liveStore.getState();
    const c = (s.subagents[${JSON.stringify(lead)}] ?? []).find((x) => x.session.id === ${JSON.stringify(child)});
    return { running: s.delegatedRuns[${JSON.stringify(lead)}]?.length ?? 0, status: s.sessionStatus[${JSON.stringify(child)}] ?? null,
      outcome: c?.outcome ?? null, settledAt: c?.settledAt ?? null };
  })()`);
  row("done: the sub-agent's card settles with no row of its own", card.running === 0 && card.status === "idle" && card.outcome === "done" && card.settledAt !== null, card);

  await readAll();
  const failing = await newSession();
  m = await mark();
  await send(failing, "ND breaks");
  await settles(failing, "error");
  await quiet();
  seen = await since(m);
  row("done: a failed turn is told", seen.rows.length === 1 && seen.rows[0].body === "Failed" && seen.toasts === 1, seen);

  // ── "After every turn" ───────────────────────────────────────────────────────────────────────
  await api.call("settings.set", { key: "notifications.sessionDone", value: "turn" });
  await readAll();
  const lead2 = await newSession();
  m = await mark();
  opened = null;
  await send(lead2, "ND lead starts a sub-agent");
  await until(async () => opened !== null, 20_000, "the second sub-agent");
  const child2 = opened;
  await settles(lead2);
  await quiet();
  seen = await since(m);
  row("every turn (main's behaviour, the control): the lead settling while its sub-agent runs is told",
    status[child2] === "running" && seen.rows.length === 1 && seen.rows[0].sessionId === lead2 && seen.toasts === 1, { childStatus: status[child2], ...seen });
  await settles(child2);
  await quiet();

  await readAll();
  const plain = await newSession();
  m = await mark();
  for (let i = 0; i < 2; i++) {
    await send(plain, "ND plain turn");
    await settles(plain);
    await quiet();
    // Read between turns, as a person who saw the first would: a still-unread row is reused, and main
    // toasts a row once.
    await readAll();
  }
  seen = await since(m);
  row("every turn: each settle is told", seen.rows.length === 2 && seen.rows.every((r) => r.sessionId === plain) && seen.toasts === 2, seen);

  const failing2 = await newSession();
  m = await mark();
  await send(failing2, "ND breaks");
  await settles(failing2, "error");
  await quiet();
  seen = await since(m);
  row("every turn: a failed turn is told", seen.rows.length === 1 && seen.rows[0].body === "Failed" && seen.toasts === 1, seen);

  // ── The Settings row ─────────────────────────────────────────────────────────────────────────
  await api.call("settings.set", { key: "notifications.sessionDone", value: "done" });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  // CI's macOS runners have Reduce Transparency on, which holds glass back whatever the setting says.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "no-preference" }] });
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: ",", code: "Comma", windowsVirtualKeyCode: 188 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: ",", code: "Comma", windowsVirtualKeyCode: 188 });
  await until(() => page.eval(`!!document.querySelector(".settings-page-pane")`), 10_000, "settings");
  await page.eval(`(() => { const t = [...document.querySelectorAll(".settings-tab")].find((l) => l.textContent.trim() === "Notifications"); (t?.querySelector("input") ?? t)?.click(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('[data-setting="session-done-when"] select')`), 10_000, "the Tell me row");
  const shown = () => page.eval(`(() => {
    const sel = document.querySelector('[data-setting="session-done-when"] select');
    sel.closest(".settings-row").scrollIntoView({ block: "center" });
    return { value: sel.value, label: sel.selectedOptions[0]?.textContent ?? null, disabled: sel.disabled,
      mode: document.documentElement.dataset.mode ?? null, glass: document.documentElement.hasAttribute("data-glass") };
  })()`);
  for (const look of ["plain", "glass"]) {
    await api.call("settings.set", { key: "ui.look", value: look });
    for (const mode of ["light", "dark"]) {
      await api.call("settings.set", { key: "ui.theme", value: mode });
      await until(async () => { const s = await shown(); return s.mode === mode && s.glass === (look === "glass"); }, 5_000, `${mode} ${look}`).catch(() => {});
      await sleep(500);
      const s = await shown();
      const capture = `settings-${mode}-${look}.png`;
      await app.screenshot(path.join(OUT, capture));
      for (const dir of outs.slice(1)) fs.copyFileSync(path.join(OUT, capture), path.join(dir, capture));
      row(`settings: the Tell me row reads "When the work is done" by default (${mode}, ${look})`,
        s.value === "done" && s.label === "When the work is done" && !s.disabled && s.mode === mode && s.glass === (look === "glass"), { ...s, capture });
    }
  }
  api.close();
} finally {
  writeRows();
  await app.stop();
  web.kill();
}
