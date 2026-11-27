/**
 * Live check for "Let agents finish sign-ins" (run with: pnpm build && node apps/desktop/scripts/agent-signins-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME under ~/realm-scratch with the scripted fake engine
 * calling Realm's real browser tools (`kind: "call"`, nothing billed), Security codes on, the
 * stand-in code source, and the Touch ID stand-in (`REALM_LIVE_PRESENCE_LOG`) — never the owner's
 * Messages, Mail or Keychain. The session is in Full access, so the only cards are the sign-in ones.
 *
 *   OFF  fill_code raises one card, "Let agents finish sign-ins? Opens Settings", once per session,
 *        and tells the agent Realm asked; a saved password raises its fill card;
 *   ON   (turned on through Settings' own IPC) a saved password on its own site, a generated one and
 *        a security code fill with no card, each leaving a transcript line; the unlock still runs;
 *        another site's password is still carded; Settings' log lists the fills; Plan refuses.
 *
 * Every fill card is declined, so nothing is ever filled off a card. Ports: LIVE_SERVER_PORT /
 * LIVE_CDP_PORT (8804 / 9244) and LIVE_SITE_PORT (18804), refused if taken.
 */
import { randomInt } from "node:crypto";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { spawnLiveElectron } from "./lib/live-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9244);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8804);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 18804);
const scratchRoot = path.join(os.homedir(), "realm-scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "agent-signins-"));
const OUT_DIR = process.env.LIVE_OUT ?? path.join(scratchRoot, "agent-signins-out");
fs.mkdirSync(OUT_DIR, { recursive: true });
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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


const codesFile = path.join(scratch, "codes.json");
const presenceLog = path.join(scratch, "presence.log");
const CODES = [];

/* ── the site: a sign-in form and a code step ───────────────────────────────────────────────── */

const page = (title, body) => `<!doctype html><html><head><title>${title}</title><style>
  body{font:15px -apple-system,system-ui;margin:48px;color:#1f2329} input{display:block;width:260px;height:36px;margin:6px 0 14px;font-size:16px;-webkit-text-security:disc}
</style></head><body>${body}</body></html>`;
const SIGNIN = page("Sign in — Fixture", `<h1>Sign in</h1><form onsubmit="return false"><label for="user">Email</label><input id="user" name="username" autocomplete="username" style="-webkit-text-security:none">
  <label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>`);
const SIGNUP = page("Sign up — Fixture", `<h1>Create your account</h1><form onsubmit="return false"><label for="user">Email</label><input id="user" name="email" autocomplete="username" style="-webkit-text-security:none">
  <label for="pw">New password</label><input id="pw" type="password" name="new-password" autocomplete="new-password"><button>Create</button></form>`);
const VERIFY = page("Verify — Fixture", `<h1>Enter code</h1><p>We sent a passcode by text message.</p><form onsubmit="return false"><label for="passcode">Passcode</label>
  <input id="passcode" name="passcode" autocomplete="one-time-code" inputmode="numeric" maxlength="8"><button>Verify</button></form>`);
function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const body = { "/signin": SIGNIN, "/signup": SIGNUP, "/verify": VERIFY }[new URL(req.url ?? "/", SITE).pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? "not found");
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ── the scripted agent: each message names a Realm tool and ends with its arguments ─────────── */

const TOOLS = { Open: "browser_open", Go: "browser_navigate", Snap: "browser_snapshot", Code: "browser_fill_code", Fill: "browser_fill_credential", Show: "pane_show" };
const SCRIPT = Object.entries(TOOLS).map(([on, tool]) => ({
  on: `${on} {`,
  emit: [{ kind: "call", tool: tool === "pane_show" ? "realm-workspace__pane_show" : `realm-browser__${tool}`, input: {}, argsFromMessage: true }, { kind: "text", text: "Done." }],
}));

const WRAPPER = [
  'import { app } from "electron";',
  'app.on("browser-window-created", (_e, w) => setTimeout(() => { if (!w.isDestroyed()) w.setBounds({ x: 80, y: 60, width: 1440, height: 900 }); }, 300));',
  'app.commandLine.appendSwitch("use-mock-keychain");',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "await import(process.env.LIVE_MAIN);",
].join("\n");

let electron = null, api = null, site = null;
const appOutput = [];
const step = (what) => console.log(`… ${what}`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();
  fs.writeFileSync(codesFile, "[]");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "security-codes.json"), `${JSON.stringify({ enabled: true })}\n`);
  const scriptFile = path.join(scratch, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  electron = spawnLiveElectron([wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: scriptFile,
      REALM_LIVE_SCRATCH: "1", REALM_LIVE_CODES: codesFile, REALM_LIVE_PRESENCE_LOG: presenceLog,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => appOutput.push(String(d))); electron.stdout.on("data", (d) => appOutput.push(String(d)));

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Sign-ins");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  step("space made");

  /* Cards: recorded, then answered — a fill's card declined (so nothing is filled off a card), the
     invitation taken down. Never answered "allow" on a fill: what is proven is whether a card came. */
  const cards = [];
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title });
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: card.toolName === "agent_signins" ? "allow" : "deny" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const ipc = (expr) => evalIn(c, `(async () => { const v = window.realm.credentials; ${expr} })()`);
  const P = JSON.stringify(space.profileId);
  await ipc(`await v.add(${P}, { origin: ${JSON.stringify(SITE)}, username: "ada", label: "Fixture", value: "fixture-" + crypto.randomUUID() }); return true;`);
  await ipc(`await v.add(${P}, { origin: "https://other.example", username: "ada", label: "Other site", value: "fixture-" + crypto.randomUUID() }); return true;`);
  const saved = await ipc(`return (await v.list(${P})).map((r) => ({ id: r.id, origin: r.origin }));`);
  const ownId = saved.find((r) => r.origin === SITE)?.id;
  const otherId = saved.find((r) => r.origin === "https://other.example")?.id;
  check("two passwords are saved, one for the page's site and one for another", !!ownId && !!otherId, saved.map((r) => r.origin));

  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Agent sign-ins live check", permissionMode: "bypassPermissions" });
  sessionId = session.id;
  const row = `[...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Agent sign-ins live check"))`;
  await until(() => evalIn(c, `!!${row}`), 20_000, "session row");
  await evalIn(c, `${row}.click(), true`);
  await sleep(800);

  let seen = 0;
  const events = () => api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 5000 });
  /** One scripted call: the tool's answer, the cards it raised, and the transcript lines it left. */
  const agent = async (verb, args) => {
    const before = cards.length;
    const all0 = await events();
    seen = all0.length;
    await api.call("sessions.send", { id: sessionId, text: `${verb} ${JSON.stringify(args)}`, attachments: [], mentions: [] });
    const result = await until(async () => (await events()).slice(seen).find((e) => e.event.type === "tool_result")?.event.payload, 150_000, `${verb} result`);
    await until(async () => (await events()).slice(seen).some((e) => e.event.type === "status" && e.event.payload.status === "idle"), 30_000, `${verb} settles`);
    const after = (await events()).slice(seen);
    return { text: result.content, isError: result.isError, cards: cards.slice(before), notes: after.filter((e) => e.event.type === "signin_filled").map((e) => e.event.payload) };
  };

  const opened = await agent("Open", { url: `${SITE}/signin` });
  const browserId = /pane (\S+) at/.exec(opened.text)?.[1];
  check("the agent opens a pane on the sign-in page", !!browserId, opened.text);
  await agent("Show", { browserId });
  const paneTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(SITE)), 20_000, "pane target");
  const pane = cdp(paneTarget.webSocketDebuggerUrl);
  await pane.ready;
  const go = async (where) => {
    await evalIn(pane, "window.__left = true").catch(() => {});
    await agent("Go", { browserId, url: `${SITE}${where}` });
    await until(() => evalIn(pane, `!window.__left && location.pathname === ${JSON.stringify(where)} && document.readyState === 'complete'`).catch(() => false), 15_000, `page ${where}`);
    await sleep(400);
  };
  const refOf = async (pattern) => Number(pattern.exec((await agent("Snap", { browserId })).text)?.[1]);
  const valueLength = (sel) => evalIn(pane, `document.querySelector(${JSON.stringify(sel)}).value.length`);
  const ids = (list) => list.map((k) => k.tool);

  /* ── OFF ────────────────────────────────────────────────────────────────────────────────────── */
  step("agent sign-ins off");
  await go("/verify");
  const codeRef = await refOf(/\[ref=(\d+)\] textbox "Passcode"/);
  const offCode = await agent("Code", { browserId, ref: codeRef });
  check("OFF fill_code: one card, the invitation, and no fill card", JSON.stringify(ids(offCode.cards)) === JSON.stringify(["agent_signins"]) && offCode.cards[0].title === "Let agents finish sign-ins? Opens Settings", offCode.cards);
  check("OFF fill_code: the agent is told Realm asked the user, not to ask for the code", offCode.isError && offCode.text.includes("Realm asked the user to turn on agent sign-ins") && !/type the code/i.test(offCode.text), offCode.text);
  const offCode2 = await agent("Code", { browserId, ref: codeRef });
  check("OFF fill_code again: no second invitation", offCode2.cards.length === 0 && offCode2.isError, ids(offCode2.cards));

  await go("/signin");
  const pwRef = await refOf(/\[ref=(\d+)\] textbox "Password"/);
  const offOwn = await agent("Fill", { browserId, ref: pwRef, credentialId: ownId });
  check("OFF own-site password: its card, even in Full access", JSON.stringify(ids(offOwn.cards)) === JSON.stringify(["browser_fill_credential"]) && (await valueLength("#pw")) === 0, offOwn.cards);
  const offOther = await agent("Fill", { browserId, ref: pwRef, credentialId: otherId });
  check("OFF another site's password: its card", JSON.stringify(ids(offOther.cards)) === JSON.stringify(["browser_fill_credential"]), offOther.cards);

  /* ── ON: the person turns it on, from Settings' own IPC ─────────────────────────────────────── */
  const turned = await ipc(`return await v.setSignins(true);`);
  check("the person turns agent sign-ins on", turned?.enabled === true, turned);
  step("agent sign-ins on");

  const presence0 = fs.existsSync(presenceLog) ? fs.readFileSync(presenceLog, "utf8").split("\n").filter(Boolean).length : 0;
  const onOwn = await agent("Fill", { browserId, ref: pwRef, credentialId: ownId });
  const presence1 = fs.existsSync(presenceLog) ? fs.readFileSync(presenceLog, "utf8").split("\n").filter(Boolean).length : 0;
  check("ON own-site password: filled with no card", onOwn.cards.length === 0 && !onOwn.isError && (await valueLength("#pw")) > 0, { cards: onOwn.cards, text: onOwn.text });
  check("ON own-site password: the unlock policy still ran (Touch ID stand-in asked once)", presence1 === presence0 + 1, { before: presence0, after: presence1 });
  check("ON own-site password: the transcript says what was filled, and where", JSON.stringify(onOwn.notes) === JSON.stringify([{ site: SITE, kind: "password", note: `Realm filled a saved password on 127.0.0.1:${SITE_PORT}` }]), onOwn.notes);

  const onOther = await agent("Fill", { browserId, ref: pwRef, credentialId: otherId });
  check("ON another site's password: still carded", JSON.stringify(ids(onOther.cards)) === JSON.stringify(["browser_fill_credential"]) && onOther.isError, onOther.cards);

  await go("/signup");
  const newRef = await refOf(/\[ref=(\d+)\] textbox "New password"/);
  const generated = await agent("Fill", { browserId, ref: newRef, generate: { username: "ada@example.com", label: "Fixture sign-up" } });
  check("ON generate: a new password is made and filled with no card", generated.cards.length === 0 && !generated.isError && (await valueLength("#pw")) > 0, { cards: generated.cards, text: generated.text });
  check("ON generate: the transcript says Realm created it and where it is kept", generated.notes[0]?.note === `Realm created a password for 127.0.0.1:${SITE_PORT}, saved in Settings ▸ Passwords`, generated.notes);

  await go("/verify");
  const code = String(randomInt(100_000, 1_000_000));
  CODES.push(code);
  fs.writeFileSync(codesFile, JSON.stringify([{ source: "Messages", at: Date.now(), text: `Your Fixture verification code is ${code}` }]));
  const onCode = await agent("Code", { browserId, ref: await refOf(/\[ref=(\d+)\] textbox "Passcode"/) });
  check("ON fill_code: filled with no card", onCode.cards.length === 0 && onCode.text === "filled" && (await valueLength("#passcode")) === code.length, { cards: onCode.cards, text: onCode.text });
  check("ON fill_code: the transcript says a code was filled, and where", onCode.notes[0]?.note === `Realm filled a security code on 127.0.0.1:${SITE_PORT}`, onCode.notes);
  fs.writeFileSync(codesFile, "[]");

  /* ── the log Settings reads, and nothing it should not hold ─────────────────────────────────── */
  const status = await ipc(`return await v.signinsStatus();`);
  check("Settings' log lists the three agent fills, newest first, by site, kind and session", JSON.stringify(status.fills.map((f) => [f.kind, f.site, f.sessionId])) === JSON.stringify([["code", SITE, sessionId], ["generated", SITE, sessionId], ["password", SITE, sessionId]]), status.fills);
  const homeFile = fs.readFileSync(path.join(home, "agent-signins.json"), "utf8");
  check("main's file holds no value and no code", !homeFile.includes("fixture-") && !CODES.some((k) => homeFile.includes(k)), null);
  const transcript = JSON.stringify(await events());
  check("the transcript holds no code", !CODES.some((k) => transcript.includes(k)), null);
  check("no code in anything the app printed", !CODES.some((k) => appOutput.join("").includes(k)), null);

  // The chat as the person sees it: the cards that came and went, and the three fill lines.
  await evalIn(c, `document.querySelector('[data-signin-filled]')?.scrollIntoView({ block: 'center' }), true`);
  await sleep(600);
  const picture = await Promise.race([c.send("Page.captureScreenshot", { format: "png" }), sleep(15_000).then(() => null)]);
  if (picture) {
    fs.writeFileSync(path.join(OUT_DIR, "transcript.png"), Buffer.from(picture.data, "base64"));
    console.log(`FRAME transcript ${path.join(OUT_DIR, "transcript.png")}`);
  }
  check("the chat draws a line for each agent fill", (await evalIn(c, `document.querySelectorAll('[data-signin-filled]').length`)) === 3, null);

  /* ── a read-only mode still refuses, switch or no switch ────────────────────────────────────── */
  await api.call("sessions.setOptions", { id: sessionId, permissionMode: "plan" });
  const planned = await agent("Code", { browserId, ref: await refOf(/\[ref=(\d+)\] textbox "Passcode"/) });
  check("Plan mode: fill_code refused, with no card", planned.isError && /read-only/.test(planned.text) && planned.cards.length === 0, planned.text);
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
