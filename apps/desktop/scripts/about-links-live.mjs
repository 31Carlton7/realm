/**
 * Live check: Realm's GitHub links, in the Help menu and Settings ▸ General ▸ About
 * (run with: pnpm build && node apps/desktop/scripts/about-links-live.mjs)
 *
 * Boots the BUILT app on a scratch home with `shell.openExternal` replaced in main, so a link reports
 * where it would go and nothing reaches a browser. Then:
 *
 *   1. Help lists Report a Bug, Request a Feature, Star Realm on GitHub and Realm on GitHub after
 *      What's New, and a click on each opens its URL — the bug report with this build's version in it.
 *   2. Settings ▸ General ends on About: four rows, each a link the row's whole size and at least a
 *      desktop hit area tall, that light under the pointer; a real click on each reaches main's
 *      window-open handler with the same URL the menu opens.
 *   3. Both faces captured: the About rows, and the native Help menu popped up over the window. A
 *      popped-up menu takes the keyboard while it is open, so it is only popped up once nobody has
 *      touched the Mac for a while (`LIVE_SKIP_MENU_SHOT=1` skips it outright).
 *
 * Ports: LIVE_SERVER_PORT (8796), LIVE_CDP_PORT (9236). Screenshots go to LIVE_SHOT_DIR, the scratch
 * home under LIVE_HOME (a temp dir otherwise). Fake agent only; no message is sent to any session.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9236);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8796);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-about-links-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-about-links-live-"));
const home = process.env.LIVE_HOME ?? path.join(scratch, "home");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/desktop/package.json"), "utf8")).version;
const REPO = "https://github.com/31Carlton7/realm";
const WANT = {
  bug: `${REPO}/issues/new?template=bug.yml&version=${version}`,
  feature: `${REPO}/issues/new?template=feature.yml`,
  repo: REPO,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
const replies = [];
const opened = [];

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const info = (name, detail) => console.log(`INFO ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);

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

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
}

/** Mean RGB of a small square of the page, at CSS px. */
async function sample(c, x, y, size = 4) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x, y, width: size, height: size, scale: 1 } });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data; const n = d.length / 4; const m = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
    return m.map((v) => Math.round(v / n));
  })()`);
}

/* Main, answering over stdin/stdout: the application menu as built, a click on a row by label, and the
   Help menu popped up over the window and put away again. `shell.openExternal` is replaced before the
   app loads, so every link — the menu's and the window-open handler's — reports where it would go. */
const WRAPPER = [
  'import { app, BrowserWindow, Menu, shell } from "electron";',
  'import readline from "node:readline";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  'shell.openExternal = async (url) => { console.log("LIVE_OPEN " + url); };',
  'console.log("LIVE_STUBBED " + JSON.stringify(shell.openExternal.toString().includes("LIVE_OPEN")));',
  "const walk = (items) => items.map((i) => ({ label: i.label, role: i.role ?? null, type: i.type, submenu: i.submenu ? walk(i.submenu.items) : null }));",
  "const findItem = (items, label) => { for (const i of items) { if (i.label === label) return i; if (i.submenu) { const f = findItem(i.submenu.items, label); if (f) return f; } } return null; };",
  "const help = () => Menu.getApplicationMenu().items.find((i) => i.role === 'help').submenu;",
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');",
  "  const win = BrowserWindow.getAllWindows()[0];",
  "  if (cmd === 'menu') console.log('LIVE_REPLY ' + JSON.stringify(walk(Menu.getApplicationMenu().items)));",
  "  if (cmd === 'click') { const item = findItem(Menu.getApplicationMenu().items, arg); if (item) item.click(); console.log('LIVE_REPLY ' + JSON.stringify(!!item)); }",
  "  if (cmd === 'bounds') console.log('LIVE_REPLY ' + JSON.stringify(win.getBounds()));",
  "  if (cmd === 'popup') { const [x, y] = arg.split(',').map(Number); help().popup({ window: win, x, y }); console.log('LIVE_REPLY true'); }",
  "  if (cmd === 'closepopup') { help().closePopup(win); console.log('LIVE_REPLY true'); }",
  "});",
  "await import(process.env.LIVE_MAIN);",
].join("\n");

/* The windows a process has above the normal level, so the popped-up menu can be captured by its own
   window id — `screencapture -l` takes that window alone, with nothing behind it. */
const WINLIST = `import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in info {
  guard let owner = w[kCGWindowOwnerPID as String] as? Int32, owner == pid,
        let layer = w[kCGWindowLayer as String] as? Int, layer > 0,
        let id = w[kCGWindowNumber as String] as? Int,
        let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
  print(id, layer, Int(b["X"]!), Int(b["Y"]!), Int(b["Width"]!), Int(b["Height"]!))
}`;

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  fs.writeFileSync(path.join(scratch, "wrapper.mjs"), WRAPPER);
  // Run as an app folder whose package.json carries the desktop app's version, so `app.getVersion()` —
  // which both the menu and the updater's status read — is this build's, not Electron's own.
  fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: "realm-about-links-live", version, type: "module", main: "wrapper.mjs" }));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.3.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [scratch, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      // A window that cannot take focus, lets clicks through and says SCRATCH: never mistaken for Realm.
      REALM_LIVE_SCRATCH: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {});
  let buf = "";
  let stubbed = null;
  electron.stdout.on("data", (d) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith("LIVE_REPLY ")) replies.push(JSON.parse(line.slice(11)));
      if (line.startsWith("LIVE_OPEN ")) opened.push(line.slice(10));
      if (line.startsWith("LIVE_STUBBED ")) stubbed = JSON.parse(line.slice(13));
    }
  });
  await until(() => stubbed !== null, 30_000, "wrapper");
  // Nothing below may click a link unless main's openExternal is the stub: a real one opens GitHub.
  if (!stubbed) throw new Error("shell.openExternal could not be replaced — refusing to click any link");

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  /* An unkeyed window greys its accent and a page without focus goes quiet; neither is what is being
     looked at, so the window is held as key and focused for the run. The scratch banner is the
     harness's, not Realm's, and comes off the captures. */
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] });
    document.getElementById('live-scratch-banner')?.remove(); return true; })()`);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const ask = async (line) => {
  const n = replies.length;
  electron.stdin.write(`${line}\n`);
  await until(() => replies.length > n, 5000, line);
  return replies[replies.length - 1];
};
const nextOpen = async (tag) => {
  const n = opened.length;
  return async () => { await until(() => opened.length > n, 5000, tag); return opened[opened.length - 1]; };
};

