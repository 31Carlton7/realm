/**
 * Live check for a side pane's tab strip and the simulator's toolbar (run with: pnpm build && node apps/desktop/scripts/tab-strip-and-device-toolbar-live.mjs)
 *
 * What only the built app can say, since jsdom lays nothing out:
 *   1. The tab strip dissolves where it scrolls: an end fades only while there is more of the strip
 *      that way, two tabs wear no fade at all, and the "+" and the bar's own buttons stay crisp outside
 *      it. A classic scrollbar does not appear under the strip, and a tab dragged across it lands.
 *   2. Every tab's glyph is the same size at every width, whatever its title — the documents and
 *      device tabs measured smaller than a session's once their titles ran to an ellipsis.
 *   3. The device's controls are a toolbar of their own above the device and centred on it, the
 *      Record row is under it, and the pane bar holds the tabs and the pane's own buttons only — for
 *      an iPhone and for an Android emulator, in a wide pane and a narrow one.
 *   Each is captured in dark and light under LIVE_SHOT_DIR.
 *
 * The DEVICE is faked, as laya-record-sheet-live.mjs fakes it, so nobody's screen is read: no
 * simulator boots and serve-sim never runs. The pane is handed a running state through the renderer's
 * own store, with an SVG for its picture and a local socket for its input, so everything it draws is
 * the real pane. The Android emulator is the same pane pointed at a row whose platform is `android`
 * (set in the scratch home's database), which is the one thing that decides its frame. No prompt is
 * sent to any agent.
 *
 * Ports: LIVE_CDP_PORT / LIVE_SERVER_PORT. Touches a scratch home (LIVE_SCRATCH, else the temp dir);
 * kills only its own ports.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9244), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8804);
const shots = process.env.LIVE_SHOT_DIR ?? path.join(os.tmpdir(), "realm-tab-strip-device");
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-tab-strip-device-live-"));
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1440, height: 900 };
const { WebSocketServer } = createRequire(path.join(repoRoot, "apps/server/package.json"))("ws");
let electron = null, inputServer = null, api = null;
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
  const listeners = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else listeners.get(msg.method)?.(msg.params);
  });
  return {
    ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    once: (method) => new Promise((res) => listeners.set(method, (p) => { listeners.delete(method); res(p); })),
    close: () => ws.close(),
  };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The window, or one element of it with a margin, at the device's scale. */
async function shoot(c, name, selector, pad = 16) {
  const box = selector ? await evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: r.width + ${2 * pad}, height: r.height + ${2 * pad} }; })()`) : null;
  if (selector && !box) { console.log(`  (no ${selector} to shoot for ${name})`); return; }
  /* The window's material is not in the DOM, so a capture composites the translucent grounds over
     nothing and the chrome comes out see-through grey. For the capture alone the root is painted with
     a ground standing in for the material over a plain wallpaper, dark or light as the face is. */
  await evalIn(c, `(() => { const r = document.documentElement; r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; return true; })()`);
  // The pointer off every control, so no tooltip stands in the picture.
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: VIEWPORT.height - 40 });
  await sleep(150);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(box ? { clip: { ...box, scale: 1 } } : {}) });
  await evalIn(c, `(() => { document.documentElement.style.background = ""; return true; })()`);
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
}

/** A phone's screen for the picture: any app will do, since nothing is read off it. */
const screenSvg = (w, h, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w / 3} ${h / 3}">
<rect width="${w / 3}" height="${h / 3}" fill="#f2f2f7"/><text x="20" y="112" font-family="-apple-system, Helvetica" font-weight="700" font-size="34">${title}</text>
${["Lemon pasta", "Green curry", "Miso soup", "Shakshuka", "Ube cake", "Cold noodles"].map((name, i) => `<rect x="16" y="${140 + i * 74}" width="${w / 3 - 32}" height="64" rx="12" fill="#fff"/>
<rect x="28" y="${152 + i * 74}" width="40" height="40" rx="9" fill="${["#ff9f0a", "#30d158", "#0a84ff", "#ff375f", "#bf5af2", "#64d2ff"][i]}"/>
<text x="82" y="${178 + i * 74}" font-family="-apple-system, Helvetica" font-size="17">${name}</text>`).join("")}</svg>`;

