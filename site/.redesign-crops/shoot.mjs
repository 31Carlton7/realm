// Landing round three, early look: captures from the built v2.11.1 app. Quiet (live-app.mjs), a scratch
// home inside this folder, the scripted stand-in for Claude, names stubbed by bin/. Nothing is sent to
// an engine: boot 1 seeds spaces, teammates and sessions over RPC; the transcripts and states are
// written into the scratch realm.db while the app is down; boot 2 renders them.
//
//   TMPDIR=<this dir>/tmp node shoot.mjs
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchLiveApp, until, sleep } from "../apps/desktop/scripts/lib/live-app.mjs";
import { daemonToken, tokenProtocols } from "../apps/desktop/scripts/lib/daemon-token.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, "out");
const HOME = path.join(HERE, "home");
const DB = path.join(HOME, "realm.db");
const APPDIR = path.join(HERE, "work");
const BIN = path.join(HERE, "bin");
fs.rmSync(HOME, { recursive: true, force: true });

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(APPDIR, { recursive: true });
fs.writeFileSync(path.join(APPDIR, "package.json"), JSON.stringify({ name: "app", private: true, scripts: { build: "sleep 3617", dev: "sleep 3617" } }));
// The space's folder is the launch folder: a clean repo of its own, so no git strip shows over the prompter.
if (!fs.existsSync(path.join(APPDIR, ".git"))) execSync("git init -q && git add package.json && git -c user.name=Realm -c user.email=realm@example.com commit -qm init", { cwd: APPDIR });
process.chdir(APPDIR);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready,
    call: (method, params = {}) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const ENV = {
  PATH: `${BIN}:${process.env.PATH}`,
  SHELL: "/usr/bin/false",
  REALM_HOME: HOME,
  REALM_FAKE_STANDS_IN: "claude",
  REALM_LAYA_VENV: path.join(HERE, "tmp/laya-off/venv"),
  REALM_LAYA_HF_HOME: path.join(HERE, "tmp/laya-off/hf"),
};
const ARGS = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];

