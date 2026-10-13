/**
 * Live check for an agent using Realm's own tools — first, closing its own goal
 * (run with: node apps/desktop/scripts/realm-self-use-live.mjs, after `pnpm build`).
 *
 * Boots the BUILT app on a scratch REALM_HOME against the SCRIPTED agent (`REALM_ENABLE_FAKE_AGENT`),
 * with this check's scenarios handed in through `REALM_FAKE_SCRIPT`. The scripted agent reaches
 * Realm's tools through the same gateway a real agent's CLI does, so what it lists and calls is what
 * an agent could list and call.
 *
 *   S1  A goal started MID-session — the agent had already connected and listed its tools — is
 *       closed by the agent with `realm-goal__update_goal`, and nothing continues after it. The bug of
 *       2026-10-07: the tools were listed only while a goal ran, so this agent never saw them.
 *   S2  A goal that is the session's first message: `goal_status` answers, `update_goal` closes it.
 *   S3  Continuations that do nothing stop after exactly three, as blocked, with the reason.
 *   S4  With `realm-goal` switched off for the space, the agent ends the goal with a
 *       `GOAL COMPLETE:` line, and the continuation told it to.
 *   S5  The user's Mark done on the strip ends a running goal, and nothing continues after it. The
 *       strip is captured in light and dark.
 *   S6  A browser pane the agent opened is closed from the layout; the agent's next read is refused
 *       with a sentence naming `realm-workspace__pane_show`, the agent calls it, the pane is back in
 *       its session's side pane, and the read succeeds. The #1 failure in the call log (125 times).
 *   S7  `workspace_state` says what is on screen and who the caller is, `sessions_list` lists this
 *       space's sessions and no other's, `session_read` reads a peer's transcript fenced, and a
 *       session in another space is refused.
 *   S8  `session_open` opens a session that answers its prompt ("echo: echo hi") in a pane of its own
 *       beside the caller's, and the saved layout has the split.
 *   S10 `docs_open` opens a 3 MB PNG (13 of 28 failed TOO_LARGE in the log), `docs_state` says it is
 *       the tab showing, and `docs_read` reads a page of a file by line.
 *   S11 `browser_act` presses Meta+a in the fixture's field and the page's selection is all of it;
 *       Shift+Tab takes the focus back a field; a key it cannot press is refused before any card.
 *   S9  From a session that asks before acting: `space_switch` puts a card up, and once allowed the
 *       window is in the other space; a switch while the user is typing is refused and the window
 *       stays; `settings_set` puts a card up and the window turns dark; a setting off the list is
 *       refused with no card. Last, because it moves the window away from the scenes above.
 *
 * Ports: LIVE_CDP_PORT (9232) and LIVE_SERVER_PORT (8792); refuses to run if either is taken.
 * Pictures land in LIVE_SHOT_DIR (a persistent folder, not /tmp). Touches only its scratch home and
 * kills only what it started — the server is a second Electron, so it is reaped by its port too.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9232), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8792);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.homedir(), ".cache/realm-live/self-use");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-self-use-live-"));
fs.mkdirSync(shots, { recursive: true });
let electron = null;
let site = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── The scenarios, as the scripted agent plays them ──────────────────────────────────────────── */
const GOAL_TOOLS = ["realm-goal__update_goal", "realm-goal__goal_status"];
const work = [{ kind: "tool", name: "Read", input: { file_path: "README.md" }, result: "# notes" }, { kind: "tool", name: "Edit", input: { file_path: "README.md" }, result: "ok" }];
const SCRIPT = [
  // S1: a plain turn first, so the agent connects and reads its list before any goal exists.
  { on: "S1 look around", emit: [{ kind: "list", expect: GOAL_TOOLS }] },
  { on: "S1 write the release notes", turn: 2, emit: [
    { kind: "call", tool: "realm-goal__update_goal", input: { status: "complete", note: "S1: the release notes are written and linked from the README." } },
    { kind: "text", text: "Closed the goal." },
  ] },
  { on: "S1 write the release notes", emit: [{ kind: "list", expect: GOAL_TOOLS }, ...work] },
  // S2: the goal is the first thing the session is ever sent.
  { on: "S2 rename the config", turn: 2, emit: [
    { kind: "call", tool: "realm-goal__update_goal", input: { status: "complete", note: "S2: renamed, and the loader reads the new name." } },
  ] },
  { on: "S2 rename the config", emit: [{ kind: "list", expect: GOAL_TOOLS }, { kind: "call", tool: "realm-goal__goal_status", input: {} }, ...work] },
  // S3: every turn says nothing has changed.
  { on: "S3 wait for the deploy", emit: [{ kind: "idle" }] },
  // S4: no goal tools in this space, so the reply line is the only way to finish.
  { on: "S4 finish the changelog", turn: 2, emit: [{ kind: "text", text: "Added the last two entries.\nGOAL COMPLETE: S4: the changelog covers every merged PR." }] },
  { on: "S4 finish the changelog", emit: [{ kind: "list", expect: GOAL_TOOLS }, ...work] },
  // S5: busy, paced turns that never finish on their own.
  { on: "S5 keep polishing the copy", emit: [...work, { kind: "text", paceMs: 40, text: "Tightened two more paragraphs and checked the build again." }] },
];
/** S6 and S7 call tools with ids learned at run time: the message ends with them (`argsFromMessage`). */
const WORKSPACE_TOOLS = ["realm-workspace__workspace_state", "realm-workspace__pane_show", "realm-workspace__sessions_list", "realm-workspace__session_read"];
const workspaceScript = (fixtureUrl) => [
  { on: "S6 open the fixture", emit: [{ kind: "call", tool: "realm-browser__browser_open", input: { url: fixtureUrl } }] },
  { on: "S6 read the page", emit: [{ kind: "call", tool: "realm-browser__browser_read", input: { kind: "text" }, argsFromMessage: true }] },
  { on: "S6 show it again", emit: [{ kind: "call", tool: "realm-workspace__pane_show", input: {}, argsFromMessage: true }] },
  { on: "S7 look at the workspace", emit: [
    { kind: "list", expect: WORKSPACE_TOOLS },
    { kind: "call", tool: "realm-workspace__workspace_state", input: {} },
    { kind: "call", tool: "realm-workspace__sessions_list", input: {} },
  ] },
  { on: "S7 read a session", emit: [{ kind: "call", tool: "realm-workspace__session_read", input: {}, argsFromMessage: true }] },
  { on: "S8 open a session beside me", emit: [{ kind: "call", tool: "realm-workspace__session_open", input: { prompt: "echo hi", beside: "right" } }] },
  { on: "S10 open the photo", emit: [{ kind: "call", tool: "realm-docs__docs_open", input: { path: "photo.png" } }] },
  { on: "S10 what is open", emit: [{ kind: "call", tool: "realm-docs__docs_state", input: {} }] },
  { on: "S10 read the notes", emit: [{ kind: "call", tool: "realm-docs__docs_read", input: { path: "notes.md", offset: 2, limit: 2 } }] },
  { on: "S11 snapshot", emit: [{ kind: "call", tool: "realm-browser__browser_snapshot", input: {}, argsFromMessage: true }] },
  { on: "S11 press", emit: [{ kind: "call", tool: "realm-browser__browser_act", input: {}, argsFromMessage: true }] },
  { on: "S9 switch space", emit: [{ kind: "call", tool: "realm-workspace__space_switch", input: {}, argsFromMessage: true }] },
  { on: "S9 go dark", emit: [{ kind: "call", tool: "realm-workspace__settings_set", input: { name: "theme", value: "dark" } }] },
  { on: "S9 widen my reach", emit: [{ kind: "call", tool: "realm-workspace__settings_set", input: { name: "mcp.providersEnabled", value: "on" } }] },
];

