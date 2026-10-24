/**
 * Live check for Settings ▸ Devices (Plan 28 Phase 2)
 * (run with: pnpm build && node apps/desktop/scripts/devices-live.mjs [--stand-in])
 *
 * Boots the BUILT app on a scratch REALM_HOME and drives Settings ▸ Devices in the real window, in the
 * dark face and the light one:
 *
 *   1. The page: in the You group after Notifications, headed Devices, a card saying no phone is paired,
 *      and nothing about the relay while nothing is wrong with it.
 *   2. Pair an iPhone: the sheet's code is decoded by Apple's Vision from a screenshot of the window
 *      and must be the server's own pairing link, with whole pixels per module; the time left counts.
 *   3. A phone scans it: the question is asked in the same sheet; Escape puts it away unanswered and it
 *      is asked again from a row; Pair there pairs the phone, which becomes a row of its own.
 *   4. Notifications grows Notify my iPhone, on, now that a phone is paired, and its switch writes its key.
 *   5. The relay going away is said on the page; Remove asks first, names the phone, and removes it.
 *   6. The line about sleep takes you to General ▸ Power's Keep the Mac awake.
 *
 * Against the real server half (realm-server answering `remote.*`), the phone is the TypeScript test
 * phone Phase 1 built (`apps/server/src/remote/test-phone.ts`) pairing through a local relay
 * (`services/relay/src/node.ts`), both run under tsx in a child process; the relay is pointed at with
 * the `remote.relay` setting before the first code is made. A server without Realm Mobile answers
 * `remote.status` with an error, and then — or with `--stand-in` — the check answers `remote.*` itself,
 * inside the page, so the renderer's half can be seen whole before the server's lands. The check says
 * which it ran against; stand-in passes are the renderer's alone.
 *
 * Screenshots go to apps/desktop/.verify/devices-live (or LIVE_OUT). Ports are env-overridable
 * (LIVE_CDP_PORT, LIVE_SERVER_PORT, LIVE_RELAY_PORT). Touches only its scratch directory, and stops
 * only the processes it started. No message is sent to any agent, so no engine is billed.
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9419);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8977);
const RELAY_PORT = Number(process.env.LIVE_RELAY_PORT ?? 8978);
const shots = process.env.LIVE_OUT ?? path.join(repoRoot, "apps/desktop/.verify/devices-live");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-devices-live-"));
const home = path.join(scratch, "home");
const FORCE_STAND_IN = process.argv.includes("--stand-in");
const PHONE = { name: "Carlton's iPhone", model: "iPhone18,1", modelName: "iPhone 17 Pro" };
/** The row a held request is asked from, once its sheet has been put away. */
const WAITING_ROW = `li[aria-label=${JSON.stringify(`${PHONE.name} is waiting to pair`)}]`;
let electron = null;
let rig = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (v) => JSON.stringify(v);

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
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.code} ${msg.error?.message}`))));
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

const results = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shoot(c, name) {
  // A sheet springs in: a capture taken mid-entrance shows a ghost of it. Every finite animation has
  // ended first; the ones that loop (a spinner, a ring) are left to loop.
  await until(() => evalIn(c, `document.getAnimations().every((a) => a.playState !== "running" || !Number.isFinite(a.effect?.getComputedTiming().endTime))`), 3000, "settled")
    .catch(() => console.log(`  (${name}: still animating after 3 s, captured anyway)`));
  const { data } = await c.send("Page.captureScreenshot", {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${path.relative(repoRoot, file)}`);
  return file;
}