async function boot(name, extra = {}) {
  const app = await launchLiveApp({ name, inspect: true, args: ARGS, env: { ...ENV, ...extra }, timeoutMs: 60_000 });
  await app.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await app.main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); return true; })()`);
  return app;
}
async function down(app, api) {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  await app.stop();
  await sleep(800);
}

function makeTools(app) {
  const ev = (expr) => app.page.eval(expr);
  const metrics = (width, height) => app.page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  const awake = () => ev(`(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive"); if (!window.__awake) { window.__awake = new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")); window.__awake.observe(r, { attributes: true }); } return true; })()`);
  const privateCheck = async () => {
    const text = await ev("document.body.innerText");
    if (/Carlton|Aikins/i.test(text)) throw new Error("a private name is on screen");
    return text;
  };
  async function shot(name) {
    await awake();
    await app.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await sleep(900);
    await ev(`(() => { for (const n of document.querySelectorAll('.tm-machine-note')) n.style.display = "none"; return true; })()`);
    await privateCheck();
    const { data } = await app.page.send("Page.captureScreenshot", { format: "png" });
    // The capture keeps the DOM's alpha and none of the window's material: lay it on the page colour.
    const flat = await ev(`(async () => { const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, 0, 0); return cv.toDataURL("image/png").split(",")[1]; })()`);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(flat, "base64"));
    const rects = await ev(`(() => { const out = {}; const sel = { session: '.session-pane', composer: '.composer', transcript: '.transcript', computer: '.tm-computer', access: '.sb-team-access', team: '.sb-team', sidebar: '.sidebar', head: '.tm-head', greeting: '.hero-greeting, [class*=greeting]', panel: '.side-panel, .panel' };
      for (const [k, s] of Object.entries(sel)) { out[k] = [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), e.className.toString().slice(0, 60)]; }); }
      out.calls = [...document.querySelectorAll('.teammate-call')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), e.innerText]; });
      out.accessLines = [...document.querySelectorAll('[data-access]')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), e.innerText]; });
      out.messages = [...document.querySelectorAll('.transcript [class*=msg], .transcript [class*=message]')].slice(0, 40).map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), e.className.toString().slice(0, 40), e.innerText.slice(0, 60)]; });
      return out; })()`);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(rects, null, 1));
    log("SHOT", name);
  }
  return { ev, metrics, awake, shot, privateCheck };
}

// ── Boot 1: onboarding, the new session, and the seed over RPC ──
let app = await boot("early1");
let api = null;
let seed;
try {
  const { ev, metrics, shot } = makeTools(app);
  await metrics(1440, 900);
  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 40_000, "onboarding");
  await ev(`(() => { const i = document.querySelector('.onboarding input:not([type=radio])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "Realm"); i.dispatchEvent(new Event("input", { bubbles: true })); i.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(HOME));
  await api.ready;
  const [first] = await until(async () => { const a = await api.call("sessions.listAll", {}); return a.length ? a : null; }, 15_000, "onboarding session");
  // "claude" here is the scripted stand-in (REALM_FAKE_STANDS_IN): the chip reads Claude, nothing can bill.
  await api.call("sessions.setAgent", { id: first.id, agentKind: "claude" });
  await api.call("sessions.setOptions", { id: first.id, model: "claude-opus-5-5" });
  // Onboarding makes the space's folder inside this checkout, where it would show the checkout's
  // untracked files over the prompter. A clean repo of its own there shows none.
  const [made] = await api.call("spaces.list", {});
  const folder = made.folderPath ?? made.folder_path;
  log("space folder", folder);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "README.md"), "# Realm\n");
  execSync("git init -q && git add README.md && git -c user.name=Realm -c user.email=realm@example.com commit -qm init", { cwd: folder });
  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  await api.call("settings.set", { key: "ui.background", value: "webb" });
  await app.page.send("Page.reload", {});
  await sleep(1500);
  await until(() => ev(`!!document.querySelector('.composer') && document.documentElement.dataset.mode === "dark"`), 30_000, "composer, dark");
  await metrics(1440, 900);
  await sleep(2500);
  await shot("session-1440");
  // A phone's width: the same session laid out narrow, for the hero on a phone.
  await metrics(440, 760);
  await sleep(2500);
  await api.call("settings.set", { key: "ui.sidebarCollapsed", value: true });
  await app.page.send("Page.reload", {});
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer, sidebar hidden");
  await metrics(470, 820);
  await sleep(3000);
  await shot("session-470");
  await api.call("settings.set", { key: "ui.sidebarCollapsed", value: false });
  await metrics(1440, 900);

  const spaceId = first.spaceId;
  const brief = (line) => `${line}\nFor real work, start a session for the task and keep the chat for decisions.`;
  const make = (input) => api.call("teammates.create", { spaceId, agentKind: "claude", model: "claude-opus-5-5", ...input });
  const mates = {
    captain: await make({ name: "Release Captain", handle: "captain", lead: true, icon: { shape: "hexagon", color: "blue" }, permissionMode: "bypassPermissions", brief: brief("You lead this team: route each ask to the teammate who fits, and ship each release.") }),
    polish: await make({ name: "Desktop Polish", handle: "polish", icon: { shape: "flower", color: "pink" }, permissionMode: "default", brief: brief("You polish the desktop app's interface.") }),
    engines: await make({ name: "Engines", handle: "engines", icon: { shape: "cloud", color: "lime" }, permissionMode: "acceptEdits", brief: brief("You keep every agent harness working.") }),
    docs: await make({ name: "Docs Writer", handle: "docs", icon: { shape: "circle", color: "teal" }, permissionMode: "acceptEdits", brief: brief("You write the changelog and the docs.") }),
  };
  for (const t of await api.call("teammates.list", { spaceId })) for (const k of Object.keys(mates)) if (mates[k].id === t.id) mates[k] = t;
  // Team access on Full access: every teammate on one level.
  await api.call("teams.access.set", { spaceId, mode: "bypassPermissions" });
  log("access", JSON.stringify(await api.call("teams.access.get", { spaceId })));

  const at = (iso) => (Date.now() - Date.parse(iso)) / 60_000;
  // key, title, owner, minutes ago. Finished rows sit at the real times of the merges and releases they name.
  const specs = [
    ["land", "land the sidebar fix", "captain", 2], ["prepare", "prepare the release branch", "captain", 4], ["changelog", "changelog entry", "captain", 6], ["build", "build the release", "engines", 5], ["notes", "release notes", "docs", 8], ["focus", "find bar focus ring", "polish", 11],
    ["ship2111", "ship 2.11.1", "captain", at("2026-11-12T17:58:39Z")],
    ["pr382", "schedules run no higher", "engines", at("2026-11-12T17:55:01Z")],
    ["pr384", "say what Full access ran", "engines", at("2026-11-12T04:02:23Z")],
    ["ship2110", "ship 2.11.0", "captain", at("2026-11-12T02:49:59Z")],
    ["pr379", "picture to the pane's foot", "polish", at("2026-11-12T02:48:27Z")],
    ["pr376", "Lead sets a teammate's access", "engines", at("2026-11-12T02:16:57Z")],
    ["ship2101", "ship 2.10.1", "captain", at("2026-11-11T23:23:23Z")],
    ["pr375", "confirm Full access for a team", "polish", at("2026-11-11T23:11:27Z")],
    ["ship2100", "ship 2.10.0", "captain", at("2026-11-11T22:34:40Z")],
    ["pr370", "Team access in the Team list", "polish", at("2026-11-11T22:01:59Z")],
  ];
  const S = {};
  for (const [key, title] of specs) {
    const { session, itemId } = await api.call("sessions.create", { spaceId, agentKind: "claude", title });
    S[key] = { id: session.id, itemId };
  }
  const browser = await api.call("browsers.create", { spaceId, url: "" });
  seed = { spaceId, mates, S, specs, browser, onboarding: first.id };
} catch (e) {
  console.error("FAIL", e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await down(app, api);
}
if (process.exitCode) process.exit(1);

// ── With the app down: transcripts and states into the scratch db ──
const sql = (stmt) => execFileSync("sqlite3", [DB, stmt], { encoding: "utf8" });
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const { mates, S, specs, browser } = seed;
const now = Date.now(), MIN = 60_000;
const set = (id, cols) => sql(`UPDATE sessions SET ${Object.entries(cols).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} WHERE id = ${q(id)}`);
const event = (id, type, payload, ts = now) => sql(`INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(id)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))})`);
const init = (id, ts) => event(id, "init", { providerSessionId: `seed-${id}`, model: "claude-opus-5-5", tools: [], cwd: APPDIR }, ts);
let use = 0;
const call = (id, name, input, content, ts) => {
  const u = `seed-${++use}`;
  event(id, "tool_call", { toolUseId: u, name, input, parentToolUseId: null }, ts);
  event(id, "tool_result", { toolUseId: u, content, isError: false }, ts + 1000);
};
const cap = mates.captain;
for (const [key, title, owner, ago] of specs) {
  const mate = mates[owner];
  init(S[key].id, now - Math.round(ago * MIN) - 5 * MIN);
  set(S[key].id, { teammate_id: mate.id, teammate_home: 0, title: `${mate.handle} - ${title}`, status: "idle",
    dispatched_by_session_id: owner === "captain" ? cap.homeSessionId : null, asked_by_session_id: owner === "captain" ? null : cap.homeSessionId,
    activity_at: now - Math.round(ago * MIN) });
}
// Each number and tag is a real one in 31Carlton7/realm, at the time its row sits at.
const repo = "https://github.com/31Carlton7/realm";
const gh = (key, command, out) => call(S[key].id, "Bash", { command }, out, now - 60 * MIN);
gh("ship2111", "gh release create v2.11.1 --notes-file notes.md", `${repo}/releases/tag/v2.11.1`);
gh("pr382", "gh pr merge 382 --squash", "");
gh("pr384", "gh pr merge 384 --squash", "");
gh("ship2110", "gh release create v2.11.0 --notes-file notes.md", `${repo}/releases/tag/v2.11.0`);
gh("pr379", "gh pr merge 379 --squash", "");
gh("pr376", "gh pr merge 376 --squash", "");
gh("ship2101", "gh release create v2.10.1 --notes-file notes.md", `${repo}/releases/tag/v2.10.1`);
gh("pr375", "gh pr merge 375 --squash", "");
gh("ship2100", "gh release create v2.10.0 --notes-file notes.md", `${repo}/releases/tag/v2.10.0`);
gh("pr370", "gh pr merge 370 --squash", "");

// The Lead's chat: an ask handed to three teammates, then the person asks it to raise @polish.
const home = cap.homeSessionId;
const team = "mcp__realm__realm-team__team_message";
let t = now - 14 * MIN;
init(home, t);
event(home, "user_message", { text: "Let's get the next release ready: check the find bar, run the build and draft the notes.", attachments: [] }, t);
event(home, "assistant_text", { messageId: "seed-a1", text: "I'll split it three ways." }, t += 20_000);
call(home, team, { to: "polish", message: "Check the find bar's focus ring before we ship." }, "Sent to @polish.", t += 4000);
call(home, team, { to: "engines", message: "Run the release build and the full test suite." }, "Sent to @engines.", t += 4000);
call(home, team, { to: "docs", message: "Draft the release notes from the merged pull requests." }, "Sent to @docs.", t += 4000);
event(home, "assistant_text", { messageId: "seed-a2", text: "Asked @polish, @engines and @docs. I'll tell you when the build is green." }, t += 6000);
event(home, "usage", { costUsd: 0, inputTokens: 1200, outputTokens: 160, numTurns: 1 }, t += 500);
t = now - 3 * MIN;
event(home, "user_message", { text: "give polish full access, it keeps asking me about edits", attachments: [] }, t);
call(home, "mcp__realm__realm-team__team_set_access", { to: "polish", mode: "bypassPermissions" },
  "Done: @polish is on Full access now (was Ask each time), chat and task sessions alike. A line in your chat and in its says so, with an Undo for the person.", t += 3000);
// What the server publishes for that call (TeammatesService.noteAccess, #376), in both chats.
const access = { teammateId: mates.polish.id, handle: "polish", by: "captain", from: "default", to: "bypassPermissions", note: "@captain set @polish to Full access, at your request." };
event(home, "access_changed", access, t += 1000);
event(mates.polish.homeSessionId ?? home, "access_changed", access, t);
event(home, "assistant_text", { messageId: "seed-a3", text: "Done. @polish is on Full access now, in its chat and its task sessions." }, t += 3000);
event(home, "usage", { costUsd: 0, inputTokens: 900, outputTokens: 60, numTurns: 1 }, t += 500);
set(home, { activity_at: t });
sql(`UPDATE sessions SET last_event_seq = COALESCE((SELECT MAX(seq) FROM session_events e WHERE e.session_id = sessions.id), 0)`);
sql(`UPDATE sessions SET seen_seq = last_event_seq`);
sql(`UPDATE items SET title = 'Pull requests · GitHub' WHERE id = ${q(browser.itemId)}`);
sql(`DELETE FROM sessions WHERE id = ${q(seed.onboarding)}`);
log("seeded");

// ── Boot 2: the Lead's page, its Computer tab, Team access ──
// The profile was named on the first boot; here the terminals need a shell that runs their command.
app = await boot("early2", { SHELL: path.join(BIN, "shell") });
api = null;
try {
  const { ev, metrics, shot } = makeTools(app);
  await metrics(1440, 900);
  await until(() => ev(`document.querySelectorAll('.sb-teammate').length === 4`), 40_000, "team rows");
  // Live work: one session waits on you, three are working (written while running, as the 2.9.0 shots did).
  for (const k of ["build", "prepare", "changelog"]) set(S[k].id, { status: "running" });
  const payload = { requestId: "seed-land", toolName: "Bash", input: { command: "gh pr merge fix/sidebar-rows --squash" }, title: "Merge fix/sidebar-rows into main? Its checks pass.", suggestions: [] };
  sql(`INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(S.land.id)}, ${now}, 'permission_request', ${q(JSON.stringify(payload))});
    UPDATE sessions SET status = 'waiting_permission', last_event_seq = last_insert_rowid(), seen_seq = last_insert_rowid() WHERE id = ${q(S.land.id)};`);
  set(S.build.id, { status: "running" });
  api = rpc(app.ports.server, await daemonToken(HOME));
  await api.ready;
  const t1 = await api.call("terminals.create", { spaceId: seed.spaceId, cwd: APPDIR, command: "pnpm build" });
  const t2 = await api.call("terminals.create", { spaceId: seed.spaceId, cwd: APPDIR, command: "pnpm dev" });
  await app.page.send("Page.reload", {});
  await until(() => ev(`document.querySelectorAll('.sb-teammate').length === 4`), 40_000, "team rows after reload");
  await metrics(1440, 900);
  await ev(`(() => { const row = [...document.querySelectorAll('.sb-teammate .item-row')].find((el) => (el.getAttribute('aria-label') ?? '').startsWith("Release Captain")); row.click(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.tm-head') && !!document.querySelector('.tm-computer')`), 20_000, "the Lead's page and computer");
  await sleep(1500);
  // What the Lead's sessions hold open: two terminals and a browser tab in a running session's side panel.
  const [space] = await api.call("spaces.list", {});
  const viewKey = `ui.view:${space.profileId}`;
  const view = (await api.call("settings.get", { key: viewKey })).value;
  log("view keys", JSON.stringify(Object.keys(view ?? {})));
  await api.call("settings.set", { key: viewKey, value: { ...view, sidePanes: { ...(view?.sidePanes ?? {}), [S.prepare.itemId]: { tabs: [t1.itemId, t2.itemId, browser.itemId], itemId: t1.itemId } } } });
  await app.page.send("Page.reload", {});
  await until(() => ev(`!!document.querySelector('.tm-head') && !!document.querySelector('.tm-computer')`), 30_000, "the Lead's page after reload");
  await sleep(2500);
  await shot("lead-1440");
  await metrics(1920, 1080);
  await sleep(2500);
  await shot("lead-1920");
  await api.call("settings.set", { key: "ui.sidebarCollapsed", value: true });
  await app.page.send("Page.reload", {});
  await until(() => ev(`!!document.querySelector('.tm-head') && !!document.querySelector('.tm-computer')`), 30_000, "the Lead's page, sidebar hidden");
  await metrics(900, 1000);
  await sleep(3000);
  await shot("lead-900");
  log("state", JSON.stringify(await ev(`({ head: document.querySelector('.tm-headline')?.textContent, access: document.querySelector('.sb-team-access')?.innerText, calls: [...document.querySelectorAll('.teammate-call')].map((e) => e.innerText) })`)));
} catch (e) {
  console.error("FAIL", e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await down(app, api);
  try { execSync("pkill -f 'sleep 3617' || true"); } catch { /* none */ }
}
