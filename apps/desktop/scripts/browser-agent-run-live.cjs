/**
 * Live check for Plan 11 W5 — browser-agent sessions, driven end to end by a REAL parent Claude
 * session through the REAL stack:
 *
 *   parent claude ── MCP gateway ──▶ realm-agent__browser_agent_run
 *      └─ creates a CHILD claude session (visible, restricted to realm-browser, default perms)
 *           └─ child claude ── MCP gateway ──▶ realm-browser__browser_* → CDP → WebContentsView
 *
 * Proves:
 *   1. The parent's browser_agent_run creates a real child session in the same space; the child
 *      session's permissionMode is "default" even though the PARENT runs bypassPermissions
 *      (the safety line: bypass is never inherited).
 *   2. The child opens the test page and actually clicks it (server-side counter), with its
 *      permission_requests surfacing on the CHILD session (the user answers there).
 *   3. The parent receives the child's final report through the tool result (fenced, attributed,
 *      naming the child session).
 *   4. Interrupt path: a second run is cancelled by interrupting the PARENT — the child stops and
 *      the tool result reports the cancellation.
 *
 * Run:  pnpm --filter @realm/server build && \
 *       apps/desktop/node_modules/.bin/electron apps/desktop/scripts/browser-agent-run-live.cjs
 *
 * Hygiene: scratch REALM_HOME + userData under mkdtemp (removed at exit); test page on 127.0.0.1:8799
 * (refuses to start if the port is taken); spawns ONE realm-server child and kills exactly that pid;
 * touches no real ~/Realm and no agent CLI config. Requires claude installed + logged in.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-agent-run-live-"));
const PAGE_PORT = 8799;
const OVERALL_TIMEOUT_MS = 600_000;
const PASSWORD_VALUE = "s3cret-pw-canary";

let failures = 0;
const results = [];
const ok = (label, cond, detail = "") => {
  results.push(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const log = (line) => console.log(`[live] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- compile the real main-process sources (TS) to CJS with the workspace's own esbuild ----
function esbuild() {
  const pnpm = path.join(repoRoot, "node_modules/.pnpm");
  for (const d of fs.readdirSync(pnpm)) {
    if (!d.startsWith("esbuild@")) continue;
    try { return require(path.join(pnpm, d, "node_modules/esbuild")); } catch { /* next */ }
  }
  throw new Error("esbuild not found in node_modules/.pnpm");
}
const entry = path.join(scratch, "entry.ts");
fs.writeFileSync(entry, `
  export { createBrowserPane, blockBrowserDownloads } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/browser-pane.ts"))};
  export { BrowserAgentHost } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/browser-agent-host.ts"))};
  export { startBrowserAgentBridge } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/browser-agent-bridge.ts"))};
`);
const bundled = path.join(scratch, "agent.cjs");
esbuild().buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: bundled });

