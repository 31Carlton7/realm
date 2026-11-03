/**
 * Live check for the picker's Account row in its three states (run with: pnpm build && node
 * apps/desktop/scripts/account-switcher-live.mjs).
 *
 * Boots the BUILT app on a scratch home, in the unfocusable scratch window, with the scripted agent
 * standing in for Claude (`REALM_FAKE_STANDS_IN`) and a stub CLI behind REALM_CLAUDE_BIN, so no turn
 * is billed, no real login runs, and nothing reads or writes the owner's `~/.claude`.
 *
 *   1. Closed: the account in force, in the foot of the picker.
 *   2. Open: the agent's two accounts as rows of one kind on one edge, the current one ticked, and
 *      Add account last. The default account carries the email its CLI is signed in as.
 *   3. Signing in: Add account's sign-in, held at the CLI's prompt for a code.
 *   4. The same sign-in as Settings ▸ Engines follows it, on the Claude card.
 * Every capture is taken dark and light.
 *
 * The renderer is served over http (LIVE_HTTP_PORT), because the squircle paint worklet does not load
 * from file://.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT / LIVE_HTTP_PORT (8796 / 9236 / 8851). Screenshots go to LIVE_OUT; the scratch home
 * to LIVE_SCRATCH. It touches only those, and kills only the processes it started.
 */
import { spawn, execFileSync } from "node:child_process";
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
const HTTP_PORT = Number(process.env.LIVE_HTTP_PORT ?? 8851);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-account-switcher-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const SCRATCH_ROOT = process.env.LIVE_SCRATCH ?? path.join(os.tmpdir(), "realm-account-switcher-scratch");
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, "run-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let web = null;
let api = null;

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
    await sleep(150);
  }
}

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(String(i), (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
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

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      // Only a process started for THIS scratch home: the owner's daemon never shares these ports,
      // but a guess by port alone is how a sweep once killed someone else's run.
      let cmd = "";
      try { cmd = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { continue; }
      if (cmd.includes(scratch)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  box: (n) => { const b = n.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A real press of the mouse on the first match, as a person's click is (a scripted `click()` reads as the keyboard's). */
async function press(c, find) {
  const b = await evalIn(c, `(() => { const n = ${find}; if (!n) return null; n.scrollIntoView({ block: 'nearest' }); return __live.box(n); })()`);
  if (!b) throw new Error(`nothing to press: ${find}`);
  const at = { x: b.x + b.w / 2, y: b.y + b.h / 2, button: "left", clickCount: 1 };
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
}

/** Hold the window key and focused, so the accent is the accent and not the inactive grey. */
async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

/** The scratch window's red banner says what it is to a person; the captures are of the product. */
async function dropBanner(c) {
  await evalIn(c, `(() => { const hide = () => document.getElementById('live-scratch-banner')?.remove(); hide();
    new MutationObserver(hide).observe(document.body, { childList: true }); return true; })()`);
}

/** One capture in each face, around `sel` with `pad` of what is beside it. */
async function shots(c, tag, sel, pad = 24) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 899 });
  for (const mode of ["dark", "light"]) {
    await evalIn(c, `(document.documentElement.setAttribute('data-mode', ${JSON.stringify(mode)}), true)`);
    // Placed by its laid-out size, not one read mid-move: wait until two looks agree.
    const look = () => evalIn(c, `(() => { const n = document.querySelector(${JSON.stringify(sel)}); return n ? __live.box(n) : null; })()`);
    let b = await look();
    for (let i = 0; i < 20; i++) { await sleep(150); const again = await look(); if (JSON.stringify(again) === JSON.stringify(b)) break; b = again; }
    if (!b) throw new Error(`nothing to capture: ${sel}`);
    const clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + pad * 2, height: b.h + pad * 2, scale: 2 };
    const r = await c.send("Page.captureScreenshot", { format: "png", clip });
    const out = path.join(OUT_DIR, `${tag}-${mode}.png`);
    fs.writeFileSync(out, Buffer.from(r.data, "base64"));
    console.log(`SCREENSHOT ${out}`);
  }
  await evalIn(c, `(document.documentElement.setAttribute('data-mode', 'dark'), true)`);
}

/* Stub CLIs, reached only through REALM_CLAUDE_BIN/REALM_CODEX_BIN. Claude's keeps a login per folder,
   as the real one does: signed in where `.signed-in` is in its CLAUDE_CONFIG_DIR, as `.email` says,
   and its login prints the page and waits until the check drops `.go` in the folder. The CLI's own
   folder is the stub's own, always signed in. Neither opens a browser. */
