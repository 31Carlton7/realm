/**
 * Live check: Settings ▸ RAM with real numbers, a hidden browser pane discarded and brought back,
 * and an agent's `machine_status` (run with: pnpm --filter @realm/server build &&
 * pnpm --filter @realm/desktop build && node apps/desktop/scripts/ram-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, opens a browser pane on a long local page and scrolls
 * it, opens two terminals, then:
 *
 *   1. Settings ▸ RAM: the total is the server's own report (real `ps`, `footprint`, `sysctl`), the
 *      categories add up to it, the browser pane is listed as hidden, and both faces are captured.
 *   2. "Discard hidden browser panes": its renderer process goes (main's own process list says so),
 *      and opening the pane again brings the page back where it was scrolled.
 *   3. A scripted agent calls `realm-workspace__machine_status` through the real gateway; its answer
 *      is read off the transcript.
 *
 * Ports: LIVE_SERVER_PORT (8795), LIVE_CDP_PORT (9235). Touches only a scratch dir under
 * LIVE_SCRATCH_ROOT. Bills nothing: Claude and Codex are the scripted agent, onboarding's session too.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9235);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8795);
const root = process.env.LIVE_SCRATCH_ROOT ?? path.join(repoRoot, "..", ".verify", "oct28", "r-live");
fs.mkdirSync(root, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, "realm-ram-live-"));
const home = path.join(scratch, "home");
const shots = path.join(root, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null, api = null, page = null;

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
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

async function evalIn(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let n = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const id = String(++n);
      pending.set(id, (msg) => (msg.ok === false || msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

function killPort(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      // Only ours: a process whose command line names this scratch dir or this worktree's bundle.
      const cmd = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
      if (cmd.includes(repoRoot) || cmd.includes(scratch)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    }
  } catch { /* nothing listening */ }
}

