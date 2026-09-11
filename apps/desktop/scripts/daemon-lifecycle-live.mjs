/**
 * Live check for the daemon's whole point (run with: node apps/desktop/scripts/daemon-lifecycle-live.mjs)
 *
 * The claim under test is the one nothing in the unit suite can make: that realm-server outlives the
 * app, keeps working while no Realm is running at all, and is found again by the next launch rather
 * than replaced. Every piece of that has unit coverage over injected fakes — `decideLaunch` is a pure
 * table, the scrollback ring is pure, the state file round-trips in a tempdir — and none of it proves
 * that a real Electron process exiting leaves a real server serving.
 *
 * The app is KILLED rather than quit, deliberately. ⌘Q now means "put the UI away", so an ordinary
 * quit leaves Electron running as a menu-bar resident and would prove nothing about detachment. A
 * SIGKILL is the strongest version of "the app is gone" — no `before-quit`, no cleanup, nothing the
 * daemon could have been told — and it is also what a crash looks like.
 *
 * `REALM_DAEMON=1` because these scripts run the built main directly rather than a packaged app, and
 * daemon mode is packaged-only by default. Everything else about the launch is the shape the other
 * live checks use.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, daemonState, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9347), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8914);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-daemon-live-"));
const HOME = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every process this script started, registered the moment it exists. A child assigned only after
 *  `launchApp` returns is a child that leaks whenever `launchApp` itself fails — which then holds the
 *  CDP port and makes the NEXT run refuse to start. */
const children = [];
/** The daemon's pid, recorded as soon as it is known so the cleanup can reach it even if the run
 *  fails before it gets to `daemon.stop`. */
let daemonPid = null;
/** Every socket opened here. An open WebSocket keeps node's event loop alive, so a run that fails
 *  half way would otherwise hang forever instead of reporting and exiting. */
const sockets = [];
/** A whole-script deadline. Every `until` below has its own, but a hang between them would have
 *  nothing to stop it — and a live check that never returns is one nobody runs twice. */
const OVERALL_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 300_000);

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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  sockets.push(ws);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else events.push(msg);
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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/**
 * Launch Electron on the scratch home with daemon mode on.
 *
 * `settle` is what proves the renderer is up, and it differs between the two launches on purpose. The
 * first one has to get through onboarding to a composer; the second is restoring a space whose layout
 * may hold a terminal, a session or nothing at all, so requiring a composer there would be asserting
 * something this check has no opinion about. What it does assert is that the preload ran with a port
 * and a token — which IS the adoption, seen from the renderer's side.
 */
