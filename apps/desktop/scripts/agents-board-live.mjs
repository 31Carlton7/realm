/**
 * Live check: the Agents page answers in place, in the built app
 * (run with: pnpm build && node apps/desktop/scripts/agents-board-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and parks real sessions in the states the board answers:
 * two scripted `fake` sessions held on the permission channel — one on a Bash permission ("ask me"),
 * one on an AskUserQuestion question ("ask a question") — and an `acp:gemini` session repointed at the
 * adapter suite's ACP stub on its HANG turn, which runs until it is cancelled. Then, in the real window:
 *
 *   1. The list shows each waiting session's request under its row — the transcript's own permission
 *      card, and the question with its options and a field for an answer — and Stop on the running one.
 *   2. Allow always, an option off the question, and Stop each reach the session (its events say so,
 *      or it settles), and none of them navigates: the Agents overlay is still up after every one.
 *   3. On the wall, a tile waiting on you takes the row for its card, a running tile carries Stop at
 *      its foot without covering its text, and Deny and Stop answer from there too.
 *
 * Ports: LIVE_SERVER_PORT (8963), LIVE_CDP_PORT (9363). Touches only a scratch dir. Nothing is billed:
 * every turn runs on the scripted agent or the ACP stub, and REALM_ENABLE_FAKE_AGENT=1 turns the
 * server's titler and recap off.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9363);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8963);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-agents-board-live-"));
const home = path.join(scratch, "home");
const OUT = (tag) => path.join(os.tmpdir(), `realm-agents-board-${tag}.png`);
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
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

async function shot(c, tag, selector) {
  const clip = selector ? await evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: Math.min(r.height + 16, 1800), scale: 2 }; })()`) : undefined;
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
}

/** In-page helpers, by the title a row or tile shows — never by position. */
const PAGE_HELPERS = `
  const rowItem = (title) => [...document.querySelectorAll('.agents-item')].find((li) => li.querySelector('.agents-row-title')?.textContent === title);
  const tileItem = (title) => [...document.querySelectorAll('.agent-tile-item')].find((d) => d.querySelector('.agent-tile-title')?.textContent === title);
  const overlayUp = () => !!document.querySelector('.page-overlay[aria-label="Agents"]');
`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  // The ACP stub the adapter suite already uses, standing in for Gemini: its HANG turn runs until cancelled.
  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_GEMINI_BIN: agent,
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  const page = (expr) => evalIn(c, `(() => { ${PAGE_HELPERS} return (${expr}); })()`);

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const start = async (agentKind, title, text) => {
    const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind, title });
    await api.call("sessions.send", { id: session.id, text, attachments: [], mentions: [] });
    return session;
  };
  const statusOf = async (id) => (await api.call("sessions.listAll", {})).find((s) => s.id === id)?.status;
  const settleTo = (id, status, tag) => until(async () => (await statusOf(id)) === status, 20_000, tag);
  const responses = async (id) => (await api.call("sessions.events", { id })).filter((e) => e.event.type === "permission_response").map((e) => e.event.payload.decision);

  const bash = await start("fake", "Clean the build folder", "ask me");
  const question = await start("fake", "Pick a base branch", "ask a question");
  const hang = await start("acp:gemini", "Long refactor", "HANG");
  await settleTo(bash.id, "waiting_permission", "bash waits");
  await settleTo(question.id, "waiting_permission", "question waits");
  await settleTo(hang.id, "running", "hang runs");

  await evalIn(c, `(() => { [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Home')).click(); return true; })()`);
  await until(() => page(`overlayUp() && !!rowItem("Clean the build folder")?.querySelector('[role=group][aria-label="Permission request"]') && !!rowItem("Pick a base branch")?.querySelector('[role=group][aria-label="Base"]')`), 15_000, "cards on the list");
  await sleep(500);

  // 1. What the list shows.
  const perm = await page(`(() => {
    const card = rowItem("Clean the build folder").querySelector('[role=group][aria-label="Permission request"]');
    return { head: card.querySelector('.permission-head').textContent, code: card.querySelector('.permission-tool code')?.textContent,
      options: [...card.querySelectorAll('.permission-option')].map((b) => b.getAttribute('aria-label')),
      group: rowItem("Clean the build folder").closest('section')?.getAttribute('aria-label') };
  })()`);
  check("a waiting session shows its request under its row, with the transcript card's own options", perm.group === "Needs you" && perm.head.startsWith("Allow Bash?") && perm.code === "rm -rf build"
    && JSON.stringify(perm.options) === JSON.stringify(["Allow", "Allow always", "Deny"]), perm);
  const ask = await page(`(() => {
    const card = rowItem("Pick a base branch").querySelector('[role=group][aria-label="Base"]');
    return { question: card.querySelector('.question-title').textContent, options: [...card.querySelectorAll('.question-option')].map((b) => b.getAttribute('aria-label')),
      allow: !!card.querySelector('[aria-label="Allow"]') };
  })()`);
  check("a waiting question shows its options and the field for an answer of your own, not Allow / Deny",
    ask.question === "Which branch should this go on?" && JSON.stringify(ask.options) === JSON.stringify(["main", "integration/v0.6", "Something else"]) && !ask.allow, ask);
  const stop = await page(`(() => {
    const li = rowItem("Long refactor"), b = li?.querySelector('.agents-stop'), when = li?.querySelector('.agents-row-when'), title = li?.querySelector('.agents-row-title');
    if (!b) return null;
    const r = b.getBoundingClientRect(), w = when.getBoundingClientRect(), t = title.getBoundingClientRect();
    return { name: b.getAttribute('aria-label'), group: li.closest('section').getAttribute('aria-label'), clearOfWhen: r.left >= w.right, clearOfTitle: r.left >= t.right, h: Math.round(r.height) };
  })()`);
  check("a running session shows Stop on its row, clear of the title and the clock", stop?.name === "Stop Long refactor" && stop.group === "Working" && stop.clearOfWhen && stop.clearOfTitle, stop);
  const geo = await page(`(() => {
    const col = document.querySelector('.agents-page .page-content');
    const items = ["Clean the build folder", "Pick a base branch"].map((t) => { const li = rowItem(t), card = li.querySelector('.agents-ask'); const a = li.getBoundingClientRect(), b = card.getBoundingClientRect(); return b.left >= a.left - 0.5 && b.right <= a.right + 0.5; });
    return { inside: items.every(Boolean), overflow: col.scrollWidth - col.clientWidth };
  })()`);
  check("the cards sit inside their rows' items, and nothing pushes the page sideways", geo.inside && geo.overflow === 0, geo);
  await shot(c, "list", ".agents-page .page-content");

  // 2. Answering, and staying.
  await page(`(() => { rowItem("Clean the build folder").querySelector('[aria-label="Allow always"]').click(); return true; })()`);
  await settleTo(bash.id, "idle", "bash answered");
  check("Allow always reaches the session as that decision", (await responses(bash.id)).includes("allow_always"), await responses(bash.id));
  check("…and the board is still on screen: answering did not open the session", await page(`overlayUp() && !document.querySelector('.agents-page .agents-item [aria-label="Allow always"]')`));
  await page(`(() => { rowItem("Pick a base branch").querySelector('.question-option[aria-label="integration/v0.6"]').click(); return true; })()`);
  await settleTo(question.id, "idle", "question answered");
  check("an option off the question answers it", (await responses(question.id)).includes("allow"), await responses(question.id));
  check("…without leaving the board", await page(`overlayUp()`));
  await page(`(() => { rowItem("Long refactor").querySelector('.agents-stop').click(); return true; })()`);
  await settleTo(hang.id, "idle", "hang stopped");
  check("Stop ends the running turn", (await statusOf(hang.id)) === "idle");
  check("…and the board stays up, with nothing left waiting or working", await page(`overlayUp() && !document.querySelector('section[aria-label="Needs you"]') && !document.querySelector('section[aria-label="Working"]')`));

  // 3. The wall.
  const deny = await start("fake", "Tidy the release notes", "ask me");
  const hang2 = await start("acp:gemini", "Port the importer", "HANG");
  await settleTo(deny.id, "waiting_permission", "deny waits");
  await settleTo(hang2.id, "running", "hang2 runs");
  await evalIn(c, `(() => { [...document.querySelectorAll('.agents-view')].find((b) => b.textContent === 'Wall').click(); return true; })()`);
  await until(() => page(`!!tileItem("Tidy the release notes")?.querySelector('[role=group][aria-label="Permission request"]') && !!tileItem("Port the importer")?.querySelector('.agents-stop')`), 15_000, "wall cards");
  await sleep(500);
  const wall = await page(`(() => {
    const waiting = tileItem("Tidy the release notes"), running = tileItem("Port the importer");
    const field = waiting.closest('.agent-wall').getBoundingClientRect(), w = waiting.getBoundingClientRect();
    const b = running.querySelector('.agents-stop').getBoundingClientRect();
    const texts = [...running.querySelectorAll('.agent-tile-sub > span, .agent-tile-title, .agent-tile-when')].map((e) => e.getBoundingClientRect());
    const sub = running.querySelector('.agent-tile-sub').getBoundingClientRect(), tile = running.querySelector('.agent-tile').getBoundingClientRect();
    return { spans: Math.abs(w.width - field.width) <= 1, waitingW: Math.round(w.width), fieldW: Math.round(field.width),
      stopInside: b.left >= tile.left && b.right <= tile.right && b.top >= tile.top && b.bottom <= tile.bottom + 0.5,
      stopClear: texts.every((r) => r.right <= b.left || r.bottom <= b.top || r.top >= b.bottom), atFoot: Math.abs(b.top + b.height / 2 - (sub.top + sub.height / 2)) <= 6 };
  })()`);
  check("on the wall a tile waiting on you takes the whole row for its card", wall.spans, wall);
  check("a running tile carries Stop at its foot, inside the tile and over none of its text", wall.stopInside && wall.stopClear && wall.atFoot, wall);
  await shot(c, "wall", ".agents-page .page-content");
  await page(`(() => { tileItem("Tidy the release notes").querySelector('[aria-label="Deny"]').click(); return true; })()`);
  await settleTo(deny.id, "idle", "deny answered");
  check("Deny on the wall reaches the session as a deny", (await responses(deny.id)).includes("deny"), await responses(deny.id));
  await page(`(() => { tileItem("Port the importer").querySelector('.agents-stop').click(); return true; })()`);
  await settleTo(hang2.id, "idle", "hang2 stopped");
  check("Stop on the wall ends that turn, and the wall is still the view on screen", await page(`overlayUp() && document.querySelector('.agents-view[aria-pressed="true"]').textContent === 'Wall'`));

  // The light face, read after a reload the way the Settings switch sets it, with one card on it.
  const light = await start("fake", "Remove the old fixtures", "ask me");
  await settleTo(light.id, "waiting_permission", "light waits");
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.app-rail .rail-btn')`).catch(() => false), 30_000, "light reload");
  await sleep(600);
  await evalIn(c, `(() => { [...document.querySelectorAll('.app-rail .rail-btn')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Home')).click(); return true; })()`);
  await until(() => page(`!!rowItem("Remove the old fixtures")?.querySelector('[role=group][aria-label="Permission request"]') || !!tileItem("Remove the old fixtures")?.querySelector('[role=group]')`), 15_000, "light card");
  await sleep(500);
  await shot(c, "light", ".agents-page .page-content");
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
