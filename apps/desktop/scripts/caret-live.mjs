/**
 * Live check for the app's caret (run with: pnpm build && node apps/desktop/scripts/caret-live.mjs)
 *
 * jsdom lays nothing out, so everything about WHERE the caret is drawn is checked here, in the built
 * app on a scratch REALM_HOME:
 *
 *   1. Position against the platform's own caret. Each field is measured twice at the same offset:
 *      once with the drawn caret off (a thin blinking line, which the platform draws), once with it on
 *      (a thin SOLID line, which the app draws) — both painted magenta for the occasion, and found in
 *      the screenshot. In the prompter (start, mid-line, either side of a soft wrap, an empty line,
 *      the end, and scrolled), a settings field, and a password field.
 *   2. The code editor: the drawn caret against CodeMirror's own primary cursor, which is hidden but
 *      still laid out where CodeMirror would have drawn it.
 *   3. A terminal: every shape's mark found inside the cell xterm marks as the cursor.
 *   4. Every animation, recorded as frames in the prompter, a settings field and a terminal, with the
 *      caret's computed opacity (or clip) beside each frame — contact sheets, dark and light.
 *   5. Reduce motion holds every caret still; a glide moves through intermediate frames; an input
 *      method composing gets the platform's caret back.
 *
 * Ports: LIVE_SERVER_PORT (8803), LIVE_CDP_PORT (9243), LIVE_MAIN_INSPECT_PORT (9343). Writes to
 * LIVE_OUT (realm-worktrees/.verify/caret-live). Nothing is billed: the one session is moved to the
 * fake agent before anything could be sent, and nothing is sent. Kills only what listens on its ports.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9243);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8803);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9343);
const OUT = process.env.LIVE_OUT ?? path.resolve(repoRoot, "..", ".verify", "caret-live");
fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(OUT, "run-"));
const home = path.join(scratch, "home");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const WINDOW = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
const daemonPids = [];

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
    await sleep(100);
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
      pending.set(i, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** Page-side helpers, prepended to every evaluation. The store is found from the DOM up. */
const HELPERS = `
globalThis.__live ??= {
  store() {
    if (globalThis.__liveStore) return globalThis.__liveStore;
    const el = document.querySelector('.app') ?? document.querySelector('#root > *');
    if (!el) return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && 'caret' in v.getState()) { globalThis.__liveStore = v; return v; }
    }
    return null;
  },
  st() { return __live.store().getState(); },
  rect(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  drawn() {
    const layer = document.querySelector('.caret-layer');
    const caret = document.querySelector('.caret-layer .caret');
    if (!layer || !caret) return null;
    const cs = getComputedStyle(caret);
    return { shown: layer.hasAttribute('data-shown'), rect: __live.rect(caret), opacity: Number(cs.opacity), clip: cs.clipPath, glide: caret.hasAttribute('data-glide'), glyph: caret.textContent };
  },
  keepKey() {
    const root = document.documentElement;
    root.removeAttribute('data-window-inactive');
    if (!globalThis.__keepKey) {
      globalThis.__keepKey = new MutationObserver(() => { if (root.hasAttribute('data-window-inactive')) root.removeAttribute('data-window-inactive'); });
      globalThis.__keepKey.observe(root, { attributes: true, attributeFilter: ['data-window-inactive'] });
    }
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
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

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) await until(() => portFree(p), 10_000, `port ${p} free`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
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
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");
  return { c, m };
}

async function shutDown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  api = null;
  electron?.kill("SIGKILL");
  electron = null;
  await sleep(500);
  daemonPids.push(...(await stopDaemons(home, daemonPids)));
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
}

/** One PNG of a clip, in CSS px; returns the file and the scale its pixels are at. */
async function capture(c, file, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

/** The image helpers: one Python process per question, PIL doing the pixel work. */
const PY = path.join(scratch, "caret_px.py");
fs.writeFileSync(PY, String.raw`
import json, sys
from PIL import Image, ImageDraw, ImageFont
cmd = sys.argv[1]
spec = json.loads(sys.argv[2])
if cmd == "magenta":
    # The bounding box of the magenta pixels, in the image's own pixels, and the image's size.
    im = Image.open(spec["file"]).convert("RGB")
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r - g > 40 and b - g > 40 and abs(r - b) < 80:
                xs.append(x); ys.append(y)
    out = {"w": w, "h": h, "box": None if not xs else [min(xs), min(ys), max(xs) + 1, max(ys) + 1], "count": len(xs)}
    print(json.dumps(out))
