/**
 * Live check: Realm's memory reaches an ACP agent at the top of its first prompt, once per agent
 * process, and the transcript shows only what the user typed
 * (run with: pnpm build && node apps/desktop/scripts/memory-first-prompt-live.mjs).
 *
 * Boots the BUILT app on a scratch home with the fake ACP agent standing in for Gemini
 * (`REALM_GEMINI_BIN`). The agent appends every `session/prompt` it receives to a file
 * (`FAKE_ACP_PROMPT_LOG`), so the wire is read as the agent saw it. The session onboarding creates is
 * switched to that agent over RPC before anything is sent: nothing here reaches a real engine.
 *
 * Three sends: two to the first agent process, then — after `daemon.stopAgents` takes it down — one to
 * a fresh process on the same conversation. The block must be on the wire for the first and third
 * prompts only, and nowhere in the stored events or the drawn transcript.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8792 / 9232). Scratch: LIVE_SCRATCH_ROOT, else the OS temp
 * dir. Kills only what it started; the scratch home is removed, the evidence (wire capture and
 * screenshot) is copied to LIVE_EVIDENCE when that is set.
 */
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8792), CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9232);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH_ROOT ?? os.tmpdir(), "realm-memory-first-prompt-live-"));
const home = path.join(scratch, "home");
const wireLog = path.join(scratch, "wire.jsonl");
// Chromium stops laying out a window macOS says is covered; this one opens behind the user's.
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const MEMORY = "LIVE_MEMORY_7731: deploys go out from main, never from a branch.";
const TYPED = ["What should I check before deploying?", "And after?", "One more, after the restart."];
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`);
    await sleep(80);
  }
}

/** One WebSocket, request by id: `frame(id)` builds the message, `settle(msg)` reads the answer.
 *  Every call is bounded, so a socket that stops answering fails the check instead of hanging it. */
function client(url, protocols, frame, settle) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error(`could not open ${url}`))); });
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(String(msg.id))?.(msg); });
  const call = (...args) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(String(i)); rej(new Error(`no answer to ${args[0]} within 20s`)); }, 20_000);
    pending.set(String(i), (msg) => { clearTimeout(timer); pending.delete(String(i)); try { res(settle(msg, args[0])); } catch (e) { rej(e); } });
    ws.send(JSON.stringify(frame(i, ...args)));
  });
  return { ready, call, close: () => ws.close() };
}

/** Chrome DevTools: integer ids, and nothing in a frame but id, method and params. */
const cdp = (url) => {
  const c = client(url, undefined, (id, method, params) => ({ id, method, params }), (msg, method) => {
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
  });
  return { ready: c.ready, close: c.close, send: c.call };
};

/** realm-server's socket, behind its token. */
const rpc = (token) => client(`ws://127.0.0.1:${SERVER_PORT}`, tokenProtocols(token), (id, method, params) => ({ id: String(id), method, params }), (msg, method) => {
  if (!msg.ok) throw new Error(`${method}: ${msg.error?.message}`);
  return msg.result;
});

async function evalIn(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

/** Our own server and Electron, by port — and only when the process's REALM_HOME is this scratch home. */
function reapByPort() {
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      const env = execSync(`ps eww -o command= -p ${pid} || true`, { encoding: "utf8" });
      if (env.includes(scratch)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
      else console.log(`left port ${port} pid ${pid} alone: not this check's`);
    }
  }
}

