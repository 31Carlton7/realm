/**
 * Live check for the handoff gate (run with: node apps/desktop/scripts/daemon-handoff-live.mjs)
 *
 * The claim: an app that finds a daemon running code it did not ship does not adopt it. With nothing
 * working there is no dialog — the old daemon is stopped and a new one started, and the only way to
 * see it happened is that the bootId changed and the old pid is gone.
 *
 * The two "different builds" are two copies of the same server bundle at different paths, which is
 * exactly what `bundleId` is defined to notice: it is size-and-mtime of the entry, so a copy made a
 * moment later is a different bundle by construction. That is the same signal `install-local.mjs`
 * produces when it swaps /Applications out from under a running daemon, and it is the signal without
 * the twenty minutes of packaging.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9348), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8915);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-handoff-live-"));
const HOME = path.join(scratch, "home");
const OVERALL_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 300_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const sockets = [];
const daemonPids = new Set();
/** Put the repo's build artifact back the way it was found. Set once the original mtime is known. */
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
    close: () => ws.close(),
  };
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Launch Electron against a particular server bundle. `entry` is what makes the two runs differ. */
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
      REALM_HOME: HOME,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: entry,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_DAEMON: "1",
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
      set.call(input, "Handoff"); input.dispatchEvent(new Event("input", { bubbles: true }));
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

  const original = path.join(repoRoot, "apps/server/dist/main.js");
  if (!fs.existsSync(original)) throw new Error(`no server bundle at ${original} — run pnpm build`);
  /**
   * The "new build" is the SAME path with a new mtime, which is precisely what `install-local.mjs`
   * leaves behind: it swaps the bundle in place, and `bundleId` is size-and-mtime of the entry.
   *
   * Copying the bundle elsewhere was the first attempt and does not work — `dist/main.js` imports
   * sibling chunks AND resolves its externals (zod, node-pty, the agent SDKs) from a sibling
   * `node_modules`, so a copy in a temp directory is a server that dies on its first import. The
   * daemon's own log said so, in as many words, which is what that log is for.
   */
  const originalTimes = fs.statSync(original);
  restoreMtime = () => fs.utimesSync(original, originalTimes.atime, originalTimes.mtime);

  // ---- 1. A daemon on the first bundle. ----
  const first = await launchApp({ entry: original, onboard: true });
  const state1 = await until(() => daemonState(HOME), 20000, "daemon.json");
  daemonPids.add(state1.pid);
  check("the daemon records the bundle it is running", state1.entry === original && !!state1.bundleId, state1.bundleId);

  // Killed rather than quit, so the daemon is left running with no app — which is exactly the state
  // an update finds.
  first.cdp.close();
  first.child.kill("SIGKILL");
  await until(async () => !alive(first.child.pid), 15000, "electron to die");
  check("the daemon outlived the app that started it", alive(state1.pid));

  // The install happens here: same path, new mtime.
  fs.utimesSync(original, new Date(), new Date());
  check("the bundle on disk is now a different one by Realm's own reckoning",
    `${fs.statSync(original).size}:${Math.trunc(fs.statSync(original).mtimeMs)}` !== state1.bundleId);

  // ---- 2. A launch on the OTHER bundle hands off rather than adopting. ----
  const second = await launchApp({ entry: original, onboard: false });
  const state2 = await until(() => {
    const s = daemonState(HOME);
    return s && s.bootId !== state1.bootId ? s : null;
  }, 40000, "the replacement daemon");
  daemonPids.add(state2.pid);
  // MUTANT: compare versions instead of bundles and this passes while running last week's server —
  // SERVER_VERSION is a hardcoded "0.0.1" that never moves.
  check("the old daemon was stopped", !alive(state1.pid), { old: state1.pid });
  check("a new one is running the bundle this app ships", state2.bundleId !== state1.bundleId, { was: state1.bundleId, now: state2.bundleId });
  check("and it is genuinely a different process", state2.pid !== state1.pid && state2.bootId !== state1.bootId);

  // ---- 3. The app is attached to the NEW one, and it works. ----
  const token = await daemonToken(HOME);
  const api = rpc(state2.port, token);
  await api.ready;
  const info = await api.call("system.info", {});
  check("the app is talking to the replacement", info.bootId === state2.bootId);
  const spaces = await until(async () => { const s = await api.call("spaces.list", {}); return s.length ? s : null; }, 20000, "a space");
  const { session } = await api.call("sessions.create", { spaceId: spaces[0].id, agentKind: "fake" });
  await api.call("sessions.send", { id: session.id, text: "after the handoff", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: session.id })).some((e) => e.event.type === "usage"), 20000, "a turn on the new daemon");
  check("work runs on the daemon that replaced it", true);

  await api.call("daemon.stop", {});
  api.close();
  await until(async () => !alive(state2.pid), 20000, "daemon to stop");
  check("and it stops cleanly", !alive(state2.pid) && daemonState(HOME) === null);

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
    const left = daemonState(HOME); if (left) daemonPids.add(left.pid);
    for (const pid of daemonPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } }
    await sleep(300);
    // LIVE_KEEP=1 leaves the scratch home behind, which is the only way to read the daemon's own
    // log after a failure — everything it says goes there, not to this script's stdout.
    if (process.env.LIVE_KEEP) console.error(`[live] keeping ${scratch}`);
    else fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
