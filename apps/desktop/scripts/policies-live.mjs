/**
 * Live check for a team's policies, dynamic Teams PR 4a (run with: pnpm build && node apps/desktop/scripts/policies-live.mjs)
 *
 * Boots the REAL app (built out/main + dist/main.js) on a scratch home with the scripted agent standing
 * in for every engine, so nothing is billed, the stub stdio MCP server serving its four risk tools, and
 * stand-ins for macOS's owner check and the Keychain stamp (scratch files, never the login Keychain):
 *
 *   L1  a role's run calls save_thing: one card, naming the team's policy; "allow" holds for the run;
 *   L2  it calls send_thing twice: a card each time, and "Allow always" licenses nothing;
 *   L3  the person's own Full-access session: "ask" does not bind it (save runs), "approve, then press"
 *       does (save is not run), and "never" on the connector does (send is refused) — each logged;
 *   L4  a loosening over RPC, holding the token but no press, is refused;
 *   L5  the Policies page: send_quietly "without asking" opens the warning sheet; a limit past the
 *       code's ceiling is refused on the sheet; 3 a day is confirmed by macOS (the stand-in) and sealed;
 *       the role's next send_quietly runs with no card;
 *   L6  the row edited in sqlite3 reads as the floor: "Not confirmed on this Mac", and the role asks again;
 *   L7  the page and the sheet in dark and light.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8826 / 9266), refused if taken and reaped by port.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9266);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8826);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-policies-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-policies-live-"));
const home = path.join(scratch, "home");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

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


const SCRIPT = [
  { on: "save twice", emit: [
    { kind: "call", tool: "stub__save_thing", input: { n: 1 } },
    { kind: "call", tool: "stub__save_thing", input: { n: 2 } },
    { kind: "text", text: "Saved twice." },
  ] },
  { on: "send twice", emit: [
    { kind: "call", tool: "stub__send_thing", input: { n: 1 } },
    { kind: "call", tool: "stub__send_thing", input: { n: 2 } },
    { kind: "text", text: "Sent twice." },
  ] },
  { on: "send quietly", emit: [
    { kind: "call", tool: "stub__send_quietly", input: { to: "nathan" } },
    { kind: "text", text: "Sent quietly." },
  ] },
  { on: "save it", emit: [
    { kind: "call", tool: "stub__save_thing", input: { n: 3 } },
    { kind: "text", text: "Saved." },
  ] },
  { on: "send it", emit: [
    { kind: "call", tool: "stub__send_thing", input: { n: 3 } },
    { kind: "text", text: "Sent." },
  ] },
];

const ownerLog = path.join(scratch, "owner-asks.log");
const ownerAsks = () => (fs.existsSync(ownerLog) ? fs.readFileSync(ownerLog, "utf8").trim().split("\n").filter(Boolean) : []);
const presenceLog = path.join(scratch, "presence-asks.log");

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const scriptFile = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  // The app's path is this scratch dir (the wrapper's), so `device-owner.ts` finds the stand-in: the
  // person typing their login password, answering yes and leaving a line saying it was asked.
  fs.mkdirSync(path.join(scratch, "native/bin"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "native/bin/deviceowner"), `#!/bin/bash\n[ "$1" = "can" ] && { echo yes; exit 0; }\necho "$2" >> ${JSON.stringify(ownerLog)}\nexit 0\n`, { mode: 0o755 });
  // And `policy-stamp.ts` finds this one: the unlock policy's stamp, kept in a scratch file rather than
  // the login Keychain. Without a stamp no looser policy can be set, so V4's "without asking" needs it.
  const stamps = path.join(scratch, "policy-stamps");
  fs.writeFileSync(path.join(scratch, "native/bin/policystamp"), `#!/bin/bash
f=${JSON.stringify(stamps)}/$(printf %s "$2|$3" | shasum | cut -c1-40)
mkdir -p ${JSON.stringify(stamps)}
if [ "$1" = "read" ]; then [ -f "$f" ] || exit 3; cat "$f"; exit 0; fi
if [ "$1" = "bump" ]; then n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo $n > "$f"; echo $n; exit 0; fi
exit 2
`, { mode: 0o755 });
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

async function openPolicies(c) {
  if (!(await evalIn(c, `!!__live.tab('Policies')`))) {
    await evalIn(c, `__live.click(__live.named('^More for Versed$'))`);
    const row = `[...document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] button')].find((b) => b.textContent.trim() === 'Team')`;
    await until(() => evalIn(c, `!!${row}`), 5_000, "menu row Team");
    await evalIn(c, `__live.click(${row})`);
    await until(() => evalIn(c, `!!__live.tab('Policies')`), 8_000, "team column");
  }
  await evalIn(c, `__live.click(__live.tab('Policies'))`);
  await until(() => evalIn(c, `__live.text('.page-head h1') === 'Policies' && __live.qa('.tv-name').some((n) => n.textContent === 'stub')`), 20_000, "policies page");
}

const unfoldStub = (c) => evalIn(c, `(() => { const b = __live.qa('.tp-row-button').find((x) => x.querySelector('.tv-name')?.textContent === 'stub');
  if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);
const toTop = (c) => evalIn(c, `(() => { document.querySelector('.page-head').scrollIntoView({ block: 'start' }); return true; })()`);
const toStub = (c) => evalIn(c, `(() => { __live.qa('.tv-name').find((n) => n.textContent === 'stub').closest('li').scrollIntoView({ block: 'start' }); return true; })()`);


/** Drive one session to idle on `message`, answering each card with `answer` (one per card, in order),
 *  and return its cards and tool results from this turn. */
