/**
 * Live check for where the sidebar column's shade falls, and how a page's column is headed
 * (run with: pnpm build && node apps/desktop/scripts/sidebar-shade-live.mjs)
 *
 * The column stands a hair above the rail (the owner, 10-05: "on the left side instead, on the
 * outside of it"): a very light shade off its LEFT edge, over the rail, below the head row and round
 * the column's corner — and none on the panes' edge, where it used to fall. A stylesheet cannot say
 * where a shadow lands or how deep it reads, so this measures pixels: the mean luminance of each
 * column of pixels across the rail's right 12px and the column's first 12px, and across the column's
 * last 12px and the panes' first 12px, against the same capture with the shade taken out (the
 * mutant), summed into one depth per strip. In both faces, under Reduce transparency and Low power, on
 * every page whose column takes the sidebar's place, and on frames of the fold held mid-motion.
 *
 * It also lays the columns side by side: where each one's first row sits under the head row — the
 * Home sidebar's profile, the Backs and the Library's, Scheduled's and Code review's names, all one
 * row at one depth — and which have a Back (Settings and a profile's or a space's settings) and which
 * do not. How even a name stands in its corner is page-heads-live.mjs's.
 *
 * Nothing is billed: the onboarding session is switched to the scripted agent before anything could
 * reach it and nothing is typed into a prompter; `gh` is the fixture's (REALM_GH_BIN), so nothing
 * reaches GitHub. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8983 / 9413). Scratch under LIVE_SCRATCH
 * (default: the OS temp dir), screenshots under LIVE_SHOTS (default: the scratch's parent). Kills only
 * what holds its own two ports, and only if it is this run's.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { buildFixture } from "../../server/scripts/fixtures/code-review-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8983);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9413);
/** Chromium's switches for a window that is covered: lay it out and run its timers anyway. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1280, height: 820 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-shade-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "shade-shots");
const home = path.join(scratch, "home");
let electron = null;
let api = null;
const daemonPids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

/* The fixture's gh, signed in, so Code review draws its column of requests. */
const ghDir = path.join(scratch, "gh");
fs.mkdirSync(ghDir, { recursive: true });
const fixturePath = path.join(ghDir, "fixture.json");
fs.writeFileSync(fixturePath, JSON.stringify({ ...buildFixture(), auth: "ready" }));
const ghBin = path.join(ghDir, "gh");
fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${path.join(ghDir, "calls.jsonl")}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`);
fs.chmodSync(ghBin, 0o755);

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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

const HELPERS = `
globalThis.__shade = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; },
  /* The middle of a run of text as laid out — the line box a reader's eye lands on, not its element's. */
  textMid(el) { if (!el) return null; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { if (n.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect();
      return { mid: +((b.top + b.bottom) / 2).toFixed(2), left: +b.left.toFixed(2), text: n.textContent.trim() }; } } return null; },
  railBtn(name) { return document.querySelector('.app-rail .rail-btn[aria-label^="' + name + '"]'); },
  menuRow(text) { return [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim().startsWith(text)) ?? null; },
  toggle() { return document.querySelector('button[aria-controls="app-sidebar"]'); },
  foldAnim() { return document.getAnimations().find((a) => a.transitionProperty === '--sidebar-open') ?? null; },
  addStyle(id, text) { document.getElementById(id)?.remove(); const st = document.createElement('style'); st.id = id; st.textContent = text; document.head.appendChild(st); return true; },
  dropStyle(id) { document.getElementById(id)?.remove(); return true; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => console.log(`NOTE ${name} ${JSON.stringify(detail)}`);

/** Two frames: what a style change has to wait for before a capture can see it. */
const settle = (c) => evalIn(c, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 });
/** Hold the window key: an unkeyed window greys its accent, and the live window opens behind. */
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);

/** Per-column mean luminance of a clip (CSS px), in DEVICE columns, with each column's mean alpha.
 *  A shade this light is a couple of levels at its deepest, so one number per column against its
 *  neighbours is what "is there a shadow here" asks — an average over the whole clip would bury it. */
