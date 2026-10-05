/**
 * Live check for recording an app for Laya (run with: pnpm build && node apps/desktop/scripts/laya-record-live.mjs)
 *
 *   Record my use of this app ── its sheet's Start ── laya.record ──▶ LayaRecorder ── SimulatorService.ax ──▶ serve-sim
 *      ──▶ a real simulator, driven by a stub agent's simulator tools while the recorder only reads
 *
 * What only a real Mac can say:
 *   1. The control is under a real device, opens a sheet that records nothing until its Start, then
 *      records the app in front — Settings — and becomes the row that stops it, with the rail's Stop.
 *   2. Each new screen of Settings a walk reaches is kept, read from the real device's tree.
 *   3. The home screen and another app (Calendar) are read and kept nothing of.
 *   4. Stop ends it; Settings ▸ Laya counts what it kept; what is on disk holds no value but a
 *      switch's, no long text, and no screen of any other app.
 *   5. On the home screen, Start refuses in the sheet — there is no app in front to learn — and
 *      records nothing.
 *
 * It boots a SHUT-DOWN iPhone (never one somebody has up), and at the end stops the stream Realm started
 * for it and shuts it down again. No billed call: the session is the fake agent's, titled at creation.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9241), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8801);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-laya-record-live-"));
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1500, height: 900 };
const TITLE = "Laya recording live check";
const OUT = (tag) => path.join(os.tmpdir(), `realm-laya-record-${tag}.png`);
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

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}
const serveSimList = (udid) => {
  try { return JSON.parse(execFileSync("npx", ["--yes", "serve-sim@latest", "--list", ...(udid ? [udid] : [])], { encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop()); }
  catch { return { running: false }; }
};

/** A PNG of one element's box, from the window. `el` is an expression that finds it. */
async function shoot(c, el, tag) {
  const clip = await evalIn(c, `(() => { const el = ${el}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, scale: 2 }; })()`);
  if (!clip) return null;
  const shot = await c.send("Page.captureScreenshot", { format: "png", clip });
  fs.writeFileSync(OUT(tag), Buffer.from(shot.data, "base64"));
  return OUT(tag);
}