elif cmd == "sheet":
    # Rows of frames, each with a caption under it; a title per row on the left.
    rows = spec["rows"]
    zoom = spec.get("zoom", 3)
    bg = tuple(spec.get("bg", [24, 25, 28]))
    ink = tuple(spec.get("ink", [220, 222, 226]))
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
        small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
    except Exception:
        font = small = ImageFont.load_default()
    cells = []
    for row in rows:
        ims = [Image.open(f["file"]).convert("RGB") for f in row["frames"]]
        cells.append(ims)
    fw = max(im.size[0] for ims in cells for im in ims) * zoom
    fh = max(im.size[1] for ims in cells for im in ims) * zoom
    cols = max(len(ims) for ims in cells)
    label_w = 210
    cap_h = 22
    gap = 6
    W = label_w + cols * (fw + gap) + gap
    H = len(rows) * (fh + cap_h + gap * 2) + 60
    sheet = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(sheet)
    d.text((gap, 12), spec["title"], fill=ink, font=font)
    y = 50
    for row, ims in zip(rows, cells):
        d.text((gap, y + fh // 2 - 10), row["label"], fill=ink, font=font)
        x = label_w
        for f, im in zip(row["frames"], ims):
            sheet.paste(im.resize((im.size[0] * zoom, im.size[1] * zoom), Image.NEAREST), (x, y))
            d.text((x + 2, y + fh + 2), f.get("caption", ""), fill=ink, font=small)
            x += fw + gap
        y += fh + cap_h + gap * 2
    sheet.save(spec["out"])
    print(json.dumps({"out": spec["out"], "size": [W, H]}))
`);
const py = (cmd, spec) => JSON.parse(execFileSync("python3", [PY, cmd, JSON.stringify(spec)], { encoding: "utf8", maxBuffer: 1 << 26 }).trim());

/** Paint every caret magenta, for finding it in a picture; or put it back. */
const magenta = (c, on) => evalIn(c, `(() => { const s = document.documentElement.style; ${on ? `s.setProperty('--caret', '#ff00ff')` : `s.removeProperty('--caret')`}; return true; })()`);

/** Where a magenta caret is, in CSS px, found in a screenshot of `clip`. A blinking one is caught
 *  by taking a few pictures until one has it. */
async function findCaret(c, tag, clip, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const file = await capture(c, path.join(scratch, `${tag}-${i}.png`), clip);
    const r = py("magenta", { file });
    if (r.box) {
      const k = r.w / clip.width;
      return { left: clip.x + r.box[0] / k, top: clip.y + r.box[1] / k, width: (r.box[2] - r.box[0]) / k, height: (r.box[3] - r.box[1]) / k, file };
    }
    await sleep(110);
  }
  return null;
}

const openSettings = async (c, tab) => {
  await evalIn(c, `(() => { __live.st().openSettingsPage(${JSON.stringify(tab)}); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.settings-search')`), 10_000, `settings ${tab}`);
};
const setCaret = (c, prefs) => evalIn(c, `(async () => { await __live.st().setCaret(${JSON.stringify(prefs)}); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`);
const press = async (c, key, code, keyCode, modifiers = 0) => {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
};

/**
 * The platform's caret and the drawn one at the same offset of one field, both magenta: off (thin
 * blinking line — the platform's own), then on (thin SOLID line — the app's). `select` puts the
 * caret there; `clip` is where to look.
 */
async function compareAt(c, label, select, clipExpr, results) {
  await setCaret(c, { shape: "line-thin", animation: "blink", glide: false });
  await evalIn(c, select);
  await sleep(60);
  const clip = await evalIn(c, clipExpr);
  const native = await findCaret(c, `native-${label}`, clip);
  const offState = await evalIn(c, `({ marked: !!document.querySelector('[data-rl-caret]'), drawn: __live.drawn() })`);
  await setCaret(c, { shape: "line-thin", animation: "solid", glide: false });
  await evalIn(c, select);
  await sleep(120);
  const drawn = await findCaret(c, `drawn-${label}`, clip, 3);
  const onState = await evalIn(c, `({ marked: !!document.querySelector('[data-rl-caret]'), drawn: __live.drawn() })`);
  const delta = native && drawn ? { dx: +(drawn.left - native.left).toFixed(2), dy: +(drawn.top - native.top).toFixed(2), dh: +(drawn.height - native.height).toFixed(2) } : null;
  results.push({ label, native, drawn, delta });
  check(`${label}: the platform's caret shows while the drawn one is off, and only it`, !!native && !offState.marked && !offState.drawn?.shown, { native, offState: { marked: offState.marked, shown: offState.drawn?.shown } });
  check(`${label}: the drawn caret stands on the platform's pixel (±1px across, ±1px down, ±2px tall)`,
    !!delta && Math.abs(delta.dx) <= 1 && Math.abs(delta.dy) <= 1 && Math.abs(delta.dh) <= 2 && onState.marked, { native, drawn, delta, marked: onState.marked });
  return delta;
}

/** Frames of the drawn caret (or a terminal cell) over ~2.4s, with its computed motion beside each. */
async function record(c, tag, clipExpr, stateExpr, count = 24, every = 90) {
  const clip = await evalIn(c, clipExpr);
  const frames = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const at = Date.now() - t0;
    const file = await capture(c, path.join(SHOTS, `frames`, `${tag}-${String(i).padStart(2, "0")}.png`), clip);
    const state = await evalIn(c, stateExpr);
    frames.push({ file, at, state });
    const wait = (i + 1) * every - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  return frames;
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  fs.mkdirSync(path.join(SHOTS, "frames"), { recursive: true });
  const { c } = await launch();

  // Onboarding, and its session onto the fake agent before anything could reach a real one.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer-input')`), 30_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const [sess] = await api.call("sessions.list", { spaceId: space.id });
  await api.call("sessions.setAgent", { id: sess.id, agentKind: "fake" });
  await evalIn(c, `__live.keepKey()`);
  await until(() => evalIn(c, `!!__live.store()`), 10_000, "the store");
  await evalIn(c, `(async () => { await __live.st().setThemePref("dark"); return true; })()`);
  await sleep(400);

  const env = await evalIn(c, `({ dpr: devicePixelRatio, supports: { shape: CSS.supports('caret-shape', 'block'), animation: CSS.supports('caret-animation', 'manual') },
    root: { caret: document.documentElement.getAttribute('data-caret'), animation: document.documentElement.getAttribute('data-caret-animation') } })`);
  note("the engine and the default caret", env);
  check("this engine has no caret-shape or caret-animation, so the shapes are drawn", env.supports.shape === false && env.supports.animation === false, env.supports);
  check("the default caret is a line that blinks", env.root.caret === "line" && env.root.animation === "blink", env.root);

  /* ── 1. The prompter: the drawn caret on the platform's pixel ─────────────────────────────────── */
  await magenta(c, true);
  const draft = "The quick brown fox jumps over the lazy dog, and the caret has to find its way along a line that wraps before it ends, past a soft wrap and on.";
  await evalIn(c, `(() => { document.querySelector('.composer-input').focus(); return true; })()`);
  await c.send("Input.insertText", { text: draft });
  await sleep(300);
  const wrapAt = await evalIn(c, `(() => {
    // The first offset whose glyph is on the second line, read off the mirror the prompter draws.
    const m = document.querySelector('.composer-highlight'); const t = m.textContent;
    const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT); let n = 0, firstTop = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('svg')) continue;
      for (let i = 0; i < node.length; i++) {
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
        const box = r.getClientRects()[0]; if (!box) { n++; continue; }
        if (firstTop === null) firstTop = box.top;
        if (box.top > firstTop + 4) return n;
        n++;
      }
    }
    return null; })()`);
  note("the prompter's draft wraps at", { offset: wrapAt, before: draft.slice(Math.max(0, wrapAt - 12), wrapAt), after: draft.slice(wrapAt, wrapAt + 12) });
  const composerClip = `(() => { const r = document.querySelector('.composer-input').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`;
  const at = (n) => `(() => { const ta = document.querySelector('.composer-input'); ta.focus(); ta.setSelectionRange(${n}, ${n}); return true; })()`;
  const prompterResults = [];
  await compareAt(c, "prompter: the start", at(0), composerClip, prompterResults);
  await compareAt(c, "prompter: mid-line", at(10), composerClip, prompterResults);
  if (wrapAt) await compareAt(c, "prompter: the first glyph after a soft wrap", at(wrapAt), composerClip, prompterResults);
  if (wrapAt) await compareAt(c, "prompter: the line after the wrap, mid-word", at(wrapAt + 5), composerClip, prompterResults);
  await compareAt(c, "prompter: the end", at(draft.length), composerClip, prompterResults);
  // A newline, then an empty last line — the mirror's one special case.
  await evalIn(c, at(draft.length));
  await press(c, "Enter", "Enter", 13, 8);
  await sleep(200);
  const withBreak = await evalIn(c, `document.querySelector('.composer-input').value.length`);
  await compareAt(c, "prompter: an empty line after a newline", at(withBreak), composerClip, prompterResults);
  // Long enough to scroll: twelve lines, the caret four from the end, the box scrolled to the bottom.
  await c.send("Input.insertText", { text: Array.from({ length: 12 }, (_, i) => `line ${i + 1} of a draft that scrolls`).join("\n") });
  await sleep(300);
  const scroll = await evalIn(c, `(() => { const ta = document.querySelector('.composer-input'); return { scrollTop: ta.scrollTop, scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight }; })()`);
  note("the prompter, scrolled", scroll);
  const scrolledAt = await evalIn(c, `(() => { const v = document.querySelector('.composer-input').value; return v.indexOf('line 9 of') + 4; })()`);
  await compareAt(c, "prompter: scrolled, four lines from the end", `(() => { const ta = document.querySelector('.composer-input'); ta.focus(); ta.setSelectionRange(${scrolledAt}, ${scrolledAt}); return true; })()`, composerClip, prompterResults);
  check("…the prompter really was scrolled for that one", scroll.scrollTop > 0, scroll);

  /* ── 2. A settings field, and a password field ─────────────────────────────────────────────────── */
  await openSettings(c, "general");
  const searchClip = `(() => { const r = document.querySelector('.settings-search').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`;
  await evalIn(c, `(() => { const f = document.querySelector('.settings-search'); f.focus(); return true; })()`);
  await c.send("Input.insertText", { text: "cursor" });
  await sleep(250);
  const fieldResults = [];
  const inSearch = (n) => `(() => { const f = document.querySelector('.settings-search'); f.focus(); f.setSelectionRange(${n}, ${n}); return true; })()`;
  await compareAt(c, "settings search: the start", inSearch(0), searchClip, fieldResults);
  await compareAt(c, "settings search: inside the word", inSearch(3), searchClip, fieldResults);
  await compareAt(c, "settings search: the end", inSearch(6), searchClip, fieldResults);
  // A password field: one stood on the page for the check, since no screen here keeps one open.
  await evalIn(c, `(() => { const f = document.createElement('input'); f.type = 'password'; f.id = 'live-password';
    f.style.cssText = 'position:fixed;left:400px;top:300px;width:280px;height:30px;z-index:100;font:14px/20px system-ui;padding:0 8px;border-radius:8px;border:1px solid #555;background:#222;color:#eee';
    document.body.appendChild(f); f.focus(); return true; })()`);
  await c.send("Input.insertText", { text: "hunter2-and-more" });
  await sleep(200);
  const pwClip = `(() => { const r = document.getElementById('live-password').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`;
  const inPw = (n) => `(() => { const f = document.getElementById('live-password'); f.focus(); f.setSelectionRange(${n}, ${n}); return true; })()`;
  await compareAt(c, "password: inside", inPw(5), pwClip, fieldResults);
  await compareAt(c, "password: the end", inPw(16), pwClip, fieldResults);
  const mirrorText = await evalIn(c, `document.querySelector('.caret-mirror').textContent`);
  check("the mirror holds bullets for a password, never what was typed", !mirrorText.includes("hunter2") && /^•+​$/.test(mirrorText), { mirrorText });
  await evalIn(c, `(() => { document.getElementById('live-password').remove(); return true; })()`);

  /* ── 3. IME: the platform's caret comes back while an input method composes ─────────────────── */
  await setCaret(c, { shape: "block", animation: "solid", glide: false });
  await evalIn(c, inSearch(6));
  await sleep(150);
  const beforeIme = await evalIn(c, `({ marked: !!document.querySelector('.settings-search[data-rl-caret]'), shown: __live.drawn().shown })`);
  await c.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
  await sleep(150);
  const duringIme = await evalIn(c, `({ marked: !!document.querySelector('.settings-search[data-rl-caret]'), shown: __live.drawn().shown, value: document.querySelector('.settings-search').value })`);
  await c.send("Input.insertText", { text: "かな" });
  await sleep(200);
  const afterIme = await evalIn(c, `({ marked: !!document.querySelector('.settings-search[data-rl-caret]'), shown: __live.drawn().shown, value: document.querySelector('.settings-search').value })`);
  check("an input method composing gets the platform's caret back, and the drawn one after", beforeIme.marked && beforeIme.shown && !duringIme.marked && !duringIme.shown && afterIme.marked && afterIme.shown,
    { beforeIme, duringIme, afterIme });

  /* ── 4. Settings ▸ Appearance ▸ Cursor, as it looks ────────────────────────────────────────────── */
  await magenta(c, false);
  await evalIn(c, `(() => { const f = document.querySelector('.settings-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); f.blur(); return true; })()`);
  await openSettings(c, "appearance");
  await until(() => evalIn(c, `!!document.querySelector('[data-setting=caret-preview]')`), 5000, "the Cursor section");
  await setCaret(c, { shape: "line", animation: "solid", glide: false, colour: "accent" });
  const section = async (tag) => {
    await evalIn(c, `(() => { document.querySelector('[data-setting=caret-preview]').scrollIntoView({ block: 'start' }); document.activeElement?.blur?.(); return true; })()`);
    await sleep(500);
    const box = await evalIn(c, `(() => { const head = [...document.querySelectorAll('.settings-head')].find((h) => h.textContent === 'Cursor'); const last = document.querySelector('[data-setting=terminal-cursor-blink]');
      const a = head.getBoundingClientRect(), b = last.getBoundingClientRect(); return { x: Math.floor(Math.min(a.x, b.x)) - 16, y: Math.floor(a.y) - 12, width: Math.ceil(b.width) + 32, height: Math.ceil(b.bottom - a.y) + 24 }; })()`);
    await capture(c, path.join(SHOTS, `${tag}.png`), box);
    console.log(`SCREENSHOT ${tag} ${path.join(SHOTS, `${tag}.png`)}`);
  };
  await section("settings-cursor-dark");
  const preview = await evalIn(c, `({ drawn: __live.drawn(), field: __live.rect(document.querySelector('.caret-preview')), active: document.activeElement?.tagName })`);
  check("the preview shows the caret while nothing is being typed in", preview.drawn?.shown && preview.drawn.rect.x > preview.field.x && preview.drawn.rect.x < preview.field.x + preview.field.width, preview);

  /* ── 5. Shapes, drawn, in the prompter — a specimen sheet ──────────────────────────────────────── */
  const SHAPES = ["line", "line-thin", "pill", "beam", "block", "block-soft", "block-outline", "underline", "underline-thin"];
  const ANIMATIONS = ["blink", "smooth", "phase", "expand", "pulse", "rest", "solid"];
  const backToSession = async () => {
    await evalIn(c, `(async () => { const st = __live.st(); st.closePageOverlay(); await st.revealSession(${JSON.stringify(sess.id)}, ${JSON.stringify(space.id)}); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.composer-input') && !document.querySelector('.settings-page-pane')`), 10_000, "back to the session").catch(() => {});
  };
  await backToSession();
  await evalIn(c, `(() => { const ta = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return true; })()`);
  await c.send("Input.insertText", { text: "Ask anything, then mind the cursor" });
  await sleep(250);
  const specimenAt = 24; // before "the"
  await setCaret(c, { shape: "line", animation: "solid", glide: false });
  await evalIn(c, at(specimenAt));
  await sleep(150);
  const line = await evalIn(c, `__live.drawn().rect`);
  const specimenBox = { x: Math.floor(line.x) - 70, y: Math.floor(line.y) - 8, width: 150, height: Math.ceil(line.height) + 16 };
  const tightBox = { x: Math.floor(line.x) - 18, y: Math.floor(line.y) - 5, width: 40, height: Math.ceil(line.height) + 10 };
  const specimenClip = `(${JSON.stringify(specimenBox)})`;
  const tightClip = `(${JSON.stringify(tightBox)})`;
  const shapesSheet = async (face) => {
    const frames = [];
    for (const shape of SHAPES) {
      await setCaret(c, { shape, animation: "solid", glide: false });
      await evalIn(c, at(specimenAt));
      await sleep(150);
      const clip = await evalIn(c, specimenClip);
      const file = await capture(c, path.join(SHOTS, "frames", `shape-${face}-${shape}.png`), clip);
      frames.push({ file, caption: shape });
    }
    const out = path.join(SHOTS, `shapes-prompter-${face}.png`);
    py("sheet", { title: `Caret shapes in the prompter (${face}), solid, before "the"`, rows: [{ label: "prompter", frames }], out, zoom: 2,
      bg: face === "dark" ? [24, 25, 28] : [244, 244, 246], ink: face === "dark" ? [220, 222, 226] : [40, 42, 46] });
    console.log(`SCREENSHOT shapes-prompter-${face} ${out}`);
  };
  await shapesSheet("dark");

  /* ── 6. Every animation in the prompter, recorded ──────────────────────────────────────────────── */
  const animationSheet = async (surface, face, select, clipExpr, stateExpr, captionOf) => {
    const rows = [];
    const traces = {};
    for (const animation of ANIMATIONS) {
      await setCaret(c, { shape: surface === "terminal" ? "block" : "line", animation, glide: false });
      await evalIn(c, select);
      await sleep(40);
      const frames = await record(c, `${surface}-${face}-${animation}`, clipExpr, stateExpr);
      traces[animation] = frames.map((f) => ({ at: f.at, ...f.state }));
      rows.push({ label: animation, frames: frames.map((f) => ({ file: f.file, caption: `${f.at}ms ${captionOf(f.state)}` })) });
    }
    const out = path.join(SHOTS, `animations-${surface}-${face}.png`);
    py("sheet", { title: `Caret animations — ${surface} (${face}); every ~90ms, with the computed opacity or clip`, rows, out, zoom: 3,
      bg: face === "dark" ? [24, 25, 28] : [244, 244, 246], ink: face === "dark" ? [220, 222, 226] : [40, 42, 46] });
    console.log(`SCREENSHOT animations-${surface}-${face} ${out}`);
    fs.writeFileSync(path.join(SHOTS, `animations-${surface}-${face}.json`), JSON.stringify(traces, null, 1));
    return traces;
  };
  const overlayState = `(() => { const d = __live.drawn(); return { opacity: d?.opacity ?? null, clip: d?.clip ?? null, shown: d?.shown ?? false }; })()`;
  const overlayCaption = (s) => (s.clip && s.clip !== "none" ? s.clip.replace("inset", "") : `α${(s.opacity ?? 0).toFixed(2)}`);
  const prompterTraces = await animationSheet("prompter", "dark", at(specimenAt), tightClip, overlayState, overlayCaption);
  const varies = (t) => new Set(t.map((s) => `${s.opacity?.toFixed(2)}|${s.clip}`)).size > 1;
  for (const a of ANIMATIONS) {
    const t = prompterTraces[a];
    if (a === "solid") check("Solid holds the prompter's caret still", !varies(t) && t.every((s) => s.opacity === 1), t.slice(0, 4));
    else check(`${a} moves the prompter's caret`, varies(t) && t.every((s) => s.shown), t.slice(0, 6));
  }
  const smooth = prompterTraces.smooth.map((s) => s.opacity);
  check("Smooth fade passes through values between shown and gone, where Blink does not", smooth.some((o) => o > 0.05 && o < 0.95)
    && prompterTraces.blink.every((s) => s.opacity === 0 || s.opacity === 1), { smooth, blink: prompterTraces.blink.map((s) => s.opacity) });
  const pulse = prompterTraces.pulse.map((s) => s.opacity);
  check("Pulse breathes and never goes out", Math.min(...pulse) >= 0.34 && Math.min(...pulse) < 0.9, { pulse });

  await setCaret(c, { shape: "line", animation: "rest", glide: false });
  await evalIn(c, at(specimenAt));
  await sleep(10_600);
  const rested = await record(c, "prompter-dark-rested", tightClip, overlayState, 8, 110);
  check("Blink, then rest: ten blinks after the caret last moved, then it holds still and shown", rested.every((f) => f.state.opacity === 1 && f.state.shown), rested.map((f) => f.state.opacity));
  await evalIn(c, at(specimenAt - 1));
  await sleep(50);
  const woke = await record(c, "prompter-dark-woke", tightClip, overlayState, 10, 90);
  check("…and blinks again as soon as it moves", woke.some((f) => f.state.opacity === 0), woke.map((f) => f.state.opacity));

  /* ── 7. A settings field's animations ──────────────────────────────────────────────────────────── */
  await openSettings(c, "general");
  await evalIn(c, `(() => { const f = document.querySelector('.settings-search'); f.focus(); return true; })()`);
  await c.send("Input.insertText", { text: "caret" });
  await sleep(250);
  await setCaret(c, { shape: "line", animation: "solid", glide: false });
  await evalIn(c, inSearch(5));
  await sleep(150);
  const fieldLine = await evalIn(c, `__live.drawn().rect`);
  const fieldClip = `(${JSON.stringify({ x: Math.floor(fieldLine.x) - 18, y: Math.floor(fieldLine.y) - 6, width: 40, height: Math.ceil(fieldLine.height) + 12 })})`;
  const fieldTraces = await animationSheet("settings-field", "dark", inSearch(5), fieldClip, overlayState, overlayCaption);
  check("the settings field's caret animates as the prompter's does", varies(fieldTraces.smooth) && !varies(fieldTraces.solid), { smooth: fieldTraces.smooth.slice(0, 6).map((s) => s.opacity) });
  await evalIn(c, `(() => { const f = document.querySelector('.settings-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  /* ── 8. The code editor: the drawn caret on CodeMirror's own ───────────────────────────────────── */
  await backToSession();
  const code = "export function caret(at: number) {\n  return at + 1; // a line to stand in\n}\n";
  fs.writeFileSync(path.join(space.folderPath, "demo.ts"), code);
  await evalIn(c, `(async () => { await __live.st().openDocumentPath(${JSON.stringify(path.join(space.folderPath, "demo.ts"))}); return true; })()`);
  const cm = await until(() => evalIn(c, `!!document.querySelector('.cm-content')`), 15_000, "the code editor").catch(() => false);
  if (cm) {
    await setCaret(c, { shape: "line", animation: "solid", glide: false });
    await evalIn(c, `(() => { document.querySelector('.cm-content').focus(); return true; })()`);
    await sleep(300);
    const cmResults = [];
    for (const [label, keys] of [["the start", []], ["six along", Array(6).fill("ArrowRight")], ["the next line", ["ArrowDown"]], ["its end", ["End"]]]) {
      for (const k of keys) await press(c, k, k, k === "ArrowRight" ? 39 : k === "ArrowDown" ? 40 : 35);
      await sleep(200);
      const r = await evalIn(c, `(() => { const own = document.querySelector('.cm-cursor-primary'); const d = __live.drawn();
        return { own: __live.rect(own), ownVisibility: own ? getComputedStyle(own).visibility : null, drawn: d, marked: document.querySelector('.cm-editor')?.hasAttribute('data-rl-caret') }; })()`);
      // CodeMirror's own is a zero-width box with a 2px border-left at -0.6px; the drawn 2px line is centred.
      const ownX = r.own ? r.own.x + 0.6 : null;
      const drawnX = r.drawn?.rect ? r.drawn.rect.x + r.drawn.rect.width / 2 : null;
      cmResults.push({ label, ownX, drawnX, ownTop: r.own?.y, drawnTop: r.drawn?.rect?.y, ownH: r.own?.height, drawnH: r.drawn?.rect?.height });
      check(`code editor, ${label}: the drawn caret stands where CodeMirror's own would, which steps aside`,
        r.drawn?.shown && r.marked && r.ownVisibility === "hidden" && Math.abs(drawnX - ownX) <= 1.2 && Math.abs(r.drawn.rect.y - r.own.y) <= 1 && Math.abs(r.drawn.rect.height - r.own.height) <= 1,
        { ownX, drawnX, own: r.own, drawn: r.drawn?.rect });
    }
    note("code editor positions", cmResults);
    await capture(c, path.join(SHOTS, "code-editor-dark.png"), await evalIn(c, `(() => { const r = document.querySelector('.cm-editor').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.min(700, Math.ceil(r.width)), height: 140 }; })()`));
    console.log(`SCREENSHOT code-editor-dark ${path.join(SHOTS, "code-editor-dark.png")}`);
  } else note("no code editor came up", null);

  /* ── 9. A terminal: every shape inside the cell xterm marks ────────────────────────────────────── */
  let terminalSheet = null;
  await backToSession();
  await evalIn(c, `(async () => { await __live.st().newTerminal(); return true; })()`);
  const termUp = await until(() => evalIn(c, `!!document.querySelector('.terminal-host .xterm-rows')`), 20_000, "a terminal").catch(() => false);
  if (termUp) {
    await sleep(2500); // the shell's prompt
    const focusTerm = () => evalIn(c, `(() => { document.querySelector('.terminal-host .xterm-helper-textarea')?.focus(); return true; })()`);
    const run = async (line) => { await focusTerm(); await c.send("Input.insertText", { text: line }); await press(c, "Enter", "Enter", 13); await sleep(500); };
    /* A shell with nothing of the user's in it: a prompt theme or a vi mode may set the cursor's shape
       itself (DECSCUSR), which is the program's right and not what this measures. Then "the default"
       asked for once, which hands the cursor back to the setting. */
    await run("exec /bin/bash --norc --noprofile");
    await run("PS1='$ '");
    await run("printf '\\033[0 q'; clear");
    await focusTerm();
    await c.send("Input.insertText", { text: "echo caret" });
    await sleep(600);
    const cellExpr = `(() => { const el = document.querySelector('.terminal-host .xterm-rows .xterm-cursor'); if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, cls: el.className, host: el.closest('.terminal-host').dataset.caret, program: el.closest('.terminal-host').hasAttribute('data-caret-program') }; })()`;
    const termClip = `(() => { const el = document.querySelector('.terminal-host .xterm-rows .xterm-cursor'); const r = el.getBoundingClientRect(); return { x: Math.floor(r.x) - 40, y: Math.floor(r.y) - 6, width: 64, height: Math.ceil(r.height) + 12 }; })()`;
    await magenta(c, true);
    await evalIn(c, `(async () => { await __live.st().setTerminalCursorBlink(false); return true; })()`);
    const termFrames = [];
    for (const shape of SHAPES) {
      await evalIn(c, `(async () => { await __live.st().setTerminalCursorStyle(${JSON.stringify(shape)}); return true; })()`);
      await evalIn(c, `(() => { document.querySelector('.terminal-host .xterm-helper-textarea')?.focus(); return true; })()`);
      await sleep(250);
      const cell = await evalIn(c, cellExpr);
      const clip = { x: Math.floor(cell.x) - 4, y: Math.floor(cell.y) - 4, width: Math.ceil(cell.width) + 8, height: Math.ceil(cell.height) + 8 };
      const mark = await findCaret(c, `term-${shape}`, clip, 3);
      const inside = mark && mark.left >= cell.x - 0.6 && mark.left + mark.width <= cell.x + cell.width + 0.6 && mark.top >= cell.y - 0.6 && mark.top + mark.height <= cell.y + cell.height + 0.6;
      const expect = { line: { w: 2 }, "line-thin": { w: 1 }, pill: { w: 3 }, beam: { w: 3 }, underline: { h: 2 }, "underline-thin": { h: 1 } }[shape];
      const sized = !expect || (expect.w ? Math.abs(mark.width - expect.w) <= 0.6 : Math.abs(mark.height - expect.h) <= 0.6);
      check(`terminal, ${shape}: its mark stands inside the cell xterm marks, at its own size`, !!mark && inside && sized && cell.host === shape, { cell, mark });
      await magenta(c, false);
      await sleep(80);
      const file = await capture(c, path.join(SHOTS, "frames", `term-dark-${shape}.png`), await evalIn(c, termClip));
      termFrames.push({ file, caption: shape });
      await magenta(c, true);
    }
    await magenta(c, false);
    const out = path.join(SHOTS, "shapes-terminal-dark.png");
    py("sheet", { title: "Terminal cursor shapes (dark), steady, after `echo caret`", rows: [{ label: "terminal", frames: termFrames }], out, zoom: 3 });
    console.log(`SCREENSHOT shapes-terminal-dark ${out}`);
    terminalSheet = async (face) => {
      const termItem = await evalIn(c, `__live.st().items.find((i) => i.kind === 'terminal')?.id ?? null`);
      if (termItem) await evalIn(c, `(async () => { await __live.st().revealItem(${JSON.stringify(termItem)}, ${JSON.stringify(space.id)}); return true; })()`);
      await sleep(600);
      await evalIn(c, `(async () => { await __live.st().setTerminalCursorBlink(false); return true; })()`);
      const frames = [];
      for (const shape of SHAPES) {
        await evalIn(c, `(async () => { await __live.st().setTerminalCursorStyle(${JSON.stringify(shape)}); return true; })()`);
        await focusTerm();
        await sleep(250);
        frames.push({ file: await capture(c, path.join(SHOTS, "frames", `term-${face}-${shape}.png`), await evalIn(c, termClip)), caption: shape });
      }
      const file = path.join(SHOTS, `shapes-terminal-${face}.png`);
      py("sheet", { title: `Terminal cursor shapes (${face}), steady`, rows: [{ label: "terminal", frames }], out: file, zoom: 3,
        bg: face === "dark" ? [24, 25, 28] : [244, 244, 246], ink: face === "dark" ? [220, 222, 226] : [40, 42, 46] });
      console.log(`SCREENSHOT shapes-terminal-${face} ${file}`);
    };

    // A program's own shape, then the default asked back (DECSCUSR), printed by the shell itself.
    await evalIn(c, `(async () => { await __live.st().setTerminalCursorStyle("pill"); return true; })()`);
    await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: "u", code: "KeyU", windowsVirtualKeyCode: 85 });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "u", code: "KeyU", windowsVirtualKeyCode: 85 });
    await run("printf '\\033[4 q'");
    const asked = await evalIn(c, cellExpr);
    await run("printf '\\033[0 q'");
    const back = await evalIn(c, cellExpr);
    check("a program's own cursor shape is drawn plainly while it holds, and asking for the default gives back the setting",
      asked?.program && asked.cls.includes("xterm-cursor-underline") && back && !back.program && back.cls.includes("xterm-cursor-bar") && back.host === "pill", { asked, back });

    // The terminal's animations, a block that blinks.
    await evalIn(c, `(async () => { await __live.st().setTerminalCursorStyle("block"); await __live.st().setTerminalCursorBlink(true); return true; })()`);
    const termState = `(() => { const el = document.querySelector('.terminal-host .xterm-rows .xterm-cursor'); if (!el) return { bg: null };
      const cs = getComputedStyle(el); return { bg: cs.backgroundColor, size: cs.backgroundSize, fg: cs.color, cls: el.className.includes('xterm-cursor-blink') }; })()`;
    const termSelect = `(() => { document.querySelector('.terminal-host .xterm-helper-textarea')?.focus(); return true; })()`;
    const termTraces = await animationSheet("terminal", "dark", termSelect, termClip, termState, (s) => (s.size && s.size !== "auto" ? `size ${s.size}` : (s.bg ?? "").replace(/rgba?\(|\)/g, "")));
    const bgVaries = (t) => new Set(t.map((s) => `${s.bg}|${s.size}`)).size > 1;
    check("a blinking terminal block moves as the caret does, and blinks plainly where the caret is Solid", bgVaries(termTraces.smooth) && bgVaries(termTraces.solid) && bgVaries(termTraces.blink),
      { smooth: termTraces.smooth.slice(0, 5), solid: termTraces.solid.slice(0, 5) });
    check("…with its blink switched off it holds still", await (async () => {
      await evalIn(c, `(async () => { await __live.st().setTerminalCursorBlink(false); return true; })()`);
      await setCaret(c, { animation: "smooth" });
      const t = await record(c, "terminal-dark-steady", termClip, termState, 8, 90);
      return !bgVaries(t.map((f) => f.state));
    })());
  } else note("no terminal came up", null);

  /* ── 10. A glide, frame by frame; and no glide when the box scrolls ────────────────────────────── */
  await backToSession();
  await evalIn(c, `(() => { const ta = document.querySelector('.composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Glide along this line'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.setSelectionRange(21, 21); return true; })()`);
  await setCaret(c, { shape: "line", animation: "solid", glide: true });
  await sleep(200);
  const glideXs = [];
  const start = await evalIn(c, `__live.drawn().rect.x`);
  await evalIn(c, `(() => { const ta = document.querySelector('.composer-input'); ta.setSelectionRange(6, 6); return true; })()`);
  for (let i = 0; i < 8; i++) { glideXs.push(await evalIn(c, `({ x: __live.drawn().rect.x, glide: __live.drawn().glide })`)); await sleep(14); }
  const end = await evalIn(c, `__live.drawn().rect.x`);
  note("a glide from the end of the line back to offset 6", { start, frames: glideXs, end });
  check("with Glide on the caret passes through places between where it was and where it lands",
    glideXs.some((f) => f.x < start - 2 && f.x > end + 2) && glideXs.some((f) => f.glide), { start, end, frames: glideXs.map((f) => f.x) });
  await setCaret(c, { shape: "line", animation: "solid", glide: false });
  await evalIn(c, `(() => { const ta = document.querySelector('.composer-input'); ta.setSelectionRange(21, 21); return true; })()`);
  await sleep(150);
  const jump = await evalIn(c, `(async () => { const ta = document.querySelector('.composer-input'); ta.setSelectionRange(6, 6);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { x: __live.drawn().rect.x, glide: __live.drawn().glide }; })()`);
  check("with Glide off it jumps", !jump.glide && Math.abs(jump.x - end) <= 1, { jump, end });

  /* ── 11. Reduce motion holds every caret still ─────────────────────────────────────────────────── */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await setCaret(c, { shape: "line", animation: "smooth", glide: true });
  await sleep(300);
  const reducedRoot = await evalIn(c, `({ still: document.documentElement.hasAttribute('data-caret-still'), animation: document.documentElement.getAttribute('data-caret-animation') })`);
  await evalIn(c, at(specimenAt));
  await sleep(100);
  const reducedFrames = await record(c, "prompter-dark-reduced", tightClip, overlayState, 10, 90);
  check("Reduce motion holds the caret still, whatever animation was chosen", reducedRoot.still && reducedRoot.animation === "smooth" && reducedFrames.every((f) => f.state.opacity === 1 && f.state.shown),
    { reducedRoot, opacities: reducedFrames.map((f) => f.state.opacity) });
  const reducedGlide = await evalIn(c, `(async () => { const ta = document.querySelector('.composer-input'); ta.focus(); ta.setSelectionRange(21, 21);
    await new Promise((r) => setTimeout(r, 120)); ta.setSelectionRange(2, 2); await new Promise((r) => requestAnimationFrame(r)); return __live.drawn().glide; })()`);
  check("…and does not glide", reducedGlide === false);
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

  /* ── 12. The light face ────────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `(async () => { await __live.st().setThemePref("light"); return true; })()`);
  await sleep(600);
  await evalIn(c, `(() => { const ta = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Ask anything, then mind the cursor'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return true; })()`);
  await sleep(250);
  await shapesSheet("light");
  await animationSheet("prompter", "light", at(specimenAt), tightClip, overlayState, overlayCaption);
  if (terminalSheet) { await terminalSheet("light"); await backToSession(); }
  await openSettings(c, "appearance");
  await until(() => evalIn(c, `!!document.querySelector('[data-setting=caret-preview]')`), 5000, "the Cursor section, light");
  await setCaret(c, { shape: "line", animation: "solid", glide: false, colour: "accent" });
  await evalIn(c, `(async () => { await __live.st().setTerminalCursorStyle("block"); return true; })()`);
  await section("settings-cursor-light");
  await setCaret(c, { shape: "pill", animation: "solid", glide: true, colour: "text" });
  await section("settings-cursor-light-pill-text");
  await evalIn(c, `(async () => { await __live.st().setThemePref("dark"); return true; })()`);
  await sleep(500);
  await section("settings-cursor-dark-pill-text");
  if (termUp) {
    await backToSession();
    note("done", { out: OUT });
  }
}

main()
  .catch((e) => { console.error("FAIL harness", e); process.exitCode = 1; })
  .finally(async () => {
    await shutDown();
    // The home is scratch; the pictures stay.
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void shutDown().finally(() => process.exit(130)); });
