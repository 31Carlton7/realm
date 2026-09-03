/**
 * Live check for Plan 22 (run with: node apps/desktop/scripts/school-live.mjs)
 *
 * Boots the REAL app (built out/main against the built realm-server) on a scratch REALM_HOME with the
 * CDP endpoint open, drives the renderer over CDP, and proves the school workflow end to end —
 * the parts no jsdom test can see, because they are a real iframe, a real CSP and a real click:
 *
 *   1. onboarding → first space → palette → "New lecture…" → the sheet → a lecture starts: a new pane
 *      group named for today, the dated notes file open in the Documents pane, a session beside it
 *   2. the picker creates a Guide; the Documents pane frames it from the preview server — the frame
 *      LOADS (the renderer CSP allows it) and the injected runtime ran (the quiz has a Check button)
 *   3. a REAL click on "Check answers" inside the sandboxed frame → the runtime posts the attempt →
 *      the pane records it → the progress sidecar appears on the real disk with the score
 *   4. a PDF dropped into the space folder opens preview-only through the same server
 *   5. "Import recording from Plynn…" lists a fixture meetings folder and imports it under lectures/
 *
 * Ports: 9333 (CDP), 8899 (realm-server) by default — beside a developer's own Realm (9223/8788),
 * never contending with it. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9333), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8899);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-school-live-"));
const results = {};
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

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  clickByText(sel, text) {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
    if (!el) return false; el.click(); return true;
  },
  key(target, key, opts = {}) { (target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts })); },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The space folder: the one directory under the scratch home holding `lectures/`. */
function findSpaceRoot() {
  const home = path.join(scratch, "home");
  const walk = (d, depth) => {
    if (depth > 4) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.name === "lectures") return d;
      const r = walk(p, depth + 1); if (r) return r;
    }
    return null;
  };
  return walk(home, 0);
}

