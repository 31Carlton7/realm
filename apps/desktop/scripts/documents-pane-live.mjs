/**
 * Live check for Plan 17 W1+W2+W3 (run with: node apps/desktop/scripts/documents-pane-live.mjs)
 *
 * Boots the REAL app (built out/main against the built realm-server) on a scratch REALM_HOME with the
 * CDP endpoint open, drives the renderer over CDP, and proves the documents pane end to end:
 *
 *   1. onboarding → first space → palette → "Documents" opens the workspace pane (empty state)
 *   2. "+" → New document creates and OPENS one in a single pick, named afterwards in the head bar;
 *      the RICH editor renders it (h1, not a textarea)
 *   3. editing in Source mode autosaves: the bytes land in the real file on disk
 *   4. an OUTSIDE edit to that file (the agent path) live-reloads a clean buffer, rich view included
 *   5. an outside edit under a DIRTY buffer raises the conflict bar; "Keep mine" wins the file
 *   6. the tab strip survives: a second document → two tabs, persisted through documents.get
 *
 * Ports: 9223 (CDP), 8788 (realm-server). Refuses to run if either is taken.
 * Touches only a scratch dir (REALM_HOME + userData); kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// 9223/8788 are the documented live-check ports, but they are also what a developer's own running
// Realm holds — and this script must never contend with (or tempt anyone to kill) the real app. It
// runs beside it instead: env-overridable, defaulting to a high pair nothing else here uses.
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9333), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8899);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-documents-live-"));
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

/** "+" opens a real menu now, so every creation goes through it: click the opener, wait for the
 *  portalled menu, pick the kind by its wording. */
