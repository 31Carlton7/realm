/**
 * Live check for Teams v2's server: teammates you message, and teammates that message each other
 * (run with: pnpm --filter @realm/server build && node apps/desktop/scripts/teammates-v2-live.mjs)
 *
 * Boots the BUILT realm-server (`apps/server/dist/main.js`) on a scratch home, under Electron's own
 * binary in node mode as the app runs it, with the scripted agent only — no window, because nothing
 * here is drawn. Over the RPC socket it proves what the unit suite proves against `createApp`, but on
 * the bundle that ships:
 *   1. `teammates.create` makes a teammate with its chat: a session tagged as its home.
 *   2. `teammates.message` is a turn in that chat, and the scripted agent answers it.
 *   3. `team_message`, called by one teammate's agent through Realm's gateway, lands in the other's
 *      chat marked as from the sender; with `wait` the sender's call returns the other's reply.
 *   4. `agent_start` from a teammate's chat makes a task session that carries the teammate, leads its
 *      title with the handle, runs in the teammate's mode, and is listed by `teammates.sessions`.
 *   5. A teammate's clock, set with `teammates.update` and fired with `schedules.runNow`, is a turn in
 *      its chat marked as the clock's, in the teammate's mode, unread, with no pane opened.
 *   6. Every change is announced as `teammates.changed`.
 *
 * Ports: REALM_PORT 8791 (env LIVE_SERVER_PORT). Writes only into its scratch folder and a report
 * beside the stream's other notes. Stops the daemon with `daemon.stop`, then SIGKILLs whatever is left
 * on its own scratch home.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonState, daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8791);
/** The stream's own folder beside the worktrees, as the other Plan 31 checks keep theirs. */
const verify = path.join(repoRoot, "../.verify/nov02/T1-teams-server");
fs.mkdirSync(verify, { recursive: true });
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? verify, "realm-teammates-v2-live-"));
const home = path.join(scratch, "home");
const report = process.env.LIVE_REPORT ?? path.join(verify, "teammates-v2-live.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let server = null;

/** What the scripted agent does with each message. Its `call` steps go through Realm's real gateway. */
const SCRIPT = [
  { on: "hello there", emit: [{ kind: "text", text: "Hi, I am on it." }] },
  { on: "tell design", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "@design", message: "the icon needs a second colour" } }, { kind: "text", text: "Told design." }] },
  { on: "ask design", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "design", message: "which colour is the icon?", wait: true } }, { kind: "text", text: "Design answered." }] },
  { on: "which colour is the icon?", emit: [{ kind: "text", text: "Violet, on graphite." }] },
  { on: "second colour", emit: [{ kind: "text", text: "Noted." }] },
  { on: "Do your scheduled work.", emit: [{ kind: "text", text: "Nothing is due today." }] },
  // The child is named onto the scripted agent too: one left to `agent_start`'s own choice falls back
  // to Claude, because the scripted agent takes no skills, and that is a real, billed turn.
  { on: "start a task", emit: [{ kind: "call", tool: "realm-agent__agent_start", input: { goal: "Move search to SQLite", title: "sqlite search", constraints: { agentKind: "fake" } } }, { kind: "text", text: "Started it." }] },
  { on: "Move search to SQLite", emit: [{ kind: "text", text: "Moved." }] },
];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

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
    await sleep(100);
  }
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) events.push(msg);
  });
  return {
    ready, events,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** Electron's own binary, which runs the server bundle in node mode as the app does. */
function electronBin() {
  const pnpmDir = path.join(repoRoot, "node_modules/.pnpm");
  const dir = fs.readdirSync(pnpmDir).find((d) => /^electron@\d/.test(d));
  if (!dir) throw new Error("no electron in node_modules/.pnpm — run pnpm install");
  return path.join(pnpmDir, dir, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
}

async function main() {
  if (!(await portFree(SERVER_PORT))) throw new Error(`port ${SERVER_PORT} is in use — refusing to run`);
  const entry = path.join(repoRoot, "apps/server/dist/main.js");
  if (!fs.existsSync(entry)) throw new Error(`${entry} is missing — build the server first`);
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  fs.mkdirSync(home, { recursive: true });
  server = spawn(electronBin(), [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_SCRIPT: scriptFile,
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "server.log"));
  server.stdout.pipe(log); server.stderr.pipe(log);

  const api = rpc(SERVER_PORT, await daemonToken(home, { timeoutMs: 60_000 }));
  await api.ready;
  const events = (sessionId) => api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 }).then((r) => r.map((e) => e.event));
  const userMessages = async (sessionId) => (await events(sessionId)).filter((e) => e.type === "user_message").map((e) => e.payload);
  const toolResults = async (sessionId) => (await events(sessionId)).filter((e) => e.type === "tool_result").map((e) => e.payload.content);

  const profile = await api.call("profiles.create", { name: "Live" });
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Realm" });

  // ── 1. A teammate is made with its chat ──
  const cto = await api.call("teammates.create", { spaceId: space.id, name: "CTO", brief: "Owns the architecture.", agentKind: "fake", permissionMode: "acceptEdits", lead: true });
  const design = await api.call("teammates.create", { spaceId: space.id, name: "Design", brief: "Draws the icons.", agentKind: "fake" });
  const home1 = await api.call("sessions.get", { id: cto.homeSessionId });
  check("teammates.create makes a teammate with a handle, an icon and its chat", cto.handle === "cto" && cto.icon?.shape && cto.lead === true && Boolean(cto.homeSessionId),
    { handle: cto.handle, icon: cto.icon, lead: cto.lead, homeSessionId: cto.homeSessionId });
  check("its chat is a session tagged as the teammate's home, titled with its name, in its mode",
    home1.teammateId === cto.id && home1.teammateHome === true && home1.title === "CTO" && home1.permissionMode === "acceptEdits" && home1.agentKind === "fake",
    { teammateId: home1.teammateId, teammateHome: home1.teammateHome, title: home1.title, permissionMode: home1.permissionMode });
  const listed = await api.call("teammates.list", { spaceId: space.id });
  check("teammates.list puts the Lead first", listed.map((t) => t.handle).join(",") === "cto,design", listed.map((t) => t.handle));

  // ── 2. The person's message is a turn in the chat ──
  const sent = await api.call("teammates.message", { id: cto.id, text: "hello there" });
  await until(async () => (await events(sent.sessionId)).some((e) => e.type === "assistant_text"), 20_000, "the CTO's answer");
  const said = (await events(sent.sessionId)).filter((e) => e.type === "assistant_text").map((e) => e.payload.text);
  check("teammates.message is a turn in its home session, and the agent answers", sent.sessionId === cto.homeSessionId && said.includes("Hi, I am on it."), { sessionId: sent.sessionId, said });

  // ── 3. team_message between two teammates ──
  await api.call("teammates.message", { id: cto.id, text: "tell design" });
  const got = await until(async () => (await userMessages(design.homeSessionId)).find((m) => m.text.startsWith("From @cto")), 20_000, "design's message from the CTO");
  check("team_message lands in the other teammate's chat, marked as from the sender",
    got.text === "From @cto: the icon needs a second colour" && got.from?.teammateId === cto.id && got.from?.sessionId === cto.homeSessionId, got);
  await until(async () => (await toolResults(cto.homeSessionId)).length >= 1, 20_000, "the CTO's team_message result");
  await api.call("teammates.message", { id: cto.id, text: "ask design" });
  const answer = await until(async () => (await toolResults(cto.homeSessionId)).find((t) => t.includes("@design answered")), 30_000, "the waited answer");
  check("team_message with wait returns the other teammate's reply", answer.includes("Violet, on graphite."), answer.slice(0, 300));

  // ── 4. A task session carries the teammate and runs in its mode ──
  await api.call("sessions.setOptions", { id: cto.homeSessionId, permissionMode: "default" });
  await api.call("teammates.message", { id: cto.id, text: "start a task" });
  const task = await until(async () => (await api.call("sessions.listAll", {})).find((s) => s.dispatchedBy?.sessionId === cto.homeSessionId), 20_000, "the CTO's task session");
  check("a task session started from the chat carries teammateId, leads with the handle, and runs in the teammate's mode",
    task.teammateId === cto.id && task.teammateHome === false && task.title === "cto - sqlite search" && task.permissionMode === "acceptEdits",
    { teammateId: task.teammateId, title: task.title, permissionMode: task.permissionMode });
  const tasks = await api.call("teammates.sessions", { id: cto.id });
  check("teammates.sessions lists it for the teammate's page", tasks.some((t) => t.id === task.id && t.teammateId === cto.id), tasks);
  const view = await api.call("teammates.get", { id: cto.id });
  check("its row carries the task among its sessions", view.taskSessions.some((t) => t.id === task.id), view.taskSessions);

  // ── 5. A clock writes into the chat ──
  const clocked = await api.call("teammates.update", { id: design.id, permissionMode: "acceptEdits", schedule: { cron: "0 9 * * 1-5" } });
  check("teammates.update sets a clock, shown on the teammate with its next time",
    clocked.schedule?.cron === "0 9 * * 1-5" && clocked.schedule.prompt === "Do your scheduled work." && clocked.schedule.enabled === true && clocked.schedule.nextRunAt > Date.now(),
    clocked.schedule);
  // The person set the chat's chip lower; the clock's turn runs as the teammate does.
  await api.call("sessions.setOptions", { id: design.homeSessionId, permissionMode: "default" });
  // Only what the clock caused: step 4's task session was announced too, as every delegated child is
  // (the window lists one under its lead and opens no pane for it).
  const firedAt = api.events.length;
  await api.call("schedules.runNow", { id: clocked.schedule.id });
  const ticked = await until(async () => (await userMessages(design.homeSessionId)).find((m) => m.scheduled), 20_000, "the clock's turn");
  await until(async () => (await events(design.homeSessionId)).filter((e) => e.type === "assistant_text").some((e) => e.payload.text === "Nothing is due today."), 20_000, "design's answer to its clock");
  check("the clock's prompt is a turn in the teammate's chat, marked as the clock's and not as anyone's message",
    ticked.text.startsWith("Do your scheduled work.") && ticked.scheduled.scheduleId === clocked.schedule.id && ticked.scheduled.task === "Design" && !ticked.from,
    { text: ticked.text.slice(0, 80), scheduled: ticked.scheduled, from: ticked.from });
  const after = await api.call("teammates.get", { id: design.id });
  const chat = await api.call("sessions.get", { id: design.homeSessionId });
  check("it ran in the teammate's mode, landed unread, and recorded the run", chat.permissionMode === "acceptEdits" && after.unread === true && after.schedule.lastRunAt !== null,
    { mode: chat.permissionMode, unread: after.unread, lastRunAt: after.schedule.lastRunAt });
  const sinceFired = api.events.slice(firedAt);
  check("no pane was opened for it, and no session was made for it",
    !sinceFired.some((e) => e.event === "session.agentOpened") && (await api.call("sessions.listAll", {})).filter((s) => s.teammateId === design.id).length === 1,
    sinceFired.filter((e) => e.event === "session.agentOpened"));

  // Nothing in this check may have reached a real engine.
  const engines = [...new Set((await api.call("sessions.listAll", {})).map((s) => s.agentKind))];
  check("every session in the check ran on the scripted agent", engines.length === 1 && engines[0] === "fake", engines);

  // ── 6. Changes are announced ──
  check("teammates.changed was broadcast for the space", api.events.some((e) => e.event === "teammates.changed" && e.payload?.spaceId === space.id),
    api.events.filter((e) => e.event === "teammates.changed").length);

  await api.call("daemon.stop", {}).catch(() => {});
  api.close();
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(`ERROR ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  const pids = [server?.pid, daemonState(home)?.pid];
  await sleep(1500);
  await stopDaemons(home, pids);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, `${JSON.stringify({ at: new Date().toISOString(), scratch, results }, null, 2)}\n`);
  const bad = results.filter((r) => !r.ok).length;
  console.log(`${results.length - bad}/${results.length} passed${failed ? " (stopped early)" : ""}; report: ${report}`);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failed || bad > 0 ? 1 : 0);
}
