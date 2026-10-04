/**
 * Live check for profiles made real (Plan 27 Phase 2). Run with:
 *   pnpm build && node apps/desktop/scripts/profiles-live.mjs
 *
 * Boots the BUILT app on a scratch REALM_HOME and a scratch userData, serves a tiny sign-in site on
 * 127.0.0.1, and checks in the real windows:
 *
 *   1. The first profile keeps the browser partition every pane used to share: a cookie already in
 *      `persist:browser` is still there for its panes.
 *   2. A profile made in the New profile sheet gets a partition of its own.
 *   3. "Open Work in a new window" opens a second window bound to Work, and each window shows its own
 *      profile's spaces; asking again brings the same window forward rather than opening a third.
 *   4. A cookie set in Personal is absent in Work; each pane's view lives in its own profile's
 *      partition and in its own window; each profile's pane fetched the site's icon on its own
 *      partition, with no cookie.
 *   5. The pane's ⋯ menu "Share this site's sign-in with ▸ Work" copies the site's cookies, and Work's
 *      pane is then signed in; Personal keeps its own.
 *   6. Clear browsing data in Work clears Work's jar only, behind a confirm that names Work.
 *   7. A sign-in saved in Personal (Settings ▸ Sign-ins) is invisible in Work until Share with ▸ Work.
 *   7b. A space moved from Personal to Work leaves Personal's window for Work's, and its browser opens
 *      there in Work's jar — a new view, which main knows is Work's — and back again.
 *   8. Deleting Work is guarded — it counts what goes, and only the typed name arms it — and takes
 *      Work's window, cookies and sign-ins with it; the last profile cannot be deleted.
 *
 * Ports: LIVE_SERVER_PORT (8976), LIVE_CDP_PORT (9376), LIVE_MAIN_INSPECT_PORT (9476), LIVE_SITE_PORT
 * (8986). Touches only a scratch dir; kills only what is listening on its own ports. Browses nothing but
 * its own fixture. Nothing is billed: every session is moved to the fake agent before anything else,
 * and nothing is ever typed into a composer. The secret store's Keychain item is named for this run's
 * scratch dir (the app is renamed before Electron names the item) and deleted at the end; the run
 * checks that item was the one used.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9376);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8976);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8986);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9476);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-profiles-live-"));
const home = path.join(scratch, "home");
const userData = path.join(scratch, "userData");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
/** The app's name for this run, which is what Electron names its Keychain item after. */
const APP_NAME = `Realm Profiles Live ${path.basename(scratch).slice(-6)}`;
const KEYCHAIN_SERVICE = `${APP_NAME} Safe Storage`;
const WINDOW = { width: 1400, height: 880 };
const OUT = (tag) => path.join(os.tmpdir(), `realm-profiles-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;
const daemonPids = [];

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

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
    await sleep(200);
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

/** An expression in main, with `require` — the Electron objects themselves, not what a page says. */
async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** Whether this run's own Keychain item exists. Attributes only — never the secret. */
function keychainItemExists() {
  try { execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" }); return true; } catch { return false; }
}

/** A 16px PNG, a solid square — enough for a tab to draw, encoded here so it is a real PNG. */
function squarePng() {
  const size = 16;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([22, 163, 74, 255], y * (size * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const ICON = squarePng();
/** Every request for the site's icon, with the cookie it carried — which must be none. */
const iconAsks = [];

/**
 * The sign-in site. `/` says who it thinks you are from the `session` cookie; `/login?user=x` signs
 * you in (an HttpOnly session cookie and a plain preference cookie) and sends you home.
 */
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", SITE);
      const cookies = Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]));
      if (url.pathname === "/login") {
        const user = url.searchParams.get("user") ?? "someone";
        res.writeHead(302, { location: "/", "set-cookie": [`session=${user}; Path=/; HttpOnly; Max-Age=86400`, "pref=compact; Path=/; Max-Age=86400"] });
        return res.end();
      }
      if (url.pathname === "/") {
        const who = cookies.session ? `Signed in as ${cookies.session}` : "Signed out";
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><meta charset=utf-8><title>${who}</title><link rel="icon" href="/icon.png"><body style="margin:0;font:28px -apple-system;padding:32px;background:#fff"><h1>${who}</h1><p>${SITE}</p></body>`);
      }
      if (url.pathname === "/icon.png") {
        iconAsks.push({ cookie: req.headers.cookie ?? null });
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(ICON);
      }
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>Not found</title>");
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** Boot the built app on the scratch home and attach to its first window and its main process. */
async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) await until(() => portFree(p), 10_000, `port ${p} free`);
  // CommonJS, so the rename runs synchronously while Electron loads the entry — before it names the
  // Keychain item it seals the secret store's keyring under. An ESM entry evaluates later.
  const wrapper = path.join(scratch, "wrapper.cjs");
  fs.writeFileSync(wrapper, [
    'const { app } = require("electron");',
    "app.setName(process.env.LIVE_APP_NAME);",
    // The inspector's console offers no require with a CommonJS entry; the checks read main through it.
    "globalThis.require = require;",
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      LIVE_APP_NAME: APP_NAME,
      LIVE_USER_DATA: userData,
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);
  const first = await until(async () => (await rendererTargets())[0], 60_000, "renderer target");
  const c = await attachRenderer(first);
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  return { c, m, firstId: first.id };
}

