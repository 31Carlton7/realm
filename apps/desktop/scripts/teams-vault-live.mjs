/**
 * Live check for the team vault, Teams Phase 2 (run with: pnpm build && node apps/desktop/scripts/teams-vault-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch home with the scripted agent standing
 * in for every engine, so nothing is billed, and a local HTTP server standing in for an API:
 *
 *   V1  a team's sign-ins and keys go in through the Vault page's own bridge, and the page draws them;
 *   V2  the Growth Analyst is granted REVENUECAT_SECRET_KEY from the grant sheet's switch;
 *   V3  its run calls vault_http: the session's card asks, the request reaches the server WITH the key,
 *       and the answer the agent reads has the key scrubbed out of it;
 *   V4  "Use without asking" opens the sheet that says what it costs; Turn on asks macOS (a stand-in
 *       helper answers yes and logs the ask); with the profile also unlocking without asking, the next
 *       run uses the key with no card — and the log says so;
 *   V5  a key the role was not granted, and a host its grant does not name, are refused and logged,
 *       and nothing reaches the server;
 *   V6  the value is in NO row of session_events, mcp_call_log or team_activity, in no audit line,
 *       and not in secrets.json in the clear;
 *   V7  the Vault page, the grant sheet and the warning, dark and light, for comparing with mock 06;
 *   V8  turning it off is one click, and the card is back.
 *
 * Touch ID is stood in for too: with REALM_LIVE_PRESENCE_LOG set (honoured only in an unpackaged harness,
 * see live-presence.ts), each ask is a line in that log, answered yes, and no prompt reaches the screen.
 *
 * `--use-mock-keychain`, so no Keychain item is read or written. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT
 * (8815 / 9255), and LIVE_ECHO_PORT (8897) for the stand-in API, all refused if taken and reaped by port.
 * Screenshots go to LIVE_OUT.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9255);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8815);
const ECHO_PORT = Number(process.env.LIVE_ECHO_PORT ?? 8897);
const OTHER_PORT = ECHO_PORT + 1;
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-teams-vault-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-vault-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The key, as the person would paste it. The run proves this string reaches the API and nowhere else. */
const SECRET = "sk_live_VAULTLIVE_7f3a9c2e1b8d4f60aa";
let electron = null;
let api = null;
let echo = null;

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
    await sleep(150);
  }
}
function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(String(msg.id))?.(msg); });
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
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}

const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  click(el) { if (!el) throw new Error('nothing to click'); el.click(); return true; },
  button(text, root = document) { return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled) ?? null; },
  named(re, root = document) { return [...root.querySelectorAll('button, [role=switch]')].find((b) => new RegExp(re).test(b.getAttribute('aria-label') ?? '')) ?? null; },
  tab(text) { return [...document.querySelectorAll('.sb-page-nav label.settings-tab')].find((l) => l.textContent.trim().startsWith(text)) ?? null; },
  text: (sel) => document.querySelector(sel)?.textContent ?? null,
};
void 0`;
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: `${HELPERS};\n${expr}`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(c, tag) {
  await sleep(1100); // past the column's slide and a sheet's spring, so the frame is the surface at rest
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
async function holdKey(c) {
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
}

/* ── the stand-in API: echoes what it was sent, including the key ─────────────────────────────── */

const received = [];
function startEcho() {
  echo = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      received.push({ url: req.url, auth: req.headers.authorization ?? null, body });
      res.writeHead(200, { "content-type": "application/json" });
      // What a careless API does: quote the credential back, raw and base64'd.
      res.end(JSON.stringify({ ok: true, path: req.url, youSent: req.headers.authorization ?? null, b64: Buffer.from(req.headers.authorization ?? "").toString("base64"), body }));
    });
  });
  return new Promise((r) => echo.listen(ECHO_PORT, "127.0.0.1", r));
}

/* ── the scripted agent ─────────────────────────────────────────────────────────────────────────── */

const ECHO_URL = `http://127.0.0.1:${ECHO_PORT}/v1/subscribers/app_user_1`;
const SCRIPT = [
  { on: "pull the numbers", emit: [
    { kind: "call", tool: "realm-vault__vault_list", input: {} },
    { kind: "call", tool: "realm-vault__vault_http", input: { secret: "REVENUECAT_SECRET_KEY", method: "POST", url: ECHO_URL, headers: { Authorization: "Bearer {{secret}}" }, body: '{"note":"weekly numbers"}' } },
    { kind: "usage", costUsd: 0.04 },
    { kind: "text", text: "Read this week's subscribers from RevenueCat." },
  ] },
  { on: "ask for the Vercel token", emit: [
    { kind: "call", tool: "realm-vault__vault_http", input: { secret: "VERCEL_TOKEN", url: "https://api.vercel.com/v9/projects", headers: { Authorization: "Bearer {{secret}}" } } },
    { kind: "text", text: "Tried the Vercel token." },
  ] },
  { on: "send it elsewhere", emit: [
    { kind: "call", tool: "realm-vault__vault_http", input: { secret: "REVENUECAT_SECRET_KEY", url: `http://127.0.0.1:${OTHER_PORT}/collect`, headers: { Authorization: "Bearer {{secret}}" } } },
    { kind: "text", text: "Tried another host." },
  ] },
];