async function drive(sessionId, start, answers = []) {
  const queue = [...answers];
  const cards = [];
  const evs = await until(async () => {
    const all = (await api.call("sessions.events", { id: sessionId, afterSeq: start, limit: 2000 }));
    for (const e of all.filter((x) => x.event.type === "permission_request")) {
      if (cards.some((c) => c.requestId === e.event.payload.requestId)) continue;
      cards.push(e.event.payload);
      await api.call("sessions.respondPermission", { id: sessionId, requestId: e.event.payload.requestId, decision: queue.shift() ?? "deny" });
    }
    // Idle once it has run: a session reports idle before its first turn starts, too.
    const ran = all.find((x) => x.event.type === "status" && x.event.payload.status === "running")?.seq ?? Infinity;
    const done = all.some((x) => x.event.type === "status" && x.event.payload.status === "idle" && x.seq > ran);
    return done ? all : null;
  }, 40_000, `session ${sessionId}`);
  return { cards, results: evs.filter((x) => x.event.type === "tool_result").map((x) => x.event.payload) };
}
const lastSeq = async (sessionId) => ((await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 5000 })).at(-1)?.seq ?? 0);
const resultText = (r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));

/** Run the role on `message` and drive its run's session. */
async function runRole(roleId, message, answers) {
  const run = await api.call("team.roleRun", { id: roleId, message });
  const sessionId = await until(async () => (await api.call("team.roleRuns", { id: roleId, limit: 10 })).find((r) => r.id === run.id)?.sessionId, 20_000, "run session");
  return drive(sessionId, 0, answers);
}
/** The person's own session says `message`. */
async function own(sessionId, message) {
  const start = await lastSeq(sessionId);
  await api.call("sessions.send", { id: sessionId, text: message });
  return drive(sessionId, start);
}
const sql = (q) => execFileSync("sqlite3", [path.join(home, "realm.db"), q], { encoding: "utf8" }).trim();