async function portFree(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(200);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const HELPERS = `
window.__live = window.__live ?? {
  type(value) {
    const el = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new Event("select", { bubbles: true }));
    return true;
  },
  enter() {
    document.querySelector('.composer-input').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  },
  strip() {
    const el = document.querySelector(".composer-goal");
    if (!el) return null;
    return {
      status: el.dataset.status,
      label: el.querySelector(".composer-goal-label")?.textContent ?? null,
      note: el.querySelector(".composer-goal-note")?.textContent ?? null,
      buttons: [...el.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    };
  },
  markDone() {
    const b = document.querySelector('.composer-goal button[aria-label="Mark this goal done"]');
    if (!b) return false;
    b.click();
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Light or dark, the way a person switches it: the command palette. */
async function setTheme(c, mode) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${JSON.stringify(label)});
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${JSON.stringify(mode)}`), 4000, `mode ${mode}`);
  await sleep(300);
}

/** The whole window, at 2×. */
async function shoot(c, name) {
  await sleep(300);
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${name} ${file}`);
}

/** The goal strip with the prompter under it, at 2×, with the pointer over the strip — its actions
 *  show on hover, as a row's own controls do. */
async function shootStrip(c, name) {
  const at = await evalIn(c, `(() => { const r = document.querySelector(".composer-goal-head")?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  if (at) await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(250);
  const box = await evalIn(c, `(() => {
    const strip = document.querySelector(".composer-goal"); const box = document.querySelector(".composer");
    if (!strip) return null;
    const a = strip.getBoundingClientRect(), b = (box ?? strip).getBoundingClientRect();
    const x0 = Math.min(a.left, b.left) - 16, y0 = a.top - 16, x1 = Math.max(a.right, b.right) + 16, y1 = Math.max(a.bottom, b.bottom) + 16;
    return { x: Math.max(0, x0), y: Math.max(0, y0), width: x1 - Math.max(0, x0), height: y1 - Math.max(0, y0) };
  })()`);
  if (!box) throw new Error("no goal strip to capture");
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${name} ${file}`);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  // S6's page: a local site, so nothing leaves the Mac.
  site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>S6 fixture</title><h1>S6 fixture page</h1><p>Read me after the pane comes back.</p><input id=first aria-label=First value=first><input id=field aria-label=Field value=\"select all of me\">"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const fixtureUrl = `http://127.0.0.1:${site.address().port}/`;
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify([...SCRIPT, ...workspaceScript(fixtureUrl)]));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  // Behind the user's window the renderer would go quiet; a focused window is what the strip is drawn for.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1320, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session to drive");
  const sid = first.id, spaceId = first.spaceId;
  // The scripted agent, or every turn below would be a billed call to a real engine.
  await api.call("sessions.setAgent", { id: sid, agentKind: "fake" });
  await sleep(300);

  const events = (id) => api.call("sessions.events", { id, afterSeq: 0, limit: 2000 });
  const texts = async (id) => (await events(id)).filter((e) => e.event.type === "assistant_text").map((e) => e.event.payload.text);
  const continuations = async (id) => (await events(id)).filter((e) => e.event.type === "user_message" && e.event.payload.goal === "continuation");
  const goalOf = async (id) => (await api.call("goals.get", { sessionId: id })).goal;
  const idle = (id) => until(async () => (await api.call("sessions.get", { id })).status === "idle", 15000, `${id} idle`);
  const fresh = async (title) => (await api.call("sessions.create", { spaceId, agentKind: "fake", title })).session.id;

  // ── S1: a goal started after the agent connected ─────────────────────────────────────────────
  await api.call("sessions.send", { id: sid, text: "S1 look around" });
  const before = await until(async () => (await texts(sid)).find((t) => t.startsWith("tools/list")), 15000, "S1 first list");
  check("S1 an agent with no goal running already lists the goal tools", before.includes("missing: none"), before.split("\n").at(-1));
  await idle(sid);
  await evalIn(c, `__live.type("/goal S1 write the release notes")`);
  await evalIn(c, `__live.enter()`);
  const s1 = await until(async () => { const g = await goalOf(sid); return g && g.status !== "active" ? g : null; }, 20000, "S1 to finish");
  check("S1 the agent closed the goal with realm-goal__update_goal", s1.status === "complete" && s1.note === "S1: the release notes are written and linked from the README.", s1);
  const lists = (await texts(sid)).filter((t) => t.startsWith("tools/list"));
  check("S1 starting the goal told the running agent its tools changed", /list_changed: [1-9]/.test(lists[1] ?? ""), lists[1]?.split("\n").slice(1));
  const call = (await events(sid)).find((e) => e.event.type === "tool_call" && e.event.payload.name.endsWith("realm-goal__update_goal"));
  const result = (await events(sid)).find((e) => e.event.type === "tool_result" && e.event.payload.toolUseId === call?.event.payload.toolUseId);
  check("S1 update_goal answered without an error", result && result.event.payload.isError === false, result?.event.payload.content);
  const cont = (await continuations(sid))[0]?.event.payload.text ?? "";
  check("S1 the continuation named the tool as the agent lists it", cont.includes("`realm-goal__update_goal`"), cont.split("\n\n").at(-1)?.slice(0, 120));
  await until(async () => (await evalIn(c, `__live.strip()`))?.label === "Done", 8000, "S1 strip Done");
  const s1Strip = await evalIn(c, `__live.strip()`);
  check("S1 the strip says Done with the agent's note", s1Strip.note === s1.note, s1Strip);
  const s1Count = (await continuations(sid)).length;
  await sleep(5000);
  check("S1 nothing continued after the goal closed", (await continuations(sid)).length === s1Count && s1Count === 1, { s1Count });

  // ── S2: the goal is the session's first message ──────────────────────────────────────────────
  const s2id = await fresh("S2");
  await api.call("goals.start", { sessionId: s2id, objective: "S2 rename the config", tokenBudget: null });
  const s2 = await until(async () => { const g = await goalOf(s2id); return g && g.status !== "active" ? g : null; }, 20000, "S2 to finish");
  check("S2 a first-message goal closes the same way", s2.status === "complete" && s2.note.startsWith("S2:"), s2);
  const status = (await events(s2id)).find((e) => e.event.type === "tool_result" && /Objective:/.test(e.event.payload.content ?? ""));
  check("S2 goal_status names the objective", status?.event.payload.content.includes("Objective: S2 rename the config"), status?.event.payload.content);

  // ── S3: turns that do nothing ────────────────────────────────────────────────────────────────
  const s3id = await fresh("S3");
  await api.call("goals.start", { sessionId: s3id, objective: "S3 wait for the deploy", tokenBudget: null });
  const s3 = await until(async () => { const g = await goalOf(s3id); return g && g.status !== "active" ? g : null; }, 20000, "S3 to stop");
  const s3Count = (await continuations(s3id)).length;
  check("S3 three no-progress continuations block the goal, with the reason", s3.status === "blocked" && s3.note === "3 turns in a row made no progress, so Realm stopped continuing this goal." && s3Count === 3, { status: s3.status, note: s3.note, continuations: s3Count });
  await sleep(4000);
  const s3After = await goalOf(s3id);
  check("S3 the turn count stops there", s3After.turns === s3.turns && (await continuations(s3id)).length === 3, { turns: s3After.turns });

  // ── S4: no goal tools in the space ───────────────────────────────────────────────────────────
  await api.call("mcp.setProviderEnabled", { spaceId, name: "realm-goal", enabled: false });
  const s4id = await fresh("S4");
  await api.call("goals.start", { sessionId: s4id, objective: "S4 finish the changelog", tokenBudget: null });
  const s4 = await until(async () => { const g = await goalOf(s4id); return g && g.status !== "active" ? g : null; }, 20000, "S4 to finish");
  const s4List = (await texts(s4id)).find((t) => t.startsWith("tools/list")) ?? "";
  check("S4 the switched-off space lists no goal tools", s4List.includes("missing: realm-goal__update_goal, realm-goal__goal_status"), s4List.split("\n").at(-1));
  const s4Cont = (await continuations(s4id))[0]?.event.payload.text ?? "";
  check("S4 the continuation taught the reply line instead of the tool", s4Cont.includes("GOAL COMPLETE: <") && !s4Cont.includes("update_goal`"));
  check("S4 a GOAL COMPLETE: line ends the goal", s4.status === "complete" && s4.note === "S4: the changelog covers every merged PR.", s4);
  await api.call("mcp.setProviderEnabled", { spaceId, name: "realm-goal", enabled: true });

  // ── S5: the user marks it done ───────────────────────────────────────────────────────────────
  await idle(sid);
  await evalIn(c, `__live.type("/goal S5 keep polishing the copy")`);
  await evalIn(c, `__live.enter()`);
  await until(async () => { const g = await goalOf(sid); return g?.objective === "S5 keep polishing the copy" && g.turns >= 2 ? g : null; }, 30000, "S5 two turns");
  const running = await evalIn(c, `__live.strip()`);
  check("S5 a running goal offers Mark done beside Pause and Drop", running?.label === "Pursuing" && running.buttons.includes("Mark this goal done"), running?.buttons);
  await setTheme(c, "light");
  await shootStrip(c, "goal-strip-mark-done-light");
  await setTheme(c, "dark");
  await shootStrip(c, "goal-strip-mark-done-dark");
  check("S5 Mark done is a button on the strip", await evalIn(c, `__live.markDone()`));
  await until(async () => (await evalIn(c, `__live.strip()`))?.label === "Done", 8000, "S5 strip Done");
  const s5 = await goalOf(sid);
  check("S5 the goal is complete, marked done by the user", s5.status === "complete" && s5.note === "Marked done by you.", s5);
  const s5Count = (await continuations(sid)).length;
  await sleep(5000);
  check("S5 nothing continued after Mark done", (await continuations(sid)).length === s5Count, { s5Count, after: (await continuations(sid)).length });
  await shootStrip(c, "goal-strip-done-dark");
  await setTheme(c, "light");
  await shootStrip(c, "goal-strip-done-light");

  // ── S6: a closed browser pane, brought back by the agent ─────────────────────────────────────
  await idle(sid);
  // browser_open asks first; this session's user has said yes to everything.
  await api.call("sessions.setOptions", { id: sid, permissionMode: "bypassPermissions" });
  const results = async (id, tool) => {
    const evs = await events(id);
    return evs.filter((e) => e.event.type === "tool_call" && e.event.payload.name === `mcp__realm__${tool}`)
      .map((call) => evs.find((e) => e.event.type === "tool_result" && e.event.payload.toolUseId === call.event.payload.toolUseId)?.event.payload)
      .filter(Boolean);
  };
  const turn = async (text, tool) => {
    const before = (await results(sid, tool)).length;
    await api.call("sessions.send", { id: sid, text });
    return until(async () => { const all = await results(sid, tool); return all.length > before ? all.at(-1) : null; }, 20000, text);
  };
  const opened = await turn("S6 open the fixture", "realm-browser__browser_open");
  const browserId = /Opened browser pane (\S+) at/.exec(opened.content)?.[1];
  check("S6 the agent opened a browser pane", !opened.isError && !!browserId, opened.content);
  const browserItem = (await api.call("items.list", { spaceId })).find((i) => i.kind === "browser" && i.refId === browserId);
  const myTitle = (await api.call("sessions.get", { id: sid })).title;
  /* The browser's tab in the side panel, and whose side panel it is: the one in the same panel group
     as the session pane titled `owner` (side-tools.mjs's reading of the layout). */
  const tabOf = (title, owner = "") => evalIn(c, `(() => {
    const tab = [...document.querySelectorAll('.panehost .panel[data-tabbed] .pane-tab')].find((t) => t.querySelector('.pane-tab-title')?.textContent === ${JSON.stringify(title)});
    if (!tab) return null;
    const group = (el) => el?.parentElement?.closest('[data-panel-group]') ?? null;
    const side = tab.closest('.panel');
    const pane = [...document.querySelectorAll('.panehost .panel:not([data-tabbed])')].find((p) => p.querySelector(':scope > .panel-bar .panel-title')?.textContent === ${JSON.stringify(owner)});
    return { active: tab.hasAttribute('data-active'), besideOwner: !!pane && group(pane) === group(side) };
  })()`);
  const titleNow = async () => (await api.call("items.list", { spaceId })).find((i) => i.id === browserItem.id).title;
  await until(async () => tabOf(await titleNow()), 15000, "S6 the browser's tab");
  const firstRead = await until(async () => { await idle(sid); const r = await turn(`S6 read the page {"browserId": "${browserId}"}`, "realm-browser__browser_read"); return r.isError || !r.content.includes("S6 fixture page") ? null : r; }, 20000, "S6 the first read");
  check("S6 the agent reads the page it opened", firstRead.content.includes("S6 fixture page"));

  // Closed from the layout the way the user closes a tab: the keyboard in the side panel, then ⌘W.
  await evalIn(c, `(() => { document.querySelector('.panehost .panel[data-tabbed]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.activeElement?.blur?.(); return true; })()`);
  for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, modifiers: 4, key: "w", code: "KeyW", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await until(async () => !(await tabOf(await titleNow())), 8000, "S6 the tab to close");
  check("S6 the browser's item outlives its pane", (await api.call("items.list", { spaceId })).some((i) => i.id === browserItem.id));
  await idle(sid);
  const refused = await turn(`S6 read the page {"browserId": "${browserId}"}`, "realm-browser__browser_read");
  check("S6 a read of the closed pane is refused, naming pane_show and the id", refused.isError && refused.content.includes(`realm-workspace__pane_show with {"browserId": "${browserId}"}`), refused.content);
  await idle(sid);
  const shown = await turn(`S6 show it again {"browserId": "${browserId}"}`, "realm-workspace__pane_show");
  check("S6 pane_show brings it back and says the tools can drive it", !shown.isError && shown.content.includes("back in your side pane"), shown.content);
  const back = await until(async () => tabOf(await titleNow(), myTitle), 8000, "S6 the tab to come back");
  check("S6 the pane is back as the showing tab of the agent's own session's side panel", back.active && back.besideOwner, back);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const shotFile = path.join(shots, "pane-show-side-panel.png");
  fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT pane-show-side-panel ${shotFile}`);
  await idle(sid);
  const again = await turn(`S6 read the page {"browserId": "${browserId}"}`, "realm-browser__browser_read");
  check("S6 the read succeeds once the pane is back", !again.isError && again.content.includes("S6 fixture page"), again.content.slice(0, 160));

  // ── S7: the workspace and its sessions, read by the agent ────────────────────────────────────
  const peer = await fresh("S7 peer");
  await api.call("sessions.send", { id: peer, text: "hello from the peer" });
  await until(async () => (await texts(peer)).includes("echo: hello from the peer"), 15000, "S7 the peer's reply");
  const { profileId } = (await api.call("spaces.list", {})).find((sp) => sp.id === spaceId);
  const elsewhere = await api.call("spaces.create", { profileId, name: "S7 elsewhere" });
  const away = (await api.call("sessions.create", { spaceId: elsewhere.id, agentKind: "fake", title: "S7 away" })).session.id;
  await api.call("sessions.send", { id: away, text: "private words in another space" });
  await until(async () => (await texts(away)).length > 0, 15000, "S7 the other space's reply");
  await idle(sid);
  const state = await turn("S7 look at the workspace", "realm-workspace__workspace_state");
  const listed = (await texts(sid)).filter((t) => t.startsWith("tools/list")).at(-1) ?? "";
  check("S7 the agent lists the realm-workspace tools", listed.includes("missing: none"), listed.split("\n").at(-1));
  check("S7 workspace_state names the caller and the window", state.content.includes(`You are session ${sid}`) && state.content.includes("The window is in this space.") && state.content.includes("Your session is on screen."), state.content.split("\n").slice(0, 6));
  check("S7 workspace_state says the browser is on screen and mounted", state.content.includes(`browserId ${browserId} — on screen, the tab showing in the side panel; page mounted`), state.content.split("\n").find((l) => l.includes(browserId ?? "-")));
  check("S7 workspace_state lists the peer and nothing of the other space", state.content.includes(`sessionId ${peer}`) && !state.content.includes(away) && !state.content.includes("S7 away"));
  const sessionsList = (await results(sid, "realm-workspace__sessions_list")).at(-1);
  check("S7 sessions_list lists this space's sessions only, marking the caller", sessionsList.content.includes(peer) && sessionsList.content.includes(`${sid} `) && sessionsList.content.includes("[you]") && !sessionsList.content.includes(away), sessionsList.content.split("\n").slice(0, 4));
  await idle(sid);
  const peerRead = await turn(`S7 read a session {"sessionId": "${peer}"}`, "realm-workspace__session_read");
  check("S7 session_read reads the peer's transcript, fenced", !peerRead.isError && peerRead.content.includes("assistant: echo: hello from the peer") && peerRead.content.includes("ANOTHER SESSION'S TRANSCRIPT"), peerRead.content.slice(0, 200));
  await idle(sid);
  const awayRead = await turn(`S7 read a session {"sessionId": "${away}"}`, "realm-workspace__session_read");
  check("S7 a session in another space is refused, and says where to look instead", awayRead.isError && awayRead.content.includes("belongs to another space") && awayRead.content.includes("sessions_list lists those") && !awayRead.content.includes("private words"), awayRead.content);

  // ── S8: a session opened beside the caller, for the user ─────────────────────────────────────
  await idle(sid);
  const before8 = new Set((await api.call("sessions.list", { spaceId })).map((s) => s.id));
  const opened8 = await turn("S8 open a session beside me", "realm-workspace__session_open");
  check("S8 session_open answers that it opened a session beside the caller", !opened8.isError && opened8.content.includes("in a pane beside yours"), opened8.content);
  const fresh8 = (await api.call("sessions.list", { spaceId })).find((s) => !before8.has(s.id));
  check("S8 the new session is the user's, opened by the caller, not a delegated child", fresh8?.dispatchedBy?.kind === "session_open" && fresh8.dispatchedBy.sessionId === sid, fresh8?.dispatchedBy);
  await until(async () => (await texts(fresh8.id)).includes("echo: echo hi"), 15000, "S8 the new session's answer");
  check("S8 the new session answered its prompt", true);
  const item8 = (await api.call("items.list", { spaceId })).find((i) => i.refId === fresh8.id);
  const myItem = (await api.call("items.list", { spaceId })).find((i) => i.refId === sid);
  const view8 = await until(async () => {
    const v = (await api.call("settings.get", { key: `ui.view:${profileId}` })).value;
    const split = (l) => l?.type === "split" ? (l.dir === "row" && l.children.some((c) => c.itemId === myItem.id) && l.children.some((c) => c.itemId === item8.id) ? l : l.children.map(split).find(Boolean)) : null;
    return split(v?.layout);
  }, 8000, "S8 the saved split");
  check("S8 the saved layout puts the new session side by side with the caller", !!view8, view8 && view8.children.map((c) => c.itemId));
  const pane8 = await until(() => evalIn(c, `[...document.querySelectorAll('.panehost .panel:not([data-tabbed]) .panel-title')].map((t) => t.textContent)`).then((t) => (t.includes(fresh8.title) ? t : null)), 8000, "S8 the pane");
  check("S8 the new session's pane is on screen", pane8.includes(myTitle) && pane8.includes(fresh8.title), pane8);
  await shoot(c, "session-open-beside");

  // ── S10: documents, by the agent ─────────────────────────────────────────────────────────────
  const folder = (await api.call("sessions.get", { id: sid })).cwd;
  fs.writeFileSync(path.join(folder, "photo.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(3 * 1024 * 1024)]));
  fs.writeFileSync(path.join(folder, "notes.md"), "# Notes\nline two\nline three\nline four\n");
  await idle(sid);
  const photo = await turn("S10 open the photo", "realm-docs__docs_open");
  check("S10 docs_open opens a 3 MB PNG", !photo.isError, photo.content);
  await idle(sid);
  const docsState = await turn("S10 what is open", "realm-docs__docs_state");
  check("S10 docs_state says the photo is the tab showing", !docsState.isError && docsState.content.includes("- photo.png (showing)"), docsState.content);
  await idle(sid);
  const notes = await turn("S10 read the notes", "realm-docs__docs_read");
  check("S10 docs_read reads lines 2–3, numbered", !notes.isError && notes.content.includes("notes.md — lines 2–3 of 4:") && notes.content.includes("    2| line two") && notes.content.includes("More: docs_read with offset 4."), notes.content);

  // ── S11: key chords on a page ────────────────────────────────────────────────────────────────
  await idle(sid);
  // The tab back at the front of the side panel, so the page has the focus a keyboard would give it.
  await api.call("sessions.send", { id: sid, text: `S6 show it again {"browserId": "${browserId}"}` });
  await idle(sid);
  const snap = await turn(`S11 snapshot {"browserId": "${browserId}"}`, "realm-browser__browser_snapshot");
  const fieldRef = Number(/textbox "Field"[^\n]*\[ref=(\d+)\]|\[ref=(\d+)\][^\n]*textbox "Field"/.exec(snap.content)?.slice(1).find(Boolean));
  check("S11 the snapshot lists the fixture's field", Number.isFinite(fieldRef), snap.content.split("\n").filter((l) => l.includes("Field")));
  const pageTarget = (await targets()).find((t) => t.url === fixtureUrl);
  const page = cdp(pageTarget.webSocketDebuggerUrl);
  await page.ready;
  const inPage = async (expr) => (await page.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
  await idle(sid);
  const press = (action) => turn(`S11 press {"browserId": "${browserId}", "action": ${JSON.stringify(action)}}`, "realm-browser__browser_act");
  const selectAll = await press({ kind: "key", key: "a", modifiers: ["meta"], ref: fieldRef });
  const selected = await inPage(`(() => { const f = document.getElementById("field"); return { active: document.activeElement?.id, start: f.selectionStart, end: f.selectionEnd, length: f.value.length, value: f.value }; })()`);
  check("S11 Meta+a selects all of the field, and types nothing", !selectAll.isError && selectAll.content.includes("pressed Meta+a") && selected.active === "field" && selected.start === 0 && selected.end === selected.length && selected.value === "select all of me", { result: selectAll.content, selected });
  await idle(sid);
  const shiftTab = await press({ kind: "key", key: "Shift+Tab" });
  const focused = await inPage(`document.activeElement?.id`);
  check("S11 Shift+Tab takes the focus back a field", !shiftTab.isError && focused === "first", { result: shiftTab.content, focused });
  await idle(sid);
  const nonsense = await press({ kind: "key", key: "BrowserBack" });
  check("S11 a key it cannot press is refused, pointing to browser_navigate", nonsense.isError && nonsense.content.includes("use browser_navigate"), nonsense.content);
  page.close();

  // ── S9: moving the window and changing a setting, behind the user's card ─────────────────────
  const asker = await fresh("S9 asker");
  const cardFor = async (id, toolName, before) => until(async () => (await events(id))
    .filter((e) => e.event.type === "permission_request" && e.event.payload.toolName === toolName).slice(before)[0]?.event.payload, 15000, `S9 ${toolName} card`);
  const cards = async (id, toolName) => (await events(id)).filter((e) => e.event.type === "permission_request" && e.event.payload.toolName === toolName).length;
  const turnOn = async (id, text, tool) => {
    const before = (await results(id, tool)).length;
    await api.call("sessions.send", { id, text });
    return () => until(async () => { const all = await results(id, tool); return all.length > before ? all.at(-1) : null; }, 20000, text);
  };
  const panesNow = () => evalIn(c, `[...document.querySelectorAll('.panehost .panel:not([data-tabbed]) .panel-title')].map((t) => t.textContent)`);
  // A switch asked while the user is typing: the card is allowed, and the window stays.
  let n = await cards(asker, "space_switch");
  const typedSwitch = await turnOn(asker, `S9 switch space {"spaceId": "${elsewhere.id}"}`, "realm-workspace__space_switch");
  const card1 = await cardFor(asker, "space_switch", n);
  await evalIn(c, `(() => { const el = document.querySelector('.composer-input'); el.focus(); return true; })()`);
  for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: "x", code: "KeyX", text: type === "keyDown" ? "x" : undefined, windowsVirtualKeyCode: 88 });
  await api.call("sessions.respondPermission", { id: asker, requestId: card1.requestId, decision: "allow" });
  const refused9 = await typedSwitch();
  check("S9 a switch while the user is typing is refused, and the window stays", refused9.isError && refused9.content.includes("the user is typing") && (await api.call("settings.get", { key: "ui.activeSpaceId" })).value === spaceId, refused9.content);
  await evalIn(c, `(() => { document.activeElement?.blur?.(); return __live.type(""); })()`);
  await sleep(4500);
  await idle(asker);
  n = await cards(asker, "space_switch");
  const switched = await turnOn(asker, `S9 switch space {"spaceId": "${elsewhere.id}"}`, "realm-workspace__space_switch");
  const card2 = await cardFor(asker, "space_switch", n);
  check("S9 space_switch put the user's card up first", card2.title === `Move the window to the space "S7 elsewhere"`, card2.title);
  await api.call("sessions.respondPermission", { id: asker, requestId: card2.requestId, decision: "allow" });
  const moved = await switched();
  check("S9 once allowed, the window is in the other space", !moved.isError && moved.content === `The window is in "S7 elsewhere" now.` && (await api.call("settings.get", { key: "ui.activeSpaceId" })).value === elsewhere.id, moved.content);
  const panes9 = await until(async () => { const t = await panesNow(); return t.includes("S7 away") ? t : null; }, 8000, "S9 the other space's session on screen");
  check("S9 the other space's session is what the window shows", panes9.includes("S7 away"), panes9);
  await shoot(c, "space-switch");
  await idle(asker);
  n = await cards(asker, "settings_set");
  const dark = await turnOn(asker, "S9 go dark", "realm-workspace__settings_set");
  const card3 = await cardFor(asker, "settings_set", n);
  check("S9 settings_set put the user's card up first", card3.title === `Change Realm's theme from "light" to "dark"`, card3.title);
  await api.call("sessions.respondPermission", { id: asker, requestId: card3.requestId, decision: "allow" });
  const darkResult = await dark();
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === "dark"`), 5000, "S9 dark mode");
  check("S9 the theme changed, and the window followed without a restart", !darkResult.isError && (await evalIn(c, `document.documentElement.getAttribute("data-mode")`)) === "dark", darkResult.content);
  await shoot(c, "settings-set-dark");
  await idle(asker);
  n = await cards(asker, "settings_set");
  const reach = await (await turnOn(asker, "S9 widen my reach", "realm-workspace__settings_set"))();
  check("S9 a setting off the list is refused, with no card", reach.isError && reach.content.includes("is not a setting you can change") && (await cards(asker, "settings_set")) === n, reach.content);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  api.close();
  c.close();
}

/** The server is a second Electron holding REALM_PORT; killing ours does not always take it along. */
function reapPort(port) {
  try {
    const pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone already */ } }
  } catch { /* nothing listening */ }
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    site?.close();
    electron?.kill("SIGTERM");
    setTimeout(() => {
      electron?.kill("SIGKILL");
      reapPort(SERVER_PORT); reapPort(CDP_PORT);
      fs.rmSync(scratch, { recursive: true, force: true });
      process.exit(process.exitCode ?? 0);
    }, 1500);
  });
