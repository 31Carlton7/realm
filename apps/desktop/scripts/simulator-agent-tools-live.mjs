/**
 * Live check for the simulator TOOLS (run with: pnpm build && node apps/desktop/scripts/simulator-agent-tools-live.mjs)
 *
 * `simulator-pane-live.mjs` proves the pane a person clicks. This proves the same pane reached by an
 * AGENT: a real session, through the real gateway, on the built app —
 *
 *   stub ACP agent ── session/new hands it the gateway URL + bearer ──▶ this script's MCP client
 *      realm-simulator provider → permission broker (answered here, over RPC) → SimulatorService
 *         → xcrun simctl + serve-sim ──▶ a real simulator, shown in the pane beside the session
 *
 * The agent is the ACP fixture the adapter suite already uses (`fake-acp-agent.mjs`), repointed with
 * REALM_GEMINI_BIN. Its `REVEAL` turn echoes the `session/new` it was handed, which is the only place
 * a session's gateway token ever goes — so the script calls tools AS that session, with its own space,
 * permission mode and cards, without a model in the loop. No billed call is made: the session is
 * created with a title (so no title is written for it) and has one turn and no work (so no recap).
 *
 * What only a real Mac can say:
 *   1. The tools are listed to a real session, and simulator_open boots a real device, behind a card.
 *   2. The pane arrives BESIDE the session in the renderer (`simulator.agentOpened` → openItemBeside),
 *      and it is painting — sampled from the window, where the stream is an ordinary <img>.
 *   3. simulator_screenshot's picture is a real screen, shrunk to the budget; simulator_elements and
 *      simulator_apps read the real device; simulator_launch opens Settings and the tree says so.
 *   4. browser_open refuses serve-sim's stream — this one, and any other already running — and still
 *      opens a loopback URL that is not one.
 *
 * It boots a SHUT-DOWN iPhone (never one somebody has up), and at the end stops the stream Realm
 * started for it and shuts it down again. Another stream on this Mac is only ever read about.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only what is listening on its own ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9233), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8793);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sim-tools-live-"));
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1500, height: 900 };
const TITLE = "Simulator tools live check";
const OUT = (tag) => path.join(os.tmpdir(), `realm-simulator-agent-tools-${tag}.png`);
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** RPC over the daemon's own socket, with the events it broadcasts handed to `onEvent`. */
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
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Whatever is listening on a port this script started. Never a name match: `pkill electron` on a
 *  developer's Mac is a way to close their editor. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* lsof says nothing is listening, which is the happy path */ }
}

