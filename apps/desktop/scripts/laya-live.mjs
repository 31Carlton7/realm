/**
 * Live check for Laya in shadow (run with: pnpm build && node apps/desktop/scripts/laya-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and proves, against the real `laya-serve`:
 *
 *   1. The service starts laya-serve through the dev seam (an existing venv and checkpoint cache —
 *      this script never installs and never downloads), bound to 127.0.0.1 and nowhere else, and
 *      reports it ready with the device it really computes on and the checkpoint it loaded.
 *   2. realm-computer acts reach the shadow and come out as rows in `<home>/laya/decisions.jsonl`,
 *      with Laya's real answers and latencies beside the ground truth. The acts are made by an agent:
 *      a scripted ACP agent (`lib/laya-live-agent.mjs`, no model) that Realm spawns for a session and
 *      that calls the tools through that session's own gateway token, one step answering a real
 *      permission card over RPC.
 *   3. Settings ▸ Engines shows the section: running, device, p50, steps logged.
 *   4. Off stops laya-serve, and killing Realm's server outright takes laya-serve with it (the
 *      watchdog), so nothing is left holding the weights.
 *
 * The app side of an act needs macOS Accessibility granted to THIS Electron. Where it is not, the
 * script says so and registers itself as the browser host in main's place, answering the two
 * accessibility ops with a scripted Mail window: the provider, the gate, the shadow and laya-serve are
 * still the built app's, and only the helper's view of the screen is scripted. It never fakes a grant.
 *
 * Needs: LAYA_VENV (a venv with laya[serve]==0.3.21, default /tmp/laya-spike/.venv) and LAYA_HF (an HF
 * cache holding convaiinnovations/laya@55cf4c4, default /tmp/laya-spike/hf). Ports: 8796 (server) and
 * 9236 (DevTools), env-overridable. Touches only a scratch dir; kills only what it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonState, daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9236), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8796);
const VENV = process.env.LAYA_VENV ?? "/tmp/laya-spike/.venv";
const HF = process.env.LAYA_HF ?? "/tmp/laya-spike/hf";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-laya-live-"));
const home = path.join(scratch, "home");
const agentDir = path.join(scratch, "agent");
fs.mkdirSync(agentDir, { recursive: true });
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

/** The server's own RPC socket; `onEvent` hears every broadcast, including browserHost ops once this
 *  client has registered as the host. */
function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  const call = (method, params) => new Promise((res, rej) => {
    const i = String(++id);
    pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else onEvent?.(msg.event, msg.payload, call);
  });
  return { ready, call, close: () => ws.close() };
}

