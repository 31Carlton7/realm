/**
 * Live check for security codes in the browser pane (run with: pnpm build && node apps/desktop/scripts/security-codes-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with a scripted ACP agent (nothing billed), a local page
 * with a one-time-code field and a row of six single-digit boxes on 127.0.0.1, and the stand-in code
 * source (`REALM_LIVE_CODES`, a JSON file in the scratch dir) — never the owner's Messages or Mail,
 * which the harness build cannot reach (`codeSourcesFor`):
 *
 *   C1  Settings ▸ Passwords has the Security codes switch, off, with what Realm reads and when;
 *   C2  off, a click in the code field pops nothing;
 *   C3  on, a click in the code field pops the OS menu under it with the code that just "arrived",
 *       and a pick fills it; the same for the six boxes, one digit each; an old message pops nothing;
 *   C4  an agent's browser_fill_code raises a card, fills only once it is approved, and answers
 *       "filled" without the code; its next snapshot does not carry the code; a declined card fills
 *       nothing and answers "declined";
 *   C5  no code is in realm.db or any log;
 *   C6  every surface in dark and light, captured from the screen (`screencapture`), because the menu
 *       and the pane are native views no CDP capture can see.
 *
 * The OS menu cannot be pressed from a script, so the wrapper stands in for the hand: it records the
 * rows of every menu main pops, lets the REAL menu stand on screen long enough to be photographed when
 * asked, then picks the row the harness names.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8801 / 9241) and LIVE_SITE_PORT (18801), refused if taken
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9241);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8801);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 18801);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-security-codes-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-codes-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codesFile = path.join(scratch, "codes.json");
/** Every code this run "receives". None may turn up anywhere but the page it was typed into. */
const CODES = [];
let electron = null, api = null, site = null;
const appOutput = [];

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

/** A message "arrives": the stand-in source reads this file on every ask. */
function receive(source, code, body, agoMs = 15_000) {
  CODES.push(code);
  const rows = fs.existsSync(codesFile) ? JSON.parse(fs.readFileSync(codesFile, "utf8")) : [];
  rows.push({ source, at: Date.now() - agoMs, text: body.replace("{code}", code) });
  fs.writeFileSync(codesFile, JSON.stringify(rows));
}
const clearInbox = () => fs.writeFileSync(codesFile, "[]");

/* ── the site ───────────────────────────────────────────────────────────────────────────────── */

