/**
 * Live check for switching a session's agent mid-conversation and for the accounts in the prompter
 * (run with: pnpm build && node apps/desktop/scripts/switch-accounts-live.mjs).
 *
 * Boots the BUILT app on a scratch home, in the unfocusable scratch window, with the scripted agent
 * standing in for Claude and Codex (`REALM_FAKE_STANDS_IN`) and stub CLIs behind REALM_CLAUDE_BIN and
 * REALM_CODEX_BIN — so no turn is billed, no real login runs, and nothing reads or writes the owner's
 * `~/.claude` or `~/.codex`. With the scripted agent on, the server writes the hand-off note verbatim
 * rather than on a model, which is what it would do on a Mac with no Claude.
 *
 *   1. The picker's Account row, opened on two accounts: the CLI's own and one added here.
 *   2. "Add account…" in the picker: the CLI's sign-in started, its first step followed in place.
 *   3. A session that has run, picking another agent's model: the question it asks first.
 *   4. The transcript's hand-off line, and its Summary link opening the note in Documents.
 *   5. Settings ▸ Engines: the Claude card's accounts.
 * Every capture is taken dark and light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8794 / 9234). Screenshots go to LIVE_OUT; the scratch home
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9234);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8794);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-switch-accounts-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const SCRATCH_ROOT = process.env.LIVE_SCRATCH ?? path.join(os.tmpdir(), "realm-switch-accounts-scratch");
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, "run-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
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
    echo "https://claude.ai/oauth/authorize?code=true&client_id=stub-live&response_type=code&state=live"
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
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_HTML_MENUS: "1",
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
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "a session");
  const sid = sessions[0].id;
  // The scripted agent, standing in under Claude's name: a session that runs, on an agent with accounts.
  await api.call("sessions.setAgent", { id: sid, agentKind: "claude" });
  await api.call("sessions.send", { id: sid, text: "Add a health endpoint to the API.", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.get", { id: sid })).status === "idle" && (await api.call("sessions.get", { id: sid })).lastEventSeq > 0, 30_000, "a turn");
  await until(() => evalIn(c, `__live.qa('.msg-assistant').length > 0`), 15_000, "the answer drawn");

  /* ── 1. A second account, and the picker's Account row opened on both ── */
  const { account: work } = await api.call("accounts.add", { kind: "claude", label: "Work" });
  fs.writeFileSync(path.join(work.configDir, ".email"), "carlton@work.example");
  fs.writeFileSync(path.join(work.configDir, ".go"), "");
  check("an added account's folder is under the scratch home", work.configDir.startsWith(path.join(home, "accounts", "claude")), work.configDir);
  await until(async () => (await api.call("accounts.list", { refresh: true })).accounts.find((a) => a.id === work.id)?.signedIn === true, 20_000, "Work signed in");
  const listed = (await api.call("accounts.list", {})).accounts.filter((a) => a.kind === "claude");
  check("the CLI's own account and the added one, the added one by its email", listed.length === 2 && listed[1].email === "carlton@work.example", listed.map((a) => [a.label, a.email, a.signedIn]));

  await evalIn(c, `__live.click(__live.q('.model-chip'))`);
  await until(() => evalIn(c, `!!__live.q('.model-picker .mp-account-head')`), 10_000, "account row");
  await evalIn(c, `__live.click(__live.q('.mp-account-head'))`);
  await until(() => evalIn(c, `__live.qa('.mp-account-list [role=option]').length === 2`), 10_000, "two accounts");
  const rows = await evalIn(c, `__live.qa('.mp-account-list [role=option]').map((r) => r.textContent)`);
  check("the picker lists both accounts, the current one ticked", rows[0].startsWith("Default") && rows[1] === "Workcarlton@work.example"
    && await evalIn(c, `__live.q('.mp-account-list [role=option][aria-selected=true]')?.textContent.startsWith('Default')`), rows);
  const fit = await evalIn(c, `(() => { const p = __live.box(__live.q('.model-picker')); return { top: p.y, bottom: p.y + p.h, win: innerHeight }; })()`);
  check("the opened picker stays inside the window", fit.top >= 0 && fit.bottom <= fit.win, fit);
  await shots(c, "1-picker-accounts", ".model-picker", 16);

  /* ── 2. Add account…, from the picker ── */
  await evalIn(c, `__live.click(__live.button('Add account…'))`);
  await until(() => evalIn(c, `/Finish signing in to Account 3/.test(__live.q('.mp-account .account-signin')?.textContent ?? '')`), 15_000, "sign-in step");
  check("the sign-in is followed in the picker, with the page one click away",
    await evalIn(c, `!!__live.button('Open the page again', __live.q('.mp-account'))`));
  await shots(c, "2-add-account", ".model-picker", 16);
  await evalIn(c, `__live.click(__live.button('Cancel', __live.q('.mp-account')))`);
  await until(() => evalIn(c, `!__live.q('.mp-account .account-signin')`), 10_000, "sign-in cancelled");
  await until(async () => (await api.call("accounts.list", {})).accounts.filter((a) => a.kind === "claude").length === 2, 10_000, "cancelled account taken back");
  check("cancelling the sign-in Add started takes the account back", true);

  /* ── 3. Another agent's model on a session that has run: the question first ── */
  await evalIn(c, `(() => { const r = __live.qa('.mp-row').find((x) => /GPT-6 Luna/.test(x.textContent)); r.scrollIntoView({ block: 'center' }); r.click(); return true; })()`);
  await until(() => evalIn(c, `!!__live.q('.mp-switch')`), 10_000, "switch question");
  const ask = await evalIn(c, `__live.q('.mp-switch').textContent`);
  check("it asks before the session moves, and says what moving means", ask.startsWith("Switch to Codex?It starts fresh with a summary of this conversation."), ask);
  check("nothing moved on the pick alone", (await api.call("sessions.get", { id: sid })).agentKind === "claude");
  await shots(c, "3-switch-confirm", ".model-picker", 16);

  /* ── 4. Switch, and the line it leaves ── */
  await evalIn(c, `__live.click(__live.button('Switch', __live.q('.mp-switch')))`);
  await until(async () => (await api.call("sessions.get", { id: sid })).agentKind === "codex", 20_000, "switched");
  await until(() => evalIn(c, `!__live.q('.mp-switch')`), 10_000, "question answered");
  check("the picker stays open for how the new model runs", await evalIn(c, `!!__live.q('.model-picker')`));
  await evalIn(c, `__live.click(__live.q('.model-chip'))`);
  await until(() => evalIn(c, `!__live.q('.model-picker')`), 5_000, "picker away");
  const seam = await until(() => evalIn(c, `(() => { const s = __live.qa('.msg-handoff').find((x) => /Switched from/.test(x.textContent)); return s ? s.textContent : null; })()`), 15_000, "hand-off line");
  check("the transcript names both models and links the summary", /^Switched from Claude .+ to Codex GPT-6 Luna·Summary$/.test(seam), seam);
  const row = await api.call("sessions.get", { id: sid });
  check("the session is on Codex's model, its Claude thread let go", row.model === "gpt-6-luna" && row.providerSessionId === null, row);
  await evalIn(c, `(() => { const s = __live.qa('.msg-handoff').find((x) => /Switched from/.test(x.textContent)); s.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(300);
  await evalIn(c, `(() => { __live.qa('.msg-handoff').find((x) => /Switched from/.test(x.textContent)).setAttribute('data-live-shot', ''); return true; })()`);
  await shots(c, "4-handoff-line", ".msg-handoff[data-live-shot]", 40);
  const note = path.join(home, "handoffs", sid, "handoff-1.md");
  check("the note is written under the home's handoffs folder", fs.existsSync(note), note);
  check("…naming both sides and carrying the conversation", /Switched from Claude .+ to Codex GPT-6 Luna/.test(fs.readFileSync(note, "utf8")) && /User: Add a health endpoint/.test(fs.readFileSync(note, "utf8")));
  await evalIn(c, `__live.click(__live.qa('.msg-handoff-link')[0])`);
  const opened = await until(() => evalIn(c, `(() => { const t = __live.qa('.documents-tab').map((x) => x.textContent).find((x) => /handoff-1/.test(x)); return t ?? null; })()`), 15_000, "note opened in Documents").catch(() => null);
  check("Summary opens the note in Documents", Boolean(opened), opened ?? await evalIn(c, `({ tabs: __live.qa('.documents-tab').map((x) => x.textContent),
    toasts: __live.qa('[role=alert], [role=status], .toast').map((x) => x.textContent).filter(Boolean).slice(0, 4),
    panes: __live.qa('[data-pane-kind], .pane-slot > *').map((x) => x.getAttribute('data-pane-kind') ?? x.className).slice(0, 8) })`));
  if (opened) {
    await sleep(600);
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "4b-summary-in-documents-dark.png"), Buffer.from(r.data, "base64"));
    console.log(`SCREENSHOT ${path.join(OUT_DIR, "4b-summary-in-documents-dark.png")}`);
  }

  /* ── 5. Settings ▸ Engines: the Claude card's accounts ── */
  await evalIn(c, `(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    return true; })()`);
  const inSettings = await until(() => evalIn(c, `!!__live.q('.settings-page-pane, .settings-page')`), 8_000, "settings").catch(() => false);
  if (inSettings) {
    await evalIn(c, `(() => { const t = __live.qa('label, [role=radio], button').find((x) => x.textContent.trim() === 'Engines'); t?.click(); return true; })()`);
    const card = await until(() => evalIn(c, `!!__live.q('.engine-accounts')`), 10_000, "engine accounts").catch(() => false);
    check("the Claude card lists its accounts", card);
    if (card) {
      await evalIn(c, `(() => { __live.q('.engine-accounts').closest('.engine-card').setAttribute('data-live-shot', ''); __live.q('.engine-card[data-live-shot]').scrollIntoView({ block: 'center' }); return true; })()`);
      await shots(c, "5-engine-accounts", ".engine-card[data-live-shot]", 16);
    }
  } else check("Settings opened from ⌘,", false);
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
    killPort(SERVER_PORT); killPort(CDP_PORT);
    process.exit(process.exitCode ?? 0);
  });