const STUB_DIR = path.join(scratch, "stubs");
fs.mkdirSync(STUB_DIR, { recursive: true });
const stub = (name, body) => { const p = path.join(STUB_DIR, name); fs.writeFileSync(p, `#!/bin/bash\n${body}\n`); fs.chmodSync(p, 0o755); return p; };
const claudeBin = stub("claude", `D="\${CLAUDE_CONFIG_DIR:-${STUB_DIR}/own-claude}"; mkdir -p "$D"; [ -z "$CLAUDE_CONFIG_DIR" ] && touch "$D/.signed-in"
case "$1 $2" in
  "--version "*) echo "2.1.316 (Claude Code)";;
  "auth status") if [ -f "$D/.signed-in" ]; then echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"email\\":\\"$(cat "$D/.email" 2>/dev/null)\\",\\"subscriptionType\\":\\"max\\"}"; else echo '{"loggedIn":false}'; exit 1; fi;;
  "auth login") echo "Opening browser to sign in..."; echo "Browser didn't open? Use the url below to sign in:"; echo ""
    echo "https://claude.ai/oauth/authorize?code=true&client_id=stub-live&response_type=code&state=live"; echo ""; printf "Paste code here if prompted > "
    for i in $(seq 1 1200); do [ -f "$D/.go" ] && break; sleep 0.1; done
    [ -f "$D/.go" ] || exit 1; touch "$D/.signed-in"; echo "Login successful."; exit 0;;
  "auth logout") rm -f "$D/.signed-in";;
  *) exit 1;;
esac`);
const codexBin = stub("codex", `case "$1 $2" in
  "--version "*) echo "codex-cli 0.166.0";;
  "login status") echo "Logged in using ChatGPT";;
  *) exit 1;;
esac`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, HTTP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  web = spawn("python3", ["-m", "http.server", String(HTTP_PORT), "--bind", "127.0.0.1"],
    { cwd: path.join(repoRoot, "apps/desktop/out/renderer"), stdio: "ignore" });
  await until(async () => !(await portFree(HTTP_PORT)), 10_000, "renderer server");
  const rendererUrl = `http://127.0.0.1:${HTTP_PORT}/index.html`;
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_HTML_MENUS: "1",
      ELECTRON_RENDERER_URL: rendererUrl,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_LIVE_SCRATCH: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_CLAUDE_BIN: claudeBin,
      REALM_CODEX_BIN: codexBin,
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory-fallback"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(rendererUrl)), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await dropBanner(c);
  check("the squircle painter is on", await evalIn(c, `document.documentElement.hasAttribute('data-squircle')`));
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "a session");
  // The scripted agent, standing in under Claude's name: a session on an agent with accounts.
  await api.call("sessions.setAgent", { id: sessions[0].id, agentKind: "claude" });

  // The fake engines keep the server from asking the CLI's own folder who it is, so the default
  // account is given the email it would have said (LIVE_DEFAULT_EMAIL; empty for one that said none).
  const defaultEmail = process.env.LIVE_DEFAULT_EMAIL ?? "carlton@example.com";
  if (defaultEmail) execFileSync("sqlite3", [path.join(home, "realm.db"), `UPDATE agent_accounts SET email = '${defaultEmail}' WHERE id = 'default-claude';`]);
  const { account: work } = await api.call("accounts.add", { kind: "claude", label: "Work" });
  fs.writeFileSync(path.join(work.configDir, ".email"), "carlton@work.example");
  fs.writeFileSync(path.join(work.configDir, ".go"), "");
  await until(async () => (await api.call("accounts.list", { refresh: true })).accounts.find((a) => a.id === work.id)?.signedIn === true, 20_000, "Work signed in");

  /* ── 1. Closed ── */
  await evalIn(c, `__live.click(__live.q('.model-chip'))`);
  await until(() => evalIn(c, `!!__live.q('.model-picker .mp-account [aria-expanded]')`), 10_000, "account row");
  // Moved to the added account first, so the closed row carries an email as the owner's did.
  await press(c, `__live.q('.mp-account [aria-expanded]')`);
  await until(() => evalIn(c, `!!__live.qa('.mp-account [role=option]').find((o) => /^Work/.test(o.textContent))`), 10_000, "Work listed");
  await press(c, `__live.qa('.mp-account [role=option]').find((o) => /^Work/.test(o.textContent))`);
  await until(async () => (await api.call("sessions.get", { id: sessions[0].id })).accountId === work.id, 10_000, "on Work");
  await sleep(300);
  await evalIn(c, `(() => { const t = __live.q('.mp-account [aria-expanded=true]'); if (t) t.click(); return true; })()`);
  await until(() => evalIn(c, `!__live.q('.mp-account [role=option]') && /carlton@work\\.example/.test(__live.q('.mp-account').textContent)`), 10_000, "closed on Work");
  // Put away and opened again, so the picker is placed for the row it now holds.
  await press(c, `__live.q('.model-chip')`);
  await until(() => evalIn(c, `!__live.q('.model-picker')`), 5_000, "picker away");
  await press(c, `__live.q('.model-chip')`);
  await until(() => evalIn(c, `!!__live.q('.model-picker .mp-account [aria-expanded]')`), 10_000, "picker back");
  await shots(c, "1-closed", ".model-picker", 16);

  /* ── 2. Open ── */
  await press(c, `__live.q('.mp-account [aria-expanded]')`);
  await until(() => evalIn(c, `__live.qa('.mp-account [role=option]').length === 2`), 10_000, "two accounts");
  const named = await evalIn(c, `(__live.q('.mp-account').textContent.match(/carlton@work\\.example/g) ?? []).length`);
  check("the open row names each account once", named === 1, named);
  const rows = await evalIn(c, `__live.qa('.mp-account [role=option]').map((o) => ({
    text: o.textContent, name: o.querySelector('.mp-account-name').getBoundingClientRect().left,
    tick: o.querySelector('.mp-check')?.getBoundingClientRect().right ?? null, right: o.getBoundingClientRect().right }))`);
  check("every account starts on one edge", new Set(rows.map((r) => Math.round(r.name))).size === 1, rows);
  check("the default account names the CLI's sign-in", rows[0].text === `Default${defaultEmail || "CLI sign-in"}`, rows[0].text);
  check("the tick sits in the rows' shared column", rows.filter((r) => r.tick !== null).length === 1 && rows.every((r) => Math.round(r.right) === Math.round(rows[0].right)), rows);
  check("the open list carries no Account label", await evalIn(c, `!__live.q('.mp-account .mp-seg-label')`));
  await shots(c, "2-open", ".model-picker", 16);

  /* ── 3. Signing in, at the prompt for a code ── */
  check("a click opens the list with no focus ring", await evalIn(c, `!__live.q('.mp-account :focus-visible')`));
  await press(c, `__live.qa('.mp-account button').find((b) => /^Add account/.test(b.textContent.trim()))`);
  await until(() => evalIn(c, `!!__live.q('.mp-account input[aria-label="Code from the sign-in page"]')`), 20_000, "code prompt");
  check("the sign-in is followed in the picker, with the page one click away", await evalIn(c, `!!__live.button('Open again', __live.q('.mp-account'))`));
  check("a click leaves no focus ring in the account row", await evalIn(c, `!__live.q('.mp-account :focus-visible')`));
  const fits = await evalIn(c, `(() => { const p = __live.q('.mp-account .account-signin').getBoundingClientRect();
    return __live.qa('.mp-account .account-signin-actions button').every((b) => { const r = b.getBoundingClientRect(); return r.right <= p.right && r.height <= 30; }); })()`);
  check("the sign-in's actions sit on one line inside its panel", fits);
  await shots(c, "3-signing-in", ".model-picker", 16);

  /* ── 4. The same sign-in on Settings ▸ Engines ── */
  await evalIn(c, `__live.click(__live.q('.model-chip'))`);
  await until(() => evalIn(c, `!__live.q('.model-picker')`), 5_000, "picker away");
  await evalIn(c, `(window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true })), true)`);
  await until(() => evalIn(c, `!!__live.q('.settings-page-pane, .settings-page')`), 8_000, "settings");
  await evalIn(c, `(() => { const t = __live.qa('label, [role=radio], button').find((x) => x.textContent.trim() === 'Engines'); t?.click(); return true; })()`);
  await until(() => evalIn(c, `!!__live.q('.engine-accounts .account-signin')`), 10_000, "engine card sign-in");
  await evalIn(c, `(() => { const card = __live.q('.engine-accounts').closest('.engine-card'); card.setAttribute('data-live-shot', ''); card.scrollIntoView({ block: 'center' }); return true; })()`);
  await shots(c, "4-engines-signing-in", ".engine-card[data-live-shot]", 16);
  await evalIn(c, `__live.click(__live.button('Cancel', __live.q('.engine-accounts .account-signin')))`);
  await until(() => evalIn(c, `!__live.q('.engine-accounts .account-signin')`), 10_000, "sign-in cancelled");
  c.close();
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch { /* already gone */ }
    try { api?.close(); } catch { /* closed */ }
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch { /* gone */ }
    await stopDaemons(home);
    web?.kill("SIGKILL");
    killPort(SERVER_PORT); killPort(CDP_PORT);
    process.exit(process.exitCode ?? 0);
  });
