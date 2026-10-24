/**
 * Live check: a paired phone finds its Mac again after realm-server is killed (Plan 28)
 * (run with: pnpm build && node apps/desktop/scripts/mobile-respawn-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the server as a daemon (REALM_DAEMON=1) on a port
 * the OS picks, as daemon-reconnect-live.mjs does, and pairs Phase 1's TypeScript test phone with it
 * through a local relay, as needs-you-live.mjs does. Realm Mobile's identity is sealed under the
 * `remote` secret domain, whose key only Electron main holds: a respawned daemon cannot open it until
 * main registers on the new socket and hands the key over again. So:
 *
 *   P1  before: `remote.status` is connected with the phone listed, and the phone's home.get answers;
 *   P2  kill -9 the daemon: the relay tells the phone its Mac went offline;
 *   P3  the supervisor's new daemon (new pid, port and token) is handed the `remote` key by main's
 *       re-register and reaches connected by itself, with the phone still paired;
 *   P4  the relay tells the phone its Mac is back; the phone handshakes again, as the app does on
 *       `online`, and home.get answers from the new daemon.
 *
 * The scripted agent and a mock keychain: nothing is billed, and the login keychain is never read.
 * Ports: LIVE_CDP_PORT (9447) and LIVE_RELAY_PORT (8996); the server's is the OS's pick. Every server
 * killed or stopped is one whose daemon.json is in this scratch home and whose command line runs this
 * worktree's bundle. LIVE_KEEP keeps the scratch directory, Electron's log with it.
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonState, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9447);
const RELAY_PORT = Number(process.env.LIVE_RELAY_PORT ?? 8996);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-mobile-respawn-"));
const HOME = path.join(scratch, "home");
const PHONE = "Respawn iPhone";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;
const seenPids = new Set();
let electron = null;
let rig = null;

const results = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + js(detail) : ""}`);
};

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`);
    await sleep(100);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
      ws.send(js({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) for (const l of [...listeners]) l(msg.event, msg.payload);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.code} ${msg.error?.message}`))));
      ws.send(js({ id: i, method, params }));
    }),
    /** The first `event` the server broadcasts after this is called. */
    next: (event, ms = 30_000) => new Promise((res, rej) => {
      const timer = setTimeout(() => { listeners.delete(l); rej(new Error(`timeout:${event}`)); }, ms);
      const l = (e, p) => { if (e === event) { clearTimeout(timer); listeners.delete(l); res(p); } };
      listeners.add(l);
    }),
    close: () => ws.close(),
  };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** This scratch home's server, and only if its command line runs this worktree's bundle. */
function ourDaemon() {
  const state = daemonState(HOME);
  if (!state) return null;
  let command = "";
  try { command = execFileSync("ps", ["-o", "command=", "-p", String(state.pid)], { encoding: "utf8" }); } catch { return null; }
  if (!command.includes(repoRoot)) throw new Error(`pid ${state.pid} in ${HOME}/daemon.json is not this worktree's server: ${command.trim()}`);
  seenPids.add(state.pid);
  return state;
}

