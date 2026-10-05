/**
 * Live check for the New space sheet (run with: pnpm build && node apps/desktop/scripts/new-space-live.mjs)
 *
 * The sheet is opened the way a person opens it — a real click on the sidebar's "+ New space" — and
 * filled the way they fill it: the name typed into the field that already has the keyboard, an icon
 * from the picker, a colour, a repo DROPPED on the folder row (a real file drag, through CDP, so the
 * dropped File carries the path a Finder drag would), and a line of memory. Then Enter, from the name.
 *
 * What jsdom cannot answer and this does: that the window lands in a session of the new space with
 * the prompter holding the keyboard (no Overview, no page over the panes), that the dropped repo is
 * where that session works, that Escape in the icon picker leaves the sheet up, and what the whole
 * thing looks like in both faces. The light face is the server's own setting and a reload, because
 * the space's tint is clamped per face in JS and a bare `data-mode` flip would not move it.
 *
 * LIVE_MODE=before only photographs the sheet and where Create lands, for a build of the old sheet.
 * Every agent is the fake one: onboarding's session is switched to it over RPC before anything
 * else, and the remembered agent is set to it so the new spaces' sessions start on it too.
 *
 * Ports: env-overridable. Touches only its scratch dir; kills only what holds its own two ports.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9389), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8957);
const MODE = process.env.LIVE_MODE === "before" ? "before" : "after";
/** Chromium's switches for a covered window: lay it out and run its timers anyway. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const scratch = process.env.LIVE_SCRATCH
  ? fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH, "run-"))
  : fs.mkdtempSync(path.join(os.tmpdir(), "realm-new-space-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? scratch;
const home = path.join(scratch, "home");
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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
    }
  });
  return { ws, ready, pending, errors, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready, errors: s.errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  box(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  },
  sheet: () => document.querySelector('[role="dialog"][aria-label="New space"]'),
  focusedLabel: () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? document.activeElement?.tagName,
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A real mouse press at real coordinates — the only thing that exercises hit-testing. */
async function clickAt(c, { cx, cy }) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1 });
  }
}
async function click(c, selector, tag = selector) {
  const b = await until(() => evalIn(c, `__live.box(document.querySelector(${JSON.stringify(selector)}))`), 8000, tag);
  await clickAt(c, b);
  return b;
}

async function press(c, key) {
  const codes = { Enter: ["Enter", 13], Escape: ["Escape", 27] };
  const [code, vk] = codes[key];
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) });
  }
}

/** A folder dragged in from outside the window, the way the Finder hands one over: a drop whose
 *  data is a FILE PATH, so the File the page receives is backed by it and `webUtils` can name it. */
async function dropFolder(c, b, dir, { hold = null } = {}) {
  const data = { items: [], files: [dir], dragOperationsMask: 1 };
  await c.send("Input.dispatchDragEvent", { type: "dragEnter", x: b.cx, y: b.cy, data });
  await c.send("Input.dispatchDragEvent", { type: "dragOver", x: b.cx, y: b.cy, data });
  if (hold) await hold();
  await c.send("Input.dispatchDragEvent", { type: "drop", x: b.cx, y: b.cy, data });
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shot(c, tag, around = null) {
  let clip;
  if (around) {
    const b = await evalIn(c, `__live.box(document.querySelector(${JSON.stringify(around)}))`);
    if (b) clip = { x: Math.max(0, b.x - 28), y: Math.max(0, b.y - 28), width: b.w + 56, height: b.h + 56, scale: 1 };
  }
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, `new-space-${MODE}-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${out}`);
}

/** The window opens behind whatever has the user's attention: tell it it has focus, and keep the
 *  unkeyed-window grey off, or the accent this sheet is drawn in comes out grey. Again after a reload. */