/* ── boot ───────────────────────────────────────────────────────────────────────────────────────── */

const ownerLog = path.join(scratch, "owner-asks.log");
const ownerAsks = () => (fs.existsSync(ownerLog) ? fs.readFileSync(ownerLog, "utf8").trim().split("\n").filter(Boolean) : []);
const presenceLog = path.join(scratch, "presence-asks.log");
const presenceAsks = () => (fs.existsSync(presenceLog) ? fs.readFileSync(presenceLog, "utf8").trim().split("\n").filter(Boolean) : []);

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT, OTHER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  // The app's path is this scratch dir (the wrapper's), so `device-owner.ts` finds the stand-in: the
  // person typing their login password, answering yes and leaving a line saying it was asked.
  fs.mkdirSync(path.join(scratch, "native/bin"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "native/bin/deviceowner"), `#!/bin/bash\n[ "$1" = "can" ] && { echo yes; exit 0; }\necho "$2" >> ${JSON.stringify(ownerLog)}\nexit 0\n`, { mode: 0o755 });
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.commandLine.appendSwitch("use-mock-keychain");', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1",
      REALM_FAKE_STANDS_IN: "claude", REALM_FAKE_SCRIPT: scriptFile, REALM_LIVE_PRESENCE_LOG: presenceLog,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
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
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Versed");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await holdKey(c);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

async function openVault(c) {
  if (!(await evalIn(c, `!!__live.tab('Vault')`))) {
    await evalIn(c, `__live.click(__live.named('^More for Versed$'))`);
    // The menu's row, not the sidebar's Team fold, which wears the same word.
    const row = `[...document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] button')].find((b) => b.textContent.trim() === 'Team')`;
    await until(() => evalIn(c, `!!${row}`), 5_000, "menu row Team");
    await evalIn(c, `__live.click(${row})`);
    await until(() => evalIn(c, `!!__live.tab('Vault')`), 8_000, "team column");
  }
  await evalIn(c, `__live.click(__live.tab('Vault'))`);
  await until(() => evalIn(c, `__live.text('.page-head h1') === 'Vault' && __live.qa('.tv-list .tv-row').length >= 6`), 10_000, "vault page");
}

/** Run the role on `message`, answer its card if one comes (or fail if one comes when none should),
 *  and return the run's session's tool results once it settles. */
