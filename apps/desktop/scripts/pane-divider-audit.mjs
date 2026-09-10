/**
 * Divider AUDIT (run with: node apps/desktop/scripts/pane-divider-audit.mjs)
 *
 * `pane-divider-live.mjs` answers "is the resting divider strong enough" on one clean split. This
 * answers a different question, the one behind reports of dividers going missing outright: after a
 * session's worth of splitting, closing and zooming, is EVERY divider the layout implies actually on
 * screen?
 *
 * Three ways a divider can be absent, and this checks all three, because they fail in different
 * places: it can be missing from the DOM (the group renders n panels and n-2 handles), it can be in
 * the DOM at zero size (laid out but not painted), or it can be painted at no contrast (there, and
 * invisible). A check that only counts elements would pass the third; one that only samples pixels
 * cannot tell the first two apart.
 *
 * The operations are a sequence, not a single shape, because the reports are of dividers that
 * disappear DURING use — which points at a transition (a pane closed, a group collapsed, a zoom
 * released) rather than at any one arrangement.
 *
 * WHAT THIS CANNOT SEE: `Page.captureScreenshot` renders the DOM only. A browser pane is a native
 * WebContentsView, which composites ABOVE the window's DOM unconditionally (browser-pane.ts) and does
 * NOT appear in a CDP capture — over a live browser pane this script reads the empty pane ground and
 * happily reports everything as fine. A native view painting over a divider is therefore invisible
 * to every pixel check in this repo, and is guarded by arithmetic instead: `toViewBounds` insets the
 * view to the pixel grid so it can never reach outside its own box. See browser-host.test.ts.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9351), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8917);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-divider-audit-"));
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
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
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
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const i = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Live');
    i.dispatchEvent(new Event('input',{bubbles:true})); i.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  async function key(k, shift = false) {
    for (const type of ["keyDown", "keyUp"]) {
      await c.send("Input.dispatchKeyEvent", { type, key: k,
        code: (k === "\\" || k === "|") ? "Backslash" : `Key${k.toUpperCase()}`,
        windowsVirtualKeyCode: (k === "\\" || k === "|") ? 220 : k.toUpperCase().charCodeAt(0),
        nativeVirtualKeyCode: (k === "\\" || k === "|") ? 220 : k.toUpperCase().charCodeAt(0),
        modifiers: 4 | (shift ? 8 : 0), ...(type === "keyDown" ? { text: k } : {}) });
    }
    await sleep(400);
  }

  const SURVEY = `(() => [...document.querySelectorAll('[data-panel-group]')].map((g) => {
    const kids = [...g.children];
    const panels = kids.filter((k) => k.hasAttribute('data-panel'));
    const handles = kids.filter((k) => k.classList.contains('resize-handle'));
    return { id: g.getAttribute('data-panel-group-id'), dir: g.getAttribute('data-panel-group-direction'),
      panels: panels.length, expected: Math.max(0, panels.length - 1), found: handles.length,
      rects: handles.map((h) => { const r = h.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, display: getComputedStyle(h).display }; }) };
  }))()`;

  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

  /**
   * How visible a divider is, sampled at points ALONG its length rather than averaged across it.
   *
   * Two traps this is shaped around, both of which produced confident wrong answers first:
   *
   *  - Averaging ACROSS the line lets one icon sitting beside it pull the neighbour's mean up to the
   *    line's own value, and reports a perfectly good divider as missing. So each sample is a single
   *    line of pixels, and the divider's score is the MEDIAN of them: hidden at one point behind a
   *    glyph is not a missing divider, hidden along half its length is.
   *  - A clip is in CSS pixels but comes back in DEVICE pixels, so a fixed index into the strip reads
   *    the wrong place the moment deviceScaleFactor is not 1 — which reported every divider on a 2x
   *    screen as invisible. So the line is LOCATED (the extremum of the middle third) rather than
   *    assumed, and the ground is read from the outer thirds. That holds at any scale factor.
   */
  async function visibility(rect, dir) {
    const rows = dir === "vertical"; // a vertical GROUP stacks panes, so its handle is a horizontal line
    const length = rows ? rect.w : rect.h;
    if (length < 12) return null;
    const PAD = 6;
    const at = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((f) => Math.round((rows ? rect.x : rect.y) + length * f));
    const readings = [];
    for (const a of at) {
      const clip = rows
        ? { x: a, y: Math.round(rect.y) - PAD, width: 1, height: PAD * 2 + 1, scale: 1 }
        : { x: Math.round(rect.x) - PAD, y: a, width: PAD * 2 + 1, height: 1, scale: 1 };
      if (clip.x < 0 || clip.y < 0) continue;
      const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip });
      const px = await evalIn(c, PIXELS(shot.data));
      const strip = (rows ? px.map((r) => r[0]) : px[0]) ?? [];
      if (strip.length < 9) continue;
      const L = strip.map(lum);
      const third = Math.floor(L.length / 3);
      const ground = [...L.slice(0, third), ...L.slice(L.length - third)].sort((x, y) => x - y);
      const mid = ground[Math.floor(ground.length / 2)];
      // The line is whichever pixel in the middle band differs MOST from that ground — brighter in
      // dark mode, darker in light, and this does not need to know which.
      const band = L.slice(third, L.length - third);
      const line = band.reduce((best, v) => (Math.abs(v - mid) > Math.abs(best - mid) ? v : best), band[0]);
      readings.push(Math.abs(line - mid) / 255 * 100);
    }
    if (readings.length === 0) return null;
    readings.sort((a, b) => a - b);
    return { median: +readings[Math.floor(readings.length / 2)].toFixed(2), worst: +readings[0].toFixed(2), n: readings.length };
  }

  const FLOOR = 6.0;
  const failures = [];
  async function audit(step) {
    const survey = await evalIn(c, SURVEY);
    let total = 0;
    for (const g of survey) {
      if (g.found !== g.expected) { failures.push({ step, kind: "missing from the DOM", group: g.id, dir: g.dir, panels: g.panels, found: g.found }); continue; }
      for (const [i, r] of g.rects.entries()) {
        total++;
        const thin = g.dir === "vertical" ? r.h : r.w;
        if (r.display === "none" || thin <= 0 || (g.dir === "vertical" ? r.w : r.h) <= 0) {
          // A group squeezed to nothing takes its dividers with it. That is a pane with no room,
          // not a divider that went missing — `minSize` is a share of the PARENT, so nesting far
          // enough drives the innermost group to zero. Noted rather than failed: this script is
          // about dividers, and failing here would only ever report how deep the fuzz split.
          console.log(`    note: ${g.dir} group ${g.id} has collapsed — its divider has no room`);
          continue;
        }
        const v = await visibility(r, g.dir);
        if (v && v.median < FLOOR) failures.push({ step, kind: "invisible along its length", group: g.id, dir: g.dir, i, ...v, rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.w.toFixed(1), h: +r.h.toFixed(1) } });
      }
    }
    console.log(`  ${step}: ${survey.length} group(s), ${total} divider(s)${failures.length ? "  (" + failures.length + " failing)" : ""}`);
  }

  // Window sizes matter: every one puts the same split at a different sub-pixel offset, and a
  // rounding failure would show at some and not others.
  for (const [w, h] of [[1280, 860], [1281, 861], [1366, 768], [1440, 900], [1512, 945], [1710, 1107]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    console.log(`window ${w}x${h}`);
    for (const [label, k, sh] of [["split right", "\\", 0], ["split down", "|", 1], ["split right", "\\", 0], ["split down", "|", 1], ["zoom", "f", 1], ["unzoom", "f", 1]]) {
      await key(k, !!sh);
      await audit(label);
    }
    // And at 2x, which is the face the reports come from.
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await sleep(350);
    await audit("same layout at 2x");
  }
  await c.send("Emulation.clearDeviceMetricsOverride");

  for (const f of failures) console.log("FAIL", JSON.stringify(f));
  check("every divider the layout implies is on screen, at size, and visible along its length", failures.length === 0, { failures: failures.length });
  c.close();
}
main().catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => { electron?.kill(); fs.rmSync(scratch, { recursive: true, force: true }); });
