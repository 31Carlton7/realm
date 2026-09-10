/**
 * Live check for the machine pane (Plan 25 W3), against the real app and a real RFB server.
 *
 * What this can settle and no unit test can:
 *
 *   1. **A click lands on the pixel it looks like it lands on.** `fit.ts` has a round-trip property
 *      test, but a round trip only proves the arithmetic agrees with ITSELF. Between it and the guest
 *      sit noVNC's own scaling, a canvas's bounding rect and the display's scale factor, and the
 *      whole failure mode here is a picture that is correct while every press goes somewhere else.
 *      The server below records the `PointerEvent` it actually received.
 *   2. **The letterbox is the guest's aspect ratio**, at three pane sizes and at 2x.
 *   3. **A sheet, a menu and the palette open OVER the screen.** This is the direct evidence for the
 *      decision the whole pane rests on. A `WebContentsView` composites above all DOM — which is why
 *      the browser pane has no dropdowns and why `state/no-overlay.ts` exists — and a canvas does
 *      not. Here a CDP screenshot IS valid evidence, which is the exact inverse of design.md's
 *      warning about native views, and worth saying because the same capture would prove nothing at
 *      all one pane over.
 *
 * Run:  node apps/desktop/scripts/machine-pane-live.mjs
 * Rebuild first — this boots the BUILT app, and a stale build reads as a live bug.
 *
 * Hygiene: scratch REALM_HOME + userData under mkdtemp, removed at exit. The RFB server is this
 * file's own, on a loopback port. Never point this at the real ~/Realm.
 */
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9381), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8947);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-machine-live-"));
let electron = null, rfb = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The guest's screen. Deliberately not square and not a round fraction of any pane size below, so a
 *  letterbox on the wrong axis or a fit that quietly rounded is visible in the numbers. */
const FB = { width: 1440, height: 900 };

/* ─────────────────────────── a real RFB server ─────────────────────────── */

/**
 * As much of RFB 3.8 as a viewer needs, and no more: version, `None` security, ServerInit, and Raw
 * framebuffer updates. Written out rather than shelled to x11vnc because the point is a KNOWN
 * pattern and a recorded input — a real VNC server would give neither.
 *
 * The pattern is four solid quadrants. Solid, because the assertion is about WHICH quadrant a click
 * reached, and a gradient would make a one-pixel error indistinguishable from a correct answer.
 */
function startRfbServer() {
  const pointers = [];
  const keys = [];
  const seen = [];
  const server = createServer((sock) => {
    let phase = "version", buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.write(Buffer.from("RFB 003.008\n", "latin1"));
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (phase === "version") {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 1]));            // one security type on offer: None
          phase = "security";
          continue;
        }
        if (phase === "security") {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          sock.write(Buffer.from([0, 0, 0, 0]));      // SecurityResult: ok
          phase = "clientinit";
          continue;
        }
        if (phase === "clientinit") {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          sock.write(serverInit());
          phase = "messages";
          continue;
        }
        // Client→server messages, by their fixed sizes. Nothing here answers anything it does not
        // have to; an unknown type ends the loop rather than desynchronising the stream.
        if (buf.length < 1) return;
        const type = buf[0];
        if (type === 0) {                                                                           // SetPixelFormat
          if (buf.length < 20) return;
          /* Honoured rather than skipped, and the first version of this file skipped it: noVNC asks
             for its OWN byte order, and a server that keeps sending its declared one renders every
             red pixel blue. Harmless for the coordinate checks below and completely misleading in
             the diagnostic beside them, which is the worst combination — a check that looks wrong
             while passing teaches you to stop reading it. */
          fmt = { rs: buf[14], gs: buf[15], bs: buf[16] };
          cachedUpdate = null;
          buf = buf.subarray(20);
          continue;
        }
        if (type === 2) {                                                                           // SetEncodings
          if (buf.length < 4) return;
          const n = buf.readUInt16BE(2);
          if (buf.length < 4 + n * 4) return;
          buf = buf.subarray(4 + n * 4);
          continue;
        }
        if (type === 3) {                                                                           // FramebufferUpdateRequest
          if (buf.length < 10) return;
          seen.push('fbur');
          buf = buf.subarray(10);
          sock.write(fullUpdate());
          continue;
        }
        if (type === 4) { if (buf.length < 8) return; keys.push({ down: buf[1], key: buf.readUInt32BE(4) }); buf = buf.subarray(8); continue; }
        if (type === 5) {                                                                           // PointerEvent
          if (buf.length < 6) return;
          pointers.push({ mask: buf[1], x: buf.readUInt16BE(2), y: buf.readUInt16BE(4) });
          buf = buf.subarray(6);
          continue;
        }
        if (type === 6) {                                                                           // ClientCutText
          if (buf.length < 8) return;
          const len = buf.readUInt32BE(4);
          if (buf.length < 8 + len) return;
          buf = buf.subarray(8 + len);
          continue;
        }
        return;
      }
    });
  });
  return { server, pointers, keys, seen, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))) };
}