async function launchApp({ onboard }) {
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
      REALM_HOME: HOME,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: process.env.LIVE_SERVER_ENTRY ?? path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      // Packaged-only by default; this script runs the built main directly.
      REALM_DAEMON: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Swallowed unless asked for: Electron is noisy, and a failing run is exactly when its complaints
  // are the only thing that explains the failure. LIVE_VERBOSE=1 to see them.
  const echo = (buf) => { if (process.env.LIVE_VERBOSE) process.stderr.write(`[electron] ${buf}`); };
  children.push(child);
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
      set.call(input, "Daemon"); input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form").requestSubmit(); return true; })()`);
    await until(() => evalIn(`!!document.querySelector('.composer')`), 30000, "composer");
  } else {
    // The port and token the preload was handed — the adoption, as the renderer sees it.
    await until(() => evalIn(`Number.isFinite(window.realm?.port) && !!window.realm?.token ? window.realm.port : null`), 30000, "a renderer holding the daemon's port");
  }
  return { child, cdp: c };
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  // ---- 1. First launch: the app starts a daemon, and the daemon is a real detached process. ----
  const first = await launchApp({ onboard: true });
  const state1 = await until(() => daemonState(HOME), 20000, "daemon.json");
  daemonPid = state1.pid;
  check("the daemon wrote a state file naming its own pid", alive(state1.pid) && state1.pid !== first.child.pid,
    { daemon: state1.pid, electron: first.child.pid });
  check("the state file is 0600 — it carries the RPC token", (fs.statSync(path.join(HOME, "daemon.json")).mode & 0o777) === 0o600);

  const token = await daemonToken(HOME);
  const api = rpc(state1.port, token);
  await api.ready;
  const info1 = await api.call("system.info", {});
  check("the socket answers with the bootId the file records", info1.bootId === state1.bootId);

  // A session doing real work, and a terminal whose output is the app's one true delta stream.
  const spaces = await until(async () => { const s = await api.call("spaces.list", {}); return s.length ? s : null; }, 20000, "a space");
  const spaceId = spaces[0].id;
  const { session } = await api.call("sessions.create", { spaceId, agentKind: "fake" });
  await api.call("sessions.send", { id: session.id, text: "before the app dies", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: session.id })).some((e) => e.event.type === "usage"), 20000, "first turn");

  const { terminalId } = await api.call("terminals.create", { spaceId, cols: 100, rows: 30 });
  await api.call("terminals.write", { terminalId, data: "echo BEFORE_KILL_7C1\n" });
  await until(async () => (await api.call("terminals.read", { terminalId, cursor: null })).live.includes("BEFORE_KILL_7C1"), 20000, "terminal output");
  // The cursor is taken once the shell has SETTLED, not the instant the marker first appears: a shell
  // echoes the command line and then prints its output, so the same marker legitimately arrives in
  // two chunks and a cursor between them would make "nothing came back twice" a false alarm.
  const before = await until(async () => {
    const a = await api.call("terminals.read", { terminalId, cursor: null });
    await sleep(400);
    const b = await api.call("terminals.read", { terminalId, cursor: null });
    return b.seq === a.seq ? b : null;
  }, 20000, "the shell to stop printing");
  api.close();

  // ---- 2. Kill the app outright. No before-quit, no cleanup — the strongest form of "gone". ----
  first.cdp.close();
  first.child.kill("SIGKILL");
  await until(async () => !alive(first.child.pid), 15000, "electron to die");
  await sleep(1000);
  check("the daemon is still alive with no Realm running", alive(state1.pid));

  // ---- 3. It is still SERVING, and still advancing work. ----
  const headless = rpc(state1.port, token);
  await headless.ready;
  const info2 = await headless.call("system.info", {});
  check("the same daemon still answers (bootId unchanged)", info2.bootId === state1.bootId);
  check("it knows the window went away", typeof info2.detachedSince === "number", info2.detachedSince);

  await headless.call("sessions.send", { id: session.id, text: "while nobody is watching", attachments: [], mentions: [] });
  const advanced = await until(async () => {
    const evs = await headless.call("sessions.events", { id: session.id });
    return evs.filter((e) => e.event.type === "usage").length >= 2 ? evs : null;
  }, 20000, "a turn with no app running");
  check("a session advanced with no Realm running at all", advanced.filter((e) => e.event.type === "usage").length >= 2);

  await headless.call("terminals.write", { terminalId, data: "echo WHILE_AWAY_7C1\n" });
  await until(async () => (await headless.call("terminals.read", { terminalId, cursor: null })).live.includes("WHILE_AWAY_7C1"), 20000, "terminal while away");
  headless.close();

  // ---- 4. Relaunch: the next app ADOPTS rather than starting a second one. ----
  const second = await launchApp({ onboard: false });
  const state2 = daemonState(HOME);
  check("the relaunched app adopted the running daemon", state2.pid === state1.pid && state2.bootId === state1.bootId,
    { was: state1.pid, now: state2.pid });

  // ---- 5. …and reattaching catches up with no gap in seq. ----
  const after = rpc(state2.port, token);
  await after.ready;
  const caught = await after.call("terminals.read", { terminalId, cursor: { runId: before.runId, seq: before.seq } });
  check("the terminal's run is the same one — no respawn", caught.runId === before.runId, { before: before.runId, after: caught.runId });
  check("nothing was dropped between the cursor and now", caught.truncated === false);
  check("the output that arrived while away is exactly what came back", caught.live.includes("WHILE_AWAY_7C1"));
  // The cursor is HONOURED, stated as the property that actually holds: a cursored read is the tail
  // of an uncursored one, and strictly shorter. Asserting that an old marker never reappears would be
  // wrong — reattaching resizes the pty, and a redrawing shell genuinely reprints its own recent
  // lines. What the server must never do is resend chunks the client already had.
  const full = await after.call("terminals.read", { terminalId, cursor: null });
  check("a cursored read is the tail of the whole buffer, and shorter",
    full.live.endsWith(caught.live) && caught.live.length < full.live.length,
    { cursored: caught.live.length, whole: full.live.length });
  check("the seq advanced from the cursor with no hole", caught.seq > before.seq, { from: before.seq, to: caught.seq });

  // ---- 6. daemon.stop leaves nothing behind. ----
  await after.call("daemon.stop", {});
  after.close();
  await until(async () => !alive(state1.pid), 20000, "daemon to stop");
  check("daemon.stop actually stopped it", !alive(state1.pid));
  check("it cleared its state file", daemonState(HOME) === null);
  check("and released the home lock", !fs.existsSync(path.join(HOME, "daemon.lock")));

  second.cdp.close();
  second.child.kill("SIGKILL");
}

Promise.race([
  main(),
  sleep(OVERALL_TIMEOUT_MS).then(() => { throw new Error(`the whole check ran past ${OVERALL_TIMEOUT_MS}ms`); }),
])
  .catch((e) => { process.exitCode = 1; console.error("FAIL", e); })
  .finally(async () => {
    for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
    // Whatever happened above, this script must never leave a daemon running on a temp directory it
    // is about to delete. Both the pid recorded at the start and whatever the file says now, because
    // a handoff mid-run would have replaced one with the other.
    for (const pid of new Set([daemonPid, daemonState(HOME)?.pid].filter(Boolean))) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } }
    await sleep(300);
    // LIVE_KEEP=1 leaves the scratch home behind, which is the only way to read the daemon's own
    // log after a failure — everything it says goes there, not to this script's stdout.
    if (process.env.LIVE_KEEP) console.error(`[live] keeping ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true });
    // Nothing above can be relied on to have released the event loop: Electron's CDP sockets in
    // particular outlive `close()` briefly, and this script must end rather than linger.
    process.exit(process.exitCode ?? 0);
  });
