/**
 * Browser benchmark: what the realm-browser tools cost an agent, on fixed pages (run with:
 * pnpm build && node apps/desktop/scripts/browser-bench-live.mjs)
 *
 * Boots the BUILT app on a scratch home and calls the realm-browser tools as a session does, through
 * the session's own gateway (the same path as browser-do-live.mjs: the stub ACP agent's REVEAL hands
 * over the gateway URL and bearer, and no model is in the loop). What each tool answers is exactly what
 * a model would be handed. Nothing is billed and nothing leaves 127.0.0.1.
 *
 * The pages are fixtures/browser-bench/*.html, served by this script. Each task is the calls a careful
 * agent makes — read, act by ref, read again with `diff: true` to see what the act did — and is run
 * `--runs` times (3) on a fresh load. For each task it records:
 *   - snapshot chars, and the chars of everything the tools returned into the model
 *   - wall ms of each act, and of each snapshot (medians, then the median across runs)
 *   - tool calls, and whether the task worked, judged by the page or the fixture server, never the tools
 * and, once, the size of the realm-browser part of the gateway's tools/list.
 *
 * Tokens are estimated as ceil(chars / 4): no tokenizer is in the repo's dependencies, and the ratio
 * is the one Anthropic and OpenAI give for English text. Compare runs by chars; the tokens are a guide.
 *
 *   --out <file>   where the JSON goes (default: $TMPDIR/realm-browser-bench.json)
 *   --runs <n>     runs per task (default 3)
 *   --dump <dir>   also write what every call of the first run returned, one file a call
 *
 * When fixtures/browser-bench/baseline.json is there and --out is not it, the table shows each number
 * against the baseline's. To make a new baseline: --out apps/desktop/scripts/fixtures/browser-bench/baseline.json
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, desktopRoot, freePort, launchLiveApp, repoRoot, sleep, until } from "./lib/live-app.mjs";

const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const FIXTURES = path.join(desktopRoot, "scripts/fixtures/browser-bench");
const BASELINE = path.join(FIXTURES, "baseline.json");
const OUT = path.resolve(flag("--out", path.join(os.tmpdir(), "realm-browser-bench.json")));
const RUNS = Number(flag("--runs", 3));
const DUMP = flag("--dump", null);
const VIEWPORT = { width: 1440, height: 900 };
/** Chromium's switches for a window that is covered or in the background: lay it out and run its timers
 *  anyway, or the pane gets no bounds and every element reads as offscreen. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const TITLE = "Browser benchmark";
const PAGES = ["form", "catalog", "docs", "dialog", "spa-diff"];

const tokens = (chars) => Math.ceil(chars / 4);
const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (x) => (x === null ? null : Math.round(x));

const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

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

/* ---------------------------------- the fixture server ---------------------------------- */

/** What the pages sent back: the form's POSTs and the cart's adds. */
const seen = { forms: [], cart: [] };

