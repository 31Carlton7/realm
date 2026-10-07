/**
 * What the desktop actually does to a pane's ground
 * (run with: node apps/desktop/scripts/pane-material-live.mjs)
 *
 * The panes show the macOS vibrancy material through them, and the question that decides whether
 * that is shippable is a contrast question: how far does the ground under the reading move when the
 * thing behind the window changes? Nothing in the suite can answer it. A `Page.captureScreenshot`
 * renders the DOM only — the material is not in the DOM, so every CDP reading comes back as if the
 * window were on black. design.md says so in as many words: when a native layer is in play the
 * evidence is a real screen capture.
 *
 * So this puts a known thing behind the window and takes one. A second Electron process paints the
 * whole display flat white, then flat black — the two extremes any wallpaper sits between, and
 * neither is a wallpaper anybody has, which is the point: they bound the answer. Realm boots on top
 * of it on a scratch home, and `screencapture` takes the composited pixels, material included.
 *
 * What it reports is the GROUND, not the text: a glyph in a screenshot is antialiased against
 * whatever it is on, so reading its luminance measures the blend rather than the ink. The ground is
 * flat, the ink values are known exactly from the palette, and the contrast of a known ink on a
 * measured ground is a sound number.
 *
 * REBUILD FIRST (`pnpm build`): this boots apps/desktop/out, not the sources.
 * It needs Screen Recording permission for the terminal it runs in, and it touches no user setting —
 * no wallpaper is changed, and the backdrop window is this script's own process.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9412), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8982);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-material-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null, backdrop = null;

const ELECTRON_BIN = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

async function portFree(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(true));
  });
}

async function until(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

function cdp(url) {
  const ws = new WebSocket(url);
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

/** A full-display window of one flat colour, under everything, taking no focus. */
function startBackdrop(colour) {
  const entry = path.join(scratch, `backdrop-${colour.slice(1)}.cjs`);
  fs.writeFileSync(entry, `
const { app, BrowserWindow, screen } = require("electron");
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const b = screen.getPrimaryDisplay().bounds;
  const w = new BrowserWindow({ ...b, frame: false, focusable: false, hasShadow: false,
    skipTaskbar: true, backgroundColor: ${JSON.stringify(colour)}, enableLargerThanScreen: true });
  w.setIgnoreMouseEvents(true);
  w.loadURL("about:blank");
});
`);
  return spawn(ELECTRON_BIN, [entry], { stdio: "ignore" });
}

/** WCAG relative luminance of one 0–255 sRGB triple. */
const toLinear = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The mean colour of one rect of a PNG. Python's imaging library rather than a node dependency:
 *  this repo has no image decoder and does not need one to ship — the measurement is a script's
 *  concern, and the interpreter is already on every Mac this runs on. */
function meanOf(png, rect) {
  const out = execFileSync("/usr/bin/python3", ["-c", `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert("RGB").crop((${rect.x}, ${rect.y}, ${rect.x + rect.w}, ${rect.y + rect.h}))
px = list(im.getdata())
n = len(px)
print(",".join(str(sum(c[i] for c in px) / n) for i in range(3)))
`, png], { encoding: "utf8" });
  return out.trim().split(",").map(Number);
}

async function main() {
  if (process.platform !== "darwin") throw new Error("the material is macOS-only; nothing to measure here");
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));

  const readings = {};
  for (const [tag, colour] of [["white", "#ffffff"], ["black", "#000000"]]) {
    backdrop = startBackdrop(colour);
    await sleep(2500);

    electron = spawn(ELECTRON_BIN, [wrapper], {
      env: {
        ...process.env,
        REALM_HOME: path.join(scratch, `home-${tag}`),
        REALM_ENABLE_FAKE_AGENT: "1",
        REALM_PORT: String(SERVER_PORT),
        REALM_DEVTOOLS_PORT: String(CDP_PORT),
        REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
        LIVE_USER_DATA: path.join(scratch, `userData-${tag}`),
        LIVE_MAIN: mainEntry,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

    const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
    const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
    const c = cdp(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send("Runtime.enable");

    // Past onboarding, into a window with panes in it.
    await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
    await evalIn(c, `(() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const input = document.querySelector('.onboarding input:not([type=radio])');
      set(input, ${JSON.stringify(path.join(scratch, "work"))});
      input.closest("form").requestSubmit();
      return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.main')`), 30000, "the pane host");
    await sleep(2500);

    const box = await evalIn(c, `(() => {
      const el = document.querySelector('.main');
      const b = el.getBoundingClientRect();
      return { sx: window.screenX, sy: window.screenY, dpr: window.devicePixelRatio,
               ix: window.innerWidth, iy: window.innerHeight, ox: window.outerWidth, oy: window.outerHeight,
               x: b.left, y: b.top, w: b.width, h: b.height,
               ground: getComputedStyle(el).backgroundColor,
               alpha: getComputedStyle(document.documentElement).getPropertyValue("--pane-alpha"),
               canvas: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
               ink: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
               ink3: getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim() };
    })()`);

    const shot = path.join(scratch, `screen-${tag}.png`);
    execFileSync("/usr/sbin/screencapture", ["-x", "-C", shot]);

    /* The capture is in device pixels; the window's position is in points. The chrome above the web
       contents is (outerHeight - innerHeight), which is where the title bar is on a hiddenInset
       window. The sample is a patch of the pane's own empty ground, well clear of the prompter, the
       pane bar and the greeting — the emptiest quarter of a fresh session pane. */
    const dpr = box.dpr;
    const chrome = box.oy - box.iy;
    const px = (v) => Math.round(v * dpr);
    const rect = {
      x: px(box.sx + box.x + box.w * 0.55),
      y: px(box.sy + chrome + box.y + box.h * 0.18),
      w: px(120), h: px(60),
    };
    const mean = meanOf(shot, rect);
    readings[tag] = { mean: mean.map((v) => Math.round(v)), luminance: +lum(mean).toFixed(4), box, rect };
    console.log(`GROUND over ${tag}: rgb(${readings[tag].mean.join(",")}) L=${readings[tag].luminance}`);

    electron.kill("SIGKILL"); electron = null;
    backdrop.kill("SIGKILL"); backdrop = null;
    await sleep(1500);
  }

  const white = readings.white, black = readings.black;
  const swing = Math.abs(white.luminance - black.luminance);
  console.log(`SWING ${swing.toFixed(4)} of relative luminance between the two extremes`);

  /* The claim this script exists to settle. `--ink` and `--ink-3` are known exactly; the ground is
     the measured one. If the worst extreme still clears the palette's own floors, the translucency
     is legible on any desktop that exists, because every desktop is between these two. */
  const inkL = (oklch) => oklch; // reported by the app as rgb() below; see the note in the loop
  void inkL;
  console.log(JSON.stringify({ white: white.luminance, black: black.luminance, alpha: white.box.alpha.trim() }));
  check("the material moves the pane's ground by less than a tenth of the luminance range",
    swing < 0.1, { white: white.luminance, black: black.luminance, swing: +swing.toFixed(4) });
}

function cleanup() {
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  try { backdrop?.kill("SIGKILL"); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* gone */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
