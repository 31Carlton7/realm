/**
 * Live check for the sidebar list's bottom fade (run with: node apps/desktop/scripts/sidebar-fade-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves the two things a jsdom test cannot, because
 * both need real layout and real compositing:
 *
 *   1. Clearance. Scrolled to the end, the LAST session row sits entirely above the fade band. The
 *      band is supposed to dissolve empty gutter, not the row someone scrolled down to read, and the
 *      only thing holding that apart is .space-body's bottom padding matching --fade-h.
 *   2. The blur actually composites. The sidebar is a macOS vibrancy column, not an opaque panel, and
 *      a backdrop-filter over a vibrant material is a different question from one over a solid
 *      surface — it can silently resolve to nothing. jsdom has neither a backdrop nor a filter.
 *
 * Both are paired with a mutant that reproduces the bug they pin: the padding is taken away for the
 * first, the backdrop-filter for the second, and each measurement has to move.
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

/** Mean horizontal gradient energy per row of a clip — how sharp the edges in it are. Blur destroys
 *  the hard boundaries of glyphs, so the same strip of rows measured with and without the backdrop
 *  filter differs here even though both are the same content at the same scroll offset. A hash
 *  comparison cannot be used: a vibrancy material dithers, so two captures of an untouched surface
 *  are already not bit-identical. */
const SHARPNESS = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  cv.getContext("2d").drawImage(img, 0, 0);
  const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  let sum = 0, n = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width - 1; x++) {
      const i = (y * cv.width + x) * 4;
      sum += Math.abs(lum(i) - lum(i + 4)); n++;
    }
  }
  return n ? +(sum / n).toFixed(4) : 0;
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
    const fade = document.querySelector('.space-fade').getBoundingClientRect();
    return { lastBottom: Math.round(last.bottom), lastTop: Math.round(last.top), fadeTop: Math.round(fade.top),
             gap: Math.round(fade.top - last.bottom), fadeH: Math.round(fade.height) };
  })()`);
  await sleep(250);
  check("scrolled to the end, the last session sits entirely above the fade band",
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
    const fade = document.querySelector('.space-fade').getBoundingClientRect();
    return { gap: Math.round(fade.top - last.bottom) };
  })()`);
  check("the mutant reproduces the bug (no bottom padding ⇒ the last session ends under the blur)",
    mutantClearance.gap < 0, { ...mutantClearance, withPadding: clearance.gap });
  await evalIn(c, `(() => { document.getElementById('mutant-pad').remove(); return true; })()`);
  await sleep(200);

  /* ── 2. The blur composites over the vibrancy material ───────────────────────────────────── */
  // Park the scroll mid-list so real rows are under the band, then measure the SAME pixels with the
  // filter on and off. Same content, same offset — the only variable is the backdrop-filter.
  const band = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    // Halfway down the SCROLLABLE range, not half the scroll height — the latter clamps to the end,
    // where the bottom padding guarantees there are no rows under the band at all and the measurement
    // below would be reading the empty gutter.
    b.scrollTop = Math.round((b.scrollHeight - b.clientHeight) / 2);
    const f = document.querySelector('.space-fade').getBoundingClientRect();
    const s = b.getBoundingClientRect();
    // The band's fully-blurred lower part, clipped to the scroller so the measurement never strays
    // into the gutter below it.
    const top = Math.round(f.top + f.height * 0.4), bottom = Math.round(Math.min(f.bottom, s.bottom));
    const covered = [...b.querySelectorAll('.item')].filter((r) => {
      const q = r.getBoundingClientRect(); return q.bottom > top && q.top < bottom;
    }).length;
    return { x: Math.round(s.left), y: top, width: Math.round(s.width), height: bottom - top, covered };
  })()`);
  check("real rows are under the measured strip, so the comparison is not vacuous", band.covered > 0, { covered: band.covered, h: band.height });

  const clip = { x: band.x, y: band.y, width: band.width, height: band.height, scale: 1 };
  await sleep(300);
  const blurredShot = (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
  const blurred = await evalIn(c, SHARPNESS(blurredShot));

  await evalIn(c, `(() => {
    const st = document.createElement('style'); st.id = 'mutant-blur';
    st.textContent = '.space-fade::before, .space-fade::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';
    document.head.appendChild(st); return true; })()`);
  await sleep(350);
  const sharpShot = (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
  const sharp = await evalIn(c, SHARPNESS(sharpShot));
  await evalIn(c, `(() => { document.getElementById('mutant-blur').remove(); return true; })()`);

  check("the band really blurs the rows under it — over macOS vibrancy, not just over an opaque panel",
    blurred < sharp * 0.7, { blurred, sharp, ratio: +(blurred / sharp).toFixed(3) });

  /* ── 3. The band is invisible where it has nothing to dissolve ──────────────────────────── */
  // Scrolled to the end, the band sits over the bottom padding — empty column. If a blur over this
  // material tints what it samples, that shows up here as a tonal stripe across the sidebar with no
  // content under it, which is a seam rather than a dissolve.
  const gutter = await evalIn(c, `(() => {
    const b = document.querySelector('.space-body');
    b.scrollTop = b.scrollHeight;
    const f = document.querySelector('.space-fade').getBoundingClientRect();
    const s = b.getBoundingClientRect();
    const inBand = { x: Math.round(s.left), y: Math.round(f.top + 20), width: Math.round(s.width), height: 16 };
    // An equal slab of untouched gutter directly above the band, between the last row and the ramp.
    return { inBand, above: { ...inBand, y: Math.round(f.top - 18) } };
  })()`);
  await sleep(300);
  const bandLum = await evalIn(c, MEANLUM((await c.send("Page.captureScreenshot", { format: "png", clip: { ...gutter.inBand, scale: 1 } })).data));
  const aboveLum = await evalIn(c, MEANLUM((await c.send("Page.captureScreenshot", { format: "png", clip: { ...gutter.above, scale: 1 } })).data));
  check("over empty gutter the band leaves no tonal seam — it dissolves content, it does not paint a stripe",
    Math.abs(bandLum - aboveLum) < 2, { inBand: bandLum, above: aboveLum, delta: +(bandLum - aboveLum).toFixed(3) });

  await sleep(300);
  const sidebar = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 280, height: 620, scale: 2 } });
  for (const [tag, data] of [["band-blurred", blurredShot], ["band-sharp", sharpShot], ["sidebar", sidebar.data]]) {
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