const thanks = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Account created — Northwind</title></head>
<body><h1>Account created</h1><p>Check your email to finish.</p><p><a href="/form.html">Back</a></p></body></html>`;

function startSite(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/form") {
        seen.forms.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(thanks);
      }
      if (req.method === "POST" && url.pathname === "/cart") {
        seen.cart.push(Number(body));
        res.writeHead(204);
        return res.end();
      }
      const name = /^\/([a-z-]+)\.html$/.exec(url.pathname)?.[1];
      if (req.method === "GET" && PAGES.includes(name)) {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        return res.end(fs.readFileSync(path.join(FIXTURES, `${name}.html`)));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
}

/* ---------------------------------- reading answers ---------------------------------- */

const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const imageBytes = (r) => (r.content ?? []).filter((c) => c.type === "image").reduce((n, c) => n + Buffer.byteLength(c.data ?? "", "base64"), 0);
/** Each element of a snapshot: its ref, role, name, and the rest of its line. A control with no name
 *  has no quoted name, only its hints (`icon:`, `img:`, `in:`). A run of offscreen elements shares
 *  one line, `{offscreen} [ref=1] … · [ref=2] …`. */
const linesOf = (snap) => snap.split("\n").flatMap((l) => l.replace(/^\{offscreen\} /, "").split(/ · (?=\[ref=\d+\])/))
  .map((l) => /^\[ref=(\d+)\] (\S+)(?: "(.*?)")?(.*)$/.exec(l)).filter(Boolean)
  .map(([, ref, role, name, rest]) => ({ ref: Number(ref), role, name: name ?? "", rest }));
const lineFor = (snap, name, role) => linesOf(snap).find((l) => l.name.trim().toLowerCase() === name.toLowerCase() && (!role || l.role === role)) ?? null;
/** A diff's lines without its removed section: what the page still has. */
const stillListed = (snap) => snap.replace(/^removed:\n(?:\[ref=.*\n?)*/m, "");
const nextOffset = (snap) => Number(/Snapshot again with offset: (\d+)/.exec(snap)?.[1]) || null;

/* ---------------------------------- the tasks ---------------------------------- */

const FORM = [
  ["First name", "Ada"], ["Last name", "Lovelace"], ["Email", "ada@example.com"], ["Phone", "+44 20 7946 0000"],
  ["Company", "Analytical Engines"], ["Job title", "Programmer"], ["Street address", "12 St James's Square"],
  ["City", "London"], ["Postal code", "SW1Y 4JH"], ["Country", "United Kingdom"],
];
const FORM_CHECKS = ["Send me product news", "I agree to the terms"];
const FORM_NAMES = ["firstName", "lastName", "email", "phone", "company", "jobTitle", "street", "city", "postalCode", "country"];

/**
 * Each task gets a pane already on its page, and `t` — `t.snapshot(args)`, `t.act(action)`,
 * `t.do(args)` call the tool and count it, and `t.fail(why)` marks it failed. It returns its own notes;
 * whether it worked is `check`, read off the page or the server afterwards.
 */
const TASKS = [
  {
    id: "form", page: "form", title: "Fill and submit the 12-field sign-up",
    async run(t) {
      const snap = await t.snapshot();
      for (const [label, value] of FORM) {
        const line = lineFor(snap, label, "textbox");
        if (!line) return t.fail(`no field "${label}" in the snapshot`);
        await t.act({ kind: "type", ref: line.ref, text: value });
      }
      for (const label of FORM_CHECKS) {
        const line = lineFor(snap, label, "checkbox");
        if (!line) return t.fail(`no checkbox "${label}" in the snapshot`);
        await t.act({ kind: "click", ref: line.ref });
      }
      const submit = lineFor(snap, "Create account", "button");
      if (!submit) return t.fail("no Create account button");
      await t.act({ kind: "click", ref: submit.ref });
      await t.waitFor("/form");
      await t.snapshot();
    },
    check: ({ formsBefore }) => {
      const sent = seen.forms.slice(formsBefore);
      return sent.length === 1 && FORM_NAMES.every((n, i) => sent[0][n] === FORM[i][1]) && sent[0].news === "on" && sent[0].terms === "on";
    },
  },
  {
    id: "catalog", page: "catalog", title: "Add product 250 to the cart (icon-only buttons)",
    async run(t) {
      let snap = await t.snapshot();
      let pages = 1;
      while (!lineFor(snap, "Product 250")) {
        const offset = nextOffset(snap);
        if (!offset) return t.fail("product 250 is not on any page of the snapshot");
        snap = await t.snapshot({ offset });
        pages++;
      }
      // The cart button has no name, so the agent goes by where it is: the first button after the
      // product's link, as the card lays them out.
      const lines = linesOf(snap);
      const at = lines.findIndex((l) => l.name === "Product 250");
      const button = lines.slice(at + 1).find((l) => l.role === "button");
      if (!button) return t.fail("no button after product 250's link");
      await t.act({ kind: "click", ref: button.ref });
      const after = await t.snapshot({ diff: true });
      return { snapshotPages: pages, unnamedButtons: linesOf(snap).filter((l) => l.role === "button" && l.name === "").length, cartShown: !!lineFor(after, "Cart (1)") };
    },
    check: ({ cartBefore }) => { const added = seen.cart.slice(cartBefore); return added.length === 1 && added[0] === 250; },
  },
  {
    id: "docs", page: "docs", title: 'Reach "Getting started" in the docs, step by step',
    async run(t) {
      let snap = await t.snapshot();
      if (!lineFor(snap, "Getting started")) {
        const section = lineFor(snap, "Guides", "button");
        if (!section) return t.fail("no Guides section in the nav");
        await t.act({ kind: "click", ref: section.ref });
        snap = await t.snapshot({ diff: true });
      }
      const link = lineFor(snap, "Getting started");
      if (!link) return t.fail('no "Getting started" link once Guides is open');
      await t.act({ kind: "click", ref: link.ref });
      await t.snapshot({ diff: true });
    },
    check: async ({ pane }) => (await pane(`location.hash + "|" + document.getElementById("title").textContent`)) === "#getting-started|Getting started",
  },
  {
    id: "docs-walk", page: "docs", title: 'Reach "Getting started" with one browser_do',
    async run(t) {
      await t.do({ intent: "read the getting started guide", path: ["Guides", "Getting started"] });
    },
    check: async ({ pane }) => (await pane(`location.hash + "|" + document.getElementById("title").textContent`)) === "#getting-started|Getting started",
  },
  {
    id: "dialog", page: "dialog", title: "Snapshot a page under a modal",
    async run(t) {
      const snap = await t.snapshot();
      t.state.snap = snap;
      // showModal makes the page behind it inert: a line for any of these is one the agent can't act on.
      const behind = ["Northwind", "Journal", "Shop", "About", "Search", "Read the tide tables", "see the route", "Week one: the harbour", "Subscribe"];
      return { backgroundListed: behind.filter((n) => lineFor(snap, n)).length };
    },
    check: ({ state }) => ["Close", "Accept all", "Reject all", "Save choices", "Count visits"].every((n) => lineFor(state.snap ?? "", n)),
  },
  {
    id: "spa-diff", page: "spa-diff", title: "Remove a row, then re-snapshot",
    async run(t) {
      const before = await t.snapshot();
      const remove = lineFor(before, "Remove INV-1007", "button");
      if (!remove) return t.fail("no Remove INV-1007 button");
      await t.act({ kind: "click", ref: remove.ref });
      const after = await t.snapshot({ diff: true });
      t.state.after = after;
      const save = lineFor(after, "Save changes", "button");
      // A diff lists only what changed; a full snapshot marks it [new].
      const diffed = /\(changes since your previous snapshot/.test(after);
      return {
        linesBefore: linesOf(before).length,
        linesAfter: linesOf(after).length,
        markedNew: diffed ? linesOf(stillListed(after)).length : after.split("\n").filter((l) => l.endsWith(" [new]")).length,
        // Whether the second snapshot says what went away, or leaves the agent to spot the missing line.
        removalNamed: /INV-1007/.test(after),
        saveEnabledShown: !!save && !/disabled/.test(save.rest),
        // The one line whose state changed, against the lines that only moved up a row.
        saveMarkedNew: !!save && (diffed || save.rest.endsWith(" [new]")),
      };
    },
    check: async ({ state, pane }) => !lineFor(stillListed(state.after ?? ""), "Remove INV-1007") && (await pane(`!document.getElementById("save").disabled && document.querySelectorAll("#rows tr").length === 11`)),
  },
];

/* ---------------------------------- the run ---------------------------------- */

let app = null, api = null, site = null, client = null, scratchBin = null;

async function main() {
  const sitePort = await freePort();
  site = await startSite(sitePort);
  const SITE = `http://127.0.0.1:${sitePort}`;

  scratchBin = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-bench-bin-"));
  const agent = path.join(scratchBin, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);

  app = await launchLiveApp({ name: "browser-bench", inspect: true, args: UNTHROTTLED, env: { REALM_GEMINI_BIN: agent } });
  const { page } = app;
  // Sized from main, not emulated in the renderer: main sizes the pane's view from the renderer's
  // devicePixelRatio over the display's scaleFactor, so an emulated ratio of 1 on a 2× display halves it.
  await app.main.eval(`require("electron").BrowserWindow.getAllWindows().find((w) => w.isResizable()).setContentSize(${VIEWPORT.width}, ${VIEWPORT.height})`);

  // Onboarding makes the space. Its first session runs a real engine, so nothing is typed there.
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Bench");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 30_000, "composer");

  let sessionId = null;
  api = rpc(app.ports.server, await daemonToken(app.home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    void api.call("sessions.respondPermission", { id: sessionId, requestId: payload.event.payload.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // A titled session runs no titler, and REALM_ENABLE_FAKE_AGENT turns the recap off: nothing is billed.
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: TITLE, permissionMode: "bypassPermissions" });
  sessionId = session.id;
  await until(() => page.eval(`[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await page.eval(`(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the stub agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  client = new Client({ name: "browser-bench-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));

  // What the model is handed for the tools before it calls one: names, descriptions and schemas.
  const listed = (await client.listTools()).tools;
  const footprint = (tools) => {
    const json = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    return { tools: tools.length, bytes: Buffer.byteLength(json), tokens: tokens(json.length) };
  };
  const browserTools = footprint(listed.filter((t) => t.name.startsWith("realm-browser__")));
  const gatewayTools = footprint(listed);

  const callTool = async (name, args) => {
    const t0 = performance.now();
    const r = await client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 120_000 });
    return { r, ms: performance.now() - t0 };
  };
  const opened = await callTool("browser_open", { url: `${SITE}/form.html?run=0` });
  const browserId = /pane (\S+) at/.exec(text(opened.r))?.[1];
  if (!browserId) throw new Error(`browser_open did not open a pane: ${text(opened.r)}`);

  /** Evaluate in the pane's own page — the truth a task is judged by, which costs the agent nothing. */
  const paneTarget = async () => (await app.targets()).find((t) => t.type === "page" && t.url.startsWith(SITE));
  const pane = async (expr) => {
    const c = await cdp((await paneTarget()).webSocketDebuggerUrl);
    try { return await c.eval(expr); } finally { c.close(); }
  };
  const loaded = (pathname) => until(async () => {
    const t = await paneTarget();
    return t && new URL(t.url).pathname === pathname && (await pane("document.readyState")) === "complete";
  }, 30_000, `${pathname} in the pane`);


  const results = [];
  for (const task of TASKS) {
    const runs = [];
    for (let run = 1; run <= RUNS; run++) {
      // A fresh load each run, outside the count: the task starts on its page.
      await callTool("browser_navigate", { browserId, url: `${SITE}/${task.page}.html?run=${run}` });
      await loaded(`/${task.page}.html`);
      await sleep(300);
      const calls = [];
      const state = {};
      let failure = null;
      const record = async (name, args) => {
        const { r, ms } = await callTool(name, { browserId, ...args });
        const out = text(r);
        calls.push({ tool: name, kind: args.action?.kind ?? null, ms, chars: out.length, imageBytes: imageBytes(r), error: r.isError ? out.split("\n")[0] : null });
        if (DUMP && run === 1) {
          fs.mkdirSync(DUMP, { recursive: true });
          fs.writeFileSync(path.join(DUMP, `${task.id}-${String(calls.length).padStart(2, "0")}-${name}.txt`), `${JSON.stringify(args)}\n\n${out}\n`);
        }
        return out;
      };
      const t = {
        state,
        snapshot: (scope = {}) => record("browser_snapshot", scope),
        act: (action) => record("browser_act", { action, intent: `${action.kind} for the benchmark` }),
        do: (args) => record("browser_do", args),
        waitFor: (pathname) => loaded(pathname),
        fail: (why) => { failure = why; },
      };
      const ctx = { formsBefore: seen.forms.length, cartBefore: seen.cart.length, state, pane };
      let notes = null;
      try { notes = await task.run(t); } catch (e) { failure = String(e?.message ?? e); }
      const ok = !failure && !calls.some((c) => c.error) && (await Promise.resolve(task.check(ctx)).catch(() => false));
      const snaps = calls.filter((c) => c.tool === "browser_snapshot");
      const acts = calls.filter((c) => c.tool !== "browser_snapshot");
      runs.push({
        ok, failure: failure ?? calls.find((c) => c.error)?.error ?? (ok ? null : "the page did not end where the task wanted"),
        toolCalls: calls.length,
        snapshotCalls: snaps.length,
        snapshotChars: snaps.reduce((n, c) => n + c.chars, 0),
        largestSnapshotChars: Math.max(0, ...snaps.map((c) => c.chars)),
        returnedChars: calls.reduce((n, c) => n + c.chars, 0),
        imageBytes: calls.reduce((n, c) => n + c.imageBytes, 0),
        actMs: median(acts.map((c) => c.ms)),
        snapshotMs: median(snaps.map((c) => c.ms)),
        taskMs: calls.reduce((n, c) => n + c.ms, 0),
        notes,
      });
    }
    const pick = (key) => median(runs.map((r) => r[key]));
    const row = {
      id: task.id,
      title: task.title,
      success: `${runs.filter((r) => r.ok).length}/${RUNS}`,
      toolCalls: pick("toolCalls"),
      snapshotCalls: pick("snapshotCalls"),
      snapshotChars: pick("snapshotChars"),
      snapshotTokens: tokens(pick("snapshotChars")),
      largestSnapshotChars: pick("largestSnapshotChars"),
      returnedChars: pick("returnedChars"),
      returnedTokens: tokens(pick("returnedChars")),
      imageBytes: pick("imageBytes"),
      actMs: round(pick("actMs")),
      snapshotMs: round(pick("snapshotMs")),
      taskMs: round(pick("taskMs")),
      // Refs are backendNodeIds, which lengthen as one pane loads page after page: the spread is here.
      snapshotCharsByRun: runs.map((r) => r.snapshotChars),
      taskMsByRun: runs.map((r) => round(r.taskMs)),
      notes: runs[0].notes ?? null,
      failures: runs.map((r) => r.failure).filter(Boolean),
    };
    results.push(row);
    console.log(`${row.success === `${RUNS}/${RUNS}` ? "PASS" : "FAIL"} ${task.id} ${row.success}${row.failures.length ? ` ${JSON.stringify(row.failures)}` : ""}`);
  }

  // Read once the tasks are done: a pane just opened has not been laid out, and reads 0×0.
  const paneViewport = await pane(`({ width: innerWidth, height: innerHeight })`);
  const { display, paneView } = await app.main.eval(`(() => {
    const { BrowserWindow, WebContentsView, screen } = require("electron");
    const win = BrowserWindow.getAllWindows().find((w) => w.isResizable());
    const { id, label, scaleFactor } = screen.getDisplayMatching(win.getBounds());
    const view = win.contentView.children.find((v) => v instanceof WebContentsView && v.webContents.getURL().startsWith(${JSON.stringify(SITE)}));
    return { display: { id, label, scaleFactor }, paneView: view?.getBounds() ?? null };
  })()`);
  const report = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    ranAt: new Date().toISOString(),
    runs: RUNS,
    tokenEstimate: "ceil(chars / 4)",
    viewport: { window: VIEWPORT, pane: paneViewport, paneView, display },
    toolsList: { browser: browserTools, gateway: gatewayTools },
    tasks: results,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  printTable(report, OUT !== BASELINE && fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : null);
  console.log(`\nwrote ${OUT}`);
  if (results.some((r) => r.success !== `${RUNS}/${RUNS}`)) process.exitCode = 1;
}

/** The numbers as a markdown table, each beside the baseline's when there is one. */
function printTable(report, base) {
  const was = (id, key) => base?.tasks.find((t) => t.id === id)?.[key];
  const cell = (now, before) => (before === undefined || before === null || before === now ? String(now) : `${before} → ${now}`);
  const rows = [
    ["task", "ok", "calls", "snapshot chars", "snapshot tok", "returned chars", "returned tok", "act ms", "snapshot ms"],
    ...report.tasks.map((t) => [
      t.id, t.success, cell(t.toolCalls, was(t.id, "toolCalls")),
      cell(t.snapshotChars, was(t.id, "snapshotChars")), cell(t.snapshotTokens, was(t.id, "snapshotTokens")),
      cell(t.returnedChars, was(t.id, "returnedChars")), cell(t.returnedTokens, was(t.id, "returnedTokens")),
      cell(t.actMs ?? "–", was(t.id, "actMs")), cell(t.snapshotMs ?? "–", was(t.id, "snapshotMs")),
    ]),
  ];
  console.log("");
  for (const [i, r] of rows.entries()) {
    console.log(`| ${r.join(" | ")} |`);
    if (i === 0) console.log(`|${r.map(() => " --- |").join("")}`);
  }
  const { browser, gateway } = report.toolsList;
  const b = base?.toolsList.browser;
  const { display, paneView } = report.viewport;
  console.log(`\nran on ${display.label} (scaleFactor ${display.scaleFactor}); pane view ${paneView ? `${paneView.width}×${paneView.height}` : "not found"}`);
  console.log(`realm-browser tools/list: ${browser.tools} tools, ${cell(browser.bytes, b?.bytes)} bytes, ~${cell(browser.tokens, b?.tokens)} tokens (whole gateway: ${gateway.tools} tools, ${gateway.bytes} bytes)`);
}

async function teardown() {
  try { await client?.close(); } catch { /* going anyway */ }
  api?.close();
  await app?.stop();
  site?.closeAllConnections();
  await new Promise((r) => (site ? site.close(() => r()) : r()));
  if (scratchBin) fs.rmSync(scratchBin, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
