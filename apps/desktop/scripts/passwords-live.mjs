/**
 * Live check for passwords in the browser pane, Realm 2.3 (run with: pnpm build && node apps/desktop/scripts/passwords-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with a scripted ACP agent (nothing billed), a local login
 * page on 127.0.0.1, and a scratch keychain made with `security create-keychain` in the scratch dir —
 * never the login keychain, which the harness build cannot reach (`keychainSourceFor`):
 *
 *   P1  a password saved in Settings, an imported CSV (the file offered to the Trash), and the scratch
 *       keychain's items are all offered on the page's site;
 *   P2  a trusted click in the empty username field pops the OS menu under it, listing them; a pick
 *       fills both fields after the unlock (the stand-in logs the Touch ID ask);
 *   P3  a field in a cross-origin frame pops nothing;
 *   P4  a sent form offers Save on the pane's bar, the bar never holds the password, and Save keeps it;
 *   P5  an agent lists the site's passwords as metadata and fills a keychain one on a card answered
 *       "Always allow on this site"; the next fill there asks no card but still asks Touch ID;
 *   P6  Show draws the password in a native sheet and Copy puts it on the clipboard and clears it —
 *       neither answers the renderer with it;
 *   P7  no password is in realm.db, any log, or secrets.json in the clear;
 *   P8  Settings ▸ Passwords and the Save bar, dark and light.
 *
 * The OS menu cannot be pressed from a script, so the wrapper stands in for the hand: it records the
 * rows of every menu main pops and picks the row LIVE_MENU_PICK names. Dialogs, the clipboard and the
 * Trash are stood in for the same way, so nothing reaches the owner's screen, clipboard or Trash.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8798 / 9238) and LIVE_SITE_PORT (18798), refused if taken
 * and reaped by port. Screenshots go to LIVE_OUT.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9238);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8798);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 18798);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-passwords-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-passwords-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FRAME_SITE = `http://localhost:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAVED = "realm-saved-Pw-1x";
const IMPORTED = "imported-Pw-2y";
const KEYCHAIN = "keychain-Pw-3z";
const TYPED = "typed-by-person-4w";
const SECRETS = [SAVED, IMPORTED, KEYCHAIN, TYPED];
let electron = null, api = null, site = null, keychainFile = null;

const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
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
    await sleep(200);
  }
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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
function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
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
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);

/* ── the login page ─────────────────────────────────────────────────────────────────────────── */