const store = (expr) => `window.__liveStore.getState().${expr}`;
const setTheme = async (c, mode) => { await evalIn(c, `${store(`setThemePref(${JSON.stringify(mode)})`)}, true`); await sleep(500); };

async function main() {
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  // The device's input socket: accepts and drops every frame, which is all a pane needs to call itself live.
  inputServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => inputServer.once("listening", r));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app, Menu } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    // A window opened behind someone's is not laid out without these (live-window-occluded memory).
    'for (const s of ["disable-backgrounding-occluded-windows", "disable-renderer-backgrounding", "disable-background-timer-throttling"]) app.commandLine.appendSwitch(s);',
    "Menu.prototype.popup = function (opts = {}) { setTimeout(() => opts.callback?.(), 10); };",
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stdout.on("data", () => {}); electron.stderr.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  // An unkeyed window greys its accent; this one is the person's window for the length of the check.
  await evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
    new MutationObserver(() => r.hasAttribute('data-window-inactive') && r.removeAttribute('data-window-inactive')).observe(r, { attributes: true }); return true; })()`);
  // The renderer's store: the value of the provider at React's root.
  const found = await evalIn(c, `(() => { const root = document.getElementById('root'); const key = Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    const stack = [root[key]]; while (stack.length) { const f = stack.pop(); if (!f) continue; const v = f.memoizedProps?.value;
      if (v && typeof v.getState === 'function' && typeof v.getState().applySimulatorState === 'function') { window.__liveStore = v; return true; }
      if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); } return false; })()`);
  if (!found) throw new Error("no store under React's root");

  // ── The side pane: a device and the documents beside the onboarding session ──────────────────
  const lead = await evalIn(c, `(() => { const s = ${store("items")}.find((i) => i.kind === 'session'); return { itemId: s.id, sessionId: s.refId, spaceId: s.spaceId }; })()`);
  const env = await evalIn(c, `${store(`sessions[${JSON.stringify(lead.sessionId)}]?.environmentId ?? null`)}`);
  await evalIn(c, `${store(`newSimulator(null, { sessionId: ${JSON.stringify(lead.sessionId)} })`)}, true`);
  const sim = await until(() => evalIn(c, `(() => { const i = ${store("items")}.find((x) => x.kind === 'simulator'); return i ? { itemId: i.id, simulatorId: i.refId } : null; })()`), 10000, "simulator item");
  await evalIn(c, `${store(`updateItem({ id: ${JSON.stringify(sim.itemId)}, title: "iPhone 17 Pro" })`)}, true`);
  if (env) await evalIn(c, `${store(`openDocuments(${JSON.stringify(env)}, null, { sessionId: ${JSON.stringify(lead.sessionId)} })`)}, true`);
  // The item lands in the store a beat after the call returns.
  const docs = env ? await until(() => evalIn(c, `${store("items")}.find((x) => x.kind === 'documents')?.id ?? null`), 10000, "documents item") : null;
  const side = () => evalIn(c, `(() => { const walk = (n) => n.type === 'leaf' ? (n.tabs ? n : null) : n.children.map(walk).find(Boolean) ?? null;
    const leaf = walk(${store("layout")}); if (!leaf) return null;
    const parent = (n) => n.type === 'split' ? (n.children.some((k) => k.id === leaf.id) ? n : n.children.map(parent).find(Boolean) ?? null) : null;
    const split = parent(${store("layout")}); return { id: leaf.id, tabs: leaf.tabs, itemId: leaf.itemId, splitId: split?.id ?? null, sizes: split?.sizes ?? null }; })()`);
  const sideLeaf = await until(side, 10000, "side pane");
  const sel = (rest) => `[data-leaf-id="${sideLeaf.id}"] ${rest}`;
  const show = async (itemId) => { await evalIn(c, `${store(`openItem(${JSON.stringify(itemId)}, ${JSON.stringify(sideLeaf.id)})`)}, true`); await sleep(500); };
  const width = async (pct) => {
    const s = await side();
    await evalIn(c, `${store(`resizeSplit(${JSON.stringify(s.splitId)}, [${100 - pct}, ${pct}])`)}, true`);
    await sleep(700);
    return evalIn(c, `Math.round(document.querySelector(${JSON.stringify(`[data-leaf-id="${sideLeaf.id}"]`)}).getBoundingClientRect().width)`);
  };
  await show(docs ?? sim.itemId);

  /** The strip's own account of itself: what scrolls, which ends are named, what is masked. */
  const strip = () => evalIn(c, `(() => { const s = document.querySelector(${JSON.stringify(sel(".pane-tabs"))}); if (!s) return null;
    const cs = getComputedStyle(s); const add = document.querySelector(${JSON.stringify(sel(".pane-tabs-add"))});
    return { tabs: s.querySelectorAll('.pane-tab').length, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth, scrollLeft: Math.round(s.scrollLeft),
      ends: s.dataset.dissolveX ?? null, mask: cs.webkitMaskImage || cs.maskImage, start: cs.getPropertyValue('--dissolve-start').trim(), end: cs.getPropertyValue('--dissolve-end').trim(),
      bar: s.offsetHeight - s.clientHeight, slackY: s.scrollHeight - s.clientHeight, addOutside: !!add && !s.contains(add), actionsOutside: !s.contains(document.querySelector(${JSON.stringify(sel(".panel-actions"))})) }; })()`);
  const scrollStrip = async (to) => { await evalIn(c, `(() => { const s = document.querySelector(${JSON.stringify(sel(".pane-tabs"))}); s.scrollLeft = ${to === "end" ? "s.scrollWidth" : to === "middle" ? "(s.scrollWidth - s.clientWidth) / 2" : 0}; return true; })()`); await sleep(400); };

  // ── 1. Two tabs: the strip fits, and wears no dissolve ──────────────────────────────────────
  await width(42);
  const two = await strip();
  check("two tabs fit in the strip", two && two.tabs === 2 && two.scrollWidth <= two.clientWidth + 1, two);
  check("…and neither end dissolves", two && !/start|end/.test(two.ends ?? "") && two.start === "0px" && two.end === "0px", two);
  await shoot(c, "strip-two-dark", sel(".panel-bar"), 6);

  // ── Many tabs: a terminal, a second session, browsers, the sub-agents ────────────────────────
  await evalIn(c, `${store(`showSessionTerminal(${JSON.stringify(lead.sessionId)})`)}, true`);
  const other = await api.call("sessions.create", { spaceId: lead.spaceId, agentKind: "fake", title: "yooo" });
  await evalIn(c, `${store("refreshItems()")}, true`);
  if (other.itemId) await evalIn(c, `${store(`openInSidePane(${JSON.stringify(lead.sessionId)}, ${JSON.stringify(other.itemId)})`)}, true`);
  await evalIn(c, `${store(`openAgentsTab(${JSON.stringify(lead.sessionId)})`)}, true`);
  for (let i = 0; i < 2; i++) await evalIn(c, `${store(`newBrowser(null, { sessionId: ${JSON.stringify(lead.sessionId)} })`)}, true`);
  await sleep(800);
  await show(sim.itemId);
  const running = (screen, title) => ({ simulatorId: sim.simulatorId, status: "running", udid: null, serial: null,
    streamUrl: `data:image/svg+xml;base64,${Buffer.from(screenSvg(screen.width, screen.height, title)).toString("base64")}`,
    wsUrl: `ws://127.0.0.1:${inputServer.address().port}/ws`, screen, error: null, detail: null, physical: false });
  const IPHONE = { width: 1206, height: 2622, orientation: "portrait" };
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify(running(IPHONE, "Recipes"))})`)}, true`);
  await sleep(600);

  await width(40);
  const many = await strip();
  check("many tabs overflow the strip, which scrolls", many && many.tabs >= 6 && many.scrollWidth > many.clientWidth + 2, many);
  check("at rest, only the far end dissolves", many && many.ends === "end" && many.start === "0px" && many.end !== "0px", many);
  check("the mask is on the strip itself", many && /linear-gradient/.test(many.mask ?? ""), many?.mask);
  check("the + and the bar's own buttons are outside the masked strip", many && many.addOutside && many.actionsOutside, many);
  check("no scrollbar under the strip", many && many.bar === 0, many);
  check("…and nothing to scroll up and down", many && many.slackY === 0, many);
  await shoot(c, "strip-many-start-dark", sel(".panel-bar"), 6);
  await scrollStrip("middle");
  const mid = await strip();
  check("scrolled part way, both ends dissolve", mid && /start/.test(mid.ends ?? "") && /end/.test(mid.ends ?? ""), mid);
  await shoot(c, "strip-many-middle-dark", sel(".panel-bar"), 6);
  await scrollStrip("end");
  const atEnd = await strip();
  check("scrolled to the end, only the near end dissolves", atEnd && atEnd.ends === "start" && atEnd.end === "0px", atEnd);
  await shoot(c, "strip-many-end-dark", sel(".panel-bar"), 6);

  /* With the Mac's scrollbars set to "always", the dissolve's own rule hands a scroller its bar back —
     which under a 28px row of tabs would be a bar taller than the gap it sits in. */
  const overlay = await evalIn(c, `document.documentElement.hasAttribute('data-overlay-scrollbars')`);
  await evalIn(c, `document.documentElement.removeAttribute('data-overlay-scrollbars'), true`);
  await sleep(300);
  const classic = await strip();
  check("with classic scrollbars, still no bar under the strip", classic && classic.bar === 0, classic);
  if (overlay) await evalIn(c, `document.documentElement.setAttribute('data-overlay-scrollbars', ''), true`);

  // A tab dragged along the strip, held over another: the strip keeps its dissolve while it is held.
  await scrollStrip("middle");
  const dragged = await evalIn(c, `(() => { const tabs = [...document.querySelectorAll(${JSON.stringify(sel(".pane-tab"))})];
    const s = document.querySelector(${JSON.stringify(sel(".pane-tabs"))}).getBoundingClientRect();
    const seen = tabs.filter((t) => { const r = t.getBoundingClientRect(); return r.left >= s.left && r.right <= s.right; });
    const from = seen[0], to = seen[seen.length - 1]; if (!from || !to) return null;
    const a = from.querySelector('.pane-tab-label').getBoundingClientRect(), b = to.querySelector('.pane-tab-label').getBoundingClientRect();
    return { from: { x: a.left + 30, y: a.top + a.height / 2 }, to: { x: b.left + b.width / 2, y: b.top + b.height / 2 }, fromTitle: from.textContent, toTitle: to.textContent }; })()`);
  if (dragged) {
    await c.send("Input.setInterceptDrags", { enabled: true });
    const intercepted = c.once("Input.dragIntercepted");
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragged.from.x, y: dragged.from.y });
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragged.from.x, y: dragged.from.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 6; i++) await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragged.from.x + i * 8, y: dragged.from.y, button: "left", buttons: 1 });
    const drag = await Promise.race([intercepted, sleep(3000).then(() => null)]);
    if (drag) {
      await c.send("Input.dispatchDragEvent", { type: "dragEnter", x: dragged.to.x, y: dragged.to.y, data: drag.data });
      await c.send("Input.dispatchDragEvent", { type: "dragOver", x: dragged.to.x, y: dragged.to.y, data: drag.data });
      await sleep(300);
      const held = await strip();
      const over = await evalIn(c, `[...document.querySelectorAll(${JSON.stringify(sel(".pane-tab[data-over]"))})].map((t) => t.textContent)`);
      check("while a tab is held over another, the strip keeps both ends dissolved", held && /start/.test(held.ends ?? "") && /end/.test(held.ends ?? ""), held);
      check("…and marks where it will land", over.length === 1, over);
      await shoot(c, "strip-drag-dark", sel(".panel-bar"), 6);
      await c.send("Input.dispatchDragEvent", { type: "drop", x: dragged.to.x, y: dragged.to.y, data: drag.data });
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragged.to.x, y: dragged.to.y, button: "left", clickCount: 1 });
      await sleep(500);
      const order = (await side()).tabs;
      check("…and the drop moves it", order.length >= 6, order);
    } else {
      check("a tab's drag starts", false, "no drag was intercepted");
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragged.from.x, y: dragged.from.y, button: "left", clickCount: 1 });
    }
    await c.send("Input.setInterceptDrags", { enabled: false });
  }
  await show(sim.itemId);

  await setTheme(c, "light");
  await scrollStrip("start");
  await shoot(c, "strip-many-start-light", sel(".panel-bar"), 6);
  await scrollStrip("middle");
  await shoot(c, "strip-many-middle-light", sel(".panel-bar"), 6);
  await setTheme(c, "dark");

  // ── 2. Every tab's glyph is one size, at every width ──────────────────────────────────────────
  const glyphs = () => evalIn(c, `[...document.querySelectorAll(${JSON.stringify(sel(".pane-tab-label"))})].map((l) => {
    const g = l.querySelector(':scope > svg, :scope > img'); const r = g?.getBoundingClientRect(); const t = l.querySelector('.pane-tab-title');
    return { title: t?.textContent, w: r ? Math.round(r.width * 10) / 10 : null, h: r ? Math.round(r.height * 10) / 10 : null, cut: t ? t.scrollWidth > t.clientWidth : null }; })`);
  for (const pct of [40, 28, 18]) {
    const px = await width(pct);
    const g = await glyphs();
    const off = g.filter((x) => x.w !== 14 || x.h !== 14);
    check(`at ${px}px every tab's glyph is 14×14 (${g.filter((x) => x.cut).length} titles cut)`, g.length >= 6 && off.length === 0, off.length ? off : g.map((x) => `${x.title}:${x.w}×${x.h}`));
    if (pct === 18) await shoot(c, "glyphs-narrow-dark", sel(".panel-bar"), 6);
  }
  // The owner's own shot: the tabs at the side pane's ordinary width, scrolled to the documents and the device.
  await width(40);
  await scrollStrip("start");
  await shoot(c, "glyphs-dark", sel(".panel-bar"), 6);

  // ── 3. The device's own toolbar, above the device ─────────────────────────────────────────────
  /** Where the bar, the toolbar, the device and the Record row are, and what the bar still carries. */
  const device = () => evalIn(c, `(() => { const q = (s) => document.querySelector(${JSON.stringify(`[data-leaf-id="${sideLeaf.id}"]`)} + ' ' + s);
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left * 2) / 2, r: Math.round(r.right * 2) / 2, t: Math.round(r.top * 2) / 2, b: Math.round(r.bottom * 2) / 2, w: Math.round(r.width * 2) / 2 }; };
    const toolbar = q('.sim-toolbar');
    return { pane: box(q('.sim-pane')), chassis: box(q('.sim-chassis')), toolbar: box(toolbar), record: box(q('.sim-record')),
      meta: q('.panel-bar .panel-meta')?.textContent.trim() ?? '',
      barButtons: [...document.querySelectorAll(${JSON.stringify(sel(".panel-bar .panel-actions button"))})].map((b) => b.getAttribute('aria-label')),
      tools: toolbar ? [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : [],
      status: toolbar?.querySelector('.sim-toolbar-status')?.textContent.trim() ?? null,
      clipped: toolbar ? [...toolbar.querySelectorAll('button, .sim-toolbar-status')].filter((e) => { const a = e.getBoundingClientRect(), t = toolbar.getBoundingClientRect(); return a.width > 0 && (a.left < t.left - 0.5 || a.right > t.right + 0.5); }).length : null,
      rowsUnder: [...document.querySelectorAll(${JSON.stringify(sel(".sim-hardware, .sim-frame-bar"))})].length }; })()`);
  const centre = (b) => (b ? (b.l + b.r) / 2 : NaN);
  const judge = (tag, d, { narrow }) => {
    check(`${tag}: the pane bar carries no device state`, !/Live|×/.test(d.meta), d.meta);
    check(`${tag}: the pane bar carries none of the device's controls`, !d.barButtons.some((l) => /screenshot|elements|apps|device settings|stop streaming/i.test(l ?? "")), d.barButtons);
    check(`${tag}: the device has a toolbar of its own`, d.toolbar !== null && d.tools.length >= 2, d.tools);
    if (!d.toolbar || !d.chassis) return;
    check(`${tag}: …above the device, close to it`, d.toolbar.b <= d.chassis.t && d.chassis.t - d.toolbar.b <= 24, { toolbarBottom: d.toolbar.b, deviceTop: d.chassis.t });
    check(`${tag}: …centred on it`, Math.abs(centre(d.toolbar) - centre(d.chassis)) <= 1, { toolbar: centre(d.toolbar), device: centre(d.chassis) });
    check(`${tag}: …and inside the pane, nothing in it clipped`, d.toolbar.l >= d.pane.l && d.toolbar.r <= d.pane.r && d.clipped === 0, { toolbar: d.toolbar, pane: d.pane, clipped: d.clipped });
    check(`${tag}: Record is under the device, centred on it too`, d.record && d.record.t >= d.chassis.b && d.record.t - d.chassis.b <= 24 && Math.abs(centre(d.record) - centre(d.chassis)) <= 1, { record: d.record, device: d.chassis });
    check(`${tag}: no second row of controls under the device`, d.rowsUnder === 0, d.rowsUnder);
    if (narrow) check(`${tag}: a narrow pane keeps the status and an overflow`, d.status !== null && d.tools.some((l) => /more/i.test(l ?? "")), { status: d.status, tools: d.tools });
  };

  for (const [pct, tag] of [[40, "wide"], [24, "narrow"]]) {
    const px = await width(pct);
    await sleep(400);
    const d = await device();
    console.log(`  iPhone, ${tag} (${px}px): ${JSON.stringify({ status: d.status, tools: d.tools, meta: d.meta, bar: d.barButtons })}`);
    judge(`iPhone ${tag}`, d, { narrow: tag === "narrow" });
    await shoot(c, `iphone-${tag}-dark`, `[data-leaf-id="${sideLeaf.id}"]`, 0);
    await setTheme(c, "light");
    await shoot(c, `iphone-${tag}-light`, `[data-leaf-id="${sideLeaf.id}"]`, 0);
    await setTheme(c, "dark");
  }
  await width(40);
  await shoot(c, "window-iphone-dark");

  /* The budget's status widths (toolbar-fit.ts) against what this build draws, for both words: a
     budget under the drawn width clips the overflow's button, and one far over gives presses up early. */
  const budget = Object.fromEntries([...fs.readFileSync(path.join(repoRoot, "apps/desktop/src/renderer/src/panes/simulator/toolbar-fit.ts"), "utf8")
    .matchAll(/(Live|Connecting): \{ full: (\d+), word: (\d+), dot: (\d+) \}/g)].map((m) => [m[1], { full: +m[2], word: +m[3], dot: +m[4] }]));
  const statusWidths = () => evalIn(c, `(() => { const t = document.querySelector(${JSON.stringify(sel(".sim-toolbar"))}); const st = t.querySelector('.sim-toolbar-status');
    const was = t.dataset.status; const out = { text: st.querySelector('.sim-toolbar-word').textContent };
    for (const level of ["full", "word", "dot"]) { t.dataset.status = level; out[level] = Math.round(st.getBoundingClientRect().width * 10) / 10; }
    t.dataset.status = was; return out; })()`);
  const drawn = [await statusWidths()];
  // A socket that never answers keeps the toolbar connecting, which is the other word it can show.
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify({ ...running(IPHONE, "Recipes"), wsUrl: "ws://127.0.0.1:9/ws" })})`)}, true`);
  await until(() => evalIn(c, `document.querySelector(${JSON.stringify(sel(".sim-toolbar-word"))})?.textContent === "Connecting"`), 5000, "connecting").catch(() => null);
  drawn.push(await statusWidths());
  await shoot(c, "iphone-connecting-dark", sel(".sim-above"), 12);
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify(running(IPHONE, "Recipes"))})`)}, true`);
  await sleep(500);
  for (const d of drawn) {
    const b = budget[d.text];
    const ok = b && ["full", "word", "dot"].every((k) => d[k] <= b[k] && b[k] - d[k] <= 4);
    check(`the toolbar budgets "${d.text}" at what this build draws`, ok, { drawn: d, budget: b });
  }

  // The overflow, open.
  const more = await evalIn(c, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel(".sim-toolbar button"))})].find((x) => /more/i.test(x.getAttribute('aria-label') ?? '')); if (!b) return false; b.click(); return true; })()`);
  if (more) {
    await until(() => evalIn(c, `!!document.querySelector('.menu')`), 5000, "overflow menu").catch(() => null);
    await sleep(300);
    const rows = await evalIn(c, `[...document.querySelectorAll('.menu [role^=menuitem]')].map((r) => r.textContent.trim())`);
    console.log(`  overflow rows: ${JSON.stringify(rows)}`);
    check("the overflow holds the rest of the device's controls", rows.some((r) => /Volume up/.test(r)) && rows.some((r) => /Stop streaming/.test(r)), rows);
    await shoot(c, "iphone-overflow-dark");
    await setTheme(c, "light");
    await shoot(c, "iphone-overflow-light");
    await setTheme(c, "dark");
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  }

  // Recording for Laya, as the row under the device reads while it runs — the system below the device.
  const status = await api.call("laya.status", {});
  const recording = { id: "rec-live", simulatorId: sim.simulatorId, device: "iPhone 17 Pro", apps: ["Recipes"], seen: ["Recipes"], screens: 12,
    startedAt: new Date().toISOString(), endedAt: null, lastError: null };
  await evalIn(c, `${store(`applyLaya(${JSON.stringify({ ...status, recording })})`)}, true`);
  await sleep(400);
  const rec = await device();
  check("while it records, the row under the device is still centred on it", rec.record && rec.chassis && Math.abs(centre(rec.record) - centre(rec.chassis)) <= 1, rec.record);
  await shoot(c, "iphone-recording-dark", `[data-leaf-id="${sideLeaf.id}"]`, 0);
  await setTheme(c, "light");
  await shoot(c, "iphone-recording-light", `[data-leaf-id="${sideLeaf.id}"]`, 0);
  await setTheme(c, "dark");
  await evalIn(c, `${store(`applyLaya(${JSON.stringify({ ...status, recording: null })})`)}, true`);

  // Turned on its side: the toolbar follows the device it belongs to.
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify(running({ width: 2622, height: 1206, orientation: "landscape_left" }, "Recipes"))})`)}, true`);
  await sleep(600);
  const turned = await device();
  judge("iPhone landscape", turned, { narrow: false });
  await shoot(c, "iphone-landscape-dark", `[data-leaf-id="${sideLeaf.id}"]`, 0);

  // ── The same pane on an Android emulator ──────────────────────────────────────────────────────
  execFileSync("sqlite3", [path.join(home, "realm.db"), `UPDATE simulators SET platform = 'android', name = 'Realm Pixel' WHERE id = '${sim.simulatorId}'`]);
  const row = (await api.call("simulators.get", { simulatorId: sim.simulatorId })).simulator;
  console.log(`  the row now reads ${JSON.stringify({ platform: row.platform, name: row.name })}`);
  await evalIn(c, `${store(`updateItem({ id: ${JSON.stringify(sim.itemId)}, title: "Realm Pixel" })`)}, true`);
  if (docs) await show(docs);
  const unmounted = await evalIn(c, `!document.querySelector(${JSON.stringify(sel(".sim-pane"))})`);
  await show(sim.itemId);
  console.log(`  the device pane ${unmounted ? "unmounted and came back" : "stayed mounted"} across the tab switch`);
  const PIXEL = { width: 1080, height: 2400, orientation: "portrait" };
  await evalIn(c, `${store(`applySimulatorState(${JSON.stringify(running(PIXEL, "Recipes"))})`)}, true`);
  await sleep(900);
  const art = await evalIn(c, `document.querySelector(${JSON.stringify(sel(".sim-art"))})?.getAttribute('src') ?? null`);
  check("the emulator wears the Pixel's frame", /android/.test(art ?? ""), art);
  for (const [pct, tag] of [[40, "wide"], [24, "narrow"]]) {
    const px = await width(pct);
    await sleep(400);
    const d = await device();
    console.log(`  Android, ${tag} (${px}px): ${JSON.stringify({ status: d.status, tools: d.tools })}`);
    judge(`Android ${tag}`, d, { narrow: tag === "narrow" });
    await shoot(c, `android-${tag}-dark`, `[data-leaf-id="${sideLeaf.id}"]`, 0);
    await setTheme(c, "light");
    await shoot(c, `android-${tag}-light`, `[data-leaf-id="${sideLeaf.id}"]`, 0);
    await setTheme(c, "dark");
  }
  c.close();
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  inputServer?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.log(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
