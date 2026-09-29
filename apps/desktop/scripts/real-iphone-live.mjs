/**
 * Live check for a REAL iPhone in the simulator tools (run with: pnpm build && node apps/desktop/scripts/real-iphone-live.mjs)
 *
 *   stub ACP agent ── session/new hands it the gateway URL + bearer ──▶ this script's MCP client
 *      realm-simulator provider → permission broker (answered here, over RPC) → SimulatorService
 *         → devicectl + Realm's test runner on the phone, over usbmuxd ──▶ the phone, in a pane
 *
 * Two modes, and the first is always run before the second:
 *
 *   LIVE_REHEARSAL_UDID=<simulator udid>  the rehearsal: that simulator is put in the device list as a
 *                                         phone (REALM_RUNNER_SIMULATOR) and reached the phone's way —
 *                                         the same runner, tree and input, over loopback.
 *   LIVE_PHONE_UDID=<udid>                the phone itself.
 *
 * The phone is somebody's own, so this script is built to stop short of anything but its script:
 *   - it reads devicectl's lock state before it starts the app at all, and does nothing to a locked
 *     phone — no runner, no read, nothing;
 *   - before EVERY read of the screen it asks the runner which app is in front — the bundle id and
 *     nothing that app shows — and stops the runner and quits if it is anything but the home screen,
 *     Settings or the runner itself;
 *   - its steps are exactly: list, open, screenshot, read, one walk to General › About that opens
 *     Settings fresh, Back twice by number, "About" typed into Settings' search and cancelled, Home;
 *   - every picture and tree it keeps goes to /tmp, never into the repo.
 *
 * No billed call: the session is the fake agent's, titled at creation, with one turn and no work.
 * Ports: LIVE_CDP_PORT / LIVE_SERVER_PORT. Touches a scratch home; kills only its own ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9238), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8798);
const REHEARSAL = process.env.LIVE_REHEARSAL_UDID?.trim() || null;
const PHONE = process.env.LIVE_PHONE_UDID?.trim() || null;
const TARGET = REHEARSAL ?? PHONE;
if (!TARGET || (REHEARSAL && PHONE)) throw new Error("set exactly one of LIVE_REHEARSAL_UDID and LIVE_PHONE_UDID");
const MODE = REHEARSAL ? "rehearsal" : "phone";
const OUT_DIR = process.env.LIVE_OUT ?? path.join("/tmp", "real-iphone", `live-${MODE}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = (name) => path.join(OUT_DIR, name);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-real-iphone-live-"));
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1500, height: 900 };
const TITLE = "Real iPhone live check";
const LIVE_LAYA_VENV = process.env.LIVE_LAYA_VENV ?? "/tmp/laya-spike/.venv";
const LIVE_LAYA_HF = process.env.LIVE_LAYA_HF ?? "/tmp/laya-spike/hf";
/** What may be in front when the script reads the screen: the home screen, Settings, the runner. */
const ALLOWED_FRONT = new Set(["com.apple.springboard", "com.apple.Preferences", "co.charmtechnologies.realm.device-runner.xctrunner"]);
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcript = [];
const log = (line) => { console.log(line); transcript.push(line); };