function serverInit() {
  const name = Buffer.from("Live test pattern", "utf8");
  const b = Buffer.alloc(24 + name.length);
  b.writeUInt16BE(FB.width, 0);
  b.writeUInt16BE(FB.height, 2);
  // PIXEL_FORMAT: 32bpp, depth 24, little-endian, true colour, BGRX shifts — noVNC's own preference,
  // so it has no reason to ask for a different one and the pattern below needs no re-encoding.
  b[4] = 32; b[5] = 24; b[6] = 0; b[7] = 1;
  b.writeUInt16BE(255, 8); b.writeUInt16BE(255, 10); b.writeUInt16BE(255, 12);
  b[14] = 16; b[15] = 8; b[16] = 0;
  b.writeUInt32BE(name.length, 20);
  name.copy(b, 24);
  return b;
}

/** Quadrant colours, in the order (top-left, top-right, bottom-left, bottom-right). */
const QUADRANTS = [
  { name: "top-left", rgb: [255, 0, 0] },
  { name: "top-right", rgb: [0, 255, 0] },
  { name: "bottom-left", rgb: [0, 0, 255] },
  { name: "bottom-right", rgb: [255, 255, 0] },
];
const quadrantOf = (x, y) => (y < FB.height / 2 ? 0 : 2) + (x < FB.width / 2 ? 0 : 1);

/** The client's requested channel shifts, from SetPixelFormat. Defaults to what ServerInit
 *  declared, which is what a client that never asks for anything else gets. */
let fmt = { rs: 16, gs: 8, bs: 0 };
let cachedUpdate = null;
function fullUpdate() {
  if (cachedUpdate) return cachedUpdate;
  const pixels = Buffer.alloc(FB.width * FB.height * 4);
  for (let y = 0; y < FB.height; y++) {
    for (let x = 0; x < FB.width; x++) {
      const [r, g, bl] = QUADRANTS[quadrantOf(x, y)].rgb;
      const i = (y * FB.width + x) * 4;
      // Packed little-endian into the shifts the CLIENT asked for, not the ones we declared.
      const word = (r << fmt.rs) | (g << fmt.gs) | (bl << fmt.bs);
      pixels.writeUInt32LE(word >>> 0, i);
    }
  }
  const head = Buffer.alloc(16);
  head.writeUInt8(0, 0); head.writeUInt8(0, 1); head.writeUInt16BE(1, 2);          // one rectangle
  head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6);
  head.writeUInt16BE(FB.width, 8); head.writeUInt16BE(FB.height, 10);
  head.writeInt32BE(0, 12);                                                        // Raw
  cachedUpdate = Buffer.concat([head, pixels]);
  return cachedUpdate;
}

/* ─────────────────────────── the harness ─────────────────────────── */

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
    const v = await fn().catch(() => null);
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

