/**
 * Live check: the phone's Needs you is the desktop's (Plan 28, Phase 2's first pass mark)
 * (run with: pnpm build && node apps/desktop/scripts/needs-you-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and pairs Phase 1's TypeScript test phone through a
 * local relay against the real server half, as devices-live.mjs does. Then it drives sessions into
 * every state Needs you decides on:
 *
 *   - waiting on a question, on a permission, and on a plan's approval (one of them in a second profile);
 *   - a sub-agent waiting while its lead is a row, and one whose lead was put away;
 *   - the quick chat waiting;
 *   - failed and never opened, failed and read, failed after it was last read, failed and put away;
 *   - running, and idle.
 *
 * It reads the desktop's Needs you from the real window's DOM and the phone's from `home.get`, prints
 * both, and holds them to the same members in the same order — and both to the list the rule must
 * make of those states, so the two cannot agree by both being empty or both being wrong.
 *
 * Every session runs the scripted agent. Each is made with `agentKind: "fake"`; the quick chat is made
 * after `ui.lastAgentKind` is set to the fake agent, and is checked before anything is sent to it; the
 * onboarding session, which takes a real engine, is never sent a word. No engine is billed.
 *
 * Ports are env-overridable (LIVE_CDP_PORT, LIVE_SERVER_PORT, LIVE_RELAY_PORT). A screenshot of the
 * window goes to apps/desktop/.verify/needs-you-live (or LIVE_OUT). Touches only its scratch
 * directory, and stops only the processes it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9433);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8991);
const RELAY_PORT = Number(process.env.LIVE_RELAY_PORT ?? 8992);
const shots = process.env.LIVE_OUT ?? path.join(repoRoot, "apps/desktop/.verify/needs-you-live");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-needs-you-live-"));
const home = path.join(scratch, "home");
let electron = null;
let rig = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (v) => JSON.stringify(v);

/** The scripted agent's turns, ahead of its built-in script (`REALM_FAKE_SCRIPT`). */
const ask = (question) => ({ kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered",
  input: { questions: [{ question, header: "Pick", multiSelect: false, options: [{ label: "This one" }, { label: "That one" }] }] } });