const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const serveSimList = (udid) => {
  try { return JSON.parse(execFileSync("npx", ["--yes", "serve-sim@latest", "--list", ...(udid ? [udid] : [])], { encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop()); }
  catch { return { running: false }; }
};

/** Luminance range and mean of a PNG, measured in the page — a flat picture is a stream that is not
 *  decoding, or a screenshot of nothing. */
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

let target = null;        // the udid this script booted, and so must shut down
let simulatorId = null;   // the pane it opened, whose stream it must stop
let api = null;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // The stub agent, runnable as a binary: the ACP probe asks `--version` before anything else, and the
  // fixture itself only speaks JSON-RPC on stdin.
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

  // Permission cards, answered the way a user would: yes to the simulator's, no to the browser's —
  // the browser card only has to APPEAR to prove the guard let that URL through.
  const cards = [];
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    // `session.event` carries the stored row: `{ seq, sessionId, event: { type, ts, payload } }`.
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title });
    const decision = card.toolName.startsWith("simulator_") ? "allow" : "deny";
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
  sessionId = session.id;

  // Into the layout, in the focused leaf: the pane the simulator is to open BESIDE.
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 15_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  // ── 1. A real session's gateway, and the tools on it ─────────────────────────────────────
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const headers = Object.fromEntries(gw.headers.map((h) => [h.name, h.value]));
  const client = new Client({ name: "simulator-agent-tools-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers } }));
  const call = async (name, args = {}) => client.callTool({ name: `realm-simulator__${name}`, arguments: args }, undefined, { timeout: 180_000 });

  const tools = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("realm-simulator__"));
  check("a real session's gateway lists the eight simulator tools", tools.length === 8, tools);

  // ── 2. The device list, and a device nobody has up ──────────────────────────────────────
  const listed = text(await call("simulator_list"));
  const pick = process.env.LIVE_SIM_UDID
    ?? listed.match(/^\s+(\S+) — iPhone 17e · [^·]+ · not running$/m)?.[1]
    ?? listed.match(/^\s+(\S+) — iPhone[^·]* · [^·]+ · not running$/m)?.[1];
  check("simulator_list names this Mac's devices, with a shut-down iPhone to use", !!pick, listed.split("\n").slice(0, 4));
  if (!pick) return;
  if (serveSimList(pick).running) throw new Error(`${pick} is already being streamed by somebody — refusing to touch it`);
  target = pick;

  // ── 3. simulator_open: a card, a boot, a stream ─────────────────────────────────────────
  const t0 = Date.now();
  let opened = await call("simulator_open", { udid: target });
  simulatorId = text(opened).match(/simulator pane (\S+?)[,\s]/)?.[1] ?? null;
  check("simulator_open asks first, naming the device and the boot", cards.some((k) => k.tool === "simulator_open" && / in a simulator pane — boots it$/.test(k.title)), cards);
  // A cold boot can outlast the tool's own wait; the pane's state is what the list reports.
  if (/still/.test(text(opened))) {
    await until(async () => new RegExp(`${simulatorId} \\(running\\)`).test(text(await call("simulator_list"))), 180_000, "the stream");
    opened = await call("simulator_open", { udid: target });
  }
  console.log(`(open answered in ${Math.round((Date.now() - t0) / 1000)}s) ${text(opened)}`);
  check("the device comes up streaming in a pane", !opened.isError && /Opened .* in simulator pane/.test(text(opened)), text(opened));

  // ── 4. BESIDE the session, and painting ─────────────────────────────────────────────────
  /* The PANE, not the picture: the pane is broadcast into the layout before the stream is up, so
     whether it arrived beside the session is a question about the renderer alone — a stream that
     fails to start must not be able to pass or fail it. */
  const box = `(el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; }`;
  const beside = await until(() => evalIn(c, `(() => {
    const box = ${box};
    const sim = document.querySelector('.sim-pane'), composer = document.querySelector('.composer');
    return sim && composer ? { sim: box(sim), composer: box(composer) } : null;
  })()`), 15_000, "the simulator pane in the layout").catch(() => null);
  check("the simulator pane opened beside the session rather than over it",
    !!beside && beside.sim.w > 200 && beside.composer.w > 200 && beside.sim.x >= beside.composer.x + beside.composer.w - 2, beside);
  const layout = await until(() => evalIn(c, `(() => {
    const box = ${box};
    const pic = document.querySelector('.sim-picture');
    return pic ? { picture: box(pic) } : null;
  })()`), 30_000, "the live picture");
  const shot = await until(async () => {
    const b = layout.picture;
    const s = await c.send("Page.captureScreenshot", { format: "png", clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
    const st = await stats(c, s.data);
    return st.range > 30 ? { ...st } : null;
  }, 45_000, "a painted frame").catch(() => null);
  check("the pane is painting the device, not an empty box", !!shot, shot);
  fs.writeFileSync(OUT("window"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  console.log(`SCREENSHOT window ${OUT("window")}`);

  // ── 5. What the agent can see ───────────────────────────────────────────────────────────
  const picture = await call("simulator_screenshot", { simulatorId });
  const image = picture.content.find((x) => x.type === "image");
  if (image) fs.writeFileSync(OUT("tool"), Buffer.from(image.data, "base64"));
  const seen = image ? await stats(c, image.data) : null;
  check("simulator_screenshot hands over a real screen, shrunk to the 1280 budget",
    !!seen && Math.max(seen.width, seen.height) === 1280 && seen.range > 30, { seen, said: text(picture) });
  console.log(`SCREENSHOT tool ${OUT("tool")}`);
  check("…and leaves nothing in the space's folder", !fs.existsSync(path.join(space.folderPath, "simulator")), space.folderPath);

  const tree = await until(async () => {
    const r = await call("simulator_elements", { simulatorId });
    return !r.isError && /element\(s\)/.test(text(r)) ? text(r) : null;
  }, 60_000, "an accessibility tree");
  check("simulator_elements reads the home screen by name, fenced", /"Settings"/.test(tree) && tree.includes("<<<"), tree.split("\n").slice(0, 8));

  const apps = text(await call("simulator_apps", { simulatorId }));
  check("simulator_apps lists the device's apps with their bundle ids", apps.includes("com.apple.Preferences"), apps.split("\n").slice(0, 3));

  // ── 6. Acting, behind a card ────────────────────────────────────────────────────────────
  const launched = await call("simulator_launch", { simulatorId, bundleId: "com.apple.Preferences" });
  check("simulator_launch runs Settings once the card is answered", !launched.isError && cards.some((k) => k.tool === "simulator_launch"), text(launched));
  const inSettings = await until(async () => {
    const r = text(await call("simulator_elements", { simulatorId }));
    return /"General"/.test(r) ? r : null;
  }, 30_000, "Settings on screen").catch(() => null);
  check("…and the tree says Settings is what is on screen now", !!inSettings, inSettings?.split("\n").slice(0, 6));
  // The keepers for the report: the agent's picture and the window, both once Settings is up, so what
  // they show can be read against the tree above rather than against a boot animation.
  const settingsShot = (await call("simulator_screenshot", { simulatorId })).content.find((x) => x.type === "image");
  if (settingsShot) { fs.writeFileSync(OUT("tool-settings"), Buffer.from(settingsShot.data, "base64")); console.log(`SCREENSHOT tool-settings ${OUT("tool-settings")}`); }
  await sleep(1500); // the stream can lag the tree by a beat
  fs.writeFileSync(OUT("window-settings"), Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  console.log(`SCREENSHOT window-settings ${OUT("window-settings")}`);

  // ── 7. The tap the preamble sends agents to serve-sim for ───────────────────────────────
  /* The tools do not tap, and the preamble says serve-sim's own `tap -d <udid>` drives the device the
     pane is streaming and starts nothing. That is a claim agents act on, so it is exercised here the
     way the skill says to: the element's centre from the tree, over the screen size the tree states. */
  const general = inSettings?.match(/\[[\d.]+\] Button "General"[^\n]*\((\d+),(\d+) (\d+)×(\d+)\)/);
  const screen = inSettings?.match(/on a (\d+)×(\d+) screen/);
  if (general && screen) {
    const [x, y, w, h] = general.slice(1).map(Number), [sw, sh] = screen.slice(1).map(Number);
    const nx = ((x + w / 2) / sw).toFixed(3), ny = ((y + h / 2) / sh).toFixed(3);
    execFileSync("npx", ["--yes", "serve-sim@latest", "tap", nx, ny, "-d", target], { stdio: "ignore", timeout: 60_000 });
    const inGeneral = await until(async () => {
      const r = text(await call("simulator_elements", { simulatorId }));
      return /"About"/.test(r) ? r : null;
    }, 20_000, "General on screen").catch(() => null);
    check("serve-sim's tap on the element's centre lands on the device the pane shows", !!inGeneral, { tapped: [nx, ny], after: inGeneral?.split("\n").slice(4, 8) });
    const streams = serveSimList();
    const forTarget = (streams.streams ?? (streams.device ? [streams] : [])).filter((s) => s.device === target);
    check("…and started nothing: still one stream for that device, the pane's", forTarget.length === 1, forTarget.map((s) => s.port));
  } else {
    check("the Settings tree carries a General row to tap", false, inSettings?.split("\n").slice(0, 8));
  }

  // ── 8. The browser guard ────────────────────────────────────────────────────────────────
  const browse = async (url) => client.callTool({ name: "realm-browser__browser_open", arguments: { url } }, undefined, { timeout: 60_000 });
  const mine = serveSimList(target);
  const refused = mine.port ? await browse(`http://127.0.0.1:${mine.port}/`) : null;
  check("browser_open on this device's serve-sim stream is refused, naming simulator_open",
    !!refused && refused.isError && text(refused).includes(`simulator_open with udid "${target}"`), refused && text(refused));
  const others = serveSimList();
  const otherStreams = (others.streams ?? (others.device ? [others] : [])).filter((s) => s.device !== target);
  for (const s of otherStreams) {
    // Only READ about: a stream somebody else started is never driven here, only refused.
    const r = await browse(`http://localhost:${s.port}/helper/${s.device}/stream.mjpeg`);
    check(`browser_open on another session's stream (${s.device.slice(0, 8)}…) is refused too`, r.isError && text(r).includes("simulator_open"), text(r));
  }
  const before = cards.length;
  const allowedThrough = await browse(`http://127.0.0.1:${SERVER_PORT}/`);
  check("a loopback URL that is NOT a simulator stream goes on to its card, as before",
    cards.slice(before).some((k) => k.tool === "browser_open") && /denied/.test(text(allowedThrough)), text(allowedThrough));

  await client.close();
  c.close();
}

async function teardown() {
  // The stream Realm started for the device this script booted — scoped to that device by the service.
  if (api && simulatorId) await api.call("simulators.stop", { simulatorId }).catch(() => {});
  if (target) { try { execFileSync("xcrun", ["simctl", "shutdown", target], { stdio: "ignore", timeout: 60_000 }); console.log(`(shut ${target} down again)`); } catch { /* already down */ } }
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
