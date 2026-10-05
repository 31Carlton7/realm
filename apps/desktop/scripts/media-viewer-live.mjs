/**
 * Live check for the media viewer (run with: pnpm build && node apps/desktop/scripts/media-viewer-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted agent standing in for every engine
 * (REALM_FAKE_STANDS_IN), so nothing runs a billed turn. One session, "Logo rework", is sent a
 * picture and a PDF and answers naming the picture and a clip; the checks then open the ONE viewer
 * from every place a file is shown and look at what it really draws:
 *
 *   1. A sent message's picture: the viewer covers the window — opaquely, so nothing of the workspace
 *      ghosts through — fits the picture without blowing it up, names where a question goes, and has
 *      the keyboard in its prompter; zoom steps it.
 *   2. A sent PDF: macOS's render of it, at the window's size.
 *   3. The answer's clip: the transcript's own player, with the picture beside it on ← — and the
 *      transcript's video behind the viewer does NOT paint through it (sampled from the composite).
 *   4. The docked prompter: "Make the sky warmer" goes to the session with the picture attached, the
 *      answer appears above the prompter, and the new version it names lands on the stage. A circle
 *      drawn on it with the pen goes too, as a copy with the circle in its pixels.
 *   5. The prompter's own chip, the documents pane's home and the Library each open the same viewer.
 * Then the same views in the light face.
 *
 * Ports: LIVE_SERVER_PORT (8807), LIVE_CDP_PORT (9247). Screenshots go to LIVE_OUT_DIR; the scratch
 * home to LIVE_SCRATCH_DIR. Kills only what listens on its own ports. Needs ffmpeg and cupsfilter.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9247);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8807);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchRoot = process.env.LIVE_SCRATCH_DIR ?? os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "realm-media-viewer-live-"));
const home = path.join(scratch, "home");
const TITLE = "Logo rework";
const VIEWPORT = { width: 1560, height: 940 };
const OUT = (tag) => path.join(OUT_DIR, `media-viewer-${tag}.png`);
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

/** A React-controlled field, filled the way typing fills it. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
const click = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
async function key(c, k, code = k, vk = 0) {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
  if (k.length === 1) await c.send("Input.dispatchKeyEvent", { type: "char", text: k, key: k });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
const escape = (c) => key(c, "Escape", "Escape", 27);

/** A ring drawn on the picture with a real pointer, round a point in its upper right: the gesture a
 *  person makes to say "this part". */
async function circle(c) {
  const r = await evalIn(c, `(() => { const b = document.querySelector('.media-viewer-frame').getBoundingClientRect();
    return { x: b.left + b.width * 0.7, y: b.top + b.height * 0.35, rad: Math.min(b.width, b.height) * 0.16 }; })()`);
  const at = (t) => ({ x: r.x + r.rad * Math.cos(t), y: r.y + r.rad * Math.sin(t) });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(0), button: "none" });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at(0), button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 36; i++) await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at((i / 36) * Math.PI * 2 + 0.2), button: "left", buttons: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(Math.PI * 2 + 0.2), button: "left", buttons: 0, clickCount: 1 });
}

/** The viewer's own facts, as a person would read them off the screen. */
const VIEWER = `(() => {
  const v = document.querySelector('.media-viewer'); if (!v) return null;
  const r = v.getBoundingClientRect();
  const img = v.querySelector('img.media-viewer-img');
  const ib = img?.getBoundingClientRect();
  return {
    name: v.getAttribute('aria-label'), parent: v.parentElement.tagName,
    covers: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2,
    count: v.querySelector('.media-viewer-count')?.textContent ?? null,
    detail: v.querySelector('.media-viewer-detail')?.textContent ?? null,
    from: v.querySelector('.media-viewer-from')?.textContent ?? null,
    owner: v.querySelector('.media-viewer-owner-name')?.textContent ?? null,
    zoom: v.querySelector('.media-viewer-zoom')?.textContent ?? null,
    img: img ? { src: img.getAttribute('src').slice(0, 64), natural: [img.naturalWidth, img.naturalHeight], shown: [Math.round(ib.width), Math.round(ib.height)], complete: img.complete } : null,
    video: !!v.querySelector('video'),
    focusInPrompter: document.activeElement?.matches?.('.media-viewer textarea.composer-input') ?? false,
    actions: [...v.querySelectorAll('.media-viewer-actions button')].map((b) => b.getAttribute('aria-label')),
    thread: v.querySelector('.media-viewer-thread')?.textContent ?? null,
    placeholder: v.querySelector('textarea.composer-input')?.getAttribute('placeholder') ?? null,
  }; })()`;
