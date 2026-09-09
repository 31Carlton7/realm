/**
 * Live check for the sidebar/panel boundary (run with: node apps/desktop/scripts/sidebar-edge-live.mjs)
 *
 * The one hairline in the app whose backdrop Realm does not control: the sidebar paints the window
 * ground over the macOS vibrancy material, so its tone is partly the user's wallpaper, while `.main`
 * beside it is opaque. The line is drawn on `.main` for exactly that reason — only one of the two
 * sides has a fixed colour.
 *
 * A stylesheet cannot answer whether that line is VISIBLE, and `styles.test.ts` can only check which
 * property was written. This is why: the line was an inset box-shadow for a while, which computed
 * perfectly and painted nothing, because an inset shadow sits below the element's children and every
 * pane covers it. Nothing but pixels catches that.
 *
 * So this measures them: the mean luminance of each column across the seam, in both faces, with the
 * line on and off. The mutant is the point — a step that is still there with the line removed was
 * never the line.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9347), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8913);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-edge-live-"));
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

/** Per-COLUMN mean luminance of a clip. A 1px vertical line averaged over the whole image would be
 *  1/12th of the reading and vanish into rounding; per column it is one number against its
 *  neighbours, which is what "is there a line here" actually asks. */
const COLUMNS = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const cols = [];
  for (let x = 0; x < cv.width; x++) {
    let sum = 0;
    for (let y = 0; y < cv.height; y++) {
      const i = (y * cv.width + x) * 4;
      sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    cols.push(+(sum / cv.height).toFixed(2));
  }
  return cols;
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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  /** The seam's x, and a clip six pixels either side of it. */
  const geom = await evalIn(c, `(() => {
    const m = document.querySelector('.main').getBoundingClientRect();
    return { seam: Math.round(m.left), top: Math.round(m.top) + 120, height: 320 };
  })()`);
  console.log("seam at x =", geom.seam);
  /* What sits over the seam, printed for context rather than asserted on: the topmost element there
     is usually transparent and the ground behind it is `.panel`. It is the reason this edge is a
     border — an inset shadow on `.main` paints below its children, and the panes cover it — but the
     claim that actually holds is the mutant below, which removes the line and re-reads the pixels. */
  const atSeam = await evalIn(c, `(() => {
    const el = document.elementFromPoint(${geom.seam} + 0.5, ${geom.top} + 40);
    return el ? el.className + " | bg " + getComputedStyle(el).backgroundColor : "none";
  })()`);
  console.log("element at the seam:", atSeam);

  /** Mean luminance per column across the seam. Column index 6 is the seam itself. */
  async function columns() {
    const shot = await c.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
      clip: { x: geom.seam - 6, y: geom.top, width: 13, height: geom.height, scale: 1 },
    });
    return evalIn(c, COLUMNS(shot.data));
  }

  /** The size of the step at the seam, against the local run of pixels either side of it. A line is
   *  only a line if it differs from BOTH neighbours; a plain change of surface differs from one. */
  const stepAt = (cols) => {
    const seam = cols[6], left = cols[4], right = cols[8];
    return +Math.min(Math.abs(seam - left), Math.abs(seam - right)).toFixed(2);
  };

  for (const mode of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
    await sleep(350);
    const applied = await evalIn(c, `(() => {
      const s = getComputedStyle(document.querySelector('.main'));
      return { mode: document.documentElement.dataset.mode, shadow: s.boxShadow };
    })()`);
    check(`${mode}: the face actually applied`, applied.mode === mode, applied);

    const on = await columns();
    const stepOn = stepAt(on);

    // The mutant: take the line away and measure the same columns. Whatever step survives was the
    // change of surface, not the hairline — and if the two readings match, this check proves nothing.
    await evalIn(c, `(() => {
      const st = document.createElement('style'); st.id = 'mutant-edge';
      st.textContent = '.main { border-left: 0 !important; box-shadow: none !important; }';
      document.head.appendChild(st); return true; })()`);
    await sleep(250);
    const off = await columns();
    const stepOff = stepAt(off);
    await evalIn(c, `(() => { document.getElementById('mutant-edge').remove(); return true; })()`);
    await sleep(200);

    console.log(`  ${mode}: shadow=${applied.shadow}`);
    console.log(`  ${mode}: columns on  =`, on.join(" "));
    console.log(`  ${mode}: columns off =`, off.join(" "));
    check(`${mode}: the seam reads as a line against both its neighbours`, stepOn >= 1.5, { stepOn, stepOff });
    check(`${mode}: the line is what draws it — removing it collapses the step`, stepOn - stepOff >= 1.0, { stepOn, stepOff });
  }

  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