const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

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
    await sleep(250);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
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
  log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => log(`INFO ${name} ${JSON.stringify(detail)}`);

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Luminance range and mean of a PNG, measured in the page. */
async function stats(c, b64) {
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
    await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    let lo = 255, hi = 0, sum = 0;
    for (let i = 0; i < px.length; i += 4) { const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; if (l < lo) lo = l; if (l > hi) hi = l; sum += l; }
    return { width: img.width, height: img.height, range: Math.round(hi - lo), mean: Math.round(sum / (px.length / 4)) };
  })()`);
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

/* ── which app is in front, and nothing else ─────────────────────────────────────────────────── */

/** The runner's port, as the server logged it when it started the runner. */
function runnerPort() {
  const file = path.join(home, "ios-device-runner", "logs", `${TARGET}.log`);
  const all = fs.existsSync(file) ? [...fs.readFileSync(file, "utf8").matchAll(/\(runner port (\d+)\)/g)] : [];
  return all.length ? Number(all.at(-1)[1]) : null;
}

/** A socket to the runner the way the server reaches it: usbmuxd for the phone, loopback for the rehearsal. */
async function runnerSocket(port) {
  if (REHEARSAL) return new Promise((res, rej) => { const s = connect({ port, host: "127.0.0.1" }); s.once("connect", () => res(s)); s.once("error", rej); });
  const frame = (xml) => { const b = Buffer.from(xml); const h = Buffer.alloc(16); h.writeUInt32LE(16 + b.length, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(8, 8); h.writeUInt32LE(1, 12); return Buffer.concat([h, b]); };
  const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}<key>ClientVersionString</key><string>realm-live</string><key>ProgName</key><string>realm-live</string><key>kLibUSBMuxVersion</key><integer>3</integer></dict></plist>`;
  const ask = (sock, xml) => new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const on = (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 4 && buf.length >= buf.readUInt32LE(0)) { sock.off("data", on); res(buf.subarray(16, buf.readUInt32LE(0)).toString()); } };
    sock.on("data", on); sock.once("error", rej); sock.write(frame(xml));
  });
  const open = () => new Promise((res, rej) => { const s = connect("/var/run/usbmuxd"); s.once("connect", () => res(s)); s.once("error", rej); });
  const lister = await open();
  const listed = await ask(lister, plist("<key>MessageType</key><string>ListDevices</string>"));
  lister.destroy();
  const id = [...listed.matchAll(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>[\s\S]*?<key>SerialNumber<\/key>\s*<string>([^<]+)<\/string>/g)].find((m) => m[2] === TARGET)?.[1];
  if (!id) throw new Error("usbmuxd does not list the phone");
  const sock = await open();
  const said = await ask(sock, plist(`<key>MessageType</key><string>Connect</string><key>DeviceID</key><integer>${id}</integer><key>PortNumber</key><integer>${((port & 0xff) << 8) | (port >> 8)}</integer>`));
  if (!/<key>Number<\/key>\s*<integer>0<\/integer>/.test(said)) { sock.destroy(); throw new Error(`usbmuxd refused the runner's port: ${said.slice(0, 200)}`); }
  return sock;
}

