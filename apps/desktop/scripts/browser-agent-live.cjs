/**
 * Live check for Plan 11 W3 — the browser agent tool surface, driven end to end by a REAL Claude
 * session through the REAL stack:
 *
 *   claude CLI ── MCP (gateway, http://127.0.0.1:<port0>/mcp, Bearer) ──▶ realm-server
 *      realm-browser provider → permission broker → browserHost bridge (WS) ──▶ THIS Electron process
 *         BrowserAgentHost → webContents.debugger CDP → a real WebContentsView
 *
 * Proves:
 *   1. browser_open raises a permission_request through the session's normal flow; on allow the pane
 *      opens (this script plays the renderer: it mounts the view on browser.agentOpened).
 *   2. browser_snapshot reaches the agent with the test page's button in it, fenced as untrusted.
 *   3. browser_act click (gated again) actually clicks — the test page records the hit server-side.
 *   4. The page's password field value NEVER appears in any persisted session event.
 *
 * Run:  pnpm --filter @realm/server build && \
 *       apps/desktop/node_modules/.bin/electron apps/desktop/scripts/browser-agent-live.cjs
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-agent-live-"));
const PAGE_PORT = 8799;
const OVERALL_TIMEOUT_MS = 300_000;
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
// Same switch the real app carries (main/index.ts): an occluded window's WebContentsView drops ALL
// synthetic input after a cross-process navigation. This script's window is usually behind the
// terminal that launched it, so without this the click lands nowhere — found the hard way.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// ---- the test page: a button that phones home, a text input, a prefilled password input ----
let clicks = 0;
function startTestPage() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/clicked") { clicks += 1; res.writeHead(204); res.end(); return; }
      if (req.url === "/state") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ clicks })); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>W3 live page</title><body style="font:14px sans-serif;padding:2rem">
        <h1>Realm W3 live check page</h1>
        <p id="count">clicks: 0</p>
        <button id="inc" onclick="fetch('/clicked',{method:'POST'}).then(()=>{document.getElementById('count').textContent='clicks: '+(++window.__n)})">Increment counter</button>
        <script>window.__n=0<\/script>
        <form><label>Name <input type="text" name="name" placeholder="your name"></label>
        <label>Secret <input type="password" name="pw" value="${PASSWORD_VALUE}"></label></form>
      </body>`);
    });
    server.once("error", (e) => reject(new Error(`test page port ${PAGE_PORT} unavailable: ${e.message} — is something already on it?`)));
    server.listen(PAGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- realm-server child (the REAL dist build, spawned exactly as production spawns it) ----
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

  // The Electron half: window + pane + executor + bridge — the exact production wiring.
  const win = new BrowserWindow({ width: 1000, height: 700, x: 40, y: 40, title: "Realm W3 live check (auto-closes)", backgroundColor: "#17181a" });
  await win.loadURL("data:text/html," + encodeURIComponent("<body style='background:#17181a;color:#eee;font:13px sans-serif;padding:8px'>W3 live check — the browser view mounts below when the agent opens it</body>"));
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

  // Play the renderer: when the agent opens a browser, mount + place its native view.
  const permissionLog = [];
  let sessionId = null;
  rpc.onEvent((event, payload) => {
    if (event === "browser.agentOpened") {
      log(`agent opened browser ${payload.browserId} — mounting the view`);
      rpc.call("browsers.get", { browserId: payload.browserId }).then((row) => {
        pane.host.create(payload.browserId, row.url, null);
        const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
        pane.host.setBounds(payload.browserId, { x: 20, y: 60, width: 940, height: 600 }, scale, true);
      }).catch((e) => log(`mount failed: ${e.message}`));
    }
    if (event === "session.event" && payload.sessionId === sessionId && payload.event.type === "permission_request") {
      const { requestId, toolName, title } = payload.event.payload;
      permissionLog.push({ requestId, toolName, title });
      log(`permission_request [${toolName}] "${title}" → allow`);
      rpc.call("sessions.respondPermission", { id: sessionId, requestId, decision: "allow" }).catch((e) => log(`respond failed: ${e.message}`));
    }
  });

  const profile = await rpc.call("profiles.create", { name: "W3 live" });
  const space = await rpc.call("spaces.create", { profileId: profile.id, name: "Live" });
  const { session } = await rpc.call("sessions.create", { spaceId: space.id, agentKind: "claude", permissionMode: "default", projectId: null });
  sessionId = session.id;
  log(`claude session ${sessionId} in space ${space.id}`);

  await rpc.call("sessions.send", {
    id: sessionId,
    text: [
      "You have Realm's realm-browser MCP tools (names like realm-browser__browser_open). Do exactly this, in order:",
      `1. browser_open with url http://127.0.0.1:${PAGE_PORT}/`,
      "2. browser_snapshot on the returned browserId (retry once after a few seconds if the page has not loaded).",
      "3. browser_act: click the button whose snapshot line contains 'Increment counter' (use its [ref=N]).",
      "4. Reply with exactly: DONE <the ref you clicked>",
      "Do not use any other tools. Do not read or type into the password field.",
    ].join("\n"),
  });

  // Wait for the click to land (or timeout). The permission handler above keeps the flow moving.
  const deadline = Date.now() + OVERALL_TIMEOUT_MS - 30_000;
  while (clicks === 0 && Date.now() < deadline) await sleep(1000);

  // Give the final assistant message a moment, then read the whole persisted transcript.
  await sleep(3000);
  const events = await rpc.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
  const allText = JSON.stringify(events);
  const toolResults = events.filter((e) => e.event.type === "tool_result").map((e) => e.event.payload.content).join("\n");
  const brokerRequests = permissionLog.filter((p) => ["browser_open", "browser_navigate", "browser_act", "browser_batch"].includes(p.toolName));

  ok("the page's button was actually clicked (server-side counter)", clicks >= 1, `clicks=${clicks}`);
  ok("a snapshot with the button reached the agent", toolResults.includes("Increment counter"), "");
  ok("snapshot content was fenced as untrusted", /untrusted-[0-9a-f]{16}/.test(toolResults), "");
  ok("browser_open raised a broker permission_request (ApprovalCard flow)", brokerRequests.some((p) => p.toolName === "browser_open"), JSON.stringify(brokerRequests.map((p) => p.toolName)));
  ok("browser_act raised one too, with a human-readable title", brokerRequests.some((p) => p.toolName === "browser_act" && /click/i.test(p.title)), brokerRequests.map((p) => p.title).join(" | "));
  ok("the password value appears in NO persisted event", !allText.includes(PASSWORD_VALUE), "");
  ok("the session finished its turn (DONE in a final message)", events.some((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("DONE")), "");

  // Cleanup: only what this script spawned.
  bridge.stop();
  rpc.close();
  serverChild.kill("SIGTERM");
  await new Promise((r) => { serverChild.once("exit", r); setTimeout(r, 3000); });
  pageServer.close();
  console.log("\n=== W3 browser-agent live check ===");
  for (const line of results) console.log(line);
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
}

app.whenReady().then(() => main())
  .catch((e) => { console.error("driver crashed:", e); failures += 1; })
  .finally(() => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(failures === 0 ? 0 : 1);
  });
