/**
 * Live check for Realm's own PDF viewer (PdfView.tsx). Run after `pnpm build`:
 *   node apps/desktop/scripts/pdf-view-live.mjs
 *
 * Boots the BUILT app on a scratch REALM_HOME and drives it over CDP, because everything that can go
 * wrong here is invisible to jsdom: pdf.js's worker, its CMaps and standard fonts and WASM decoders
 * under the file:// page's CSP, canvas paint, text-layer alignment and the page ground.
 *
 *   1. a 40-page text PDF in a font it does not embed → white pages on the pane's ground, "1 of 40"
 *   2. the page field, zoom, a link inside the file, ⌘F find with a count, text selection
 *   3. an agent rewriting the file keeps the reader's page; a shorter rewrite clamps it
 *   4. a 200-page file holds only the canvases in reach
 *   5. CJK through a predefined CMap, a JPEG 2000 picture (the WASM decoder), a password, a corrupt file
 *   6. screenshots, dark and light, to look at
 *
 * Ports: LIVE_CDP_PORT (9239) and LIVE_SERVER_PORT (8799); refuses to run if either is taken. Touches
 * only its scratch dir, never the real ~/Realm, and no agent is ever sent anything.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { corruptPdf, cjkPdf, jpxPdf, passwordPdf, textPdf } from "./pdf-fixtures.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9239), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8799);
const SHOTS = process.env.LIVE_SHOTS ?? path.join(os.homedir(), ".cache", "realm-pdf-live");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-pdf-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) => new Promise((resolve) => {
  const s = connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

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
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
      // pdf.js reports a missing CMap, font or decoder as a warning, not an error.
      if (m.params.type === "error" || /warning|cmap|font|wasm|jpx|jbig2/i.test(text)) events.push(`${m.params.type.toUpperCase()} ${text}`);
    }
    if (m.method === "Runtime.exceptionThrown") events.push("EXC " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === "Log.entryAdded" && m.params.entry.level !== "verbose") events.push(`LOG ${m.params.entry.text.slice(0, 300)}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return { ready, send, close: () => ws.close(), events };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) { failures++; process.exitCode = 1; }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shot(c, name, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const p = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log("SCREENSHOT " + p);
  return p;
}

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 5000, `palette row ${label}`);
}

/** Open a file through the pane's own picker, as a person would. */
async function openFile(c, name) {
  await until(() => evalIn(c, `!!document.querySelector('.documents-new, .docs-home-new')`), 15000, "the New button");
  await evalIn(c, `document.querySelector('.documents-new, .docs-home-new').click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.menu [role="menuitem"]')`), 5000, "new menu");
  await evalIn(c, `[...document.querySelectorAll('.menu [role="menuitem"]')].find((e) => e.textContent.includes('A file in this folder'))?.click(); true`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.documents-picker-list button')].some((b) => b.textContent.trim() === ${JSON.stringify(name)})`), 8000, `picker row ${name}`);
  await evalIn(c, `[...document.querySelectorAll('.documents-picker-list button')].find((b) => b.textContent.trim() === ${JSON.stringify(name)}).click(); true`);
  await until(() => evalIn(c, `document.querySelector('.documents-name')?.textContent === ${JSON.stringify(name.replace(/\.pdf$/, ""))}`), 8000, `opened ${name}`);
}

const state = (c) => evalIn(c, `(() => {
  const v = document.querySelector('.pdf-view');
  return {
    pages: document.querySelectorAll('.pdf-page').length,
    painted: document.querySelectorAll('.pdf-page[data-painted]').length,
    canvases: document.querySelectorAll('.pdf-canvas').length,
    field: document.querySelector('.pdf-page-field')?.value ?? null,
    of: document.querySelector('.pdf-tools-of')?.textContent ?? null,
    zoom: document.querySelector('.pdf-tools-zoom .media-viewer-zoom')?.textContent ?? null,
    top: v?.scrollTop ?? null,
    message: document.querySelector('.pdf-message')?.textContent ?? null,
    iframe: !!document.querySelector('iframe.documents-frame'),
  }; })()`);