/* ── Reading a QR code the way a phone would: Apple's Vision, from pixels, knowing nothing of uqr ── */
let decoder = null;
function decodeQr(file) {
  if (!decoder) {
    const src = path.join(scratch, "decode-qr.swift");
    fs.writeFileSync(src, `import Foundation
import Vision
import ImageIO
let path = CommandLine.arguments[1]
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { print("unreadable"); exit(2) }
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
for result in request.results ?? [] { print(result.payloadStringValue ?? "") }
`);
    decoder = path.join(scratch, "decode-qr");
    execFileSync("swiftc", ["-O", src, "-o", decoder], { stdio: "pipe" });
  }
  return execFileSync(decoder, [file], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/* ── The stand-in: `remote.*` answered inside the page, for a server that does not have it yet ───── */
function standIn() {
  const Real = window.WebSocket;
  const sockets = new Set();
  const relay = "wss://realm-relay-staging.realm-relay.workers.dev";
  const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const random = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64u(String.fromCharCode(...a)); };
  const fake = { status: { state: "off", relay, macName: "Live Mac", phones: [], pairing: null }, requests: {}, calls: [] };
  // The link PROTOCOL.md §2 describes, at its real length: two ids, two 32-byte keys, a name, an expiry.
  const link = (w, e) => `https://realm.computer/pair#1.${b64u(JSON.stringify({ r: relay, m: random(16), k: random(32), s: random(32), w, n: fake.status.macName, e }))}`;
  const deliver = (sock, msg) => setTimeout(() => { if (sock.readyState === 1) sock.onmessage?.({ data: JSON.stringify(msg) }); }, 5);
  const emit = (event, payload) => { for (const s of sockets) deliver(s, { event, payload }); };
  const changed = (patch) => { fake.status = { ...fake.status, ...patch }; emit("remote.changed", fake.status); };
  const handlers = {
    "remote.status": () => fake.status,
    "remote.pair.start": () => {
      const windowId = random(16);
      const expiresAt = Date.now() + 5 * 60_000;
      changed({ pairing: { windowId, url: link(windowId, expiresAt), expiresAt }, state: fake.status.state === "off" ? "connected" : fake.status.state });
      return fake.status.pairing;
    },
    "remote.pair.cancel": () => { changed({ pairing: null }); return { ok: true }; },
    "remote.pair.answer": ({ requestId, accept }) => {
      const asked = fake.requests[requestId];
      if (!asked) throw new Error(`no pair request ${requestId}`);
      delete fake.requests[requestId];
      const at = Date.now();
      changed(accept ? { phones: [...fake.status.phones, { phoneId: random(16), name: asked.name, model: asked.model, addedAt: at, lastSeen: at }], pairing: null } : {});
      return { ok: true };
    },
    "remote.phones.remove": ({ phoneId }) => { changed({ phones: fake.status.phones.filter((p) => p.phoneId !== phoneId) }); return { ok: true }; },
  };
  // Only the RPC socket — the one offering `realm.<token>` — and only `remote.*` on it: the rest of the
  // app talks to the real server exactly as it always does.
  class StandIn extends Real {
    constructor(url, protocols) {
      super(url, protocols);
      if ([].concat(protocols ?? []).some((p) => String(p).startsWith("realm."))) sockets.add(this);
    }
    send(data) {
      let msg = null;
      try { msg = JSON.parse(data); } catch { /* not JSON: not ours */ }
      const handle = msg && sockets.has(this) ? handlers[msg.method] : undefined;
      if (!handle) return super.send(data);
      fake.calls.push(msg.method);
      try { deliver(this, { id: msg.id, ok: true, result: handle(msg.params ?? {}) }); }
      catch (e) { deliver(this, { id: msg.id, ok: false, error: { code: "STAND_IN", message: e.message } }); }
    }
  }
  window.WebSocket = StandIn;
  window.__standIn = {
    fake, changed,
    request(name, model) {
      const req = { requestId: random(8), windowId: fake.status.pairing?.windowId ?? "none", name, model };
      fake.requests[req.requestId] = req;
      emit("remote.pairRequest", req);
      return req;
    },
  };
}

/* ── The real phone: Phase 1's TestPhone and local relay, under tsx, driven over stdin ──────────── */
async function startRig() {
  const file = path.join(scratch, "phone-rig.mts");
  fs.writeFileSync(file, `import { createInterface } from "node:readline";
import { startLocalRelay } from ${js(path.join(repoRoot, "services/relay/src/node.ts"))};
import { TestPhone } from ${js(path.join(repoRoot, "apps/server/src/remote/test-phone.ts"))};
const port = Number(process.env.RELAY_PORT);
let relay = await startLocalRelay({ port });
console.log("relay " + relay.url);
const handle = async (cmd: string, args: string[]) => {
  if (cmd === "pair") {
    const r = await new TestPhone().pair(args[0]!, { name: args[1], model: args[2], timeoutMs: 120_000 });
    console.log(r.ok ? "paired ok" : "paired no " + r.reason);
  }
  if (cmd === "stop-relay") { await relay.close(); console.log("relay stopped"); }
  if (cmd === "start-relay") { relay = await startLocalRelay({ port }); console.log("relay " + relay.url); }
};
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, ...args] = line.split("\\t");
  handle(cmd!, args).catch((e) => console.log("error " + cmd + " " + (e as Error).message));
}
`);
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  const child = spawn(tsx, [file], { cwd: path.join(repoRoot, "apps/server"), env: { ...process.env, RELAY_PORT: String(RELAY_PORT) }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const waiters = new Set();
  createInterface({ input: child.stdout }).on("line", (line) => { lines.push(line); for (const w of [...waiters]) w(); });
  child.stderr.on("data", (d) => process.stderr.write(`    [rig] ${d}`));
  const next = (pattern, ms, tag) => new Promise((resolve, reject) => {
    const scan = () => { const i = lines.findIndex((l) => pattern.test(l)); if (i < 0) return false; waiters.delete(scan); clearTimeout(timer); resolve(lines.splice(i, 1)[0]); return true; };
    const timer = setTimeout(() => { waiters.delete(scan); reject(new Error(`timeout:${tag}`)); }, ms);
    if (!scan()) waiters.add(scan);
  });
  const url = (await next(/^relay /, 30_000, "local relay")).slice("relay ".length);
  /** Whether a line has come that `pattern` matches, without taking it. */
  const has = (pattern) => lines.some((l) => pattern.test(l));
  return { child, url, next, has, send: (...parts) => child.stdin.write(`${parts.join("\t")}\n`) };
}

/* ── The window ─────────────────────────────────────────────────────────────────────────────────── */
async function holdKey(c) {
  // Opened behind the person's own window it is never key, and greys its accent: hold it key.
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute("data-window-inactive");
    new MutationObserver(() => root.hasAttribute("data-window-inactive") && root.removeAttribute("data-window-inactive")).observe(root, { attributes: true }); return true; })()`);
}

async function setTheme(c, mode) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${js(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${js(label)});
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${js(mode)}`), 4000, `mode ${mode}`);
  await sleep(250);
}