async function keyed(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

async function openSheet(c) {
  await click(c, ".sb-new-space", "the sidebar's New space row");
  await until(() => evalIn(c, `!!__live.sheet()`), 8000, "the New space sheet");
  await sleep(400); // the sheet's own entrance
}

/** Where the window landed after Create, read off the DOM: what is focused, whether a page is over
 *  the panes, and what the focused pane's bar names. */
const LANDING = `(() => {
  const focusedPane = document.querySelector('.panel[data-focused]');
  return {
    sheetOpen: !!__live.sheet(),
    pageOverlay: document.querySelector('.page-overlay')?.getAttribute('aria-label') ?? null,
    spacePage: !!document.querySelector('.space-page-pane'),
    composerFocused: document.activeElement?.classList.contains('composer-input') ?? false,
    focused: __live.focusedLabel(),
    crumb: focusedPane?.querySelector('.panel-crumb, .crumb, .panel-bar')?.textContent?.trim().slice(0, 80) ?? null,
    composers: document.querySelectorAll('.composer-input').length,
  };
})()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  electron = spawn(path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [wrapper, ...UNTHROTTLED], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"] });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl); await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });

  // First run, through its own form — the only way a scratch home gets its first space.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Realm"); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer-input')`), 20000, "onboarding's session");

  // Nothing here talks to a real engine: onboarding's session goes to the fake agent, and so does
  // every session made after it.
  const api = rpc(SERVER_PORT, await daemonToken(home)); await api.ready;
  const first = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "onboarding's session row");
  for (const s of first) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer-input') && !!document.querySelector('.sb-new-space')`), 30000, "the window after reload");
  await keyed(c);
  await sleep(500);

  // A repo to drop: a real git checkout, so the session it opens has a branch to show.
  const repo = path.join(scratch, "code", "versed");
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main && git -c user.email=live@realm.test -c user.name=live commit -q --allow-empty -m init", { cwd: repo });

  if (MODE === "before") {
    await openSheet(c);
    check("before: the sheet opens from the sidebar", true, { focused: await evalIn(c, `__live.focusedLabel()`) });
    await shot(c, "dark-empty", '[role="dialog"][aria-label="New space"]');
    await c.send("Input.insertText", { text: "Versed" });
    await sleep(300);
    await shot(c, "dark-typed", '[role="dialog"][aria-label="New space"]');
    await shot(c, "dark-window");
    await press(c, "Enter");
    await sleep(1500);
    console.log("INFO before: where Create lands", JSON.stringify(await evalIn(c, LANDING)));
    await shot(c, "dark-landed");
    await api.call("settings.set", { key: "ui.theme", value: "light" });
    await c.send("Page.reload", {});
    await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.sb-new-space')`), 30000, "the light face");
    await keyed(c);
    await sleep(500);
    await openSheet(c);
    await c.send("Input.insertText", { text: "Field notes" });
    await sleep(300);
    await shot(c, "light-typed", '[role="dialog"][aria-label="New space"]');
    await shot(c, "light-window");
    api.close(); c.close();
    return;
  }

  /* ── The dark face: everything the sheet offers, then Enter from the name ─────────────────── */
  await openSheet(c);
  check("the name field has the keyboard the moment the sheet is up", await evalIn(c, `__live.focusedLabel()`) === "Space name", await evalIn(c, `__live.focusedLabel()`));
  await shot(c, "dark-empty", '[role="dialog"][aria-label="New space"]');
  // Typed, not set: the field that has focus is the one that takes it.
  await c.send("Input.insertText", { text: "Versed" });
  const location = await until(() => evalIn(c, `document.querySelector('.space-folder-default')?.textContent ?? ''`), 5000, "the default location line")
    .catch(() => "");
  const expected = path.join(home, "personal", "versed");
  check("with no folder, it says where the space's sessions will run, from the server", location.includes(expected), { location, expected });

  // The picker's search has the keyboard once it is up — and Escape in it is the picker's, with the
  // sheet staying up under it.
  await click(c, ".space-tile", "the icon tile");
  await until(() => evalIn(c, `!!document.querySelector('.icon-picker')`), 5000, "the icon picker");
  const searching = await until(() => evalIn(c, `document.activeElement?.closest('.icon-picker') ? document.activeElement.getAttribute('aria-label') : null`), 3000, "the picker's search to take the keyboard")
    .catch(() => null);
  check("the icon picker's search takes the keyboard when it opens", searching === "Search", { focused: await evalIn(c, `__live.focusedLabel()`) });
  await sleep(300);
  await shot(c, "dark-icon-picker");
  await press(c, "Escape");
  await sleep(400);
  const afterEscape = await evalIn(c, `({ picker: !!document.querySelector('.icon-picker'), sheet: !!__live.sheet(), focused: __live.focusedLabel() })`);
  check("Escape in the icon picker closes the picker and leaves the sheet up", !afterEscape.picker && afterEscape.sheet, afterEscape);

  await click(c, ".space-tile", "the icon tile");
  await until(() => evalIn(c, `document.activeElement?.closest('.icon-picker') !== null`), 3000, "the picker's search");
  await c.send("Input.insertText", { text: "rocket" });
  await sleep(200);
  await click(c, '.icon-picker [aria-label="Icon rocket"]', "the rocket");
  await until(() => evalIn(c, `!document.querySelector('.icon-picker')`), 5000, "the picker to close on a pick");
  await click(c, '[role="radio"][aria-label="Color #ff6b8b"]', "a colour");
  await sleep(200);
  const tile = await evalIn(c, `(() => { const t = document.querySelector('.space-tile'); return { color: getComputedStyle(t).color, glyph: !!t.querySelector('svg') }; })()`);
  check("the tile previews the icon in the space's colour as it is picked", tile.glyph && tile.color !== "" && tile.color !== "rgb(0, 0, 0)", tile);

  // The repo, dropped on the folder row — photographed mid-drag, while the row says what a drop does.
  const row = await evalIn(c, `__live.box(document.querySelector('.space-folder'))`);
  await dropFolder(c, row, repo, { hold: async () => { await sleep(250); await shot(c, "dark-dropping", '[role="dialog"][aria-label="New space"]'); } });
  const shown = await until(() => evalIn(c, `document.querySelector('.space-folder-path')?.textContent ?? ''`), 5000, "the dropped folder").catch(() => "");
  check("a folder dropped on the row becomes the space's folder", shown === repo, { shown, repo });

  await click(c, ".new-space-memory-add", "Add memory");
  await until(() => evalIn(c, `document.activeElement?.tagName === 'TEXTAREA'`), 3000, "the memory field to take the keyboard");
  await c.send("Input.insertText", { text: "Use pnpm. Run the tests before handing anything back." });
  await sleep(300);
  await shot(c, "dark-filled", '[role="dialog"][aria-label="New space"]');
  await shot(c, "dark-filled-window");

  // Enter, from the name — the one gesture the fast path is.
  await click(c, 'input[aria-label="Space name"]', "the name field");
  await press(c, "Enter");
  const landed = await until(async () => { const l = await evalIn(c, LANDING); return !l.sheetOpen && l.composerFocused ? l : null; }, 10000, "a session holding the keyboard")
    .catch(async () => evalIn(c, LANDING));
  check("Create lands in a new session with the prompter holding the keyboard", !landed.sheetOpen && landed.composerFocused, landed);
  check("…and not on the space's page", landed.pageOverlay === null && !landed.spacePage, landed);
  await sleep(600);
  await shot(c, "dark-landed");

  const spaces = await api.call("spaces.list", {});
  const versed = spaces.find((s) => s.name === "Versed");
  check("the space carries the icon and colour picked", versed?.icon === "rocket" && versed?.color === "#ff6b8b", versed && { icon: versed.icon, color: versed.color });
  const projects = versed ? await api.call("projects.list", { spaceId: versed.id }) : [];
  check("the dropped repo is the space's first project", projects.length === 1 && projects[0].rootPath === repo, projects.map((p) => p.rootPath));
  const sessions = versed ? (await api.call("sessions.listAll", {})).filter((s) => s.spaceId === versed.id) : [];
  check("one session, on the fake agent, working in the repo", sessions.length === 1 && sessions[0].agentKind === "fake" && sessions[0].cwd === repo,
    sessions.map((s) => ({ agent: s.agentKind, cwd: s.cwd })));
  const memory = versed ? await api.call("memory.get", { spaceId: versed.id }) : null;
  check("the memory typed is the space's memory", memory?.doc === "Use pnpm. Run the tests before handing anything back.", memory?.doc);

  /* ── The light face: an emoji, no folder, Create by the mouse ────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.sb-new-space')`), 30000, "the light face");
  await keyed(c);
  await sleep(500);
  await openSheet(c);
  await c.send("Input.insertText", { text: "Field notes" });
  await click(c, ".space-tile", "the icon tile");
  await click(c, '.icon-picker [role="tab"]:nth-child(2)', "the Emoji tab");
  await until(() => evalIn(c, `!!document.querySelector('.icon-picker .ip-emoji') && document.activeElement?.closest('.icon-picker') !== null`), 10000, "the emoji grid, search focused");
  await c.send("Input.insertText", { text: "seedling" });
  await sleep(300);
  await click(c, ".icon-picker .ip-emoji", "the first emoji");
  await until(() => evalIn(c, `!document.querySelector('.icon-picker')`), 5000, "the picker to close on a pick");
  await click(c, '[role="radio"][aria-label="Color #3ddc97"]', "a colour");
  await until(() => evalIn(c, `(document.querySelector('.space-folder-default')?.textContent ?? '').includes('field-notes')`), 5000, "the default location for the new name").catch(() => false);
  await sleep(300);
  await shot(c, "light-filled", '[role="dialog"][aria-label="New space"]');
  await shot(c, "light-filled-window");
  await click(c, '[role="dialog"][aria-label="New space"] button[type="submit"]', "Create");
  const landedLight = await until(async () => { const l = await evalIn(c, LANDING); return !l.sheetOpen && l.composerFocused ? l : null; }, 10000, "a session holding the keyboard")
    .catch(async () => evalIn(c, LANDING));
  check("light: Create by the mouse lands in the new session too, prompter focused", !landedLight.sheetOpen && landedLight.composerFocused && landedLight.pageOverlay === null, landedLight);
  await sleep(600);
  await shot(c, "light-landed");
  const notes = (await api.call("spaces.list", {})).find((s) => s.name === "Field notes");
  check("light: the emoji is the space's icon", notes?.icon?.startsWith("emoji:"), notes?.icon);
  const notesSessions = notes ? (await api.call("sessions.listAll", {})).filter((s) => s.spaceId === notes.id) : [];
  check("light: with no folder, the session works in the folder the sheet named", notesSessions.length === 1 && notesSessions[0].cwd === notes.folderPath
    && notes.folderPath === path.join(home, "personal", "field-notes"), { cwd: notesSessions[0]?.cwd, folder: notes?.folderPath });

  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  check("no uncaught renderer exceptions", c.errors.length === 0, c.errors.slice(0, 5));
  api.close();
  c.close();
}

/**
 * The server is a SECOND Electron, spawned by the one this started, and killing the parent leaves it
 * holding REALM_PORT. So teardown clears the two ports by owner rather than by pid, which also
 * catches an orphan of an interrupted run; the run refused to start while either was taken, so
 * nothing else can be on them.
 */
async function reap() {
  electron?.kill("SIGKILL");
  await stopDaemons(home).catch(() => {});
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
  }
  // Screenshots are kept when they were written into the scratch dir; the home goes either way.
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(path.join(scratch, "userData"), { recursive: true, force: true });
}
main().catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; }).finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void reap().finally(() => process.exit(1)); });
