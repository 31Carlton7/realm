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
 *
 * Ports: LIVE_CDP_PORT (9232) and LIVE_SERVER_PORT (8792); refuses to run if either is taken.
 * Pictures land in LIVE_SHOT_DIR (a persistent folder, not /tmp). Touches only its scratch home and
 * kills only what it started — the server is a second Electron, so it is reaped by its port too.
 */
import { execFileSync, spawn } from "node:child_process";
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
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));

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
    electron?.kill("SIGTERM");
    setTimeout(() => {
      electron?.kill("SIGKILL");
      reapPort(SERVER_PORT); reapPort(CDP_PORT);
      fs.rmSync(scratch, { recursive: true, force: true });
      process.exit(process.exitCode ?? 0);
    }, 1500);
  });
