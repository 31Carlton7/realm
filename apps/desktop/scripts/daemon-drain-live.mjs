/**
 * Live check for the drain handoff (run with: node apps/desktop/scripts/daemon-drain-live.mjs)
 *
 * `daemon-handoff-live.mjs` proves the DEFAULT handoff: stop the old server, start the new one. This
 * proves the other one, behind `daemon.handoffMode = "drain"` — the old server is asked to go quiet
 * and close itself, and the app waits for it rather than killing it.
 *
 * The distinction the check has to make is between those two outcomes, because both end with the old
 * pid gone and a new daemon up. It makes it by the CLOCK: a drain that works closes within seconds of
 * quiescence, and one that does not is stopped by the SIGTERM fallback two minutes later. So the
 * check times it, and asserts the old daemon went away long before the fallback could have fired.
 *
 * It also asserts the refusals while draining, over the socket, on the real server — a draining
 * daemon that still accepts `sessions.create` would exec an agent from a bundle that is being
 * replaced underneath it.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, daemonState, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9349), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8916);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-drain-live-"));
const HOME = path.join(scratch, "home");
const OVERALL_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 300_000);
/** `DRAIN_WAIT_MS` in main/index.ts — what the SIGTERM fallback waits before giving up on a drain.
 *  A drain that genuinely worked must land far inside this. */