async function shoot(c, tag) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(shots, `ram-${tag}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  note("captured", file);
}

const MB = 1024 ** 2;
const mb = (b) => Math.round((b ?? 0) / MB);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  // A page long enough to scroll, served from here: nothing leaves the machine.
  page = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<title>Long page</title><body style="margin:0;font:16px system-ui">${Array.from({ length: 400 }, (_, i) => `<p style="height:40px;margin:0">Row ${i}</p>`).join("")}</body>`);
  });
  await new Promise((r) => page.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${page.address().port}/long`;
  const script = path.join(scratch, "fake-script.json");
  fs.writeFileSync(script, JSON.stringify([
    { on: "How is the machine", emit: [{ kind: "call", tool: "realm-workspace__machine_status", input: {} }, { kind: "text", text: "Read it." }] },
    // Brings a browser into the side panel the way an agent's `pane_show` does — no CDP op, so no
    // agent has driven the page and nothing spares it from a discard.
    { on: "Show the pane", emit: [{ kind: "call", tool: "realm-workspace__pane_show", input: {}, argsFromMessage: true }, { kind: "text", text: "Shown." }] },
  ]));

  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — build first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1",
      REALM_FAKE_STANDS_IN: "claude,codex", REALM_FAKE_SCRIPT: script,
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const awake = () => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);
  await awake();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await awake();

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  for (let i = 0; i < 2; i++) await api.call("terminals.create", { spaceId: space.id });

  // A browser pane on the long page, shown in the session's side panel, and scrolled.
  const { browserId } = await api.call("browsers.create", { spaceId: space.id, url: pageUrl });
  const lead = (await api.call("sessions.listAll", {}).catch(() => null))?.[0]?.id
    ?? (await api.call("items.list", { spaceId: space.id })).find((i) => i.kind === "session").refId;
  await api.call("sessions.send", { id: lead, text: `Show the pane ${JSON.stringify({ browserId })}`, attachments: [], mentions: [] });
  const viewTarget = await until(async () => (await targets()).find((t) => t.url === pageUrl), 30_000, "the page's own target");
  const view = cdp(viewTarget.webSocketDebuggerUrl);
  await view.ready;
  await until(async () => (await evalIn(view, "document.readyState")) === "complete", 10_000, "page loaded");
  await evalIn(view, "window.scrollTo(0, 4321); window.scrollY");
  note("scrolled the page to", await evalIn(view, "window.scrollY"));
  view.close();
  await sleep(1200);

  // ── 1. Settings ▸ RAM ───────────────────────────────────────────────────────────────────────────
  await evalIn(c, `(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    document.querySelector('.settings-rail input[value="ram"]').click();
    return true;
  })()`);
  await until(() => evalIn(c, `!!document.querySelector('.ram-total')`), 20_000, "the RAM page");
  // Settings covers the side panel, so the browser pane is off screen from here.
  await sleep(1500);
  const report = await api.call("resources.snapshot", { fresh: true });
  note("report", {
    realmMB: mb(report.realm.footprintBytes), realmResidentMB: mb(report.realm.residentBytes), processes: report.realm.processes,
    pressure: report.machine.pressure, swap: report.machine.swap && { usedMB: mb(report.machine.swap.usedBytes), totalMB: mb(report.machine.swap.totalBytes) },
    categories: report.categories.map((x) => [x.category, mb(x.footprintBytes), x.processes]),
    browsers: report.parts.filter((p) => p.category === "browsers").map((p) => [p.label, p.detail, mb(p.footprintBytes)]),
    others: report.others.slice(0, 5).map((o) => [o.name, mb(o.footprintBytes)]),
    freeable: report.freeable,
  });
  check("the report measures footprints on this Mac", report.measure === "footprint" && report.realm.footprintBytes > 0);
  check("its categories add up to Realm's total", report.categories.reduce((n, x) => n + (x.footprintBytes ?? 0), 0) === report.realm.footprintBytes);
  check("it names the app's own processes and the terminals", ["app", "server", "terminals"].every((k) => report.categories.some((x) => x.category === k)), report.categories.map((x) => x.category));
  check("the browser pane is listed, hidden", report.parts.some((p) => p.category === "browsers" && /^Hidden/.test(p.detail ?? "")), report.parts.filter((p) => p.category === "browsers"));

  // Every category open, so the capture shows the parts.
  await evalIn(c, `(() => { for (const d of document.querySelectorAll('.ram-category details')) d.open = true; return true; })()`);
  await sleep(400);
  const drawn = await evalIn(c, `(() => ({
    total: document.querySelector('.ram-total .settings-row-name')?.textContent,
    machine: document.querySelector('.ram-machine')?.textContent,
    categories: [...document.querySelectorAll('.ram-category summary')].map((s) => s.getAttribute('aria-label')),
    free: [...document.querySelectorAll('[data-setting^="ram-free-"]')].map((r) => r.textContent),
    windows: [...document.querySelectorAll('[data-setting^="ram-"] select')].map((s) => [s.getAttribute('aria-label'), s.value]),
  }))()`);
  note("page", drawn);
  check("the page draws the server's total", typeof drawn.total === "string" && /Realm is holding \d/.test(drawn.total), drawn.total);
  check("every window is drawn at its default", JSON.stringify(drawn.windows) === JSON.stringify([
    ["Stop an idle engine after", "30"], ["Stop an idle MCP server after", "30"], ["Stop Laya after", "10"],
    ["Shut down a simulator Realm booted after", "30"], ["Discard a hidden browser pane after", "20"], ["Hidden browser panes kept loaded", "3"],
  ]), drawn.windows);
  await shoot(c, "dark");
  // …and the rest of the page: the buttons and the windows, scrolled into the column.
  await evalIn(c, `(() => { for (const d of document.querySelectorAll('.ram-category details')) d.open = false;
    document.querySelector('[data-setting="ram-free-engines"]').scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(400);
  await shoot(c, "dark-lower");

  // ── 2. Discard it, and bring it back ────────────────────────────────────────────────────────────
  const metrics = async () => (await targets()).filter((t) => t.url === pageUrl).length;
  check("before: the page has a renderer of its own", (await metrics()) === 1);
  await evalIn(c, `(() => { document.querySelector('[data-setting="ram-free-browsers"] button').click(); return true; })()`);
  await until(() => evalIn(c, `/Discarded 1 pane/.test(document.querySelector('[data-setting="ram-free-browsers"]').textContent)`), 15_000, "discarded");
  check("the button discards the hidden pane: its page has no renderer", (await metrics()) === 0);
  await shoot(c, "after-discard");
  const after = await api.call("resources.snapshot", { fresh: true });
  note("report after discard", { realmMB: mb(after.realm.footprintBytes), browsers: after.parts.filter((p) => p.category === "browsers").length });
  check("the report no longer counts it", !after.parts.some((p) => p.category === "browsers"));
  // Back: leave Settings, and the side panel shows its tab again.
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(600);
  const back = await until(async () => (await targets()).find((t) => t.url === pageUrl), 20_000, "the page back");
  const bv = cdp(back.webSocketDebuggerUrl);
  await bv.ready;
  const y = await until(async () => { const v = await evalIn(bv, "window.scrollY").catch(() => 0); return v > 0 ? v : null; }, 10_000, "scroll restored").catch(() => 0);
  bv.close();
  check("shown again, the page comes back where it was scrolled", y === 4321, { scrollY: y });

  // ── 3. An agent asks how the machine is ─────────────────────────────────────────────────────────
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", permissionMode: "default" });
  await api.call("sessions.send", { id: session.id, text: "How is the machine before I build?", attachments: [], mentions: [] });
  const result = await until(async () => {
    const stored = await api.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 });
    const r = stored.map((e) => e.event).find((e) => e.type === "tool_result");
    return r ? r : null;
  }, 30_000, "the tool's answer");
  const text = typeof result.payload.content === "string" ? result.payload.content : JSON.stringify(result.payload.content);
  console.log(`INFO machine_status said:\n${text.split("\\n").join("\n").slice(0, 2400)}`);
  check("machine_status answered through the gateway with the Mac's pressure and advice", /Memory pressure:/.test(text) && /## Advice/.test(text));
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  page?.close();
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
