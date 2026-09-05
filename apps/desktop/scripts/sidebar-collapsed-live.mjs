/**
 * Live check for the collapsed sidebar's window chrome (run with: node apps/desktop/scripts/sidebar-collapsed-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and measures the thing the collapse was changed for:
 * with the sidebar collapsed there is no rail, the content starts at the very top of the window, and
 * the macOS traffic lights sit inline with the first pane's bar without landing on anything.
 *
 * All of it is layout, so none of it is visible to jsdom — a shell test can only see that a div with
 * the right class exists, not that the button inside it is reachable or that the bar underneath left
 * room for three OS-drawn circles the web contents cannot even paint.
 *
 * The traffic lights are drawn by the window server, above the web view, so a screenshot of the page
 * does not contain them. Their box is therefore taken from the placement main asks for
 * (trafficLightPosition x:12, y:14) plus the fixed size AppKit gives them, and asserted against — the
 * comment on LIGHTS is the contract, and main/index.ts carries its other half.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9340), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8906);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-collapsed-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The lights as AppKit draws them for `titleBarStyle: "hiddenInset"`: three 12px circles on a 20px
 *  pitch, with main placing the group's top-left at (12, 14). So they occupy x 12..64 and y 14..26.
 *  `right` is rounded up to 66 for the half-pixel the shadow adds. If main ever moves them, this
 *  number and the 76px of padding on .sb-corner move together. */
const LIGHTS = { left: 12, top: 14, right: 66, bottom: 30 };

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

const collapse = (c) => evalIn(c, `(() => { document.querySelector('.sb-toggle').click(); return true; })()`);

