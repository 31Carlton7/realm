/**
 * Live check for the Mac-idiom pass (run with: node apps/desktop/scripts/native-feel-live.mjs)
 *
 * Every claim is about the real renderer, which jsdom cannot stand in for:
 *
 *  - `oklch(from …)` relative colour is what greys the accent in a background window. A Chromium that
 *    did not parse it would drop the declaration and leave the window blue, and the stylesheet test
 *    would still pass.
 *  - A press is a fill painted on the mouse-down frame. `CSS.forcePseudoState` is the renderer's own
 *    :active, so the computed fill and the absence of any scale are read off the real cascade.
 *  - The cursor, the selection lock and the spring's `linear()` are computed values, not source text.
 *  - The focus ring's halo is an animation that only runs when a key moved focus.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-native-feel-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-native-feel-live-"));
let electron = null;
const menus = [];
const focusReports = [];
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

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip ? { clip: { ...clip, scale: 2 } } : {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
  return file;
}

/** A named element's box, or null. Used for both the geometry checks and the screenshot clips. */
const boxOf = (c, sel) => evalIn(c, `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  const wrapper = path.join(scratch, "wrapper.mjs");
  /* The OS menu is stood in for, not shown: it cannot be clicked over CDP, and a real one would open
     over whatever the person running this is doing. The stand-in reports exactly what main built and
     answers the way NSMenu does — the pick lands, then the close. stdin drives the rest: which label
     to pick, a key-window report, and a question about the window's real focus. */
  fs.writeFileSync(wrapper, [
    'import { app, BrowserWindow, Menu } from "electron";',
    'import readline from "node:readline";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "let pickLabel = null;",
    "Menu.prototype.popup = function (opts = {}) {",
    "  const items = this.items.map((i) => ({ label: i.label, role: i.role ?? null, type: i.type, enabled: i.enabled, checked: i.checked, accelerator: i.accelerator ?? null, icon: !!i.icon }));",
    "  console.log('LIVE_MENU ' + JSON.stringify({ items, x: opts.x ?? null, y: opts.y ?? null }));",
    "  const idx = pickLabel === null ? -1 : this.items.findIndex((i) => i.label === pickLabel);",
    "  setTimeout(() => { if (idx >= 0) this.items[idx].click(); opts.callback?.(); }, 30);",
    "};",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const [cmd, arg] = line.split(' ');",
    "  if (cmd === 'pick') pickLabel = arg === '-' ? null : decodeURIComponent(arg);",
    "  if (cmd === 'key') for (const w of BrowserWindow.getAllWindows()) w.webContents.send('window:key', arg === 'true');",
    "  if (cmd === 'focused') console.log('LIVE_FOCUSED ' + JSON.stringify(BrowserWindow.getAllWindows().map((w) => w.isFocused())));",
    "  if (cmd === 'phase') { const [phase, momentum] = arg.split('/'); for (const w of BrowserWindow.getAllWindows()) w.webContents.send('realm:scroll-phase', { phase, momentum, dx: 0, dy: 0, ts: Date.now() / 1000 }); }",
    "});",
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
    stdio: ["pipe", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  let outBuf = "";
  electron.stdout.on("data", (d) => {
    process.stderr.write(`    [electron] ${d}`);
    outBuf += d.toString();
    for (let nl = outBuf.indexOf("\n"); nl !== -1; nl = outBuf.indexOf("\n")) {
      const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1);
      if (line.startsWith("LIVE_MENU ")) menus.push(JSON.parse(line.slice(10)));
      if (line.startsWith("LIVE_FOCUSED ")) focusReports.push(JSON.parse(line.slice(13)));
    }
  });
  const tell = (line) => electron.stdin.write(`${line}\n`);

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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await sleep(500);

  // ---- 0. the key-window state on arrival, before anything below writes the attribute by hand ----
  tell("focused");
  await until(() => focusReports.length > 0, 5000, "focus report");
  const focusedNow = focusReports.at(-1)[0];
  const inactiveNow = await evalIn(c, `document.documentElement.hasAttribute('data-window-inactive')`);
  check("the page agrees with the window about being key, from the first frame", inactiveNow === !focusedNow, { windowFocused: focusedNow, pageInactive: inactiveNow });


  const computed = (sel, prop) => evalIn(c, `(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    return e ? getComputedStyle(e)[${JSON.stringify(prop)}] : null; })()`);
  /* What a control is FILLED with. A painted control (\`.btn\` under the squircle worklet) spends its
     background on \`paint()\` and carries the colour in the registered \`--sq-fill\`, so its
     background-color reads transparent whatever state it is in. */
  const fillOf = (sel) => evalIn(c, `(() => {
    const cs = getComputedStyle(document.querySelector(${JSON.stringify(sel)}));
    return cs.backgroundImage.startsWith('paint(') ? cs.getPropertyValue('--sq-fill').trim() : cs.backgroundColor; })()`);
  /** Chroma of a computed colour, from the renderer's own conversion: paint it into a 1px canvas. */
  const chromaOf = (sel, prop) => evalIn(c, `(() => {
    const e = document.querySelector(${JSON.stringify(sel)}); const cs = getComputedStyle(e);
    const colour = cs.backgroundImage.startsWith('paint(') ? cs.getPropertyValue('--sq-fill').trim() : cs[${JSON.stringify(prop)}];
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, 1, 1);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    return { rgb: [r, gr, b], spread: Math.max(r, gr, b) - Math.min(r, gr, b) }; })()`);

  // A fixture row of the controls under test, appended to the live document so the real stylesheet
  // and the real theme resolve them.
  await evalIn(c, `(() => {
    const host = document.createElement('div'); host.id = 'native-fixture';
    host.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:9999;display:flex;gap:12px;align-items:center;padding:12px;background:var(--surface);border-radius:12px';
    host.innerHTML = '<button class="btn primary" id="nf-primary">Create</button>'
      + '<button class="btn" id="nf-btn">Cancel</button>'
      + '<button class="icon-btn" id="nf-icon" aria-label="x">×</button>'
      + '<input type="checkbox" class="checkbox" id="nf-check" checked>'
      + '<div class="menu" id="nf-menu" role="menu" style="position:static">menu</div>'
      + '<div class="sheet" id="nf-sheet" style="position:static;width:40px;height:20px"></div>';
    document.body.appendChild(host); return true; })()`);
  await sleep(400);

  // ---- 1. cursor and selection ----------------------------------------------------------------
  for (const sel of ["#nf-primary", "#nf-icon", ".sidebar button"])
    check(`${sel} points with the arrow`, (await computed(sel, "cursor")) === "default", await computed(sel, "cursor"));
  check("the sidebar does not select", (await computed(".sidebar", "userSelect")) === "none", await computed(".sidebar", "userSelect"));
  check("the composer field still selects", (await computed(".composer textarea", "userSelect")) === "text", await computed(".composer textarea", "userSelect"));

  // ---- 2. press: a fill, on the frame, never a scale --------------------------------------------
  const node = async (sel) => {
    const { root } = await c.send("DOM.getDocument", { depth: -1 });
    return (await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel })).nodeId;
  };
  await c.send("DOM.enable"); await c.send("CSS.enable");
  for (const sel of ["#nf-btn", "#nf-icon", "#nf-primary"]) {
    const rest = await fillOf(sel);
    // The press as press-tracking.ts marks it; section 5 drives the real pointer through it.
    await evalIn(c, `document.querySelector(${JSON.stringify(sel)}).setAttribute('data-press-tracking', ''); document.querySelector(${JSON.stringify(sel)}).setAttribute('data-pressed', ''); true`);
    await sleep(30);
    const pressed = { bg: await fillOf(sel), scale: await computed(sel, "scale"),
      transform: await computed(sel, "transform"), dur: await computed(sel, "transitionDuration") };
    await evalIn(c, `document.querySelector(${JSON.stringify(sel)}).removeAttribute('data-press-tracking'); document.querySelector(${JSON.stringify(sel)}).removeAttribute('data-pressed'); true`);
    check(`${sel} pressed changes fill`, pressed.bg !== rest, { rest, ...pressed });
    check(`${sel} pressed keeps its size`, pressed.scale === "none" && pressed.transform === "none", pressed);
    check(`${sel} pressed lands with no transition`, pressed.dur.split(",").every((d) => d.trim() === "0s"), pressed.dur);
  }

  // ---- 3. motion -------------------------------------------------------------------------------
  check("a menu has no entrance", (await computed("#nf-menu", "animationName")) === "none", await computed("#nf-menu", "animationName"));
  const sheetEase = await computed("#nf-sheet", "animationTimingFunction");
  check("a sheet arrives on the spring (linear() parsed)", sheetEase?.startsWith("linear("), sheetEase);

  await evalIn(c, `document.getElementById('nf-btn').focus({ focusVisible: true }); document.getElementById('nf-btn').blur(); true`);
  // A real Tab, so :focus-visible is the keyboard's and not a script's.
  await evalIn(c, `document.getElementById('nf-btn').focus(); true`);
  for (const type of ["keyDown", "keyUp"])
    await c.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await sleep(20);
  const ring = await evalIn(c, `(() => { const a = document.activeElement;
    return { id: a.id, cls: a.className, visible: a.matches(':focus-visible'), anims: a.getAnimations().map((x) => x.animationName) }; })()`);
  check("a keyboard focus ring draws in", ring.visible && ring.anims.includes("rl-focus-ring"), ring);

  // ---- 4. the window that is not key ----------------------------------------------------------
  // Pinned: the real window can lose focus mid-run (and does — the bridge then greys it for real).
  tell("key true"); await sleep(250);
  const activePrimary = await chromaOf("#nf-primary", "backgroundColor");
  const activeCheck = await chromaOf("#nf-check", "backgroundColor");
  await shoot(c, "01-key-window", { x: 0, y: 0, width: 1280, height: 860 });
  await evalIn(c, `document.documentElement.setAttribute('data-window-inactive', ''); true`);
  await sleep(400);
  const idlePrimary = await chromaOf("#nf-primary", "backgroundColor");
  const idleCheck = await chromaOf("#nf-check", "backgroundColor");
  console.log(`  primary fill: key ${JSON.stringify(activePrimary)} → not key ${JSON.stringify(idlePrimary)}`);
  check("the accent is coloured in the key window", activePrimary.spread > 40 && activeCheck.spread > 40, { activePrimary, activeCheck });
  check("the accent goes grey when the window is not key", idlePrimary.spread <= 3 && idleCheck.spread <= 3, { idlePrimary, idleCheck });
  /** WCAG contrast of the white label on a fill — the number the "same lightness" claim is about. */
  const onWhite = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return +(1.05 / (0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) + 0.05)).toFixed(2);
  };
  check("…and the white label reads exactly as well on it", Math.abs(onWhite(activePrimary.rgb) - onWhite(idlePrimary.rgb)) < 0.35,
    { key: onWhite(activePrimary.rgb), notKey: onWhite(idlePrimary.rgb) });
  await shoot(c, "02-not-key-window", { x: 0, y: 0, width: 1280, height: 860 });
  await evalIn(c, `document.documentElement.removeAttribute('data-window-inactive'); true`);

  // ---- 5. the press tracks the pointer, with real mouse events ---------------------------------
  const mouse = (type, x, y, buttons = 0, button = "none") => c.send("Input.dispatchMouseEvent",
    { type, x, y, buttons, button, clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0 });
  const nb = await boxOf(c, "#nf-btn");
  const at = { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 };
  const restFill = await fillOf("#nf-btn");
  await mouse("mouseMoved", at.x, at.y);
  await mouse("mousePressed", at.x, at.y, 1, "left"); await sleep(40);
  const downFill = await fillOf("#nf-btn");
  await mouse("mouseMoved", at.x, at.y - 240, 1); await sleep(40);
  const offFill = await fillOf("#nf-btn");
  await mouse("mouseMoved", at.x, at.y, 1); await sleep(40);
  const backFill = await fillOf("#nf-btn");
  await mouse("mouseMoved", at.x, at.y - 240, 1);
  await mouse("mouseReleased", at.x, at.y - 240, 0, "left");
  check("a held button lights under the pointer", downFill !== restFill, { restFill, downFill });
  check("…lets go the moment the pointer leaves it", offFill === restFill, { restFill, offFill });
  check("…and takes the highlight back on return", backFill === downFill, { downFill, backFill });

  // ---- 6. rows and the sidebar ------------------------------------------------------------------
  await evalIn(c, `(() => { const r = document.createElement('div'); r.className = 'palette-opt'; r.id = 'nf-row';
    r.setAttribute('role', 'option'); r.textContent = 'row'; document.getElementById('native-fixture').appendChild(r); return true; })()`);
  check("a list row has no fade in either direction", (await computed("#nf-row", "transitionDuration")).split(",").every((d) => d.trim() === "0s"),
    await computed("#nf-row", "transitionDuration"));
  const itemRest = await computed(".item", "backgroundColor");
  if (itemRest !== null) {
    const itemId = await node(".item");
    await c.send("CSS.forcePseudoState", { nodeId: itemId, forcedPseudoClasses: ["hover"] });
    const itemHover = await computed(".item", "backgroundColor");
    await c.send("CSS.forcePseudoState", { nodeId: itemId, forcedPseudoClasses: [] });
    check("a sidebar row does not light under the pointer", itemHover === itemRest, { itemRest, itemHover });
  } else console.log("  (no sidebar row on screen to hover)");

  // ---- 7. rubber-banding ------------------------------------------------------------------------
  const rubberSel = (await evalIn(c, `!!document.querySelector('.space-body')`)) ? ".space-body" : ".transcript";
  const rb = await boxOf(c, rubberSel);
  await evalIn(c, `document.querySelector(${JSON.stringify(rubberSel)}).scrollTop = 0; true`);
  const wheel = (dy) => c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rb.x + rb.w / 2, y: rb.y + 60, deltaX: 0, deltaY: dy });
  await evalIn(c, `window.__wheels = []; document.addEventListener('wheel', (e) => window.__wheels.push({
    t: e.target.className?.toString?.().slice(0, 40), dy: e.deltaY, mode: e.deltaMode, legacy: e.wheelDeltaY,
    scroller: !!e.target.closest?.('.space-body, .transcript') }), { capture: true, passive: true }); true`);
  // Fingers on the pad, as the phase helper reports them. CDP can only synthesise a mouse-style
  // wheel, and the phase stream is exactly what tells the page the deltas are a trackpad's.
  tell("phase began/none"); await sleep(100);
  for (let i = 0; i < 6; i++) { await wheel(-37); await sleep(16); }
  console.log(`  wheel events the page saw: ${JSON.stringify(await evalIn(c, "window.__wheels.slice(0, 2)"))}`);
  const stretched = await evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(rubberSel)});
    return { on: e.hasAttribute('data-rubber'), offset: parseFloat(e.style.getPropertyValue('--rubber') || '0'),
      childTranslate: e.firstElementChild ? getComputedStyle(e.firstElementChild).translate : null }; })()`);
  check(`${rubberSel} stretches past its top under a trackpad pull`, stretched.on && stretched.offset > 4 && stretched.offset < 120, stretched);
  tell("phase ended/none");
  await sleep(900);
  const settled = await evalIn(c, `document.querySelector(${JSON.stringify(rubberSel)}).hasAttribute('data-rubber')`);
  check("…and springs home once the pull stops", settled === false, settled);
  // A mouse wheel has no phases, and never stretches.
  for (let i = 0; i < 4; i++) { await wheel(-37); await sleep(16); }
  check("a mouse wheel's notch does not stretch it", !(await evalIn(c, `document.querySelector(${JSON.stringify(rubberSel)}).hasAttribute('data-rubber')`)));

  // ---- 8. menus are OS menus, through the real IPC ----------------------------------------------
  tell("pick -");
  const before = menus.length;
  const opened = await evalIn(c, `(() => { const b = document.querySelector('.panel-bar [aria-haspopup="menu"]'); if (!b) return false; b.click(); return true; })()`);
  if (opened) {
    await until(() => menus.length > before, 5000, "native pane menu");
    const m = menus.at(-1);
    console.log(`  pane menu as main built it: ${JSON.stringify(m.items.map((i) => i.type === "separator" ? "—" : `${i.label}${i.accelerator ? ` [${i.accelerator}]` : ""}${i.icon ? " (icon)" : ""}`))}`);
    check("the pane menu reached main with its rows", m.items.filter((i) => i.type !== "separator" && i.label).length >= 3, m.items.length);
    check("…carrying the row glyphs as images", m.items.some((i) => i.icon), m.items.map((i) => i.icon));
    check("…placed in window coordinates under its button", typeof m.x === "number" && m.y > 0, { x: m.x, y: m.y });
    check("no drawn menu appeared beside it", !(await evalIn(c, `!!document.querySelector('.menu:not(#nf-menu)')`)));
    await sleep(200);
    check("closing it hands the button back", (await evalIn(c, `document.querySelector('.panel-bar [aria-haspopup="menu"]').getAttribute('aria-expanded')`)) !== "true");
    const split = m.items.find((i) => i.enabled && /split/i.test(i.label ?? ""));
    if (split) {
      const panes = await evalIn(c, `document.querySelectorAll('.panel-bar').length`);
      tell(`pick ${encodeURIComponent(split.label)}`);
      await evalIn(c, `document.querySelector('.panel-bar [aria-haspopup="menu"]').click(); true`);
      await until(async () => (await evalIn(c, `document.querySelectorAll('.panel-bar').length`)) > panes, 5000, "split from the OS menu");
      check(`picking "${split.label}" in the OS menu runs it`, true);
      tell("pick -");
    }
  } else check("found a pane menu button to open", false);

  // ---- 9. the Edit menu on a right-click in a field ---------------------------------------------
  const ta = await boxOf(c, ".composer textarea");
  await evalIn(c, `(() => { const t = document.querySelector('.composer textarea'); t.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, 'teh draft'); t.dispatchEvent(new Event('input', { bubbles: true })); t.select(); return true; })()`);
  const beforeCtx = menus.length;
  await mouse("mouseMoved", ta.x + 20, ta.y + ta.h / 2);
  await mouse("mousePressed", ta.x + 20, ta.y + ta.h / 2, 2, "right");
  await mouse("mouseReleased", ta.x + 20, ta.y + ta.h / 2, 0, "right");
  await until(() => menus.length > beforeCtx, 5000, "text context menu");
  const ctx = menus.at(-1).items;
  console.log(`  field menu: ${JSON.stringify(ctx.map((i) => i.type === "separator" ? "—" : (i.label || i.role)))}`);
  const roles = ctx.map((i) => (i.role ?? "").toLowerCase());
  check("a right-click in a field gets Cut, Copy and Paste", ["cut", "copy", "paste"].every((r) => roles.includes(r)), roles);
  check("…and Look Up for the selection", ctx.some((i) => /^Look Up/.test(i.label ?? "")), ctx.map((i) => i.label));
  await evalIn(c, `(() => { const t = document.querySelector('.composer textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  // ---- 10. the key-window round trip -------------------------------------------------------------
  tell("key false"); await sleep(200);
  check("main's report greys the window", await evalIn(c, `document.documentElement.hasAttribute('data-window-inactive')`));
  tell("key true"); await sleep(200);
  check("…and the next one lights it again", !(await evalIn(c, `document.documentElement.hasAttribute('data-window-inactive')`)));

  // ---- 11. scrollbars follow the system -----------------------------------------------------------
  const sys = await evalIn(c, `(() => { const p = document.createElement('div');
    p.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;scrollbar-color:auto;scrollbar-width:auto';
    document.body.appendChild(p); const r = p.offsetWidth - p.clientWidth; p.remove();
    return { reserved: r, marked: document.documentElement.hasAttribute('data-overlay-scrollbars') }; })()`);
  check("the overlay mark matches what this Mac draws", sys.marked === (sys.reserved === 0), sys);
  await evalIn(c, `document.documentElement.setAttribute('data-overlay-scrollbars', ''); true`);
  const overlay = { side: await computed(".space-body", "scrollbarColor"), sideW: await computed(".space-body", "scrollbarWidth") };
  const bar = await evalIn(c, `(() => { const e = document.querySelector('.space-body'); return e.offsetWidth - e.clientWidth; })()`);
  await evalIn(c, `document.documentElement.removeAttribute('data-overlay-scrollbars'); true`);
  check("on an overlay Mac every styled bar stands down to the system's", overlay.side === "auto" && overlay.sideW === "auto", overlay);
  console.log(`  sidebar gutter with the system bar on this Mac: ${bar}px`);

  // ---- 12. reduced motion ---------------------------------------------------------------------------
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(100);
  tell("phase began/none"); await sleep(100);
  for (let i = 0; i < 4; i++) { await wheel(-37); await sleep(16); }
  tell("phase ended/none");
  check("under reduced motion nothing stretches", !(await evalIn(c, `document.querySelector(${JSON.stringify(rubberSel)}).hasAttribute('data-rubber')`)));
  await evalIn(c, `document.getElementById('nf-btn').focus(); true`);
  for (const type of ["keyDown", "keyUp"])
    await c.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await sleep(20);
  const quietRing = await evalIn(c, `document.activeElement.getAnimations().map((a) => a.animationName).filter(Boolean)`);
  check("…and the focus ring is simply there", !quietRing.includes("rl-focus-ring"), quietRing);
  const sheetUnderReduce = await computed("#nf-sheet", "animationName");
  check("…and a sheet does not travel", sheetUnderReduce === "none", sheetUnderReduce);
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  // ---- 13. light mode ------------------------------------------------------------------------------
  const mode = await evalIn(c, `document.documentElement.dataset.mode`);
  await evalIn(c, `document.documentElement.dataset.mode = 'light'; true`);
  await sleep(400);
  tell("key true"); await sleep(250);
  const lightKey = await chromaOf("#nf-primary", "backgroundColor");
  await shoot(c, "03-light-key-window", { x: 0, y: 0, width: 1280, height: 860 });
  await evalIn(c, `document.documentElement.setAttribute('data-window-inactive', ''); true`);
  await sleep(400);
  const lightIdle = await chromaOf("#nf-primary", "backgroundColor");
  await shoot(c, "04-light-not-key-window", { x: 0, y: 0, width: 1280, height: 860 });
  await evalIn(c, `document.documentElement.removeAttribute('data-window-inactive'); document.documentElement.dataset.mode = ${JSON.stringify(mode)}; true`);
  check("light mode: coloured when key, grey when not", lightKey.spread > 40 && lightIdle.spread <= 3, { lightKey, lightIdle });
  check("light mode: …and the white label reads exactly as well on it", Math.abs(onWhite(lightKey.rgb) - onWhite(lightIdle.rgb)) < 0.35,
    { key: onWhite(lightKey.rgb), notKey: onWhite(lightIdle.rgb) });

  c.close();
}

/**
 * The server is a SECOND Electron process, spawned by the one we started, and killing the parent
 * leaves it holding REALM_PORT — so the next run refuses to start on a port nothing is using any
 * more. Killed by port rather than by pid so an orphan from an interrupted run is cleared too, and
 * only ever the port this script chose.
 */
function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid)); } catch {}
      }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