async function main() {
  for (const p of [SERVER_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexport FAKE_ACP_PROMPT_LOG="${wireLog}"\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_GEMINI_BIN: agent, REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const spawnFailed = new Promise((_, reject) => electron.once("error", (e) => reject(new Error(`Electron did not start: ${e.message}`))));
  spawnFailed.catch(() => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const page = await Promise.race([spawnFailed, until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40_000, "renderer target")]);
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // First run: name a space. That makes a session on the first engine this Mac can run — which is
  // switched to the fake ACP agent below, before a word is sent to it.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false });

  const api = rpc(await daemonToken(home));
  await api.ready;
  const session = await until(async () => (await api.call("sessions.listAll", {}))[0] ?? null, 15_000, "onboarding's session");
  await api.call("sessions.setAgent", { id: session.id, agentKind: "acp:gemini" });
  check("the session runs on the fake ACP agent before anything is sent", (await api.call("sessions.get", { id: session.id })).agentKind === "acp:gemini");
  await api.call("memory.set", { spaceId: session.spaceId, doc: MEMORY });

  const replies = async () => (await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 2000 })).filter((e) => e.event.type === "assistant_text").length;
  const send = async (text) => {
    const before = await replies();
    await api.call("sessions.send", { id: session.id, text, attachments: [], mentions: [] });
    await until(async () => (await replies()) > before, 30_000, `the reply to "${text}"`);
  };
  await send(TYPED[0]);
  await send(TYPED[1]);
  const { stopped } = await api.call("daemon.stopAgents", {});
  check("the agent process is stopped between the second and third sends", stopped >= 1, { stopped });
  await send(TYPED[2]);

  // ── The wire, as the agent received it ──
  const wire = fs.readFileSync(wireLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const carries = wire.map((p) => p.filter((b) => b.type === "text" && b.text.startsWith("<realm-context>") && b.text.includes(MEMORY)).length);
  check("the block is on the wire once per agent process: prompts 1 and 3, not 2", JSON.stringify(carries) === "[1,0,1]", carries);
  check("each prompt ends with exactly what was typed, a block of its own",
    wire.every((p, i) => JSON.stringify(p.at(-1)) === JSON.stringify({ type: "text", text: TYPED[i] })), wire.map((p) => p.at(-1)));
  check("the restarted process is sent the same bytes the first one was", JSON.stringify(wire[0][0]) === JSON.stringify(wire[2][0]));
  const tools = wire[0][0].text.indexOf("This session runs in Realm");
  check("the block says what Realm's tools are for, ahead of the memory — Claude's and Codex's order", tools > 0 && tools < wire[0][0].text.indexOf(MEMORY), { tools, memory: wire[0][0].text.indexOf(MEMORY) });
  console.log(`WIRE prompt 1, block 0 (first 400 chars):\n${wire[0][0].text.slice(0, 400)}\n…`);

  // ── What Realm stored and drew ──
  const events = (await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 2000 })).map((e) => e.event);
  const stored = events.filter((e) => e.type === "user_message").map((e) => e.payload.text);
  check("the stored user messages are exactly what was typed", JSON.stringify(stored) === JSON.stringify(TYPED), stored);
  check("no stored event carries the block", !JSON.stringify(events).includes("realm-context") && !JSON.stringify(events).includes("LIVE_MEMORY_7731"));
  const drawn = await until(async () => {
    const d = await evalIn(c, `({ users: [...document.querySelectorAll('.msg-user-row .msg-user')].map((el) => el.innerText.trim()), body: document.body.innerText })`);
    return d.users.length === TYPED.length ? d : null;
  }, 15_000, "three user bubbles in the transcript");
  check("the transcript draws the three messages exactly as typed", JSON.stringify(drawn.users) === JSON.stringify(TYPED), drawn.users);
  check("the transcript shows neither the block nor the memory in it", !drawn.body.includes("realm-context") && !drawn.body.includes("LIVE_MEMORY_7731"));

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(scratch, "transcript.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  if (process.env.LIVE_EVIDENCE) {
    fs.mkdirSync(process.env.LIVE_EVIDENCE, { recursive: true });
    fs.copyFileSync(wireLog, path.join(process.env.LIVE_EVIDENCE, "wire.jsonl"));
    fs.copyFileSync(shotPath, path.join(process.env.LIVE_EVIDENCE, "transcript.png"));
    fs.writeFileSync(path.join(process.env.LIVE_EVIDENCE, "stored-user-messages.json"), JSON.stringify(stored, null, 2));
    console.log(`EVIDENCE ${process.env.LIVE_EVIDENCE}`);
  }
  api.close();
  c.close();
}

const teardown = async () => {
  await stopDaemons(home).catch(() => {});
  electron?.kill("SIGKILL");
  await sleep(500);
  reapByPort();
  fs.rmSync(scratch, { recursive: true, force: true });
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().then(() => process.exit(1)); });

// However it stalls, the run ends and cleans up after itself.
const watchdog = setTimeout(() => { console.error("ERROR the check took more than 4 minutes"); process.exitCode = 1; void teardown().then(() => process.exit(1)); }, 240_000);

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog))
  .finally(async () => { await teardown(); process.exit(process.exitCode ?? 0); });
