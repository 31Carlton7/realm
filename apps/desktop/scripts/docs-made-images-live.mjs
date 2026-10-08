/**
 * Live check: a picture an agent made from a shell command, in ANOTHER space's folder, is listed in the
 * documents pane (run with: pnpm build && node apps/desktop/scripts/docs-made-images-live.mjs)
 *
 * The report: an aurafarm deck composed by a Realm-space session into the Versed space's folder, by
 * Bash, never reached the documents pane, because no write tool named a slide. Now the server sweeps
 * the folders a turn named when it settles and writes `files_made`, which the Library's index reads.
 * This boots the BUILT app on a scratch REALM_HOME with the scripted agent (nothing billed), seeds a
 * second space "Versed" (a plain folder, no git), and has a session in the first space run the fake's
 * "Compose the deck" turn: a Bash call `cd ../versed/content/decks && node compose.mjs deck v1`, held
 * on its permission while this script writes the real 1080×1920 slide the command would have. Checks:
 *
 *   1. After the settle, the session's own documents home lists 01.png under This session, as an image,
 *      with its folder as the detail.
 *   2. Its row opens the media viewer, which decodes the slide at its natural size.
 *   3. The profile's Library, which every other pane's Library section reads, lists it as made in the session.
 *
 * Ports: LIVE_SERVER_PORT (8793), LIVE_CDP_PORT (9233). Screenshots go to LIVE_OUT_DIR. Kills only what
 * listens on its own ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9233);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8793);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-made-images-live-"));
const home = path.join(scratch, "home");
const TITLE = "Investigate missing features";
const VIEWPORT = { width: 1560, height: 940 };
const OUT = (tag) => path.join(OUT_DIR, `made-images-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
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
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(200);
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** A button by its visible text inside `scope`. */
const clickText = (scope, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`;
/** The names a home section lists, in order. */
const namesIn = (section) => `[...(document.querySelector('.docs-home section[aria-label=${JSON.stringify(section)}]')?.querySelectorAll('.docs-home-name') ?? [])].map((n) => n.textContent)`;
/** The centre of the element `selector` matches, for a real pointer to go to. */
const centreOf = (c, selector) => evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
async function pointer(c, type, at) { await c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }); }
async function realClick(c, at) { await pointer(c, "mouseMoved", at); await pointer(c, "mousePressed", at); await pointer(c, "mouseReleased", at); }

/** A gradient, written by hand so the check needs nothing installed to make a picture. */
function gradientPng(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([Math.round((x * 255) / w), Math.round((y * 255) / h), 160], 1 + x * 3);
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}


async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_HTML_MENUS: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`;
  await evalIn(c, awake);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const versed = await api.call("spaces.create", { profileId: space.profileId, name: "Versed" });
  note("folders", { realm: space.folderPath, versed: versed.folderPath });
  check("Versed's folder sits beside the first space's, so ../versed reaches it", path.dirname(versed.folderPath) === path.dirname(space.folderPath)
    && path.basename(versed.folderPath) === "versed", versed.folderPath);
  check("Versed is a plain folder, not a git checkout", !fs.existsSync(path.join(versed.folderPath, ".git")));
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);
  await openSideTool(c, TITLE, "Documents");
  await until(() => evalIn(c, `!!document.querySelector('.docs-home')`), 10_000, "home");

  await api.call("sessions.send", { id: session.id, text: "Compose the deck for Versed", attachments: [], mentions: [] });
  const request = await until(async () => (await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 500 }))
    .find((x) => x.event.type === "permission_request"), 20_000, "the compose call's permission");
  // What `node compose.mjs deck v1` would have left: a real 1080×1920 slide, written while the turn is open.
  const slide = path.join(versed.folderPath, "content/decks/deck/v1/01.png");
  fs.mkdirSync(path.dirname(slide), { recursive: true });
  fs.writeFileSync(slide, gradientPng(1080, 1920));
  fs.writeFileSync(path.join(path.dirname(slide), "deck.json"), "{}");
  await api.call("sessions.respondPermission", { id: session.id, requestId: request.event.payload.requestId, decision: "allow" });
  const made = await until(async () => (await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 500 }))
    .find((x) => x.event.type === "files_made"), 20_000, "files_made");
  note("files_made", made.event.payload);
  check("the settle wrote files_made naming the slide, and not the deck's json", made.event.payload.files.length === 1 && made.event.payload.files[0].path === slide, made.event.payload);

  await until(async () => (await evalIn(c, namesIn("This session"))).includes("01.png"), 15_000, "the slide in This session");
  await sleep(600);
  const row = await evalIn(c, `(() => {
    const r = [...document.querySelectorAll('.docs-home section[aria-label="This session"] .docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === '01.png');
    return r ? { detail: r.querySelector('.docs-home-detail')?.textContent ?? null, type: r.querySelector('.docs-home-glyph')?.dataset.type ?? null } : null; })()`);
  note("row", row);
  check("This session lists the slide as an image, with the Versed deck folder as its detail",
    row?.type === "image" && /versed\/content\/decks\/deck\/v1/.test(row?.detail ?? ""), row);
  await evalIn(c, `(() => { document.activeElement?.blur?.(); return true; })()`);
  await shot(c, "1-session-home");

  await evalIn(c, `(() => { [...document.querySelectorAll('.docs-home section[aria-label="This session"] .docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === '01.png').click(); return true; })()`);
  const img = await until(() => evalIn(c, `(() => { const i = document.querySelector('.media-viewer img');
    return i && i.complete && i.naturalWidth > 0 ? { w: i.naturalWidth, h: i.naturalHeight } : null; })()`), 15_000, "the viewer's image").catch(() => null);
  check("the row opens the media viewer, which decodes the slide at 1080×1920", img?.w === 1080 && img?.h === 1920, img);
  await sleep(400);
  await shot(c, "2-viewer");
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(500);

  // The profile's Library — what every other pane's Library section reads, the Versed space's included.
  const lib = await api.call("library.artifacts", { profileId: space.profileId, perFile: true });
  const entry = lib.entries.find((e) => e.path === slide);
  note("library entry", entry);
  check("the profile's Library lists the slide as made in the session", entry?.kind === "output" && entry?.sessionTitle === TITLE, entry);
}

/** The window's material is not in the DOM, so a capture composites the translucent grounds over
 *  nothing and the PNG comes out see-through. For the capture alone the root is painted with a
 *  ground that stands in for the material over a plain wallpaper, dark or light as the face is. */
async function shot(c, tag) {
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

async function teardown() {
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