const HELPERS = `
globalThis.__live = {
  box: (n) => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; },
  canvas: () => document.querySelector('.machine-host canvas'),
  screen: () => document.querySelector('.machine-screen'),
  fill: (label, value) => {
    const el = [...document.querySelectorAll('.machine-field')].find((f) => f.querySelector('span')?.textContent.trim().startsWith(label));
    if (!el) throw new Error('no field: ' + label);
    const input = el.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const shot = async (c, tag) => {
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(os.tmpdir(), `realm-machine-live-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return out;
};

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  rfb = startRfbServer();
  const vncPort = await rfb.listen();
  console.log(`[live] test-pattern RFB server on 127.0.0.1:${vncPort} (${FB.width}x${FB.height})`);

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
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
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  // 2x, because the bug `fit.ts` exists to prevent is invisible at 1x: computing the ratio in CSS
  // pixels looks like exactly 1 in the code and gives a half-resolution screen only on a Retina
  // display. Every measurement below is taken under it.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* ── connect, through the connect flow the user actually uses ─────────── */
  await evalIn(c, `(() => { document.querySelector('.cmdk') || window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `(() => {
    const rows = [...document.querySelectorAll('.cmdk-row, .cmdk-item, [role="option"]')];
    const row = rows.find((r) => /Connect a machine/i.test(r.textContent ?? ''));
    if (!row) throw new Error('no palette row (have: ' + rows.map((r) => r.textContent.trim()).slice(0, 12).join('|') + ')');
    row.click();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.machine-connect')`), 15000, "connect flow");
  check("the pane opens with the connect flow ready", true);

  await evalIn(c, `(() => {
    [...document.querySelectorAll('.machine-routes button')].find((b) => /Host and port/.test(b.textContent))?.click();
    return true; })()`);
  await sleep(150);
  await evalIn(c, `__live.fill('Host and port', '127.0.0.1:${vncPort}')`);
  await sleep(200);
  const resolved = await evalIn(c, `document.querySelector('.machine-resolved-target')?.textContent ?? null`);
  check("the form says what it will dial, in the units it will dial it in", resolved === `127.0.0.1:${vncPort}`, resolved);

  await evalIn(c, `(() => { document.querySelector('.machine-connect').requestSubmit(); return true; })()`);
  const canvasBox = await until(() => evalIn(c, `(() => { const n = __live.canvas(); return n && n.getBoundingClientRect().width > 10 ? __live.box(n) : null; })()`), 20000, "canvas");
  await sleep(800);
  const painted = await evalIn(c, `(() => {
    const cv = __live.canvas();
    const g = cv.getContext('2d');
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { w: cv.width, h: cv.height, tl: px(10, 10), tr: px(cv.width - 10, 10), bl: px(10, cv.height - 10) };
  })()`);
  check("the guest's screen is on the canvas", canvasBox.w > 10, canvasBox);
  console.log(`[diag] backing store ${painted.w}x${painted.h}, corners tl=${painted.tl} tr=${painted.tr} bl=${painted.bl}, server saw ${rfb.seen.length} update requests`);
  /* The pattern arrived, in the right places and the right colours. This is what proves the pixels
     came through the relay rather than the canvas merely being the right SIZE — which it is from
     the ServerInit alone, and which is exactly how a permanently black screen once passed. */
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 24);
  check("the test pattern is painted, quadrant by quadrant", rfb.seen.length > 0
    && near(painted.tl, QUADRANTS[0].rgb) && near(painted.tr, QUADRANTS[1].rgb) && near(painted.bl, QUADRANTS[2].rgb),
    { tl: painted.tl, tr: painted.tr, bl: painted.bl, requests: rfb.seen.length });

  /* ── 2. the letterbox is the guest's aspect ratio, at three pane sizes ── */
  for (const [w, h] of [[1500, 950], [1100, 950], [1500, 620]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    const m = await evalIn(c, `(() => ({ canvas: __live.box(__live.canvas()), screen: __live.box(__live.screen()) }))()`);
    const want = FB.width / FB.height;
    const got = m.canvas.w / m.canvas.h;
    check(`${w}x${h}: the canvas keeps the guest's aspect ratio`, Math.abs(got - want) < 0.01, { want: want.toFixed(3), got: got.toFixed(3) });
    check(`${w}x${h}: it fits inside the pane rather than overflowing it`,
      m.canvas.w <= m.screen.w + 1 && m.canvas.h <= m.screen.h + 1, m);
    // Letterboxed on exactly one axis: a fit that filled neither would be a rounding bug, and one
    // that filled both would mean the aspect ratio above was a coincidence.
    const fillsW = Math.abs(m.canvas.w - m.screen.w) < 2, fillsH = Math.abs(m.canvas.h - m.screen.h) < 2;
    check(`${w}x${h}: it is bound by exactly one axis`, fillsW !== fillsH, { fillsW, fillsH });
  }

  /* ── 1. a click lands on the pixel it looks like it lands on ──────────── */
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const box = await evalIn(c, `__live.box(__live.canvas())`);
  for (const [fx, fy, label] of [[0.25, 0.25, "top-left"], [0.75, 0.25, "top-right"], [0.25, 0.75, "bottom-left"], [0.75, 0.75, "bottom-right"]]) {
    const before = rfb.pointers.length;
    const px = box.l + box.w * fx, py = box.t + box.h * fy;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await c.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
    await sleep(300);
    const got = rfb.pointers.slice(before).at(-1);
    // What the guest was told, against what the picture said. The tolerance is one framebuffer pixel
    // per device pixel of rounding, which at this scale is a couple — anything larger is the scale
    // factor showing up as a coordinate error.
    const want = { x: Math.round(FB.width * fx), y: Math.round(FB.height * fy) };
    const off = got ? Math.hypot(got.x - want.x, got.y - want.y) : Infinity;
    check(`a click at the ${label} quadrant reaches the ${label} quadrant`,
      got != null && quadrantOf(got.x, got.y) === quadrantOf(want.x, want.y) && off < 6,
      { want, got, off: Number.isFinite(off) ? off.toFixed(1) : "none" });
  }

  /* ── 3. the whole reason this is a canvas ─────────────────────────────── */
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); return true; })()`);
  await sleep(400);
  const over = await evalIn(c, `(() => {
    const p = document.querySelector('.cmdk, .palette, [role="dialog"]');
    if (!p) return null;
    const b = p.getBoundingClientRect();
    const cv = __live.canvas().getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const overlaps = b.left < cv.right && b.right > cv.left && b.top < cv.bottom && b.bottom > cv.top;
    // What is actually painted at the palette's own centre. On a native view this is the view and
    // the palette is invisible; on a canvas it is the palette, which is the whole point.
    const top = document.elementFromPoint(cx, cy);
    return { overlaps, topIsPalette: !!top && (p === top || p.contains(top)), box: { l: b.left, t: b.top, w: b.width, h: b.height } };
  })()`);
  check("the command palette opens", over !== null, over);
  check("…over the screen rather than beside it", over?.overlaps === true, over);
  /* The direct evidence for the decision the pane rests on. A `WebContentsView` composites above all
     DOM unconditionally, so the palette would be hit-tested BEHIND one however the layout reads —
     which is why the browser pane has no dropdowns and why `no-overlay.ts` exists. Here the topmost
     thing at the palette's own centre is the palette. */
  check("…and is the topmost thing there, which a native view would never allow", over?.topIsPalette === true, over);
  await shot(c, "palette-over-canvas");

  await c.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
}

const cleanup = () => {
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  try { rfb?.server.close(); } catch { /* gone */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
};

const bail = setTimeout(() => { console.error("[live] TIMEOUT"); cleanup(); process.exit(2); }, 180_000);
main()
  .catch((e) => { failures += 1; console.log(`FAIL script threw — ${e?.stack ?? e}`); })
  .finally(() => {
    clearTimeout(bail);
    console.log(failures === 0 ? "[live] ALL PASS" : `[live] ${failures} FAILURE(S)`);
    cleanup();
    process.exit(failures === 0 ? 0 : 1);
  });