/** Every laid-out fact the checks below read, in one round trip. */
const PROBE = `(() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const bars = [...document.querySelectorAll('.panel')].map((p) => {
    const bar = p.querySelector(':scope > .panel-bar');
    if (!bar) return null;
    const first = bar.firstElementChild?.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    return { first: p.hasAttribute('data-first-leaf'), barLeft: Math.round(r.left), barTop: Math.round(r.top),
             contentLeft: first ? Math.round(first.left) : null, padLeft: Math.round(parseFloat(getComputedStyle(bar).paddingLeft)) };
  }).filter(Boolean);
  return {
    sidebar: box('.sidebar'), corner: box('.sb-corner'), main: box('.main'),
    panehost: box('.panehost'), groupBar: box('.group-bar'), toggle: box('.sb-toggle'),
    groupBarPadLeft: document.querySelector('.group-bar') ? Math.round(parseFloat(getComputedStyle(document.querySelector('.group-bar')).paddingLeft)) : null,
    bars,
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  const open = await evalIn(c, PROBE);
  check("with the sidebar open the lights sit in its 40px head row, clear of any pane",
    open.sidebar?.w === 280 && open.main.left === 280 && open.toggle.top >= 0 && open.toggle.bottom <= 40,
    { sidebarW: open.sidebar?.w, mainLeft: open.main.left, toggle: open.toggle });

  /* Two panes, both holding a session, made the way a user makes them — splitting alone leaves the
     new leaf EMPTY, and an empty leaf renders no bar at all, so there would be nothing to measure.
     Done while the sidebar is open because the sidebar is the only way to fill that leaf. */
  await evalIn(c, `(() => { document.querySelector('.new-row').click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.space-body .item').length >= 2`), 15000, "a second session");
  await evalIn(c, `(() => {
    const inline = document.querySelector('.panel-bar button[aria-label^="Split"][aria-label$="right"]');
    if (inline) { inline.click(); return true; }
    document.querySelector('.panel-bar button[aria-label^="Pane menu"]').click();
    return true; })()`);
  await evalIn(c, `(() => {
    const it = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.startsWith('Split right'));
    if (it) it.click();
    return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.panehost .panel').length === 2`), 15000, "two panes");
  await evalIn(c, `(() => {
    const row = [...document.querySelectorAll('.item-list .item-row')].find((r) => !r.querySelector('.item-glyph'));
    row.click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.panehost .panel-bar').length === 2`), 15000, "two pane bars");
  await sleep(300);

  /* ── Collapsed: no rail, no band of height, content at y=0 ───────────────────────────────── */
  await collapse(c);
  await until(() => evalIn(c, `!!document.querySelector('.sb-corner')`), 5000, "the corner");
  await sleep(300);
  const one = await evalIn(c, PROBE);

  check("collapsed, the sidebar is gone rather than narrowed", one.sidebar === null, { sidebar: one.sidebar });
  // The regression this replaces: a 38px full-width strip above the content. The panes now start at
  // the window's own top edge, so collapsing costs no height at all.
  check("collapsing costs no height — the pane host still starts at the top of the window",
    one.panehost.top === 0 && one.main.top === 0 && one.main.left === 0,
    { panehostTop: one.panehost.top, mainTop: one.main.top, mainLeft: one.main.left });
  const bar = one.bars.find((b) => b.first);
  check("the leftmost pane's bar is the strip under the lights, sitting at the very top of the window",
    !!bar && bar.barTop === 0 && bar.barLeft === 0, one.bars);

  /* ── The lights land on that bar without hitting anything ────────────────────────────────── */
  check("the first pane's bar leaves the lights their whole width before its own content starts",
    bar.contentLeft >= LIGHTS.right, { contentLeft: bar.contentLeft, lightsRight: LIGHTS.right, padLeft: bar.padLeft });
  check("the corner clears the lights before the toggle, so the two never overlap",
    one.toggle.left >= LIGHTS.right, { toggleLeft: one.toggle.left, lightsRight: LIGHTS.right });
  check("the toggle still sits in the same 40px band it occupied inside the sidebar",
    one.toggle.top >= 0 && one.toggle.bottom <= 40, one.toggle);
  check("the toggle stops short of the bar's content, so the corner and the bar do not fight for a row",
    one.toggle.right <= bar.contentLeft, { toggleRight: one.toggle.right, contentLeft: bar.contentLeft });

  /* ── The toggle is actually reachable, not buried under the pane ─────────────────────────── */
  // Panes are positioned elements, so a corner rendered before .main would be painted over by the
  // first pane's bar and hit-test to it. This is the check that catches that.
  const hit = await evalIn(c, `(() => {
    const t = document.querySelector('.sb-toggle').getBoundingClientRect();
    const el = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    return { tag: el?.tagName, cls: el?.className, inToggle: !!el?.closest('.sb-toggle') };
  })()`);
  check("a click at the toggle's centre lands on the toggle, not on the pane behind it", hit.inToggle, hit);

  /* ── Only the FIRST pane reserves the corner ─────────────────────────────────────────────── */
  const otherBars = one.bars.filter((b) => !b.first);
  check("in a split only the leftmost pane reserves the corner — every other bar keeps its normal rail",
    otherBars.length > 0 && otherBars.every((b) => b.padLeft <= 20),
    { first: bar.padLeft, others: otherBars.map((b) => b.padLeft) });

  /* ── With a group bar on top, IT takes the corner and the pane bar gives it back ─────────── */
  // The group bar renders above the pane host, so with two groups it is the strip the lights land on.
  // Reaching it means going back through the sidebar, which is the only place groups are made.
  await collapse(c);
  await until(() => evalIn(c, `!!document.querySelector('.sidebar')`), 5000, "the sidebar back");
  await evalIn(c, `(() => { document.querySelector('.group-new').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.group-bar')`), 15000, "a second pane group");
  await collapse(c);
  await until(() => evalIn(c, `!!document.querySelector('.sb-corner')`), 5000, "the corner again");
  await sleep(400);
  const grouped = await evalIn(c, PROBE);
  check("the group bar takes the lights when it is on top, and takes the 40px with them",
    grouped.groupBar?.top === 0 && grouped.groupBarPadLeft >= LIGHTS.right && grouped.groupBar.h >= 40,
    { top: grouped.groupBar?.top, padLeft: grouped.groupBarPadLeft, h: grouped.groupBar?.h });
  check("…and the pane bar underneath is no longer indented, because it is no longer under them",
    grouped.bars.every((b) => b.padLeft <= 20), grouped.bars.map((b) => ({ first: b.first, padLeft: b.padLeft })));

  /* ── And the way back ────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `(() => { document.elementFromPoint(...(() => { const t = document.querySelector('.sb-toggle').getBoundingClientRect(); return [t.left + t.width / 2, t.top + t.height / 2]; })()).closest('.sb-toggle').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.sidebar')`), 5000, "the sidebar restored");
  const back = await evalIn(c, PROBE);
  check("clicking the corner's toggle brings the sidebar back", back.sidebar?.w === 280 && back.corner === null,
    { sidebarW: back.sidebar?.w, corner: back.corner });

  await collapse(c);
  await sleep(400);
  const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 700, height: 120, scale: 2 } });
  const out = path.join(os.tmpdir(), "realm-sidebar-collapsed-top.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT top ${out}`);

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
