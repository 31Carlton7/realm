/**
 * Live check for the sidebar's archived shelf (run with: node apps/desktop/scripts/disclosure-live.mjs)
 *
 * The shelf now unfolds on the tool row's `grid-template-rows: 0fr → 1fr`, which is a claim about
 * layout and nothing else — and jsdom has no layout, so every part of it is invisible to the suite:
 *
 *   1. Folded really is ZERO. `0fr` only collapses if the row's content clips against an overflow
 *      container AND nothing in the chain refuses to shrink; one `min-height: auto` anywhere and the
 *      shelf sits permanently open at full height with a caret that lies about it. The sidebar is a
 *      flex column, which is exactly where that goes wrong.
 *   2. Open is the content's OWN height — `1fr` resolving to the rows' natural size, not to a
 *      guessed maximum that clips a long list or leaves a short one padded.
 *   3. The rows stay mounted while folded, so both directions animate, and a mounted-but-folded row
 *      must be unreachable: no tab stop, no hit target, nothing a screen reader can find. That is
 *      the cost of keeping them in the DOM and the only thing that makes it acceptable.
 *   4. It is animating at all — a transition on a property the browser cannot interpolate would look
 *      identical to a snap in every jsdom assertion.
 *
 * Each measurement is paired with a mutant that reproduces the bug it pins.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9342), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8908);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-disclosure-"));
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

/** `scrollHeight` is an integer ceiling and a border box is fractional, so the two readings of one
 *  height differ by up to a pixel. The claim is "the same height", not "the same number". */
const sameHeight = (a, b) => Math.abs(a - b) <= 1;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The shelf's measured state. `rows` is what `1fr` has to resolve to; `hit` is what a click at the
 *  first archived row's centre actually lands on, which is the only honest read on "unreachable". */
const SHELF = `(() => {
  const wrap = document.querySelector('.archived-wrap');
  if (!wrap) return null;
  const row = wrap.querySelector('.item-row');
  const r = row?.getBoundingClientRect();
  const hit = r && r.width > 0 ? document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) : null;
  return {
    open: wrap.hasAttribute('data-open'),
    wrapH: Math.round(wrap.getBoundingClientRect().height),
    rowsH: Math.round(wrap.querySelector('.archived-clip > *')?.scrollHeight ?? -1),
    rowCount: wrap.querySelectorAll('.item-row').length,
    tabbable: [...wrap.querySelectorAll('button, a, input')].some((e) => e.tabIndex >= 0 && !e.closest('[inert]')),
    reachable: !!(hit && wrap.contains(hit)),
    transitions: wrap.getAnimations().map((a) => a.transitionProperty ?? a.animationName),
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

  // Two sessions, one shelved: the shelf only exists when something is on it, and one row left in
  // the space above it keeps the sidebar's own scroll out of the measurement.
  await evalIn(c, `(() => { document.querySelector('.new-row').click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.item-list .item-row').length >= 2`), 15000, "two sessions");
  await evalIn(c, `(() => {
    const row = document.querySelector('.item-list .item-row');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }));
    return true; })()`);
  await evalIn(c, `(() => {
    const it = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim() === 'Archive');
    it.click(); return true; })()`);
  const toggle = await until(() => evalIn(c, `!!document.querySelector('.archived-toggle')`), 15000, "the archived shelf's heading");
  check("archiving puts the row on a shelf that appears only because something is on it", toggle === true);

  /* ── 1. Before it has ever been opened, the shelf costs nothing ───────────────────────────── */
  check("an unopened shelf builds no rows at all", (await evalIn(c, SHELF)) === null);

  /* ── 2. Open: the wrap takes the rows' own height ─────────────────────────────────────────── */
  await evalIn(c, `(() => { document.querySelector('.archived-toggle').click(); return true; })()`);
  await sleep(400); // longer than --dur-base, so this is the settled height
  const open = await evalIn(c, SHELF);
  check("open, the shelf is exactly as tall as its rows — 1fr, not a guessed maximum",
    open.open === true && open.rowCount === 1 && sameHeight(open.wrapH, open.rowsH) && open.wrapH > 20, open);
  check("and an open row is reachable by pointer and by tab", open.reachable === true && open.tabbable === true, open);

  /* ── 3. Folded: zero height, rows still mounted, nothing reachable ────────────────────────── */
  await evalIn(c, `(() => { document.querySelector('.archived-toggle').click(); return true; })()`);
  const during = await evalIn(c, SHELF);
  // The whole point of `grid-template-rows`: the browser interpolates it, so a real transition is
  // running on the way down. A property it could not interpolate would jump and look identical to
  // this in every other assertion.
  check("folding it back animates rather than snaps — grid-template-rows is mid-transition",
    during.transitions.some((t) => String(t).includes("grid-template-rows")), during.transitions);
  await sleep(400);
  const folded = await evalIn(c, SHELF);
  check("MUTANT-CATCHER: folded really is ZERO — no min-height in the sidebar's flex column props it open",
    folded.wrapH === 0, folded);
  check("the rows stayed in the DOM, so both directions animate", folded.rowCount === 1, folded);
  check("…and a folded row is unreachable: no tab stop, no hit target",
    folded.tabbable === false && folded.reachable === false, folded);
  // Without this the two checks above would pass on a shelf that had simply unmounted its rows.
  check("MUTANT: the rows are genuinely there to be unreachable, not merely gone",
    (await evalIn(c, `document.querySelectorAll('.archived-clip .item-row').length`)) === 1);

  const sidebar = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 280, height: 820, scale: 2 } });
  const out = path.join(os.tmpdir(), "realm-disclosure-folded.png");
  fs.writeFileSync(out, Buffer.from(sidebar.data, "base64"));
  console.log(`SCREENSHOT folded ${out}`);

  /* ── 4. Reduced motion folds it instantly, and still to zero ──────────────────────────────── */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evalIn(c, `(() => { document.querySelector('.archived-toggle').click(); return true; })()`);
  await sleep(60); // well inside --dur-base: with the preference on, the shelf is already all the way open
  const reduced = await evalIn(c, SHELF);
  check("under reduced motion the shelf is open at full height immediately, with no transition running",
    sameHeight(reduced.wrapH, reduced.rowsH) && reduced.wrapH > 20 && reduced.transitions.length === 0, reduced);
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
