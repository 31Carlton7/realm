/**
 * Live check for §6's popover exit (run with: node apps/desktop/scripts/popover-exit-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves the things an exit animation can only be
 * wrong about at runtime. jsdom can see that `data-closing` is set and that the node eventually
 * goes; it cannot see any of these:
 *
 *   1. The exit actually RUNS. `rl-menu-out` is a compositor animation on a portalled node — jsdom
 *      has no animation clock, so only `getAnimations()` on a real document can say the fade is
 *      playing rather than the mark being set over nothing.
 *   2. A closing menu is not in the way. It is still painted, so the question is whether the app
 *      behind it can be reached: `elementFromPoint` through the middle of the fading surface has to
 *      land on the app, not on the menu. jsdom has no hit-testing at all.
 *   3. It is FROZEN where it was dismissed. The hook stops re-placing the moment the exit starts;
 *      a surface that re-measured mid-fade — against an anchor its own action had moved, or against
 *      no anchor at all — falls back to the window margin and fades from the wrong place. jsdom
 *      reports every rect as zero, so only a real window can tell "did not move" from "never had a
 *      position".
 *   4. Nothing leaks. The failure mode this whole feature risks is a popover that stays in the DOM
 *      after it has finished going: invisible in a screenshot, and fatal to everything under it.
 *      Checked after a settle AND across ten open/close cycles faster than the exit runs.
 *   5. prefers-reduced-motion skips the exit rather than running it invisibly. The global
 *      `animation: none !important` would otherwise leave a fully painted, inert menu sitting there
 *      for the length of an exit nobody asked to see — the opposite of the preference.
 *
 * Each measurement is paired with a mutant that reproduces the bug it pins, so a check that has
 * quietly stopped measuring anything fails instead of passing.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9341), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8907);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-popover-exit-"));
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

/** A real press, not `element.click()`. The whole dismissal model turns on pointerdown arriving
 *  before click — the hook commits a running exit on the first and the trigger reopens on the
 *  second — so a synthetic click would exercise a sequence no pointer can produce. */
