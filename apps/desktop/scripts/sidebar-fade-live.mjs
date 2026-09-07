/**
 * Live check for the sidebar list's bottom fade (run with: node apps/desktop/scripts/sidebar-fade-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves the two things a jsdom test cannot, because
 * both need real layout and real compositing:
 *
 *   1. Clearance. Scrolled to the end, the LAST session row sits entirely above the ramp. The ramp
 *      is supposed to dissolve empty gutter, not the row someone scrolled down to read, and the only
 *      thing holding that apart is .space-body's bottom padding matching --fade-h.
 *   2. The mask actually dissolves, and paints nothing. The ramp is a mask on the scroller: over its
 *      last --fade-h the rows' alpha runs to zero, so with a row parked under it the scroller's last
 *      pixels read as the column's own ground — the same tone as untouched gutter — and taking the
 *      mask away puts the row's glyphs back. It replaced a backdrop-blur band which, over this
 *      translucent column, blurred the window's own transparency and composited toward black: a
 *      dark smudge hanging above the space strip. The third check is the one that caught that.
 *
 * Each is paired with a mutant that reproduces the bug it pins: the padding is taken away for the
 * first, the mask for the second, and each measurement has to move.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9339), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8905);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-fade-"));
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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
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

/** Mean luminance of a clip — used to ask whether the band tints the column it sits over. A
 *  backdrop-filter over a VIBRANT material is not the same operation as one over an opaque panel;
 *  it can average the material toward a different tone and leave a visible band across the sidebar
 *  even where there is no content under it to dissolve. */