const posts = [];
const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>body{font:16px system-ui;margin:40px}input{display:block;margin:8px 0 16px;width:280px;height:30px}</style></head><body>${body}</body></html>`;
const LOGIN = page("Sign in — Fixture", `<h1>Sign in</h1><form method="post" action="/session">
  <label>Email<input id="username" name="username" autocomplete="username"></label>
  <label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button></form>`);
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", SITE);
      if (req.method === "POST" && url.pathname === "/session") {
        let body = ""; req.on("data", (d) => { body += d; });
        req.on("end", () => { posts.push(Object.fromEntries(new URLSearchParams(body))); res.writeHead(302, { location: "/home" }); res.end(); });
        return;
      }
      const routes = {
        "/login": LOGIN,
        "/home": page("Home — Fixture", "<h1>Signed in</h1>"),
        "/frame": page("Framed — Fixture", `<h1>A frame from another origin</h1><iframe id="f" src="${FRAME_SITE}/login" width="500" height="320"></iframe>`),
      };
      const body = routes[url.pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? page("Not found", "<h1>Not found</h1>"));
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ── the wrapper: the hand on the OS menu, and stand-ins for dialogs, clipboard and Trash ──────── */

const menuLog = path.join(scratch, "menus.jsonl");
const pickFile = path.join(scratch, "pick");
const dialogLog = path.join(scratch, "dialogs.jsonl");
const clipFile = path.join(scratch, "clipboard");
const presenceLog = path.join(scratch, "presence-asks.log");
const ownerLog = path.join(scratch, "owner-asks.log");
const csvFile = path.join(scratch, "Passwords.csv");
const WRAPPER = [
  'import { app, Menu, dialog, clipboard, shell } from "electron";',
  'import fs from "node:fs";',
  'app.commandLine.appendSwitch("use-mock-keychain");',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "const E = process.env;",
  // The menu: record its rows, then do what a hand would — pick the named row, or press Escape.
  "Menu.prototype.popup = function (opts = {}) {",
  "  const rows = this.items.map((i) => i.type === 'separator' ? '—' : i.label);",
  "  fs.appendFileSync(E.LIVE_MENU_LOG, JSON.stringify({ rows, x: opts.x, y: opts.y }) + '\\n');",
  "  const want = fs.existsSync(E.LIVE_MENU_PICK) ? fs.readFileSync(E.LIVE_MENU_PICK, 'utf8').trim() : '';",
  "  setTimeout(() => { const item = want ? this.items.find((i) => (i.label || '').startsWith(want)) : null; if (item) item.click(); opts.callback?.(); }, 150);",
  "};",
  "dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [E.LIVE_CSV] });",
  "dialog.showMessageBox = async (a, b) => { const o = b ?? a; fs.appendFileSync(E.LIVE_DIALOG_LOG, JSON.stringify({ message: o.message, detail: o.detail }) + '\\n'); return { response: /Trash/.test(o.message) ? 0 : 0, checkboxChecked: false }; };",
  "shell.trashItem = async (p) => { fs.rmSync(p); };",
  "for (const [k, fn] of Object.entries({ writeText: (t) => fs.writeFileSync(E.LIVE_CLIP, t), readText: () => (fs.existsSync(E.LIVE_CLIP) ? fs.readFileSync(E.LIVE_CLIP, 'utf8') : ''), clear: () => fs.writeFileSync(E.LIVE_CLIP, '') })) {",
  "  try { Object.defineProperty(clipboard, k, { value: fn, configurable: true, writable: true }); } catch (e) { fs.appendFileSync(E.LIVE_DIALOG_LOG, JSON.stringify({ clipboardPatch: String(e) }) + '\\n'); }",
  "}",
  "await import(E.LIVE_MAIN);",
].join("\n");

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const helper = path.join(repoRoot, "apps/desktop/native/bin/realmkeychain");
  if (!fs.existsSync(helper)) throw new Error("native/bin/realmkeychain is missing — run `node apps/desktop/scripts/build-native.mjs`");
  site = await startSite();

  // The app's path is the wrapper's dir, so main finds the helpers here: the real keychain helper, and
  // a stand-in for the login-password check that answers yes and logs the ask.
  fs.mkdirSync(path.join(scratch, "native/bin"), { recursive: true });
  const ourHelper = path.join(scratch, "native/bin/realmkeychain");
  fs.copyFileSync(helper, ourHelper);
  fs.chmodSync(ourHelper, 0o755);
  fs.writeFileSync(path.join(scratch, "native/bin/deviceowner"), `#!/bin/bash\n[ "$1" = "can" ] && { echo yes; exit 0; }\necho "$2" >> ${JSON.stringify(ownerLog)}\nexit 0\n`, { mode: 0o755 });

  // A scratch keychain, in the scratch dir, trusting only the helper copy above — so macOS asks nothing.
  const before = execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  keychainFile = path.join(scratch, "scratch.keychain-db");
  execFileSync("security", ["create-keychain", "-p", "scratch", keychainFile]);
  execFileSync("security", ["unlock-keychain", "-p", "scratch", keychainFile]);
  execFileSync("security", ["add-internet-password", "-a", "kc-user", "-s", "127.0.0.1", "-P", String(SITE_PORT), "-r", "http", "-w", KEYCHAIN, "-T", ourHelper, keychainFile]);
  check("the scratch keychain is not on the search list", execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }) === before, null);

  fs.writeFileSync(csvFile, `Title,URL,Username,Password,Notes,OTPAuth\nFixture (bob),${SITE}/login,bob,${IMPORTED},,\nApp,android://abc@com.x,u,p,,\n`);
  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_GEMINI_BIN: agent, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_LIVE_SCRATCH: "1", REALM_LIVE_PRESENCE_LOG: presenceLog, REALM_LIVE_KEYCHAIN: keychainFile,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry, LIVE_MENU_LOG: menuLog, LIVE_MENU_PICK: pickFile,
      LIVE_DIALOG_LOG: dialogLog, LIVE_CLIP: clipFile, LIVE_CSV: csvFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Passwords");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  // Cards: answered as the person would — "Always allow on this site" the first time, recorded.
  const cards = [];
  let sessionId = null;
  let decision = "allow_always";
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title, input: card.input });
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: card.toolName === "browser_fill_credential" ? decision : "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const profileId = space.profileId;
  const P = JSON.stringify(profileId);
  const ipc = (expr) => evalIn(c, `(async () => { const v = window.realm.credentials; ${expr} })()`);

  /* ── P1: three sources ──────────────────────────────────────────────────────────────────────── */
  await ipc(`return v.add(${P}, { origin: ${JSON.stringify(SITE)}, username: "ada", label: "Fixture", value: ${JSON.stringify(SAVED)} });`);
  const imported = await ipc(`return v.import(${P});`);
  check("P1 the CSV imports as counts, and the file is offered to the Trash and gone", imported.ok && imported.added === 1 && imported.skipped === 1 && imported.trashed && !fs.existsSync(csvFile), imported);
  check("P1 the Trash question named the file", lines(dialogLog).some((l) => /Move Passwords\.csv to the Trash\?/.test(l)), lines(dialogLog));
  const kc = await ipc(`return v.setKeychain(true);`);
  check("P1 the scratch keychain's item is listed, metadata only", kc.enabled && kc.count === 1, kc);
  const kcRows = await ipc(`return v.keychainList();`);
  check("P1 …as this site's address and its account", kcRows.length === 1 && kcRows[0].origin === SITE && kcRows[0].username === "kc-user" && !JSON.stringify(kcRows).includes(KEYCHAIN), kcRows);

  /* ── the agent's session, and a pane on the login page ─────────────────────────────────────── */
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: "Passwords live check", permissionMode: "default" });
  sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes("Passwords live check"))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Passwords live check")).click(); return true; })()`);
  await sleep(800);
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "passwords-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = (name, args = {}) => client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 120_000 });
  const opened = await call("browser_open", { url: `${SITE}/login` });
  const browserId = /pane (\S+) at/.exec(text(opened))?.[1];
  check("an agent opens a pane on the login page", !!browserId, text(opened));
  const paneTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(`${SITE}/login`)), 20_000, "pane target");
  const pane = cdp(paneTarget.webSocketDebuggerUrl);
  await pane.ready;
  await until(() => evalIn(pane, `!!document.querySelector('#username') && document.readyState === 'complete'`), 15_000, "login form");
  if (process.env.LIVE_DEBUG) {
    const probe = cdp(paneTarget.webSocketDebuggerUrl); await probe.ready;
    const seen = [];
    const ws2 = new WebSocket(paneTarget.webSocketDebuggerUrl);
    await new Promise((r) => ws2.addEventListener("open", r));
    ws2.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.method === "Runtime.executionContextCreated") seen.push(msg.params.context); });
    ws2.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    await sleep(800);
    console.log("CONTEXTS", JSON.stringify(seen.map((x) => ({ name: x.name, origin: x.origin, aux: x.auxData }))));
    ws2.close(); probe.close();
  }
  await sleep(500);

  const centre = (sel) => evalIn(pane, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (p, at) => {
    await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
  };
  const values = () => evalIn(pane, `({ u: document.querySelector('#username')?.value ?? null, p: document.querySelector('#password')?.value ?? null })`);

  /* ── P2: the menu, and a pick ───────────────────────────────────────────────────────────────── */
  fs.writeFileSync(pickFile, "ada");
  const presence0 = lines(presenceLog).length;
  await click(pane, await centre("#username"));
  const menu = await until(() => lines(menuLog)[0], 10_000, "menu");
  const rows = JSON.parse(menu).rows;
  check("P2 a click in the empty username field pops the menu with the site's three passwords", rows.join("|") === "ada|bob|kc-user — Keychain|—|Manage passwords…", rows);
  await until(async () => (await values()).p === SAVED, 10_000, "filled").catch(() => null);
  const filled = await values();
  check("P2 the pick filled the username and the password", filled.u === "ada" && filled.p === SAVED, { u: filled.u, filled: filled.p === SAVED });
  check("P2 after the unlock (Touch ID stand-in asked once)", lines(presenceLog).length === presence0 + 1, lines(presenceLog).slice(presence0));
  const pos = JSON.parse(menu);
  check("P2 the menu was placed under the field, in the window", Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.y > 0, pos);

  /* ── P3: a cross-origin frame pops nothing ─────────────────────────────────────────────────── */
  await call("browser_navigate", { browserId, url: `${SITE}/frame` });
  await until(() => evalIn(pane, `location.pathname === '/frame' && !!document.querySelector('#f')`), 15_000, "frame page");
  await sleep(1500);
  const frameBox = await evalIn(pane, `(() => { const r = document.querySelector('#f').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const menus0 = lines(menuLog).length;
  // The frame's own login page puts #username about 90px down and 40px in.
  await click(pane, { x: frameBox.x + 60, y: frameBox.y + 100 });
  await sleep(1500);
  check("P3 a click in a cross-origin frame's field pops no menu", lines(menuLog).length === menus0, lines(menuLog).slice(menus0));

  /* ── P4: Save after a sent form ─────────────────────────────────────────────────────────────── */
  await call("browser_navigate", { browserId, url: `${SITE}/login` });
  await until(() => evalIn(pane, `location.pathname === '/login' && !!document.querySelector('#password')`), 15_000, "login again");
  await sleep(500);
  fs.writeFileSync(pickFile, "");
  await click(pane, await centre("#username"));
  await sleep(600);
  await pane.send("Input.insertText", { text: "cat@example.com" });
  await click(pane, await centre("#password"));
  await pane.send("Input.insertText", { text: TYPED });
  await pane.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await pane.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const bar = await until(() => evalIn(c, `(() => { const b = [...document.querySelectorAll('.browser-notice')].find((n) => n.textContent.includes('Save password')); return b ? { text: b.textContent, noAgent: b.hasAttribute('data-no-agent'), html: b.outerHTML } : null; })()`), 15_000, "save bar");
  check("P4 the form went to the site", posts.some((p) => p.password === TYPED), posts.length);
  check("P4 the pane offers to save it, naming the person and the site", bar.text.includes(`Save password for cat@example.com on 127.0.0.1:${SITE_PORT}?`) && bar.noAgent, bar.text);
  check("P4 the bar holds no password", !bar.html.includes(TYPED), null);
  await shotOf(c, "04-save-bar-dark");
  await evalIn(c, `[...document.querySelectorAll('.browser-notice button')].find((b) => b.textContent.trim() === 'Save').click(), true`);
  await until(async () => (await ipc(`return v.list(${P});`)).some((r) => r.username === "cat@example.com"), 10_000, "saved row");
  check("P4 Save kept it as a password of this profile", true, null);

  /* ── P5: an agent, by metadata ──────────────────────────────────────────────────────────────── */
  await call("browser_navigate", { browserId, url: `${SITE}/login` });
  await until(() => evalIn(pane, `location.pathname === '/login' && !!document.querySelector('#password')`), 15_000, "login for agent");
  const listed = text(await call("browser_credentials", { browserId }));
  const kcId = /credentialId: (kc_\w+)/.exec(listed)?.[1];
  check("P5 the agent lists the site's passwords, with no password in them", listed.includes(`Saved passwords for ${SITE}`) && !!kcId && listed.includes("from the login keychain") && !SECRETS.some((s) => listed.includes(s)), listed);
  const snap = text(await call("browser_snapshot", { browserId }));
  const ref = Number(/\[ref=(\d+)\][^\n]*\{password\}/i.exec(snap)?.[1] ?? /\[ref=(\d+)\] textbox "Password"/i.exec(snap)?.[1]);
  if (process.env.LIVE_DEBUG) console.log("SNAP", snap.split("\n").filter((l) => /ref=/.test(l)).slice(0, 12).join(" | "));
  const cards0 = cards.length, presence1 = lines(presenceLog).length;
  const fill = await call("browser_fill_credential", { browserId, ref, credentialId: kcId });
  check("P5 the fill asked on a card offering Always allow on this site", cards.length === cards0 + 1 && cards[cards0].input.page === SITE && !fill.isError, { card: cards[cards0], result: text(fill) });
  check("P5 the agent's answer has no password in it", !SECRETS.some((s) => text(fill).includes(s)), text(fill));
  check("P5 the field holds the keychain password, after Touch ID", (await values()).p.endsWith(KEYCHAIN) && lines(presenceLog).length === presence1 + 1, null);
  await evalIn(pane, `document.querySelector('#password').value = '', true`);
  const allows = await ipc(`return v.fillAllows(${P});`);
  check("P5 Always allow is kept for that password on that site", allows.length === 1 && allows[0].credentialId === kcId && allows[0].origin === SITE, allows);
  const again = await call("browser_fill_credential", { browserId, ref, credentialId: kcId });
  check("P5 the next fill there asks no card — and still asks Touch ID", cards.length === cards0 + 1 && !again.isError && lines(presenceLog).length === presence1 + 2, { cards: cards.length - cards0, presence: lines(presenceLog).length - presence1 });

  /* ── P6: Show and Copy ──────────────────────────────────────────────────────────────────────── */
  const ada = (await ipc(`return v.list(${P});`)).find((r) => r.username === "ada");
  const owner0 = lines(ownerLog).length;
  const shown = await ipc(`return v.reveal(${P}, ${JSON.stringify(ada.id)}, "show");`);
  check("P6 Show answers the renderer with no password, and draws it in a native sheet", shown.ok && !JSON.stringify(shown).includes(SAVED) && lines(dialogLog).some((l) => l.includes(SAVED)), shown);
  const copied = await ipc(`return v.reveal(${P}, ${JSON.stringify(ada.id)}, "copy");`);
  check("P6 Copy puts it on the clipboard", copied.ok && fs.readFileSync(clipFile, "utf8") === SAVED, copied);
  check("P6 both asked macOS (the login-password stand-in) first", lines(ownerLog).length === owner0 + 2, lines(ownerLog).slice(owner0));
  await sleep(31_000);
  check("P6 the clipboard is cleared 30 seconds later", fs.readFileSync(clipFile, "utf8") === "", null);

  /* ── P7: nowhere it should not be ───────────────────────────────────────────────────────────── */
  const db = path.join(home, "realm.db");
  const q = (sql) => execFileSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const inflated = q("SELECT hex(payload_json) FROM session_events WHERE typeof(payload_json) = 'blob'").split("\n").filter(Boolean)
    .map((h) => inflateRawSync(Buffer.from(h, "hex").subarray(1)).toString("utf8")).join("\n");
  const dump = `${q(".dump")}\n${inflated}`;
  check("P7 no password anywhere in realm.db", !SECRETS.some((s) => dump.includes(s)), { bytes: dump.length });
  const logs = fs.readdirSync(path.join(home, "logs")).map((f) => fs.readFileSync(path.join(home, "logs", f), "utf8")).join("\n");
  check("P7 nor in any log", !SECRETS.some((s) => logs.includes(s)), null);
  check("P7 nor in secrets.json in the clear", !SECRETS.some((s) => fs.readFileSync(path.join(home, "secrets.json"), "utf8").includes(s)), null);
  const audit = lines(path.join(home, "logs/credential-audit.log")).map((l) => JSON.parse(l));
  check("P7 the audit has the person's fill, the agent's fills, the import, the save and both reveals",
    audit.some((a) => a.by === "person" && a.outcome === "filled") && audit.filter((a) => a.outcome === "filled" && !a.by).length === 2
      && audit.some((a) => a.kind === "import") && audit.some((a) => a.kind === "save-offer") && audit.filter((a) => a.kind === "reveal").length === 2,
    audit.map((a) => a.kind ?? a.outcome));

  /* ── P8: the pages ──────────────────────────────────────────────────────────────────────────── */
  await openPasswords(c);
  await shotOf(c, "01-settings-passwords-dark");
  await evalIn(c, `(() => { const h = [...document.querySelectorAll('h3.settings-head')].find((x) => x.textContent === 'Agents fill without asking'); h?.scrollIntoView({ block: 'center' }); return !!h; })()`);
  await shotOf(c, "03-settings-allows-dark");
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await sleep(1500);
  await openPasswords(c);
  await shotOf(c, "02-settings-passwords-light");
  await evalIn(c, `(() => { const h = [...document.querySelectorAll('h3.settings-head')].find((x) => x.textContent === 'Agents fill without asking'); h?.scrollIntoView({ block: 'center' }); return !!h; })()`);
  await shotOf(c, "03-settings-allows-light");
  // The bar, light: a second sent form, from a new person on the same site.
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector('.signins')`), 10_000, "settings closed");
  await call("browser_navigate", { browserId, url: `${SITE}/login` });
  await until(() => evalIn(pane, `location.pathname === '/login' && !!document.querySelector('#password')`), 15_000, "login light");
  await sleep(500);
  await click(pane, await centre("#username"));
  await sleep(600);
  await pane.send("Input.insertText", { text: "dee@example.com" });
  await click(pane, await centre("#password"));
  await pane.send("Input.insertText", { text: `${TYPED}-dee` });
  await pane.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await pane.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until(() => evalIn(c, `[...document.querySelectorAll('.browser-notice')].some((n) => n.textContent.includes('Save password for dee'))`), 15_000, "save bar light");
  await shotOf(c, "05-save-bar-light");
  pane.close();
  c.close();
  console.log(`MENU ROWS ${JSON.stringify(lines(menuLog).map((l) => JSON.parse(l).rows))}`);
}

async function openPasswords(c) {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await evalIn(c, `(() => { const input = document.querySelector('.palette input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, "Open settings");
    input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  await evalIn(c, `[...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes("Open settings"))?.click(), true`);
  const tab = `[...document.querySelectorAll('label.settings-tab')].find((l) => l.textContent.trim() === 'Passwords')`;
  await until(() => evalIn(c, `!!${tab}`), 10_000, "settings rail");
  await evalIn(c, `${tab}.click(), true`);
  await until(() => evalIn(c, `!!document.querySelector('.signins') && [...document.querySelectorAll('.creds-list .settings-row')].length >= 3`), 10_000, "passwords page");
}

async function shotOf(c, tag) {
  await sleep(900);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  if (keychainFile) { try { execFileSync("security", ["delete-keychain", keychainFile]); } catch { /* gone with the dir */ } }
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