const lead = (title) => [
  { kind: "call", tool: "realm-agent__agent_start", input: { title, goal: "NY child waits on a permission", constraints: { agentKind: "fake" } } },
  { kind: "text", text: "Started a sub-agent." },
];
const SCRIPT = [
  { on: "NY asks a question", emit: [ask("Which database?")] },
  { on: "NY runs a command", emit: [{ kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm test" }, result: "ok" }] },
  { on: "NY proposes a plan", emit: [
    { kind: "plan", planId: "ny-plan", steps: [{ text: "Add the column", status: "pending" }, { text: "Backfill it", status: "pending" }] },
    { kind: "tool", name: "ExitPlanMode", needsPermission: true, input: { plan: "## Theme column\n\nAdd it, then backfill it." }, result: "Approved" },
  ] },
  { on: "NY leads a listed agent", emit: lead("NY child of a listed lead") },
  { on: "NY leads an agent to put away", emit: lead("NY child of a put-away lead") },
  { on: "NY child waits on a permission", emit: [{ kind: "tool", name: "Bash", needsPermission: true, input: { command: "make deploy" }, result: "deployed" }] },
  { on: "NY quick chat asks", emit: [ask("Which colour?")] },
  { on: "NY fails", emit: [{ kind: "fail", message: "NY: the build broke" }] },
  { on: "NY works", emit: [{ kind: "text", paceMs: 1_500, text: Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ") }] },
  { on: "NY idles", emit: [{ kind: "text", text: "Nothing to do." }] },
];

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
    const v = await fn().catch(() => null);
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

/** realm-server's RPC, as the renderer dials it, with its broadcasts. */
function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) for (const l of [...listeners]) l(msg.event, msg.payload);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.code} ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    /** The first `event` whose payload `pick` accepts. */
    next: (event, pick = () => true, ms = 30_000) => new Promise((res, rej) => {
      const timer = setTimeout(() => { listeners.delete(l); rej(new Error(`timeout:${event}`)); }, ms);
      const l = (e, p) => { if (e === event && pick(p)) { clearTimeout(timer); listeners.delete(l); res(p); } };
      listeners.add(l);
    }),
    close: () => ws.close(),
  };
}

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const results = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/* ── The phone: Phase 1's TestPhone and local relay, under tsx, driven over stdin ─────────────── */
async function startRig() {
  const file = path.join(scratch, "phone-rig.mts");
  fs.writeFileSync(file, `import { createInterface } from "node:readline";
import { startLocalRelay } from ${js(path.join(repoRoot, "services/relay/src/node.ts"))};
import { TestPhone } from ${js(path.join(repoRoot, "apps/server/src/remote/test-phone.ts"))};
const relay = await startLocalRelay({ port: Number(process.env.RELAY_PORT) });
console.log("relay " + relay.url);
const phone = new TestPhone();
const handle = async (cmd: string, args: string[]) => {
  if (cmd === "pair") {
    const r = await phone.pair(args[0]!, { name: "Needs-you iPhone", model: "iPhone18,1", timeoutMs: 60_000 });
    console.log(r.ok ? "paired ok" : "paired no " + r.reason);
  }
  if (cmd === "connect") console.log("connected " + (await phone.connect()).mac);
  if (cmd === "home") console.log("home " + JSON.stringify(await phone.call("home.get")));
};
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, ...args] = line.split("\\t");
  handle(cmd!, args).catch((e) => console.log("error " + cmd + " " + (e as Error).message));
}
`);
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  const child = spawn(tsx, [file], { cwd: path.join(repoRoot, "apps/server"), env: { ...process.env, RELAY_PORT: String(RELAY_PORT) }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const waiters = new Set();
  createInterface({ input: child.stdout }).on("line", (line) => { lines.push(line); for (const w of [...waiters]) w(); });
  child.stderr.on("data", (d) => process.stderr.write(`    [rig] ${d}`));
  const next = (pattern, ms, tag) => new Promise((resolve, reject) => {
    const scan = () => { const i = lines.findIndex((l) => pattern.test(l)); if (i < 0) return false; waiters.delete(scan); clearTimeout(timer); resolve(lines.splice(i, 1)[0]); return true; };
    const timer = setTimeout(() => { waiters.delete(scan); reject(new Error(`timeout:${tag}`)); }, ms);
    if (!scan()) waiters.add(scan);
  });
  const url = (await next(/^relay /, 30_000, "local relay")).slice("relay ".length);
  return { child, url, next, send: (...parts) => child.stdin.write(`${parts.join("\t")}\n`) };
}

async function holdKey(c) {
  // Opened behind the person's own window it is never key, and greys its accent: hold it key.
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute("data-window-inactive");
    new MutationObserver(() => root.hasAttribute("data-window-inactive") && root.removeAttribute("data-window-inactive")).observe(root, { attributes: true }); return true; })()`);
}

/** The desktop's Needs you, as its rows say it: title, where, and the state its mark reads. */
const desktopRows = (c) => evalIn(c, `[...document.querySelectorAll('section.sb-needs .item-row')].map((b) => ({
  title: b.querySelector('.item-title')?.textContent ?? '', where: b.querySelector('.item-where')?.textContent ?? '',
  status: b.querySelector('.status-dot')?.getAttribute('data-status') ?? '' }))`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, RELAY_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  if (!fs.existsSync(path.join(repoRoot, "apps/desktop/out/main/index.js")) || !fs.existsSync(path.join(repoRoot, "apps/server/dist/main.js"))) throw new Error("build first: pnpm build");
  // A server from before Needs you was shared reads the quick chat's setting nowhere.
  check("the build is this tree's: its server reads the quick chat's setting", fs.readFileSync(path.join(repoRoot, "apps/server/dist/main.js"), "utf8").includes("ui.quickChat"));
  fs.mkdirSync(shots, { recursive: true });
  const script = path.join(scratch, "fake-script.json");
  fs.writeFileSync(script, JSON.stringify(SCRIPT));

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: script,
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // The quick chat takes the last agent picked: the scripted one, before the window has read it.
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer after reload");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1320, height: 900, deviceScaleFactor: 2, mobile: false });
  await holdKey(c);

  // ── The phone, paired through Settings' own calls and a local relay ──
  rig = await startRig();
  await api.call("settings.set", { key: "remote.relay", value: rig.url });
  const asked = api.next("remote.pairRequest");
  const { url } = await api.call("remote.pair.start", {});
  rig.send("pair", url);
  await api.call("remote.pair.answer", { requestId: (await asked).requestId, accept: true });
  check("the test phone pairs with the Mac's own server", (await rig.next(/^paired /, 60_000, "paired")) === "paired ok");
  rig.send("connect");
  await rig.next(/^connected /, 30_000, "connected");

  // ── The spaces: the window's own, a second in its profile, and one in another profile ──
  const profiles = await api.call("profiles.list", {});
  const own = (await api.call("spaces.list", {})).find((sp) => sp.profileId === profiles[0].id);
  const errands = await api.call("spaces.create", { profileId: own.profileId, name: "Errands" });
  const school = await api.call("profiles.create", { name: "School" });
  const lectures = await api.call("spaces.create", { profileId: school.id, name: "Lectures" });

  /** Until the session's last message has taken its turn to `status`: the last status its log holds
   *  after its last message, and its row agreeing. A new session is idle before its turn has begun. */
  const reach = (id, status, tag) => until(async () => {
    const log = await api.call("sessions.events", { id, afterSeq: 0, limit: 2_000, types: ["user_message", "status"] });
    const sent = log.findLastIndex((e) => e.event.type === "user_message");
    const after = sent < 0 ? null : log.slice(sent + 1).filter((e) => e.event.type === "status").at(-1);
    return after?.event.payload.status === status && (await api.call("sessions.get", { id })).status === status;
  }, 30_000, `${tag} ${status}`);
  /** A scripted session, sent `text`, once its turn stands at `status`. */
  async function drive(title, spaceId, text, status) {
    const { session, itemId } = await api.call("sessions.create", { spaceId, agentKind: "fake", permissionMode: "default", title });
    if (session.agentKind !== "fake") throw new Error(`${title} is not on the scripted agent`);
    await api.call("sessions.send", { id: session.id, text });
    await reach(session.id, status, title);
    return { id: session.id, itemId, title };
  }
  /** The sub-agent a lead started, once it waits. */
  async function childOf(leadId, tag) {
    const child = await until(async () => (await api.call("sessions.listAll", { profileId: null })).find((s) => s.dispatchedBy?.sessionId === leadId), 30_000, tag);
    if (child.agentKind !== "fake") throw new Error(`${tag} is not on the scripted agent`);
    await reach(child.id, "waiting_permission", tag);
    return child;
  }
  const settle = () => sleep(600);
  const markRead = async (id) => api.call("sessions.markSeen", { id, seq: (await api.call("sessions.get", { id })).lastEventSeq });

  const question = await drive("NY waits on a question", own.id, "NY asks a question", "waiting_permission"); await settle();
  const permission = await drive("NY waits on a permission", errands.id, "NY runs a command", "waiting_permission"); await settle();
  const listedLead = await drive("NY listed lead", own.id, "NY leads a listed agent", "idle");
  const listedChild = await childOf(listedLead.id, "the listed lead's sub-agent"); await settle();
  const plan = await drive("NY waits on a plan", lectures.id, "NY proposes a plan", "waiting_permission"); await settle();
  const putAwayLead = await drive("NY put-away lead", own.id, "NY leads an agent to put away", "idle");
  const putAwayChild = await childOf(putAwayLead.id, "the put-away lead's sub-agent");
  await api.call("items.update", { id: putAwayLead.itemId, archived: true }); await settle();

  // The quick chat, opened as a person opens it (⌘⇧N, which needs no field focused), or from the
  // palette; on the scripted agent before a word is sent.
  await evalIn(c, `(() => { document.activeElement?.blur?.();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "N", code: "KeyN", metaKey: true, shiftKey: true, bubbles: true })); return true; })()`);
  if (!(await until(() => evalIn(c, `!!document.querySelector('.quick-chat')`), 4_000, "quick chat").catch(() => false))) {
    await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5_000, "the palette");
    await evalIn(c, `(() => { const input = document.querySelector(".palette input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Quick chat");
      input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === "Quick chat");
      if (!hit) return null; hit.click(); return true; })()`), 5_000, "Quick chat in the palette");
  }
  const quickId = await until(async () => (await api.call("settings.get", { key: "ui.quickChat" })).value?.sessionId, 15_000, "the quick chat");
  const quick = await api.call("sessions.get", { id: quickId });
  check("the quick chat runs the scripted agent", quick.agentKind === "fake", quick.agentKind);
  if (quick.agentKind !== "fake") throw new Error("refusing to send to a quick chat on a real engine");
  await api.call("sessions.send", { id: quickId, text: "NY quick chat asks" });
  await reach(quickId, "waiting_permission", "the quick chat"); await settle();

  const neverOpened = await drive("NY failed, never opened", errands.id, "NY fails", "error"); await settle();
  const read = await drive("NY failed, read", own.id, "NY fails", "error");
  await markRead(read.id); await settle();
  const readBefore = await drive("NY failed after it was read", lectures.id, "NY idles", "idle");
  await markRead(readBefore.id);
  await api.call("sessions.send", { id: readBefore.id, text: "NY fails" });
  await reach(readBefore.id, "error", "NY failed after it was read"); await settle();
  const archived = await drive("NY failed, put away", errands.id, "NY fails", "error");
  await api.call("items.update", { id: archived.itemId, archived: true });
  const running = await drive("NY running", own.id, "NY works", "running");
  const idle = await drive("NY idle", errands.id, "NY idles", "idle");
  check("every session stands where it was driven", true, {
    waiting: [question, permission, plan, listedChild, putAwayChild].length, failed: 4, running: running.title, idle: idle.title, quickChat: quickId });

  // ── What the rule must make of those states ──
  // Titles as they stand now: a session with no title of its own takes one from its first message.
  const titleOf = async (id) => (await api.call("items.listAll", {})).find((i) => i.refId === id)?.title ?? (await api.call("sessions.get", { id })).title;
  const expected = [question.title, permission.title, plan.title, await titleOf(putAwayChild.id), neverOpened.title, readBefore.title];
  const leftIds = [listedChild.id, quickId, read.id, archived.id, running.id, idle.id, listedLead.id, putAwayLead.id];
  const left = await Promise.all(leftIds.map(titleOf));
  const leftSaid = left.map((t, i) => (leftIds[i] === quickId ? `the quick chat ("${t}")` : t));

  // ── The desktop's list, read off the window once it has stopped moving ──
  let stable = 0, last = "";
  const desktop = await until(async () => {
    const rows = await desktopRows(c);
    const now = JSON.stringify(rows);
    stable = now === last ? stable + 1 : 0;
    last = now;
    return stable >= 8 && rows.length > 0 ? rows : null;
  }, 30_000, "the desktop's Needs you settling");
  const { data } = await c.send("Page.captureScreenshot", {});
  fs.writeFileSync(path.join(shots, "needs-you.png"), Buffer.from(data, "base64"));

  // ── The phone's list ──
  rig.send("home");
  const phoneHome = JSON.parse((await rig.next(/^home /, 30_000, "home.get")).slice("home ".length));
  const phone = phoneHome.needsYou.map((r) => ({ id: r.id, title: r.title, space: r.spaceName, status: r.status, needsYou: r.needsYou }));

  const lefts = desktop.map((r, i) => `${i + 1}. ${r.title} (${r.where}) — ${r.status}`);
  const width = Math.max(...lefts.map((l) => l.length), "desktop: Needs you in the window".length) + 3;
  console.log(`\n  ${"desktop: Needs you in the window".padEnd(width)}phone: home.get needsYou`);
  for (let i = 0; i < Math.max(desktop.length, phone.length); i++) {
    const p = phone[i] ? `${i + 1}. ${phone[i].title} (${phone[i].space}) — ${phone[i].status}` : "";
    console.log(`  ${(lefts[i] ?? "").padEnd(width)}${p}`);
  }
  console.log(`  left out on both: ${leftSaid.join(", ")}\n`);

  const mobileStatus = { waiting_permission: "waiting", error: "error" };
  check("the phone's Needs you has the desktop's members, in the desktop's order", js(phone.map((r) => r.title)) === js(desktop.map((r) => r.title)),
    { desktop: desktop.map((r) => r.title), phone: phone.map((r) => r.title) });
  check("each row is in the same space and the same state on both", desktop.every((d, i) => phone[i] && d.where.split(" · ")[0] === phone[i].space && mobileStatus[d.status] === phone[i].status));
  check("and that is what the rule makes of the states driven: the waiting by how long each has waited, then the failures nobody has read",
    js(desktop.map((r) => r.title)) === js(expected), { expected });
  check("left out on both: the quick chat, a sub-agent under a listed lead, a read failure, a failure put away, the running and the idle",
    left.every((t) => !desktop.some((r) => r.title === t)) && leftIds.every((id) => !phone.some((r) => r.id === id)));
  check("every row the phone lists says it needs you", phone.every((r) => r.needsYou === true));

  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    rig?.child.kill("SIGKILL");
    electron?.kill("SIGKILL");
    await stopDaemons(home);
    // Anything still listening on the three ports is this run's, started under its scratch home.
    try { execFileSync("bash", ["-c", `lsof -nP -tiTCP:${SERVER_PORT},${CDP_PORT},${RELAY_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]); } catch { /* nothing left */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { rig?.child.kill("SIGKILL"); electron?.kill("SIGKILL"); process.exit(1); });