async function columns(c, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { ...clip, scale: 1 } });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    const cols = [], alpha = [];
    for (let x = 0; x < cv.width; x++) {
      let s = 0, a = 0;
      for (let y = 0; y < cv.height; y++) { const i = (y * cv.width + x) * 4; s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; a += px[i + 3]; }
      cols.push(+(s / cv.height).toFixed(3)); alpha.push(+(a / cv.height).toFixed(1));
    }
    return { cols, alpha, k: img.width / ${clip.width} };
  })()`);
}

/** The shade, taken out: the mutant every reading is measured against. Both places it has lived. */
const SHADE_OFF = `.sidebar-shade { display: none !important; } .app:not([data-sidebar-folded]) > .main::after { display: none !important; }`;

/** The two seams' strips, with and without the shade. `depth` is per CSS px column, in 8-bit levels
 *  (positive = darker than the ground without the shade), and each side of a seam is summed across
 *  its 12px — `outside` the column and `inside` it at the rail, the `column` and the `panes` at the
 *  seam — which is how the depth was matched when the shade was first lightened (10-04): at a couple
 *  of levels the gradient lands in whole steps, so its peak alone says little. */
async function seams(c) {
  const g = await evalIn(c, `(() => ({ rail: document.querySelector('.app-rail').getBoundingClientRect().right,
    main: document.querySelector('.main').getBoundingClientRect().left,
    column: document.getElementById('app-sidebar').getBoundingClientRect().width }))()`);
  // A band clear of the rail's destinations above and the person at its foot.
  const top = 290, bottom = VIEW.height - 120;
  const clipRail = { x: Math.round(g.rail) - 12, y: top, width: 24, height: bottom - top };
  const clipMain = { x: Math.round(g.main) - 12, y: top, width: 24, height: bottom - top };
  const railOn = await columns(c, clipRail), mainOn = await columns(c, clipMain);
  await evalIn(c, `__shade.addStyle('shade-off', ${JSON.stringify(SHADE_OFF)})`);
  await settle(c);
  const railOff = await columns(c, clipRail), mainOff = await columns(c, clipMain);
  await evalIn(c, `__shade.dropStyle('shade-off')`);
  await settle(c);
  const fold = (on, off) => {
    const k = on.k;
    const perCss = [];
    for (let i = 0; i < on.cols.length; i += k) {
      let d = 0;
      for (let j = 0; j < k; j++) d += off.cols[i + j] - on.cols[i + j];
      perCss.push(+(d / k).toFixed(2));
    }
    return { depth: perCss, ground: on.cols.slice(0, k).reduce((a, b) => a + b, 0) / k, alpha: Math.min(...on.alpha) };
  };
  const rail = fold(railOn, railOff), main = fold(mainOn, mainOff);
  // The rail's right 12px are the strip's first twelve CSS columns; the column's first 12px the rest.
  return { geom: g, rail: { ...rail, outside: +rail.depth.slice(0, 12).reduce((a, b) => a + b, 0).toFixed(2), inside: +rail.depth.slice(12).reduce((a, b) => a + b, 0).toFixed(2) },
    main: { ...main, column: +main.depth.slice(0, 12).reduce((a, b) => a + b, 0).toFixed(2), panes: +main.depth.slice(12).reduce((a, b) => a + b, 0).toFixed(2) } };
}

/** The head row's band over the rail's edge: the shade must not reach it. Rows 24–39, the 8px left
 *  of the column. */
async function headBand(c) {
  const rail = await evalIn(c, `document.querySelector('.app-rail').getBoundingClientRect().right`);
  const clip = { x: Math.round(rail) - 8, y: 24, width: 8, height: 16 };
  const on = await columns(c, clip);
  await evalIn(c, `__shade.addStyle('shade-off', ${JSON.stringify(SHADE_OFF)})`);
  await settle(c);
  const off = await columns(c, clip);
  await evalIn(c, `__shade.dropStyle('shade-off')`);
  await settle(c);
  return +on.cols.reduce((s, v, i) => s + (off.cols[i] - v), 0).toFixed(2) / on.k;
}

/** The corner, row by row: for each row from just above the rim down, the depth summed over the 12px
 *  left of the column's edge and over the 16px right of it (where the corner's outside is chrome). */
async function cornerRows(c) {
  const rail = Math.round(await evalIn(c, `document.querySelector('.app-rail').getBoundingClientRect().right`));
  const rows = [];
  const capture = async () => {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: rail - 12, y: 36, width: 28, height: 24, scale: 1 } });
    return data;
  };
  const on = await capture();
  await evalIn(c, `__shade.addStyle('shade-off', ${JSON.stringify(SHADE_OFF)})`);
  await settle(c);
  const off = await capture();
  await evalIn(c, `__shade.dropStyle('shade-off')`);
  await settle(c);
  const grid = await evalIn(c, `(async () => {
    const read = async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, cv.width, cv.height).data; const L = [];
      for (let y = 0; y < cv.height; y++) { const row = []; for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; row.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]); } L.push(row); }
      return { L, k: img.width / 28 }; };
    const a = await read(${JSON.stringify(on)}), b = await read(${JSON.stringify(off)});
    return { k: a.k, d: a.L.map((row, y) => row.map((v, x) => +(b.L[y][x] - v).toFixed(1))) };
  })()`);
  const k = grid.k;
  for (let cy = 0; cy < 24; cy++) {
    let left = 0, right = 0;
    for (let j = 0; j < k; j++) {
      const row = grid.d[cy * k + j];
      for (let x = 0; x < 12 * k; x++) left += row[x];
      for (let x = 12 * k; x < 28 * k; x++) right += row[x];
    }
    rows.push({ y: 36 + cy, left: +(left / (k * k)).toFixed(2), right: +(right / (k * k)).toFixed(2) });
  }
  return rows;
}

/** A capture as a person would see it. A capture holds the DOM's alpha and none of the material, so
 *  it is laid over the face's page colour first, as a picture that leaves the window is (design.md). */
async function shot(c, tag, clip, scale = 1) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale } } : {}) });
  const data = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(r.data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return data;
}

/** Where the shade falls, drawn large: each pixel's depth against the mutant, times `gain`, white on
 *  black, every device pixel a block of `zoom`. A couple of levels is invisible in a capture; its
 *  footprint is not. */
async function shadeMap(c, tag, clip, { gain = 60, zoom = 4 } = {}) {
  const capture = async () => (await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } })).data;
  const on = await capture();
  await evalIn(c, `__shade.addStyle('shade-off', ${JSON.stringify(SHADE_OFF)})`);
  await settle(c);
  const off = await capture();
  await evalIn(c, `__shade.dropStyle('shade-off')`);
  await settle(c);
  const data = await evalIn(c, `(async () => {
    const read = async (b64) => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, cv.width, cv.height); };
    const a = await read(${JSON.stringify(on)}), b = await read(${JSON.stringify(off)});
    const L = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const z = ${zoom}, out = document.createElement("canvas"); out.width = a.width * z; out.height = a.height * z;
    const g = out.getContext("2d");
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4, v = Math.max(0, Math.min(255, Math.round((L(b.data, i) - L(a.data, i)) * ${gain})));
      g.fillStyle = "rgb(" + v + "," + v + "," + v + ")"; g.fillRect(x * z, y * z, z, z);
    }
    return out.toDataURL("image/png").split(",")[1];
  })()`);
  const file = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${file}`);
}