const MEANLUM = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  cv.getContext("2d").drawImage(img, 0, 0);
  const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  return +(sum / (px.length / 4)).toFixed(3);
})()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // Short viewport on purpose: it takes fewer sessions to overflow the list, and the fade only has a
  // job once the list scrolls.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  // "New session" opens into the focused leaf, so each click pushes the previous session out into the
  // SPACE group — one click, one more row.
  for (let i = 0; i < 10; i++) {
    const want = i + 2;
    await evalIn(c, `(() => { document.querySelector('.new-row').click(); return true; })()`);
    await until(() => evalIn(c, `document.querySelectorAll('.space-body .item').length >= ${want}`), 15000, `session ${want}`);
  }
  await sleep(400);

  const overflow = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    return { scrollH: b.scrollHeight, clientH: b.clientHeight, rows: b.querySelectorAll('.item').length };
  })()`);
  check("the list actually overflows, so the fade has something to do", overflow.scrollH > overflow.clientH + 40, overflow);

  /* ── 1. Clearance: scrolled to the end, the last row is clear of the band ────────────────── */
  const clearance = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    b.scrollTop = b.scrollHeight;
    const rows = [...b.querySelectorAll('.item')];
    const last = rows[rows.length - 1].getBoundingClientRect();
    const s = b.getBoundingClientRect();
    const fadeH = parseFloat(getComputedStyle(b).paddingBottom);
    const fadeTop = s.bottom - fadeH;
    return { lastBottom: Math.round(last.bottom), lastTop: Math.round(last.top), fadeTop: Math.round(fadeTop),
             gap: Math.round(fadeTop - last.bottom), fadeH: Math.round(fadeH) };
  })()`);
  await sleep(250);
  check("scrolled to the end, the last session sits entirely above the ramp",
    clearance.gap >= 0, clearance);

  // The mutant: take the scroller's bottom padding away, which is the only thing buying that gap.
  await evalIn(c, `(() => {
    const st = document.createElement('style'); st.id = 'mutant-pad';
    st.textContent = '.space-body { padding-bottom: 0 !important; }';
    document.head.appendChild(st); return true; })()`);
  await sleep(200);
  const mutantClearance = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    b.scrollTop = b.scrollHeight;
    const rows = [...b.querySelectorAll('.item')];
    const last = rows[rows.length - 1].getBoundingClientRect();
    const s = b.getBoundingClientRect();
    // The padding is gone, so the ramp's height has to come from the page's --fade-h directly.
    const fadeH = parseFloat(getComputedStyle(b.closest('.space-page')).getPropertyValue('--fade-h'));
    return { gap: Math.round((s.bottom - fadeH) - last.bottom) };
  })()`);
  check("the mutant reproduces the bug (no bottom padding ⇒ the last session ends under the ramp)",
    mutantClearance.gap < 0, { ...mutantClearance, withPadding: clearance.gap });
  await evalIn(c, `(() => { document.getElementById('mutant-pad').remove(); return true; })()`);
  await sleep(200);

  /* ── 2. The mask dissolves a row to the ground, and the mutant puts it back ─────────────── */
  // Park the scroll mid-list so real rows run under the ramp, then read the scroller's LAST rows of
  // pixels: at the bottom edge the mask is fully transparent, so whatever row is there must have
  // vanished into the column's ground. Same content, same offset — the only variable is the mask.
  const band = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    /* A row's MIDDLE is parked at the scroller's bottom edge, rather than scrolling to the middle of
       the range and taking whatever lands there. Half the range is not a row boundary, so the strip
       could fall on a row's rounded top corner — mostly gutter, low contrast — and the mutant that
       puts the row back would then barely brighten it. Aiming at the row's centre band makes both
       readings about the same ink, which is the comparison this is trying to make. */
    const rows0 = [...b.querySelectorAll('.item')];
    const target = rows0[Math.floor(rows0.length / 2)];
    const s0 = b.getBoundingClientRect(), q = target.getBoundingClientRect();
    const centreFromTop = (q.top + q.height / 2) - s0.top + b.scrollTop;
    b.scrollTop = Math.max(0, Math.min(b.scrollHeight - b.clientHeight, Math.round(centreFromTop - b.clientHeight + 3)));
    const s = b.getBoundingClientRect();
    const top = Math.round(s.bottom - 6), bottom = Math.round(s.bottom);
    const covered = [...b.querySelectorAll('.item')].filter((r) => {
      const q = r.getBoundingClientRect(); return q.bottom > top && q.top < bottom;
    }).length;
    return { x: Math.round(s.left), y: top, width: Math.round(s.width), height: bottom - top, covered,
             gutter: { x: Math.round(s.left), y: Math.round(s.bottom) + 2, width: Math.round(s.width), height: 6 } };
  })()`);
  check("a real row runs under the measured strip, so the comparison is not vacuous", band.covered > 0, { covered: band.covered });

  const clip = { x: band.x, y: band.y, width: band.width, height: band.height, scale: 1 };
  await sleep(300);
  const maskedShot = (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
  const masked = await evalIn(c, MEANLUM(maskedShot));
  // The untouched column directly below the scroller: what a fully dissolved row should read as.
  const groundLum = await evalIn(c, MEANLUM((await c.send("Page.captureScreenshot", { format: "png", clip: { ...band.gutter, scale: 1 } })).data));

  await evalIn(c, `(() => {
    const st = document.createElement('style'); st.id = 'mutant-mask';
    st.textContent = '.space-body { mask-image: none !important; -webkit-mask-image: none !important; }';
    document.head.appendChild(st); return true; })()`);
  await sleep(350);
  const unmaskedShot = (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
  const unmasked = await evalIn(c, MEANLUM(unmaskedShot));
  await evalIn(c, `(() => { document.getElementById('mutant-mask').remove(); return true; })()`);

  check("at the scroller's bottom edge a row has dissolved into the column's own ground",
    Math.abs(masked - groundLum) < 2, { masked, ground: groundLum, delta: +(masked - groundLum).toFixed(3) });
  check("the mutant reproduces the bug (no mask ⇒ the row is back, brighter than the ground)",
    Math.abs(unmasked - groundLum) > 4, { unmasked, ground: groundLum });

  /* ── 3. The ramp is invisible where it has nothing to dissolve ──────────────────────────── */
  // Scrolled to the end, the ramp sits over the bottom padding — empty column. This is the check the
  // old backdrop-blur band failed: over a translucent column it composited toward black and painted a
  // dark stripe across the sidebar with no content under it. A mask paints nothing, so the band and
  // the gutter above it must read the same.
  const gutter = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    b.scrollTop = b.scrollHeight;
    const s = b.getBoundingClientRect();
    const fadeH = parseFloat(getComputedStyle(b).paddingBottom);
    const inBand = { x: Math.round(s.left), y: Math.round(s.bottom - fadeH + 20), width: Math.round(s.width), height: 16 };
    // The reference is the column just BELOW the scroller: untouched ground with nothing over it.
    // (Not the slab above the ramp — the last row ends exactly at the ramp's top, so that is a row.)
    return { inBand, below: { ...inBand, y: Math.round(s.bottom) + 2, height: 6 } };
  })()`);
  await sleep(300);
  const bandLum = await evalIn(c, MEANLUM((await c.send("Page.captureScreenshot", { format: "png", clip: { ...gutter.inBand, scale: 1 } })).data));
  const belowLum = await evalIn(c, MEANLUM((await c.send("Page.captureScreenshot", { format: "png", clip: { ...gutter.below, scale: 1 } })).data));
  check("over empty gutter the ramp leaves no tonal seam — it dissolves content, it does not paint a stripe",
    Math.abs(bandLum - belowLum) < 2, { inBand: bandLum, below: belowLum, delta: +(bandLum - belowLum).toFixed(3) });

  await sleep(300);
  const sidebar = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 280, height: 620, scale: 2 } });
  for (const [tag, data] of [["edge-masked", maskedShot], ["edge-unmasked", unmaskedShot], ["sidebar", sidebar.data]]) {
    const out = path.join(os.tmpdir(), `realm-sidebar-fade-${tag}.png`);
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${out}`);
  }

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