let target = null;
let simulatorId = null;
let api = null;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_GEMINI_BIN: agent,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
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

  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: card.toolName.startsWith("simulator_") ? "allow" : "deny" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
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
  const client = new Client({ name: "laya-record-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = async (name, args = {}) => {
    const t0 = Date.now();
    console.log(`INFO calling ${name}`);
    try { return await client.callTool({ name: `realm-simulator__${name}`, arguments: args }, undefined, { timeout: 300_000 }); }
    finally { console.log(`INFO ${name} answered in ${((Date.now() - t0) / 1000).toFixed(1)} s`); }
  };

  // ── A device nobody has up, open in a pane ─────────────────────────────────────────────────
  const listed = text(await call("simulator_list"));
  const pick = process.env.LIVE_SIM_UDID ?? listed.match(/^\s+(\S+) — iPhone[^·]* · [^·]+ · not running$/m)?.[1];
  if (!pick) throw new Error(`no shut-down iPhone to use:\n${listed}`);
  if (serveSimList(pick).running) throw new Error(`${pick} is already being streamed by somebody — refusing to touch it`);
  target = pick;
  let opened = await call("simulator_open", { udid: target });
  simulatorId = text(opened).match(/simulator pane (\S+?)[,\s]/)?.[1] ?? null;
  if (/still/.test(text(opened))) {
    await until(async () => new RegExp(`${simulatorId} \\(running\\)`).test(text(await call("simulator_list"))), 240_000, "the stream");
    opened = await call("simulator_open", { udid: target });
  }
  const deviceName = text(opened).match(/^Opened (.+?) \(/)?.[1] ?? null;
  note("opened", text(opened).split("\n")[0]);
  if (opened.isError || !simulatorId) throw new Error(`the device did not open: ${text(opened)}`);

  /* The screen as the check needs it: readable, with `app` in front and no system alert over it. A
     freshly booted iPhone greets its home screen with one a few seconds in (widgets asking for
     location), answered "Don't Allow" on this simulator; and the read straight after a press can be
     the device's "not yet". */
  async function inFront(app) {
    for (let i = 0; i < 24; i++) {
      const r = await call("simulator_elements", { simulatorId });
      const listing = text(r);
      const deny = r.isError ? null : listing.match(/^\[(\d+)\] Button "Don’t Allow"/m)?.[1];
      if (deny) {
        note("a system alert was up; answered Don't Allow", listing.match(/StaticText "([^"]*)"/)?.[1] ?? null);
        await call("simulator_tap", { simulatorId, intent: "dismiss the system alert", element: Number(deny) });
      } else if (!r.isError && listing.split("\n").some((l) => l.trim() === `app: ${app}`)) {
        return true;
      }
      await sleep(1_000);
    }
    return false;
  }
  // A refusal is an error toast at the window's foot (components/Toasts.tsx), not a bar.
  const errorBar = () => evalIn(c, `document.querySelector('.toast[data-tone="error"] .toast-text')?.textContent ?? null`);
  const clearError = () => evalIn(c, `(() => { document.querySelector('.toast[data-tone="error"] .toast-close')?.click(); return true; })()`);

  const status = () => api.call("laya.status", {});
  const RECORD = `document.querySelector('.sim-record-start')`;
  const START = `[...document.querySelectorAll('.sheet button')].find((b) => b.textContent.trim() === "Start recording")`;
  const sheetOpen = () => evalIn(c, `!!document.querySelector('.sheet[aria-label="Record your use of this app"]')`);
  const stopIn = (where, label) => `document.querySelector(${JSON.stringify(`${where}[aria-label="${label}"]`)})`;

  // ── 5 first: on the home screen, Record refuses and records nothing ──────────────────────
  await call("simulator_press", { simulatorId, intent: "go to the home screen", key: "home" });
  check("the home screen is in front, readable, with no alert over it", await inFront("(no name)"));
  const recordButton = await until(() => evalIn(c, `(() => { const b = ${RECORD}; return b ? { disabled: b.disabled, text: b.textContent.trim() } : null; })()`), 20_000, "Record under the device").catch(() => null);
  check("under the device, Record says what it records, and is enabled", recordButton?.text === "Record my use of this app…" && !recordButton.disabled, recordButton);
  await evalIn(c, `(() => { ${RECORD}.click(); return true; })()`);
  check("it opens the sheet", await until(sheetOpen, 5_000, "the sheet").catch(() => false));
  check("…and opening it records nothing", (await status()).recording === null);
  await evalIn(c, `(() => { ${START}.click(); return true; })()`);
  const refusal = await until(() => evalIn(c, `document.querySelector('.laya-record-refused')?.textContent ?? null`), 10_000, "the refusal").catch(() => null);
  check("on the home screen, Start refuses in the sheet, in words — there is no app in front to learn", /Open the app you want Laya to learn on .* first — the home screen, or a system alert over it, is in front\./.test(refusal ?? ""), refusal);
  check("…the sheet stays open, the error bar says nothing, and nothing is recording", await sheetOpen() && (await errorBar()) === null && (await status()).recording === null);
  await evalIn(c, `(() => { [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.trim() === "Cancel").click(); return true; })()`);

  // ── 1. Settings in front: Record records it, and the toggle becomes its Stop ─────────────
  const launched = await call("simulator_launch", { simulatorId, bundleId: "com.apple.Preferences" });
  check("Settings is launched in front", !launched.isError && await inFront("Settings"), text(launched).split("\n")[0]);
  await evalIn(c, `(() => { ${RECORD}.click(); return true; })()`);
  await until(sheetOpen, 5_000, "the sheet again");
  await evalIn(c, `(() => { ${START}.click(); return true; })()`);
  const started = await until(async () => (await status()).recording, 15_000, "the recording").catch(() => null);
  if (!started) note("no recording; the error bar says", await errorBar());
  check("Record records the app in front, Settings, on this device", started?.apps?.length === 1 && started.apps[0] === "Settings" && (!deviceName || started.device === deviceName), started);
  const STOP = "Stop recording Settings for Laya";
  const recordingRow = await until(() => evalIn(c, `(() => { const r = document.querySelector('.sim-recording'); return r && ${stopIn(".sim-recording-stop", STOP)} ? r.innerText : null; })()`), 10_000, "the recording row").catch(() => null);
  check("the row under the device is now the recording: what it keeps, how many, and Stop", /Recording Settings for Laya/.test(recordingRow ?? "") && /\d+ screens? kept/.test(recordingRow ?? ""), recordingRow);
  check("…and the rail carries its Stop too", await evalIn(c, `!!${stopIn(".rail-recording", STOP)}`));
  note("the device while recording", await shoot(c, `document.querySelector('.sim-pane')`, "pane").catch((e) => String(e)));

  // ── 2. Each new screen a walk reaches is kept ─────────────────────────────────────────────
  const first = await until(async () => { const r = (await status()).recording; return r && r.screens >= 1 ? r : null; }, 15_000, "the first screen").catch(() => null);
  check("the screen Settings opened on is kept within seconds", !!first, first);
  const walked = await call("simulator_do", { simulatorId, intent: "find the iOS version", path: ["General", "About"] });
  check("a walk reaches General › About", !walked.isError, text(walked).split("\n")[0]);
  const kept = await until(async () => { const r = (await status()).recording; return r && r.screens >= 3 ? r : null; }, 20_000, "three screens").catch(async () => (await status()).recording);
  check("each new screen of the walk is kept: the root, General and About", (kept?.screens ?? 0) >= 3 && JSON.stringify(kept?.seen) === '["Settings"]', kept);

  // ── 3. The home screen and another app are read and kept nothing of ──────────────────────
  // Measured once the walk's last screen has stopped changing: About fills in its values after it
  // arrives, and a screen that changed that much is a new screen of Settings, kept a moment later.
  let before = -1;
  for (let stable = 0, last = -1; stable < 3; ) {
    await sleep(1_000);
    const n = (await status()).recording.screens;
    stable = n === last ? stable + 1 : 0;
    last = before = n;
  }
  await call("simulator_press", { simulatorId, intent: "go home", key: "home" });
  await sleep(3_000);
  await call("simulator_launch", { simulatorId, bundleId: "com.apple.mobilecal" });
  await sleep(4_000);
  const after = (await status()).recording;
  check("the home screen and Calendar are kept nothing of", after.screens === before && JSON.stringify(after.seen) === '["Settings"]', { before, after: after.screens, seen: after.seen });

  // ── 4. Stop, and what it kept ─────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { ${stopIn(".sim-recording-stop", STOP)}.click(); return true; })()`);
  const stopped = await until(async () => { const s = await status(); return s.recording === null ? s : null; }, 10_000, "the stop").catch(() => null);
  check("the row's Stop stops it, and Settings ▸ Laya's counts say what it kept", !!stopped && stopped.recorded?.recordings === 1 && stopped.recorded.screens === after.screens && JSON.stringify(stopped.recorded.apps) === '["Settings"]', stopped?.recorded);
  const back = await until(() => evalIn(c, `!!${RECORD} && !document.querySelector('.rail-recording')`), 10_000, "Record again").catch(() => false);
  check("…the row reads Record again, and the rail's Stop is gone", back);

  const dir = path.join(home, "laya", "recordings");
  const recs = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const screens = recs.flatMap((r) => { const d = path.join(dir, r, "screens"); return fs.existsSync(d) ? fs.readdirSync(d).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))) : []; });
  const els = screens.flatMap((s) => s.elements);
  const valued = els.filter((e) => e.value !== undefined);
  check("on disk: one recording, its screens all of Settings", recs.length === 1 && screens.length === after.screens && screens.every((s) => s.app === "Settings"), { recordings: recs.length, screens: screens.length });
  check("on disk: no value but a switch's on or off, and no label past 60 characters",
    valued.every((e) => /switch|toggle|check ?box/i.test(e.role) && (e.value === "0" || e.value === "1")) && els.every((e) => e.label.length <= 60),
    { elements: els.length, valued: valued.map((e) => `${e.role}=${e.value}`).slice(0, 6), longest: Math.max(0, ...els.map((e) => e.label.length)) });
  check("on disk: the walk's screens are there by their own words", ["General", "About"].every((w) => els.some((e) => e.label === w)), screens.map((s) => s.elements.length));

  // Settings is reached from the palette (it has no row in the sidebar's destinations), one step at a
  // time: nothing awaited inside the page, where a re-render can collect the promise.
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette-list")`), 5_000, "the palette");
  await evalIn(c, `(() => { [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /settings/i.test(b.textContent))?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 10_000, "the Settings page");
  const row = await until(() => evalIn(c, `(() => { const li = [...document.querySelectorAll('.laya-recordings')][0]; if (!li) return null; li.scrollIntoView({ block: "center" }); return li.innerText; })()`), 15_000, "the Recordings row").catch(() => null);
  check("Settings ▸ Laya ▸ Recordings counts the screens of Settings, with Delete", !!row && new RegExp(`${after.screens} screens? of Settings`).test(row) && /Delete recordings/.test(row), row);
  await sleep(300);
  note("Settings row", await shoot(c, `document.querySelector(".laya-recordings")`, "settings-row").catch((e) => String(e)));
  // The whole window, for where the page and the device sit — a clip says nothing about what is over it.
  const whole = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT("window"), Buffer.from(whole.data, "base64"));
  note("window", OUT("window"));
  note("Recordings row box, and its pane's", await evalIn(c, `(() => { const r = document.querySelector(".laya-recordings"); const p = r?.closest(".settings-page-pane"); const box = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return r && p ? { row: box(r), page: box(p) } : null; })()`));

  await client.close();
  c.close();
}

async function teardown() {
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