/** Several captures laid side by side on one canvas, each under its name — the columns compared. */
async function sideBySide(c, tag, parts) {
  const data = await evalIn(c, `(async () => {
    const parts = ${JSON.stringify(parts)};
    const imgs = await Promise.all(parts.map(async (p) => { const i = new Image(); i.src = "data:image/png;base64," + p.data; await i.decode(); return i; }));
    const gap = 16, label = 36;
    const w = imgs.reduce((s, i) => s + i.width, 0) + gap * (imgs.length + 1), h = Math.max(...imgs.map((i) => i.height)) + label + gap;
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d");
    g.fillStyle = "#808080"; g.fillRect(0, 0, w, h);
    let x = gap;
    imgs.forEach((img, n) => { g.fillStyle = "#000"; g.font = "600 24px Inter, sans-serif"; g.fillText(parts[n].name, x, 26); g.drawImage(img, x, label); x += img.width + gap; });
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      REALM_GH_BIN: ghBin,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 2, mobile: false });
  return c;
}

async function reload(c, ready, tag) {
  await c.send("Page.reload", {});
  await until(() => evalIn(c, ready), 30_000, tag);
  await holdKey(c);
  await park(c);
  await sleep(900);
}

const HOME_READY = `!!document.querySelector('.composer') && !!document.querySelector('.sb-profile')`;

async function setFace(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await reload(c, `${HOME_READY} && document.documentElement.dataset.mode === '${mode}'`, `the ${mode} face`);
}

async function goHome(c) {
  await evalIn(c, `__shade.railBtn('Home').click()`);
  await until(() => evalIn(c, `!document.querySelector('.page-overlay') && !!document.querySelector('.sb-profile')`), 8_000, "home");
  await park(c);
  await sleep(500);
}

/** Each page whose column takes the sidebar's place, opened the way a person opens it. */
const PAGES = [
  { name: "Settings", back: true, open: `(async () => { document.querySelector('.app-rail .rail-foot button[aria-haspopup="menu"]').click();
      await new Promise((r) => setTimeout(r, 300)); __shade.menuRow('Settings').click(); return true; })()`,
    ready: `!!document.querySelector('.sb-page-nav .settings-rail')` },
  { name: "Library", back: false, title: true, open: `__shade.railBtn('Library').click()`, ready: `!!document.querySelector('.sb-page-nav .page-rail .settings-tab')` },
  { name: "Scheduled", back: false, title: true, open: `__shade.railBtn('Scheduled tasks').click()`, ready: `!!document.querySelector('.sb-page-nav .sched-col-head')` },
  { name: "Code review", back: false, title: true, open: `__shade.railBtn('Code review').click()`, ready: `!!document.querySelector('.sb-page-nav .cr-col:not([aria-hidden]) .cr-col-head')` },
  { name: "Profile", back: true, open: `(async () => { document.querySelector('.sb-profile').click();
      await new Promise((r) => setTimeout(r, 300)); __shade.menuRow('Profile settings').click(); return true; })()`,
    ready: `document.querySelector('.page-overlay')?.getAttribute('aria-label') === 'Profile' && !!document.querySelector('.sb-page-nav .settings-tab')` },
  { name: "Overview", back: true, open: `(() => { document.querySelector('.panel-crumb').click(); return true; })()`,
    ready: `document.querySelector('.page-overlay')?.getAttribute('aria-label') === 'Overview' && !!document.querySelector('.sb-page-nav .settings-tab')` },
];

/** Where a column's first row sits: its box, and the middle of its text. A page's name is read off its
 *  head's row, the column's own (the Library's) or the one its column brings. */
const FIRST_ROW = `(() => {
  const col = document.getElementById('app-sidebar');
  const back = col.querySelector('.sb-page-back');
  const nav = col.querySelector('.sb-page-nav');
  const profile = col.querySelector('.sb-list:not([hidden]) .sb-profile');
  const title = col.querySelector('.sb-page-title') ?? nav?.querySelector('.sched-col-title, .cr-col:not([aria-hidden]) .cr-col-title');
  const first = profile ?? back ?? title?.parentElement ?? nav?.querySelector('.settings-search, .page-rail .settings-tab');
  const text = profile ? profile.querySelector('.sb-profile-name') : back ?? title ?? first;
  const next = back ? nav?.querySelector('.settings-search, .page-rail .settings-tab') : title ? nav.querySelector('.page-rail .settings-tab, .sched-new, .cr-col-search') : null;
  // A head's row is its content box, its padding being the inset this measures; any other row's box
  // is its fill.
  const row = __shade.box(first);
  if (row && title) row.t += parseFloat(getComputedStyle(first).paddingTop);
  return { back: !!back, title: !!title, row, text: __shade.textMid(text), next: __shade.box(next),
    rim: Math.round(col.querySelector('.sb-header').getBoundingClientRect().bottom),
    depth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--col-head-top')) };
})()`;

async function measureFace(c, mode) {
  /* ── Home: the shade on the rail's edge, none on the panes' ─────────────────────────────────── */
  const homeSeams = await seams(c);
  note(`${mode} home: rail strip depth per CSS px (rail's right 12 | column's first 12)`, homeSeams.rail.depth);
  note(`${mode} home: seam strip depth per CSS px (column's last 12 | panes' first 12)`, homeSeams.main.depth);
  note(`${mode} home: grounds`, { rail: +homeSeams.rail.ground.toFixed(2), column: +homeSeams.main.ground.toFixed(2), alphaRail: homeSeams.rail.alpha, alphaMain: homeSeams.main.alpha, geom: homeSeams.geom });
  // Present, and only that, here: over a translucent ground a capture holds the DOM's alpha and none of
  // the material, so its depth is not the screen's. The depth is held below, on solid grounds.
  check(`${mode}: the column casts its shade over the rail's edge`, homeSeams.rail.outside >= 2, { summed: homeSeams.rail.outside });
  check(`${mode}: …and none on the panes' edge`, Math.abs(homeSeams.main.panes) < 0.3 && Math.abs(homeSeams.main.column) < 0.3, { panes: homeSeams.main.panes, column: homeSeams.main.column });
  const band = await headBand(c);
  check(`${mode}: the head row takes none of it`, Math.abs(band) < 0.3, { band });
  /* The shade's box covers the column and comes after its buttons in the document, which is the order
     Electron lays drag regions down in: a `drag` there would take every click in the column for a
     window drag, a `no-drag` would stop the window moving by the column. It must set neither. */
  const region = await evalIn(c, `getComputedStyle(document.querySelector('.sidebar-shade')).getPropertyValue('-webkit-app-region')`);
  check(`${mode}: the shade takes no part in the window's drag regions`, region === "none", { region });
  const corner = await cornerRows(c);
  note(`${mode} corner rows (depth summed over the 12px left of the column's edge | the 16px right of it)`, corner.map((r) => `${r.y}:${r.left}|${r.right}`).join(" "));
  check(`${mode}: the corner's shade stops at the rim — nothing above it`, corner.filter((r) => r.y < 40).every((r) => Math.abs(r.left) < 0.3 && Math.abs(r.right) < 0.3), corner.filter((r) => r.y < 40));
  const shades = corner.filter((r) => r.y >= 40);
  // Following the curve: it fades in from the rim to the straight edge, never a band at full depth
  // running up into the corner.
  check(`${mode}: …and grows from the rim to the straight edge, following the curve`,
    shades[0].left + shades[0].right < shades[shades.length - 1].left * 0.5, { first: shades[0], last: shades[shades.length - 1] });
  await shot(c, `${mode}-home`, { x: 0, y: 0, width: 640, height: 420 });
  await shot(c, `${mode}-corner-x6`, { x: 34, y: 28, width: 44, height: 44 }, 3);
  // The footprint round the corner, and down both seams (the rail's edge, and the panes').
  await shadeMap(c, `${mode}-shade-map-corner`, { x: 36, y: 30, width: 40, height: 40 });
  const seamX = Math.round(homeSeams.geom.main);
  await shadeMap(c, `${mode}-shade-map-rail-edge`, { x: 36, y: 30, width: 40, height: 140 }, { zoom: 2 });
  await shadeMap(c, `${mode}-shade-map-panes-edge`, { x: seamX - 20, y: 30, width: 40, height: 140 }, { zoom: 2 });

  /* ── The pages whose column takes the sidebar's place ───────────────────────────────────────── */
  const homeRow = await evalIn(c, FIRST_ROW);
  note(`${mode} Home's first row`, homeRow);
  /* Every column's first row stands one depth under the rim — the profile here, a Back or a page's
     name on the pages below — so going from Home to a page moves nothing (the owner, 10-06: "add some
     top padding to the profile switcher and where the back button is"). */
  check(`${mode} Home: its profile stands the column's first-row depth under the rim`, Math.abs(homeRow.row.t - homeRow.rim - homeRow.depth) <= 0.5,
    { gap: +(homeRow.row.t - homeRow.rim).toFixed(2), depth: homeRow.depth });
  const parts = [{ name: "Home", data: await shot(c, `${mode}-column-home`, { x: 0, y: 0, width: 330, height: 200 }) }];
  for (const p of PAGES) {
    await evalIn(c, p.open);
    await until(() => evalIn(c, p.ready), 15_000, p.name);
    await park(c);
    await sleep(800);
    const row = await evalIn(c, FIRST_ROW);
    note(`${mode} ${p.name}'s first row`, row);
    check(`${mode} ${p.name}: ${p.back ? "keeps its Back" : "has no Back"}`, row.back === p.back, { back: row.back });
    if (p.title) check(`${mode} ${p.name}: its name heads the column`, row.title, { title: row.title });
    const off = row.text.mid - homeRow.text.mid;
    check(`${mode} ${p.name}: its first row's text is on the Home sidebar's first row's line`, Math.abs(off) <= 1, { text: row.text, home: homeRow.text.mid });
    check(`${mode} ${p.name}: …its row at the depth every column's first row stands at`, Math.abs(row.row.t - row.rim - row.depth) <= 0.5,
      { gap: +(row.row.t - row.rim).toFixed(2), depth: row.depth });
    const s = await seams(c);
    check(`${mode} ${p.name}: the column's shade is on the rail's edge, at the Home depth`, Math.abs(s.rail.outside - homeSeams.rail.outside) <= 0.6,
      { summed: s.rail.outside, home: homeSeams.rail.outside });
    check(`${mode} ${p.name}: …and none on the page's edge`, Math.abs(s.main.panes) < 0.3, { panes: s.main.panes });
    parts.push({ name: p.name, data: await shot(c, `${mode}-column-${p.name.toLowerCase().replace(/\s+/g, "-")}`, { x: 0, y: 0, width: 330, height: 200 }) });
    await shot(c, `${mode}-page-${p.name.toLowerCase().replace(/\s+/g, "-")}`, { x: 0, y: 0, width: 760, height: 480 });
    await goHome(c);
  }
  await sideBySide(c, `${mode}-columns-side-by-side`, parts);

  /* ── The fold, held mid-motion ───────────────────────────────────────────────────────────────
     The column's clock slowed to 20s, so a frame can be held where it is and read: the transition is
     paused and seeked, which is the real interpolation at that point of the real easing. */
  await evalIn(c, `__shade.addStyle('slow-fold', '.sidebar { transition-duration: 20s !important; }')`);
  await settle(c);
  await evalIn(c, `__shade.toggle().click()`);
  await until(() => evalIn(c, `!!__shade.foldAnim()`), 3_000, "the fold's transition");
  await evalIn(c, `(() => { __shade.foldAnim().pause(); return true; })()`);
  const fold = [];
  for (const t of [0.25, 0.5, 0.75, 0.85, 0.9, 0.95, 0.98, 0.995]) {
    await evalIn(c, `(() => { __shade.foldAnim().currentTime = ${t} * 20000; return true; })()`);
    await settle(c);
    const s = await seams(c);
    fold.push({ t, width: +s.geom.column.toFixed(1), rail: s.rail.outside, panes: s.main.panes, folded: await evalIn(c, `document.querySelector('.app').hasAttribute('data-sidebar-folded')`) });
    await shot(c, `${mode}-fold-${String(t).replace(".", "_")}`, { x: 0, y: 0, width: 420, height: 260 });
    if (t === 0.5 || t === 0.75) await shadeMap(c, `${mode}-shade-map-fold-${String(t).replace(".", "_")}`, { x: 36, y: 30, width: 40, height: 60 });
  }
  note(`${mode} folding: width, the rail's summed shade, the panes'`, fold);
  check(`${mode}: while the column folds its shade holds the rail's edge`, fold.filter((f) => f.width >= 20).every((f) => Math.abs(f.rail - homeSeams.rail.outside) <= 0.6), fold);
  check(`${mode}: …fades out with the last of the column`, fold.filter((f) => f.width < 8).every((f) => f.rail < homeSeams.rail.outside * 0.5), fold.filter((f) => f.width < 8));
  check(`${mode}: …and the panes' edge takes none on any frame`, fold.every((f) => Math.abs(f.panes) < 0.3), fold.map((f) => f.panes));
  await evalIn(c, `(() => { __shade.foldAnim()?.finish(); return true; })()`);
  await until(() => evalIn(c, `document.querySelector('.app').hasAttribute('data-sidebar-folded')`), 25_000, "folded");
  await park(c);
  await sleep(400);
  const folded = await seams(c);
  note(`${mode} folded`, { rail: folded.rail.depth, main: folded.main.depth, geom: folded.geom });
  check(`${mode}: folded away, there is no shade at all`, Math.abs(folded.rail.outside) < 0.3 && Math.abs(folded.rail.inside) < 0.3, { rail: folded.rail.outside, inside: folded.rail.inside });
  await shot(c, `${mode}-folded`, { x: 0, y: 0, width: 420, height: 260 });
  await shot(c, `${mode}-folded-corner-x6`, { x: 34, y: 28, width: 44, height: 44 }, 3);
  // …and back open.
  await evalIn(c, `__shade.toggle().click()`);
  await until(() => evalIn(c, `!!__shade.foldAnim()`), 3_000, "the opening's transition");
  await evalIn(c, `(() => { __shade.foldAnim().pause(); return true; })()`);
  const opening = [];
  for (const t of [0.05, 0.1, 0.15, 0.25, 0.5]) {
    await evalIn(c, `(() => { __shade.foldAnim().currentTime = ${t} * 20000; return true; })()`);
    await settle(c);
    const s = await seams(c);
    opening.push({ t, width: +s.geom.column.toFixed(1), rail: s.rail.outside, panes: s.main.panes });
    await shot(c, `${mode}-open-${String(t).replace(".", "_")}`, { x: 0, y: 0, width: 420, height: 260 });
  }
  note(`${mode} opening: width, the rail's summed shade, the panes'`, opening);
  check(`${mode}: opening, the shade comes in with the column — none before it has any width`,
    opening.filter((f) => f.width < 8).every((f) => f.rail < homeSeams.rail.outside * 0.5) && opening.filter((f) => f.width >= 20).every((f) => Math.abs(f.rail - homeSeams.rail.outside) <= 0.6), opening);
  await evalIn(c, `(() => { __shade.foldAnim()?.finish(); return true; })()`);
  await evalIn(c, `__shade.dropStyle('slow-fold')`);
  await until(() => evalIn(c, `!document.getElementById('app-sidebar').hasAttribute('data-collapsed') && Math.abs(document.getElementById('app-sidebar').getBoundingClientRect().width - parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue('--sidebar-w'))) < 0.5`), 25_000, "open again");
  await park(c);
  await sleep(400);
  return homeSeams;
}

/* What the depth has to come to on the rail, summed over its right 12px, per face, on SOLID grounds
   (Reduce transparency), the one case where a capture is exactly what the screen shows; the shade
   lands in whole 8-bit steps, so the window is one step of rounding either way. Light is the depth the
   shade had on the panes' edge before it moved — the one the owner settled on (10-04) — measured by
   this script on the build before (588778af), over the panes' first 12px. Dark is set on the owner's
   own translucent window instead (a7cbf699: there the matched 0.045 read about a sixth lighter than
   the panes' shade did), which on solid grounds sums to 8.0 against the panes' 6.26. */
const TARGET = { dark: 8.01, light: 8.5 };
const STEP = 0.6;

async function main() {
  const c = await launch();
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const daemon = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  if (daemon.pid) daemonPids.push(daemon.pid);
  // Onboarding's session runs the person's real engine; it is switched to the fake before anything
  // could reach it, and every later session starts on the fake.
  for (const s of await api.call("sessions.listAll", { profileId: null })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });

  const faces = {};
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    faces[mode] = await measureFace(c, mode);
  }

  /* ── Reduce transparency: every ground goes solid, so the shade lands on the opaque rail ────── */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  for (const mode of ["light", "dark"]) {
    await setFace(c, mode);
    const s = await seams(c);
    note(`${mode} reduced transparency: rail strip depth`, s.rail.depth);
    note(`${mode} reduced transparency: grounds`, { rail: +s.rail.ground.toFixed(2), alpha: s.rail.alpha });
    check(`${mode}, reduced transparency: the rail's shade is at its depth`, Math.abs(s.rail.outside - TARGET[mode]) <= STEP,
      { summed: s.rail.outside, target: TARGET[mode] });
    check(`${mode}, reduced transparency: …and none on the panes' edge`, Math.abs(s.main.panes) < 0.3, { panes: s.main.panes });
    await shot(c, `${mode}-reduced-transparency`, { x: 0, y: 0, width: 640, height: 420 });
  }
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  /* ── Low power: it quiets motion, and changes no ground ─────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.lowPower", value: true });
  await reload(c, `${HOME_READY} && document.documentElement.getAttribute('data-quiet') === 'always'`, "low power");
  const quiet = await seams(c);
  check("dark, Low power: the same shade, in the same place", Math.abs(quiet.rail.outside - faces.dark.rail.outside) <= 0.3 && Math.abs(quiet.main.panes) < 0.3,
    { summed: quiet.rail.outside, normal: faces.dark.rail.outside, panes: quiet.main.panes });
  await api.call("settings.set", { key: "ui.lowPower", value: false });
  c.close();
}

/** Kill whatever still listens on one of this run's ports, but only if it is this run's. */
function killPort(port) {
  const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
    if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home, daemonPids);
  for (const port of [SERVER_PORT, CDP_PORT]) killPort(port);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.stack ?? e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
