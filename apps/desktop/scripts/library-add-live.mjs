/**
 * Live check for the destination pages' bars and for adding files to the Library
 * (run with: pnpm build && node apps/desktop/scripts/library-add-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for every engine
 * (REALM_FAKE_STANDS_IN), so nothing runs a billed turn, and answers what jsdom cannot:
 *
 *   1. Every destination page's bar is its name and nothing else — no × at its far end — and it is a
 *      window-drag region from one end to the other, even at both ends, in both faces. Escape, the
 *      sidebar's Back and the rail's lit button each go back to the workspace as it was.
 *   2. The Library's Add copies what the picker chose (a picture, a PDF, a markdown file) into the
 *      home under the profile, and the files are listed with "Added", in All and in their kind's tab.
 *      The native dialog cannot be driven over CDP, so the store's `pickFiles` answers for it — the
 *      button, the copy and the page are the real ones.
 *   3. Files dropped on the page (a real CDP drag carrying paths): the page lights while they are held,
 *      a different file of a name already there is kept beside it as `name 2`, the same bytes again are
 *      not copied, a file past the ceiling is refused; a folder is offered, and added only when told.
 *   4. The documents pane's home lists the added files under Library, and the media viewer opens one
 *      like any other — saying "Added by you" and offering its own app.
 *
 * Ports: LIVE_SERVER_PORT (8814), LIVE_CDP_PORT (9254). Screenshots go to LIVE_OUT_DIR; the scratch
 * home to LIVE_SCRATCH_DIR. Kills only what listens on its own ports. Needs ffmpeg and cupsfilter.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { openSideTool } from "./lib/side-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9254);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8814);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-library-add-live-"));
const home = path.join(scratch, "home");
const desk = path.join(scratch, "desk");
const TITLE = "Atlas brief";
const VIEWPORT = { width: 1440, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `library-add-${tag}.png`);
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

/** A real press at the middle of `selector` — the only kind of click that exercises hit-testing. */
async function press(c, selector) {
  const b = await until(() => evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`), 10_000, selector);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
}

/** Files dragged in from the Finder and let go over `selector`: a drop whose data is file PATHS, so the
 *  File the page receives is backed by one and `webUtils` can name it. `hold` runs mid-drag. */
async function dropFiles(c, selector, paths, { hold = null } = {}) {
  const b = await evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  await c.send("Input.dispatchDragEvent", { type: "dragEnter", x: b.x, y: b.y, data });
  await c.send("Input.dispatchDragEvent", { type: "dragOver", x: b.x, y: b.y, data });
  if (hold) await hold();
  await c.send("Input.dispatchDragEvent", { type: "drop", x: b.x, y: b.y, data });
}

/** The React tree's store, found through the root's fiber — a harness's reach, used here to answer for
 *  the native file dialog (which no CDP command can drive) and to open the pages the rail's menu holds. */
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

/** Waits out every finite animation (a page's rise, a toast's entrance), then two frames for the paint. */
const settled = (c) => evalIn(c, `Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => null))),
  new Promise((r) => setTimeout(r, 2000)),
]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)`);

/** A capture of the window — or of `clip` — on a ground standing in for the material over a plain
 *  wallpaper, dark or light as the face is: a CDP capture has no material behind the window. */
async function shot(c, tag, clip = null) {
  await settled(c);
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
}

/** The page bar as it is drawn: what is in it, where its name sits, and what a press at each of a row
 *  of points along it would do — `drag` moves the window. Asked of the nearest box that sets a region,
 *  because the region is not inherited. */
const BAR = `(() => {
  const bar = document.querySelector('.page-overlay-bar'); if (!bar) return null;
  const r = bar.getBoundingClientRect();
  const mark = bar.querySelector('.page-overlay-mark').getBoundingClientRect();
  const title = bar.querySelector('.page-overlay-title');
  const t = title.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(title); const text = range.getBoundingClientRect();
  const regionAt = (x, y) => { for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    const v = getComputedStyle(el).getPropertyValue('-webkit-app-region'); if (v && v !== 'none') return v; } return null; };
  const xs = [r.left + 4, r.left + r.width * 0.25, r.left + r.width * 0.5, r.left + r.width * 0.75, r.right - 4];
  const cs = getComputedStyle(bar);
  return {
    label: document.querySelector('.page-overlay')?.getAttribute('aria-label'),
    title: title.textContent, buttons: bar.querySelectorAll('button, [role=button]').length,
    closeTitle: !!bar.querySelector('[title*="Close"]'),
    h: Math.round(r.height), w: Math.round(r.width),
    padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight),
    markInset: Math.round(mark.left - r.left), markMid: Math.round(mark.top + mark.height / 2 - r.top), textMid: Math.round(text.top + text.height / 2 - r.top),
    titleRightGap: Math.round(r.right - t.right),
    regions: xs.map((x) => regionAt(x, r.top + r.height / 2)),
  }; })()`;

/** Every destination page, opened the way the app opens it, its bar read, and a capture of its top. */
async function readBars(c, face) {
  const kinds = [
    ["rail", "Library"], ["rail", "Connections"], ["rail", "Scheduled tasks"], ["rail", "Notifications"],
    ["store", "settings-page"], ["store", "you-page"], ["store", "profile-page"], ["store", "space-page"],
  ];
  const bars = [];
  for (const [how, which] of kinds) {
    if (how === "rail") {
      const there = await evalIn(c, `!!document.querySelector('.app-rail .rail-btn[aria-label^=${JSON.stringify(which)}]')`);
      if (!there) { note(`no rail button for ${which}`, null); continue; }
      await press(c, `.app-rail .rail-btn[aria-label^=${JSON.stringify(which)}]`);
    } else {
      await evalIn(c, `(() => { const s = window.__liveStore.getState();
        if (${JSON.stringify(which)} === "profile-page") s.openProfilePage();
        else if (${JSON.stringify(which)} === "space-page") s.openSpacePage(s.activeSpaceId);
        else s.openDestinationPage(${JSON.stringify(which)});
        return true; })()`);
    }
    const bar = await until(() => evalIn(c, BAR), 10_000, `${which}'s bar`);
    await settled(c);
    bars.push({ which, ...(await evalIn(c, BAR)) });
    await shot(c, `bar-${face}-${which.replace(/[^a-z]+/gi, "-").toLowerCase()}`, { x: 0, y: 0, width: VIEWPORT.width, height: 150 });
    note("bar", { which, label: bar.label });
  }
  return bars;
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // ── The person's own files, on a "Desktop" outside the Realm home ───────────────────────────────
  fs.mkdirSync(path.join(desk, "other"), { recursive: true });
  fs.mkdirSync(path.join(desk, "shots", "old"), { recursive: true });
  const ff = (args) => { const r = spawnSync("ffmpeg", ["-v", "error", ...args, "-y"], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
  const sky = `geq=r='clip(30+X/1600*50+150*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+60*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:g='clip(80+Y/1000*70+110*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+30*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:b='clip(215-Y/1000*110-100*gt(Y\\,760-60*sin(X/170)),0,255)'`;
  ff(["-f", "lavfi", "-i", "color=c=black:s=1600x1000", "-vf", sky, "-frames:v", "1", path.join(desk, "hero.png")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1200x900", "-frames:v", "1", path.join(desk, "palette.jpg")]);
  ff(["-f", "lavfi", "-i", "mandelbrot=size=1200x800", "-frames:v", "1", path.join(desk, "shots", "ridge.png")]);
  ff(["-f", "lavfi", "-i", "smptehdbars=size=1280x720", "-frames:v", "1", path.join(desk, "shots", "bars.png")]);
  fs.writeFileSync(path.join(desk, "shots", ".DS_Store"), "finder");
  fs.writeFileSync(path.join(desk, "shots", "old", "first-draft.png"), fs.readFileSync(path.join(desk, "hero.png")));
  fs.writeFileSync(path.join(scratch, "brief.txt"), "Atlas launch brief\n\nThe hero shot leads the page: a clear sky over the ridge, the product\nbelow it, one line of copy.\n\n1. Warm the sky a little.\n2. Keep the ridge as it is.\n3. Export at 1600 x 1000.\n");
  fs.writeFileSync(path.join(desk, "brief.pdf"), execFileSync("cupsfilter", ["-m", "application/pdf", path.join(scratch, "brief.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  fs.writeFileSync(path.join(desk, "notes.md"), "# Launch notes\n\n- Hero shot: keep the ridge.\n- Copy: one line, no exclamation marks.\n");
  // A different notes.md, and the hero again under another name: the two duplicates a person makes.
  fs.writeFileSync(path.join(desk, "other", "notes.md"), "# Notes from the review\n\n- Ship Thursday.\n");
  fs.copyFileSync(path.join(desk, "hero.png"), path.join(desk, "hero copy.png"));
  // Past the attachment ceiling, sparse: it takes no room on disk.
  fs.writeFileSync(path.join(desk, "screen-recording.mov"), "");
  fs.truncateSync(path.join(desk, "screen-recording.mov"), 48 * 1024 * 1024);

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
      // Every engine is the scripted agent, onboarding's session included: nothing reaches a real one.
      REALM_FAKE_STANDS_IN: "claude,codex",
      // The OS menus cannot be driven over CDP; the app draws its own.
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
  const libraryDir = path.join(home, "library", profile.id);
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);
  note("session", session.id);

  // ── 1. The destination pages' bars, in both faces ──────────────────────────────────────────────
  for (const face of ["dark", "light"]) {
    await evalIn(c, `window.__liveStore.getState().setThemePref(${JSON.stringify(face)}).then(() => document.documentElement.dataset.mode)`);
    await until(() => evalIn(c, `document.documentElement.dataset.mode === ${JSON.stringify(face)}`), 5_000, `the ${face} face`);
    const bars = await readBars(c, face);
    check(`${face}: every destination page's bar is its name alone — no close, no button at all`,
      bars.length >= 7 && bars.every((b) => b.buttons === 0 && !b.closeTitle), bars.map((b) => [b.which, b.buttons, b.closeTitle]));
    check(`${face}: …and the whole bar moves the window, end to end`, bars.every((b) => b.regions.every((r) => r === "drag")), bars.map((b) => [b.which, b.regions]));
    check(`${face}: …the bar keeps the head row's 40px, its name centred in it`,
      bars.every((b) => b.h === 40 && Math.abs(b.markMid - 20) <= 1 && Math.abs(b.textMid - 20) <= 1.5), bars.map((b) => [b.which, b.h, b.markMid, b.textMid]));
    check(`${face}: …and even at both ends (14px in from each)`, bars.every((b) => b.padR === 14 && b.markInset === b.padL && b.padL >= 14), bars.map((b) => [b.which, b.padL, b.markInset, b.padR]));
    if (face === "dark") {
      // Back, three ways, to the session that was in front.
      await press(c, `.app-rail .rail-btn[aria-label^="Library"]`);
      await until(() => evalIn(c, `document.querySelector('.page-overlay')?.getAttribute('aria-label') === 'Library'`), 5_000, "Library");
      await escape(c);
      const esc = await until(() => evalIn(c, `!document.querySelector('.page-overlay') && [...document.querySelectorAll('.panel-bar')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 5_000, "Escape").catch(() => false);
      check("Escape goes back to the session that was in front", esc === true);
      await press(c, `.app-rail .rail-btn[aria-label^="Library"]`);
      await until(() => evalIn(c, `!!document.querySelector('.sb-page-back')`), 5_000, "the column's Back");
      await press(c, `.sb-page-back`);
      const back = await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "Back").catch(() => false);
      check("…and so does the sidebar's Back", back === true);
      await press(c, `.app-rail .rail-btn[aria-label^="Connections"]`);
      await until(() => evalIn(c, `document.querySelector('.page-overlay')?.getAttribute('aria-label') === 'Connections'`), 5_000, "Connections");
      await press(c, `.app-rail .rail-btn[aria-label^="Connections"]`);
      const lit = await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the lit rail button").catch(() => false);
      check("…and the rail's lit button, pressed again, from a page with no sidebar", lit === true);
    }
    await escape(c);
    await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "no page");
  }
  await evalIn(c, `window.__liveStore.getState().setThemePref("dark").then(() => true)`);
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "dark"`), 5_000, "dark again");

  // ── 2. Add, from the Files toolbar ─────────────────────────────────────────────────────────────
  await press(c, `.app-rail .rail-btn[aria-label^="Library"]`);
  await until(() => evalIn(c, `!!document.querySelector('.library-add')`), 10_000, "the Library's Add");
  await sleep(500);
  await shot(c, "1-library-empty-dark");
  const picked = ["hero.png", "palette.jpg", "brief.pdf", "notes.md"].map((name) => {
    const p = path.join(desk, name);
    const mime = { png: "image/png", jpg: "image/jpeg", pdf: "application/pdf", md: "text/markdown" }[name.split(".").pop()];
    return { path: p, mime, name, size: fs.statSync(p).size };
  });
  // What the native dialog would have answered. Everything after it — the button, the copy, the page — is the app's.
  await evalIn(c, `(() => { const picked = ${JSON.stringify(picked)}; window.__liveStore.setState({ pickFiles: async () => picked }); return true; })()`);
  await press(c, `.library-add`);
  await until(() => evalIn(c, `document.querySelectorAll('.library-tile').length >= 4`), 15_000, "the added tiles");
  await until(() => evalIn(c, `[...document.querySelectorAll('.library-tile[data-thumb] img')].length >= 2 && [...document.querySelectorAll('.library-tile[data-thumb] img')].every((i) => i.complete)`), 10_000, "the pictures").catch(() => null);
  await sleep(400);
  const grid = await evalIn(c, `[...document.querySelectorAll('.library-tile')].map((t) => ({ name: t.querySelector('.library-tile-name')?.textContent,
    from: t.querySelector('.library-tile-session')?.textContent, said: t.querySelector('.library-tile-from .visually-hidden')?.textContent, thumb: t.hasAttribute('data-thumb'), title: t.title }))`);
  note("grid", grid);
  check("Add copies the chosen files in, and the Library lists each with a quiet Added",
    ["hero.png", "palette.jpg", "brief.pdf", "notes.md"].every((n) => grid.some((g) => g.name === n && g.from === "Added" && g.said === "Added by you")), grid);
  check("…the pictures drawn as themselves", grid.filter((g) => g.thumb).map((g) => g.name).sort().join() === "hero.png,palette.jpg", grid.map((g) => [g.name, g.thumb]));
  const copies = fs.readdirSync(libraryDir).sort();
  check("…as COPIES, under the profile in the Realm home, the originals left where they were",
    copies.join() === "brief.pdf,hero.png,notes.md,palette.jpg" && grid.every((g) => g.title.startsWith(libraryDir)) && fs.existsSync(path.join(desk, "hero.png"))
      && fs.readFileSync(path.join(libraryDir, "notes.md"), "utf8") === fs.readFileSync(path.join(desk, "notes.md"), "utf8"), { libraryDir, copies });
  const toasts = () => evalIn(c, `[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim())`);
  note("toasts", await toasts());
  await shot(c, "2-library-added-dark");
  const tileNames = `[...document.querySelectorAll('.library-tile .library-tile-name')].map((n) => n.textContent).sort().join()`;
  const tab = async (label, expect) => {
    await press(c, `.library-types button[aria-pressed]:nth-child(${["All", "Images", "Documents"].indexOf(label) + 1})`);
    return until(async () => { const names = await evalIn(c, tileNames); return names === expect ? names.split(",") : null; }, 5_000, label).catch(async () => (await evalIn(c, tileNames)).split(","));
  };
  const images = await tab("Images", "hero.png,palette.jpg");
  const docs = await tab("Documents", "brief.pdf,notes.md");
  check("…in their kind's tab: Images and Documents", images.join() === "hero.png,palette.jpg" && docs.join() === "brief.pdf,notes.md", { images, docs });
  await shot(c, "3-library-documents-tab-dark");
  await tab("All", "brief.pdf,hero.png,notes.md,palette.jpg");
  // The same files as rows: the origin is the row's third column, quiet as a session's title is.
  await press(c, `.library-view label[title="Rows"]`);
  const rows = await until(() => evalIn(c, `(() => { const r = [...document.querySelectorAll('.library-row')]; return r.length === 4
    ? r.map((x) => [x.querySelector('.library-row-name').textContent, x.querySelector('.library-tile-session')?.textContent ?? null]) : null; })()`), 5_000, "rows");
  check("…and in rows, each with the same quiet Added", rows.every(([, from]) => from === "Added"), rows);
  await shot(c, "3b-library-rows-dark");
  await press(c, `.library-view label[title="Tiles"]`);
  await until(() => evalIn(c, `document.querySelectorAll('.library-tile').length === 4`), 5_000, "tiles again");

  // ── 3. Dropped on the page ─────────────────────────────────────────────────────────────────────
  let held = null;
  await dropFiles(c, ".library-files", [path.join(desk, "other", "notes.md"), path.join(desk, "hero copy.png"), path.join(desk, "screen-recording.mov")], {
    hold: async () => {
      await sleep(150);
      held = await evalIn(c, `(() => { const d = document.querySelector('.library-drop'); if (!d) return null;
        const g = d.getBoundingClientRect(), p = document.querySelector('.library-page-pane').getBoundingClientRect();
        const content = [document.querySelector('.page-head h1'), document.querySelector('.library-add'), document.querySelector('.library-tile')].map((el) => el.getBoundingClientRect());
        return { text: d.textContent, w: Math.round(g.width), inset: [g.left - p.left, g.top - p.top, p.right - g.right, p.bottom - g.bottom].map(Math.round),
          clear: content.every((r) => r.left >= g.left + 12 && r.right <= g.right - 12 && r.top >= g.top) }; })()`);
      await shot(c, "4-library-drop-held-dark");
    },
  });
  check("files held over the page light it, naming the gesture", held?.text === "Drop to add to the Library" && held.w > 600, held);
  check("…its glow inset from the page's own edge, as a pane's is, and clear of the page's content", held?.inset?.every((v) => v === 6) && held.clear === true, held);
  await until(() => evalIn(c, `[...document.querySelectorAll('.library-tile .library-tile-name')].some((n) => n.textContent === 'notes 2.md')`), 10_000, "notes 2.md");
  await sleep(500);
  const afterDrop = { names: await evalIn(c, `[...document.querySelectorAll('.library-tile .library-tile-name')].map((n) => n.textContent)`), toasts: await toasts(), copies: fs.readdirSync(libraryDir).sort() };
  note("after the drop", afterDrop);
  check("a different notes.md is kept beside the first as notes 2.md, the first untouched",
    afterDrop.copies.includes("notes 2.md") && fs.readFileSync(path.join(libraryDir, "notes.md"), "utf8").startsWith("# Launch notes"), afterDrop.copies);
  check("the same picture under another name is not copied again, and says so",
    !afterDrop.copies.includes("hero copy.png") && afterDrop.toasts.some((t) => t.includes("hero copy.png is already in the Library, as hero.png.")), afterDrop.toasts);
  check("a file past the ceiling is refused by its size", !afterDrop.copies.includes("screen-recording.mov")
    && afterDrop.toasts.some((t) => t.includes("Too large to add — the limit is 20 MB: screen-recording.mov (48 MB)")), afterDrop.toasts);
  await shot(c, "5-library-after-drop-dark");

  // A folder: offered, and added only when told.
  await sleep(6000); // let the drop's toasts leave, so the offer is what the capture shows
  await dropFiles(c, ".library-files", [path.join(desk, "shots")]);
  const offer = await until(() => evalIn(c, `(() => { const o = document.querySelector('.library-offer'); return o ? { text: o.querySelector('.library-offer-text').textContent,
    buttons: [...o.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`), 10_000, "the folder's offer");
  check("a dropped folder is a question first: its own files, what is left out, and nothing copied yet",
    offer.text === "“shots” is a folder of 2 files (" + offer.text.split("(")[1]?.split(")")[0] + "). Add them to the Library? The folders inside it are left out."
      && offer.buttons.join() === "Not now,Add 2 files" && !fs.readdirSync(libraryDir).includes("ridge.png"), offer);
  await shot(c, "6-library-folder-offer-dark");
  await press(c, `.library-offer .btn.primary`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.library-tile .library-tile-name')].some((n) => n.textContent === 'ridge.png')`), 10_000, "the folder's files");
  const folderCopies = fs.readdirSync(libraryDir).sort();
  check("…and told, it adds the folder's own files — not the hidden one, not the folder inside it",
    folderCopies.includes("ridge.png") && folderCopies.includes("bars.png") && !folderCopies.includes(".DS_Store") && !folderCopies.includes("first-draft.png"), folderCopies);
  await sleep(500);
  await shot(c, "7-library-folder-added-dark");

  // ── 4. The viewer, from the Library ────────────────────────────────────────────────────────────
  const openTile = (name) => evalIn(c, `(() => { [...document.querySelectorAll('.library-tile')].find((t) => t.title.endsWith('/' + ${JSON.stringify(name)}))?.click(); return true; })()`);
  const viewer = () => evalIn(c, `(() => { const v = document.querySelector('.media-viewer'); if (!v) return null;
    const img = v.querySelector('img.media-viewer-img');
    return { name: v.getAttribute('aria-label'), from: v.querySelector('.media-viewer-from')?.textContent ?? null, fromIsButton: v.querySelector('.media-viewer-from')?.tagName === 'BUTTON',
      img: img ? { complete: img.complete, w: img.naturalWidth } : null, actions: [...v.querySelectorAll('.media-viewer-actions button')].map((b) => b.getAttribute('aria-label')),
      still: !!v.querySelector('.media-viewer-stage img'), prompter: !!v.querySelector('textarea.composer-input') }; })()`);
  await openTile("hero.png");
  const v1 = await until(async () => { const v = await viewer(); return v?.img?.complete && v.img.w > 0 ? v : null; }, 15_000, "the viewer on hero.png");
  check("an added picture opens in the viewer like any file, saying it was added — not a session to jump to",
    v1.from === "Added by you" && !v1.fromIsButton && v1.prompter, v1);
  await shot(c, "8-viewer-added-picture-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  await openTile("notes.md");
  const v2 = await until(async () => { const v = await viewer(); return v && v.actions.length > 2 ? v : null; }, 15_000, "the viewer on notes.md");
  check("an added markdown file offers its own app, not a documents pane that could not reach it",
    !v2.actions.includes("Open in the documents pane") && v2.actions.includes("Open with the default app"), v2.actions);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  await openTile("brief.pdf");
  await until(async () => { const v = await viewer(); return v?.still ? v : null; }, 15_000, "the PDF's picture").catch(() => null);
  await sleep(400);
  await shot(c, "9-viewer-added-pdf-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  // ── 5. The documents pane's home lists them under Library ──────────────────────────────────────
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
  await openSideTool(c, TITLE, "Documents");
  await until(() => evalIn(c, `!!document.querySelector('.docs-home section[aria-label="Library"] .docs-home-row')`), 15_000, "the documents home");
  await sleep(600);
  const home$ = await evalIn(c, `[...document.querySelectorAll('.docs-home section[aria-label="Library"] .docs-home-row')].map((r) => ({
    name: r.querySelector('.docs-home-name')?.textContent, detail: r.querySelector('.docs-home-detail')?.textContent ?? null }))`);
  note("documents home", home$);
  check("the documents pane's home lists the added files under Library, as Added",
    ["hero.png", "brief.pdf", "notes.md", "notes 2.md"].every((n) => home$.some((r) => r.name === n && r.detail === "Added")), home$);
  await shot(c, "10-documents-home-dark");
  await evalIn(c, `(() => { [...document.querySelectorAll('.docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === 'palette.jpg')?.click(); return true; })()`);
  const v3 = await until(async () => { const v = await viewer(); return v?.img?.complete ? v : null; }, 15_000, "the viewer from the documents home");
  check("…and opens one in the same viewer", v3.name === "palette.jpg" && v3.from === "Added by you", v3);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  // ── The light face ─────────────────────────────────────────────────────────────────────────────
  await evalIn(c, `window.__liveStore.getState().setThemePref("light").then(() => true)`);
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "light"`), 5_000, "light");
  await sleep(500);
  await shot(c, "11-documents-home-light");
  await press(c, `.app-rail .rail-btn[aria-label^="Library"]`);
  await until(() => evalIn(c, `document.querySelectorAll('.library-tile').length >= 7`), 10_000, "the Library, light");
  await sleep(600);
  await shot(c, "12-library-light");
  await dropFiles(c, ".library-files", [path.join(desk, "shots")], { hold: () => shot(c, "13-library-drop-held-light") });
  await until(() => evalIn(c, `!!document.querySelector('.toast')`), 10_000, "the duplicate folder's word").catch(() => null);
  await sleep(400);
  note("light drop of the same folder", await evalIn(c, `({ offer: !!document.querySelector('.library-offer'), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()) })`));
  await press(c, `.library-offer .btn.primary`).catch(() => null);
  await sleep(1200);
  note("light second add of the folder", await toasts());
  await shot(c, "14-library-duplicates-light");
  await openTile("hero.png");
  await until(async () => { const v = await viewer(); return v?.img?.complete ? v : null; }, 15_000, "the viewer, light");
  await shot(c, "15-viewer-added-picture-light");
  await escape(c);

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