/* ── The phone: Phase 1's TestPhone and local relay, under tsx, driven over stdin ─────────────── */
async function startRig() {
  const file = path.join(scratch, "phone-rig.mts");
  fs.writeFileSync(file, `import { createInterface } from "node:readline";
import { startLocalRelay } from ${js(path.join(repoRoot, "services/relay/src/node.ts"))};
import { TestPhone } from ${js(path.join(repoRoot, "apps/server/src/remote/test-phone.ts"))};
const relay = await startLocalRelay({ port: Number(process.env.RELAY_PORT) });
console.log("relay " + relay.url);
const phone = new TestPhone();
let watching = false;
const handle = async (cmd: string, args: string[]) => {
  if (cmd === "pair") {
    const r = await phone.pair(args[0]!, { name: ${js(PHONE)}, model: "iPhone18,1", timeoutMs: 60_000 });
    console.log(r.ok ? "paired ok" : "paired no " + r.reason);
  }
  if (cmd === "connect") {
    const r = await phone.connect();
    console.log("connected " + JSON.stringify({ mac: r.mac, macOnline: r.macOnline }));
    // What the relay says about the Mac, one line each, with the time the rig read it.
    if (!watching) { watching = true; phone.on("mac", (p) => console.log("mac " + JSON.stringify(p))); }
  }
  if (cmd === "home") {
    const home = await phone.call<Record<string, unknown>>("home.get");
    console.log("home " + JSON.stringify({ keys: Object.keys(home) }));
  }
};
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, ...args] = line.split("\\t");
  handle(cmd!, args).catch((e) => console.log("error " + cmd + " " + (e as Error).message));
}
`);
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  // Its own process group: tsx runs the rig in a child node, which a kill of tsx alone leaves holding
  // the relay's port.
  const child = spawn(tsx, [file], { cwd: path.join(repoRoot, "apps/server"), env: { ...process.env, RELAY_PORT: String(RELAY_PORT) }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const lines = [];
  const waiters = new Set();
  createInterface({ input: child.stdout }).on("line", (line) => { lines.push({ line, at: Date.now() }); for (const w of [...waiters]) w(); });
  child.stderr.on("data", (d) => process.stderr.write(`    [rig] ${d}`));
  const next = (pattern, ms, tag) => new Promise((resolve, reject) => {
    const scan = () => { const i = lines.findIndex((l) => pattern.test(l.line)); if (i < 0) return false; waiters.delete(scan); clearTimeout(timer); resolve(lines.splice(i, 1)[0]); return true; };
    const timer = setTimeout(() => { waiters.delete(scan); reject(new Error(`timeout:${tag}`)); }, ms);
    if (!scan()) waiters.add(scan);
  });
  const url = (await next(/^relay /, 30_000, "local relay")).line.slice("relay ".length);
  return { child, url, next, send: (...parts) => child.stdin.write(`${parts.join("\t")}\n`) };
}

async function main() {
  for (const p of [CDP_PORT, RELAY_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry) || !fs.existsSync(path.join(repoRoot, "apps/server/dist/main.js"))) throw new Error("build first: pnpm build");
  fs.mkdirSync(HOME, { recursive: true });

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    // The secret store's keyring: an in-memory keychain, never the login one.
    'app.commandLine.appendSwitch("use-mock-keychain");',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const env = { ...process.env };
  delete env.REALM_PORT;
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...env, REALM_HOME: HOME, REALM_DEVTOOLS_PORT: String(CDP_PORT), REALM_DAEMON: "1",
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appLog = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(appLog); electron.stdout.pipe(appLog);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Respawn");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  /* ── P1: the phone, paired through Settings' own calls and a local relay ─────────────────────── */
  const first = await until(async () => ourDaemon(), 15_000, "daemon.json");
  const api = rpc(first.port, first.token);
  await api.ready;
  rig = await startRig();
  await api.call("settings.set", { key: "remote.relay", value: rig.url });
  const asked = api.next("remote.pairRequest");
  const { url } = await api.call("remote.pair.start", {});
  rig.send("pair", url);
  await api.call("remote.pair.answer", { requestId: (await asked).requestId, accept: true });
  check("the test phone pairs with the daemon", (await rig.next(/^paired /, 60_000, "paired")).line === "paired ok");
  rig.send("connect");
  const joined = JSON.parse((await rig.next(/^connected /, 30_000, "connected")).line.slice("connected ".length));
  const before = await until(async () => { const s = await api.call("remote.status", {}); return s.state === "connected" ? s : null; }, 30_000, "connected before the kill");
  check("P1 before the kill, remote.status is connected with the phone listed", before.phones.length === 1 && before.phones[0].name === PHONE, { phones: before.phones.map((p) => p.name) });
  check("P1 the phone found its Mac online", joined.macOnline === true, joined);
  rig.send("home");
  const home1 = await rig.next(/^(home|error home) /, 30_000, "home.get before");
  check("P1 and the phone's home.get answers", home1.line.startsWith("home "), home1.line);
  api.close();

  /* ── P2: kill -9 the daemon ──────────────────────────────────────────────────────────────────── */
  const killedAt = Date.now();
  process.kill(first.pid, "SIGKILL");
  const offline = await rig.next(/^mac .*"online":false/, 20_000, "the offline notice").catch(() => null);
  check("P2 the relay tells the phone its Mac went offline", offline !== null, offline ? { afterMs: offline.at - killedAt } : undefined);

  /* ── P3: the new daemon is handed the `remote` key and dials the relay by itself ─────────────── */
  const second = await until(async () => { const s = ourDaemon(); return s && s.pid !== first.pid ? s : null; }, 60_000, "a new daemon");
  check("P3 a new daemon: new pid, port and token", second.port !== first.port && second.token !== first.token, { pid: [first.pid, second.pid], port: [first.port, second.port] });
  const api2 = await until(async () => { const a = rpc(second.port, second.token); await a.ready; return a; }, 30_000, "the new daemon's socket");
  // Every state it passes through: `locked` until main's key arrives is expected, and nothing else.
  const states = [];
  const after = await until(async () => {
    const s = await api2.call("remote.status", {});
    if (states[states.length - 1] !== s.state) states.push(s.state);
    return s.state === "connected" ? s : null;
  }, 60_000, "connected after the kill").catch(() => null);
  check("P3 the new daemon reaches connected by itself", after !== null, { states, afterMs: Date.now() - killedAt });
  check("P3 with the phone still paired", after?.phones.length === 1 && after.phones[0].name === PHONE, after?.phones.map((p) => p.name));

  /* ── P4: the phone hears its Mac is back, handshakes again, and reads home ───────────────────── */
  const online = await rig.next(/^mac .*"online":true/, 30_000, "the online notice").catch(() => null);
  check("P4 the relay tells the phone its Mac is back", online !== null, online ? { afterKillMs: online.at - killedAt } : undefined);
  rig.send("connect");
  const rejoined = await rig.next(/^(connected|error connect) /, 30_000, "the second handshake");
  check("P4 the phone's handshake with the new daemon completes", rejoined.line.startsWith("connected "), rejoined.line);
  rig.send("home");
  const home2 = await rig.next(/^(home|error home) /, 30_000, "home.get after");
  check("P4 and home.get answers from the new daemon", home2.line.startsWith("home "), home2.line);

  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  api2.close();
  c.close();
}

async function teardown() {
  if (rig) { try { process.kill(-rig.child.pid, "SIGKILL"); } catch { /* already gone */ } }
  electron?.kill("SIGKILL");
  await sleep(500);
  // Every server this check started, by pid, each one checked against this worktree as it was seen.
  await stopDaemons(HOME, [...seenPids]);
  if (process.env.LIVE_KEEP) console.error(`[live] keeping ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
