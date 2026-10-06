/**
 * Live check: a transcript never scrolls sideways, and no scrollbar corner paints white
 * (run with: pnpm build && node apps/desktop/scripts/transcript-overflow-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, sends the scripted `fake` agent two messages with
 * screenshots attached — under the long names a screenshot tool gives them — and measures, in the
 * real window, at two pane widths:
 *
 *   1. The transcript is exactly as wide as its viewport. A sent tile's hover tip, centred on a
 *      tile that hugs the right edge, used to overhang it by up to a hundred pixels — unseen, but
 *      overflow, so every transcript with a screenshot in it grew a horizontal scrollbar.
 *   2. Hovered, the tip is fully on screen and inside the transcript, and still adds no width.
 *   3. Where a vertical and a horizontal bar DO meet (forced, with a wide element), the corner is
 *      not white. Sampled from a capture of the page, which Blink paints the bars into.
 *
 * Ports: LIVE_SERVER_PORT (8851), LIVE_CDP_PORT (9291). Touches only a scratch dir. Nothing is billed:
 * the agent is `fake`.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9291);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8851);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-transcript-overflow-live-"));
const home = path.join(scratch, "home");
const TITLE = "Transcript overflow live check";
const OUT = (tag) => path.join(os.tmpdir(), `realm-transcript-overflow-${tag}.png`);
/** A real 8×8 PNG, so the tile draws a thumbnail as a screenshot's does. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64");
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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
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
  const resize = (width) => c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await resize(1000);

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home), () => {});
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  // Screenshots under the names a screenshot tool gives them: long enough to fill the tip's 260px.
  const shots = ["CleanShot 2026-10-01 at 12.27.41 AM@2x.png", "CleanShot 2026-10-01 at 3.13.44 PM@2x.png"].map((name) => {
    const p = path.join(scratch, name); fs.writeFileSync(p, PNG); return p;
  });
  for (const p of shots) await api.call("sessions.send", { id: session.id, text: "These white squares are still here", attachments: [{ path: p, mime: "image/png" }], mentions: [] });
  await until(() => evalIn(c, `document.querySelectorAll('.msg-user-files .attach-tile').length >= 2`), 20_000, "sent tiles");
  await sleep(800);

  const transcript = `[...document.querySelectorAll('.panehost .transcript')].find((x) => x.offsetParent)`;
  for (const width of [1000, 800]) {
    await resize(width);
    await sleep(600);
    const w = await evalIn(c, `(() => { const t = ${transcript}; return { client: t.clientWidth, scroll: t.scrollWidth }; })()`);
    check(`at a ${width}px window the transcript is as wide as its viewport`, w.scroll === w.client, w);
  }

  // Hovered: on screen, inside the transcript, and still no wider.
  await evalIn(c, `(() => { document.querySelector('.msg-user-files .attach-tile').scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(300);
  await c.send("DOM.enable"); await c.send("CSS.enable");
  const { root } = await c.send("DOM.getDocument", {});
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".msg-user-files .attach-tile" });
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  await sleep(400);
  const tip = await evalIn(c, `(() => {
    const t = ${transcript}, tile = document.querySelector('.msg-user-files .attach-tile'), tip = tile.querySelector('.attach-tip');
    const tr = t.getBoundingClientRect(), r = tip.getBoundingClientRect();
    return { left: Math.round(r.left - tr.left), right: Math.round(r.right - tr.left), top: Math.round(r.top), inner: t.clientWidth,
      opacity: getComputedStyle(tip).opacity, scroll: t.scrollWidth, client: t.clientWidth };
  })()`);
  check("hovered, the tip is fully inside the transcript and on screen", tip.opacity === "1" && tip.left >= 0 && tip.right <= tip.inner && tip.top >= 0, tip);
  check("…and still adds no width", tip.scroll === tip.client, tip);
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });

  // Where two bars meet: forced with a wide element, then the corner pixel, read back in the page.
  const box = await evalIn(c, `(() => {
    const t = ${transcript};
    const wide = document.createElement('div'); wide.style.cssText = 'width:4000px;height:3000px'; t.querySelector('.transcript-col').append(wide);
    const r = t.getBoundingClientRect();
    return { x: r.left + t.clientWidth, y: r.top + t.clientHeight, w: r.width - t.clientWidth, h: r.height - t.clientHeight };
  })()`);
  await sleep(300);
  check("the forced case really has two bars", box.w > 0 && box.h > 0, box);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: Math.max(1, box.w), height: Math.max(1, box.h), scale: 1 } });
  fs.writeFileSync(OUT("corner"), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT corner ${OUT("corner")}`);
  const rgb = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const p = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
    return [p[0], p[1], p[2]];
  })()`);
  check("where the two bars meet the corner is not white", rgb.some((v) => v < 200), rgb);
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
