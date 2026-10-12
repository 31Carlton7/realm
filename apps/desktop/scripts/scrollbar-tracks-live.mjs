/**
 * The app's scroll bars, looked at: never a track, a thumb only while scrolling or under the pointer
 * (run with: node apps/desktop/scripts/scrollbar-tracks-live.mjs [outDir]).
 *
 * Boots the BUILT app on a scratch home holding a read-only copy of ~/Realm/realm.db (as
 * sidebar-scroll-perf-live.mjs does, every session on the fake agent), once per macOS scroll bar
 * style — overlay (WhenScrolling) and classic (Always), forced on this process alone through
 * NSArgumentDomain — and per face, light and dark. For the sidebar's list and the widest other
 * scroller on screen (a transcript, on the copied layout) it captures the scroller's right edge:
 *   rest     — no pointer near it
 *   hover    — the pointer over the bar's lane, where macOS widens an overlay bar and draws its track
 *   scroll   — mid-scroll with the pointer on the lane
 * and measures the lane: a TRACK is the lane running a different colour from the ground for most of
 * its height away from the thumb, so each capture reports the share of the lane's rows that differ
 * from the column just inside it. Prints PASS/FAIL lines; screenshots go to outDir.
 *
 * SCROLLBARS_HOME (default ~/.cache/realm-perf-scrollfix/home), SCROLLBARS_EVAL (an expression run
 * in the page first, for trying a stylesheet change in place).
 * Ports: REALM_DEVTOOLS_PORT (9278), REALM_PORT (8838). Reaps only what holds its own two ports.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopDaemons } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9278), SERVER_PORT = Number(process.env.REALM_PORT ?? 8838);
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "scrollbar-tracks"));
const HOME = path.resolve(process.env.SCROLLBARS_HOME ?? path.join(os.homedir(), ".cache/realm-perf-scrollfix/home"));
const SCRATCH = path.dirname(HOME);
const DB = path.join(HOME, "realm.db");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
const seenPids = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});
async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
  }
}
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const sql = (stmt) => execFileSync("sqlite3", [DB, stmt], { encoding: "utf8" });
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const setting = (key, value) => sql(`INSERT INTO settings (key, value_json) VALUES (${q(key)}, ${q(JSON.stringify(value))})
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);

function seed() {
  if (fs.existsSync(DB)) return;
  fs.mkdirSync(HOME, { recursive: true });
  execFileSync("sqlite3", [`file:${path.join(os.homedir(), "Realm/realm.db")}?mode=ro`, `VACUUM INTO ${q(DB)}`]);
}

async function boot(bars) {
  const wrapper = path.join(SCRATCH, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "-AppleShowScrollBars", bars], {
    env: {
      ...process.env, REALM_HOME: HOME, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(SCRATCH, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  seenPids.push(electron.pid);
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 90000, "renderer");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return c;
}

async function shutdown(c) {
  try { c?.close(); } catch { /* gone */ }
  electron?.kill("SIGKILL");
  await stopDaemons(HOME, seenPids);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  await sleep(800);
}

/** The scrollers to look at: the sidebar's list, and the tallest other one on screen. */
const FIND = `(() => {
  const out = [];
  const side = document.querySelector('.space-body');
  if (side && side.scrollHeight > side.clientHeight + 40) out.push(side);
  let best = null;
  for (const el of document.querySelectorAll('*')) {
    if (el === side || el.closest('#app-sidebar')) continue;
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight < el.clientHeight + 200 || el.clientHeight < 300) continue;
    if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
  }
  if (best) out.push(best);
  return out.map((el, i) => { el.dataset.liveScroller = String(i); const r = el.getBoundingClientRect();
    return { i, cls: String(el.className).split(' ')[0], x: r.x, y: r.y, w: r.width, h: r.height, gutter: el.offsetWidth - el.clientWidth }; });
})()`;

