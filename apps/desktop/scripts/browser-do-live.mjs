/**
 * Live check for browser_do, and for Laya's shadow on a page (run with: pnpm build && node apps/desktop/scripts/browser-do-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and drives the realm-browser tools as a real session does:
 *
 *   stub ACP agent ── session/new hands it the gateway URL + bearer ──▶ this script's MCP client
 *      realm-browser provider → permission broker (answered here, over RPC) → browserHost bridge
 *         → Electron main's CDP executor → a real browser pane, on a fixture site at 127.0.0.1
 *
 * The agent is the ACP fixture the adapter suite already uses (`fake-acp-agent.mjs`), repointed with
 * REALM_GEMINI_BIN. Its REVEAL turn echoes the `session/new` it was handed, which is where a session's
 * gateway token is, so the script calls tools AS that session with no model in the loop. Nothing is
 * billed: the session has a title (so no titler runs), and REALM_ENABLE_FAKE_AGENT=1 turns the recap off.
 *
 * What it proves, on a real page in a real pane:
 *   1. One card for a walk, asked as browser_act's and shown as browser_do's.
 *   2. browser_do walks a path in one call — Docs › Getting started; Catalog › Item 142, a row far below
 *      the fold; Catalog › Item 180, a row the page only loads once it is scrolled to its end — and hands
 *      back a snapshot whose refs browser_act takes next.
 *   3. It stops rather than guesses: at a label that is not there, and at Send message on the contact
 *      form, which it never presses. The fixture counts the form's POSTs, and must count none.
 *   4. It types into the field its path ended on, and never presses Enter.
 *   5. The measurement: tool calls and tool-side time for each path, walked in one browser_do call
 *      against a scripted agent doing browser_snapshot + browser_act step by step, THINK_MS apart.
 *   6. LIVE_LAYA=1: Laya's shadow logs a row for every browser_act and every click of a walk, on the
 *      browser surface, and no tool result says a word of what Laya answered.
 *
 * Ports: LIVE_SERVER_PORT (8811), LIVE_CDP_PORT (9251), LIVE_SITE_PORT (8812). Touches only a scratch
 * dir; kills only what is listening on its own ports. Browses nothing but its own 127.0.0.1 fixture.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** Chromium's switches for a window that is covered or in the background: lay it out and run its timers
 *  anyway. Passed to Electron on its command line, as Chromium reads its switches there. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9251);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8811);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8812);
const RUNS = Number(process.env.LIVE_RUNS ?? 5);
/** The pause between a scripted agent's calls — the model's turn, which is not tool-side time. */
const THINK_MS = Number(process.env.LIVE_THINK_MS ?? 1500);
const LIVE_LAYA = process.env.LIVE_LAYA === "1";
const LIVE_LAYA_VENV = process.env.LIVE_LAYA_VENV ?? "/tmp/laya-spike/.venv";
const LIVE_LAYA_HF = process.env.LIVE_LAYA_HF ?? "/tmp/laya-spike/hf";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-do-live-"));
const home = path.join(scratch, "home");
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TITLE = "Browser walk live check";
const VIEWPORT = { width: 1500, height: 900 };
const OUT = (tag) => path.join(os.tmpdir(), `realm-browser-do-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;
let site = null;

const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

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

/* ---------------------------------- the fixture site ---------------------------------- */

/** What the site saw: every request, and every POST of the contact form — which must stay at zero. */
const seen = { requests: [], posts: 0 };

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body { font: 15px/1.5 -apple-system, sans-serif; margin: 0; color: #222; }
  nav { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd; padding: 10px 16px; display: flex; gap: 18px; }
  main { padding: 16px 24px; } li { margin: 3px 0; } label { display: block; margin: 8px 0; }
</style></head><body><nav><a href="/">Home</a><a href="/docs">Docs</a><a href="/catalog">Catalog</a><a href="/contact">Contact</a></nav><main>${body}</main></body></html>`;
const items = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<li><a href="/catalog/item-${from + i}">Item ${from + i}</a></li>`).join("");

const ROUTES = {
  "/": () => page("Fixture", `<h1>Fixture</h1><p>A small site to walk. Nothing on it leaves this Mac.</p>`),
  "/docs": () => page("Docs — Fixture", `<h1>Docs</h1><ul><li><a href="/docs/getting-started">Getting started</a></li><li><a href="/docs/configuration">Configuration</a></li><li><a href="/docs/troubleshooting">Troubleshooting</a></li></ul>`),
  "/docs/getting-started": () => page("Getting started — Fixture", `<h1>Getting started</h1><p>Install the tool, then run it once to write its settings.</p><p><a href="/docs/configuration">Next: Configuration</a></p>`),
  "/docs/configuration": () => page("Configuration — Fixture", `<h1>Configuration</h1><p>Every setting lives in one file.</p>`),
  "/docs/troubleshooting": () => page("Troubleshooting — Fixture", `<h1>Troubleshooting</h1><p>Start it again.</p>`),
  // 150 rows now, and 50 more fetched once the row after the last one scrolls into view.
  "/catalog": () => page("Catalog — Fixture", `<h1>Catalog</h1><ul id="items">${items(1, 150)}</ul><p id="more">Loading more…</p><script>
    const more = document.getElementById("more");
    let asked = false;
    new IntersectionObserver(async (entries) => {
      if (asked || !entries.some((e) => e.isIntersecting)) return;
      asked = true;
      const rows = await (await fetch("/catalog/more")).json();
      document.getElementById("items").insertAdjacentHTML("beforeend", rows.map((n) => '<li><a href="/catalog/item-' + n + '">Item ' + n + '</a></li>').join(""));
      more.textContent = "That is everything.";
    }).observe(more);
  </script>`),
  "/contact": () => page("Contact — Fixture", `<h1>Contact</h1><form method="post" action="/contact">
    <label>Name <input name="name"></label><label>Email <input name="email" type="email"></label>
    <label>Message <textarea name="message" rows="4" cols="40"></textarea></label>
    <button type="submit">Send message</button></form>`),
};

function startSite() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      seen.requests.push(`${req.method} ${req.url}`);
      const url = new URL(req.url, SITE);
      if (req.method === "POST") {
        if (url.pathname === "/contact") seen.posts++;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Sent — Fixture", "<h1>Thanks</h1>"));
        return;
      }
      if (url.pathname === "/catalog/more") {
        // A little late, as a real server is: long enough to be seen in flight.
        setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.from({ length: 50 }, (_, i) => 151 + i))); }, 150);
        return;
      }
      const item = /^\/catalog\/item-(\d+)$/.exec(url.pathname);
      const body = item ? page(`Item ${item[1]} — Fixture`, `<h1>Item ${item[1]}</h1><p>Item ${item[1]} ships in two days.</p><p><a href="/catalog">Back to the catalog</a></p>`) : ROUTES[url.pathname]?.();
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? page("Not found", "<h1>Not found</h1>"));
    });
    server.once("error", reject);
    server.listen(SITE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------------------------- reading answers ---------------------------------- */

const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
/** The URL a snapshot or a walk's answer says it is of. */
const urlOf = (t) => /Snapshot of (\S+) —/.exec(t)?.[1] ?? null;
/** The ref of the element a snapshot names `label` — what a scripted agent picks by reading the lines. */
function refFor(t, label) {
  for (const line of t.split("\n")) {
    const m = /^\[ref=(\d+)\] \S+ "(.*)"/.exec(line);
    if (m && m[2].trim().toLowerCase() === label.toLowerCase()) return Number(m[1]);
  }
  return null;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/* ---------------------------------- the run ---------------------------------- */

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  site = await startSite();

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  // Chromium stops laying out a window macOS says is covered — and a window this script starts from
  // the background opens BEHIND whatever the person at the Mac has in front. The browser pane is a
  // native view sized from that layout, so it would get no bounds: every element offscreen and every
  // click lost (measured: the walk's first click "changed nothing" until these were passed).
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_GEMINI_BIN: agent,
      REALM_ENABLE_FAKE_AGENT: "1",
      ...(LIVE_LAYA ? { REALM_LAYA_VENV: LIVE_LAYA_VENV, REALM_LAYA_HF_HOME: LIVE_LAYA_HF } : {}),
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  // Cards, answered as a user would: allow every browser card, and keep what each said.
  const cards = [];
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    const card = payload.event.payload;
    cards.push({ tool: card.toolName, title: card.title });
    void api.call("sessions.respondPermission", { id: sessionId, requestId: card.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  if (LIVE_LAYA) {
    await api.call("laya.setMode", { mode: "shadow" });
    const ready = await until(async () => {
      const st = (await api.call("laya.status", {})).runtime;
      return st.state === "ready" ? st : st.state === "failed" ? { failed: st } : null;
    }, 180_000, "Laya ready");
    check("Laya is running locally in shadow before the first step", !ready.failed, ready);
  }
  const [space] = await api.call("spaces.list", {});
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "default" });
  sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  // The session's own gateway, through the stub agent's REVEAL.
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const client = new Client({ name: "browser-do-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const results = [];
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 120_000 });
    results.push({ name, text: text(r) });
    return r;
  };
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("the session's gateway lists browser_do beside browser_act", tools.includes("realm-browser__browser_do") && tools.includes("realm-browser__browser_act"), tools.filter((t) => t.startsWith("realm-browser__")));

  // ── 1. A pane on the fixture, and one card for a walk ────────────────────────────────────
  const opened = await call("browser_open", { url: `${SITE}/` });
  const browserId = /pane (\S+) at/.exec(text(opened))?.[1];
  check("browser_open opens a pane on the fixture", !!browserId && !opened.isError, text(opened));
  const loaded = async (pathname, label) => until(async () => {
    const t = text(await client.callTool({ name: "realm-browser__browser_snapshot", arguments: { browserId } }, undefined, { timeout: 60_000 }));
    return urlOf(t) === `${SITE}${pathname}` && refFor(t, label) ? t : null;
  }, 30_000, `${pathname} loaded`);
  await loaded("/", "Docs");

  const cardsBefore = cards.length;
  const first = await call("browser_do", { browserId, intent: "read the getting-started guide", path: ["Docs", "Getting started"] });
  const walkCards = cards.slice(cardsBefore);
  check("a walk asks one card, shown as browser_do's, naming the labels and the site",
    walkCards.length === 1 && walkCards[0].tool === "browser_do" && walkCards[0].title === `Click "Docs" › "Getting started" on 127.0.0.1:${SITE_PORT}`, walkCards);
  check("…and walks Docs › Getting started in one call", !first.isError && urlOf(text(first)) === `${SITE}/docs/getting-started`, text(first).split("\n").slice(0, 2));
  note("the walk's answer, head", text(first).split("\n")[0]);
  // A ref from the walk's answer is one browser_act takes.
  const next = refFor(text(first), "Next: Configuration");
  check("the walk's answer carries a ref for what is on the page it ended on", next !== null, text(first).split("\n").filter((l) => l.startsWith("[ref=")).slice(0, 8));
  await api.call("sessions.setOptions", { id: sessionId, permissionMode: "bypassPermissions" });
  const acted = await call("browser_act", { browserId, action: { kind: "click", ref: next }, intent: "go on to configuration" });
  check("browser_act takes a ref from the walk's answer", !acted.isError, text(acted));
  await loaded("/docs/configuration", "Home");

  // ── 2. Where a walk stops ───────────────────────────────────────────────────────────────
  const goHome = async () => { await call("browser_navigate", { browserId, url: `${SITE}/` }); await loaded("/", "Docs"); };
  await goHome();
  const missing = await call("browser_do", { browserId, intent: "see the prices", path: ["Docs", "Pricing"] });
  check("a label the page does not have stops the walk, naming the likeliest by ref", missing.isError && /stopped at "Pricing"/.test(text(missing)) && /The likeliest: \[ref=\d+\]/.test(text(missing)), text(missing).split("\n")[0]);

  await goHome();
  const typed = await call("browser_do", { browserId, intent: "write to the team", path: ["Contact", "Message"], text: "Hello from a walk" });
  check("a walk types into the field its path ended on", !typed.isError && /textbox "Message" value="Hello from a walk"/.test(text(typed)), text(typed).split("\n").filter((l) => /Message/.test(l)).slice(0, 3));
  const sending = await call("browser_do", { browserId, intent: "send it", path: ["Send message"] });
  check("…and stops at Send message rather than press it, saying to take that step by ref", sending.isError && /it is a step a walk never takes/.test(text(sending)) && /take it yourself with browser_act by its ref/.test(text(sending)), text(sending).split("\n")[0]);
  check("the fixture's form was never submitted", seen.posts === 0, { posts: seen.posts });
  await shot(targets, "contact");

  // ── 3. The measurement ──────────────────────────────────────────────────────────────────
  const TASKS = [
    { name: "Docs › Getting started", path: ["Docs", "Getting started"], url: `${SITE}/docs/getting-started` },
    { name: "Catalog › Item 142 (below the fold)", path: ["Catalog", "Item 142"], url: `${SITE}/catalog/item-142` },
    { name: "Catalog › Item 180 (loaded at the end)", path: ["Catalog", "Item 180"], url: `${SITE}/catalog/item-180` },
  ];
  const walkOnce = async (task) => {
    const t = performance.now();
    const r = await call("browser_do", { browserId, intent: `open ${task.path.at(-1)}`, path: task.path });
    const ms = performance.now() - t;
    return { calls: 1, toolMs: ms, wallMs: ms, ok: !r.isError && urlOf(text(r)) === task.url, why: r.isError ? text(r).split("\n")[0] : null };
  };
  // A careful agent without browser_do: read, act by ref, read again to see what the act did — a turn
  // for each call. Scrolls by a screen when the label is not in the snapshot yet.
  const stepByStep = async (task) => {
    const started = performance.now();
    let calls = 0, toolMs = 0;
    const timedCall = async (name, args) => { calls++; const t = performance.now(); const r = await call(name, args); toolMs += performance.now() - t; await sleep(THINK_MS); return r; };
    let snap = text(await timedCall("browser_snapshot", { browserId }));
    for (const label of task.path) {
      let ref = refFor(snap, label);
      for (let scrolls = 0; ref === null && scrolls < 10; scrolls++) {
        await timedCall("browser_act", { browserId, action: { kind: "scroll", deltaY: 800 }, intent: `look further down for ${label}` });
        snap = text(await timedCall("browser_snapshot", { browserId }));
        ref = refFor(snap, label);
      }
      if (ref === null) return { calls, toolMs, wallMs: performance.now() - started, ok: false, why: `no ${label}` };
      await timedCall("browser_act", { browserId, action: { kind: "click", ref }, intent: `open ${label}` });
      snap = text(await timedCall("browser_snapshot", { browserId }));
    }
    return { calls, toolMs, wallMs: performance.now() - started, ok: urlOf(snap) === task.url, why: urlOf(snap) === task.url ? null : `ended on ${urlOf(snap)}` };
  };
  const table = [];
  for (const task of TASKS) {
    const walks = [], steps = [];
    for (let run = 0; run < RUNS; run++) {
      await goHome(); walks.push(await walkOnce(task));
      await goHome(); steps.push(await stepByStep(task));
    }
    const row = {
      task: task.name,
      walk: { calls: median(walks.map((w) => w.calls)), toolMs: Math.round(median(walks.map((w) => w.toolMs))), wallMs: Math.round(median(walks.map((w) => w.wallMs))), correct: `${walks.filter((w) => w.ok).length}/${RUNS}` },
      steps: { calls: median(steps.map((w) => w.calls)), toolMs: Math.round(median(steps.map((w) => w.toolMs))), wallMs: Math.round(median(steps.map((w) => w.wallMs))), correct: `${steps.filter((w) => w.ok).length}/${RUNS}` },
      toolMs: { walk: walks.map((w) => Math.round(w.toolMs)), steps: steps.map((w) => Math.round(w.toolMs)) },
      failures: [...walks, ...steps].filter((w) => !w.ok).map((w) => w.why),
    };
    table.push(row);
    note("MEASURE", row);
    check(`browser_do walks ${task.name} correctly every time`, walks.every((w) => w.ok), walks.map((w) => w.why).filter(Boolean));
  }
  await shot(targets, "item-180");
  check("the fixture's form was never submitted, over the whole run", seen.posts === 0, { posts: seen.posts });

  // ── 4. Laya heard it (LIVE_LAYA=1) ─────────────────────────────────────────────────────
  if (LIVE_LAYA) {
    await goHome();
    const logPath = path.join(home, "laya", "decisions.jsonl");
    const rows = await until(() => {
      const r = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      return r.filter((x) => x.surface === "browser").length >= 6 ? r : null;
    }, 60_000, "Laya's rows for the page's steps").catch(() => []);
    const web = rows.filter((x) => x.surface === "browser");
    const byTool = web.reduce((acc, x) => ({ ...acc, [x.tool]: (acc[x.tool] ?? 0) + 1 }), {});
    check("Laya logged rows for the page's steps, on the browser surface", (byTool.browser_act ?? 0) >= 1 && (byTool.browser_do ?? 0) >= 4, byTool);
    const asked = web.filter((x) => x.laya?.target);
    const agreed = asked.filter((x) => x.laya.target.choice === x.truth?.target?.id).length;
    note("Laya agreed with the agent's element", `${agreed}/${asked.length}`);
    const ms = web.flatMap((x) => [x.laya?.target?.ms, x.laya?.sensitive?.ms]).filter((v) => typeof v === "number").sort((a, b) => a - b);
    note("Laya question latency (ms, p50)", ms.length ? ms[Math.floor(ms.length / 2)] : null);
    const example = (tool) => web.find((x) => x.tool === tool && x.laya?.target);
    for (const tool of ["browser_act", "browser_do"]) {
      const r = example(tool);
      if (r) note(`ROW ${tool}`, { ...r, candidates: r.candidates.slice(0, 6), laya: { ...r.laya, target: r.laya.target && { ...r.laya.target, probabilities: Object.fromEntries(Object.entries(r.laya.target.probabilities).slice(0, 4)) } } });
    }
    check("nothing Laya said reached the agent: no tool result mentions it", !results.some((r) => /laya/i.test(r.text)), results.filter((r) => /laya/i.test(r.text)).map((r) => r.name));
  }

  await client.close();
  c.close();
  note("fixture requests", { total: seen.requests.length, posts: seen.posts, sample: seen.requests.slice(0, 6) });
}


/** A picture of the pane's own page, from its own target: a window capture never shows a native view. */
async function shot(targets, tag) {
  try {
    const pane = (await targets()).find((t) => t.type === "page" && t.url.startsWith(SITE));
    if (!pane) return;
    const p = cdp(pane.webSocketDebuggerUrl);
    await p.ready;
    const { data } = await p.send("Page.captureScreenshot", { format: "png" });
    p.close();
    fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  } catch (e) { note("screenshot failed", String(e)); }
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