const pickOn = (rowExpr) => `(() => { const li = ${rowExpr}; const b = li.querySelector('button[aria-haspopup=menu]'); b.click(); return true; })()`;
const menuPick = (label) => `(() => { const m = document.querySelector('[role=menu]:not([data-closing])'); const it = [...m.querySelectorAll('[role^=menuitem]')].find((b) => b.querySelector('.menu-label')?.textContent === ${JSON.stringify(label)}); it.click(); return true; })()`;
const quietRow = `__live.qa('.tpol-tool').find((li) => li.querySelector('.settings-row-name').textContent === 'send quietly')`;
const setInput = (v) => `(() => { const i = document.querySelector('.sheet input[type=number]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const sheetState = `(() => { const s = document.querySelector('.sheet'); if (!s) return null; const b = s.querySelector('.btn.primary');
  return { title: s.querySelector('.sheet-head h3').textContent, body: s.querySelector('.sheet-body p').textContent, button: b.textContent, disabled: b.disabled,
    alert: s.querySelector('.sheet-body [role=alert]')?.textContent ?? null, noAgent: !!s.querySelector('.sheet-body > [data-no-agent]') && !!s.querySelector('.sheet-foot > [data-no-agent]') }; })()`;

let liveC = null;
async function main() {
  const c = await boot();
  liveC = c;
  const space = (await api.call("spaces.list", {})).find((s) => s.name === "Versed");
  await api.call("team.make", { spaceId: space.id, templates: [], roles: [] });
  const role = await api.call("team.roleCreate", { spaceId: space.id, name: "Growth Analyst", brief: "Report Mondays.", realmite: { seed: "ga" }, agentKind: "fake", model: "sonnet", cron: null, permissionMode: "acceptEdits" });
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  const stub = await api.call("mcp.add", { spaceId: space.id, name: "stub", transport: "stdio", command: tsx,
    args: [path.join(repoRoot, "apps/server/src/mcp/fixtures/stub-stdio.ts")], env: { PATH: process.env.PATH ?? "", STUB_TOOLS: "risk" } });
  const conn = `mcp:${stub.id}`;
  const activity = async (verb) => (await api.call("team.activity", { spaceId: space.id, limit: 200 })).filter((a) => a.verb === verb);

  /* ── L1: a change elsewhere that can be undone asks once, naming the policy ─────────────────────── */
  const l1 = await runRole(role.id, "save twice", ["allow"]);
  check("L1 one card for two saves, naming Versed's policy", l1.cards.length === 1 && /^Versed's policy asks before stub changes something elsewhere/.test(l1.cards[0].title), l1.cards.map((x) => x.title));
  check("L1 both saves ran", l1.results.length === 2 && l1.results.every((r) => !r.isError), l1.results.map(resultText));

  /* ── L2: something that can't be taken back asks every time, and "always" licenses nothing ──────── */
  const l2 = await runRole(role.id, "send twice", ["allow_always", "deny"]);
  check("L2 a card for each send, each time", l2.cards.length === 2 && l2.cards.every((x) => /asks each time before stub does something that can't be taken back/.test(x.title)), l2.cards.map((x) => x.title));
  check("L2 the first ran, the denied second did not", !l2.results[0]?.isError && l2.results[1]?.isError === true && /Not run/.test(resultText(l2.results[1])), l2.results.map(resultText));

  /* ── L3: which of the person's own sessions a rule binds ─────────────────────────────────────────── */
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", permissionMode: "bypassPermissions" });
  const a = await own(session.id, "save it");
  check("L3 \"ask\" does not bind the person's Full-access session: the save ran with no card", a.cards.length === 0 && a.results.length === 1 && !a.results[0].isError, a.results.map(resultText));
  await api.call("team.policySet", { spaceId: space.id, scope: "tool", scopeKey: `${conn}#save_thing`, decision: "ticket", caps: {}, checks: [] });
  const t = await own(session.id, "save it");
  check("L3 \"approve, then press\" binds it: the save is not run", t.results[0]?.isError === true && /Not run: Versed's policy has the person approve/.test(resultText(t.results[0])), t.results.map(resultText));
  await api.call("team.policySet", { spaceId: space.id, scope: "connector", scopeKey: conn, decision: "block", caps: {}, checks: [] });
  const b = await own(session.id, "send it");
  check("L3 \"never\" binds it: the send is refused", b.results[0]?.isError === true && /Refused: Versed's policy never lets stub: send thing run/.test(resultText(b.results[0])), b.results.map(resultText));
  check("L3 each is a line in the team's activity", (await activity("policy_ticket")).length >= 1 && (await activity("policy_blocked")).length >= 1, null);

  /* ── L4: a loosening over RPC with the token, but no press ──────────────────────────────────────── */
  let l4 = null;
  try { await api.call("team.policySet", { spaceId: space.id, scope: "connector", scopeKey: conn, decision: "ask", caps: {}, checks: [] }); } catch (e) { l4 = e.message; }
  check("L4 a loosening with no press is refused", /team.policySet: /.test(l4 ?? "") && sql(`SELECT decision FROM team_policies WHERE scope_key = '${conn}'`) === "block", l4);
  // Back to the floor for the stub, through the page's own write (a press), so L5 has a clean connector.
  sql(`DELETE FROM team_policies WHERE scope_key IN ('${conn}', '${conn}#save_thing')`);

  /* ── L5: the sheet, the ceiling, macOS, the seal ────────────────────────────────────────────────── */
  await openPolicies(c);
  await toTop(c);
  await shot(c, "01-policies-dark");
  await unfoldStub(c);
  await toStub(c);
  await evalIn(c, pickOn(quietRow));
  await evalIn(c, menuPick("Without asking"));
  await until(() => evalIn(c, `!!document.querySelector('.sheet')`), 5_000, "sheet");
  const prefill = await evalIn(c, sheetState);
  check("L5 the sheet warns, prefilled at the ceiling, out of an agent's reach", /can't be taken back/.test(prefill.body) && prefill.button === "Allow, up to 20 a day" && prefill.noAgent, prefill);
  await evalIn(c, setInput("21"));
  const over = await evalIn(c, sheetState);
  check("L5 a limit past the ceiling is refused on the sheet", over.disabled && /more than 20 times a day/.test(over.alert ?? ""), over);
  await shot(c, "02-sheet-over-ceiling-dark");
  await evalIn(c, setInput("3"));
  await shot(c, "03-sheet-dark");
  const asksBefore = ownerAsks().length;
  await evalIn(c, `__live.click(__live.button('Allow, up to 3 a day'))`);
  await until(() => evalIn(c, `!document.querySelector('.sheet')`), 10_000, "sheet closes");
  check("L5 macOS was asked once (the stand-in)", ownerAsks().length === asksBefore + 1, ownerAsks().slice(asksBefore));
  const row = (await api.call("team.policies", { spaceId: space.id })).rows.find((r) => r.scope === "tool" && r.scopeKey === `${conn}#send_quietly`);
  check("L5 the row is sealed, 3 a day", row?.decision === "auto" && row.sealed === true && row.caps.perDay === 3, row);
  const q = await runRole(role.id, "send quietly", []);
  check("L5 the role's send_quietly runs with no card", q.cards.length === 0 && q.results.length === 1 && !q.results[0].isError, { cards: q.cards.map((x) => x.title), results: q.results.map(resultText) });
  check("L5 and leaves a line for it", (await activity("policy_auto")).length === 1, null);

  /* ── L6: edited behind Realm's back ─────────────────────────────────────────────────────────────── */
  sql(`UPDATE team_policies SET caps_json = '{"perDay":20,"gapMs":60000}' WHERE scope_key = '${conn}#send_quietly'`);
  const tool = (await api.call("team.policies", { spaceId: space.id })).connectors.find((x) => x.connector === conn).tools.find((x) => x.tool === "send_quietly");
  check("L6 the edited row reads as the floor, not confirmed", tool.decision === "ask" && tool.unconfirmed === true, tool);
  const again = await runRole(role.id, "send quietly", ["deny"]);
  check("L6 the role asks again", again.cards.length === 1, again.cards.map((x) => x.title));
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.app-rail')`).catch(() => false), 30_000, "reload");
  await holdKey(c);
  await openPolicies(c);
  await unfoldStub(c);
  await toStub(c);
  check("L6 the page says so", await evalIn(c, `${quietRow}.textContent.includes('Not confirmed on this Mac')`), null);
  await shot(c, "04-stub-unconfirmed-dark");

  /* ── L7: light ──────────────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail')`).catch(() => false), 30_000, "light reload");
  await holdKey(c);
  await until(() => evalIn(c, `!!__live.named('^More for Versed$') || !!__live.tab('Policies')`), 15_000, "sidebar in light");
  await openPolicies(c);
  await toTop(c);
  await shot(c, "05-policies-light");
  await unfoldStub(c);
  await toStub(c);
  await shot(c, "06-stub-unconfirmed-light");
  await evalIn(c, pickOn(quietRow));
  await evalIn(c, menuPick("Without asking"));
  await until(() => evalIn(c, `!!document.querySelector('.sheet')`), 5_000, "sheet in light");
  await shot(c, "07-sheet-light");
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
    killPort(SERVER_PORT); killPort(CDP_PORT);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