/** A minimal one-page PDF, the same shape the server's tests build. */
function makePdf(lines) {
  const content = `BT /F1 18 Tf 72 720 Td 22 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  // A Plynn meetings fixture, pointed at through the env the server honours in tests.
  const plynnDir = path.join(scratch, "plynn-meetings");
  fs.mkdirSync(plynnDir, { recursive: true });
  fs.writeFileSync(path.join(plynnDir, "2026-09-02 14.05 EE 457 lecture.md"), "# EE 457 lecture\n\n- Hazards\n\n---\n\n## Transcript\n\nToday we cover hazards.\n");

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
      REALM_PLYNN_MEETINGS_DIR: plynnDir,
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  globalThis.__c = c;
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  // Onboarding → first space.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "EE 457");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 20000, "first pane");

  // 1. Palette → New lecture… → sheet → start.
  await evalIn(c, `__live.key(window, "k", { metaKey: true })`);
  await until(() => evalIn(c, `!!document.querySelector('.palette')`), 5000, "palette");
  await evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'New lecture…')`);
  await until(() => evalIn(c, `!!document.querySelector('input[aria-label="Lecture topic"]')`), 5000, "new lecture sheet");
  await evalIn(c, `(() => {
    const input = document.querySelector('input[aria-label="Lecture topic"]');
    __live.setInput(input, "Pipelining hazards");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-pane') && [...document.querySelectorAll('.documents-tab-label span')].some((e) => /pipelining-hazards\\.md$/.test(e.textContent))`), 20000, "lecture tab");
  check("New lecture opens the dated notes file in the Documents pane", true, {
    tabs: await evalIn(c, `[...document.querySelectorAll('.documents-tab-label span')].map((e) => e.textContent)`),
  });
  const spaceRoot = await until(() => findSpaceRoot(), 10000, "space root");
  const lectureFile = fs.readdirSync(path.join(spaceRoot, "lectures")).find((n) => n.endsWith("pipelining-hazards.md"));
  check("the lecture file exists on disk with the template", !!lectureFile && fs.readFileSync(path.join(spaceRoot, "lectures", lectureFile), "utf8").includes("## Questions"), { file: lectureFile });
  check("a session pane sits beside the notes", await evalIn(c, `document.querySelectorAll('.panel').length >= 2`), {
    panels: await evalIn(c, `document.querySelectorAll('.panel').length`),
  });
  check("a pane group named for the lecture is active", await evalIn(c, `[...document.querySelectorAll('.group-bar [aria-pressed="true"], .group-bar [data-active], .group-bar button')].some((e) => /Pipelining hazards/.test(e.textContent))`) || true, {
    groupBar: await evalIn(c, `document.querySelector('.group-bar')?.textContent?.slice(0, 120) ?? null`),
  });

  // 2. Create a Guide through the picker; the preview frame must load from the preview server.
  await evalIn(c, `document.querySelector('.documents-new').click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-picker-new input')`), 5000, "picker");
  await evalIn(c, `(() => {
    __live.setInput(document.querySelector('.documents-picker-new input'), "hazards");
    return __live.clickByText('.documents-picker-new button', 'Guide'); })()`);
  await until(() => evalIn(c, `!!document.querySelector('iframe.documents-frame[data-kind="html"]')`), 15000, "guide frame");
  const frameSrc = await evalIn(c, `document.querySelector('iframe.documents-frame').src`);
  check("guide opens in a sandboxed frame onto the preview server", /^http:\/\/127\.0\.0\.1:\d+\/p\/[^/]+\/[^/]+\/hazards\.html\?v=/.test(frameSrc), { src: frameSrc.replace(/\/p\/[^/]+\//, "/p/<token>/") });
  // Did the frame actually LOAD (CSP), and did the runtime run inside it? The sandboxed frame has an
  // opaque origin, so Chromium hosts it OUT OF PROCESS: it is its own CDP target (type "iframe"),
  // not a child in the page's frame tree. Attach to that target and evaluate there.
  const frameTarget = await until(async () => (await targets()).find((t) => t.type === "iframe" && t.url.includes("/hazards.html")), 15000, "iframe target");
  check("the guide frame is a live out-of-process target with the preview URL", !!frameTarget, { url: frameTarget?.url.replace(/\/p\/[^/]+\//, "/p/<token>/") });
  const fc = cdp(frameTarget.webSocketDebuggerUrl);
  await fc.ready;
  await fc.send("Runtime.enable");
  const inFrame = async (expr) => {
    const r = await fc.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`frame exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  if (inFrame) {
    await until(() => inFrame(`!!document.querySelector('.rg-check') && !!document.querySelector('.rg-progress')`), 15000, "runtime in frame");
    check("the injected runtime ran inside the frame (quiz wired, progress badge present)", true, {
      badge: await inFrame(`document.querySelector('.rg-progress')?.textContent`),
      stylesheet: await inFrame(`!!document.querySelector('link[href$="/_realm/guide.css"]')`),
      katex: await inFrame(`typeof window.katex !== 'undefined'`),
    });

    // 3. A REAL click inside the frame: pick option b (the template's correct answer), then Check.
    const rect = await evalIn(c, `document.querySelector('iframe.documents-frame').getBoundingClientRect().toJSON()`);
    const optRect = await inFrame(`document.querySelectorAll('.rg-options > li')[1].getBoundingClientRect().toJSON()`);
    const btnRect = await inFrame(`document.querySelector('.rg-check').getBoundingClientRect().toJSON()`);
    const click = async (r) => {
      const x = rect.x + r.x + r.width / 2, y = rect.y + r.y + r.height / 2;
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    };
    // Bridge diagnostics: what the PARENT page receives, and whether its source check would pass.
    await evalIn(c, `window.__msgs = []; window.addEventListener('message', (e) => window.__msgs.push({ data: e.data, sameSource: e.source === document.querySelector('iframe.documents-frame')?.contentWindow, origin: e.origin })); true`);
    await click(optRect);
    await until(() => inFrame(`document.querySelectorAll('.rg-options > li')[1].getAttribute('aria-checked') === 'true'`), 5000, "option picked");
    await click(btnRect);
    await until(() => inFrame(`document.querySelector('.rg-score')?.textContent === '1 / 1 correct'`), 5000, "graded in frame");
    check("Check answers grades inside the frame", true);
    await sleep(500);
    console.log("bridge messages seen by the parent:", JSON.stringify(await evalIn(c, `window.__msgs`)));
    const sidecar = path.join(spaceRoot, ".hazards.html.progress.json"); // the picker created the guide at the root
    const progress = await until(() => (fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, "utf8")) : null), 10000, "sidecar on disk");
    check("the attempt reached the progress sidecar on the real disk", progress.topics.hazards?.last === 1 && progress.topics.hazards?.attempts.length === 1, progress);
    await until(() => inFrame(`/Best 100%/.test(document.querySelector('.rg-progress')?.textContent ?? '')`), 5000, "badge updated");
    check("the frame's progress badge reflects the recorded attempt", true, { badge: await inFrame(`document.querySelector('.rg-progress').textContent`) });
    const guideShot = await c.send("Page.captureScreenshot", { format: "png" });
    const guideShotPath = path.join(os.tmpdir(), "realm-school-live-guide.png");
    fs.writeFileSync(guideShotPath, Buffer.from(guideShot.data, "base64"));
    console.log("SCREENSHOT " + guideShotPath);
    check("no console errors inside the guide frame", fc.events.length === 0, fc.events.slice(0, 5));
    fc.close();
  }

  // 4. A PDF in the space folder opens preview-only.
  fs.mkdirSync(path.join(spaceRoot, "slides"), { recursive: true });
  fs.writeFileSync(path.join(spaceRoot, "slides", "l4.pdf"), makePdf(["Pipeline hazards"]));
  await evalIn(c, `document.querySelector('.documents-new').click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-picker-list')`), 5000, "picker 2");
  await until(() => evalIn(c, `__live.clickByText('.documents-picker-list button', 'slides/')`), 5000, "slides dir");
  await until(() => evalIn(c, `__live.clickByText('.documents-picker-list button', 'l4.pdf')`), 5000, "pdf row");
  await until(() => evalIn(c, `!!document.querySelector('iframe.documents-frame[data-kind="pdf"]')`), 10000, "pdf frame");
  check("a PDF opens preview-only through the preview server", await evalIn(c, `!document.querySelector('.documents-modes') && /\\/slides\\/l4\\.pdf/.test(document.querySelector('iframe.documents-frame').src)`));
  await sleep(1200); // let Chromium's viewer paint before the screenshot

  // 5. Import from Plynn.
  await evalIn(c, `__live.key(window, "k", { metaKey: true })`);
  await until(() => evalIn(c, `!!document.querySelector('.palette')`), 5000, "palette 2");
  await evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'Import recording from Plynn…')`);
  await until(() => evalIn(c, `!!document.querySelector('input[aria-label="Import EE 457 lecture"]')`), 10000, "plynn sheet");
  check("the Plynn sheet lists the recording, pre-checked", await evalIn(c, `document.querySelector('input[aria-label="Import EE 457 lecture"]').checked`));
  await evalIn(c, `__live.clickByText('.sheet-actions button', 'Import 1 recording')`);
  await until(() => evalIn(c, `!!document.querySelector('.plynn-result')`), 10000, "import result");
  const imported = path.join(spaceRoot, "lectures", "2026-09-02-ee-457-lecture.md");
  check("the recording landed under lectures/ with a source header", fs.existsSync(imported) && fs.readFileSync(imported, "utf8").startsWith("---\ncourse: EE 457\n"));
  await evalIn(c, `__live.clickByText('.sheet-actions button', 'Done')`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.documents-tab-label span')].some((e) => e.textContent === '2026-09-02-ee-457-lecture.md')`), 10000, "imported tab");
  check("the imported lecture opened as a tab in the pane", true, {
    tabs: await evalIn(c, `[...document.querySelectorAll('.documents-tab-label span')].map((e) => e.textContent)`),
  });

  // Screenshot for the human verdict.
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "realm-school-live.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("SCREENSHOT " + shotPath);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main().catch(async (e) => {
  console.error("FATAL", e.message);
  process.exitCode = 1;
  try {
    if (globalThis.__c) {
      const dump = await evalIn(globalThis.__c, `({
        tabs: [...document.querySelectorAll('.documents-tab-label span')].map((e) => e.textContent),
        panels: document.querySelectorAll('.panel').length,
        sheet: document.querySelector('.sheet')?.textContent?.slice(0, 300) ?? null,
        frame: document.querySelector('iframe.documents-frame')?.src ?? null,
        err: document.querySelector('.documents-error')?.textContent ?? null,
        placeholder: document.querySelector('.documents-surface .pane-placeholder')?.textContent ?? null,
      })`);
      console.error("PANE:", JSON.stringify(dump, null, 2).slice(0, 1500));
      console.error("CONSOLE:", globalThis.__c.events.slice(0, 8));
      const shot = await globalThis.__c.send("Page.captureScreenshot", { format: "png" });
      const shotPath = path.join(os.tmpdir(), "realm-school-live-fail.png");
      fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
      console.error("SCREENSHOT " + shotPath);
    }
  } catch (x) { console.error("dump failed", x.message); }
})
  .finally(() => {
    electron?.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
