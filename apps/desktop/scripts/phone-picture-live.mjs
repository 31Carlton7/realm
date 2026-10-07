/**
 * A real iPhone's picture, measured through the BUILT app: the runner's screenshots first, then — once
 * Realm is allowed the camera, which is how macOS reaches an iPhone's screen over the cable — live video.
 *
 *   LIVE_PHONE_UDID=<udid> [SCRATCH_HOME=<a home whose runner is already built>] node apps/desktop/scripts/phone-picture-live.mjs
 *
 * Needs a person, twice: the phone plugged in and unlocked, and a click on Allow when macOS asks about
 * the camera (asked through the same IPC the pane's Show live uses). Scroll something on the phone
 * while the live picture is measured: an iPhone sends a frame when its screen changes.
 *
 * It taps nothing on the phone. It starts Realm's runner there — which takes over from any other
 * runner on that phone — and takes it off again at the end.
 *
 * Electron is launched through LaunchServices (`open`), not spawned: macOS asks the camera question of
 * the RESPONSIBLE app, and a spawned Electron answers to whatever app ran this script — under a Realm
 * session, the installed Realm, which held no camera entitlement until this change and is refused
 * without a prompt. Opened, this Electron answers for itself, as a Realm opened from the Dock does.
 */
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { daemonState, stopDaemons, tokenProtocols } = await import(pathToFileURL(path.join(repoRoot, "apps/desktop/scripts/lib/daemon-token.mjs")).href);
const PHONE = process.env.LIVE_PHONE_UDID?.trim();
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9243), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8803);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-phone-picture-live-"));
const home = process.env.SCRATCH_HOME ?? path.join(scratch, "home");
const helper = path.join(repoRoot, "apps/desktop/native/bin/phonescreen");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function portFree(port) {
  return new Promise((resolve) => { const s = connect({ port, host: "127.0.0.1" }); s.once("connect", () => { s.destroy(); resolve(false); }); s.once("error", () => resolve(true)); });
}
async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`); await sleep(250); }
}
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* none */ }
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return { ready, close: () => ws.close(), send: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result))); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token)); let id = 0; const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return { ready, close: () => ws.close(), call: (method, params) => new Promise((res, rej) => { const i = String(++id); pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)))); ws.send(JSON.stringify({ id: i, method, params })); }) };
}

/** Frames on the MJPEG stream for `ms`: how many, and the gaps between them. */
function measure(url, ms) {
  return new Promise((resolve) => {
    const at = [];
    let buf = Buffer.alloc(0);
    const req = request(url, (res) => {
      res.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const head = buf.indexOf("\r\n\r\n");
          if (head < 0) break;
          const length = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, head).toString())?.[1]);
          if (buf.length < head + 4 + length + 2) break;
          at.push(performance.now());
          buf = buf.subarray(head + 4 + length + 2);
        }
      });
    });
    req.on("error", () => {});
    req.end();
    setTimeout(() => {
      req.destroy();
      const gaps = at.slice(1).map((t, i) => t - at[i]).sort((a, b) => a - b);
      const q = (p) => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]) : null);
      resolve({ frames: at.length, fps: Math.round((at.length / (ms / 1000)) * 10) / 10, gapP50: q(0.5), gapP90: q(0.9) });
    }, ms);
  });
}

let electron = null, api = null, simulatorId = null;

async function main() {
  if (!PHONE) throw new Error("set LIVE_PHONE_UDID to the phone's udid");
  if (!fs.existsSync(helper)) throw new Error(`${helper} is missing — run apps/desktop/scripts/build-native.mjs`);
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const lock = JSON.parse(execFileSync("xcrun", ["devicectl", "device", "info", "lockState", "--device", PHONE, "--json-output", "-", "--quiet"], { encoding: "utf8", timeout: 30_000 }));
  if (lock.result?.passcodeRequired !== false) throw new Error("the phone is locked (or would not say) — unlock it and run again");

  fs.mkdirSync(home, { recursive: true });
  // A reused home can hold the state file of a server that is gone — and its token, which this run's
  // server would refuse. One that is still running is someone's: leave it and stop.
  const stale = daemonState(home);
  if (stale?.pid) {
    let alive = true;
    try { process.kill(stale.pid, 0); } catch { alive = false; }
    if (alive) throw new Error(`a Realm server (pid ${stale.pid}) is already running on ${home}`);
    fs.rmSync(path.join(home, "daemon.json"), { force: true });
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const env = {
    REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
    REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_PHONESCREEN_BIN: helper,
    LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
  };
  const app = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app");
  execFileSync("open", ["-n", ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), app, "--args", wrapper,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]);
  // `open` returns at once; the app is found by the wrapper only it was given.
  const pid = await until(() => { try { return Number(execFileSync("pgrep", ["-f", wrapper], { encoding: "utf8" }).split("\n")[0]) || null; } catch { return null; } }, 30_000, "electron");
  electron = { kill: (sig) => { try { process.kill(pid, sig); } catch { /* gone */ } } };
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const page = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer");
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  api = rpc(SERVER_PORT, await until(() => { const st = daemonState(home); return st && st.port === SERVER_PORT ? st.token : null; }, 60_000, "this run's server"));
  await api.ready;
  let spaces = await api.call("spaces.list", {});
  if (spaces.length === 0) {
    await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
    await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Phone"); input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
    spaces = await until(async () => { const s = await api.call("spaces.list", {}); return s.length ? s : null; }, 30_000, "space");
  }
  const space = spaces[0];

  simulatorId = (await api.call("simulators.list", { spaceId: space.id })).simulators.find((s) => s.udid === PHONE)?.id
    ?? (await api.call("simulators.create", { spaceId: space.id, name: "iPhone", udid: PHONE })).simulatorId;
  note("starting the runner", { home });
  await api.call("simulators.start", { simulatorId, udid: PHONE, platform: "ios", physical: true });
  const running = await until(async () => { const s = (await api.call("simulators.get", { simulatorId })).state; return s.status === "running" ? s : s.status === "failed" ? { failed: s } : null; }, 900_000, "runner");
  if (running.failed) throw new Error(`the runner did not start: ${running.failed.error} ${running.failed.detail ?? ""}`);
  const stateNow = async () => (await api.call("simulators.get", { simulatorId })).state;

  // 1. Before the camera: screenshots, and the pane told why.
  const before = await measure(running.streamUrl, 6_000);
  const asked = await stateNow();
  note("picture before the camera", { ...before, stills: asked.stills ?? null });
  if (asked.stills === "camera") {
    check("without the camera the picture is screenshots, and says it is for the camera's sake", before.frames > 0, before);
    // 2. Show live, through the pane's own IPC: macOS asks, a person answers.
    console.log("ACTION click Allow on macOS's camera prompt (it is the iPhone's screen it asks about)");
    const answer = await evalIn(c, `window.realm.phoneScreen.showLive()`);
    note("camera after asking", answer);
    check("the camera was allowed", answer === "granted", answer);
  } else {
    note("the camera was already decided", asked.stills ?? "live");
  }

  // 3. Live: the bridge notices the grant by itself.
  const live = await until(async () => { const s = await stateNow(); return (s.stills ?? null) === null ? s : null; }, 30_000, "live picture");
  check("the picture goes live by itself once the camera is allowed", (live.stills ?? null) === null);
  console.log("ACTION scroll something on the phone for ten seconds");
  await sleep(1_500);
  const after = await measure(running.streamUrl, 10_000);
  note("live picture", after);
  check("the live picture runs at several times the screenshots' rate", after.fps >= Math.max(5, before.fps * 4), { before: before.fps, live: after.fps });
}

try {
  await main();
} catch (e) {
  process.exitCode = 1;
  console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (api && simulatorId) await api.call("simulators.stop", { simulatorId }).catch(() => {});
  api?.close();
  electron?.kill("SIGTERM");
  await sleep(1_500);
  try { await stopDaemons(home); } catch { /* none */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
}