/** Every Realm window's renderer — the app's own pages, not a browser pane's. */
const rendererTargets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())
  .then((list) => list.filter((t) => t.type === "page" && t.url.startsWith("file://"))).catch(() => []);

/** Attach to a window's renderer, with focus emulated and the window held key, so nothing a check
 *  reads is greyed for a window that macOS happens to think is in the background. */
async function attachRenderer(target) {
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => {
    const root = document.documentElement;
    const hold = () => { if (root.hasAttribute("data-window-inactive")) root.removeAttribute("data-window-inactive"); };
    hold();
    new MutationObserver(hold).observe(root, { attributes: true, attributeFilter: ["data-window-inactive"] });
    return true; })()`);
  return c;
}

async function shutDown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  api = null;
  electron?.kill("SIGKILL");
  electron = null;
  await sleep(500);
  daemonPids.push(...(await stopDaemons(home, daemonPids)));
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
}

/** The window as its renderer draws it. Native views (the pages) are not in a DOM capture; those are
 *  captured from main, below. */
async function shot(c, tag) {
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
}

/** Run a command from the palette: type the query, click the option that says `option`. */
async function palette(c, query, option) {
  await evalIn(c, `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector(".palette input"); i++) await wait(25);
    const input = document.querySelector(".palette input");
    if (!input) throw new Error("the palette did not open");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 80; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((b) => b.textContent.includes(${JSON.stringify(option)}));
      if (hit) { hit.click(); return true; }
      await wait(25);
    }
    throw new Error("no palette option: " + ${JSON.stringify(option)});
  })()`);
  await sleep(300);
}

/** Set a React-controlled field's value the way typing does. */
const typeInto = (selectorExpr, value) => `(() => {
  const input = ${selectorExpr};
  if (!input) throw new Error("no field for " + ${JSON.stringify(value)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true; })()`;
/** The input inside a `<label>` whose text starts with `text`. */
const fieldByLabel = (text) => `[...document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(${JSON.stringify(text)}))?.querySelector("input")`;
/** A button by its text, inside an optional scope. */
const buttonByText = (text, scope = "document") => `[...${scope}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

/** Every fixture view main holds: which window it composites into, which partition it lives in, and
 *  the page it is on. Read off the Electron objects, never off anything a page says. */
const fixtureViews = (m) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView, session } = require("electron");
  const out = [];
  for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
    if (!(v instanceof WebContentsView)) continue;
    const url = v.webContents.getURL();
    if (!url.startsWith(${JSON.stringify(SITE)})) continue;
    const parts = ["persist:browser", ...(globalThis.__livePartitions ?? [])];
    // By where the session keeps its data on disk: two Session handles for one partition need not be
    // the same object, and the storage path is the partition.
    const partition = parts.find((p) => session.fromPartition(p).getStoragePath() === v.webContents.session.getStoragePath()) ?? "(unknown)";
    out.push({ window: w.getTitle(), windowId: w.id, partition, url, title: v.webContents.getTitle(), shown: v.getVisible() });
  }
  return out;
})()`);

/** One partition's cookies for the site, by name. */
const cookiesIn = (m, partition) => inMain(m, `require("electron").session.fromPartition(${JSON.stringify(partition)}).cookies.get({ url: ${JSON.stringify(SITE)} }).then((cs) => Object.fromEntries(cs.map((c) => [c.name, c.value])))`);

/** Capture a fixture view's own picture from main — what the person sees in the pane. */
const captureView = (m, partition, tag) => inMain(m, `(async () => {
  const { BrowserWindow, WebContentsView, session } = require("electron");
  for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children) {
    if (!(v instanceof WebContentsView) || v.webContents.session.getStoragePath() !== session.fromPartition(${JSON.stringify(partition)}).getStoragePath()) continue;
    if (!v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) continue;
    const img = await v.webContents.capturePage();
    require("node:fs").writeFileSync(${JSON.stringify(OUT(tag))}, img.toPNG());
    return true;
  }
  return false;
})()`).then((ok) => { if (ok) console.log(`SCREENSHOT ${tag} ${OUT(tag)}`); else note("no view to capture", tag); });

/** Reload the fixture view living in a partition, and wait for the page to settle. */
const reloadView = async (m, partition) => {
  await inMain(m, `(() => {
    const { BrowserWindow, WebContentsView, session } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) for (const v of w.contentView.children)
      if (v instanceof WebContentsView && v.webContents.session.getStoragePath() === session.fromPartition(${JSON.stringify(partition)}).getStoragePath() && v.webContents.getURL().startsWith(${JSON.stringify(SITE)})) v.webContents.reload();
    return true; })()`);
  await sleep(1200);
};

/** The last native menu main was asked to pop, as the OS would draw it. */
const lastMenu = (m) => inMain(m, `(() => {
  const L = globalThis.__live; const last = L.menus[L.menus.length - 1]; if (!last) return null;
  const rows = (items) => items.map((i) => ({ label: i.label, enabled: i.enabled, sub: i.submenu ? rows(i.submenu.items) : null }));
  return { count: L.menus.length, rows: rows(last.menu.items) };
})()`);
/** Click a row of the last native menu the way a person does, then close it as the OS does. */
const clickMenuRow = (m, labels) => inMain(m, `(() => {
  const L = globalThis.__live; const last = L.menus[L.menus.length - 1]; if (!last) return "no menu";
  let items = last.menu.items, item = null;
  for (const label of ${JSON.stringify(labels)}) {
    item = items.find((i) => i.label === label);
    if (!item) return "no row " + label + " in " + items.map((i) => i.label).join(" | ");
    items = item.submenu ? item.submenu.items : [];
  }
  if (!item.enabled) return "disabled: " + item.label;
  item.click();
  if (last.opts.callback) last.opts.callback();
  return "ok";
})()`);
/** Press a pane's ⋯ (the first window's, or a given renderer's) and wait for main's native menu. */
async function openPaneMenu(c, m) {
  const before = (await lastMenu(m))?.count ?? 0;
  await evalIn(c, `(() => { const b = [...document.querySelectorAll('.browser-pane .browser-more')].find((x) => x.offsetParent !== null); b.click(); return true; })()`);
  return until(async () => { const menu = await lastMenu(m); return menu && menu.count > before ? menu : null; }, 10_000, "a native menu");
}

/** The status line the browser pane's toast shows. */
const paneToast = (c) => evalIn(c, `[...document.querySelectorAll('.browser-pane [role=status]')].map((s) => s.textContent).join(" | ")`);

/** Open an existing item from a window's palette by its title — the one in `spaceName` when the
 *  title repeats (another space's row names its space in the hint; the current space's does not, and
 *  is listed first). */
async function openFromPalette(c, title, spaceName) {
  await evalIn(c, `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector(".palette input"); i++) await wait(25);
    const input = document.querySelector(".palette input");
    if (!input) throw new Error("the palette did not open");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(title)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 120; i++) {
      const opts = [...document.querySelectorAll(".palette-list [role=option]")].filter((o) => o.querySelector(".palette-label")?.textContent === ${JSON.stringify(title)});
      const hit = opts.find((o) => (o.querySelector(".palette-hint")?.textContent ?? "").includes(${JSON.stringify(spaceName)})) ?? opts[0];
      if (hit) { hit.click(); return true; }
      await wait(25);
    }
    throw new Error("no palette row titled " + ${JSON.stringify(title)});
  })()`);
  await sleep(300);
}

/** Open a browser on SITE in this space. The sidebar lists sessions only, so a browser made on its own
 *  is reached the way any item is — through the palette, where it is the one still titled "Browser"
 *  until its page has loaded and named it. */
async function openBrowserIn(c, spaceId) {
  const { browserId } = await api.call("browsers.create", { spaceId, url: `${SITE}/` });
  const space = (await api.call("spaces.list", {})).find((sp) => sp.id === spaceId);
  await openFromPalette(c, "Browser", space.name);
  return browserId;
}

/** A browser's item, as the server has it now — its title follows the page it last showed. */
const browserItem = async (spaceId, browserId) => (await api.call("items.list", { spaceId })).find((i) => i.refId === browserId);

/** Settings ▸ Sign-ins in one window, opened as its menu bar would. */
async function openSignIns(c, m, windowId) {
  await inMain(m, `(() => { require("electron").BrowserWindow.fromId(${windowId}).webContents.send("app:command", "settings.open"); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.settings-page-pane')`), 10_000, "settings");
  await evalIn(c, `(() => { document.querySelector('.settings-page-pane .page-rail input[value="signins"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="saved-signins"]')`), 10_000, "the sign-ins tab");
  await sleep(500);
}
const signInRows = (c) => evalIn(c, `[...document.querySelectorAll('[data-setting="saved-signins"] li')].map((li) => li.getAttribute('aria-label'))`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js"))) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  if (keychainItemExists()) throw new Error(`a Keychain item named ${KEYCHAIN_SERVICE} already exists — refusing to share it`);
  const marker = path.join(scratch, "marker");
  fs.writeFileSync(marker, "");
  const claudeBefore = new Set(fs.readdirSync(path.join(os.homedir(), ".claude/projects")));
  site = await startSite();
  const { c, m, firstId } = await launch();

  // Main's OS pieces stood in for, so nothing waits on a person: the native menu records what it was
  // asked to show, and the confirm answers what the check says.
  await inMain(m, `(() => {
    const { Menu, dialog } = require("electron");
    const L = globalThis.__live = { menus: [], dialogs: [], dialogAnswer: 1 };
    Menu.prototype.popup = function (opts) { L.menus.push({ menu: this, opts: opts || {} }); };
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      L.dialogs.push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: L.dialogAnswer, checkboxChecked: false };
    };
    return true; })()`);

  // ── 1. A cookie already in the shared jar, before any pane exists ─────────────────────────────
  await inMain(m, `require("electron").session.fromPartition("persist:browser").cookies.set({ url: ${JSON.stringify(SITE)}, name: "session", value: "legacy", expirationDate: Math.floor(Date.now() / 1000) + 86400 })
    .then(() => require("electron").session.fromPartition("persist:browser").cookies.flushStore()).then(() => true)`);

  // Onboarding makes the space. Its first session runs a REAL engine, so it goes to the fake agent
  // before anything else, and nothing is typed into it.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, typeInto(`document.querySelector('.onboarding input:not([type=radio])')`, "Live"));
  await evalIn(c, `(() => { document.querySelector('.onboarding input:not([type=radio])').closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [live] = await api.call("spaces.list", {});
  for (const s of await api.call("sessions.list", { spaceId: live.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const [personal] = await api.call("profiles.list", {});
  await inMain(m, `(() => { for (const w of require("electron").BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  check("the first profile keeps the partition every pane used to share", personal.browserPartition === "persist:browser", personal);
  check("the secret store's keyring is sealed under this run's own Keychain item", await until(async () => keychainItemExists(), 15_000, "keychain item").catch(() => false), { service: KEYCHAIN_SERVICE });

  // ── 2. A profile from the New profile sheet ───────────────────────────────────────────────────
  await palette(c, "New profile", "New profile…");
  await until(() => evalIn(c, `!!document.querySelector('[role=dialog][aria-label="New profile"]')`), 5_000, "the New profile sheet");
  await evalIn(c, typeInto(`document.querySelector('[role=dialog] input[aria-label="Profile name"]')`, "Work"));
  await evalIn(c, `(() => { document.querySelector('[role=dialog] [aria-label="Icon briefcase"]').click(); document.querySelector('[role=dialog] [aria-label="Colour #4cc9f0"]').click(); return true; })()`);
  await sleep(200);
  await shot(c, "new-profile-sheet");
  await evalIn(c, `(() => { ${buttonByText("Create profile")}.click(); return true; })()`);
  const work = await until(async () => (await api.call("profiles.list", {})).find((p) => p.name === "Work"), 10_000, "Work");
  check("a profile made in the New profile sheet has the name, icon and colour chosen, and a partition of its own",
    work.icon === "briefcase" && work.color === "#4cc9f0" && work.browserPartition === `persist:browser-${work.id}`, work);
  const WORK_PARTITION = work.browserPartition;
  await inMain(m, `(() => { globalThis.__livePartitions = [${JSON.stringify(WORK_PARTITION)}]; return true; })()`);
  const clients = await api.call("spaces.create", { profileId: work.id, name: "Clients" });

  // ── 1, continued: the first profile's pane sees the cookie that was already in its jar ─────────
  const personalBrowser = await openBrowserIn(c, live.id);
  const pView = await until(async () => (await fixtureViews(m)).find((v) => v.title.startsWith("Signed")), 20_000, "Personal's view").catch(() => null);
  check("the first profile's pane is in persist:browser and still signed in with the cookie that was there before",
    pView?.partition === "persist:browser" && pView.title === "Signed in as legacy", pView);

  // Sign in as alice in Personal's pane, through its own address bar.
  await evalIn(c, `(() => { const i = [...document.querySelectorAll('.browser-address input')].find((x) => x.offsetParent !== null); i.focus(); return true; })()`);
  await evalIn(c, typeInto(`[...document.querySelectorAll('.browser-address input')].find((x) => x.offsetParent !== null)`, `${SITE}/login?user=alice`));
  await evalIn(c, `(() => { [...document.querySelectorAll('.browser-address input')].find((x) => x.offsetParent !== null).closest("form").requestSubmit(); return true; })()`);
  await until(async () => (await fixtureViews(m)).some((v) => v.partition === "persist:browser" && v.title === "Signed in as alice"), 15_000, "alice in Personal");
  await captureView(m, "persist:browser", "personal-pane-alice");

  // ── 3. Work in a window of its own ────────────────────────────────────────────────────────────
  await palette(c, "Open Work", "Open Work in a new window");
  const secondTarget = await until(async () => (await rendererTargets()).find((t) => t.id !== firstId), 30_000, "a second window");
  const c2 = await attachRenderer(secondTarget);
  await inMain(m, `(() => { for (const w of require("electron").BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  const bound = await evalIn(c2, `window.realm.profileId ?? null`);
  check("the second window is bound to Work (window.realm.profileId)", bound === work.id, { bound, work: work.id });
  await until(() => evalIn(c2, `!!document.querySelector('.sb-section[aria-label="Clients"]')`), 20_000, "Work's window listing Clients").catch(() => {});
  const side = async (cc) => evalIn(cc, `({ profile: document.querySelector('.sb-profile')?.getAttribute('aria-label') ?? null,
    spaces: [...document.querySelectorAll('.sb-section')].map((sec) => sec.getAttribute('aria-label')) })`);
  const w1 = await side(c); const w2 = await side(c2);
  check("each window shows its own profile's spaces — Personal's in the first, Work's in the second",
    w1.spaces.join() === "Live" && w2.spaces.join() === "Clients", { first: w1, second: w2 });
  const titles = await inMain(m, `require("electron").BrowserWindow.getAllWindows().map((w) => ({ id: w.id, title: w.getTitle() }))`);
  check("each window is titled by the profile it shows — what the Window menu lists", titles.map((t) => t.title).sort().join() === "Personal,Work", titles);
  const workWindowId = titles.find((t) => t.title === "Work").id;
  const personalWindowId = titles.find((t) => t.title === "Personal").id;
  await shot(c, "window-personal");
  await shot(c2, "window-work");
  // Asking again brings the same window forward rather than opening a third.
  await palette(c, "Open Work", "Open Work in a new window");
  await sleep(1500);
  const count = (await rendererTargets()).length;
  const focused = await inMain(m, `require("electron").BrowserWindow.getFocusedWindow()?.getTitle() ?? null`);
  check("opening Work again brings its window forward instead of opening another", count === 2, { windows: count, focused });

  // ── 4. A cookie set in Personal is absent in Work ─────────────────────────────────────────────
  await openBrowserIn(c2, clients.id);
  const wView = await until(async () => (await fixtureViews(m)).find((v) => v.partition === WORK_PARTITION && v.title.startsWith("Signed")), 20_000, "Work's view").catch(() => null);
  check("Work's pane lives in Work's own partition, in Work's window, and is signed out",
    wView?.windowId === workWindowId && wView.title === "Signed out", wView);
  const before = { personal: await cookiesIn(m, "persist:browser"), work: await cookiesIn(m, WORK_PARTITION) };
  check("a cookie set in Personal is absent in Work", before.personal.session === "alice" && before.work.session === undefined, before);
  await captureView(m, WORK_PARTITION, "work-pane-signed-out");
  // The icon: each profile's pane asked for it on its OWN partition — two asks, since one profile's
  // memory of icons is not another's — and neither carried the cookies the page had set.
  // Read off the pane: a loose browser has no sidebar row now, and its tab or bar draws the icon.
  const workIcon = await until(() => evalIn(c2, `(() => { const img = [...document.querySelectorAll('.panehost img.page-icon')].find((x) => x.offsetParent !== null); return !!img && img.naturalWidth > 0; })()`), 10_000, "Work's pane icon").catch(() => false);
  check("each profile's pane fetched the site's icon on its own partition, and with no cookie",
    workIcon && iconAsks.length === 2 && iconAsks.every((a) => a.cookie === null), { workIcon, iconAsks });

  // ── 5. Share this site's sign-in with ▸ Work ──────────────────────────────────────────────────
  const menu = await openPaneMenu(c, m);
  const shareRow = menu.rows.find((r) => r.label === "Share this site's sign-in with");
  check("the pane's ⋯ menu offers to share this site's sign-in with Work — and not with its own profile",
    !!shareRow && shareRow.enabled && shareRow.sub.map((r) => r.label).join() === "Work", shareRow);
  const clicked = await clickMenuRow(m, ["Share this site's sign-in with", "Work"]);
  await sleep(1000);
  const shareToast = await paneToast(c);
  const after = { personal: await cookiesIn(m, "persist:browser"), work: await cookiesIn(m, WORK_PARTITION) };
  check("sharing copies the site's cookies into Work, and says so", clicked === "ok" && after.work.session === "alice" && after.work.pref === "compact"
    && shareToast.includes(`Shared 127.0.0.1's sign-in with Work.`), { clicked, after, shareToast });
  check("…and Personal keeps its own — a copy, not a move", after.personal.session === "alice", after.personal);
  await reloadView(m, WORK_PARTITION);
  const wSigned = (await fixtureViews(m)).find((v) => v.partition === WORK_PARTITION);
  check("Work's pane is signed in once the page reloads", wSigned?.title === "Signed in as alice", wSigned);
  await captureView(m, WORK_PARTITION, "work-pane-shared");

  // ── 6. Clear browsing data in Work clears Work's jar only ─────────────────────────────────────
  await inMain(m, `(() => { globalThis.__live.dialogAnswer = 0; return true; })()`);
  await openPaneMenu(c2, m);
  await clickMenuRow(m, ["Clear browsing data…"]);
  await sleep(1200);
  const dialog = await inMain(m, `globalThis.__live.dialogs.at(-1) ?? null`);
  const cleared = { personal: await cookiesIn(m, "persist:browser"), work: await cookiesIn(m, WORK_PARTITION) };
  check("Clear browsing data asks about Work by name, and clears Work's jar and only Work's",
    dialog?.message === "Clear browsing data for Work?" && Object.keys(cleared.work).length === 0 && cleared.personal.session === "alice", { dialog, cleared });
  await inMain(m, `(() => { globalThis.__live.dialogAnswer = 1; return true; })()`);
  // A clear forgets the profile's icons too — in the pane already open, not just in the next one.
  const asksBeforeReload = iconAsks.length;
  await reloadView(m, WORK_PARTITION);
  await until(() => iconAsks.length > asksBeforeReload, 10_000, "the icon asked for again").catch(() => {});
  check("…and forgets Work's icons, so Work's open pane asks for the site's icon again", iconAsks.length === asksBeforeReload + 1, { before: asksBeforeReload, after: iconAsks.length });

  // ── 7. A sign-in saved in Personal is invisible in Work until shared ──────────────────────────
  await openSignIns(c, m, personalWindowId);
  await evalIn(c, `(() => { ${buttonByText("Add a sign-in")}.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[role=dialog][aria-label="Add a sign-in"]')`), 5_000, "the add sheet");
  await evalIn(c, typeInto(fieldByLabel("Site address"), SITE));
  await evalIn(c, typeInto(fieldByLabel("Username"), "alice"));
  await evalIn(c, typeInto(fieldByLabel("Password"), "correct horse battery staple"));
  await evalIn(c, `(() => { ${buttonByText("Save sign-in")}.click(); return true; })()`);
  const saved = await until(async () => { const rows = await signInRows(c); return rows.length > 0 ? rows : null; }, 10_000, "the saved row").catch(async () => ({ rows: await signInRows(c), alerts: await evalIn(c, `[...document.querySelectorAll('[role=alert]')].map((a) => a.textContent)`) }));
  check("a sign-in saved in Personal's Settings is listed there", Array.isArray(saved) && saved.join() === `${SITE}: alice`, saved);
  await openSignIns(c2, m, workWindowId);
  const workBefore = await signInRows(c2);
  const workEmpty = await evalIn(c2, `!!document.querySelector('[data-setting="saved-signins"] .creds-empty')`);
  const workSays = await evalIn(c2, `document.querySelector('[data-setting="signins-profile"]')?.textContent ?? null`);
  check("…and is invisible in Work's", workBefore.length === 0 && workEmpty && /These are Work's/.test(workSays ?? ""), { workBefore, workSays });
  await shot(c, "signins-personal");
  // Share with ▸ Work, from Personal's row.
  await evalIn(c, `(() => { const row = [...document.querySelectorAll('[data-setting="saved-signins"] li')][0]; ${buttonByText("Share with…", "row")}.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[role=menu]')`), 5_000, "the share menu");
  const offered = await evalIn(c, `[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((i) => i.textContent.trim())`);
  await evalIn(c, `(() => { [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((i) => i.textContent.trim() === 'Work').click(); return true; })()`);
  const receipt = await until(() => evalIn(c, `document.querySelector('[data-setting="saved-signins"] [role=status]')?.textContent ?? null`), 5_000, "the receipt").catch(() => null);
  check("Share with offers Work, and says what happened", offered.join() === "Work" && receipt === "Shared with Work.", { offered, receipt });
  await shot(c, "signins-personal-shared");
  // Work's list, read again.
  await evalIn(c2, `(() => { document.querySelector('.settings-page-pane .page-rail input[value="general"]').click(); return true; })()`);
  await sleep(300);
  await evalIn(c2, `(() => { document.querySelector('.settings-page-pane .page-rail input[value="signins"]').click(); return true; })()`);
  const workAfter = await until(async () => { const rows = await signInRows(c2); return rows.length > 0 ? rows : null; }, 10_000, "Work's shared row").catch(() => []);
  check("…after which Work has its own copy", workAfter.join() === `${SITE}: alice`, workAfter);
  await shot(c2, "signins-work-shared");
  const file = JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8"));
  check("on disk each sign-in names its profile, and holds no password", file.version === 2
    && file.credentials.map((r) => r.profileId).sort().join() === [personal.id, work.id].sort().join()
    && !JSON.stringify(file).includes("correct horse"), file.credentials.map((r) => ({ profileId: r.profileId, origin: r.origin })));

  // ── 7b. A space moved to another profile takes its browser into that profile's jar ────────────
  // One window per profile: the moved space leaves Personal's window and is Work's to show, where its
  // browser opens in Work's jar — and, moved back, opens in Personal's again.
  await evalIn(c, `(() => { document.querySelector('.page-overlay-bar [aria-label^="Close"]')?.click(); return true; })()`);
  await evalIn(c2, `(() => { document.querySelector('.page-overlay-bar [aria-label^="Close"]')?.click(); return true; })()`);
  const spare = await api.call("spaces.create", { profileId: personal.id, name: "Spare" });
  await until(() => evalIn(c, `!!document.querySelector('.sb-section[aria-label="Spare"]')`), 10_000, "Spare in the sidebar");
  const spareBrowser = await openBrowserIn(c, spare.id);
  await until(async () => (await fixtureViews(m)).some((v) => v.windowId === personalWindowId && v.shown && v.partition === "persist:browser" && v.title === "Signed in as alice"), 15_000, "Spare's view in Personal's jar");
  await api.call("spaces.update", { id: spare.id, profileId: work.id });
  const handedOver = await until(async () => (await evalIn(c2, `!!document.querySelector('.sb-section[aria-label="Spare"]')`))
    && !(await evalIn(c, `!!document.querySelector('.sb-section[aria-label="Spare"]')`)), 10_000, "Spare in Work's window, out of Personal's").catch(() => false);
  await openFromPalette(c2, (await browserItem(spare.id, spareBrowser)).title, "Spare");
  const moved = await until(async () => (await fixtureViews(m)).find((v) => v.windowId === workWindowId && v.shown && v.partition === WORK_PARTITION && v.title.startsWith("Signed")), 15_000, "Spare's view in Work's jar").catch(() => null);
  const movedMenu = await openPaneMenu(c2, m);
  await inMain(m, `(() => { const L = globalThis.__live; const last = L.menus.at(-1); last?.opts.callback?.(); return true; })()`);
  const movedShare = movedMenu.rows.find((r) => r.label === "Share this site's sign-in with");
  check("a space moved to Work goes to Work's window, and its browser opens there in Work's jar — signed out, and main knows the view is Work's",
    handedOver === true && moved?.title === "Signed out" && movedShare?.sub?.map((r) => r.label).join() === "Personal", { handedOver, moved, shareTo: movedShare?.sub?.map((r) => r.label) ?? null });
  await api.call("spaces.update", { id: spare.id, profileId: personal.id });
  await until(() => evalIn(c, `!!document.querySelector('.sb-section[aria-label="Spare"]')`), 10_000, "Spare back in Personal's window");
  await openFromPalette(c, (await browserItem(spare.id, spareBrowser)).title, "Spare");
  const back = await until(async () => (await fixtureViews(m)).find((v) => v.windowId === personalWindowId && v.shown && v.partition === "persist:browser" && v.title.startsWith("Signed")), 15_000, "Spare back in Personal's jar").catch(() => null);
  check("…and moved back, it opens in Personal's jar again, signed in", back?.title === "Signed in as alice", back);
  await api.call("browsers.close", { browserId: spareBrowser }).catch(() => {});
  await api.call("spaces.delete", { id: spare.id });
  await until(() => evalIn(c, `!document.querySelector('.sb-section[aria-label="Spare"]')`), 10_000, "Spare gone from the sidebar").catch(() => {});
  // Live's browser back on screen for what follows: Spare's took its place in the view.
  await openFromPalette(c, (await browserItem(live.id, personalBrowser)).title, "Live");
  await until(async () => (await fixtureViews(m)).some((v) => v.windowId === personalWindowId && v.shown && v.partition === "persist:browser"), 15_000, "Live's browser on screen");

  // ── 8. Deleting Work is guarded ───────────────────────────────────────────────────────────────
  // Work holds the site's cookies again, so the delete has a jar to clear.
  await openPaneMenu(c, m);
  await clickMenuRow(m, ["Share this site's sign-in with", "Work"]);
  await sleep(800);
  await evalIn(c2, `(() => { document.querySelector('.page-overlay-bar [aria-label^="Close"]')?.click(); return true; })()`);
  await palette(c2, "Open profile", "Open profile");
  await until(() => evalIn(c2, `!!document.querySelector('.profile-page-pane')`), 10_000, "Work's profile page");
  await evalIn(c2, `(() => { ${buttonByText("Delete profile…")}.click(); return true; })()`);
  const confirmText = await until(() => evalIn(c2, `(() => { const g = document.querySelector('.profile-delete'); const t = g?.querySelector('.settings-hint')?.textContent; return t && /space/.test(t) && !/its spaces and every/.test(t) ? t : null; })()`), 10_000, "the counts").catch(() => null);
  const go = `[...document.querySelectorAll('.profile-delete button')].find((b) => b.textContent.trim() === 'Delete Work')`;
  const disabledAtFirst = await evalIn(c2, `${go}?.disabled ?? null`);
  await evalIn(c2, typeInto(`document.querySelector('.profile-delete input')`, "Wor"));
  const disabledWrong = await evalIn(c2, `${go}?.disabled ?? null`);
  await evalIn(c2, typeInto(`document.querySelector('.profile-delete input')`, "Work"));
  const enabledRight = await evalIn(c2, `${go}?.disabled === false`);
  await shot(c2, "delete-profile-guard");
  check("deleting Work says what goes with it and is armed only by typing Work",
    /Deleting Work deletes its 1 space and \d+ sessions?\./.test(confirmText ?? "") && disabledAtFirst === true && disabledWrong === true && enabledRight === true,
    { confirmText, disabledAtFirst, disabledWrong, enabledRight });
  await evalIn(c2, `(() => { ${go}.click(); return true; })()`);
  await until(async () => !(await api.call("profiles.list", {})).some((p) => p.id === work.id), 15_000, "Work deleted");
  await sleep(1500);
  const left = await inMain(m, `require("electron").BrowserWindow.getAllWindows().map((w) => w.getTitle())`);
  const jar = await cookiesIn(m, WORK_PARTITION);
  const fileAfter = JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8"));
  check("…and takes Work's window, its cookies and its sign-ins with it; Personal's stay",
    left.join() === "Personal" && Object.keys(jar).length === 0 && fileAfter.credentials.every((r) => r.profileId === personal.id) && fileAfter.credentials.length === 1
      && (await cookiesIn(m, "persist:browser")).session === "alice",
    { windows: left, workJar: jar, rows: fileAfter.credentials.map((r) => r.profileId) });
  // The last profile cannot go.
  await evalIn(c, `(() => { document.querySelector('.page-overlay-bar [aria-label^="Close"]')?.click(); return true; })()`);
  await sleep(300);
  await palette(c, "Open profile", "Open profile");
  await until(() => evalIn(c, `!!document.querySelector('.profile-page-pane')`), 10_000, "Personal's profile page");
  const last = await evalIn(c, `({ disabled: ${buttonByText("Delete profile…")}?.disabled ?? null, why: [...document.querySelectorAll('.danger-zone .muted')].map((s) => s.textContent).join(" ") })`);
  check("the last profile cannot be deleted, and the page says why", last.disabled === true && last.why.includes("This is the only profile"), last);
  await shot(c, "last-profile");

  // Nothing of this run reached the user's own agent homes.
  const claudeAfter = fs.readdirSync(path.join(os.homedir(), ".claude/projects")).filter((d) => !claudeBefore.has(d));
  let newer = "";
  try { newer = execFileSync("find", [path.join(os.homedir(), ".claude/projects"), "-maxdepth", "1", "-newer", marker], { encoding: "utf8" }).trim(); } catch { /* none */ }
  note("~/.claude/projects entries touched since the run began (this session's own transcript dir is expected)", newer.split("\n").filter(Boolean));
  check("no new project appeared under ~/.claude/projects", claudeAfter.length === 0, claudeAfter);
  note("browser that started it all", { personalBrowser });
}

async function teardown() {
  await shutDown().catch(() => {});
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  killPort(SITE_PORT);
  // This run's own Keychain item, and nothing else.
  try { execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" }); } catch { /* never made */ }
  if (keychainItemExists()) { process.exitCode = 1; console.log(`FAIL the Keychain item ${KEYCHAIN_SERVICE} could not be removed`); }
  if (process.env.LIVE_KEEP_SCRATCH !== "1") fs.rmSync(scratch, { recursive: true, force: true });
  else console.log(`INFO scratch kept at ${scratch}`);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