const DRAIN_FALLBACK_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const sockets = [];
const daemonPids = new Set();
let restoreMtime = null;

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
    await sleep(150);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
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
  sockets.push(ws);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
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
    /** Like `call`, but hands back the error code instead of throwing — for the refusals. */
    code: (method, params) => new Promise((res) => {
      const i = String(++id);
      pending.set(i, (msg) => res(msg.ok ? null : msg.error?.code));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function launchApp({ entry, onboard }) {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  const child = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: HOME, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: entry, REALM_ENABLE_FAKE_AGENT: "1", REALM_DAEMON: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const echo = (buf) => { if (process.env.LIVE_VERBOSE) process.stderr.write(`[electron] ${buf}`); };
  child.stderr.on("data", echo); child.stdout.on("data", echo);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  const evalIn = async (expr) => {
    const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  if (onboard) {
    await until(() => evalIn(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
    await evalIn(`(() => {
      const input = document.querySelector('.onboarding input:not([type=radio])');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(input, "Drain"); input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form").requestSubmit(); return true; })()`);
    await until(() => evalIn(`!!document.querySelector('.composer')`), 30000, "composer");
  } else {
    await until(() => evalIn(`Number.isFinite(window.realm?.port) && !!window.realm?.token ? window.realm.port : null`), 30000, "a renderer holding a port");
  }
  return { child, cdp: c };
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const entry = path.join(repoRoot, "apps/server/dist/main.js");
  if (!fs.existsSync(entry)) throw new Error(`no server bundle at ${entry} — run pnpm build`);
  const times = fs.statSync(entry);
  restoreMtime = () => fs.utimesSync(entry, times.atime, times.mtime);

  // ---- 1. A daemon, set to drain, with a session that has actually been used. ----
  const first = await launchApp({ entry, onboard: true });
  const state1 = await until(() => daemonState(HOME), 20000, "daemon.json");
  daemonPids.add(state1.pid);
  const token = await daemonToken(HOME);
  const api = rpc(state1.port, token);
  await api.ready;
  await api.call("settings.set", { key: "daemon.handoffMode", value: "drain" });

  const spaces = await until(async () => { const s = await api.call("spaces.list", {}); return s.length ? s : null; }, 20000, "a space");
  const { session } = await api.call("sessions.create", { spaceId: spaces[0].id, agentKind: "fake" });
  await api.call("sessions.send", { id: session.id, text: "a turn that finishes", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: session.id })).some((e) => e.event.type === "usage"), 20000, "the turn to settle");

  // The state a drain actually meets: the turn is over, nothing is working, and the session still
  // holds a warm adapter handle — Realm keeps one until the adapter's stream ends.
  const settled = await api.call("daemon.info", {});
  check("the turn finished — nothing is working", settled.working === 0 && settled.activeRuns === 0, settled);
  check("…and the session still holds a warm handle", settled.liveHandles > 0, { liveHandles: settled.liveHandles });
  api.close();

  first.cdp.close();
  first.child.kill("SIGKILL");
  await until(async () => !alive(first.child.pid), 15000, "electron to die");

  // ---- 2. The update: same path, new mtime. ----
  fs.utimesSync(entry, new Date(), new Date());

  // ---- 3. Relaunch. The drain should take it, and the old daemon should close ITSELF. ----
  const t0 = Date.now();
  const draining = rpc(state1.port, token);
  await draining.ready;
  const secondPromise = launchApp({ entry, onboard: false });

  await until(async () => {
    const s = daemonState(HOME);
    return s && s.pid === state1.pid && s.state === "draining";
  }, 40000, "the old daemon to say it is draining");
  check("the old daemon announced the drain in its state file", true);

  // The refusals, on the real draining server.
  check("a draining daemon refuses to start a session",
    (await draining.code("sessions.create", { spaceId: spaces[0].id, agentKind: "fake" })) === "DAEMON_DRAINING");
  check("…and refuses to start a task",
    (await draining.code("runs.create", { spaceId: spaces[0].id, goal: "do a thing", title: "T" })) === "DAEMON_DRAINING");
  // The refusal that actually prevents the crash. A session that still HOLDS a handle may carry on —
  // the child has exec'd, and its inode survives the bundle being replaced. One that does not would
  // have to exec a new agent from a path that is being swapped out, so it is refused.
  await draining.call("daemon.stopAgents", {});
  check("…and refuses to wake a session whose handle is gone",
    (await draining.code("sessions.send", { id: session.id, text: "wake up", attachments: [], mentions: [] })) === "DAEMON_DRAINING");
  draining.close();

  await until(async () => !alive(state1.pid), DRAIN_FALLBACK_MS + 30_000, "the old daemon to close");
  const took = Date.now() - t0;
  // The distinction that matters: a drain that worked closes shortly after quiescence; one that did
  // not is killed by the SIGTERM fallback two minutes later.
  check("the old daemon closed ITSELF rather than being stopped by the fallback", took < DRAIN_FALLBACK_MS / 2, { tookMs: took });

  const second = await secondPromise;
  const state2 = await until(() => {
    const s = daemonState(HOME);
    return s && s.bootId !== state1.bootId && s.state === "running" ? s : null;
  }, 60000, "the replacement daemon");
  daemonPids.add(state2.pid);
  check("a replacement is up on the new bundle", state2.bundleId !== state1.bundleId, { was: state1.bundleId, now: state2.bundleId });

  // ---- 4. …and the session that was on the old one still works. ----
  const after = rpc(state2.port, await daemonToken(HOME));
  await after.ready;
  await after.call("sessions.send", { id: session.id, text: "after the drain", attachments: [], mentions: [] });
  await until(async () => (await after.call("sessions.events", { id: session.id })).filter((e) => e.event.type === "usage").length >= 2, 20000, "a turn on the replacement");
  check("the session carried across and runs on the replacement", true);

  await after.call("daemon.stop", {});
  after.close();
  await until(async () => !alive(state2.pid), 20000, "daemon to stop");
  check("and it stops cleanly", daemonState(HOME) === null);

  second.cdp.close();
  second.child.kill("SIGKILL");
}

Promise.race([
  main(),
  sleep(OVERALL_TIMEOUT_MS).then(() => { throw new Error(`the whole check ran past ${OVERALL_TIMEOUT_MS}ms`); }),
])
  .catch((e) => { process.exitCode = 1; console.error("FAIL", e); })
  .finally(async () => {
    try { restoreMtime?.(); } catch { /* the artifact is rebuilt by `pnpm build` anyway */ }
    for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
    await stopDaemons(HOME, [...daemonPids]);
    for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } }
    await sleep(300);
    if (process.env.LIVE_KEEP) console.error(`[live] keeping ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
