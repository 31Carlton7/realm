/**
 * Live check for the divider between two panes (run with: node apps/desktop/scripts/pane-divider-live.mjs)
 *
 * `.resize-handle` is the ONLY thing separating one pane from the next. Everywhere else in the app a
 * hairline accompanies a change of surface and the surface change carries most of the boundary — but
 * `.main` and every `.panel` both paint --rl-panel, so here there is no change of surface at all. If
 * the line is faint, the panes are one wash.
 *
 * A stylesheet cannot answer how faint. `--rl-line` is 8% white; what that COMES TO depends on the
 * ground it lands on, and on --rl-panel it measured 17 of 255 — 6.6% — which is where the reports of
 * dividers "disappearing" came from. The reliable way to see one was to put the pointer on it, which
 * is the hover state doing the resting state's job.
 *
 * So this measures pixels: the mean luminance of each row/column across a divider, in both faces, at
 * rest and hovered, with the mutant (back to --rl-line) beside it. Reported as a percentage of full
 * range, because that is the number a human squinting at a dark pane is actually subject to.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9348), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8914);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-divider-live-"));
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

/** Per-ROW (or per-column) mean luminance of a clip. A 1px line averaged over the whole image would
 *  be a twelfth of the reading and vanish into rounding; per line it is one number against its
 *  neighbours, which is what "is there a line here" actually asks. */
const LINES = (b64, axis) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const across = ${JSON.stringify(axis)} === "rows" ? cv.height : cv.width;
  const along = ${JSON.stringify(axis)} === "rows" ? cv.width : cv.height;
  const out = [];
  for (let a = 0; a < across; a++) {
    let sum = 0;
    for (let b = 0; b < along; b++) {
      const i = (${JSON.stringify(axis)} === "rows" ? (a * cv.width + b) : (b * cv.width + a)) * 4;
      sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    out.push(+(sum / along).toFixed(2));
  }
  return out;
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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  // Two splits, so BOTH axes are under test: ⌘\ gives a vertical divider, ⌘⇧\ a horizontal one.
  // They are separate code paths only in the sense that flex-basis means width on one and height on
  // the other — but that is exactly the sort of thing a stylesheet reads fine and renders wrong.
  for (const shift of [false, true]) {
    for (const type of ["keyDown", "keyUp"]) {
      await c.send("Input.dispatchKeyEvent", {
        type, key: shift ? "|" : "\\", code: "Backslash", windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220,
        modifiers: 4 | (shift ? 8 : 0), ...(type === "keyDown" ? { text: shift ? "|" : "\\" } : {}),
      });
    }
    await sleep(400);
  }
  await sleep(600);

  const handles = await evalIn(c, `[...document.querySelectorAll('.resize-handle')].map((e) => {
    const r = e.getBoundingClientRect();
    return { dir: e.closest('[data-panel-group]')?.getAttribute('data-panel-group-direction'),
             x: r.x, y: r.y, w: r.width, h: r.height };
  })`);
  check("both a vertical and a horizontal divider are on screen", 
    handles.some((h) => h.dir === "horizontal") && handles.some((h) => h.dir === "vertical"), handles.map((h) => h.dir));

  /** Mean luminance across a divider: index 6 is the divider itself, 0-5 and 7-12 its neighbours. */
  async function lines(h) {
    const rows = h.dir === "vertical"; // a vertical GROUP stacks panes, so its handle is a horizontal line
    const clip = rows
      ? { x: Math.round(h.x + h.w * 0.25), y: Math.round(h.y) - 6, width: Math.max(40, Math.round(h.w * 0.5)), height: 13, scale: 1 }
      : { x: Math.round(h.x) - 6, y: Math.round(h.y + h.h * 0.25), width: 13, height: Math.max(40, Math.round(h.h * 0.5)), scale: 1 };
    const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip });
    return evalIn(c, LINES(shot.data, rows ? "rows" : "cols"));
  }

  /** The step at the divider against BOTH neighbours. A line is only a line if it differs from each
   *  side; a plain change of surface differs from one. As a percentage of full range, because "17 of
   *  255" is the number and "6.6%" is what it means. */
  const stepAt = (ls) => +((Math.min(Math.abs(ls[6] - ls[4]), Math.abs(ls[6] - ls[8])) / 255) * 100).toFixed(2);

  // What the resting line has to clear. 6.6% is what --rl-line measured on --rl-panel, and it is the
  // reading this check exists because of — so the floor sits above it, not at it.
  const FLOOR = 8.0;

  for (const mode of ["dark", "light"]) {
    await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(mode)}; return true; })()`);
    await sleep(350);

    for (const dir of ["horizontal", "vertical"]) {
      const h = handles.find((x) => x.dir === dir);
      if (!h) continue;
      const axis = dir === "vertical" ? "a horizontal divider" : "a vertical divider";

      // Pointer parked far away: hover is the state that was covering for this one, and measuring it
      // by accident is how the resting line stayed unmeasured for so long.
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 });
      await sleep(150);
      const rest = await lines(h);
      const stepRest = stepAt(rest);

      // The mutant: put the resting line back to --rl-line and re-read the same pixels. If the two
      // readings match, this check proves nothing about the token that was changed.
      await evalIn(c, `(() => {
        const st = document.createElement('style'); st.id = 'mutant-divider';
        st.textContent = '.resize-handle { background: var(--rl-line) !important; }';
        document.head.appendChild(st); return true; })()`);
      await sleep(250);
      const weak = await lines(h);
      const stepWeak = stepAt(weak);
      await evalIn(c, `(() => { document.getElementById('mutant-divider').remove(); return true; })()`);
      await sleep(200);

      // The dragging step, which must survive raising the resting line — a divider is a control.
      // Driven by the ATTRIBUTE react-resizable-panels sets on a real drag, not by a synthetic
      // mouseMoved: CDP's pointer does not update `:hover` here, so a hover reading is a measurement
      // of the rig. The attribute is a state the app genuinely enters, and the CSS targets both.
      await evalIn(c, `(() => {
        const e = [...document.querySelectorAll('.resize-handle')].find((x) =>
          x.closest('[data-panel-group]')?.getAttribute('data-panel-group-direction') === ${JSON.stringify(dir)});
        e.setAttribute('data-resize-handle-active', 'pointer'); return true; })()`);
      await sleep(250);
      const hover = await lines(h);
      const stepHover = stepAt(hover);
      await evalIn(c, `(() => {
        const e = [...document.querySelectorAll('.resize-handle')].find((x) =>
          x.closest('[data-panel-group]')?.getAttribute('data-panel-group-direction') === ${JSON.stringify(dir)});
        e.removeAttribute('data-resize-handle-active'); return true; })()`);
      await sleep(150);

      console.log(`  ${mode}/${axis}: rest=${stepRest}%  was=${stepWeak}%  dragging=${stepHover}%`);
      check(`${mode}: ${axis} holds at rest`, stepRest >= FLOOR, { stepRest, FLOOR });
      check(`${mode}: ${axis} is stronger than the line it replaced`, stepRest - stepWeak >= 1.0, { stepRest, stepWeak });
      check(`${mode}: ${axis} still gains a step while dragging`, stepHover - stepRest >= 1.0, { stepRest, stepHover });
    }
  }

  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
