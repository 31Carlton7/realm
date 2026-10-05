/**
 * Live check for the surface files and Library items stand on
 * (run with: pnpm build && node apps/desktop/scripts/object-surface-live.mjs)
 *
 * The owner, 10-05: "Files and library items should have a very slight shadow under them instead of
 * being just a flat square. And also it should have a light border. Look at the simulator and the bar
 * that has the live indicator… That should be the shadow and border used for any library item." So
 * every such item is asked what it wears — the same computed box-shadow as the device toolbar, read
 * off a toolbar the check puts in the page, since no device is attached here — and seen in each face:
 *
 *   - the Library's Files as tiles and as rows, its Saved turns, the documents pane's home, and the
 *     files on a message and in the prompter;
 *   - dark, light, and a themed palette (Rosé Pine);
 *   - a tile under the pointer and one with the keyboard's focus, and a picture tile's corner up close,
 *     where the picture has to keep its radius inside the border.
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for every engine.
 * LIVE_TAG names the run's captures (`before`, `after`). Ports: LIVE_SERVER_PORT (8814), LIVE_CDP_PORT
 * (9254). Screenshots go to LIVE_OUT_DIR, the scratch home to LIVE_SCRATCH_DIR. Kills only what listens
 * on its own ports. Needs ffmpeg and cupsfilter.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9254);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8814);
const TAG = process.env.LIVE_TAG ?? "run";
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-object-surface-live-"));
const home = path.join(scratch, "home");
const desk = path.join(scratch, "desk");
const TITLE = "Atlas brief";
const VIEWPORT = { width: 1440, height: 900 };
const OUT = (name) => path.join(OUT_DIR, `object-surface-${TAG}-${name}.png`);
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
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
  });
  return {
    ready, errors,
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

async function key(c, k, code = k, vk = 0) {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
const escape = (c) => key(c, "Escape", "Escape", 27);

async function centre(c, selector) {
  return until(() => evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`), 10_000, selector);
}
/** A real press at the middle of `selector` — the only kind of click that exercises hit-testing. */
async function press(c, selector) {
  const b = await centre(c, selector);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
}
/** The pointer resting somewhere neutral, so no item is caught mid-hover by a capture. */
const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VIEWPORT.width - 4, y: VIEWPORT.height - 4 });

const FIND_STORE = `(() => {
  if (window.__liveStore) return true;
  const root = document.getElementById("root");
  const k = root && Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
  if (!k) return false;
  const stack = [root[k]];
  for (let n = 0; stack.length && n < 400000; n++) {
    const f = stack.pop();
    const v = f && f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.getState().addLibraryFiles === "function") { window.__liveStore = v; return true; }
    if (f && f.sibling) stack.push(f.sibling);
    if (f && f.child) stack.push(f.child);
  }
  return false; })()`;

const settled = (c) => evalIn(c, `Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => null))),
  new Promise((r) => setTimeout(r, 2000)),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)`);

/** A capture on a ground standing in for the material over a plain wallpaper — a CDP capture has no
 *  material behind the window. `clip` in CSS pixels, `scale` for a close look. */