/** Share of the lane's rows (the bar's 10px at the right edge) that differ from the column 14px in. */
async function laneShare(c, png, box) {
  return evalIn(c, `(async () => {
    const bin = atob('${png}'); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = new OffscreenCanvas(img.width, img.height); const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const px = (x, y) => { const i = (y * img.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const scale = img.width / ${box.w};
    const lane = Math.round(img.width - 4 * scale), inside = Math.round(img.width - 16 * scale);
    let differ = 0, rows = 0;
    for (let y = Math.round(20 * scale); y < img.height - 20 * scale; y += 2) {
      rows++;
      const a = px(lane, y), b = px(inside, y);
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 18) differ++;
    }
    return Math.round(100 * differ / rows);
  })()`);
}

async function look(c, bars, theme) {
  await until(() => evalIn(c, `!!document.querySelector('.space-body .item')`), 60000, "sidebar");
  await evalIn(c, `(() => { document.documentElement.removeAttribute('data-window-inactive');
    new MutationObserver(() => document.documentElement.removeAttribute('data-window-inactive')).observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await sleep(3500);
  if (process.env.SCROLLBARS_EVAL) log("eval", await evalIn(c, process.env.SCROLLBARS_EVAL));
  const overlay = await evalIn(c, `document.documentElement.hasAttribute('data-overlay-scrollbars')`);
  const scrollers = await evalIn(c, FIND);
  log(bars, theme, "overlay", overlay, JSON.stringify(scrollers));
  for (const s of scrollers) {
    // A strip of the scroller's right edge, at twice the pixels, tall enough to show the lane's run.
    const strip = { x: s.x + s.w - 120, y: s.y, w: 120, h: Math.min(s.h, 700) };
    const shoot = async (label) => {
      const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: strip.x, y: strip.y, width: strip.w, height: strip.h, scale: 2 } });
      const file = path.join(OUT, `scrollbar-${bars === "WhenScrolling" ? "overlay" : "classic"}-${theme}-${s.cls}-${label}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      return { file, share: await laneShare(c, data, strip) };
    };
    const laneX = s.x + s.w - 4, midY = s.y + Math.min(s.h, 700) / 2;
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await evalIn(c, `(() => { const el = document.querySelector('[data-live-scroller="${s.i}"]'); el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.6); return true; })()`);
    await sleep(2500);
    const rest = await shoot("rest");
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: laneX - 30, y: midY });
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: laneX, y: midY });
    await sleep(700);
    const hover = await shoot("hover");
    await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: laneX - 30, y: midY, deltaX: 0, deltaY: -60 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: laneX, y: midY });
    await sleep(120);
    const scroll = await shoot("scroll");
    const tag = `${bars}/${theme}/${s.cls}`;
    log(tag, "lane differs on % of rows: rest", rest.share, "hover", hover.share, "scroll", scroll.share, "gutter", s.gutter);
    // A thumb on these long scrollers is well short of the lane; a track runs the whole of it.
    check(`${tag}: no track at rest`, rest.share < 90, rest.share);
    check(`${tag}: no track under the pointer`, hover.share < 90, hover.share);
    check(`${tag}: no track while scrolling`, scroll.share < 90, scroll.share);
  }
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  seed();
  sql(`UPDATE sessions SET agent_kind = 'fake' WHERE agent_kind <> 'fake'`);
  // An opaque ground, so the picture is the app and not whatever sat behind the window.
  setting("ui.groundAlpha", 100);
  for (const bars of (process.env.SCROLLBARS_MODES ?? "WhenScrolling,Always").split(",")) {
    for (const theme of (process.env.SCROLLBARS_THEMES ?? "dark,light").split(",")) {
      setting("ui.theme", theme);
      log("boot", bars, theme);
      const c = await boot(bars);
      try { await look(c, bars, theme); } finally { await shutdown(c); }
    }
  }
}

main().catch(async (e) => { console.log("FAIL", e.message); process.exitCode = 1; await shutdown(null); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void shutdown(null).then(() => process.exit(1)); });
