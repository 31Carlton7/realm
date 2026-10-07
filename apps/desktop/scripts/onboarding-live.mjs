/**
 * Live check for the first run (run with: pnpm build && node apps/desktop/scripts/onboarding-live.mjs)
 *
 * First run is one page that takes the whole window — what Realm is, the agent (Claude and Codex as
 * cards that install and sign in in place), the space, Start — and jsdom has no layout: it will say
 * the cards exist and nothing about whether they sit side by side, whether the page fits, whether
 * the rail and sidebar really went, or where Start ended up. Those are the questions this answers.
 *
 * It boots the built app on a scratch home, which lands straight on the page (no spaces exist), and
 * measures at a wide window and a very narrow one, in both faces, after the agent PROBE lands. The
 * cards' states are this Mac's (a read-only probe of the CLIs on PATH and the one Realm carries), so
 * they are reported, not claimed.
 *
 * What it caught before, and would catch again: `minmax(248px, 1fr)` reads like a hint and is a
 * FLOOR, so a track keeps its minimum after there is less room than that and hangs out of the page —
 * visible only at a width barely wider than one column.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only what holds its own two ports.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9381), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8947);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-onboarding-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Raw pixels of a clip, as [y][x] RGB triples. The reduction is done in node, per sample point,
 *  because averaging ALONG a divider is what made the first version of this script cry wolf: one
 *  icon sitting against the line pulled the neighbour's mean up to the line's own value. */
const PIXELS = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const rows = [];
  for (let y = 0; y < cv.height; y++) {
    const row = [];
    for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; row.push([d[i], d[i+1], d[i+2]]); }
    rows.push(row);
  }
  return rows;
})()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} in use`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  electron = spawn(path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [wrapper], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"] });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith("file://")), 30000, "renderer");
  const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding')`), 20000, "onboarding");
  // The window this opens is rarely the key one, and an unkeyed Mac window greys its accent — the
  // chosen card's ring and Start are drawn in it, so the run is told it has focus and kept so.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  // Wait for the probe to actually LAND: before it, both cards say "Checking…", which is not the state
  // a real machine sits in and not the one worth reviewing.
  await until(() => evalIn(c, `![...document.querySelectorAll('.agent-card-status')].some((e) => e.textContent.includes('Checking'))`), 40000, "probe");
  await sleep(600);
  const OUT = process.env.LIVE_OUT ?? os.tmpdir();
  fs.mkdirSync(OUT, { recursive: true });

  const GEO = `(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
    const shown = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; };
    const stage = document.querySelector('.onboarding-stage');
    const mark = document.querySelector('img.onboarding-mark');
    return {
      firstRun: document.querySelector('.app')?.hasAttribute('data-first-run') ?? false,
      rail: shown('.app-rail'), sidebar: shown('.sidebar'),
      stage: box(stage), win: { w: innerWidth, h: innerHeight },
      overflowX: stage ? stage.scrollWidth > stage.clientWidth + 1 : null,
      scrolls: stage ? stage.scrollHeight > stage.clientHeight + 1 : null,
      drag: stage ? getComputedStyle(stage, '::before').getPropertyValue('-webkit-app-region') : null,
      mark: mark ? { loaded: mark.complete && mark.naturalWidth > 0, ...box(mark) } : null,
      cards: [...document.querySelectorAll('.agent-card')].map((e) => ({ name: e.querySelector('.agent-card-name')?.textContent,
        state: e.querySelector('.agent-card-foot')?.textContent?.trim(), ...box(e) })),
      start: box(document.querySelector('.onboarding-start')),
      summary: document.querySelector('.onboarding-summary')?.textContent ?? null,
      focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
      swatches: document.querySelectorAll('.onboarding-space .swatch').length,
      iconTrigger: !!document.querySelector('.onboarding-space .space-tile'),
    };
  })()`;

  const shot = async (name) => {
    const png = await c.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `onboarding-${name}.png`);
    fs.writeFileSync(file, Buffer.from(png.data, "base64"));
    console.log(`SCREENSHOT ${file}`);
  };

  for (const [label, w, h] of [["wide", 1200, 860], ["narrow", 520, 860]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    for (const mode of ["dark", "light"]) {
      await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
      await sleep(300);
      const g = await evalIn(c, GEO);
      await shot(`${label}-${mode}`);
      if (mode !== "dark") continue;
      console.log(`INFO ${label} ${w}x${h} ${JSON.stringify({ cards: g.cards.map((k) => [k.name, k.state]), summary: g.summary, scrolls: g.scrolls })}`);
      check(`${label}: first run takes the whole window — no rail, no sidebar`, g.firstRun && !g.rail && !g.sidebar && Math.abs(g.stage.w - g.win.w) <= 1, { firstRun: g.firstRun, rail: g.rail, sidebar: g.sidebar, stage: g.stage, win: g.win });
      check(`${label}: the window can still be dragged by its top band`, g.drag === "drag", g.drag);
      check(`${label}: Realm's mark is drawn`, g.mark?.loaded === true, g.mark);
      const [a, b] = g.cards;
      if (label === "wide") {
        check("wide: Claude and Codex as two cards, side by side", g.cards.length === 2 && a.name === "Claude" && b.name === "Codex" && Math.abs(a.y - b.y) < 2 && b.x >= a.right - 1, g.cards);
        // The first impression is the whole decision: at an ordinary window it fits, Start included.
        check("wide: the whole page fits the window, Start on screen", !g.scrolls && g.start.bottom <= g.win.h, { start: g.start, win: g.win });
      } else {
        check("narrow: the cards stack, Claude first", g.cards.length === 2 && b.y >= a.bottom - 1 && Math.abs(a.x - b.x) < 2, g.cards);
      }
      check(`${label}: nothing runs off the side`, g.overflowX === false, { overflowX: g.overflowX });
      check(`${label}: focus lands in the name field`, g.focused === "Space name", g.focused);
      check(`${label}: the identity controls are both there`, g.swatches === 10 && g.iconTrigger, { swatches: g.swatches, iconPicker: g.iconTrigger });
    }
  }
  await c.send("Emulation.clearDeviceMetricsOverride");
  c.close();
}
/**
 * The server is a SECOND Electron, spawned by the one this started, and killing the parent leaves it
 * holding REALM_PORT — an earlier run's sat on both ports for forty minutes. So teardown clears the
 * two ports by owner rather than by pid, which also catches an orphan of an interrupted run; the run
 * refused to start while either was taken, so nothing else can be on them.
 */
function reap() {
  electron?.kill("SIGKILL");
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
main().catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; }).finally(reap);
for (const sig of ["SIGINT", "SIGTERM", "SIGALRM"]) process.on(sig, () => { reap(); process.exit(1); });
