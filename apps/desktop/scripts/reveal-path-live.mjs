/**
 * Live check for Reveal in Finder on a path an agent wrote (run with: pnpm build && node apps/desktop/scripts/reveal-path-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the scripted `fake` agent, whose turn echoes the
 * message back — so a message naming three paths comes back as an assistant reply with three
 * clickable paths in it. Each is clicked and revealed through the transcript's own menu, and main's
 * `shell.showItemInFolder` is replaced over main's inspector with a recorder, so the check reads what
 * the Finder would have been asked to select and no Finder window opens.
 *
 *   1. `~/Desktop/` reveals this account's Desktop — the `~/…` form, which used to do nothing.
 *   2. `notes/today.md` reveals the file under the session's working directory.
 *   3. A path that is not there reveals nothing, and the window says so.
 *
 * Ports: LIVE_SERVER_PORT (8831), LIVE_CDP_PORT (9271), LIVE_MAIN_INSPECT_PORT (9272). Touches only a
 * scratch dir and reads (never writes) ~/Desktop's existence. Nothing is billed: the agent is `fake`.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9271);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8831);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9272);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-reveal-live-"));
const home = path.join(scratch, "home");
const TITLE = "Reveal live check";
const MISSING = "~/realm-reveal-live-nothing-here/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
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
    await sleep(200);
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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
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

  // Main's `shell.showItemInFolder`, swapped for a recorder: what the Finder would have been asked.
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl); await m.ready;
  const inMain = async (expression) => {
    const r = await m.send("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await inMain(`(() => { const { shell } = require("electron"); globalThis.__revealed = []; shell.showItemInFolder = (p) => { globalThis.__revealed.push(p); }; return true; })()`);
  const revealed = () => inMain("globalThis.__revealed");

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home), () => {});
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  // A file the agent "wrote", under the session's working directory, named relative to it.
  fs.mkdirSync(path.join(session.cwd, "notes"), { recursive: true });
  fs.writeFileSync(path.join(session.cwd, "notes", "today.md"), "# today");
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  await api.call("sessions.send", { id: session.id, text: `Files are in \`~/Desktop/\`, the notes are \`notes/today.md\`, and \`${MISSING}\` is gone.`, attachments: [], mentions: [] });
  const marks = await until(async () => {
    const ps = await evalIn(c, `[...document.querySelectorAll('.md-path')].map((e) => e.getAttribute('data-path'))`);
    return ps.length >= 3 ? ps : null;
  }, 20_000, "three paths in the reply");
  note("paths marked in the reply", marks);

  const reveal = async (p) => {
    await evalIn(c, `(() => { [...document.querySelectorAll('.md-path')].find((e) => e.getAttribute('data-path') === ${JSON.stringify(p)}).click(); return true; })()`);
    await until(() => evalIn(c, `[...document.querySelectorAll('[role=menuitem]')].some((b) => b.textContent === 'Reveal in Finder')`), 5_000, `menu for ${p}`);
    await evalIn(c, `(() => { [...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent === 'Reveal in Finder').click(); return true; })()`);
    await sleep(600);
  };

  await reveal("~/Desktop/");
  check("~/Desktop/ reveals this account's Desktop", (await revealed()).at(-1) === path.join(os.homedir(), "Desktop"), await revealed());
  await reveal("notes/today.md");
  check("a relative path reveals the file under the session's working directory", (await revealed()).at(-1) === path.join(session.cwd, "notes", "today.md"), await revealed());
  const before = (await revealed()).length;
  await reveal(MISSING);
  check("a path that is not there reveals nothing", (await revealed()).length === before, await revealed());
  const said = await until(() => evalIn(c, `document.body.innerText.includes(${JSON.stringify(`Nothing is at ${MISSING}.`)})`), 5_000, "the error").catch(() => false);
  check("…and the window says so", said === true);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
