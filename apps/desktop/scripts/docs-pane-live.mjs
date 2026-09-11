/**
 * Live check for the docs pane (run with: node apps/desktop/scripts/docs-pane-live.mjs)
 *
 * Two reported bugs, both invisible to jsdom for the same reason — every rect there is zero, so
 * "does this scroll" and "how tall did the pane get" have no answers at all:
 *
 *   1. **Scrolling.** A long document must scroll INSIDE the editor. The failure mode is the
 *      surface growing to its content and pushing the pane past the window, which reads as "the
 *      docs pane does not scroll" and cannot be seen in a stylesheet, because it comes from a
 *      flex chain three elements deep rather than from any one rule.
 *   2. **Tables.** A GFM table must render as a table. It used to be preserved verbatim as a
 *      `rawBlock` — correct for round-tripping, wrong for reading, and the reason a document full
 *      of tables looked like raw markdown.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9361), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8927);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-docs-live-"));
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

/** A client for the server's own RPC socket. The fake agent has to be selected over the wire — a
 *  fresh session defaults to an engine this scratch home has no CLI for, and the summary needs an
 *  actual answer to summarise. Same helper `message-actions-live.mjs` uses, for the same reason. */
function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
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

const HELPERS = `
globalThis.__live = {
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; },
  type(sel, value) {
    const el = document.querySelector(sel);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const shot = async (c, tag, clip) => {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  const out = path.join(os.tmpdir(), `realm-docs-live-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
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
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session");
  const spaceId = sessions[0].spaceId;

  // A real file on disk, written through the server's own document API, opened through the real
  // pane. Long enough that it MUST scroll at any sane window size, and with a table in it.
  const lines = [];
  lines.push("# A long document", "");
  lines.push("| Engine | Ships | Notes |", "| --- | --- | --- |");
  for (let i = 0; i < 6; i++) lines.push(`| row ${i} | yes | a note about row ${i} |`);
  lines.push("");
  for (let i = 0; i < 120; i++) lines.push(`Paragraph ${i}. The quick brown fox jumps over the lazy dog.`, "");
  const { documentsId } = await api.call("documents.create", { spaceId });
  await api.call("documents.write", { documentsId, path: "long.md", text: lines.join("\n"), baseHash: null });
  await api.call("documents.openPath", { spaceId, path: "long.md" });

  await until(() => evalIn(c, `!!document.querySelector('.documents-rich-surface')`), 25000, "rich surface");
  await sleep(700);

  /* ── 1. Scrolling ───────────────────────────────────────────────────────── */
  const scroll = await evalIn(c, `(() => {
    // The SCROLLER, which is EditorContent's wrapper — not the ProseMirror element inside it. Found
    // by walking up from the surface for the first element that actually overflows, so this check
    // keeps working if the scroll ever moves again rather than quietly measuring the wrong box.
    const inner = document.querySelector('.documents-rich-surface');
    const pane0 = document.querySelector('.documents-pane');
    let surface = inner;
    for (let el = inner; el && el !== pane0; el = el.parentElement) {
      if (getComputedStyle(el).overflowY === 'auto' || getComputedStyle(el).overflowY === 'scroll') { surface = el; break; }
    }
    const pane = pane0;
    // Every ancestor between the scroller and the pane, so a chain that breaks in the middle names
    // the element that broke it rather than just reporting "it did not scroll".
    const chain = [];
    for (let el = inner; el && el !== pane.parentElement; el = el.parentElement) {
      chain.push({ cls: el.className || el.tagName, h: Math.round(el.getBoundingClientRect().height),
                   scrollH: el.scrollHeight, overflowY: getComputedStyle(el).overflowY });
    }
    return { pane: __live.box(pane), surface: __live.box(surface),
             scrollHeight: surface.scrollHeight, clientHeight: surface.clientHeight,
             win: { h: window.innerHeight }, chain };
  })()`);
  check("the pane itself stays inside the window", scroll.pane.b <= scroll.win.h + 1, { pane: scroll.pane, win: scroll.win });
  check("the editor scrolls its content rather than growing to it",
    scroll.scrollHeight > scroll.clientHeight + 40, { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight });
  check("…and the surface is the thing that scrolls",
    scroll.surface.b <= scroll.pane.b + 1, { surface: scroll.surface, pane: scroll.pane });
  if (process.exitCode) console.log("CHAIN " + JSON.stringify(scroll.chain, null, 1));

  // Scrolling actually moves it. A bounded box that refuses to scroll looks identical to a working
  // one in every measurement above.
  const moved = await evalIn(c, `(() => {
    const s = document.querySelector('.documents-rich-scroll');
    s.scrollTop = 400;
    return s.scrollTop;
  })()`);
  check("and it responds to being scrolled", moved > 0, { scrollTop: moved });
  await evalIn(c, `(() => { document.querySelector('.documents-rich-scroll').scrollTop = 0; return true; })()`);
  await sleep(200);

  /* ── 2. Tables ──────────────────────────────────────────────────────────── */
  const table = await evalIn(c, `(() => {
    const surface = document.querySelector('.documents-rich-surface');
    const t = surface.querySelector('table');
    const raw = surface.querySelector('.documents-raw');
    return { hasTable: !!t, rows: t ? t.querySelectorAll('tr').length : 0,
             headers: t ? [...t.querySelectorAll('th')].map((h) => h.textContent.trim()) : [],
             rawText: raw ? raw.textContent.slice(0, 60) : null,
             box: t ? __live.box(t) : null, surfaceW: __live.box(surface).w };
  })()`);
  check("a GFM table renders as a table, not as its own source", table.hasTable, table);
  check("it keeps its header row", table.headers.join("|") === "Engine|Ships|Notes", table.headers);
  check("every row survived the parse", table.rows === 7, { rows: table.rows });
  check("no pipe-table text is left sitting in a raw block", table.rawText === null, table);
  if (table.box) check("the table stays inside the editor's column", table.box.w <= table.surfaceW, table);
  await shot(c, "table", table.box ? { x: table.box.l - 20, y: table.box.t - 40, width: table.box.w + 40, height: table.box.h + 60 } : undefined);
  await shot(c, "pane");

  /* ── 3. The round trip still holds ──────────────────────────────────────── */
  // The whole reason tables were a rawBlock: a construct the schema cannot hold gets deleted on the
  // first save. Now that it CAN hold one, the bytes have to survive an edit somewhere else.
  // Placed and typed through the real input pipeline: the caret goes in with a click at the
  // paragraph's own coordinates and the text arrives as `Input.insertText`, which is what a keystroke
  // produces. `execCommand` does not reach ProseMirror at all, so an edit driven that way would be
  // testing the script rather than the editor.
  // Scroll first, THEN measure: a rect read in the same tick as the scroll is the pre-scroll rect,
  // and the click would land on whatever paragraph happens to be at those coordinates afterwards.
  await evalIn(c, `(() => {
    const s = document.querySelector('.documents-rich-surface');
    [...s.querySelectorAll('p')].find((n) => /^Paragraph 3\\./.test(n.textContent)).scrollIntoView({ block: 'center' });
    return true; })()`);
  await sleep(400);
  const caret = await evalIn(c, `(() => {
    const s = document.querySelector('.documents-rich-surface');
    const p = [...s.querySelectorAll('p')].find((n) => /^Paragraph 3\\./.test(n.textContent));
    const b = p.getBoundingClientRect();
    return { x: Math.round(b.left + 4), y: Math.round(b.top + b.height / 2), text: p.textContent };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x: caret.x, y: caret.y, button: "left", clickCount: 1 });
  }
  await sleep(150);
  // Home first. A click lands the caret at the nearest character boundary, which for a click near
  // the left edge is AFTER the first glyph — the insert then reads "PEDITED aragraph", which is a
  // fact about where the mouse was and not about the editor.
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key: "Home", code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 });
  }
  await sleep(100);
  await c.send("Input.insertText", { text: "EDITED " });
  await sleep(700);
  const typed = await evalIn(c, `(() => {
    const s = document.querySelector('.documents-rich-surface');
    return [...s.querySelectorAll('p')].some((n) => /^EDITED Paragraph 3\\./.test(n.textContent));
  })()`);
  check("the keystroke reached the editor", typed, { caret });
  await until(async () => {
    const st = await evalIn(c, `(document.querySelector('.documents-state') || {}).textContent`);
    return st && !/Unsaved/.test(st);
  }, 20000, "save to settle");
  const onDisk = await api.call("documents.read", { documentsId, path: "long.md" });
  check("the table's source survives an edit elsewhere in the document",
    /\| Engine \| Ships \| Notes \|/.test(onDisk.text), { head: onDisk.text.split("\n").slice(0, 4) });
  check("the edit itself landed", /EDITED Paragraph 3\./.test(onDisk.text),
    { sample: onDisk.text.split("\n").filter((l) => /Paragraph 3\.|EDITED/.test(l)).slice(0, 3) });
  api.close();

  check("no renderer console errors", c.events.length === 0, c.events.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 800);
  });
