/**
 * Live check for taking files back out of the Library (run with: pnpm build && node apps/desktop/scripts/library-remove-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for every engine
 * (REALM_FAKE_STANDS_IN), so nothing runs a billed turn, adds real files from a scratch "Desktop" with
 * the Library's own Add, and answers what jsdom cannot:
 *
 *   1. A file's ⋯ comes up under the pointer, and a right-click opens its menu, which for a file the
 *      person added ends in Remove from Library — and for a session's file does not.
 *   2. Remove takes the file out at once with no question, Realm's copy leaves its place in the home
 *      and the original on the Desktop is untouched, and the toast's Undo puts the copy back exactly:
 *      the same bytes, the same name, the same place in the grid.
 *   3. Delete on the tile in focus does the same and hands the keyboard to the next tile.
 *   4. A file sent with a message: the toast says so, the message's tile loses its picture, and the
 *      Undo gives it back. A file sitting as a prompter chip comes off it and back on with the Undo.
 *   5. The viewer's ⋯ ends in the same row, and removing the file on show moves the viewer on.
 *   6. The documents pane's home gives its Library rows the same menu.
 *   7. Removing the last file brings the page's empty state back — and all of it in both faces.
 *
 * Ports: LIVE_SERVER_PORT (8814), LIVE_CDP_PORT (9254). Screenshots go to LIVE_OUT_DIR; the scratch
 * home to LIVE_SCRATCH_DIR. Kills only what listens on its own ports. Needs ffmpeg and cupsfilter.
 */
import { createHash } from "node:crypto";
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
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-library-remove-live-"));
const home = path.join(scratch, "home");
const desk = path.join(scratch, "desk");
const TITLE = "Atlas brief";
const VIEWPORT = { width: 1440, height: 900 };
const OUT = (tag) => path.join(OUT_DIR, `library-remove-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
let electron = null;
let api = null;
/** The renderer's CDP client, for the state a failure leaves behind. */
let page = null;

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
    await sleep(150);
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

async function key(c, k, code = k, vk = 0, modifiers = 0) {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}
const escape = (c) => key(c, "Escape", "Escape", 27);
/** Escape on a menu just opened. A drawn menu takes its keys a timer tick after it opens
 *  (use-anchored-popover.ts), and in a window behind another that tick can come after a key CDP sends
 *  at once — which then goes to the page under the menu, as no person's could. */
const escapeMenu = async (c) => {
  await sleep(400);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.menu')`), 5_000, "the menu gone");
};
const backspace = (c, modifiers = 0) => key(c, "Backspace", "Backspace", 8, modifiers);

/** The middle of the first element matching `expr` (an expression yielding an element), laid out. */
const centreOf = (c, expr, tag) => until(() => evalIn(c, `(() => { const el = ${expr}; if (!el) return null;
  const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`), 10_000, tag);