const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>
  body{font:16px -apple-system,system-ui;margin:48px;color:#1d1d1f;background:#fff}
  h1{font-size:24px;font-weight:600;margin:0 0 6px} p{color:#555;margin:0 0 20px}
  #otp{width:220px;height:40px;font-size:20px;letter-spacing:4px;padding:0 10px;border:1px solid #c7c7cc;border-radius:8px}
  .boxes{display:flex;gap:8px} .boxes input{width:44px;height:52px;text-align:center;font-size:24px;border:1px solid #c7c7cc;border-radius:8px}
  button{margin-top:20px;height:36px;padding:0 18px;border-radius:8px;border:0;background:#0a66ff;color:#fff;font-size:15px}
</style></head><body>${body}</body></html>`;
const VERIFY = page("Verify — Fixture", `<h1>Check your phone</h1><p>We sent a 6-digit code to the number on your account.</p>
  <form onsubmit="return false"><label for="otp" style="display:block;margin-bottom:8px">Verification code</label>
  <input id="otp" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"><br><button>Verify</button></form>`);
const SPLIT = page("Verify — Fixture", `<h1>Enter the code</h1><p>We emailed you a 6-digit sign-in code.</p>
  <div class="boxes" id="boxes">${[0, 1, 2, 3, 4, 5].map((i) => `<input id="d${i}" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join("")}</div>
  <button>Continue</button>
  <script>const b=[...document.querySelectorAll('#boxes input')];b.forEach((el,i)=>el.addEventListener('input',()=>{if(el.value&&b[i+1])b[i+1].focus();}));</script>`);
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", SITE);
      const body = { "/verify": VERIFY, "/split": SPLIT }[url.pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? page("Not found", "<h1>Not found</h1>"));
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ── the wrapper: the hand on the OS menu, and the window's place on screen ─────────────────────── */

const menuLog = path.join(scratch, "menus.jsonl");
const pickFile = path.join(scratch, "pick");
const cmdFile = path.join(scratch, "cmd");
const infoFile = path.join(scratch, "window.json");
const WRAPPER = [
  'import { app, BrowserWindow, Menu } from "electron";',
  'import fs from "node:fs";',
  'app.commandLine.appendSwitch("use-mock-keychain");',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "const E = process.env;",
  "const realPopup = Menu.prototype.popup;",
  // The pick file says what the hand does: `<prefix>` picks that row at once, `real:<ms>:<prefix>` lets
  // the real menu stand for that long first, so the harness can photograph it.
  "Menu.prototype.popup = function (opts = {}) {",
  "  const rows = this.items.map((i) => i.type === 'separator' ? '—' : i.label);",
  "  fs.appendFileSync(E.LIVE_MENU_LOG, JSON.stringify({ rows, x: opts.x, y: opts.y }) + '\\n');",
  "  const raw = fs.existsSync(E.LIVE_MENU_PICK) ? fs.readFileSync(E.LIVE_MENU_PICK, 'utf8').trim() : '';",
  "  const real = /^real:(\\d+):(.*)$/.exec(raw);",
  "  const want = real ? real[2] : raw;",
  "  const pick = () => { const item = want ? this.items.find((i) => (i.label || '').startsWith(want)) : null; if (item) item.click(); };",
  "  if (real) { realPopup.call(this, opts); setTimeout(() => { this.closePopup(opts.window); pick(); }, Number(real[1])); return; }",
  "  setTimeout(() => { pick(); opts.callback?.(); }, 150);",
  "};",
  // Commands from the harness: size the window, report its id and bounds, raise it for a screen capture.
  "setInterval(() => {",
  "  if (!fs.existsSync(E.LIVE_CMD)) return;",
  "  const cmd = fs.readFileSync(E.LIVE_CMD, 'utf8').trim(); fs.rmSync(E.LIVE_CMD);",
  "  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file://'));",
  "  if (!win) return;",
  "  if (cmd === 'size') { win.setBounds({ x: 80, y: 60, width: 1440, height: 900 }); }",
  "  if (cmd === 'front') { win.setAlwaysOnTop(true, 'floating'); app.focus({ steal: true }); win.focus(); }",
  "  if (cmd === 'lower') { win.setAlwaysOnTop(false); }",
  "  fs.writeFileSync(E.LIVE_INFO, JSON.stringify({ id: win.getMediaSourceId(), bounds: win.getBounds(), cmd }));",
  "}, 100);",
  "await import(E.LIVE_MAIN);",
].join("\n");

async function windowCmd(cmd) {
  fs.rmSync(infoFile, { force: true });
  fs.writeFileSync(cmdFile, cmd);
  return until(() => (fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, "utf8")) : null), 5000, `window ${cmd}`);
}
/** The window as macOS draws it, its panes and their native views included, even under another window. */
async function shotWindow(tag) {
  await sleep(700);
  const info = await windowCmd("info");
  const cgId = info.id.split(":")[1];
  const out = path.join(OUT_DIR, `${tag}.png`);
  execFileSync("screencapture", ["-x", "-o", `-l${cgId}`, out]);
  console.log(`SCREENSHOT ${tag} ${out}`);
}
/** The app in front, by bundle id, so it can be handed back the keyboard after a shot. */
function frontApp() {
  try { return /bundleID="([^"]+)"/.exec(execFileSync("lsappinfo", ["info", "-only", "bundleid", execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim()], { encoding: "utf8" }))?.[1] ?? null; } catch { return null; }
}
/**
 * A real menu over the pane, photographed off the screen. macOS takes down a menu an app pops while
 * it is not in front, so the scratch window comes forward for the few seconds this takes — `act`
 * opens the menu — and the app that was in front gets the keyboard back after.
 */
async function shotMenu(tag, act) {
  const was = frontApp();
  const { bounds } = await windowCmd("front");
  await sleep(500);
  await act();
  await sleep(1000);
  const out = path.join(OUT_DIR, `${tag}.png`);
  execFileSync("screencapture", ["-x", `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, out]);
  console.log(`SCREENSHOT ${tag} ${out}`);
  await sleep(2500);
  await windowCmd("lower");
  if (was) { try { execFileSync("open", ["-b", was]); } catch { /* it closed */ } }
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();
  clearInbox();

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_GEMINI_BIN: agent, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_LIVE_SCRATCH: "1", REALM_LIVE_CODES: codesFile,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry, LIVE_MENU_LOG: menuLog, LIVE_MENU_PICK: pickFile,
      LIVE_CMD: cmdFile, LIVE_INFO: infoFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => appOutput.push(String(d))); electron.stdout.on("data", (d) => appOutput.push(String(d)));

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await windowCmd("size");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Codes");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await keepKey(c);

  /* Cards: every one but a code fill is allowed at once; a code fill waits for the harness. */
  const cards = [];
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title, input: card.input, requestId: card.requestId });
    if (card.toolName !== "browser_fill_code") void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});

  /* ── C1: the switch, off ────────────────────────────────────────────────────────────────────── */
  await openPasswords(c);
  const row = `document.querySelector('[data-no-agent="security codes"]')`;
  const offState = await evalIn(c, `(() => { const r = ${row}; return r ? { on: r.querySelector('input').checked, desc: r.querySelector('.settings-row-desc').textContent } : null; })()`);
  check("C1 the Security codes switch is there and off, saying what Realm reads and when", offState && offState.on === false && /last 5 minutes/.test(offState.desc), offState);
  await evalIn(c, `(() => { document.querySelector('[data-setting="security-codes"]').scrollIntoView({ block: 'center' }); return true; })()`);
  await shotWindow("01-settings-off-dark");
  await closeSettings(c);

  /* ── the agent's session, and a pane on the code page ──────────────────────────────────────── */
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: "Security codes live check", permissionMode: "default" });
  sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes("Security codes live check"))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Security codes live check")).click(); return true; })()`);
  await sleep(800);
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "security-codes-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = (name, args = {}) => client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 120_000 });
  const opened = await call("browser_open", { url: `${SITE}/verify` });
  const browserId = /pane (\S+) at/.exec(text(opened))?.[1];
  check("an agent opens a pane on the code page", !!browserId, text(opened));
  const paneTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(SITE)), 20_000, "pane target");
  const pane = cdp(paneTarget.webSocketDebuggerUrl);
  await pane.ready;
  // The old document is marked first, so a navigation to the page already shown is waited out too.
  const go = async (where) => {
    await evalIn(pane, "window.__left = true").catch(() => {});
    await call("browser_navigate", { browserId, url: `${SITE}${where}` });
    await until(() => evalIn(pane, `!window.__left && location.pathname === ${JSON.stringify(where)} && document.readyState === 'complete'`).catch(() => false), 15_000, `page ${where}`);
    await sleep(600);
  };
  await until(() => evalIn(pane, `!!document.querySelector('#otp') && document.readyState === 'complete'`), 15_000, "code page");
  await sleep(500);
  const centre = (sel) => evalIn(pane, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (at) => {
    await pane.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await pane.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
  };
  const otpValue = () => evalIn(pane, `document.querySelector('#otp')?.value ?? null`);
  const boxValues = () => evalIn(pane, `[...document.querySelectorAll('#boxes input')].map((i) => i.value).join("")`);

  /* ── C2: off, nothing ───────────────────────────────────────────────────────────────────────── */
  receive("Messages", "190254", "Your Fixture verification code is {code}. Don't share it with anyone.");
  fs.writeFileSync(pickFile, "");
  const menus0 = lines(menuLog).length;
  await click(await centre("#otp"));
  await sleep(1200);
  check("C2 with the switch off, a click in the code field pops nothing", lines(menuLog).length === menus0 && (await otpValue()) === "", lines(menuLog).slice(menus0));
  const offFill = await call("browser_fill_code", { browserId, ref: 1 });
  check("C2 …and an agent's fill is refused before any card", offFill.isError && /Security codes are off/.test(text(offFill)) && !cards.some((k) => k.tool === "browser_fill_code"), text(offFill));

  /* ── turn it on ─────────────────────────────────────────────────────────────────────────────── */
  await openPasswords(c);
  await evalIn(c, `(() => { ${row}.querySelector('input').click(); return true; })()`);
  await until(() => evalIn(c, `${row}.querySelector('input').checked`), 5000, "switch on");
  await closeSettings(c);
  await go("/verify");
  clearInbox();

  for (const mode of ["dark", "light"]) {
    if (mode === "light") {
      await api.call("settings.set", { key: "ui.theme", value: "light" });
      await c.send("Page.reload", {});
      await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
      await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await keepKey(c);
      await sleep(1500);
      await go("/verify");
    }
    await openPasswords(c);
    await evalIn(c, `(() => { document.querySelector('[data-setting="security-codes"]').scrollIntoView({ block: 'center' }); return true; })()`);
    if (mode === "light") {
      const toggle = (on) => evalIn(c, `(() => { ${row}.querySelector('input').click(); return true; })()`)
        .then(() => until(() => evalIn(c, `${row}.querySelector('input').checked === ${on}`), 5000, `switch ${on ? "on" : "off"}`));
      await toggle(false);
      await shotWindow("01-settings-off-light");
      await toggle(true);
    }
    await shotWindow(`02-settings-on-${mode}`);
    await closeSettings(c);
    await sleep(500);

    /* ── C3: the person's menu, one field ─────────────────────────────────────────────────────── */
    const single = mode === "dark" ? "482913" : "306118";
    receive("Messages", single, "Your Fixture verification code is {code}. Don't share it with anyone.");
    fs.writeFileSync(pickFile, `real:2500:${single.slice(0, 3)}`);
    const m0 = lines(menuLog).length;
    await shotMenu(`03-suggestion-field-${mode}`, async () => click(await centre("#otp")));
    await until(async () => (await otpValue()) === single, 15_000, "field filled");
    const rows = JSON.parse(lines(menuLog)[m0] ?? "{}").rows;
    check(`C3 [${mode}] a click in the code field offers the code from Messages, and a pick fills it`, rows?.[0] === `${single.slice(0, 3)} ${single.slice(3)} — from Messages` && (await otpValue()) === single, rows);
    await shotWindow(`04-filled-field-${mode}`);

    /* ── C3: six boxes ────────────────────────────────────────────────────────────────────────── */
    await go("/split");
    const split = mode === "dark" ? "731904" : "558270";
    receive("Mail", split, "Your sign-in code\nUse {code} to sign in. It expires in 10 minutes.", 5_000);
    fs.writeFileSync(pickFile, `real:2500:${split.slice(0, 3)}`);
    const m1 = lines(menuLog).length;
    await shotMenu(`05-suggestion-boxes-${mode}`, async () => click(await centre("#d0")));
    await until(async () => (await boxValues()) === split, 15_000, "boxes filled");
    const boxRows = JSON.parse(lines(menuLog)[m1] ?? "{}").rows;
    check(`C3 [${mode}] the six boxes offer the newer code, from Mail, and take one digit each`, boxRows?.[0]?.endsWith("— from Mail") && (await boxValues()) === split, boxRows);
    await shotWindow(`06-filled-boxes-${mode}`);

    /* ── C4: an agent's fill, approved ────────────────────────────────────────────────────────── */
    await go("/verify");
    const agentCode = mode === "dark" ? "615247" : "924031";
    receive("Messages", agentCode, "{code} is your Fixture code. It expires in 5 minutes.", 2_000);
    const snap = text(await call("browser_snapshot", { browserId }));
    const ref = Number(/\[ref=(\d+)\] textbox "Verification code"/.exec(snap)?.[1] ?? /\[ref=(\d+)\] textbox/.exec(snap)?.[1]);
    const cards0 = cards.length;
    const pending = call("browser_fill_code", { browserId, ref });
    const card = await until(() => cards.slice(cards0).find((k) => k.tool === "browser_fill_code"), 15_000, "code card");
    await until(() => evalIn(c, `[...document.querySelectorAll('.permission-card, [class*=permission]')].some((n) => n.textContent.includes('Fill the security code'))`).catch(() => false), 10_000, "card on screen");
    check(`C4 [${mode}] the card names the site and nothing of the code, and nothing is typed before it is answered`,
      card.title === `Fill the security code from Messages or Mail into the page on 127.0.0.1:${SITE_PORT}` && !JSON.stringify(card).includes(agentCode) && (await otpValue()) === "", card);
    await shotWindow(`07-agent-card-${mode}`);
    await api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: "allow" });
    const result = await pending;
    const resultText = text(result);
    fs.writeFileSync(path.join(OUT_DIR, `08-agent-tool-result-${mode}.txt`), `browser_fill_code → ${result.isError ? "error" : "ok"}: ${resultText}\n`);
    check(`C4 [${mode}] approved, it fills the field and answers "filled", without the code`, !result.isError && resultText === "filled" && (await otpValue()) === agentCode, resultText);
    const after = text(await call("browser_snapshot", { browserId }));
    check(`C4 [${mode}] the agent's next snapshot does not carry the code`, !after.includes(agentCode), null);
    await shotWindow(`08-agent-filled-${mode}`);

    /* ── C4: declined ─────────────────────────────────────────────────────────────────────────── */
    await go("/verify");
    const cards1 = cards.length;
    const declined = call("browser_fill_code", { browserId, ref: Number(/\[ref=(\d+)\] textbox/.exec(text(await call("browser_snapshot", { browserId })))?.[1]) });
    const card2 = await until(() => cards.slice(cards1).find((k) => k.tool === "browser_fill_code"), 15_000, "second code card");
    await api.call("sessions.respondPermission", { id: sessionId, requestId: card2.requestId, decision: "deny" });
    const no = await declined;
    check(`C4 [${mode}] a declined card fills nothing and answers "declined"`, no.isError && /^declined/.test(text(no)) && (await otpValue()) === "", text(no));

    /* ── C3: an old message offers nothing ────────────────────────────────────────────────────── */
    clearInbox();
    receive("Messages", "777001", "Your Fixture verification code is {code}.", 6 * 60_000);
    fs.writeFileSync(pickFile, "777");
    const m2 = lines(menuLog).length;
    await click(await centre("#otp"));
    await sleep(1200);
    check(`C3 [${mode}] a code older than five minutes is not offered`, lines(menuLog).length === m2 && (await otpValue()) === "", lines(menuLog).slice(m2));
    clearInbox();
  }

  /* ── C5: nowhere it should not be ───────────────────────────────────────────────────────────── */
  const db = path.join(home, "realm.db");
  const q = (sql) => execFileSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const inflated = q("SELECT hex(payload_json) FROM session_events WHERE typeof(payload_json) = 'blob'").split("\n").filter(Boolean)
    .map((h) => inflateRawSync(Buffer.from(h, "hex").subarray(1)).toString("utf8")).join("\n");
  const dump = `${q(".dump")}\n${inflated}`;
  check("C5 no code anywhere in realm.db", !CODES.some((s) => dump.includes(s)), { bytes: dump.length, codes: CODES.length });
  const logDir = path.join(home, "logs");
  const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("\n") : "";
  check("C5 nor in any log, nor in what the app printed", !CODES.some((s) => logs.includes(s) || appOutput.join("").includes(s)), null);
  check("C5 the home keeps only the switch", fs.readFileSync(path.join(home, "security-codes.json"), "utf8").trim() === '{"enabled":true}', null);
  pane.close();
  c.close();
}

/** A live window opens behind the person's, unkeyed, and greys its accent; hold it as if key. */
async function keepKey(c) {
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute('data-window-inactive');
    new MutationObserver(() => root.removeAttribute('data-window-inactive')).observe(root, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
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
  await until(() => evalIn(c, `!!document.querySelector('[data-setting="security-codes"]')`), 10_000, "passwords page");
}

async function closeSettings(c) {
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector('.signins')`), 10_000, "settings closed");
}

async function teardown() {
  if (process.exitCode) {
    console.log(`MENUS ${JSON.stringify(lines(menuLog))}`);
    console.log(`APP OUTPUT (tail) ${appOutput.join("").slice(-3000)}`);
  }
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