const { app, BrowserWindow, screen } = require("electron");
const { createBrowserPane, blockBrowserDownloads, BrowserAgentHost, startBrowserAgentBridge } = require(bundled);
app.setPath("userData", path.join(scratch, "userData"));
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// ---- the test page: a button that phones home, plus the W3 password canary ----
let clicks = 0;
function startTestPage() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/clicked") { clicks += 1; res.writeHead(204); res.end(); return; }
      if (req.url === "/state") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ clicks })); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>W5 live page</title><body style="font:14px sans-serif;padding:2rem">
        <h1>Realm W5 live check page</h1>
        <p id="count">clicks: 0</p>
        <button id="inc" onclick="fetch('/clicked',{method:'POST'}).then(()=>{document.getElementById('count').textContent='clicks: '+(++window.__n)})">Increment counter</button>
        <script>window.__n=0<\/script>
        <form><label>Secret <input type="password" name="pw" value="${PASSWORD_VALUE}"></label></form>
      </body>`);
    });
    server.once("error", (e) => reject(new Error(`test page port ${PAGE_PORT} unavailable: ${e.message} — is something already on it?`)));
    server.listen(PAGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- realm-server child (the REAL dist build) ----
function startRealmServer() {
  const dist = path.join(repoRoot, "apps/server/dist/main.js");
  if (!fs.existsSync(dist)) throw new Error("apps/server/dist/main.js missing — run: pnpm --filter @realm/server build");
  const child = spawn("node", [dist], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("realm-server did not report ready in 20s")), 20_000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "ready") { clearTimeout(timer); resolve(msg); }
          if (msg.type === "error") { clearTimeout(timer); reject(new Error(msg.message)); }
        } catch { /* partial line */ }
      }
    });
    child.once("exit", (code) => reject(new Error(`realm-server exited early (${code})`)));
  });
  return { child, ready };
}

// ---- a minimal RPC client over the server's WS ----
function connectRpc(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const eventHandlers = [];
    let n = 0;
    ws.addEventListener("open", () => resolve({
      call: (method, params) => new Promise((res, rej) => {
        const id = String(++n);
        const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 30_000);
        pending.set(id, (m) => { clearTimeout(timer); m.ok ? res(m.result) : rej(new Error(`${m.error.code}: ${m.error.message}`)); });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      onEvent: (cb) => eventHandlers.push(cb),
      close: () => ws.close(),
    }));
    ws.addEventListener("error", () => reject(new Error("could not connect to realm-server ws")));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) pending.get(m.id)?.(m), pending.delete(m.id);
      else for (const cb of eventHandlers) cb(m.event, m.payload);
    });
  });
}

async function main() {
  const pageServer = await startTestPage();
  const { child: serverChild, ready } = startRealmServer();
  const info = await ready;
  log(`realm-server up on :${info.port}, home ${info.home}`);

  const win = new BrowserWindow({ width: 1000, height: 700, x: 40, y: 40, title: "Realm W5 live check (auto-closes)", backgroundColor: "#17181a" });
  await win.loadURL("data:text/html," + encodeURIComponent("<body style='background:#17181a;color:#eee;font:13px sans-serif;padding:8px'>W5 live check — the browser view mounts below when the CHILD agent opens it</body>"));
  const pane = createBrowserPane(win);
  const host = new BrowserAgentHost({
    attach: (id) => pane.attachCdp(id),
    hasView: (id) => pane.hasView(id),
    navigate: (id, url) => pane.host.navigate(id, url),
    pageState: (id) => pane.pageState(id),
  });
  pane.onViewDestroyed((id) => host.release(id));
  blockBrowserDownloads(() => {});
  const bridge = startBrowserAgentBridge({ port: info.port, handleOp: (op, params) => host.handleOp(op, params), onLog: (l) => log(l) });

  const rpc = await connectRpc(info.port);

  // Play the renderer for BOTH sessions: mount agent-opened browser views; auto-allow every
  // permission_request on any session in the space (parent runs bypass so in practice these are the
  // CHILD's — asserted below); record session.agentOpened and mcp.call rows.
  const permissionLog = [];   // { sessionId, requestId, toolName, title }
  const childOpens = [];      // { sessionId, itemId }
  const agentCalls = [];      // mcp.call rows for realm-agent
  rpc.onEvent((event, payload) => {
    if (event === "browser.agentOpened") {
      log(`child agent opened browser ${payload.browserId} — mounting the view`);
      rpc.call("browsers.get", { browserId: payload.browserId }).then((row) => {
        pane.host.create(payload.browserId, row.url, null);
        const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
        pane.host.setBounds(payload.browserId, { x: 20, y: 60, width: 940, height: 600 }, scale, true);
      }).catch((e) => log(`mount failed: ${e.message}`));
    }
    if (event === "session.agentOpened") {
      log(`browser-agent session opened: ${payload.sessionId}`);
      childOpens.push({ sessionId: payload.sessionId, itemId: payload.itemId });
    }
    if (event === "mcp.call" && payload.serverName === "realm-agent") {
      agentCalls.push(payload);
      log(`realm-agent call logged: ok=${payload.ok} — ${payload.resultSummary?.slice(0, 90)}`);
    }
    if (event === "session.event" && payload.event.type === "permission_request") {
      const { requestId, toolName, title } = payload.event.payload;
      permissionLog.push({ sessionId: payload.sessionId, requestId, toolName, title });
      log(`permission_request on ${payload.sessionId.slice(-6)} [${toolName}] "${title}" → allow`);
      rpc.call("sessions.respondPermission", { id: payload.sessionId, requestId, decision: "allow" }).catch((e) => log(`respond failed: ${e.message}`));
    }
  });

  const profile = await rpc.call("profiles.create", { name: "W5 live" });
  const space = await rpc.call("spaces.create", { profileId: profile.id, name: "Live" });
  // The parent runs BYPASS on purpose: the safety-line assertion is that the child does not.
  const { session: parent } = await rpc.call("sessions.create", { spaceId: space.id, agentKind: "claude", permissionMode: "bypassPermissions", projectId: null });
  log(`parent claude session ${parent.id} (bypassPermissions) in space ${space.id}`);

  // ---- Phase 1: the delegated run, end to end ----
  await rpc.call("sessions.send", {
    id: parent.id,
    text: [
      "You have Realm's realm-agent MCP tool (realm-agent__browser_agent_run). Call it EXACTLY ONCE with:",
      `goal: "Open http://127.0.0.1:${PAGE_PORT}/ with browser_open, take a browser_snapshot, then browser_act-click the button whose snapshot line contains 'Increment counter'. Re-snapshot to verify the count changed, then report which [ref=N] you clicked."`,
      `constraints: { "allowedOrigins": ["http://127.0.0.1:${PAGE_PORT}"], "maxActs": 8 }`,
      "Wait for its result, then reply with exactly: PARENT DONE",
      "Do not use any other tools. Do not browse yourself.",
    ].join("\n"),
  });

  const phase1Deadline = Date.now() + 420_000;
  while (Date.now() < phase1Deadline) {
    if (agentCalls.length >= 1) break;
    await sleep(1000);
  }
  // Give the parent's closing message a moment.
  let parentEvents = [];
  const settleDeadline = Date.now() + 60_000;
  for (;;) {
    parentEvents = await rpc.call("sessions.events", { id: parent.id, afterSeq: 0, limit: 2000 });
    const done = parentEvents.some((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("PARENT DONE"));
    if (done || Date.now() >= settleDeadline) break;
    await sleep(1000);
  }

  const childId = childOpens[0]?.sessionId ?? null;
  const child = childId ? await rpc.call("sessions.get", { id: childId }).catch(() => null) : null;
  const childEvents = childId ? await rpc.call("sessions.events", { id: childId, afterSeq: 0, limit: 2000 }) : [];
  const parentToolResults = parentEvents.filter((e) => e.event.type === "tool_result").map((e) => e.event.payload.content).join("\n");
  const childText = JSON.stringify(childEvents);

  ok("session.agentOpened announced a child session", childId !== null, childId ?? "none");
  ok("the child is a real session in the caller's space", child !== null && child.spaceId === space.id, child ? child.spaceId : "-");
  ok("SAFETY LINE: bypass parent → child permissionMode is default", child !== null && child.permissionMode === "default", child ? child.permissionMode : "-");
  ok("the child's session is titled as a browser agent", child !== null && /browser agent/i.test(child.title), child ? child.title : "-");
  ok("the page's button was actually clicked by the CHILD (server-side counter)", clicks >= 1, `clicks=${clicks}`);
  ok("the child's permission_requests surfaced on the CHILD session", permissionLog.some((p) => p.sessionId === childId), JSON.stringify(permissionLog.map((p) => [p.sessionId.slice(-6), p.toolName])));
  ok("no permission_request surfaced on the bypass parent", !permissionLog.some((p) => p.sessionId === parent.id), "");
  ok("the parent received the child's report through the tool result (finished + fenced + attributed)",
    parentToolResults.includes("Browser agent finished") && /agent-output-[0-9a-f]{16}/.test(parentToolResults) && parentToolResults.includes(childId ?? " "), "");
  ok("the parent finished its turn (PARENT DONE)", parentEvents.some((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("PARENT DONE")), "");
  ok("the child's transcript shows realm-browser tool activity", childText.includes("browser_snapshot") || childText.includes("browser_act"), "");
  ok("the password value appears in NO persisted event (parent or child)", !JSON.stringify(parentEvents).includes(PASSWORD_VALUE) && !childText.includes(PASSWORD_VALUE), "");
  ok("browser_agent_run was logged in Activity under realm-agent", agentCalls.some((c) => c.tool === "browser_agent_run"), "");

  // ---- Phase 2: parent interrupt cancels the delegated run ----
  log("phase 2: interrupt path");
  const callsBefore = agentCalls.length;
  await rpc.call("sessions.send", {
    id: parent.id,
    text: [
      "Call realm-agent__browser_agent_run once more with:",
      `goal: "Open http://127.0.0.1:${PAGE_PORT}/ and click the 'Increment counter' button 40 times, ONE browser_act per click, taking a fresh browser_snapshot between every pair of clicks. Then report the final count."`,
      `constraints: { "allowedOrigins": ["http://127.0.0.1:${PAGE_PORT}"], "maxActs": 100 }`,
      "Then reply with exactly: PARENT DONE 2",
    ].join("\n"),
  });
  // Wait for the SECOND child to appear and start running, then interrupt the PARENT.
  const p2Deadline = Date.now() + 180_000;
  while (childOpens.length < 2 && Date.now() < p2Deadline) await sleep(500);
  const child2Id = childOpens[1]?.sessionId ?? null;
  if (child2Id) {
    let running = false;
    while (Date.now() < p2Deadline) {
      const s = await rpc.call("sessions.get", { id: child2Id }).catch(() => null);
      if (s && s.status === "running") { running = true; break; }
      await sleep(300);
    }
    log(`child2 ${child2Id} running=${running} — interrupting the PARENT`);
    // Let it act at least once so the cancellation is genuinely mid-run.
    await sleep(4000);
    await rpc.call("sessions.interrupt", { id: parent.id });
  }
  // The cancelled run's mcp.call row lands when browser_agent_run resolves.
  const p2LogDeadline = Date.now() + 90_000;
  while (agentCalls.length <= callsBefore && Date.now() < p2LogDeadline) await sleep(500);
  const cancelledCall = agentCalls[callsBefore] ?? null;
  let child2Idle = false;
  if (child2Id) {
    const idleDeadline = Date.now() + 60_000;
    while (Date.now() < idleDeadline) {
      const s = await rpc.call("sessions.get", { id: child2Id }).catch(() => null);
      if (s && (s.status === "idle" || s.status === "ended")) { child2Idle = true; break; }
      await sleep(500);
    }
  }
  ok("a second child session was created for the interrupt phase", child2Id !== null, child2Id ?? "none");
  ok("interrupting the PARENT resolved the run as cancelled (ok:false in Activity)",
    cancelledCall !== null && cancelledCall.ok === false && /interrupt|cancel/i.test(cancelledCall.resultSummary ?? ""),
    cancelledCall ? `${cancelledCall.ok} ${cancelledCall.resultSummary?.slice(0, 80)}` : "no call row");
  ok("the interrupted child wound down (idle/ended, not still driving)", child2Idle, "");

  // Cleanup: only what this script spawned.
  bridge.stop();
  rpc.close();
  serverChild.kill("SIGTERM");
  await new Promise((r) => { serverChild.once("exit", r); setTimeout(r, 3000); });
  pageServer.close();
  console.log("\n=== W5 browser-agent-run live check ===");
  for (const line of results) console.log(line);
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
}

const overall = setTimeout(() => { console.error("driver timed out"); failures += 1; try { app.exit(1); } catch { process.exit(1); } }, OVERALL_TIMEOUT_MS);
app.whenReady().then(() => main())
  .catch((e) => { console.error("driver crashed:", e); failures += 1; })
  .finally(() => {
    clearTimeout(overall);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(failures === 0 ? 0 : 1);
  });