async function shot(c, name, clip = null, scale = 1) {
  await settled(c);
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale } } : {}) });
    fs.writeFileSync(OUT(name), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${name} ${OUT(name)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}
const boxOf = (c, selector, pad = 16) => evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
  const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} }; })()`);

/**
 * What each kind of item wears, against what the device's toolbar wears. The toolbar is put in the
 * page for the asking — its rule is the stylesheet's, whatever is around it — and taken out again.
 */
const SURFACES = `(() => {
  const probe = document.createElement("div"); probe.className = "sim-toolbar"; document.body.appendChild(probe);
  const toolbar = getComputedStyle(probe).boxShadow; probe.remove();
  const of = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).boxShadow : null; };
  return { toolbar, tile: of('.library-tile'), thumbTile: of('.library-tile[data-thumb]'), rowMark: of('.library-row-mark'),
    saved: of('.saved-turn-open'), docsGlyph: of('.docs-home-glyph'), attach: of('.attach-art'),
    thumbOutline: (() => { const t = document.querySelector('.library-tile[data-thumb]'); return t ? getComputedStyle(t, '::after').boxShadow : null; })() };
})()`;

async function face(c, label, set) {
  await evalIn(c, `(async () => { const s = window.__liveStore.getState(); ${set}; return true; })()`);
  await sleep(700);
  note(`face ${label}`, await evalIn(c, `({ mode: document.documentElement.dataset.mode })`));
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // ── The person's own files ──────────────────────────────────────────────────────────────────
  fs.mkdirSync(desk, { recursive: true });
  const ff = (args) => { const r = spawnSync("ffmpeg", ["-v", "error", ...args, "-y"], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
  const sky = `geq=r='clip(30+X/1600*50+150*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+60*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:g='clip(80+Y/1000*70+110*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+30*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:b='clip(215-Y/1000*110-100*gt(Y\\,760-60*sin(X/170)),0,255)'`;
  ff(["-f", "lavfi", "-i", "color=c=black:s=1600x1000", "-vf", sky, "-frames:v", "1", path.join(desk, "hero.png")]);
  // A picture whose own corner is near-white, so a corner that escapes the tile's radius would show.
  ff(["-f", "lavfi", "-i", "color=c=0xf4f1ea:s=1200x900", "-vf", "drawbox=x=300:y=220:w=600:h=460:color=0x2d6cdf@1:t=fill", "-frames:v", "1", path.join(desk, "sketch.png")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1200x900", "-frames:v", "1", path.join(desk, "palette.jpg")]);
  fs.writeFileSync(path.join(scratch, "brief.txt"), "Atlas launch brief\n\nThe hero shot leads the page: a clear sky over the ridge.\n");
  fs.writeFileSync(path.join(desk, "brief.pdf"), execFileSync("cupsfilter", ["-m", "application/pdf", path.join(scratch, "brief.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  fs.writeFileSync(path.join(desk, "notes.md"), "# Launch notes\n\n- Keep the ridge.\n");
  fs.writeFileSync(path.join(desk, "usage.csv"), "day,turns\nmon,4\ntue,9\n");

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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Atlas");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await evalIn(c, awake);
  await until(() => evalIn(c, FIND_STORE), 10_000, "the store");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const [profile] = await api.call("profiles.list", {});

  // ── Seeded: a session that was sent files and answered, two turns of it saved, and files added ──
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  const asks = [
    { text: "The hero shot and the brief for the launch page.", attachments: [{ path: path.join(desk, "hero.png"), mime: "image/png" }, { path: path.join(desk, "brief.pdf"), mime: "application/pdf" }] },
    { text: "Warm the sky a little and keep the ridge as it is.", attachments: [] },
    { text: "And the usage numbers for the week.", attachments: [{ path: path.join(desk, "usage.csv"), mime: "text/csv" }] },
  ];
  for (const ask of asks) {
    await api.call("sessions.send", { id: session.id, mentions: [], ...ask });
    await until(async () => (await api.call("sessions.get", { id: session.id }).catch(() => null))?.status === "idle", 20_000, "the answer").catch(() => null);
    await sleep(600);
  }
  const events = await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 500 }).catch(() => null);
  const prompts = (events?.events ?? events ?? []).filter((e) => e.event?.type === "user_message" || e.type === "user_message").map((e) => e.seq);
  note("prompt seqs", prompts);
  for (const seq of prompts.slice(0, 2)) await api.call("sessions.setSaved", { id: session.id, seq, saved: true }).catch((e) => note("save failed", String(e)));
  await api.call("library.add", { profileId: profile.id, paths: ["sketch.png", "palette.jpg", "notes.md"].map((n) => path.join(desk, n)) });
  // A file waiting in the prompter, beside the ones the transcript already shows sent.
  await evalIn(c, `window.__liveStore.getState().attachPaths(${JSON.stringify(session.id)}, [${JSON.stringify(path.join(desk, "palette.jpg"))}]).then(() => true)`);
  await until(() => evalIn(c, `document.querySelectorAll('.msg-user-files .attach-tile').length >= 3`), 20_000, "the sent files").catch(() => null);

  const faces = [
    ["dark", `await s.setThemeName("dark", "realm"); await s.setThemePref("dark")`],
    ["light", `await s.setThemeName("light", "realm"); await s.setThemePref("light")`],
    ["rosepine", `await s.setThemeName("dark", "rosepine"); await s.setThemePref("dark")`],
  ];
  for (const [label, set] of faces) {
    await face(c, label, set);
    // The transcript's files: sent on the messages, and waiting in the prompter.
    await park(c);
    await shot(c, `${label}-1-transcript`);
    const prompter = await boxOf(c, ".composer", 12);
    if (prompter) await shot(c, `${label}-2-prompter-close`, prompter, 2);
    const sent = await boxOf(c, ".msg-user-files", 12);
    if (sent) await shot(c, `${label}-3-sent-files-close`, sent, 2);

    // The documents pane's home, beside the session.
    await press(c, `button[aria-label=${JSON.stringify(`Open documents for ${TITLE}`)}]`);
    await until(() => evalIn(c, `!!document.querySelector('.docs-home section[aria-label="Library"] .docs-home-row')`), 15_000, "the documents home");
    await park(c);
    await sleep(500);
    const docs = await boxOf(c, ".docs-home", 0);
    await shot(c, `${label}-4-documents-home`, docs);

    // The Library: tiles, rows, Saved.
    await press(c, `.app-rail .rail-btn[aria-label^="Library"]`);
    await until(() => evalIn(c, `document.querySelectorAll('.library-tile').length >= 5 || document.querySelectorAll('.library-row').length >= 5`), 15_000, "the Library");
    if (await evalIn(c, `!!document.querySelector('.library-row')`)) await press(c, `.library-view label[title="Tiles"]`);
    await until(() => evalIn(c, `[...document.querySelectorAll('.library-tile[data-thumb] img')].length >= 2 && [...document.querySelectorAll('.library-tile[data-thumb] img')].every((i) => i.complete)`), 10_000, "pictures").catch(() => null);
    await park(c);
    await shot(c, `${label}-5-library-tiles`);
    const surfaces = await evalIn(c, SURFACES);
    note(`${label} surfaces`, surfaces);
    // Under the pointer, and with the keyboard's focus.
    const second = ".library-grid li:nth-child(2) .library-tile";
    const b = await centre(c, second);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
    await sleep(250);
    const grid = await boxOf(c, ".library-grid", 12);
    await shot(c, `${label}-6-library-tile-hover`, { ...grid, height: Math.min(grid.height, 330) }, 2);
    await park(c);
    await evalIn(c, `(() => { document.querySelector('.library-grid li:nth-child(3) .library-tile')?.focus({ focusVisible: true }); return true; })()`);
    await key(c, "ArrowLeft", "ArrowLeft", 37);
    await sleep(250);
    await shot(c, `${label}-7-library-tile-focus`, { ...grid, height: Math.min(grid.height, 330) }, 2);
    // A picture tile's corner, close: the picture keeps the tile's radius inside the border.
    const corner = await evalIn(c, `(() => { const t = [...document.querySelectorAll('.library-tile[data-thumb]')].find((x) => x.title.endsWith('/sketch.png')); if (!t) return null;
      const r = t.getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: 56, height: 56 }; })()`);
    if (corner) await shot(c, `${label}-8-picture-corner`, corner, 6);
    await press(c, `.library-view label[title="Rows"]`);
    await until(() => evalIn(c, `document.querySelectorAll('.library-row').length >= 5`), 5_000, "rows");
    await park(c);
    await shot(c, `${label}-9-library-rows`);
    surfaces.rowMark = await evalIn(c, `(() => { const el = document.querySelector('.library-row-mark'); return el ? getComputedStyle(el).boxShadow : null; })()`);
    const rows = await boxOf(c, ".library-rows", 12);
    if (rows) await shot(c, `${label}-9b-library-rows-close`, { ...rows, height: Math.min(rows.height, 260) }, 2);
    await press(c, `.library-view label[title="Tiles"]`);
    const saved = await evalIn(c, `(() => { const t = [...document.querySelectorAll('.sb-page-nav .settings-tab, .page-rail .settings-tab')].find((x) => x.textContent.trim() === 'Saved'); if (!t) return false; t.click(); return true; })()`);
    if (saved) {
      await until(() => evalIn(c, `!!document.querySelector('.saved-turn-open') || !!document.querySelector('.library-empty')`), 10_000, "Saved");
      await park(c);
      await shot(c, `${label}-10-library-saved`);
      const savedSurface = await evalIn(c, `(() => { const el = document.querySelector('.saved-turn-open'); return el ? getComputedStyle(el).boxShadow : null; })()`);
      note(`${label} saved surface`, savedSurface);
      surfaces.saved = savedSurface;
      await evalIn(c, `(() => { [...document.querySelectorAll('.sb-page-nav .settings-tab, .page-rail .settings-tab')].find((x) => x.textContent.trim() === 'Files')?.click(); return true; })()`);
    }
    const same = (v) => v === surfaces.toolbar;
    check(`${label}: a Library tile wears the device toolbar's border and shadow`, same(surfaces.tile), { toolbar: surfaces.toolbar, tile: surfaces.tile });
    check(`${label}: …and so do a row's file, a saved turn, the documents home's files and an attachment`,
      [surfaces.rowMark, surfaces.saved, surfaces.docsGlyph, surfaces.attach].every(same), surfaces);
    check(`${label}: a picture tile wears ONE ring — the tile's — and none traced inside it`, same(surfaces.thumbTile) && (surfaces.thumbOutline === "none" || surfaces.thumbOutline === null), surfaces);
    await escape(c);
    await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
    // The documents pane back out of the way for the next face.
    await evalIn(c, `(() => { document.querySelector('.panel-bar button[aria-label^="Close Documents"], .pane-tab-close')?.click(); return true; })()`);
    await sleep(400);
  }
  check("no uncaught errors in the renderer", c.errors.length === 0, c.errors.slice(0, 3));
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
