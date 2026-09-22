/**
 * Live check for sidebar swipe intent (run with: node apps/desktop/scripts/sidebar-swipe-live.mjs)
 *
 * `gesture.test.ts` proves the state machine. It cannot prove the sidebar, because between the two
 * sit `bounds()` — which has to report a lone space as walled on both sides — and the transform
 * SpaceSwiper writes from the result. Either could be wrong with every unit test green.
 *
 * So this reads the track's real matrix while wheel events land on the real sidebar. Every claim is
 * paired with its control: a lone space that does not move proves nothing unless the SAME gesture
 * moves two spaces, and ignored jitter proves nothing unless a deliberate swipe is honoured.
 *
 * This drives the DOM wheel path. The native helper only takes over once a real trackpad streams to
 * it, which no headless run can produce — but both routes reach `wheel()` on the same tracker, and
 * the describe.each in gesture.test.ts covers the phase-armed route.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-swipe-live-"));
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
  await c.send("Input.enable").catch(() => {});

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

  /** The swiper's centre, in viewport coordinates — where the wheel events have to land. */
  const at = async () => evalIn(c, `(() => {
    const r = document.querySelector('.swiper').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

  /** The track's own translateX in px, with the resting `-index * 100%` taken back out. What is left
   *  is the gesture's displacement and nothing else, so one number compares across page counts. The
   *  page width comes from a page, not the track: the track is as wide as all of them together. */
  const displacement = async () => evalIn(c, `(() => {
    const track = document.querySelector('.swiper-track');
    const m = new DOMMatrix(getComputedStyle(track).transform);
    const page = document.querySelector('.space-page').getBoundingClientRect().width;
    const index = [...track.children].findIndex(el => !el.hasAttribute('inert'));
    return +(m.m41 + Math.max(0, index) * page).toFixed(2);
  })()`);

  /** A gesture releases 340ms after its last delta and then eases home for another 220ms. Sampling
   *  before that finishes reads the PREVIOUS gesture — which is what made a jitter run that never
   *  moved anything report a displacement of -1.17px. Wait for rest, do not guess a duration. */
  const atRest = () => until(async () => (await displacement()) === 0, 4000, "track at rest");

  /** One gesture, as a run of wheel events, sampling the displacement at its furthest point. The
   *  tracker settles on a quiet gap, so the reading has to be taken while the run is still going. */
  const swipe = async (dx, dy, steps = 6) => {
    await atRest();
    const { x, y } = await at();
    let peak = 0;
    for (let i = 0; i < steps; i++) {
      await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, pointerType: "mouse" });
      await sleep(16);
      const d = await displacement();
      if (Math.abs(d) > Math.abs(peak)) peak = d;
    }
    return peak;
  };

  const spaceCount = () => evalIn(c, `document.querySelectorAll('.space-page').length`);
  check("starts on a single space", (await spaceCount()) === 1, { spaces: await spaceCount() });

  const loneDeliberate = await swipe(24, 0);
  const loneJitter = await swipe(5, 5);
  check("a lone space does not move under a deliberate swipe", loneDeliberate === 0, { displacement: loneDeliberate });
  check("a lone space does not move under diagonal jitter", loneJitter === 0, { displacement: loneJitter });

  // The control. Without a second space every reading above is zero for want of anything to swipe,
  // and a sidebar that never moved at all would pass the two checks the fix is supposed to earn.
  await evalIn(c, `(() => { document.querySelector('button[aria-label="New space"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('input[aria-label="Space name"]')`), 8000, "new space sheet");
  await evalIn(c, `(() => {
    const input = document.querySelector('input[aria-label="Space name"]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Second'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(async () => (await spaceCount()) === 2, 10000, "second space");

  const pairDeliberate = await swipe(24, 0);
  const pairJitter = await swipe(5, 5);
  const pairCreep = await swipe(2, 0, 2);
  check("two spaces still follow a deliberate swipe", Math.abs(pairDeliberate) >= 20, { displacement: pairDeliberate });
  check("two spaces ignore diagonal jitter", pairJitter === 0, { displacement: pairJitter });
  check("two spaces ignore horizontal creep under the intent threshold", pairCreep === 0, { displacement: pairCreep });

  console.log("displacements:", JSON.stringify({ loneDeliberate, loneJitter, pairDeliberate, pairJitter, pairCreep }));
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
