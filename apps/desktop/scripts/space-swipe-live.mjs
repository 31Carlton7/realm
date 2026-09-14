/**
 * Live check for the space swipe's feel (run with: node apps/desktop/scripts/space-swipe-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME, makes a second space, and drives the sidebar with
 * wheel events while recording the track's transform on every frame. Everything asserted here is
 * about MOTION, and none of it is visible to the suite: jsdom has no frames, no compositor and no
 * clock that a spring can be read against.
 *
 * The four claims, each of which was false while the endgame was a CSS transition:
 *
 *   1. A committed swipe is animated — the track passes through intermediate positions — and it
 *      lands EXACTLY on the new page, with no residue left in the transform.
 *   2. No CSS transition is ever set on the track. A transition under a spring is two animations
 *      fighting for one property, and the loser is whichever wrote last.
 *   3. A harder throw arrives sooner. That is the velocity handoff: the animation continues at the
 *      speed the fingers left, rather than starting from rest at a fixed duration.
 *   4. A page can be caught mid-flight: a drag during the animation continues from where the page
 *      IS, without snapping back to its base first.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9393), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8957);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-space-swipe-"));
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

/** Record the track's own inline transform every frame, for `ms`. The INLINE value, not the computed
 *  matrix: the component writes displacement in px on top of a percentage base, and the pair is what
 *  says whether the page is mid-flight or resting. */
const RECORD = (ms) => `(async () => {
  const el = document.querySelector('.swiper-track');
  const out = [];
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const t = performance.now() - t0;
      out.push([+t.toFixed(1), el.style.transform, el.style.transition]);
      if (t < ${ms}) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  return out;
})()`;

/** The displacement in px from whichever page the track is resting on. 0 means it has landed. */
const displacement = (transform) => {
  const m = /\+ (-?[\d.]+)px/.exec(transform ?? "");
  return m ? Number(m[1]) : 0;
};

/** Two-finger horizontal deltas over the sidebar, as the DOM sees them. The native ScrollPhase
 *  helper reads the window server and cannot be synthesized, so this drives the wheel path — the
 *  same tracker, the same spring, one fewer source of finger-lift. */
async function swipe(c, { dx, steps, gapMs, x = 140, y = 400 }) {
  for (let i = 0; i < steps; i++) {
    await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: 0, pointerType: "mouse" });
    if (gapMs) await sleep(gapMs);
  }
}

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

  // A swipe needs somewhere to go. Two spaces is a track with one move in it, which is all four
  // claims below need — and it is the shape a new user actually has.
  await evalIn(c, `(() => { document.querySelector('[aria-label="New space"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.sheet input')`), 10000, "the new-space sheet");
  await evalIn(c, `(() => {
    const input = document.querySelector('.sheet input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Second'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.space-page').length >= 2`), 15000, "a second page");
  // Land on the first space, so there is a page to the right to swipe to.
  await evalIn(c, `(() => { document.querySelectorAll('.strip-space')[0].click(); return true; })()`);
  await sleep(600);

  const start = await evalIn(c, `document.querySelector('.swiper-track').style.transform`);
  check("the track is resting on the first page", start === "translateX(0%)", { start });

  // ── 1 & 2. A committed swipe animates, lands exactly, and never uses a transition ────────
  const rec = evalIn(c, RECORD(1600));
  await sleep(60);
  await swipe(c, { dx: 26, steps: 6, gapMs: 12 });
  const frames = await rec;
  const moved = frames.filter((f) => displacement(f[1]) !== 0);
  const last = frames.at(-1);

  check("the swipe animates rather than cutting to the new page", moved.length >= 6,
    { animatedFrames: moved.length, sample: moved.slice(0, 3).map((f) => f[1]) });
  check("and it lands exactly on the page, with nothing left over", last[1] === "translateX(-100%)", { last: last[1] });
  /* THE MUTANT this catches: keep the old `transform 300ms cubic-bezier(...)` on the element. Every
     check above still passes — it animates and it lands — and the two mechanisms then take turns
     writing the same property, which is the stutter that started this. */
  check("no CSS transition is ever set on the track", frames.every((f) => !f[2]),
    { transitions: [...new Set(frames.map((f) => f[2]))] });

  /* The motion is monotone: a pager may not overshoot, because past the target is the edge of the
     page AFTER the one you asked for. Read off the recording rather than argued from the damping. */
  const path0 = moved.map((f) => displacement(f[1]));
  check("it never overshoots the page it landed on", Math.min(...path0) >= -1, { min: Math.min(...path0) });

  // ── 3. A harder throw arrives sooner ─────────────────────────────────────────────────────
  const settleTime = async (dx, steps, gapMs) => {
    await evalIn(c, `(() => { document.querySelectorAll('.strip-space')[0].click(); return true; })()`);
    await sleep(700);
    const r = evalIn(c, RECORD(1600));
    await sleep(60);
    await swipe(c, { dx, steps, gapMs });
    const fs2 = await r;
    const first = fs2.findIndex((f) => displacement(f[1]) !== 0);
    const landed = fs2.findIndex((f, i) => i > first && first >= 0 && displacement(f[1]) === 0 && f[1] === "translateX(-100%)");
    return landed < 0 ? Infinity : fs2[landed][0] - fs2[first][0];
  };
  const hard = await settleTime(60, 4, 8);
  const gentle = await settleTime(20, 8, 34);
  check("a harder throw lands sooner than a gentle push — the velocity is handed to the spring",
    hard < gentle, { hardMs: Math.round(hard), gentleMs: Math.round(gentle) });

  // ── 4. Catchable mid-flight ──────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelectorAll('.strip-space')[0].click(); return true; })()`);
  await sleep(700);
  await swipe(c, { dx: 40, steps: 3, gapMs: 10 });
  await sleep(90); // …and grab it while it is still flying
  const before = displacement(await evalIn(c, `document.querySelector('.swiper-track').style.transform`));
  await swipe(c, { dx: -30, steps: 1 });
  await sleep(40);
  const after = displacement(await evalIn(c, `document.querySelector('.swiper-track').style.transform`));
  check("a page in flight can be grabbed, and the drag continues from where it is",
    before !== 0 && after > before - 5, { before: Math.round(before), after: Math.round(after) });

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
