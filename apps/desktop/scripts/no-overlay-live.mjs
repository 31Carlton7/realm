/**
 * Live check for Plan 11 W2 (run with: node apps/desktop/scripts/no-overlay-live.mjs)
 *
 * Boots the REAL app (built out/main against the built realm-server) on a scratch REALM_HOME with
 * the CDP endpoint open, drives the renderer over CDP, and asserts the no-overlay invariant with
 * getBoundingClientRect numbers — not by eyeball — against a real, painting WebContentsView:
 *
 *   1. onboarding → first space → a browser pane on a locally served page (no network)
 *   2. palette over a FULL-WIDTH browser: squeezed into the complement, clear of the view rect
 *   3. the space overview (⌘⇧Space) over the same full-width browser: squeezed into the complement
 *   4. the DEGENERATE sheet: opening "New space…" snaps the full-width browser leaf to a [50,50]
 *      split (an empty sibling pane appears), the sheet sits clear of the shrunken view, and
 *      closing restores the exact pre-snap width and removes the sibling
 *   5. the browser pane header carries NO popup control (no aria-haspopup anywhere in its bar/chrome)
 *   6. a non-browser pane's ⋯ menu whose NATURAL right-aligned position would cross into the view
 *      (narrow pane, browser beside it) is repositioned clear of the view rect
 *
 * Ports: 9223 (CDP), 8788 (realm-server), 8799 (local test page). Refuses to run if any is taken.
 * Touches only a scratch dir (REALM_HOME + userData); kills only the processes it started.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = 9223, SERVER_PORT = 8788, PAGE_PORT = 8799;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-no-overlay-live-"));
const results = {};
let electron = null, pageServer = null;
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

/** Poll until `fn` is truthy (the invariant settles within a beat of layout churn — rects re-register
 *  after a pane remount), then record it; a mutant that never satisfies it FAILS via the timeout. */
async function checkEventually(name, fn, ms, detail) {
  let ok = false;
  try { await until(fn, ms, name); ok = true; } catch { ok = false; }
  check(name, ok, await detail());
}

/** Minimal CDP client over the renderer page's websocket. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") events.push("CONSOLE " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    if (m.method === "Runtime.exceptionThrown") events.push("EXC " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return { ready, send, close: () => ws.close(), events };
}

/** Evaluate an expression in the renderer; throws on page exceptions; JSON value back. The helper
 *  bundle is prepended to EVERY evaluation (idempotent) — the page reloads during startup, and a
 *  once-installed helper would vanish with the old context. */
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const rectsIntersect = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