/** How much of a page's canvas is ink, read back from its own pixels: 0 is a blank page. */
const inkOf = (c, index, region = null) => evalIn(c, `(() => {
  const cv = document.querySelectorAll('.pdf-page')[${index}]?.querySelector('.pdf-canvas');
  if (!cv) return null;
  const r = ${JSON.stringify(region)} ?? { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.floor(r.x * cv.width), y = Math.floor(r.y * cv.height), w = Math.max(1, Math.floor(r.w * cv.width)), h = Math.max(1, Math.floor(r.h * cv.height));
  const d = cv.getContext('2d').getImageData(x, y, w, h).data;
  let ink = 0, red = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] < 600) ink++; if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) red++; }
  return { ink: ink / (d.length / 4), red: red / (d.length / 4) };
})()`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const home = path.join(scratch, "home");
  electron = spawn(electronBin, [...UNTHROTTLED, wrapper], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: process.env.LIVE_MAIN ?? path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  globalThis.__c = c;
  await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable"); await c.send("Log.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  // An unkeyed window greys its accent (a Mac's rule); the screenshots should show the key window.
  const keyed = `(() => { const r = document.documentElement; r.removeAttribute('data-window-inactive');
    if (!window.__keyed) { window.__keyed = new MutationObserver(() => r.removeAttribute('data-window-inactive')); window.__keyed.observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); } return true; })()`;

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 30000, "first pane");
  await evalIn(c, keyed);

  // The space's folder is the documents pane's root: the fixtures go there.
  const folder = await until(() => {
    const walk = (d, depth) => {
      if (depth > 3) return null;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const p = path.join(d, e.name);
        if (e.name.toLowerCase() === "live") return p;
        const r = walk(p, depth + 1); if (r) return r;
      }
      return null;
    };
    try { return walk(home, 0); } catch { return null; }
  }, 10000, "space folder");
  const put = (name, bytes) => { fs.writeFileSync(path.join(folder, name), bytes); return path.join(folder, name); };
  const lecture = put("lecture.pdf", textPdf(40, 30));
  put("long.pdf", textPdf(200, 2));
  put("japanese.pdf", cjkPdf());
  const jpx = jpxPdf();
  if (jpx) put("scan.pdf", jpx);
  put("locked.pdf", passwordPdf());
  put("broken.pdf", corruptPdf());

  await paletteRow(c, "Documents");
  await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 15000, "documents pane");

  // 1. The text PDF.
  await openFile(c, "lecture.pdf");
  await until(async () => (await state(c)).painted >= 1, 20000, "first page painted");
  let s = await state(c);
  check("Realm draws the PDF: no iframe, every page laid out", !s.iframe && s.pages === 40, s);
  check("a file opened fresh starts at the top of its column", s.top === 0, { top: s.top });
  check("the head row says where the reader is", s.field === "1" && s.of === "of 40", { field: s.field, of: s.of });
  check("the head shows no Saved for a PDF", await evalIn(c, `document.querySelector('.documents-state')?.textContent === ''`));
  const ink = await inkOf(c, 0, { x: 0.1, y: 0.1, w: 0.8, h: 0.4 });
  check("page 1 is painted with its text (standard font data loaded)", ink && ink.ink > 0.005, ink);
  const geom = await evalIn(c, `(() => {
    const v = document.querySelector('.pdf-view').getBoundingClientRect();
    const p = [...document.querySelectorAll('.pdf-page')].slice(0, 2).map((e) => e.getBoundingClientRect());
    const cs = getComputedStyle(document.querySelector('.pdf-page[data-painted]'));
    return { view: { x: v.x, y: v.y, w: v.width, h: v.height }, p0: { x: p[0].x, y: p[0].y, w: p[0].width, h: p[0].height }, gap: p[1].y - p[0].bottom,
      ground: getComputedStyle(document.querySelector('.pdf-view')).backgroundColor, shadow: cs.boxShadow, outline: cs.outlineColor, radius: cs.borderRadius };
  })()`);
  check("fit width caps the page at 900px and spaces pages by 16", geom.p0.w <= 900 && Math.round(geom.gap) === 16, geom);
  check("no pdf.js warnings for fonts, CMaps or decoders", !c.events.some((e) => /Unable to load|failed to fetch|cmap|standardFontData/i.test(e)), c.events.slice(-5));
  await shot(c, "pdf-dark-window");
  await shot(c, "pdf-dark-pane", { x: geom.view.x - 1, y: geom.view.y - 52, width: geom.view.w + 2, height: geom.view.h + 52 });

  // 2a. The page field: type a page and press Return.
  await evalIn(c, `(() => { const f = document.querySelector('.pdf-page-field'); f.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(f, "12"); f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(async () => (await state(c)).field === "12", 5000, "page 12");
  check("typing 12 and Return goes to page 12", true);
  // 2b. Zoom: + steps up a rung, the readout puts it back to fit.
  const before = (await state(c)).zoom;
  await evalIn(c, `document.querySelector('[aria-label="Zoom in"]').click(); true`);
  await until(async () => (await state(c)).zoom !== before, 3000, "zoomed");
  s = await state(c);
  check("zoom in moves to the next rung and keeps the page", s.field === "12", { before, after: s.zoom, field: s.field });
  await sleep(400);
  const aligned = await evalIn(c, `(() => {
    const page = document.querySelectorAll('.pdf-page')[11];
    const span = [...page.querySelectorAll('.textLayer span')].find((e) => e.textContent.startsWith('Page 12'));
    if (!span) return null;
    const a = span.getBoundingClientRect(), p = page.getBoundingClientRect();
    return { x: (a.x - p.x) / p.width, y: (a.y - p.y) / p.height, w: a.width / p.width };
  })()`);
  check("the text layer sits over the heading after a zoom", aligned && Math.abs(aligned.x - 72 / 612) < 0.02 && aligned.y > 0.05 && aligned.y < 0.12, aligned);
  await evalIn(c, `document.querySelector('.pdf-tools-zoom .media-viewer-zoom').click(); true`);
  await sleep(300);
  // 2c. A link inside the file.
  await evalIn(c, `(() => { const f = document.querySelector('.pdf-page-field'); f.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(f, "1"); f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(async () => (await state(c)).field === "1", 5000, "back to 1");
  await until(() => evalIn(c, `document.querySelectorAll('.pdf-page')[0].querySelectorAll('.pdf-link').length === 2`), 5000, "links on page 1");
  check("an outside link leaves through a new window (the prose route)", await evalIn(c,
    `(() => { const a = [...document.querySelectorAll('.pdf-page')[0].querySelectorAll('.pdf-link')].find((l) => l.getAttribute('href')?.startsWith('https://example.com')); return a?.target === '_blank'; })()`));
  await evalIn(c, `[...document.querySelectorAll('.pdf-page')[0].querySelectorAll('.pdf-link')].find((l) => l.getAttribute('href') === '#').click(); true`);
  await until(async () => (await state(c)).field === "30", 5000, "link to page 30");
  check("a link inside the file goes to its page", true);
  // 2d. Find: ⌘F with the keyboard in the pane, a count, Return steps.
  await evalIn(c, `document.querySelector('.pdf-view').focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true })); true`);
  await until(() => evalIn(c, `document.activeElement?.classList.contains('pdf-find-field')`), 3000, "find field focused");
  await evalIn(c, `(() => { const f = document.querySelector('.pdf-find-field');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(f, "lighthouse"); f.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const count = await until(() => evalIn(c, `(() => { const t = document.querySelector('.pdf-find-count')?.textContent ?? ''; return / of 8$/.test(t) ? t : null; })()`), 10000, "find count");
  check("⌘F finds every lighthouse, starting at the page being read", count === "6 of 8", { count });
  await until(() => evalIn(c, `!!document.querySelector('.pdf-hit[data-current]')`), 5000, "current hit marked");
  const hitOnScreen = await evalIn(c, `(() => { const h = document.querySelector('.pdf-hit[data-current]').getBoundingClientRect(), v = document.querySelector('.pdf-view').getBoundingClientRect(); return h.top >= v.top && h.bottom <= v.bottom; })()`);
  check("the current hit is marked and on screen", hitOnScreen);
  await shot(c, "pdf-dark-find", { x: geom.view.x - 1, y: geom.view.y - 52, width: geom.view.w + 2, height: geom.view.h + 52 });
  await evalIn(c, `document.querySelector('.pdf-find-field').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true`);
  await until(() => evalIn(c, `document.querySelector('.pdf-find-count')?.textContent === '7 of 8'`), 3000, "next hit");
  const hitPage = await until(() => evalIn(c, `[...document.querySelectorAll('.pdf-page')].indexOf(document.querySelector('.pdf-hit[data-current]')?.closest('.pdf-page')) + 1`), 5000, "next hit marked").catch(() => 0);
  check("Return steps to the next hit, on page 35", hitPage === 35, { hitPage });
  await evalIn(c, `document.querySelector('.pdf-find-field').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await until(() => evalIn(c, `!document.querySelector('.pdf-find') && !document.querySelector('.pdf-hit')`), 3000, "find closed");
  check("Escape closes find and takes its marks away", true);
  // 2e. Text selects.
  const selected = await evalIn(c, `(() => {
    const page = [...document.querySelectorAll('.pdf-page')].find((p) => p.querySelector('.textLayer span'));
    const spans = [...page.querySelectorAll('.textLayer span')].filter((s) => s.textContent.includes('quick brown fox'));
    const r = document.createRange(); r.selectNodeContents(spans[0]);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return sel.toString();
  })()`);
  check("a page's text selects as text", selected.includes("quick brown fox"), { selected });
  await evalIn(c, `getSelection().removeAllRanges(); true`);

  // 3. An agent rewrites the file while it is open: the page holds; a shorter file clamps it.
  await evalIn(c, `(() => { const f = document.querySelector('.pdf-page-field'); f.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(f, "22"); f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(async () => (await state(c)).field === "22", 5000, "page 22");
  await sleep(800);
  fs.writeFileSync(lecture, textPdf(36, 30));
  await until(async () => (await state(c)).of === "of 36", 10000, "rewrite reloaded");
  await sleep(400);
  s = await state(c);
  check("a rewrite of the open file keeps the reader on page 22", s.field === "22", s);
  fs.writeFileSync(lecture, textPdf(8, 3));
  await until(async () => (await state(c)).of === "of 8", 10000, "shorter rewrite");
  await sleep(400);
  s = await state(c);
  check("a shorter rewrite lands on its last page", s.field === "8", s);

  // 4. 200 pages: only the pages in reach hold a canvas, wherever the reader is.
  await openFile(c, "long.pdf");
  await until(async () => (await state(c)).painted >= 1, 20000, "long painted");
  const most = [];
  for (const at of [0.1, 0.35, 0.6, 0.85, 1]) {
    await evalIn(c, `(() => { const v = document.querySelector('.pdf-view'); v.scrollTop = (v.scrollHeight - v.clientHeight) * ${at}; return true; })()`);
    await sleep(700);
    most.push((await state(c)).canvases);
  }
  check("a 200-page file holds only the canvases in reach", Math.max(...most) <= 10, { canvases: most });

  // 5. CJK, a JPEG 2000 scan, a password, a corrupt file.
  await openFile(c, "japanese.pdf");
  await until(async () => (await state(c)).painted >= 1, 20000, "cjk painted");
  await sleep(500);
  const cjk = await inkOf(c, 0, { x: 0.1, y: 0.1, w: 0.7, h: 0.25 });
  const cjkText = await evalIn(c, `document.querySelector('.pdf-page .textLayer')?.textContent ?? ''`);
  check("Japanese through a predefined CMap is drawn and selectable", cjk && cjk.ink > 0.01 && cjkText.includes("日本語"), { cjk, text: cjkText.slice(0, 30) });
  const cjkGeom = await evalIn(c, `(() => { const v = document.querySelector('.pdf-view').getBoundingClientRect(); return { x: v.x, y: v.y, w: v.width, h: v.height }; })()`);
  await shot(c, "pdf-cjk", { x: cjkGeom.x - 1, y: cjkGeom.y - 52, width: cjkGeom.w + 2, height: cjkGeom.h + 52 });
  if (jpx) {
    await openFile(c, "scan.pdf");
    await until(async () => (await state(c)).painted >= 1, 20000, "jpx painted");
    await sleep(500);
    const pic = await inkOf(c, 0, { x: 0.45, y: 0.3, w: 0.1, h: 0.05 });
    check("a JPEG 2000 picture is decoded (WASM in the worker)", pic && pic.red > 0.8, pic);
    await shot(c, "pdf-jpx", { x: cjkGeom.x - 1, y: cjkGeom.y - 52, width: cjkGeom.w + 2, height: cjkGeom.h + 52 });
  } else console.log("SKIP jpx: no opj_compress");
  if (process.env.LIVE_JBIG2) {
    // A real scanned file someone has, copied in; checked for ink only, never photographed.
    fs.copyFileSync(process.env.LIVE_JBIG2, path.join(folder, "jbig2.pdf"));
    await openFile(c, "jbig2.pdf");
    await until(async () => (await state(c)).painted >= 1, 30000, "jbig2 painted");
    await sleep(1500);
    const scan = await inkOf(c, 0);
    check("a JBIG2 scan is decoded (WASM in the worker)", scan && scan.ink > 0.01, scan);
  }
  await openFile(c, "locked.pdf");
  await until(async () => (await state(c)).message, 10000, "password message");
  s = await state(c);
  check("a password-protected file says so, and offers Preview", s.message?.startsWith("locked.pdf is password-protected. Realm can't open it.")
    && await evalIn(c, `[...document.querySelectorAll('.pdf-message button')].some((b) => b.textContent === 'Open in Preview')`), s.message);
  await shot(c, "pdf-password", { x: cjkGeom.x - 1, y: cjkGeom.y - 52, width: cjkGeom.w + 2, height: cjkGeom.h + 52 });
  await openFile(c, "broken.pdf");
  await until(async () => (await state(c)).message, 10000, "corrupt message");
  s = await state(c);
  check("a corrupt file says why", /^Realm couldn't read this PDF: .+\.$/.test(s.message ?? ""), s.message);

  // 6. Light.
  await openFile(c, "lecture.pdf");
  await until(async () => (await state(c)).painted >= 1, 20000, "lecture again");
  // The page strip, beside the pages.
  await evalIn(c, `document.querySelector('[aria-label="Show pages"]').click(); true`);
  await until(() => evalIn(c, `document.querySelectorAll('.pdf-thumb-page[data-painted]').length >= 3`), 10000, "thumbnails painted");
  const strip = await evalIn(c, `(() => { const s = document.querySelector('.pdf-strip').getBoundingClientRect(); const cur = document.querySelector('.pdf-thumb[aria-current="page"]');
    return { w: s.width, floating: document.querySelector('.pdf-strip').hasAttribute('data-floating'), current: cur?.getAttribute('aria-label') }; })()`);
  check("the page strip is a 132px column beside the pages, the current page marked", strip.w === 132 && !strip.floating && strip.current === `Page ${(await state(c)).field}`, strip);
  await shot(c, "pdf-dark-strip", { x: cjkGeom.x - 1, y: cjkGeom.y - 52, width: cjkGeom.w + 2, height: cjkGeom.h + 52 });
  await paletteRow(c, "Theme: Light");
  await sleep(800);
  await evalIn(c, keyed);
  await shot(c, "pdf-light-window");
  const lg = await evalIn(c, `(() => { const v = document.querySelector('.pdf-view').getBoundingClientRect(); return { x: v.x, y: v.y, w: v.width, h: v.height, ground: getComputedStyle(document.querySelector('.pdf-view')).backgroundColor, outline: getComputedStyle(document.querySelector('.pdf-page')).outlineColor }; })()`);
  await shot(c, "pdf-light-pane", { x: lg.x - 1, y: lg.y - 52, width: lg.w + 2, height: lg.h + 52 });
  console.log("LIGHT", JSON.stringify(lg));
  await paletteRow(c, "Theme: Dark");

  const errs = c.events.filter((e) => /^(ERROR|EXC)/.test(e) && !e.includes("Autofill"));
  check("no renderer errors", errs.length === 0, errs.slice(0, 6));
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  c.close();
}

main().catch(async (e) => {
  console.error("FATAL", e.message);
  process.exitCode = 1;
  try { if (globalThis.__c) { console.error("STATE", JSON.stringify(await state(globalThis.__c))); console.error("EVENTS", globalThis.__c.events.slice(-12)); } } catch {}
}).finally(async () => {
  electron?.kill("SIGKILL");
  // The server is a second process that outlives the app and holds the port. Reap it by port — but
  // only once its environment shows it is THIS run's, so a real Realm can never be the one that goes.
  await sleep(500);
  try {
    for (const pid of execFileSync("lsof", ["-t", `-iTCP:${SERVER_PORT}`, "-sTCP:LISTEN"]).toString().split("\n").filter(Boolean)) {
      if (execFileSync("ps", ["eww", "-p", pid]).toString().includes(scratch)) process.kill(Number(pid), "SIGKILL");
    }
  } catch {}
  setTimeout(() => { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 800);
});