const HELPERS = `
globalThis.__live = {
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; },
  async openSettings() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette-list"); i++) await new Promise((r) => setTimeout(r, 25));
    [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /settings/i.test(b.textContent))?.click();
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    return !!document.querySelector(".settings-page-pane");
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** laya-serve, found as the child of this run's server that is running `laya.serve`. */
function layaServe(serverPid) {
  const out = execSync(`pgrep -P ${serverPid} -f "laya.serve" || true`, { encoding: "utf8" }).trim();
  const pid = Number(out.split("\n")[0]);
  if (!pid) return null;
  const listen = execSync(`lsof -nP -a -p ${pid} -iTCP -sTCP:LISTEN -Fn || true`, { encoding: "utf8" })
    .split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
  return { pid, listen };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/* A Mail compose window, as the accessibility helper would report it — used only when this Electron
   has no Accessibility grant. Thirty-odd elements, so the candidate cut to twenty is exercised. */
const MAIL = (() => {
  const rows = [
    ["AXWindow", "New Message"], ["AXButton", "Send"], ["AXButton", "Attach"], ["AXButton", "Format"],
    ["AXButton", "Photo Browser"], ["AXButton", "Header Fields"], ["AXButton", "Close"],
    ["AXTextField", "To:", "sam@example.com"], ["AXTextField", "Cc:"], ["AXTextField", "Bcc:"],
    ["AXTextField", "Subject:", "Friday"], ["AXPopUpButton", "From:", "me@example.com"],
    ["AXTextArea", "Message body", "See you then."], ["AXButton", "Markup"], ["AXButton", "Emoji"],
    ["AXMenuBarItem", "Mail"], ["AXMenuBarItem", "File"], ["AXMenuBarItem", "Edit"], ["AXMenuBarItem", "View"],
    ["AXMenuBarItem", "Mailbox"], ["AXMenuBarItem", "Message"], ["AXMenuBarItem", "Format"], ["AXMenuBarItem", "Window"],
    ["AXMenuBarItem", "Help"], ["AXButton", "Bold"], ["AXButton", "Italic"], ["AXButton", "Underline"],
    ["AXButton", "Align Left"], ["AXButton", "Align Center"], ["AXButton", "Bulleted List"],
    ["AXButton", "Delete Draft"], ["AXButton", "Save Draft"], ["AXStaticText", ""], ["AXGroup", ""],
  ];
  const elements = rows.map(([role, name, value = ""], index) => ({ index, role, subrole: "", name, value, x: 100 + index, y: 80, w: 40, h: 20, actions: ["AXPress"], enabled: true, focused: false, depth: 3 }));
  return {
    snapshotId: "ax_mail", pid: 4242, bundleId: "com.apple.mail", appName: "Mail", frontmost: true, truncated: false, elements,
    text: elements.map((e) => `[${e.index}] ${e.role} "${e.name}" (${e.x},${e.y} ${e.w}×${e.h})`).join("\n"),
  };
})();

function reap() {
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
}
process.on("SIGINT", () => { reap(); process.exit(130); });
process.on("SIGTERM", () => { reap(); process.exit(143); });

async function main() {
  if (!fs.existsSync(path.join(VENV, "bin", "laya-serve")) || !fs.existsSync(path.join(HF, "hub", "models--convaiinnovations--laya"))) {
    throw new Error(`the dev seam needs an existing install: ${VENV} with laya-serve, and ${HF} holding the checkpoint. This script never installs or downloads.`);
  }
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const agent = path.join(repoRoot, "apps/desktop/scripts/lib/laya-live-agent.mjs");
  fs.chmodSync(agent, 0o755);
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
      // The dev seam: an install that already exists, so nothing is downloaded.
      REALM_LAYA_VENV: VENV,
      REALM_LAYA_HF_HOME: HF,
      // An ACP kind nobody here has installed, pointed at the scripted agent.
      REALM_GOOSE_BIN: agent,
      LAYA_LIVE_DIR: agentDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 90000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 60000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 60000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });

  const serverPid = daemonState(home)?.pid ?? (await daemonToken(home), daemonState(home).pid);
  let scriptedHost = false;
  const api = rpc(SERVER_PORT, await daemonToken(home), (event, payload, call) => {
    if (event === "browserHost.op" && scriptedHost) {
      const { callId, op } = payload;
      if (op === "computerSnapshot") void call("browserHost.result", { callId, ok: true, result: MAIL });
      else if (op === "computerAct") {
        const el = MAIL.elements[payload.params.action.index];
        void call("browserHost.result", { callId, ok: true, result: { ok: true, detail: `clicked "${el?.name}" in Mail` } });
      } else void call("browserHost.result", { callId, ok: false, error: "the scripted host answers accessibility ops only" });
    }
    // The first card of the run is answered the way the renderer answers one: over RPC.
    if (event === "session.event" && payload.event?.type === "permission_request") {
      console.log(`CARD ${payload.event.payload.title} -> allow_always`);
      void call("sessions.respondPermission", { id: payload.sessionId, requestId: payload.event.payload.requestId, decision: "allow_always" });
    }
  });
  await api.ready;
  // The onboarding session runs a real, billed engine: it is moved to the fake before anything else.
  const onboarding = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all[0] : null; }, 15000, "onboarding session");
  await api.call("sessions.setAgent", { id: onboarding.id, agentKind: "fake" });
  const spaceId = onboarding.spaceId;

  /* ── 1. laya-serve, started by the service, on loopback ─────────────────────────────────────── */
  const before = await api.call("laya.status", {});
  check("the dev seam counts as installed, and Laya starts off", before.installed === true && before.runtime.state === "off", before);
  const t0 = Date.now();
  await api.call("laya.setMode", { mode: "shadow" });
  const ready = await until(async () => { const s = await api.call("laya.status", {}); return s.runtime.state === "ready" ? s : null; }, 180000, "laya ready");
  console.log(`READY after ${Date.now() - t0} ms: ${JSON.stringify(ready.runtime)}`);
  check("ready on the device laya-serve reports, with the pinned checkpoint", ready.runtime.checkpoint === "english@55cf4c4", ready.runtime);
  const serve = layaServe(serverPid);
  check("laya-serve listens on 127.0.0.1 and nowhere else", serve && serve.listen.length === 1 && serve.listen[0].startsWith("127.0.0.1:"), serve);

  /* ── 2. Steps, from an agent, through the real gateway ─────────────────────────────────────── */
  const access = await evalIn(c, `window.realm.computerAccess.status()`);
  const ax = access.rows.find((r) => r.id === "accessibility");
  console.log(`ACCESSIBILITY for this Electron: ${ax?.state} (helper available: ${access.helperAvailable})`);
  if (ax?.state !== "granted") {
    console.log("NOTE Accessibility is not granted to this Electron, so the scripted host stands in for the helper (see the header).");
    scriptedHost = true;
    await api.call("browserHost.register", {});
  }
  const bundle = scriptedHost ? "com.apple.mail" : "com.apple.calculator";
  const steps = scriptedHost
    ? [
        { bundleId: bundle, label: "Subject:", intent: "add a subject line" },
        { bundleId: bundle, label: "Attach", intent: "attach a file" },
        { bundleId: bundle, label: "Bold", intent: "make the selected text bold" },
        { bundleId: bundle, label: "Send", intent: "send the email" },
        { bundleId: bundle, label: "Send", intent: "send the email" },
        { bundleId: bundle, label: "Delete Draft", intent: "throw this draft away" },
      ]
    : [
        { bundleId: bundle, label: "7", intent: "enter the digit 7" },
        { bundleId: bundle, label: "Add", intent: "add the next number" },
        { bundleId: bundle, label: "5", intent: "enter the digit 5" },
        { bundleId: bundle, label: "Equals", intent: "work out the result" },
      ];
  fs.writeFileSync(path.join(agentDir, "steps.json"), JSON.stringify(steps));
  await api.call("mcp.setProviderEnabled", { spaceId, name: "realm-computer", enabled: true });
  const session = await api.call("sessions.create", { spaceId, agentKind: "acp:goose", title: "Laya live" });
  const sid = session.session?.id ?? session.id;
  await api.call("sessions.send", { id: sid, text: "Do the steps.", attachments: [], mentions: [] });
  const agentLog = () => (fs.existsSync(path.join(agentDir, "agent.log")) ? fs.readFileSync(path.join(agentDir, "agent.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  await until(() => agentLog().some((e) => e.done || e.error), 180000, "agent steps");
  for (const e of agentLog()) console.log(`AGENT ${JSON.stringify(e)}`);
  check("every act went through", agentLog().filter((e) => e.intent).every((e) => !e.isError), agentLog());

  // The last step waits a minute for a successor before its row is written; wait it out rather than
  // quit, so the count Settings shows is the whole run.
  const logPath = path.join(home, "laya", "decisions.jsonl");
  const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  await until(() => rows().length === steps.length, 180000, "every row");
  for (const r of rows()) {
    console.log(`ROW ${JSON.stringify({ intent: r.intent, candidates: r.candidates.length, chosen: r.chosen, checkpoint: r.checkpoint,
      target: r.laya.target && { choice: r.laya.target.choice, p: r.laya.target.probabilities[r.laya.target.choice], confidence: r.laya.target.confidence, ms: r.laya.target.ms },
      sensitive: r.laya.sensitive, errors: r.laya.errors, truth: r.truth })}`);
  }
  check("one row per step, each naming the agent's element as the target's ground truth",
    rows().every((r, i) => r.truth.target?.source === "agent" && r.candidates.some((c) => c.id === r.truth.target.id) && r.intent === steps[i].intent), rows().length);
  check("Laya answered every question, with a latency", rows().every((r) => r.laya.target && r.laya.sensitive && r.laya.errors.length === 0 && r.laya.target.ms > 0));
  check("the card the user answered is the first step's user label", rows()[0].truth.permission?.source === "user", rows()[0].truth.permission);
  fs.copyFileSync(logPath, path.join(os.tmpdir(), "realm-laya-live-decisions.jsonl"));
  console.log(`LOG copied to ${path.join(os.tmpdir(), "realm-laya-live-decisions.jsonl")}`);

  /* ── 3. Settings ▸ Engines ▸ Laya ───────────────────────────────────────────────────────────── */
  await until(() => evalIn(c, `__live.openSettings()`), 20000, "settings");
  await until(() => evalIn(c, `!!document.querySelector('.laya-section')`), 20000, "laya section");
  /** The section's rows as read, and a capture of it: the heading, the three rows and the sentence. */
  const capture = async (face) => {
    const section = await evalIn(c, `(() => {
      const list = document.querySelector('.laya-section');
      const head = [...document.querySelectorAll('.settings-head')].find((h) => h.textContent === 'Laya (local decisions)');
      head.scrollIntoView({ block: 'start', behavior: 'instant' });
      const hint = list.nextElementSibling;
      const rows = [...list.querySelectorAll('.settings-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
      const top = head.getBoundingClientRect().top, bottom = hint.getBoundingClientRect().bottom;
      return { rows, ground: getComputedStyle(list.querySelector('.settings-row')).backgroundColor,
        clip: { x: Math.round(list.getBoundingClientRect().left) - 16, y: Math.round(top) - 12, width: Math.round(list.getBoundingClientRect().width) + 32, height: Math.round(bottom - top) + 24 } };
    })()`);
    await sleep(300);
    const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { ...section.clip, scale: 2 } });
    const shotPath = path.join(os.tmpdir(), `realm-laya-live-settings-${face}.png`);
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log(`SCREENSHOT ${face} ${shotPath} (row ground ${section.ground})`);
    return section;
  };
  const section = await capture("dark");
  console.log(`SETTINGS ${JSON.stringify(section.rows)}`);
  check("Settings says it is running, on which device, and the p50", /^Running/.test(section.rows[0]) && /p50 \d+ ms/.test(section.rows[0]), section.rows[0]);
  check("…and counts the steps logged", new RegExp(`${steps.length} steps logged`).test(section.rows[2]), section.rows[2]);
  // The light face is its own set of token values, not the dark one inverted (design.md): switched
  // under Settings ▸ App the way a person would, then back to Engines.
  await evalIn(c, `(async () => {
    const wait = async (sel) => { for (let i = 0; i < 80 && !document.querySelector(sel); i++) await new Promise((r) => setTimeout(r, 25)); return document.querySelector(sel); };
    document.querySelector('.page-rail input[value="app"]').click();
    (await wait('input[name="settings-theme"][value="light"]')).click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('.page-rail input[value="engines"]').click();
    return !!(await wait('.laya-section'));
  })()`);
  const light = await capture("light");
  check("the light face renders the same rows", JSON.stringify(light.rows) === JSON.stringify(section.rows) && light.ground !== section.ground, { dark: section.ground, light: light.ground });

  /* ── 4. Off stops it; a killed server takes it down ────────────────────────────────────────── */
  const first = layaServe(serverPid);
  await api.call("laya.setMode", { mode: "off" });
  await until(() => !alive(first.pid), 10000, "laya-serve gone after Off");
  check("Off stops laya-serve", !alive(first.pid), first);
  await api.call("laya.setMode", { mode: "shadow" });
  await until(async () => (await api.call("laya.status", {})).runtime.state === "ready", 180000, "ready again");
  const second = layaServe(serverPid);
  api.close();
  process.kill(serverPid, "SIGKILL");
  const t1 = Date.now();
  await until(() => !alive(second.pid), 10000, "laya-serve gone after the server was killed");
  check("killing Realm's server takes laya-serve with it", !alive(second.pid), { ms: Date.now() - t1 });
  c.close();
}

main()
  .catch((e) => { console.error("FAIL", e.stack ?? e); process.exitCode = 1; })
  .finally(() => {
    try { electron?.kill("SIGKILL"); } catch { /* gone */ }
    reap();
    // After the teardown: any laya-serve still running now outlived the server that started it.
    const stray = execSync(`pgrep -f "laya.serve import main" || true`, { encoding: "utf8" }).trim();
    console.log(stray ? `FAIL laya-serve still running after teardown: ${stray}` : "PASS no laya-serve left running");
    fs.rmSync(scratch, { recursive: true, force: true });
  });