async function foreground() {
  const port = runnerPort();
  if (!port) throw new Error("no runner port in the server's log");
  const sock = await runnerSocket(port);
  return new Promise((resolve, reject) => {
    let raw = "";
    sock.on("data", (d) => { raw += d; });
    sock.once("error", reject);
    sock.once("close", () => { const body = raw.split("\r\n\r\n")[1] ?? ""; try { resolve(JSON.parse(body).bundleId); } catch { reject(new Error(`no answer: ${raw.slice(0, 120)}`)); } });
    sock.write("GET /foreground HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
}

class Stop extends Error {}
/** Before every read: which app is in front. Anything but home, Settings or the runner ends the run. */
async function guard(step) {
  const front = await foreground();
  note(`in front before ${step}`, front);
  if (!ALLOWED_FRONT.has(front)) throw new Stop(`${front} is in front before "${step}" — the script reads only the home screen and Settings, so it stops here and takes the runner off the phone`);
  return front;
}

/* ── the run ─────────────────────────────────────────────────────────────────────────────────── */

let simulatorId = null;
let api = null;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  if (PHONE) {
    // Before the app starts: a locked phone is not acted on at all.
    const lock = JSON.parse(execFileSync("xcrun", ["devicectl", "device", "info", "lockState", "--device", PHONE, "--json-output", "-", "--quiet"], { encoding: "utf8", timeout: 30_000 }));
    note("lock state before anything", lock.result);
    if (lock.result?.passcodeRequired !== false) throw new Stop("the phone is locked (or would not say) — nothing is done to a locked phone");
  }

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_GEMINI_BIN: agent,
      REALM_LAYA_VENV: LIVE_LAYA_VENV, REALM_LAYA_HF_HOME: LIVE_LAYA_HF,
      ...(REHEARSAL ? { REALM_RUNNER_SIMULATOR: REHEARSAL } : {}),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const page = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30_000, "renderer target");
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");

  // Cards, answered as the user would: yes to the simulator tools, and the titles kept to check.
  const cards = [];
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title });
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: card.toolName.startsWith("simulator_") ? "allow" : "deny" }).catch(() => {});
  });
  await api.ready;

  // Laya's shadow on, through the runtime's dev seam — an existing venv and checkpoint cache.
  await api.call("laya.setMode", { mode: "shadow" });
  const laya = await until(async () => {
    const st = (await api.call("laya.status", {})).runtime;
    return st.state === "ready" ? st : st.state === "failed" ? { failed: st } : null;
  }, 180_000, "Laya ready").catch((e) => ({ failed: String(e) }));
  check("Laya runs locally in shadow before the first step", !laya.failed, laya);

  const [space] = await api.call("spaces.list", {});
  // bypassPermissions ON PURPOSE: a phone's cards must be asked even so.
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "bypassPermissions" });
  sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 15_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "real-iphone-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = async (name, args = {}) => {
    const t0 = Date.now();
    const r = await client.callTool({ name: `realm-simulator__${name}`, arguments: args }, undefined, { timeout: 600_000 });
    const ms = Date.now() - t0;
    fs.appendFileSync(OUT("tools.log"), `\n=== ${name} ${JSON.stringify(args)} (${ms} ms)${r.isError ? " ERROR" : ""}\n${text(r)}\n`);
    return Object.assign(r, { ms });
  };

  // ── 1. The device list ──────────────────────────────────────────────────────────────────────
  const listed = text(await call("simulator_list"));
  const line = listed.split("\n").find((l) => l.includes(TARGET)) ?? "";
  check("simulator_list shows the device under real devices, marked as one", /Real iPhones and iPads/.test(listed) && / · a real device, connected$/.test(line), line);

  // ── 2. Open it: a card even under bypass, the runner up, the pane painting ─────────────────
  const t0 = Date.now();
  let opened = await call("simulator_open", { udid: TARGET });
  simulatorId = text(opened).match(/simulator pane (\S+?)[,\s]/)?.[1] ?? null;
  if (/still starting/.test(text(opened))) {
    await until(async () => new RegExp(`${simulatorId} \\((running|failed to start)\\)`).test(text(await call("simulator_list"))), 900_000, "the runner");
    opened = await call("simulator_open", { udid: TARGET });
  }
  note("open answered", { seconds: Math.round((Date.now() - t0) / 1000), said: text(opened).split("\n")[0] });
  check("simulator_open asks under bypassPermissions, naming a physical phone", cards.some((k) => k.tool === "simulator_open" && /a physical phone/.test(k.title)), cards);
  check("the phone comes up in a pane", !opened.isError && /^Opened /.test(text(opened)), text(opened));
  if (opened.isError) return;

  await guard("the first screenshot");
  const box = await until(() => evalIn(c, `(() => { const p = document.querySelector('.sim-picture'); if (!p || p.tagName !== 'IMG') return null; const b = p.getBoundingClientRect(); return b.width > 50 ? { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } : null; })()`), 30_000, "the live picture");
  // A flat picture is a stream that is not decoding: the luminance must span a range.
  const painted = await until(async () => {
    const s = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
    const st = await stats(c, s.data);
    return st.range > 30 ? st : null;
  }, 45_000, "a painted frame").catch(() => null);
  check("the pane is painting the device's picture", !!painted, { box, painted });
  fs.writeFileSync(OUT("window-open.png"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ── 3. Look at it ───────────────────────────────────────────────────────────────────────────
  const shot = await call("simulator_screenshot", { simulatorId });
  const image = shot.content.find((x) => x.type === "image");
  if (image) fs.writeFileSync(OUT("tool-screenshot.png"), Buffer.from(image.data, "base64"));
  check("simulator_screenshot hands over the phone's screen", !shot.isError && !!image, text(shot).split("\n")[0]);

  await guard("the first read of elements");
  const first = await call("simulator_elements", { simulatorId });
  check("simulator_elements reads it by name, in points, numbered", !first.isError && /in points, on a \d+×\d+ screen/.test(text(first)), text(first).split("\n").slice(0, 3));
  note("first read took (ms)", first.ms);

  // ── 4. One walk: Settings fresh, General › About ───────────────────────────────────────────
  const inputCards = () => cards.filter((k) => k.tool.startsWith("simulator_") && /^Tap, swipe and type/.test(k.title));
  const walked = await call("simulator_do", { simulatorId, intent: "find the iOS version", app: "com.apple.Preferences", path: ["General", "About"] });
  const walk = text(walked);
  log(`WALK General › About: ${walked.ms} ms, one call`);
  check("ONE simulator_do opens Settings fresh and walks General › About", !walked.isError && /^Walked "General" → "About" on /.test(walk), walk.split("\n")[0]);
  check("…and its answer is the About screen, read by name", /\[\d+\] \w+ "(iOS Version|Software Version|Model Name|Name)"/.test(walk), walk.split("\n").filter((l) => /^\[\d+\]/.test(l)).slice(0, 6).map((l) => l.replace(/value="[^"]*"/, 'value="…"')));
  check("…behind the launch card and the phone's input card, both asked under bypass", cards.some((k) => k.tool === "simulator_launch" && /a physical phone/.test(k.title)) && inputCards().length === 1 && /a physical phone/.test(inputCards()[0].title), cards);

  // ── 5. Back twice, by number, each checked by reading again ─────────────────────────────────
  const read = async (step) => { await guard(step); const r = await call("simulator_elements", { simulatorId }); return r.isError ? null : text(r); };
  const steady = async (holds, step) => {
    let last = null;
    const shape = (t) => (t ?? "").split("\n").filter((l) => /^\[\d+\] /.test(l)).map((l) => l.replace(/^\[\d+\] /, "")).join("\n");
    return until(async () => { const t = await read(step); const still = t !== null && last !== null && shape(t) === shape(last); last = t; return still && holds(t) ? t : null; }, 30_000, step).catch(() => null);
  };
  const backToGeneral = walk.match(/\[(\d+)\] Button "General"/);
  check("the walk's answer has a Back button to General, by number", !!backToGeneral, walk.split("\n").slice(3, 10));
  if (!backToGeneral) return;
  await call("simulator_tap", { simulatorId, intent: "back to General", element: Number(backToGeneral[1]) });
  const general = await steady((t) => /\] Button "About"/.test(t) && /\] Button "Settings"/.test(t), "General, after Back");
  check("Back by number goes to General", !!general, general?.split("\n").slice(4, 8));
  const backToSettings = general?.match(/\[(\d+)\] Button "Settings"/);
  if (!backToSettings) return;
  await call("simulator_tap", { simulatorId, intent: "back to the Settings list", element: Number(backToSettings[1]) });
  const root = await steady((t) => /\] Button "General"/.test(t) && !/\] Button "About"/.test(t), "the Settings list, after Back");
  check("Back by number again goes to the Settings list", !!root, root?.split("\n").slice(4, 8));

  // ── 6. How long a read takes: the service's ax, twenty times on Settings' root ─────────────
  await guard("the timed reads");
  const times = [];
  for (let i = 0; i < 20; i++) { const t = performance.now(); await api.call("simulators.ax", { simulatorId }); times.push(Math.round(performance.now() - t)); }
  note("ax latency on Settings' root (ms)", { p50: pct(times, 50), p90: pct(times, 90), all: times });

  // ── 7. "About" into Settings' search, then cancelled ───────────────────────────────────────
  const field = root?.match(/\[(\d+)\] (?:SearchField|TextField)[^\n]*/);
  check("the Settings list has its search field", !!field, root?.split("\n").filter((l) => /Field/.test(l)));
  if (field) {
    await call("simulator_tap", { simulatorId, intent: "focus Settings search", element: Number(field[1]) });
    await sleep(800);
    const typed = await call("simulator_type", { simulatorId, intent: "search Settings for About", text: "About" });
    check("simulator_type types into Settings' search", !typed.isError, text(typed));
    const found = await steady((t) => /(?:SearchField|TextField)[^\n]*value="About"/.test(t), "the typed search");
    check("…and the field holds \"About\"", !!found, found?.split("\n").filter((l) => /Field/.test(l)));
    const cancel = ["Cancel", "Close"].map((label) => found?.match(new RegExp(`\\[(\\d+)\\] Button "${label}"`, "i"))).find(Boolean);
    check("search has a way out to tap", !!cancel, found?.split("\n").filter((l) => /\] Button "/.test(l)).slice(-6).map((l) => l.replace(/ \(.*$/, "")));
    if (cancel) {
      await call("simulator_tap", { simulatorId, intent: "cancel the search", element: Number(cancel[1]) });
      const cancelled = await steady((t) => !/value="About"/.test(t) && /\] Button "General"/.test(t), "search cancelled");
      check("…and cancelling it leaves the Settings list, nothing searched", !!cancelled, cancelled?.split("\n").filter((l) => /Field/.test(l)));
    }
  }

  // ── 8. Home ────────────────────────────────────────────────────────────────────────────────
  const pressed = await call("simulator_press", { simulatorId, intent: "go to the home screen", key: "home" });
  check("simulator_press home", !pressed.isError, text(pressed));
  const homeScreen = await steady((t) => /^app: \(no name\)$/m.test(t), "the home screen");
  check("…and the elements say the home screen is up", !!homeScreen, homeScreen?.split("\n").slice(3, 5));
  check("one input card for the whole run on the phone", inputCards().length === 1, inputCards());
  fs.writeFileSync(OUT("window-end.png"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // ── 9. Laya heard every step ───────────────────────────────────────────────────────────────
  const logPath = path.join(home, "laya", "decisions.jsonl");
  const rows = await until(() => {
    const r = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return r.filter((x) => x.surface === "simulator").length >= 6 ? r : null;
  }, 60_000, "Laya's rows").catch(() => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []));
  const sim = rows.filter((x) => x.surface === "simulator");
  fs.writeFileSync(OUT("laya-rows.json"), JSON.stringify(sim.map((x) => ({ tool: x.tool, intent: x.intent, chosen: x.truth?.target?.id ?? null, laya: x.laya?.target?.choice ?? null })), null, 1));
  check("Laya's shadow logged the walk's taps", sim.filter((x) => x.tool === "simulator_do").length >= 2, sim.map((x) => `${x.tool}: ${x.intent}`));
  // A row is written when the step AFTER it arrives — that is what says whether it worked — so the
  // last step's, Home, is still to come when the run ends.
  check("…and the steps after it", ["simulator_tap", "simulator_type"].every((t) => sim.some((x) => x.tool === t)), sim.map((x) => x.tool));

  await client.close();
  c.close();
}

async function teardown() {
  // The runner comes off the device first: the phone is its owner's again.
  if (api && simulatorId) await api.call("simulators.stop", { simulatorId }).then(() => log("(runner stopped)")).catch((e) => log(`(stop failed: ${e.message})`));
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  // The server's own log of the runner, kept with the evidence before the scratch home goes.
  try { fs.cpSync(path.join(home, "ios-device-runner", "logs"), OUT("runner-logs"), { recursive: true }); } catch { /* none written */ }
  fs.writeFileSync(OUT("transcript.txt"), transcript.join("\n") + "\n");
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => {
  if (e instanceof Stop) { log(`STOPPED ${e.message}`); process.exitCode = 2; return; }
  process.exitCode = 1; log(`FAIL ${e?.stack ?? e}`);
}).finally(teardown);