async function press(c, selector) {
  const box = await evalIn(c, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  return box;
}

const escape = (c) => c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

/** Everything worth knowing about a menu in one round trip — sampling these separately would let
 *  the exit advance between them and turn one moment into three. */
const SNAPSHOT = `(() => {
  const m = document.querySelector('.menu');
  if (!m) return { count: document.querySelectorAll('.menu').length };
  const r = m.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return {
    count: document.querySelectorAll('.menu').length,
    closing: m.hasAttribute('data-closing'),
    inert: m.hasAttribute('inert'),
    pointerEvents: getComputedStyle(m).pointerEvents,
    animations: m.getAnimations().map((a) => a.animationName),
    opacity: Number(getComputedStyle(m).opacity),
    rect: { x: Math.round(r.x), y: Math.round(r.y) },
    hitInsideMenu: !!(hit && m.contains(hit)),
    holdsFocus: m.contains(document.activeElement),
    focusOnTrigger: document.activeElement?.getAttribute('aria-label')?.startsWith('Pane menu') ?? false,
  };
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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  const DOTS = '.panel-bar button[aria-label^="Pane menu"]';
  await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(DOTS)})`), 15000, "the pane's ⋯ button");

  /* ── 1. The exit runs, and is out of the way while it does ───────────────────────────────── */
  await press(c, DOTS);
  await until(() => evalIn(c, `!!document.querySelector('.menu')`), 5000, "menu open");
  await sleep(250); // let the ENTER finish, so what we sample next is unambiguously the exit
  await escape(c);
  const mid = await evalIn(c, SNAPSHOT);
  check("Escape starts the exit rather than unmounting: the menu is still there, marked closing", mid.closing === true, mid);
  check("and the exit is genuinely playing — rl-menu-out, on the compositor", mid.animations?.includes("rl-menu-out"), mid.animations);
  check("a closing menu is inert and pointer-dead", mid.inert === true && mid.pointerEvents === "none", { inert: mid.inert, pointerEvents: mid.pointerEvents });
  // The one that matters: the app behind a fading menu has to be reachable. `pointer-events: none`
  // and `inert` are both claims about hit-testing, and this is the only way to read the answer.
  check("MUTANT-CATCHER: a click through the middle of the fading menu lands on the app, not on it",
    mid.hitInsideMenu === false, { hit: mid.hitInsideMenu });
  check("focus goes home with the gesture, not with the unmount",
    mid.holdsFocus === false && mid.focusOnTrigger === true, { holdsFocus: mid.holdsFocus, onTrigger: mid.focusOnTrigger });

  const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1200, height: 300, scale: 2 } });
  const shotOut = path.join(os.tmpdir(), "realm-popover-exit.png");
  fs.writeFileSync(shotOut, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT mid-exit ${shotOut}`);

  await sleep(400);
  const after = await evalIn(c, SNAPSHOT);
  check("and then it is really gone — no node left behind", after.count === 0, after);
  // Without this the check above would pass on a page that had stopped rendering menus entirely.
  const seeded = await evalIn(c, `(() => {
    const d = document.createElement('div'); d.className = 'menu'; d.dataset.seeded = '1';
    document.body.appendChild(d);
    const n = document.querySelectorAll('.menu').length;
    d.remove();
    return n; })()`);
  check("MUTANT: a leaked menu WOULD be seen — the same predicate counts a planted one", seeded === 1, { seeded });

  /* ── 2. A dismissed menu goes out from where it was ──────────────────────────────────────── */
  // §6's exit is opacity and scale, never travel, and the hook stops re-placing the moment the exit
  // begins — a menu that re-measured against an anchor its own action had removed would fall back to
  // the window margin and fade from the corner instead of from the control it belongs to.
  // The LAID-OUT position, not the painted box: the exit scales the surface, and a bounding rect
  // shrinking around its transform-origin would read as travel. `left`/`top` are what placement
  // writes and what freezing protects.
  const RECT = `(() => { const m = document.querySelector('.menu');
    return m ? { left: m.style.left, top: m.style.top } : null; })()`;
  await press(c, DOTS);
  await until(() => evalIn(c, `!!document.querySelector('.menu')`), 5000, "menu open (2)");
  await sleep(250);
  const before = await evalIn(c, RECT);
  await escape(c);
  const early = await evalIn(c, RECT);
  await sleep(60);
  const late = await evalIn(c, RECT);
  check("the menu does not travel on its way out — placed once, then left alone",
    !!before.left && early?.left === before.left && early?.top === before.top
      && late?.left === before.left && late?.top === before.top, { before, early, late });
  await evalIn(c, `(() => { const m = document.querySelector('.menu'); if (m) m.style.left = '0px'; return true; })()`);
  const moved = await evalIn(c, RECT);
  check("MUTANT-CATCHER: and a menu that DID move would read as moved", moved?.left === "0px", { before, moved });
  await sleep(400);
  check("the moved menu still left when its exit was up", (await evalIn(c, SNAPSHOT)).count === 0);

  /* ── 3. A parent that unmounts mid-exit takes the surface with it ─────────────────────────── */
  // "Close" removes the pane the menu hangs off, PanelBar and all. The exit's timer has to die with
  // it: firing afterwards would drive a parent that no longer exists.
  await press(c, DOTS);
  await until(() => evalIn(c, `!!document.querySelector('.menu')`), 5000, "menu open (3)");
  await sleep(250);
  await evalIn(c, `(() => {
    const it = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim().startsWith('Close'));
    it.click(); return true; })()`);
  await sleep(400);
  check("the pane closed and its menu went with it", (await evalIn(c, SNAPSHOT)).count === 0);

  /* ── 4. Ten cycles faster than the exit: no pile-up, nothing left ─────────────────────────── */
  await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(DOTS)})`), 15000, "a pane with a ⋯ again");
  let worst = 0;
  for (let i = 0; i < 10; i++) {
    await press(c, DOTS);
    await sleep(30);
    await escape(c);
    await sleep(30);
    worst = Math.max(worst, await evalIn(c, `document.querySelectorAll('.menu').length`));
  }
  check("opening and dismissing faster than the exit never stacks two menus", worst <= 1, { worst });
  await sleep(500);
  check("and the DOM is empty of menus once it settles", (await evalIn(c, `document.querySelectorAll('.menu').length`)) === 0);

  /* ── 5. prefers-reduced-motion has no exit at all ─────────────────────────────────────────── */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await press(c, DOTS);
  await until(() => evalIn(c, `!!document.querySelector('.menu')`), 5000, "menu open (reduced)");
  await sleep(250);
  await escape(c);
  const reduced = await evalIn(c, SNAPSHOT);
  // Not "instant but still mounted": the preference must skip the hold, not run it invisibly.
  check("under reduced motion the menu is gone on the keystroke — no closing frame to skip",
    reduced.count === 0, reduced);
  await c.send("Emulation.setEmulatedMedia", { features: [] });

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