/** A real press at the middle of it — the only kind of click that exercises hit-testing. */
async function pressAt(c, expr, tag, button = "left") {
  const b = await centreOf(c, expr, tag);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button, clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button, clickCount: 1 });
}
const press = (c, selector) => pressAt(c, `document.querySelector(${JSON.stringify(selector)})`, selector);
/** A right-click at the middle of it, as the trackpad's two-finger click arrives. */
async function rightClick(c, expr, tag, menuLabel) {
  await pressAt(c, expr, tag, "right");
  const opened = await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label=${JSON.stringify(menuLabel)}]')`), 3_000, `${tag}'s menu`).catch(() => false);
  if (opened) return "pointer";
  note("a right press raised no contextmenu; dispatching one", tag);
  await evalIn(c, `(() => { const el = ${expr}; const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label=${JSON.stringify(menuLabel)}]')`), 5_000, `${tag}'s menu`);
  return "event";
}
const hover = async (c, expr, tag) => { const b = await centreOf(c, expr, tag); await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y }); };

/** The li of a Library file, by its name and — where two share one — by what the tile says it came from. */
const FILE = (name, from = null) => `[...document.querySelectorAll('.library-file')].find((li) => li.querySelector('.library-tile-name, .library-row-name')?.textContent === ${JSON.stringify(name)}
  && (${JSON.stringify(from)} === null || li.querySelector('.library-tile-session')?.textContent === ${JSON.stringify(from)}))`;
const TILE = (name, from) => `(${FILE(name, from)})?.querySelector('.library-tile')`;
const MORE = (name, from) => `(${FILE(name, from)})?.querySelector('.library-file-more')`;
/** The grid as it reads: each tile's name and the line under it. */
const GRID = `[...document.querySelectorAll('.library-file')].map((li) => li.querySelector('.library-tile-name')?.textContent + ' · ' + li.querySelector('.library-tile-session')?.textContent)`;
const menuRows = (c) => evalIn(c, `[...document.querySelectorAll('.menu [role^=menuitem]')].map((r) => r.querySelector('.menu-label')?.textContent)`);
const pressRow = (c, label) => pressAt(c, `[...document.querySelectorAll('.menu [role^=menuitem]')].find((r) => r.querySelector('.menu-label')?.textContent === ${JSON.stringify(label)})`, label);
/** The front toast: its words and whether it offers an Undo. */
const TOAST = `(() => { const t = [...document.querySelectorAll('.toast')].find((x) => x.hasAttribute('data-front') && !x.hasAttribute('data-leaving')); return t ? { text: t.querySelector('.toast-text')?.textContent, undo: t.querySelector('.toast-action')?.textContent ?? null } : null; })()`;
const frontToast = (c, has) => until(async () => { const t = await evalIn(c, TOAST); return t && (!has || t.text.includes(has)) ? t : null; }, 8_000, `a toast saying ${has}`);
const pressUndo = (c) => pressAt(c, `[...document.querySelectorAll('.toast[data-front]:not([data-leaving]) .toast-action')][0]`, "the toast's Undo");
/** Every toast taken down, so the next one read is the next one said. */
const clearToasts = (c) => evalIn(c, `(() => { const s = window.__liveStore.getState(); for (const t of s.toasts) s.dismissToast(t.id); return true; })()`);

const FIND_STORE = `(() => {
  if (window.__liveStore) return true;
  const root = document.getElementById("root");
  const k = root && Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
  if (!k) return false;
  const stack = [root[k]];
  for (let n = 0; stack.length && n < 400000; n++) {
    const f = stack.pop();
    const v = f && f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.getState().removeLibraryFiles === "function") { window.__liveStore = v; return true; }
    if (f && f.sibling) stack.push(f.sibling);
    if (f && f.child) stack.push(f.child);
  }
  return false; })()`;

/** Waits out every finite animation but a toast's clock (which runs for as long as the toast is up),
 *  then two frames for the paint. */
const settled = (c) => evalIn(c, `Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.playState === "running" && a.animationName !== "rl-toast-progress" && Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => null))),
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

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // ── The person's own files, on a "Desktop" outside the Realm home ───────────────────────────────
  fs.mkdirSync(desk, { recursive: true });
  const ff = (args) => { const r = spawnSync("ffmpeg", ["-v", "error", ...args, "-y"], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
  const sky = `geq=r='clip(30+X/1600*50+150*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+60*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:g='clip(80+Y/1000*70+110*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+30*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:b='clip(215-Y/1000*110-100*gt(Y\\,760-60*sin(X/170)),0,255)'`;
  ff(["-f", "lavfi", "-i", "color=c=black:s=1600x1000", "-vf", sky, "-frames:v", "1", path.join(desk, "hero.png")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1200x900", "-frames:v", "1", path.join(desk, "palette.jpg")]);
  fs.writeFileSync(path.join(scratch, "brief.txt"), "Atlas launch brief\n\nThe hero shot leads the page: a clear sky over the ridge.\n");
  fs.writeFileSync(path.join(desk, "brief.pdf"), execFileSync("cupsfilter", ["-m", "application/pdf", path.join(scratch, "brief.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  fs.writeFileSync(path.join(desk, "notes.md"), "# Launch notes\n\n- Hero shot: keep the ridge.\n- Copy: one line, no exclamation marks.\n");
  fs.writeFileSync(path.join(desk, "budget.csv"), "item,cost\nshoot,1200\nedit,800\n");
  const ORDER = ["hero.png", "palette.jpg", "brief.pdf", "notes.md", "budget.csv"];
  const originals = Object.fromEntries(ORDER.map((n) => [n, sha(path.join(desk, n))]));

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
      // The OS menus cannot be driven or captured over CDP; the app draws its own.
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
  page = c;
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Held key, so the toasts' clocks run as they do in front of the person.
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
  note("session", session.id);

  // ── Real files in, with the Library's own Add ──────────────────────────────────────────────────
  const openLibrary = async () => {
    await press(c, `.app-rail .rail-btn[aria-label^="Library"]`);
    await until(() => evalIn(c, `!!document.querySelector('.library-add')`), 10_000, "the Library's Add");
  };
  const addAll = async () => {
    const mime = { png: "image/png", jpg: "image/jpeg", pdf: "application/pdf", md: "text/markdown", csv: "text/csv" };
    const picked = ORDER.map((name) => ({ path: path.join(desk, name), mime: mime[name.split(".").pop()], name, size: fs.statSync(path.join(desk, name)).size }));
    await evalIn(c, `(() => { const picked = ${JSON.stringify(picked)}; window.__liveStore.setState({ pickFiles: async () => picked }); return true; })()`);
    await press(c, `.library-add`);
    await until(() => evalIn(c, `${JSON.stringify(ORDER)}.every((n) => [...document.querySelectorAll('.library-tile-name')].some((t) => t.textContent === n))`), 15_000, "the added tiles");
    await until(() => evalIn(c, `[...document.querySelectorAll('.library-tile[data-thumb] img')].length >= 2 && [...document.querySelectorAll('.library-tile[data-thumb] img')].every((i) => i.complete)`), 10_000, "the pictures").catch(() => null);
    await clearToasts(c);
  };
  await openLibrary();
  await addAll();
  const copyOf = (name) => path.join(libraryDir, name);
  check("the files are added as copies under the profile, the originals where they were",
    ORDER.every((n) => fs.existsSync(copyOf(n)) && sha(copyOf(n)) === originals[n]), fs.readdirSync(libraryDir));

  // A message sent with hero.png's copy, and palette.jpg's waiting in the prompter as a chip.
  await api.call("sessions.send", { id: session.id, text: "Warm the sky a little.", attachments: [{ path: copyOf("hero.png"), mime: "image/png" }] });
  await evalIn(c, `window.__liveStore.getState().attachPaths(${JSON.stringify(session.id)}, [${JSON.stringify(copyOf("palette.jpg"))}]).then(() => true)`);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
  await until(() => evalIn(c, `!!document.querySelector('.msg-user-files .attach-tile[data-image]')`), 15_000, "the sent message's picture");
  await openLibrary();
  await until(() => evalIn(c, `document.querySelectorAll('.library-file').length === 6`), 10_000, "six tiles (hero.png twice)");
  await sleep(600);

  for (const face of ["dark", "light"]) {
    await evalIn(c, `window.__liveStore.getState().setThemePref(${JSON.stringify(face)}).then(() => true)`);
    await until(() => evalIn(c, `document.documentElement.dataset.mode === ${JSON.stringify(face)}`), 5_000, `the ${face} face`);
    await sleep(500);
    if (face === "light") {
      // The dark pass took every file out; the same files come in again, as a person would add them.
      await addAll();
      await api.call("sessions.send", { id: session.id, text: "And the palette, please.", attachments: [{ path: copyOf("hero.png"), mime: "image/png" }] });
      // The page reads the index when it opens; a message sent since is read on the next visit.
      await escape(c);
      await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
      await until(() => evalIn(c, `document.querySelectorAll('.msg-user-files .attach-tile[data-image]').length >= 2`), 15_000, "the new message's picture");
      await openLibrary();
      await until(() => evalIn(c, `document.querySelectorAll('.library-file').length === 6`), 10_000, "six tiles again");
      await sleep(600);
    }
    await shot(c, `1-library-${face}`);
    const grid = await evalIn(c, GRID);
    note(`${face} grid`, grid);

    // ── 1. The ⋯ and the menu ──────────────────────────────────────────────────────────────────
    await hover(c, TILE("notes.md"), "notes.md");
    const more = await evalIn(c, `(() => { const b = ${MORE("notes.md")}; const r = b.getBoundingClientRect(); return { opacity: getComputedStyle(b).opacity, w: r.width, h: r.height }; })()`);
    check(`${face}: a file's ⋯ comes up under the pointer`, more.opacity === "1" && more.w === 28 && more.h === 28, more);
    const tileBox = await evalIn(c, `(() => { const r = (${TILE("notes.md")}).getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16 }; })()`);
    await shot(c, `2-tile-more-${face}`, tileBox);
    note("right-click", await rightClick(c, TILE("notes.md"), "notes.md", "notes.md"));
    const rows = await menuRows(c);
    check(`${face}: a right-click on an added file opens its menu, ending in Remove from Library`, rows.at(-1) === "Remove from Library" && rows[0] === "Open", rows);
    await shot(c, `3-menu-${face}`);
    await escapeMenu(c);
    await pressAt(c, MORE("hero.png", "Atlas brief"), "the sent hero.png's ⋯");
    await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label="hero.png"]')`), 5_000, "the sent copy's menu");
    const sentRows = await menuRows(c);
    check(`${face}: …the same file as a message's attachment — a session's — has no such row`, !sentRows.includes("Remove from Library") && sentRows.includes("Open"), sentRows);
    await escapeMenu(c);

    // ── 2. Remove, and Undo ───────────────────────────────────────────────────────────────────
    const before = await evalIn(c, GRID);
    await rightClick(c, TILE("notes.md"), "notes.md", "notes.md");
    await pressRow(c, "Remove from Library");
    await until(() => evalIn(c, `!(${FILE("notes.md")})`), 5_000, "notes.md gone from the grid");
    const said = await frontToast(c, "notes.md");
    const aside = fs.existsSync(path.join(libraryDir, ".removed")) ? fs.readdirSync(path.join(libraryDir, ".removed")).flatMap((d) => fs.readdirSync(path.join(libraryDir, ".removed", d))) : [];
    check(`${face}: Remove takes it out at once — no question — and says so with an Undo`,
      said.text === "Removed notes.md from the Library." && said.undo === "Undo" && !(await evalIn(c, `!!document.querySelector('.sheet, [role=alertdialog]')`)), said);
    check(`${face}: …Realm's copy leaves its place, set aside; the original on the Desktop is untouched`,
      !fs.existsSync(copyOf("notes.md")) && aside.includes("notes.md") && sha(path.join(desk, "notes.md")) === originals["notes.md"], aside);
    // The pointer on the stack holds its clock while it is captured.
    await hover(c, `document.querySelector('.toast[data-front] .toast-text')`, "the toast");
    await shot(c, `4-toast-undo-${face}`);
    await pressUndo(c);
    await until(() => evalIn(c, `!!(${FILE("notes.md")})`), 5_000, "notes.md back");
    await sleep(300);
    const after = await evalIn(c, GRID);
    check(`${face}: Undo puts it back exactly — the same bytes, the same name, the same place in the grid`,
      JSON.stringify(after) === JSON.stringify(before) && sha(copyOf("notes.md")) === originals["notes.md"] && !fs.existsSync(path.join(libraryDir, ".removed")), { before, after });
    await clearToasts(c);

    // ── 3. Delete on the tile in focus ─────────────────────────────────────────────────────────
    const order = (await evalIn(c, GRID)).map((s) => s.split(" · ")[0]);
    const nextAfterBrief = order[order.indexOf("brief.pdf") + 1];
    await evalIn(c, `(() => { (${TILE("brief.pdf")}).focus(); return true; })()`);
    await backspace(c);
    await until(() => evalIn(c, `!(${FILE("brief.pdf")})`), 5_000, "brief.pdf gone on Delete");
    const focused = await until(() => evalIn(c, `document.activeElement?.closest('.library-file')?.querySelector('.library-tile-name')?.textContent ?? null`), 5_000, "the keyboard handed on");
    check(`${face}: Delete takes the tile in focus out and hands the keyboard to the next one`, focused === nextAfterBrief, { focused, nextAfterBrief });
    await frontToast(c, "brief.pdf");
    await pressUndo(c);
    await until(() => evalIn(c, `!!(${FILE("brief.pdf")})`), 5_000, "brief.pdf back");
    await clearToasts(c);

    // ── 4. A file sent with a message, and one waiting as a chip ───────────────────────────────
    await pressAt(c, MORE("hero.png", "Added"), "the added hero.png's ⋯");
    await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label="hero.png"]')`), 5_000, "hero.png's menu");
    await pressRow(c, "Remove from Library");
    const sentSaid = await frontToast(c, "hero.png");
    check(`${face}: removing a file sent with a message says the message loses it`,
      sentSaid.text.startsWith("Removed hero.png from the Library. It's gone from the") && sentSaid.text.includes("it was sent with, too."), sentSaid);
    await until(() => evalIn(c, `![...document.querySelectorAll('.library-tile-name')].some((t) => t.textContent === "hero.png")`), 5_000, "both hero.png tiles gone");
    await hover(c, `document.querySelector('.toast[data-front] .toast-text')`, "the toast");
    await shot(c, `5-toast-sent-${face}`);
    await escape(c);
    await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
    const glyph = await until(() => evalIn(c, `(() => { const t = [...document.querySelectorAll('.msg-user-files .attach-tile')]; return t.length > 0 && t.every((x) => !x.hasAttribute('data-image')) ? t.length : null; })()`), 5_000, "the message's tile without its picture").catch(() => null);
    check(`${face}: …and the message's tile loses its picture`, glyph !== null, glyph);
    await hover(c, `document.querySelector('.toast[data-front] .toast-text')`, "the toast");
    await shot(c, `6-transcript-removed-${face}`);
    await pressUndo(c);
    const pictured = await until(() => evalIn(c, `!!document.querySelector('.msg-user-files .attach-tile[data-image]')`), 8_000, "the picture back").catch(() => false);
    check(`${face}: …until the Undo gives it back`, pictured === true && sha(copyOf("hero.png")) === originals["hero.png"]);
    await clearToasts(c);
    // The chip.
    const chips = () => evalIn(c, `(window.__liveStore.getState().pendingAttachments[${JSON.stringify(session.id)}] ?? []).map((a) => a.name)`);
    if (!(await chips()).includes("palette.jpg")) await evalIn(c, `window.__liveStore.getState().attachPaths(${JSON.stringify(session.id)}, [${JSON.stringify(copyOf("palette.jpg"))}]).then(() => true)`);
    await openLibrary();
    await until(() => evalIn(c, `!!(${FILE("palette.jpg")})`), 5_000, "palette.jpg");
    await pressAt(c, MORE("palette.jpg"), "palette.jpg's ⋯");
    await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label="palette.jpg"]')`), 5_000, "palette.jpg's menu");
    await pressRow(c, "Remove from Library");
    const chipSaid = await frontToast(c, "palette.jpg");
    const chipsGone = await chips();
    check(`${face}: a file waiting as a prompter chip comes off it, and the toast says so`,
      !chipsGone.includes("palette.jpg") && chipSaid.text.includes("It's gone from the message you're writing, too."), { chipsGone, chipSaid });
    await pressUndo(c);
    const chipsBack = await until(async () => { const n = await chips(); return n.includes("palette.jpg") ? n : null; }, 5_000, "the chip back").catch(() => null);
    check(`${face}: …and back on it with the Undo`, chipsBack !== null, chipsBack);
    await clearToasts(c);

    // ── 5. The viewer ─────────────────────────────────────────────────────────────────────────
    await pressAt(c, TILE("budget.csv"), "budget.csv");
    await until(() => evalIn(c, `document.querySelector('.media-viewer')?.getAttribute('aria-label') === "budget.csv"`), 10_000, "the viewer on budget.csv");
    await press(c, `.media-viewer-actions button[aria-label="More actions"]`);
    await until(() => evalIn(c, `!!document.querySelector('.menu[aria-label="budget.csv"]')`), 5_000, "the viewer's menu");
    const viewerRows = await menuRows(c);
    check(`${face}: the viewer's ⋯ ends in the same row for an added file`, viewerRows.at(-1) === "Remove from Library", viewerRows);
    await shot(c, `7-viewer-menu-${face}`);
    const files = await evalIn(c, `window.__liveStore.getState().viewer.files.map((f) => f.name)`);
    const expectNext = files[files.indexOf("budget.csv") + 1] ?? files[files.indexOf("budget.csv") - 1];
    await pressRow(c, "Remove from Library");
    const onShow = await until(async () => { const n = await evalIn(c, `document.querySelector('.media-viewer')?.getAttribute('aria-label') ?? null`); return n && n !== "budget.csv" ? n : null; }, 5_000, "the viewer moved on");
    check(`${face}: …and removing the file on show moves the viewer on to the next one`, onShow === expectNext, { onShow, expectNext });
    await shot(c, `8-viewer-after-remove-${face}`);
    await pressUndo(c);
    await until(() => evalIn(c, `document.querySelector('.media-viewer')?.getAttribute('aria-label') === "budget.csv"`), 5_000, "the viewer back on budget.csv");
    await clearToasts(c);
    await escape(c);
    await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "the viewer closed");

    // ── 6. The documents pane's home ─────────────────────────────────────────────────────────
    await escape(c);
    await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 5_000, "the Library put away");
    if (!(await evalIn(c, `!!document.querySelector('.docs-home')`))) await openSideTool(c, TITLE, "Documents");
    await until(() => evalIn(c, `!!document.querySelector('.docs-home section[aria-label="Library"] .docs-home-row')`), 15_000, "the documents home");
    await sleep(500);
    await rightClick(c, `[...document.querySelectorAll('.docs-home section[aria-label="Library"] .docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === "notes.md")`, "notes.md's row", "notes.md");
    const homeRows = await menuRows(c);
    check(`${face}: the documents home gives an added file's row the same menu`, homeRows.at(-1) === "Remove from Library", homeRows);
    await shot(c, `9-docs-home-menu-${face}`);
    await escapeMenu(c);

    // ── 7. Every file out: the empty state ─────────────────────────────────────────────────────
    await openLibrary();
    // Delete on each added file in turn; a session's file — the message's copy of hero.png — goes with
    // the added one it is a copy of, and Delete on it alone would rightly do nothing.
    for (let n = 0; n < 8; n++) {
      const left = await evalIn(c, `document.querySelectorAll('.library-file').length`);
      if (left === 0) break;
      const focusedOne = await evalIn(c, `(() => { const li = [...document.querySelectorAll('.library-file')].find((x) => x.querySelector('.library-tile-session')?.textContent === "Added");
        if (!li) return false; li.querySelector('.library-tile').focus(); return true; })()`);
      if (!focusedOne) break;
      await backspace(c);
      await until(async () => (await evalIn(c, `document.querySelectorAll('.library-file').length`)) < left, 5_000, "a file out");
    }
    const empty = await until(() => evalIn(c, `document.querySelector('.library-empty')?.textContent ?? null`), 5_000, "the empty state");
    check(`${face}: with the last file out, the page's empty state is back`, empty.startsWith("Nothing here yet."), empty);
    const left = fs.readdirSync(libraryDir).filter((n) => !n.startsWith("."));
    check(`${face}: …and the profile's folder holds no copy, the Desktop every original`,
      left.length === 0 && ORDER.every((n) => sha(path.join(desk, n)) === originals[n]), left);
    await clearToasts(c);
    await hover(c, `document.querySelector('.library-empty')`, "the empty state");
    await shot(c, `10-library-empty-${face}`);
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
await main().catch(async (e) => {
  process.exitCode = 1;
  console.error(`FAIL ${e?.stack ?? e}`);
  // What the window held when it stopped: which page, which files, what had focus, what was up.
  if (page) {
    note("at the failure", await evalIn(page, `({ page: document.querySelector('.page-overlay')?.getAttribute('aria-label') ?? null,
      files: [...document.querySelectorAll('.library-file')].map((li) => li.textContent.slice(0, 40)), menu: !!document.querySelector('.menu'),
      viewer: document.querySelector('.media-viewer')?.getAttribute('aria-label') ?? null, focus: document.activeElement?.className ?? null,
      toasts: [...document.querySelectorAll('.toast-text')].map((t) => t.textContent) })`).catch((x) => String(x)));
    await shot(page, "failure").catch(() => {});
  }
}).finally(teardown);
