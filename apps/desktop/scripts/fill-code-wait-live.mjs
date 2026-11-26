/**
 * Live check that an agent's browser_fill_code waits for its code (run with: pnpm build && node apps/desktop/scripts/fill-code-wait-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME under ~/realm-scratch with a scripted ACP agent (nothing
 * billed), Security codes already on, and the stand-in code source (`REALM_LIVE_CODES`) — never the
 * owner's Messages or Mail. The page is a local copy of the shape of Duo's Universal Prompt passcode
 * step, its field drawn as dots so a picture shows it filled without showing the code:
 *
 *   W1  a text "arrives" 20 s after the call: the call is still waiting, then fills the field and
 *       answers "filled";
 *   W2  nothing arrives: after the wait the call fails, saying Messages and Mail were both empty and
 *       what that may mean, and the field stays empty;
 *   W3  a call cancelled 5 s in stops waiting: a code that arrives after that is never filled.
 *
 * Every card is approved by the harness. Frames of the pane go to LIVE_OUT. The codes are made up
 * for this run, and none is printed.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8803 / 9243) and LIVE_SITE_PORT (18803), refused if taken.
 */
import { randomInt } from "node:crypto";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { spawnLiveElectron } from "./lib/live-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9243);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8803);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 18803);
const scratchRoot = path.join(os.homedir(), "realm-scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "fill-code-wait-"));
const OUT_DIR = process.env.LIVE_OUT ?? path.join(scratchRoot, "fill-code-wait-out");
fs.mkdirSync(OUT_DIR, { recursive: true });
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const codesFile = path.join(scratch, "codes.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function socket(url, protocols, onEvent = () => {}) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
  });
  const send = (body) => new Promise((res) => {
    const i = ++id;
    pending.set(String(i), res);
    ws.send(JSON.stringify({ ...body, id: typeof body.method === "string" && protocols ? String(i) : i }));
  });
  return { ready, send, close: () => ws.close() };
}
const cdp = (wsUrl) => {
  const s = socket(wsUrl);
  return { ready: s.ready, close: s.close, send: (method, params) => s.send({ method, params }).then((m) => { if (m.error) throw new Error(m.error.message); return m.result; }) };
};
const rpc = (port, token, onEvent) => {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token), onEvent);
  return { ready: s.ready, close: s.close, call: (method, params) => s.send({ method, params }).then((m) => { if (!m.ok) throw new Error(`${method}: ${m.error?.message}`); return m.result; }) };
};
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** A made-up 7-digit Duo passcode for this run; kept in memory, written only to the stand-in inbox. */
const newCode = () => String(randomInt(1_000_000, 10_000_000));
const CODES = [];
function receive(code) {
  CODES.push(code);
  fs.writeFileSync(codesFile, JSON.stringify([{ source: "Messages", at: Date.now(), text: `Duo passcode: ${code}` }]));
}
const clearInbox = () => fs.writeFileSync(codesFile, "[]");

/* ── the site: the passcode step of a Duo-style prompt ──────────────────────────────────────── */

const DUO = `<!doctype html><html><head><title>Duo Security</title><style>
  body{font:15px -apple-system,system-ui;margin:0;background:#f4f5f7;color:#1f2329}
  .card{width:400px;margin:56px auto;background:#fff;border-radius:10px;padding:32px 36px;box-shadow:0 1px 3px #0002}
  .brand{font-weight:700;color:#3a8545;letter-spacing:.5px;margin-bottom:24px} h1{font-size:22px;margin:0 0 8px}
  p{color:#5a6170;margin:0 0 20px} label{display:block;font-weight:600;margin-bottom:6px}
  #passcode-input{width:100%;box-sizing:border-box;height:44px;font-size:20px;padding:0 12px;border:1px solid #b5bac4;border-radius:6px;-webkit-text-security:disc}
  button{width:100%;height:44px;margin-top:16px;border:0;border-radius:6px;background:#2d6cd8;color:#fff;font-size:16px}
  a{display:block;margin-top:18px;color:#2d6cd8;text-align:center} #count{margin-top:10px;color:#5a6170;font-size:13px}
</style></head><body><div class="card"><div class="brand">DUO</div>
  <h1>Enter code</h1><p>We sent a passcode by text message to your phone ending in 0000.</p>
  <form onsubmit="return false"><label for="passcode-input">Passcode</label>
  <input type="text" id="passcode-input" name="passcode-input" autocomplete="one-time-code" inputmode="numeric" maxlength="8">
  <div id="count">Nothing entered yet</div><button>Verify</button></form><a href="#">Other options</a></div>
<script>const i=document.querySelector('#passcode-input');i.addEventListener('input',()=>{document.querySelector('#count').textContent=i.value.length+' characters entered';});</script>
</body></html>`;
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const ok = new URL(req.url ?? "/", SITE).pathname.startsWith("/frame/v4/auth/prompt");
      res.writeHead(ok ? 200 : 404, { "content-type": "text/html" });
      res.end(ok ? DUO : "not found");
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