// Small page-side helpers, installed once: React-safe input setter + rect reader.
const HELPERS = `
window.__live = window.__live ?? {
  rect(sel) { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
  setInput(el, value) {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  clickByText(sel, text) {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent === text);
    if (!el) return false; el.click(); return true;
  },
  key(target, key, opts = {}) { (target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts })); },
};
void 0`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, PAGE_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run (is something already listening there?)`);
  }

  // 1. The local test page — the browser view never leaves the machine.
  pageServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>live target</title><body style='background:#26a'>no-overlay live target</body>");
  });
  await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));

  // 2. Launch the real app: built main, built server, scratch home + userData, CDP open.
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  // The REAL Electron binary, not the .bin shim: killing the shim orphans the app, and teardown
  // must only ever kill what this script started.
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
  await c.send("Runtime.enable"); // renderer console errors are part of the verdict

  // 3. Onboarding → first space (agent probe runs; sessions only spawn adapters on first MESSAGE).
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input[type="text"], .onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 20000, "first pane");

  // 4. A browser pane on the local page. Palette → New browser (replaces the session pane's leaf).
  const openPalette = async () => {
    await evalIn(c, `__live.key(window, "k", { metaKey: true })`);
    await until(() => evalIn(c, `!!document.querySelector('.palette')`), 5000, "palette open");
  };
  await openPalette();
  await evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'New browser')`);
  await until(() => evalIn(c, `!!document.querySelector('.browser-address input')`), 10000, "browser pane");
  await evalIn(c, `(() => {
    const input = document.querySelector('.browser-address input');
    __live.setInput(input, "http://127.0.0.1:${PAGE_PORT}/");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(async () => (await targets()).some((t) => t.url.startsWith(`http://127.0.0.1:${PAGE_PORT}`)), 20000, "view navigated");
  await until(() => evalIn(c, `!document.querySelector('.browser-hint')`), 10000, "hasUrl");
  await sleep(400); // let the rAF-throttled rect registration settle

  const viewRect = () => evalIn(c, `__live.rect('.browser-view-host')`);

  // 5. Palette over a FULL-WIDTH browser pane: must squeeze into the complement (the sidebar column).
  const v0 = await viewRect();
  check("view is full-width (the degenerate layout)", v0.width > 800, v0);
  await openPalette();
  await checkEventually("palette clear of the view", async () => {
    const p2 = await evalIn(c, `__live.rect('.palette')`);
    return p2 && !rectsIntersect(p2, v0) && p2.x + p2.width <= v0.x + 0.5;
  }, 5000, async () => ({ palette: await evalIn(c, `__live.rect('.palette')`), view: v0 }));

  // 6. The space overview (⌘⇧Space) over the same full-width browser: it is a centered surface like
  //     the palette, so it must squeeze into the complement rather than open under the view.
  await evalIn(c, `__live.key(window, " ", { code: "Space", metaKey: true, shiftKey: true })`);
  await until(() => evalIn(c, `!!document.querySelector('.spaces-overview')`), 5000, "overview open");
  await checkEventually("space overview clear of the view", async () => {
    const o = await evalIn(c, `__live.rect('.spaces-overview')`);
    return o && !rectsIntersect(o, v0) && o.x + o.width <= v0.x + 0.5;
  }, 5000, async () => ({ overview: await evalIn(c, `__live.rect('.spaces-overview')`), view: v0 }));
  // Escape goes to the dialog itself: the handler is React's onKeyDown on the panel, not a window listener.
  await evalIn(c, `__live.key(document.querySelector('.spaces-overview'), "Escape")`);
  await until(() => evalIn(c, `!document.querySelector('.spaces-backdrop')`), 5000, "overview closed");

  // 7. The DEGENERATE sheet: "New space…" must snap the browser leaf to [50,50] and restore on close.
  await openPalette();
  await evalIn(c, `(() => {
    const input = document.querySelector('.palette-input input');
    __live.setInput(input, "New space");
    return true; })()`);
  await sleep(100);
  await evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'New space…')`);
  await until(() => evalIn(c, `!!document.querySelector('.sheet-backdrop .sheet')`), 5000, "sheet open");
  // The wrap-remount re-registers the view rect a beat later; the sheet repositions when it lands.
  await checkEventually("snap: view at ~half its width while the sheet is open", async () => {
    const v = await viewRect();
    return v && v.width < v0.width * 0.62 && v.width > v0.width * 0.35;
  }, 8000, async () => ({ before: v0.width, during: (await viewRect())?.width }));
  const v1 = await viewRect();
  const panels1 = await evalIn(c, `document.querySelectorAll('.panel').length`);
  check("snap: an empty sibling pane appeared", panels1 === 2, { panels: panels1 });
  await checkEventually("sheet clear of the (snapped) view", async () => {
    const sr = await evalIn(c, `__live.rect('.sheet-backdrop .sheet')`);
    return sr && !rectsIntersect(sr, v1);
  }, 8000, async () => ({ sheet: await evalIn(c, `__live.rect('.sheet-backdrop .sheet')`), view: v1 }));
  await evalIn(c, `__live.key(window, "Escape")`);
  await until(() => evalIn(c, `!document.querySelector('.sheet-backdrop')`), 5000, "sheet closed");
  await checkEventually("restore: exact pre-snap width is back", async () => {
    const v = await viewRect();
    return v && Math.abs(v.width - v0.width) <= 1;
  }, 8000, async () => ({ before: v0.width, after: (await viewRect())?.width }));
  const panels2 = await evalIn(c, `document.querySelectorAll('.panel').length`);
  check("restore: the empty sibling is gone", panels2 === 1, { panels: panels2 });

  // 8. The browser pane header carries no popup control at all.
  const popups = await evalIn(c, `document.querySelectorAll('.panel-bar [aria-haspopup], .browser-chrome [aria-haspopup]').length`);
  check("browser pane header/chrome is dropdown-free", popups === 0, { popups });

  // 9. Menu avoidance: browser LEFT, a narrow terminal pane RIGHT whose right-aligned ⋯ menu would
  //    naturally cross into the view. Split right, open a terminal there, shrink it, open the menu.
  await evalIn(c, `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^Split .* right$/.test(x.getAttribute('aria-label') ?? ''));
    b.click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.panel').length === 2`), 5000, "split right");
  await openPalette();
  await evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'New terminal')`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.panel-bar [aria-haspopup]')].length === 1`), 10000, "terminal pane");
  // Keyboard-shrink the right pane via the resize handle until it is narrower than a menu.
  await until(async () => {
    const w = await evalIn(c, `(() => {
      const h = document.querySelector('.resize-handle');
      h.focus(); __live.key(h, "ArrowRight");
      const bars = [...document.querySelectorAll('.panel')];
      return bars[bars.length - 1].getBoundingClientRect().width; })()`);
    return w < 150;
  }, 10000, "narrow right pane");
  await sleep(450); // let the resized view rect re-register
  const v3 = await viewRect();
  const anchor = await evalIn(c, `(() => {
    const b = document.querySelector('.panel-bar [aria-haspopup]');
    const r = b.getBoundingClientRect(); b.click();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await until(() => evalIn(c, `(() => { const m = document.querySelector('[role=menu]'); return !!m && m.style.left !== '-9999px'; })()`), 5000, "menu placed");
  const menuRect = await evalIn(c, `__live.rect('[role=menu]')`);
  const naturalRect = { x: anchor.x + anchor.width - menuRect.width, y: anchor.y + anchor.height + 4, width: menuRect.width, height: menuRect.height };
  check("scenario is real: the NATURAL right-aligned position would cross into the view", rectsIntersect(naturalRect, v3), { natural: naturalRect, view: v3 });
  await checkEventually("menu repositioned clear of the view", async () => {
    const m = await evalIn(c, `__live.rect('[role=menu]')`);
    return m && !rectsIntersect(m, v3);
  }, 8000, async () => ({ menu: await evalIn(c, `__live.rect('[role=menu]')`), view: v3 }));

  check("no renderer console errors during the run", c.events.length === 0, c.events.slice(0, 10));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(async () => {
    try { electron?.kill("SIGTERM"); } catch { /* already gone */ }
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch { /* already gone */ }
    pageServer?.closeAllConnections?.();
    pageServer?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log("RESULTS " + JSON.stringify(results));
    process.exit(process.exitCode ?? 0); // the view's keep-alive sockets must not hold the loop open
  });