const viewer = (c) => evalIn(c, VIEWER);
const pictureUp = (c, name) => until(async () => {
  const v = await viewer(c);
  return v && v.name === name && v.img?.complete && v.img.natural[0] > 0 ? v : null;
}, 15_000, `the viewer on ${name}`);

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

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const envs = await api.call("environments.list", { spaceId: space.id });
  const root = envs.find((e) => e.kind === "primary").path;
  note("checkout", root);

  // The files: a picture, the warmer version the scripted command stands in for, a clip and a brief.
  const ff = (args) => { const r = spawnSync("ffmpeg", ["-v", "error", ...args, "-y"], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); };
  const sky = (warm) => `geq=r='clip(${warm ? 90 : 30}+X/1600*${warm ? 70 : 50}+${warm ? 165 : 150}*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+60*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:g='clip(${warm ? 70 : 80}+Y/1000*${warm ? 60 : 70}+${warm ? 100 : 110}*exp(-((X-1150)*(X-1150)+(Y-360)*(Y-360))/12000)+30*gt(Y\\,760-60*sin(X/170)),0,255)'`
    + `:b='clip(${warm ? 160 : 215}-Y/1000*${warm ? 90 : 110}-100*gt(Y\\,760-60*sin(X/170)),0,255)'`;
  ff(["-f", "lavfi", "-i", "color=c=black:s=1600x1000", "-vf", sky(false), "-frames:v", "1", path.join(root, "hero.png")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(root, "clip.mp4")]);
  fs.writeFileSync(path.join(scratch, "brief.txt"), "Atlas launch brief\n\nThe hero shot leads the page: a clear sky over the ridge, the product\nbelow it, one line of copy.\n\n1. Warm the sky a little.\n2. Keep the ridge as it is.\n3. Export at 1600 x 1000.\n");
  fs.writeFileSync(path.join(root, "brief.pdf"), execFileSync("cupsfilter", ["-m", "application/pdf", path.join(scratch, "brief.txt")], { stdio: ["ignore", "pipe", "ignore"] }));

  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${JSON.stringify(TITLE)})) b.click(); return true; })()`);
  await sleep(500);

  // A message carrying the picture and the brief, which the scripted agent echoes — naming the
  // picture and the clip, so its answer grows the transcript's media strip.
  await api.call("sessions.send", { id: lead, mentions: [],
    text: `The hero shot and a clip of the page: \`${root}/hero.png\` and \`${root}/clip.mp4\`. The brief is attached.`,
    attachments: [{ path: path.join(root, "hero.png"), mime: "image/png" }, { path: path.join(root, "brief.pdf"), mime: "application/pdf" }] });
  await until(() => evalIn(c, `document.querySelectorAll('.msg-user-files .attach-tile').length === 2 && document.querySelectorAll('.media-strip .media-item').length === 2`), 20_000, "the sent files and the answer's strip");
  await until(() => evalIn(c, `[...document.querySelectorAll('.media-strip img')].every((i) => i.complete && i.naturalWidth > 0)`), 10_000, "the strip's picture");
  await sleep(600);
  await shot(c, "0-session-dark");

  // ── 1. A sent message's picture ─────────────────────────────────────────────────────────────────
  await evalIn(c, click(`.msg-user-files .attach-tile[data-media] .attach-open`));
  const v1 = await pictureUp(c, "hero.png");
  note("from a sent message", v1);
  check("a sent picture opens the viewer, portalled to <body> and covering the window", v1.parent === "BODY" && v1.covers, v1);
  check("the picture is fitted to the stage, never above its own size", v1.img.shown[0] <= 1600 && v1.img.shown[0] > 300
    && Math.abs(v1.img.shown[0] / v1.img.shown[1] - 1.6) < 0.02, v1.img);
  check("it says where a question goes, and the keyboard is already in the prompter", v1.owner === TITLE && v1.focusInPrompter, { owner: v1.owner, focus: v1.focusInPrompter });
  check("its actions are the quiet row: the pane, the Finder, a copy, more, close",
    ["Open in the documents pane", "Reveal in Finder", "Save a copy…", "More actions", "Close"].every((a) => v1.actions.includes(a)), v1.actions);
  check("the prompter names the file it will ask about", v1.placeholder?.startsWith("Ask about hero.png"), v1.placeholder);
  {
    // The workspace under the viewer must not ghost through it: at 97% every label in the window read
    // beside the file's own name. Sampled where a sidebar row's label sits under the viewer's ground.
    const at = await evalIn(c, `(() => { const r = [...document.querySelectorAll('.app .item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)}))?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + 8), y: Math.round(r.top + 4), w: Math.round(Math.min(120, r.width - 16)), h: Math.round(r.height - 8) } : null; })()`);
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: at.x, y: at.y, width: at.w, height: at.h, scale: 1 } });
    const file = path.join(scratch, "ghost.png");
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    const raw = [...spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 22 }).stdout];
    const spread = Math.max(...raw) - Math.min(...raw);
    check("the workspace under the viewer does not ghost through it", spread <= 1, { at, spread });
  }
  await shot(c, "1-sent-picture-dark");
  await evalIn(c, click(`.media-viewer-tools button[aria-label="Zoom in"]`));
  await evalIn(c, click(`.media-viewer-tools button[aria-label="Zoom in"]`));
  await sleep(300);
  const zoomed = await viewer(c);
  check("+ steps the picture up a rung at a time, past the window, and it pans", zoomed.img.shown[0] > v1.img.shown[0] && zoomed.zoom !== v1.zoom
    && await evalIn(c, `document.querySelector('.media-viewer-canvas')?.hasAttribute('data-pans')`), { fit: v1.zoom, now: zoomed.zoom, shown: zoomed.img.shown });
  await shot(c, "2-zoomed-dark");
  await escape(c);
  const afterEsc = await until(() => evalIn(c, `(() => document.querySelector('.media-viewer') ? null : { onTile: !!document.activeElement?.closest('.msg-user-files .attach-tile') })()`), 5_000, "closed");
  check("Escape closes it, and the keyboard is back on the tile it came out of", afterEsc.onTile, afterEsc);

  // ── 2. A sent PDF ───────────────────────────────────────────────────────────────────────────────
  await evalIn(c, click(`.msg-user-files .attach-tile:not([data-media]) .attach-open`));
  const v2 = await pictureUp(c, "brief.pdf");
  note("a sent PDF", v2);
  check("a sent PDF opens in the same viewer as macOS's render of its page, big enough to read", v2.img.src.startsWith("data:image/png") && v2.img.natural[1] >= 1000 && v2.img.shown[1] > 500, v2.img);
  await sleep(300);
  await shot(c, "3-pdf-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  // ── 3. The answer's clip, and the transcript's video behind the viewer ───────────────────────────
  await evalIn(c, click(`.media-strip .media-video button[aria-label="Open larger"]`));
  const v3 = await until(async () => { const v = await viewer(c); return v?.name === "clip.mp4" && v.video ? v : null; }, 10_000, "the clip");
  const meta = await until(() => evalIn(c, `(() => { const el = document.querySelector('.media-viewer video'); return el && el.readyState >= 1 ? { w: el.videoWidth, h: el.videoHeight, d: Math.round(el.duration) } : null; })()`), 10_000, "its metadata");
  check("the answer's clip opens in the viewer's player, beside the picture", v3.count === "2 of 2" && meta.w === 1280 && meta.d === 4, { count: v3.count, meta });
  // The transcript's own video sits under the viewer. Sample the composite there and over the
  // viewer's ground where nothing is behind it: a video layer painting through would add to it.
  // The spot has to be the viewer's bare ground over the video — not its own player or prompter,
  // which would be measured instead — so it is found by asking what is on top at each point.
  const behind = await evalIn(c, `(() => {
    const b = document.querySelector('.app .media-strip video').getBoundingClientRect();
    const ground = (x, y) => { const top = document.elementsFromPoint(x, y)[0];
      return !!top && top.closest('.media-viewer') && !top.closest('img, video, .media-viewer-player, .media-viewer-chat, .media-viewer-tools, .media-viewer-step, .media-viewer-head'); };
    for (let y = b.top + 6; y < b.bottom - 12; y += 6) for (let x = b.left + 6; x < b.right - 12; x += 6) {
      if ([[0, 0], [8, 0], [0, 8], [8, 8], [4, 4]].every(([dx, dy]) => ground(x + dx, y + dy))) return { x: Math.round(x), y: Math.round(y), w: 8, h: 8 };
    }
    return null; })()`);
  check("some of the transcript's video lies under the viewer's bare ground, to be sampled", behind !== null, behind);
  const control = { x: 30, y: Math.round(behind?.y ?? 400), w: 8, h: 8 };
  const sample = async (r) => {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
    const file = path.join(scratch, `sample-${r.x}-${r.y}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    const avg = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
    return [...avg.stdout];
  };
  const over = behind ? await sample(behind) : [0, 0, 0], ground = await sample(control);
  const delta = Math.max(...over.map((x, i) => Math.abs(x - ground[i])));
  check("the transcript's video does not paint through the viewer", delta <= 8, { over, ground, delta, behind });
  await shot(c, "4-video-dark");
  await key(c, "ArrowLeft", "ArrowLeft", 37);
  await pictureUp(c, "hero.png");
  check("← walks back to the picture from an empty prompter", true);

  // ── 4. Asking about it, and the new version ─────────────────────────────────────────────────────
  // The scripted command writes nothing, so the file it names is put where it says it put it.
  ff(["-f", "lavfi", "-i", "color=c=black:s=1600x1000", "-vf", sky(true), "-frames:v", "1", path.join(root, "hero-warm.png")]);
  await evalIn(c, fill(".media-viewer textarea.composer-input", "Make the sky warmer"));
  await key(c, "Enter", "Enter", 13);
  const answered = await until(async () => {
    const v = await viewer(c);
    return v?.thread?.includes("Warmed the sky") && v.name === "hero-warm.png" && v.img?.complete ? v : null;
  }, 20_000, "the answer and the new version");
  note("after the answer", answered);
  check("the answer appears above the prompter, and the new version it names is on the stage", answered.count === "2 of 3", { count: answered.count, thread: answered.thread?.slice(0, 120) });
  const events = await api.call("sessions.events", { id: lead, afterSeq: 0, limit: 500 });
  const asked = events.find((e) => e.event.type === "user_message" && e.event.payload.text === "Make the sky warmer");
  check("the question went to the session the picture came from, with the picture attached",
    asked?.event.payload.attachments?.[0]?.path === path.join(root, "hero.png"), asked?.event.payload);
  await sleep(500);
  await shot(c, "5-answer-new-version-dark");

  // ── 4b. Marking it up: a circle drawn on the picture goes as a copy with the circle on it ────────
  await evalIn(c, click(`.media-viewer-tools button[aria-label="Mark up"]`));
  await circle(c);
  const marked = await evalIn(c, `({ marks: document.querySelectorAll('.media-viewer-marks polyline').length,
    note: document.querySelector('.media-viewer-marks-note')?.textContent ?? null })`);
  check("the pen draws on the picture, and the prompter says the marks will go", marked.marks === 1 && (marked.note ?? "").includes("hero-warm-marked.png"), marked);
  await shot(c, "5b-markup-dark");
  await evalIn(c, fill(".media-viewer textarea.composer-input", "Brighten what I circled"));
  await key(c, "Enter", "Enter", 13);
  const withMarks = await until(async () => {
    const evs = await api.call("sessions.events", { id: lead, afterSeq: 0, limit: 500 });
    return evs.find((e) => e.event.type === "user_message" && e.event.payload.text === "Brighten what I circled") ?? null;
  }, 15_000, "the marked question");
  const sentFiles = withMarks.event.payload.attachments.map((a) => a.path);
  note("sent with marks", sentFiles);
  const copy = sentFiles.find((p) => p.endsWith("hero-warm-marked.png"));
  check("the question carries the file and a copy with the marks drawn on it", sentFiles[0] === path.join(root, "hero-warm.png") && !!copy, sentFiles);
  if (copy) {
    // The circle is in the copy's pixels, in the theme's red: count the pixels that are that red.
    const raw = spawnSync("ffmpeg", ["-v", "error", "-i", copy, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 }).stdout;
    let red = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 190 && raw[i + 1] < 110 && raw[i + 2] < 110) red++;
    check("the copy has the drawn circle in it", red > 500, { red, bytes: raw.length });
  }
  check("the marks are put away once they went", await evalIn(c, `document.querySelectorAll('.media-viewer-marks polyline').length === 0`));
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  check("the exchange is in the session's own transcript too", await evalIn(c, `[...document.querySelectorAll('.app .msg-user')].some((m) => m.textContent.includes('Make the sky warmer'))`));

  // ── 5. The prompter's chip, the documents pane, the Library ─────────────────────────────────────
  await evalIn(c, click(`button[aria-label=${JSON.stringify(`Open documents for ${TITLE}`)}]`));
  await until(() => evalIn(c, `!!document.querySelector('.docs-home section[aria-label="This session"] .docs-home-row')`), 15_000, "the documents home");
  await sleep(600);
  await evalIn(c, `(() => { const b = document.querySelector('.docs-home button[aria-label="Add hero.png to the next message"]'); if (!b) return false; b.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.app .composer .attach-tile .attach-open')`), 5_000, "the prompter's chip");
  await evalIn(c, click(`.app .composer .attach-tile .attach-open`));
  const v5 = await pictureUp(c, "hero.png");
  check("the prompter's own chip opens the same viewer, asked about in the same session", v5.owner === TITLE, v5.owner);
  await shot(c, "6-prompter-chip-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  await evalIn(c, `(() => { [...document.querySelectorAll('.docs-home-open')].find((b) => b.querySelector('.docs-home-name')?.textContent === 'hero.png')?.click(); return true; })()`);
  const v6 = await pictureUp(c, "hero.png");
  check("the documents pane's home opens a picture in the viewer, not a tab", v6.actions.includes("Open in the documents pane"), v6.actions);
  await shot(c, "7-documents-dark");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");

  await evalIn(c, click(`.app-rail button[aria-label="Library"]`));
  await until(() => evalIn(c, `!!document.querySelector('.library-tile')`), 15_000, "the Library");
  await sleep(800);
  await evalIn(c, `(() => { [...document.querySelectorAll('.library-tile')].find((t) => t.title.endsWith('/hero.png'))?.click(); return true; })()`);
  const v7 = await pictureUp(c, "hero.png");
  note("from the Library", v7);
  check("a Library tile opens the viewer, naming where the file came from and asking that session", (v7.from ?? "").includes(TITLE) && v7.owner === TITLE, { from: v7.from, owner: v7.owner });
  await shot(c, "8-library-dark");

  // ── The light face ──────────────────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.documentElement.dataset.mode = "light"; return true; })()`);
  await sleep(500);
  await shot(c, "9-library-light");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  await evalIn(c, `(() => { [...document.querySelectorAll('.library-tile')].find((t) => t.title.endsWith('/brief.pdf'))?.click(); return true; })()`);
  await pictureUp(c, "brief.pdf");
  await sleep(300);
  await shot(c, "10-pdf-light");
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('.media-viewer')`), 5_000, "closed");
  await evalIn(c, click(`.page-overlay-bar button[aria-label^="Close"]`));
  await sleep(600);
  await evalIn(c, click(`.media-strip .media-video button[aria-label="Open larger"]`));
  await until(async () => { const v = await viewer(c); return v?.name === "clip.mp4" && v.video ? v : null; }, 10_000, "the clip, light");
  await sleep(600);
  await shot(c, "11-video-light");
  await key(c, "ArrowLeft", "ArrowLeft", 37);
  await pictureUp(c, "hero.png");
  await evalIn(c, fill(".media-viewer textarea.composer-input", "Make the sky warmer"));
  await key(c, "Enter", "Enter", 13);
  await until(async () => { const v = await viewer(c); return v?.thread?.includes("Warmed the sky") && v.name === "hero-warm.png" && v.img?.complete ? v : null; }, 20_000, "the answer, light");
  await sleep(500);
  await shot(c, "12-answer-light");
  await evalIn(c, click(`.media-viewer-tools button[aria-label="Mark up"]`));
  await circle(c);
  await sleep(200);
  await shot(c, "13-markup-light");
  await escape(c);

  check("no page exceptions along the way", c.errors.length === 0, c.errors.slice(0, 3));
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