const WRAPPER = [
  'import { app } from "electron";',
  // A window the size of a person's, so the session and its side pane are laid out and drawn.
  'app.on("browser-window-created", (_e, w) => setTimeout(() => { if (!w.isDestroyed()) w.setBounds({ x: 80, y: 60, width: 1440, height: 900 }); }, 300));',
  'app.commandLine.appendSwitch("use-mock-keychain");',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "await import(process.env.LIVE_MAIN);",
].join("\n");

const step = (what) => console.log(`… ${what}`);
async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();
  clearInbox();
  // Security codes on, as the person's switch leaves it: main's own file in the home.
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "security-codes.json"), `${JSON.stringify({ enabled: true })}\n`);

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  electron = spawnLiveElectron([wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_GEMINI_BIN: agent, REALM_ENABLE_FAKE_AGENT: "1",
      REALM_LIVE_SCRATCH: "1", REALM_LIVE_CODES: codesFile, LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => appOutput.push(String(d))); electron.stdout.on("data", (d) => appOutput.push(String(d)));

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  step(`renderer ${renderer.url.slice(0, 40)}`);
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Codes");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  step("space made");

  const cards = [];
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title });
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: "Fill code wait live check", permissionMode: "default" });
  sessionId = session.id;
  const row = `[...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Fill code wait live check"))`;
  await until(() => evalIn(c, `!!${row}`), 20_000, "session row");
  await evalIn(c, `${row}.click(), true`);
  await sleep(800);
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  step("agent journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "fill-code-wait-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = (name, args = {}, o = {}) => client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 200_000, ...o });

  const opened = await call("browser_open", { url: `${SITE}/frame/v4/auth/prompt?sid=fixture` });
  const browserId = /pane (\S+) at/.exec(text(opened))?.[1];
  check("an agent opens a pane on the Duo-style passcode page", !!browserId, text(opened));
  const paneTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(SITE)), 20_000, "pane target");
  const pane = cdp(paneTarget.webSocketDebuggerUrl);
  await pane.ready;
  const reload = async () => {
    await evalIn(pane, "window.__left = true").catch(() => {});
    await call("browser_navigate", { browserId, url: `${SITE}/frame/v4/auth/prompt?sid=fixture&n=${Date.now()}` });
    await until(() => evalIn(pane, `!window.__left && !!document.querySelector('#passcode-input') && document.readyState === 'complete'`).catch(() => false), 15_000, "page");
    await sleep(500);
  };
  await until(() => evalIn(pane, `!!document.querySelector('#passcode-input') && document.readyState === 'complete'`), 15_000, "page");
  const refOf = async () => { const snap = text(await call("browser_snapshot", { browserId })); return Number((/\[ref=(\d+)\] textbox "Passcode"/.exec(snap) ?? /\[ref=(\d+)\] textbox/.exec(snap))?.[1]); };
  const length = () => evalIn(pane, `document.querySelector('#passcode-input').value.length`);
  const holds = (code) => evalIn(pane, `document.querySelector('#passcode-input').value === ${JSON.stringify(code)}`);
  /** The pane as the agent's browser_screenshot sees it: main's capture, the code field painted over. */
  const frame = async (tag) => {
    const shot = await call("browser_screenshot", { browserId });
    const image = (shot.content ?? []).find((x) => x.type === "image");
    const out = path.join(OUT_DIR, `${tag}.${image?.mimeType === "image/png" ? "png" : "jpg"}`);
    if (image) fs.writeFileSync(out, Buffer.from(image.data, "base64"));
    console.log(`FRAME ${tag} ${image ? out : `none: ${text(shot)}`}`);
  };
  // Brought to the front of the side pane, so main has a drawn page to capture.
  await client.callTool({ name: "realm-workspace__pane_show", arguments: { browserId } }, undefined, { timeout: 30_000 });
  await sleep(1_000);
  step("pane open");
  /* ── W1: the code arrives 20 s after the call ───────────────────────────────────────────────── */
  const code = newCode();
  const t0 = Date.now();
  const pending = call("browser_fill_code", { browserId, ref: await refOf() });
  await sleep(10_000);
  check("W1 ten seconds in, the call is still waiting and the field is empty", (await length()) === 0, { length: await length() });
  await frame("w1-01-waiting-10s");
  await sleep(10_000);
  receive(code);
  const filled = await pending;
  const took = Date.now() - t0;
  fs.writeFileSync(path.join(OUT_DIR, "w1-result.txt"), `browser_fill_code → ${filled.isError ? "error" : "ok"} after ${Math.round(took / 1000)} s: ${text(filled)}\n`);
  check("W1 the text that arrived 20 s in is filled, and the call answers \"filled\"", !filled.isError && text(filled) === "filled" && (await holds(code)) && took >= 20_000, { result: text(filled), seconds: Math.round(took / 1000) });
  check("W1 …the card was the code fill's", cards.some((k) => k.tool === "browser_fill_code"), cards.map((k) => k.tool));
  await frame("w1-02-filled");
  const after = text(await call("browser_snapshot", { browserId }));
  check("W1 the agent's snapshot afterwards does not carry the code", !after.includes(code), null);

  /* ── W2: nothing arrives ────────────────────────────────────────────────────────────────────── */
  clearInbox();
  await reload();
  const t1 = Date.now();
  const missed = await call("browser_fill_code", { browserId, ref: await refOf() });
  const waited = Date.now() - t1;
  fs.writeFileSync(path.join(OUT_DIR, "w2-result.txt"), `browser_fill_code → ${missed.isError ? "error" : "ok"} after ${Math.round(waited / 1000)} s: ${text(missed)}\n`);
  check("W2 with nothing arriving, it waits about 90 s and then fails", missed.isError && waited >= 88_000 && waited < 120_000, { seconds: Math.round(waited / 1000) });
  check("W2 …saying Messages and Mail were both empty, and what that may mean", /no security code arrived in 9\d s/.test(text(missed)) && /Text Message Forwarding/.test(text(missed)) && /Mail may not be fetching/.test(text(missed)), text(missed));
  check("W2 …and the field stays empty", (await length()) === 0, null);
  await frame("w2-timed-out");

  /* ── W3: a cancelled call stops waiting ─────────────────────────────────────────────────────── */
  await reload();
  const abort = new AbortController();
  const t2 = Date.now();
  const cancelled = call("browser_fill_code", { browserId, ref: await refOf() }, { signal: abort.signal }).then(() => "answered", (e) => `rejected: ${e?.message ?? e}`);
  await sleep(5_000);
  abort.abort();
  const outcome = await cancelled;
  check("W3 the agent's call ends as soon as it is cancelled", Date.now() - t2 < 8_000, { outcome, seconds: Math.round((Date.now() - t2) / 1000) });
  await sleep(1_000);
  const late = newCode();
  receive(late);
  await sleep(8_000);
  check("W3 …and main stopped waiting: a code that arrives after it is never filled", (await length()) === 0, { length: await length() });
  await frame("w3-cancelled");
  clearInbox();

  const logs = appOutput.join("");
  check("no code in anything the app printed", !CODES.some((k) => logs.includes(k)), null);
  pane.close();
  c.close();
}

async function teardown() {
  if (process.exitCode) console.log(`APP OUTPUT (tail) ${appOutput.join("").slice(-3000)}`);
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