/** Seconds since anyone touched this Mac's keyboard or pointer. */
const idleSeconds = () => {
  const out = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8" });
  const m = /"HIDIdleTime" = (\d+)/.exec(out);
  return m ? Number(m[1]) / 1e9 : 0;
};

let winlist = null;
/** The Help menu, popped up over the window and captured as its own window. */
async function shootHelpMenu(name) {
  if (process.env.LIVE_SKIP_MENU_SHOT === "1") { info(`skipped the ${name} capture (LIVE_SKIP_MENU_SHOT)`); return; }
  // Waited for, not assumed: a person typing while the menu is up would be typing into it.
  try { await until(() => idleSeconds() > 20, 120_000, "nobody at the Mac"); } catch { info(`skipped the ${name} capture: the Mac is in use`); return; }
  if (!winlist) {
    fs.writeFileSync(path.join(scratch, "winlist.swift"), WINLIST);
    execFileSync("swiftc", ["-O", path.join(scratch, "winlist.swift"), "-o", path.join(scratch, "winlist")]);
    winlist = path.join(scratch, "winlist");
  }
  await ask("popup 24,48");
  try {
    const menuWin = await until(() => {
      const rows = execFileSync(winlist, [String(electron.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number));
      return rows.find(([, layer, , , w, h]) => layer >= 100 && w > 100 && h > 100) ?? null;
    }, 4000, "the popped-up menu's window");
    await sleep(250); // the menu fades in
    const file = path.join(shots, `${name}.png`);
    execFileSync("screencapture", ["-x", `-l${menuWin[0]}`, file]);
    console.log(`  shot ${file}`);
  } finally {
    await ask("closepopup");
  }
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  const c = await boot();
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  info("version under test", version);

  /* ── 1. Help ───────────────────────────────────────────────────────────────────────────────── */
  await sleep(600);
  const menu = await ask("menu");
  const help = menu.find((m) => m.role === "help");
  const rows = help.submenu.map((i) => (i.type === "separator" ? "—" : i.label));
  check("Help lists the four rows after What's New", JSON.stringify(rows) === JSON.stringify(
    ["Realm Website", "What's New", "—", "Report a Bug", "Request a Feature", "—", "Star Realm on GitHub", "Realm on GitHub"]), rows);
  for (const [label, want] of [["Report a Bug", WANT.bug], ["Request a Feature", WANT.feature], ["Star Realm on GitHub", WANT.repo], ["Realm on GitHub", WANT.repo]]) {
    const got = await nextOpen(label);
    await ask(`click ${label}`);
    const url = await got();
    check(`Help ▸ ${label} opens ${want}`, url === want, url);
  }

  /* ── 2. Settings ▸ General ▸ About ─────────────────────────────────────────────────────────── */
  await ask("click Settings…");
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="realm-on-github"]')`), 15_000, "About on General");
  const ids = ["report-bug", "request-feature", "star-realm", "realm-on-github"];
  await evalIn(c, `document.querySelector('[data-setting="report-bug"]').scrollIntoView({ block: "center" }), true`);
  await sleep(400);
  const about = await evalIn(c, `(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const rows = ${JSON.stringify(ids)}.map((id) => document.querySelector('[data-setting="' + id + '"]'));
    const head = rows[0].closest('ul').previousElementSibling;
    return {
      head: head?.textContent, headTag: head?.tagName,
      last: !!rows[3].closest('.settings-page-pane') && rows[3].closest('ul').nextElementSibling?.className,
      rows: rows.map((li) => { const a = li.querySelector('a'); return { id: li.dataset.setting, text: a.textContent.trim(), href: a.getAttribute('href'),
        title: a.title, li: box(li), a: box(a), cursor: getComputedStyle(a).cursor }; }),
    };
  })()`);
  check("General ends on an About section, above the credit", about.head === "About" && about.last === "settings-attribution", { head: about.head, after: about.last });
  check("its rows read as the Help menu's, in sentence case", JSON.stringify(about.rows.map((r) => r.text)) === JSON.stringify(["Report a bug", "Request a feature", "Star Realm on GitHub", "Realm on GitHub"]), about.rows.map((r) => r.text));
  check("each row is its link, edge to edge", about.rows.every((r) => Math.abs(r.a.w - r.li.w) <= 1 && Math.abs(r.a.h - r.li.h) <= 1), about.rows.map((r) => ({ li: r.li, a: r.a })));
  check("each row is a desktop hit area tall, and points", about.rows.every((r) => r.li.h >= 40 && r.cursor === "pointer"), about.rows.map((r) => [r.li.h, r.cursor]));
  check("each row says where it goes in its tooltip", about.rows.every((r) => /GitHub/.test(r.title)), about.rows.map((r) => r.title));
  check("the bug report carries this build's version", about.rows[0].href === WANT.bug, about.rows[0].href);

  // The pointer lights the row: its fill, read off the screen, at rest and hovered.
  await c.send("DOM.enable");
  const doc = await c.send("DOM.getDocument", { depth: 1 });
  const first = about.rows[1].li;
  const at = { x: first.l + first.w - 60, y: first.t + 6 };
  const rest = await sample(c, at.x, at.y);
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '[data-setting="request-feature"]' });
  await c.send("CSS.enable");
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  await sleep(250);
  const hot = await sample(c, at.x, at.y);
  check("a row lights under the pointer", hot.some((v, i) => Math.abs(v - rest[i]) >= 3), { rest, hot });
  const clip = await evalIn(c, `(() => { const ul = document.querySelector('[data-setting="report-bug"]').closest('ul');
    const head = ul.previousElementSibling.getBoundingClientRect(); const credit = document.querySelector('.settings-attribution').getBoundingClientRect();
    return { x: Math.round(head.left) - 24, y: Math.round(head.top) - 16, width: Math.round(ul.getBoundingClientRect().width) + 48, height: Math.round(credit.bottom - head.top) + 32 }; })()`);
  await shoot(c, "about-hover-dark", clip);
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  await sleep(250);
  await shoot(c, "about-dark", clip);

  // A real click on each row reaches main's window-open handler, and leaves for the same URL as Help.
  for (const r of about.rows) {
    const live = await evalIn(c, `(() => { const b = document.querySelector('[data-setting="${r.id}"]').getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
    const got = await nextOpen(r.id);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: live.x, y: live.y, button: "left", clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: live.x, y: live.y, button: "left", clickCount: 1 });
    const url = await got();
    const want = { "report-bug": WANT.bug, "request-feature": WANT.feature }[r.id] ?? WANT.repo;
    check(`About ▸ ${r.text} opens what Help opens`, url === want, url);
  }
  // The pointer the clicks left on the last row would light it in every capture after this.
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 400 });

  await shootHelpMenu("help-menu-dark");

  /* ── 3. The light face ──────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `(() => { document.querySelector('.settings-rail input[value="appearance"]').click(); return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-theme"][value="light"]').click(); return true; })()`);
  await sleep(500);
  await evalIn(c, `(() => { document.querySelector('.settings-rail input[value="general"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="report-bug"]')`), 5000, "General again");
  await evalIn(c, `document.querySelector('[data-setting="report-bug"]').scrollIntoView({ block: "center" }), true`);
  await sleep(500);
  check("the window is on the light face", await evalIn(c, `document.documentElement.dataset.mode === "light"`));
  const clipLight = await evalIn(c, `(() => { const ul = document.querySelector('[data-setting="report-bug"]').closest('ul');
    const head = ul.previousElementSibling.getBoundingClientRect(); const credit = document.querySelector('.settings-attribution').getBoundingClientRect();
    return { x: Math.round(head.left) - 24, y: Math.round(head.top) - 16, width: Math.round(ul.getBoundingClientRect().width) + 48, height: Math.round(credit.bottom - head.top) + 32 }; })()`);
  await shoot(c, "about-light", clipLight);
  const { nodeId: lightNode } = await c.send("DOM.querySelector", { nodeId: (await c.send("DOM.getDocument", { depth: 1 })).root.nodeId, selector: '[data-setting="request-feature"]' });
  await c.send("CSS.forcePseudoState", { nodeId: lightNode, forcedPseudoClasses: ["hover"] });
  await sleep(250);
  await shoot(c, "about-hover-light", clipLight);
  await c.send("CSS.forcePseudoState", { nodeId: lightNode, forcedPseudoClasses: [] });
  await shootHelpMenu("help-menu-light");
  c.close();
}

/** Whatever is listening on a port this script chose. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