async function openSettingsPage(c, value) {
  const open = `!!document.querySelector('input[name="settings-page-tab"]')`;
  if (!(await evalIn(c, open))) await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, open), 8000, "Settings");
  await evalIn(c, `(() => { document.querySelector('input[name="settings-page-tab"][value=${js(value)}]').click(); return true; })()`);
  await sleep(400);
}

/** Click the button whose accessible name is `name`, inside `scope` (a selector) or anywhere. */
const click = (c, name, scope = "body") => evalIn(c, `(() => {
  const root = document.querySelector(${js(scope)});
  const b = root && [...root.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") ?? x.textContent.trim()) === ${js(name)});
  if (!b || b.disabled) return false; b.click(); return true; })()`);
const text = (c, selector) => evalIn(c, `document.querySelector(${js(selector)})?.textContent ?? null`);
const dialogName = (c) => evalIn(c, `document.querySelector('.sheet')?.getAttribute("aria-label") ?? null`);
/** A real Escape, through the input pipeline to whatever has focus. One dispatched on `window` itself
 *  reaches every window listener at once — the page's too, which a key press never does while a sheet's
 *  capturing listener stops it on the way down — and closes the whole page. */
const escape = async (c) => {
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, RELAY_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const built = path.join(repoRoot, "apps/desktop/out/renderer/assets");
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js")) || !fs.existsSync(path.join(repoRoot, "apps/server/dist/main.js"))) throw new Error("build first: pnpm build");
  // A build from before the page existed would fail every check below for a reason the code has not got.
  check("the build is this tree's: its renderer has Settings ▸ Devices",
    fs.readdirSync(built).some((f) => f.endsWith(".js") && fs.readFileSync(path.join(built, f), "utf8").includes("Pair an iPhone")));
  fs.mkdirSync(shots, { recursive: true });

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1320, height: 900, deviceScaleFactor: 2, mobile: false });

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const served = FORCE_STAND_IN ? null : await api.call("remote.status", {}).catch((e) => ({ error: e.message }));
  const real = served !== null && !("error" in served);
  if (real) {
    console.log("against the real server half: remote.status answered");
    rig = await startRig();
    console.log(`  local relay ${rig.url}`);
    // Before the first code: the link starts with the first window, on the relay this names.
    await api.call("settings.set", { key: "remote.relay", value: rig.url });
  } else {
    console.log(FORCE_STAND_IN ? "against the in-page stand-in (--stand-in)"
      : `PENDING the server half: remote.status answered ${served.error} — running the renderer against the in-page stand-in`);
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${standIn.toString()})();` });
    await c.send("Page.reload", {});
    await until(() => evalIn(c, `!!window.__standIn && !!document.querySelector('.composer')`), 30_000, "reload with the stand-in");
  }
  await holdKey(c);

  /** What the server says now: the real one over RPC, or the stand-in inside the page. */
  const status = () => (real ? api.call("remote.status", {}) : evalIn(c, `window.__standIn.fake.status`));
  /** A phone scanning the code in the sheet: the test phone through the local relay, or the stand-in. */
  const scan = async (url) => {
    if (real) rig.send("pair", url, PHONE.name, PHONE.model);
    else await evalIn(c, `(() => { window.__standIn.request(${js(PHONE.name)}, ${js(PHONE.model)}); return true; })()`);
  };

  for (const mode of ["dark", "light"]) {
    console.log(`── the ${mode} face ──`);
    await setTheme(c, mode);
    await openSettingsPage(c, "devices");

    // 1. The page, with no phone.
    const rail = await evalIn(c, `[...document.querySelectorAll('.page-rail-list')].map((g) => [g.querySelector('.page-rail-head')?.textContent, [...g.querySelectorAll('.page-rail-tab')].map((t) => t.textContent.trim())])`);
    const you = rail.find(([head]) => head === "You")?.[1] ?? [];
    check(`${mode}: Devices is in You, after Notifications`, you.join(",") === "General,Appearance,Keys,Notifications,Devices", you);
    check(`${mode}: the page is headed Devices`, (await text(c, ".page-head h1")) === "Devices");
    await until(() => evalIn(c, `!!document.querySelector('[data-setting="pair-iphone"] button')`), 8000, "Pair an iPhone");
    check(`${mode}: no phone — the empty card, and nothing said about the relay`,
      (await text(c, ".device-empty .settings-row-name")) === "No iPhone paired yet." && !(await evalIn(c, `!!document.querySelector('.page-content [role=alert]')`)));
    await shoot(c, `01-devices-empty-${mode}`);

    // 2. Pair an iPhone: the code, decoded from the window's own pixels.
    await click(c, "Pair an iPhone");
    await until(() => evalIn(c, `!!document.querySelector('svg[aria-label="Pairing code"]')`), 10_000, "the code");
    await sleep(500);
    let pairing = (await status()).pairing;
    const box = await evalIn(c, `(() => { const s = document.querySelector('svg[aria-label="Pairing code"]'); const r = s.getBoundingClientRect();
      return { w: r.width, h: r.height, modules: Number(s.getAttribute("viewBox").split(" ")[2]),
        expiry: document.querySelector(".pair-expiry")?.textContent ?? null, title: document.querySelector('.sheet')?.getAttribute("aria-label") }; })()`);
    check(`${mode}: the sheet is Pair an iPhone, with the code and its time left`, box.title === "Pair an iPhone" && /^Expires in [45]:\d\d$/.test(box.expiry ?? ""), box);
    check(`${mode}: whole pixels per module, the quiet zone included`, box.w === box.h && Number.isInteger(box.w / box.modules) && box.w / box.modules >= 3, box);
    const sheetShot = await shoot(c, `02-pair-code-${mode}`);
    const decoded = decodeQr(sheetShot);
    check(`${mode}: Vision reads the code off the window, and it is the server's pairing link`, pairing !== null && decoded.includes(pairing.url),
      { decoded: decoded.map((d) => `${d.slice(0, 40)}…`), expected: pairing ? `${pairing.url.slice(0, 40)}…` : null });
    const before = box.expiry;
    await sleep(2200);
    check(`${mode}: the time left counts down`, (await text(c, ".pair-expiry")) !== before, { before, after: await text(c, ".pair-expiry") });

    // A window closed at the server — another Realm window cancelling it, say — takes the code away,
    // keeps the sheet's size, and offers a new one, which is a new window.
    const sheetHeight = () => evalIn(c, `document.querySelector(".sheet").getBoundingClientRect().height`);
    const heightWithCode = await sheetHeight();
    if (real) await api.call("remote.pair.cancel", {});
    else await evalIn(c, `(() => { window.__standIn.changed({ pairing: null }); return true; })()`);
    await until(() => evalIn(c, `document.querySelector(".pair-code-gone p")?.textContent === "This code no longer works."`), 10_000, "the code gone");
    const gone = await evalIn(c, `(() => { const r = document.querySelector(".pair-code-gone").getBoundingClientRect(); return { w: r.width, h: r.height, code: !!document.querySelector('svg[aria-label="Pairing code"]') }; })()`);
    gone.sheet = [heightWithCode, await sheetHeight()];
    check(`${mode}: a closed window takes the code away, and the sheet holds still`, !gone.code && gone.w === box.w && gone.h === box.h && gone.sheet[0] === gone.sheet[1], gone);
    await shoot(c, `02b-pair-code-gone-${mode}`);
    await click(c, "Show a new code", ".sheet");
    await until(async () => { const p = (await status()).pairing; return p && p.windowId !== pairing.windowId ? p : null; }, 10_000, "a new window");
    await until(() => evalIn(c, `!!document.querySelector('svg[aria-label="Pairing code"]')`), 10_000, "the new code");
    pairing = (await status()).pairing;
    check(`${mode}: Show a new code opens a new window, and draws its code`, true);

    // 3. A phone scans it: asked in the same sheet; put away, asked from a row; paired from there.
    await scan(pairing.url);
    await until(async () => (await dialogName(c)) === `Pair ${PHONE.name}?`, 30_000, "the question");
    const asked = await evalIn(c, `(() => { const d = document.querySelector('.sheet');
      return { text: d.textContent, dialogs: document.querySelectorAll('.sheet').length,
        consequenceLines: Math.round(d.querySelector('.device-consequence').getBoundingClientRect().height / 20),
        focusOnAnswer: ["Pair", "Cancel"].includes(document.activeElement?.textContent?.trim() ?? "") }; })()`);
    check(`${mode}: the question names the phone, its model and what yes gives it, in the one sheet`,
      asked.text.includes(PHONE.modelName) && asked.text.includes("It can read every session on this Mac and answer for you.") && asked.dialogs === 1, asked);
    check(`${mode}: it arrives without the keyboard on an answer`, !asked.focusOnAnswer);
    await shoot(c, `03-pair-request-${mode}`);
    // Answers given so far: the stand-in's own log, or — against the real server — whether the phone has
    // heard anything back, which a yes, a no or a closed window would all have sent it.
    const answers = () => (real ? Number(rig.has(/^paired /)) : evalIn(c, `window.__standIn.fake.calls.filter((m) => m === "remote.pair.answer" || m === "remote.pair.cancel").length`));
    const answered = await answers();
    await escape(c);
    await until(async () => (await dialogName(c)) === null, 5000, "the sheet away");
    await sleep(500);
    const after = await status();
    check(`${mode}: Escape answered nothing and left the window open`,
      after.pairing?.windowId === pairing.windowId && after.phones.length === 0 && (await answers()) === answered,
      { pairing: after.pairing?.windowId, phones: after.phones.length });
    check(`${mode}: the question is asked again from the page`, await evalIn(c, `!!document.querySelector(${js(WAITING_ROW)})`));
    check(`${mode}: …and is the page's one accent — Pair an iPhone steps down beside it`,
      await evalIn(c, `[...document.querySelectorAll('.page-content .btn.primary')].map((b) => b.textContent.trim()).join() === "Pair"`));
    await shoot(c, `04-pair-request-row-${mode}`);
    await click(c, "Pair", WAITING_ROW);
    if (real) check(`${mode}: the phone hears yes`, (await rig.next(/^paired /, 30_000, "the phone's answer")) === "paired ok");
    await until(async () => (await status()).phones.length === 1, 15_000, "the phone paired");
    await until(() => evalIn(c, `[...document.querySelectorAll('.device-row .settings-row-name')].some((n) => n.textContent === ${js(PHONE.name)})`), 10_000, "the phone's row");
    const row = await evalIn(c, `[...document.querySelectorAll('.device-row')].map((r) => r.textContent).find((t) => t.includes(${js(PHONE.name)}))`);
    check(`${mode}: the phone is a row — name, model, last seen`, row.includes(`${PHONE.modelName} · Last seen just now`) || row.includes(`${PHONE.modelName} · Paired just now`), row);
    await shoot(c, `05-phones-${mode}`);

    // 4. Notifications: the iPhone row, now that there is a phone for it.
    await openSettingsPage(c, "notifications");
    await until(() => evalIn(c, `!!document.querySelector('input[aria-label="Notify my iPhone"]')`), 8000, "the iPhone row");
    const sw = await evalIn(c, `(() => { const s = document.querySelector('input[aria-label="Notify my iPhone"]'); const li = s.closest("li");
      return { checked: s.checked, afterSlack: !!li.previousElementSibling?.querySelector('input[aria-label="Slack webhook URL"]') }; })()`);
    check(`${mode}: Notify my iPhone is drawn beside the relays, on`, sw.checked && sw.afterSlack, sw);
    await evalIn(c, `(() => { document.querySelector('input[aria-label="Notify my iPhone"]').scrollIntoView({ block: "center" }); return true; })()`);
    await sleep(300);
    await shoot(c, `06-notifications-${mode}`);
    await evalIn(c, `(() => { document.querySelector('input[aria-label="Notify my iPhone"]').click(); return true; })()`);
    await until(async () => (await api.call("settings.get", { key: "notifications.relay.iphone" })).value === false, 5000, "the switch written");
    await evalIn(c, `(() => { document.querySelector('input[aria-label="Notify my iPhone"]').click(); return true; })()`);
    await until(async () => (await api.call("settings.get", { key: "notifications.relay.iphone" })).value === true, 5000, "the switch written back");
    check(`${mode}: its switch writes notifications.relay.iphone`, true);

    // 5. The relay going away, said on the page; then Remove, asked first.
    await openSettingsPage(c, "devices");
    if (real) {
      rig.send("stop-relay");
      await rig.next(/^relay stopped/, 10_000, "relay stopped");
    } else {
      await evalIn(c, `(() => { window.__standIn.changed({ state: "offline" }); return true; })()`);
    }
    const offline = await until(() => evalIn(c, `document.querySelector('.page-content [role=alert]')?.textContent ?? null`), 60_000, "the offline line").catch(() => null);
    check(`${mode}: offline is said in the plan's words`, offline === "Can't reach the relay. Your phone shows this Mac as offline.", offline);
    await shoot(c, `07-offline-${mode}`);
    if (real) {
      // Locked is a daemon that restarted with no window to hand it its key, which this check does not
      // stage against the real server; the stand-in shows its line below.
      rig.send("start-relay");
      await rig.next(/^relay /, 10_000, "relay back");
    } else {
      await evalIn(c, `(() => { window.__standIn.changed({ state: "locked" }); return true; })()`);
      await until(() => evalIn(c, `/unlocks once Realm's window/.test(document.querySelector('.page-content [role=alert]')?.textContent ?? "")`), 5000, "the locked line");
      check(`${mode}: locked is said, and Pair waits for it`, await evalIn(c, `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Pair an iPhone")?.disabled === true`));
      await shoot(c, `08-locked-${mode}`);
      await evalIn(c, `(() => { window.__standIn.changed({ state: "connected" }); return true; })()`);
    }
    await until(() => evalIn(c, `!document.querySelector('.page-content [role=alert]')`), 60_000, "the line gone once the relay is back")
      .then(() => check(`${mode}: nothing is said once the link is up again`, true))
      .catch(() => check(`${mode}: nothing is said once the link is up again`, false));

    await click(c, `Remove ${PHONE.name}`);
    await until(async () => (await dialogName(c)) === `Remove ${PHONE.name}?`, 5000, "the remove question");
    check(`${mode}: Remove asks first, naming the phone and what it loses`,
      (await text(c, ".sheet")).includes("It will no longer see or answer sessions on this Mac.") && (await status()).phones.length === 1);
    await shoot(c, `09-remove-${mode}`);
    await escape(c);
    await until(async () => (await dialogName(c)) === null, 5000, "the remove question away");
    check(`${mode}: Escape keeps the phone`, (await status()).phones.length === 1);
    await click(c, `Remove ${PHONE.name}`);
    await until(async () => (await dialogName(c)) === `Remove ${PHONE.name}?`, 5000, "the remove question again");
    await click(c, "Remove", ".sheet");
    await until(async () => (await status()).phones.length === 0, 10_000, "the phone removed");
    await until(() => evalIn(c, `!!document.querySelector('.device-empty')`), 5000, "the empty card back");
    check(`${mode}: the confirm removes it, and the page is back to no phone`, true);

    // 6. The line about sleep, and where it goes.
    await click(c, "Keep the Mac awake while agents work");
    await until(() => evalIn(c, `document.activeElement?.getAttribute("aria-label") === "Keep the Mac awake while agents work"`), 5000, "General ▸ Power");
    check(`${mode}: the sleep line lands on General ▸ Power's switch`,
      await evalIn(c, `document.querySelector('input[name="settings-page-tab"][value="general"]').checked && !!document.activeElement.closest('[data-setting="prevent-sleep"]')`));
  }

  if (!real) console.log("PENDING the server half: every check above ran against the in-page stand-in for remote.*; rerun once realm-server answers remote.status");
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    rig?.child.kill("SIGKILL");
    electron?.kill("SIGKILL");
    await stopDaemons(home);
    // Anything still listening on the three ports is this run's, started under its scratch home.
    try { execFileSync("bash", ["-c", `lsof -nP -tiTCP:${SERVER_PORT},${CDP_PORT},${RELAY_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]); } catch { /* nothing left */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { rig?.child.kill("SIGKILL"); electron?.kill("SIGKILL"); process.exit(1); });