async function newDocument(c, menuLabel) {
  await evalIn(c, `document.querySelector('.documents-new').click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('.menu [role="menuitem"]')`), 5000, `menu for ${menuLabel}`);
  const picked = await evalIn(c, `__live.clickByText('.menu [role="menuitem"]', ${JSON.stringify(menuLabel)})`);
  if (!picked) throw new Error(`no menu item labelled ${menuLabel}`);
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The one file the run creates, found on the real disk under the scratch home. */
function findDoc(name) {
  const home = path.join(scratch, "home");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) { const r = walk(p); if (r) return r; }
      else if (e.name === name) return p;
    }
    return null;
  };
  return walk(home);
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
  globalThis.__c = c;
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  // Onboarding → first space.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel')`), 20000, "first pane");

  // 1. Palette → Documents.
  await evalIn(c, `__live.key(window, "k", { metaKey: true })`);
  await until(() => evalIn(c, `!!document.querySelector('.palette')`), 5000, "palette");
  await evalIn(c, `__live.clickByText('.palette-opt .palette-label', 'Documents')`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-pane')`), 15000, "documents pane");
  check("palette opens the documents pane", true);
  check("empty state offers a way in", await evalIn(c, `document.querySelector('.documents-pane').textContent.includes('Nothing open yet')`));

  // 2. One pick makes a document. No name is asked for first — it arrives as "Untitled document",
  // already open, with its name selected in the head bar.
  await newDocument(c, "New document");
  await until(() => evalIn(c, `!!document.querySelector('[aria-label="Rich text editor"] h1')`), 15000, "rich editor");
  check("one menu pick creates AND opens the document", true, {
    h1: await evalIn(c, `document.querySelector('[aria-label="Rich text editor"] h1')?.textContent`),
  });
  check("it lands with its name selected, ready to be typed over", await evalIn(c,
    `document.activeElement?.classList.contains('documents-name-input') && document.activeElement.value === 'Untitled document'`));
  // Rename it in place — the half of the flow that used to happen before the file existed.
  await evalIn(c, `(() => {
    const el = document.querySelector('.documents-name-input');
    __live.setInput(el, "Live Report");
    __live.key(el, "Enter");
    return true; })()`);
  await until(() => evalIn(c, `[...document.querySelectorAll('.documents-tab-label span')].some((e) => e.textContent === 'Live Report')`), 10000, "renamed tab");
  check("renaming in place moves the file and its tab", true, {
    onDisk: !!findDoc("Live Report.md"), untitledGone: !findDoc("Untitled document.md"),
  });

  // 3. Edit in Source mode; the autosaved bytes must land on the real disk.
  await evalIn(c, `__live.clickByText('.documents-modes button', 'Source')`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-source')`), 5000, "source mode");
  await evalIn(c, `(() => {
    __live.setInput(document.querySelector('.documents-source'), "# Live Report\\n\\nTyped in the live check.\\n");
    return true; })()`);
  const onDisk = await until(() => {
    const p = findDoc("Live Report.md");
    return p && fs.readFileSync(p, "utf8").includes("Typed in the live check") ? p : null;
  }, 10000, "autosave to disk");
  check("autosave reached the file on disk", true, { path: path.relative(scratch, onDisk) });
  await until(() => evalIn(c, `document.querySelector('.documents-state')?.dataset.state === 'clean'`), 5000, "status clean");
  check("the head bar settles on Saved", true);

  // 4. The agent path: an outside write to a CLEAN buffer live-reloads, rich view included.
  await evalIn(c, `__live.clickByText('.documents-modes button', 'Rich')`);
  await until(() => evalIn(c, `!!document.querySelector('[aria-label="Rich text editor"]')`), 5000, "back to rich");
  fs.writeFileSync(onDisk, "# Rewritten Outside\n\nAn agent changed this file on disk.\n");
  await until(() => evalIn(c, `document.querySelector('[aria-label="Rich text editor"] h1')?.textContent === 'Rewritten Outside'`), 10000, "live reload");
  check("outside edit live-reloads a clean buffer (rich view)", true);
  check("no conflict bar for a clean reload", await evalIn(c, `!document.querySelector('.documents-bar.conflict')`));

  // 5. Outside edit under a DIRTY buffer → conflict bar; Keep mine wins the file.
  await evalIn(c, `__live.clickByText('.documents-modes button', 'Source')`);
  await until(() => evalIn(c, `!!document.querySelector('.documents-source')`), 5000, "source again");
  await evalIn(c, `(() => {
    __live.setInput(document.querySelector('.documents-source'), "# Mine\\n\\nThe user's unsaved paragraph.\\n");
    return true; })()`);
  // Immediately race it with an outside write, inside the autosave debounce.
  fs.writeFileSync(onDisk, "# Theirs\n\nThe agent's competing rewrite.\n");
  await until(() => evalIn(c, `!!document.querySelector('.documents-bar.conflict')`), 10000, "conflict bar");
  check("conflicting outside edit raises the bar, not a clobber", true, {
    editorStillMine: await evalIn(c, `document.querySelector('.documents-source').value.startsWith('# Mine')`),
  });
  await evalIn(c, `__live.clickByText('.documents-bar .btn-quiet', 'Keep mine')`);
  await until(() => fs.readFileSync(onDisk, "utf8").startsWith("# Mine"), 10000, "keep mine wrote");
  check("Keep mine writes the user's text to disk", true);
  await until(() => evalIn(c, `!document.querySelector('.documents-bar.conflict')`), 5000, "bar cleared");

  // 6. A second document → two tabs.
  await newDocument(c, "New document");
  await until(() => evalIn(c, `document.querySelectorAll('.documents-tab').length === 2`), 10000, "two tabs");
  check("second document adds a tab", true, {
    tabs: await evalIn(c, `[...document.querySelectorAll('.documents-tab-label span')].map((e) => e.textContent)`),
  });

  // 7. The sheet editor (W3): a real grid over a real CSV, formulas computed on screen but stored
  // as TEXT in the file — the property the whole format decision rests on.
  await newDocument(c, "New spreadsheet");
  // The pane's mode toggle is per-pane and was left on Source above; the sheet's structured view is
  // behind the same toggle, labelled Grid.
  // Wait for the ACTIVE TAB to be the new sheet, not merely for a mode toolbar to exist — the
  // markdown tab's own Rich/Source toolbar matches `.documents-modes` and races the click.
  await until(() => evalIn(c, `document.querySelector('.documents-tab[data-active] .documents-tab-label span')?.textContent === 'Untitled spreadsheet'`), 10000, "sheet tab active");
  // The name field is still open on the sheet, and it must be seeded from the SHEET, not from the
  // document created before it — an unkeyed field kept the old value and the next blur renamed the
  // new file to the old name. This is the assertion that caught that.
  check("a second creation re-seeds the open name field", await evalIn(c,
    `document.querySelector('.documents-name-input')?.value === 'Untitled spreadsheet'`));
  const clicked = await evalIn(c, `__live.clickByText('.documents-modes button', 'Grid')`);
  console.log("grid click landed:", clicked);
  for (let i = 0; i < 20; i++) {
    const st = await evalIn(c, `({ rows: document.querySelectorAll('.dsg-row').length, bar: !!document.querySelector('.sheet-formula-bar'), ph: document.querySelector('.documents-surface .pane-placeholder')?.textContent ?? null, src: !!document.querySelector('.documents-source') })`);
    if (st.rows >= 2 && st.bar) break;
    if (i % 4 === 3) console.log("waiting for grid:", JSON.stringify(st));
    await sleep(600);
  }
  await until(() => evalIn(c, `document.querySelectorAll('.dsg-row').length >= 2 && !!document.querySelector('.sheet-formula-bar')`), 5000, "grid mounted");
  check("spreadsheet opens in the grid", true);

  // Type through the real cells with REAL input events (CDP Input domain): the grid resolves the
  // target cell from mouse COORDINATES, so a synthetic bubbled dblclick with clientX/Y = 0,0 lands
  // nowhere. Double-click opens the cell editor; blur commits (the CellView contract).
  const setSheetCell = async (r, cCol, value) => {
    // Let the previous commit's re-render (new grid value identity + autosave kick-off) settle
    // before measuring — a rect taken mid-remount can belong to a row that is about to move.
    await sleep(250);
    const rect = await evalIn(c, `(() => {
      const row = document.querySelectorAll('.dsg-row')[${r + 1}]; // +1: header row is a .dsg-row too
      const cell = row.querySelectorAll('.dsg-cell')[${cCol + 1}]; // +1: gutter column
      const b = cell.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    for (const clickCount of [1, 2]) {
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount });
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount });
    }
    try {
      await until(() => evalIn(c, `!!document.querySelector('.sheet-cell-input')`), 5000, `edit ${r},${cCol}`);
    } catch (e) {
      console.log("edit diagnostics:", JSON.stringify(await evalIn(c, `({
        at: document.elementFromPoint(${rect.x}, ${rect.y})?.className ?? null,
        rows: document.querySelectorAll('.dsg-row').length,
        active: document.querySelector('.dsg-cell.dsg-active') ? true : false,
        focusedTag: document.activeElement?.tagName ?? null,
      })`)), "rect:", JSON.stringify(rect));
      throw e;
    }
    await evalIn(c, `(() => {
      const input = document.querySelector('.sheet-cell-input');
      __live.setInput(input, ${JSON.stringify(value)});
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true; })()`);
    await until(() => evalIn(c, `!document.querySelector('.sheet-cell-input')`), 5000, `commit ${r},${cCol}`);
  };
  await setSheetCell(0, 0, "100");
  await setSheetCell(1, 0, "250");
  await setSheetCell(0, 1, "=A1+A2");
  await until(() => evalIn(c, `[...document.querySelectorAll('.sheet-cell')].some((e) => e.textContent === '350')`), 5000, "computed on screen");
  check("formula computes on screen", true);

  const sheetOnDisk = await until(() => {
    const p = findDoc("Untitled spreadsheet.csv");
    if (!p) return null;
    const t = fs.readFileSync(p, "utf8");
    return t.includes("=A1+A2") ? t : null;
  }, 10000, "sheet autosave");
  check("the FILE stores the formula as text, never the computed value", !sheetOnDisk.includes("350"), { file: sheetOnDisk.split("\n").slice(0, 3) });
  check("values landed in the file", sheetOnDisk.includes("100") && sheetOnDisk.includes("250"));

  // Screenshot for the human verdict.
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "realm-documents-live.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("SCREENSHOT " + shotPath);

  const errs = c.events.filter((e) => !e.includes("Autofill")); // devtools noise
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main().catch(async (e) => {
  console.error("FATAL", e.message);
  process.exitCode = 1;
  // Post-mortem: what was the pane showing, and what did the renderer log?
  try {
    if (globalThis.__c) {
      const dump = await evalIn(globalThis.__c, `({
        tabs: [...document.querySelectorAll('.documents-tab-label span')].map((e) => e.textContent),
        activeTab: document.querySelector('.documents-tab[data-active] .documents-tab-label span')?.textContent ?? null,
        tabTitles: [...document.querySelectorAll('.documents-tab-label')].map((e) => e.title),
        modes: [...document.querySelectorAll('.documents-modes button')].map((e) => e.textContent + ':' + e.getAttribute('aria-pressed')),
        name: document.querySelector('.documents-name, .documents-name-input')?.textContent ?? null,
        sheetEditor: !!document.querySelector('.sheet-editor'),
        formulaBar: !!document.querySelector('.sheet-formula-bar'),
        dsgRows: document.querySelectorAll('.dsg-row').length,
        sourceArea: !!document.querySelector('.documents-source'),
        placeholder: document.querySelector('.documents-surface .pane-placeholder')?.textContent ?? null,
        surface: document.querySelector('.documents-surface')?.innerHTML?.slice(0, 400) ?? null,
        err: document.querySelector('.documents-error')?.textContent ?? null,
      })`);
      console.error("PANE:", JSON.stringify(dump, null, 2).slice(0, 1600));
      const docsDir = path.join(scratch, "home", "personal", "live");
      try { console.error("FILES:", fs.readdirSync(docsDir)); } catch (err) { console.error("FILES: unreadable", err.message); }
      console.error("CONSOLE:", globalThis.__c.events.slice(0, 8));
    }
  } catch (x) { console.error("dump failed", x.message); }
})
  .finally(() => {
    electron?.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