async function runRole(roleId, message, { expectCard }) {
  const run = await api.call("team.roleRun", { id: roleId, message });
  const sessionId = await until(async () => (await api.call("team.roleRuns", { id: roleId, limit: 10 })).find((r) => r.id === run.id)?.sessionId, 20_000, "run session");
  let cards = 0;
  const done = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    for (const e of evs.filter((x) => x.event.type === "permission_request")) {
      const answered = evs.some((x) => x.event.type === "permission_response" && x.event.payload.requestId === e.event.payload.requestId);
      if (!answered) { cards++; await api.call("sessions.respondPermission", { id: sessionId, requestId: e.event.payload.requestId, decision: "allow" }); }
    }
    const r = (await api.call("team.roleRuns", { id: roleId, limit: 10 })).find((x) => x.id === run.id);
    return r && !["queued", "running", "blocked"].includes(r.state) ? evs : null;
  }, 40_000, `run ${message}`);
  const cardsSeen = done.filter((x) => x.event.type === "permission_request");
  if (expectCard !== undefined) check(`${expectCard ? "a card asked" : "no card asked"} for "${message}"`, expectCard ? cardsSeen.length === 1 : cardsSeen.length === 0, cardsSeen.map((x) => x.event.payload.title));
  return { sessionId, results: done.filter((x) => x.event.type === "tool_result").map((x) => x.event.payload) };
}

let liveC = null;
async function main() {
  if (!(await portFree(ECHO_PORT))) throw new Error(`port ${ECHO_PORT} is in use — refusing to run`);
  await startEcho();
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  const profileId = space.profileId;
  await api.call("team.make", { spaceId: space.id, templates: ["creator-manager", "content-producer"], roles: [] });
  const ga = await api.call("team.roleCreate", { spaceId: space.id, name: "Growth Analyst", brief: "Read RevenueCat, PostHog and each post's views; report Mondays.", realmite: { seed: "growth-analyst-372" }, agentKind: "fake", model: "sonnet", cron: null });
  const team = await api.call("team.space", { spaceId: space.id });
  for (const r of team.roles) await api.call("team.roleUpdate", { id: r.id, agentKind: "fake" });
  const roleId = (name) => team.roles.find((r) => r.name === name).id;

  /* ── V1: secrets in through the Vault page's bridge ──────────────────────────────────────────── */
  const ipc = (expr) => evalIn(c, `(async () => { const v = window.realm.vault; ${expr} })()`);
  const P = JSON.stringify(profileId); const S = JSON.stringify(space.id);
  const ids = await ipc(`
    const rc = await v.addKey(${P}, ${S}, { name: "REVENUECAT_SECRET_KEY", label: "", allowedHosts: ["api.revenuecat.com", "127.0.0.1:${ECHO_PORT}"], value: ${JSON.stringify(SECRET)} });
    const ph = await v.addKey(${P}, ${S}, { name: "POSTHOG_PERSONAL_KEY", label: "", allowedHosts: ["us.posthog.com"], value: "phx_live_posthog_0000" });
    const vc = await v.addKey(${P}, ${S}, { name: "VERCEL_TOKEN", label: "", allowedHosts: ["api.vercel.com"], value: "vercel_live_token_0000" });
    const tt = await v.addSignin(${P}, ${S}, { origin: "https://www.tiktok.com", username: "nathan", label: "@versed.nathan", value: "tiktok-password-0000" });
    const ig = await v.addSignin(${P}, ${S}, { origin: "https://www.instagram.com", username: "nathan", label: "@versed.nathan", value: "insta-password-0000" });
    const ss = await v.addSignin(${P}, ${S}, { origin: "https://app.sideshift.app", username: "carlton", label: "", value: "sideshift-password-0000" });
    return { rc: rc.id, ph: ph.id, vc: vc.id, tt: tt.id, ig: ig.id, ss: ss.id };`);
  for (const [secretId, roles] of [[ids.tt, ["Creator Manager", "Content Producer"]], [ids.ig, ["Creator Manager", "Content Producer"]], [ids.ss, ["Creator Manager"]], [ids.ph, ["Growth Analyst"]]]) {
    for (const r of roles) await api.call("team.vaultGrant", { spaceId: space.id, secretId, roleId: roleId(r), hosts: [], purpose: null });
  }
  const onDisk = fs.readFileSync(path.join(home, "secrets.json"), "utf8");
  check("V1 the key is in secrets.json only sealed", onDisk.includes("REVENUECAT_SECRET_KEY") && !onDisk.includes(SECRET), null);
  await openVault(c);
  const rows = await evalIn(c, `__live.qa('.tv-list .tv-name').map((n) => n.textContent)`);
  check("V1 the page draws the team's sign-ins and keys", rows.join() === "tiktok.com · nathan,instagram.com · nathan,app.sideshift.app · carlton,REVENUECAT_SECRET_KEY,POSTHOG_PERSONAL_KEY,VERCEL_TOKEN", rows);
  check("V1 its sections are sign-ins, recent use, keys", (await evalIn(c, `__live.qa('.form > h3.settings-head').map((h) => h.textContent).join()`)) === "Sign-ins,Recent use,Keys", null);

  /* ── V2: a grant from the sheet ──────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.named('^REVENUECAT_SECRET_KEY —'))`);
  await until(() => evalIn(c, `!!__live.named('^Growth Analyst may use REVENUECAT_SECRET_KEY$')`), 5_000, "grant sheet");
  await evalIn(c, `__live.click(__live.named('^Growth Analyst may use REVENUECAT_SECRET_KEY$'))`);
  await until(async () => (await api.call("team.vaultGrants", { spaceId: space.id })).some((g) => g.secretId === ids.rc && g.roleId === ga.id), 5_000, "grant made");
  const g = (await api.call("team.vaultGrants", { spaceId: space.id })).find((x) => x.secretId === ids.rc && x.roleId === ga.id);
  check("V2 the switch granted every host the key is locked to", g.hosts.join() === `api.revenuecat.com,127.0.0.1:${ECHO_PORT}`, g.hosts);
  await until(() => evalIn(c, `!!__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$')`), 5_000, "allow row");
  await shot(c, "02-grant-sheet-dark");

  /* ── V3: a run uses the key, on its card ─────────────────────────────────────────────────────── */
  const first = await runRole(ga.id, "Monday: pull the numbers from RevenueCat.", { expectCard: true });
  check("V3 the API got the key in the header Realm wrote", received.length === 1 && received[0].auth === `Bearer ${SECRET}`, received.map((r) => r.auth === `Bearer ${SECRET}`));
  const answer = first.results.find((r) => r.content.startsWith("HTTP "))?.content ?? "";
  check("V3 the agent read the answer, with the key scrubbed from it", /^HTTP 200/.test(answer) && answer.includes("[redacted]") && !answer.includes(SECRET) && !answer.includes(Buffer.from(`Bearer ${SECRET}`).toString("base64")), answer.slice(0, 300));
  const listed = first.results.find((r) => r.content.includes("What you may use"))?.content ?? "";
  check("V3 vault_list told the role its names only", listed.includes("REVENUECAT_SECRET_KEY") && listed.includes("POSTHOG_PERSONAL_KEY") && !listed.includes("VERCEL_TOKEN") && !listed.includes("tiktok"), listed);
  let uses = await api.call("team.vaultUses", { spaceId: space.id });
  check("V3 the use is a line in the log, on its card", uses[0]?.outcome === "used" && uses[0]?.how === "card" && uses[0]?.roleId === ga.id && uses[0]?.status === 200, uses[0]);
  check("V3 the allowed card asked for Touch ID (the stand-in answered)", presenceAsks().length === 1, presenceAsks());

  /* ── V4: use without asking ──────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$'))`);
  await until(() => evalIn(c, `!!__live.button('Turn on for Growth Analyst')`), 5_000, "warning sheet");
  check("V4 the switch opened the warning instead of applying", ownerAsks().length === 0, ownerAsks());
  check("V4 the warning is out of an agent's reach", await evalIn(c, `!!__live.button('Turn on for Growth Analyst').closest('[data-no-agent]')`), null);
  await shot(c, "03-without-asking-dark");
  await evalIn(c, `__live.click(__live.button('Turn on for Growth Analyst'))`);
  await until(() => evalIn(c, `!__live.button('Turn on for Growth Analyst') && __live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$')?.checked === true`), 8_000, "allow on");
  check("V4 Turn on asked macOS first", ownerAsks().length === 1 && /let Growth Analyst use REVENUECAT_SECRET_KEY without asking/.test(ownerAsks()[0]), ownerAsks());
  const allowSealed = JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8")).allow ?? {};
  check("V4 the allow is sealed in secrets.json, not written plain", Object.keys(allowSealed).length === 1 && !JSON.stringify(allowSealed).includes("Growth"), Object.keys(allowSealed));
  // The profile still asks Touch ID, so the card must still come: unattended needs both.
  await runRole(ga.id, "Tuesday: pull the numbers again.", { expectCard: true });
  const set = await ipc(`return window.realm.credentials.setUnlockPolicy(${P}, { kind: "unattended" });`);
  check("V4 the profile now unlocks without asking (macOS asked)", set.ok === true && ownerAsks().length === 2, set);
  const presenceBefore = presenceAsks().length;
  await runRole(ga.id, "Wednesday: pull the numbers once more.", { expectCard: false });
  check("V4 without asking, Touch ID was not asked either", presenceAsks().length === presenceBefore, presenceAsks().slice(presenceBefore));
  uses = await api.call("team.vaultUses", { spaceId: space.id });
  check("V4 that use is logged as without asking", uses[0]?.how === "unattended" && uses[0]?.outcome === "used" && received.length === 3, { how: uses[0]?.how, calls: received.length });

  /* ── V5: refusals ────────────────────────────────────────────────────────────────────────────── */
  const before = received.length;
  const vercel = await runRole(ga.id, "Please ask for the Vercel token.", { expectCard: false });
  check("V5 an ungranted key is refused", vercel.results.some((r) => r.isError && /holds no grant for VERCEL_TOKEN/.test(r.content)), vercel.results.map((r) => r.content.slice(0, 120)));
  const elsewhere = await runRole(ga.id, "Now send it elsewhere.", { expectCard: false });
  check("V5 a host the grant does not name is refused", elsewhere.results.some((r) => r.isError && new RegExp(`not 127\\.0\\.0\\.1:${OTHER_PORT}`).test(r.content)), elsewhere.results.map((r) => r.content.slice(0, 160)));
  check("V5 nothing reached any server", received.length === before, received.length);
  uses = await api.call("team.vaultUses", { spaceId: space.id });
  check("V5 both refusals are in the log", uses.filter((u) => u.outcome === "refused").length === 2, uses.slice(0, 3).map((u) => [u.outcome, u.secretName, u.where]));

  /* ── V6: the value is nowhere it should not be ───────────────────────────────────────────────── */
  const db = path.join(home, "realm.db");
  const q = (sql) => execFileSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const b64 = Buffer.from(SECRET).toString("base64");
  for (const [table, sql] of [["session_events", "SELECT payload_json FROM session_events"], ["mcp_call_log", "SELECT * FROM mcp_call_log"], ["team_activity", "SELECT detail_json || coalesce(object,'') FROM team_activity"]]) {
    let text = "";
    try { text = q(sql); } catch (e) { text = q(`SELECT * FROM ${table}`); }
    check(`V6 the key is in no row of ${table}`, text.length > 0 && !text.includes(SECRET) && !text.includes(b64), { bytes: text.length });
  }
  const dump = q(".dump");
  check("V6 nor anywhere in realm.db", !dump.includes(SECRET) && !dump.includes(b64), { bytes: dump.length });
  const logs = fs.readdirSync(path.join(home, "logs")).map((f) => fs.readFileSync(path.join(home, "logs", f), "utf8")).join("\n");
  const audit = fs.readFileSync(path.join(home, "logs/credential-audit.log"), "utf8");
  const httpLines = audit.split("\n").filter((l) => l.includes('"vault-http"')).map((l) => JSON.parse(l));
  check("V6 nor in any log, and main's audit has a used line per request the API received", !logs.includes(SECRET) && httpLines.filter((l) => l.outcome === "used").length === received.length,
    httpLines.map((l) => [l.outcome, l.host, l.roleId ? "role" : "person"]));
  check("V6 nor in secrets.json in the clear", !fs.readFileSync(path.join(home, "secrets.json"), "utf8").includes(SECRET), null);

  /* ── V7: the page, dark ──────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.button('Done'))`);
  await until(() => evalIn(c, `!__live.q('[aria-modal=true]')`), 5_000, "sheet closed");
  await until(() => evalIn(c, `__live.qa('.tv-uses tbody tr').length >= 5`), 8_000, "uses drawn");
  await shot(c, "01-vault-dark");

  /* ── V8: off in one click ────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.click(__live.named('^REVENUECAT_SECRET_KEY —'))`);
  await until(() => evalIn(c, `__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$')?.checked === true`), 5_000, "sheet again");
  await evalIn(c, `__live.click(__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$'))`);
  await until(() => evalIn(c, `__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$')?.checked === false`), 5_000, "allow off");
  check("V8 turning it off asked nothing", ownerAsks().length === 2 && !(await evalIn(c, `!!__live.button('Turn on for Growth Analyst')`)), ownerAsks().length);
  await runRole(ga.id, "Thursday: pull the numbers.", { expectCard: true });
  const log = await api.call("team.activity", { spaceId: space.id, limit: 100 });
  check("V8 the log has the grant, the allow and its end", ["granted_secret", "allowed_unattended", "asked_again"].every((v) => log.some((a) => a.verb === v)), log.map((a) => a.verb).filter((v) => /secret|unattended|asked/.test(v)));

  /* ── V7: light ───────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await until(() => evalIn(c, `!!__live.named('^More for Versed$') || !!__live.tab('Vault')`), 15_000, "sidebar in light");
  await openVault(c);
  await until(() => evalIn(c, `__live.qa('.tv-uses tbody tr').length >= 5`), 8_000, "uses in light");
  await shot(c, "01-vault-light");
  await evalIn(c, `__live.click(__live.named('^REVENUECAT_SECRET_KEY —'))`);
  await until(() => evalIn(c, `!!__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$')`), 5_000, "sheet light");
  await shot(c, "02-grant-sheet-light");
  await evalIn(c, `__live.click(__live.named('^Growth Analyst uses REVENUECAT_SECRET_KEY without asking$'))`);
  await until(() => evalIn(c, `!!__live.button('Turn on for Growth Analyst')`), 5_000, "warning light");
  await shot(c, "03-without-asking-light");
  await evalIn(c, `__live.click(__live.button('Cancel'))`);
  await sleep(300);
  check("V7 Cancel leaves it asking, and asked macOS nothing", ownerAsks().length === 2, ownerAsks().length);
  c.close();
}

main()
  .catch(async (e) => {
    console.log(`FAIL harness ${e.message}`); process.exitCode = 1;
    try { console.log("ALERTS", JSON.stringify(await evalIn(liveC, `[...document.querySelectorAll('[role=alert], .toast, [class*=toast]')].map((t) => t.textContent)`))); await shot(liveC, "zz-failed"); } catch { /* the window is gone */ }
  })
  .finally(async () => {
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    await sleep(800);
    try { electron?.kill("SIGKILL"); } catch {}
    await stopDaemons(home);
    echo?.close();
    killPort(SERVER_PORT); killPort(CDP_PORT); killPort(ECHO_PORT);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
