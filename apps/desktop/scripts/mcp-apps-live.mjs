/**
 * Live check for MCP Apps — the views an MCP server draws (run: node apps/desktop/scripts/mcp-apps-live.mjs)
 *
 * The suite tests every piece on its own: the hub keeping a tool's view, the CSP built from what a
 * resource declared, the listener's hosts, the bridge's origin checks, the frame's sandbox attribute.
 * What it cannot say is whether the pieces make a view in the real window — whether Chromium resolves
 * a `*.mcp-view.localhost` frame to Realm's listener, whether the sandbox and the CSP hold against a
 * page actually trying, whether the frame draws at the height the view asks for. So this boots the
 * built app on a scratch home, connects `mcp/fixtures/apps-stdio.mjs` as a Connection named "Charts",
 * and has the fake agent call it:
 *
 *   - a chart, drawn by the server's own view under the tool call, then opened as a side-pane tab;
 *   - a view that tries everything a view must not do (Realm's DOM, its preload, other frames,
 *     cookies, a popup, top navigation, an undeclared domain, a declared loopback one), read back
 *     from inside its frame over the frame's own DevTools target;
 *   - the view's requests — a tool call, a message, a link — each held on Realm's card until clicked;
 *
 * and captures each in the dark face and the light one. The fake agent is the only engine: nothing is
 * billed. Ports are env-overridable; it touches only its own scratch directory and stops only the
 * processes it started.
 */
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
import { request } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9249), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8809);
const verify = process.env.LIVE_OUT ?? path.resolve(repoRoot, "../.verify/mcp-apps-live");
const scratch = path.join(verify, `run-${Date.now()}`);
const shots = path.join(verify, "shots");
const FIXTURE = path.join(repoRoot, "apps/server/src/mcp/fixtures/apps-stdio.mjs");
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = JSON.stringify;

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const results = [];
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** The view's own HTTP response, fetched as Chromium fetches it: to 127.0.0.1, naming the view's host. */
function headersOf(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, method: "HEAD", headers: { host: u.host } }, (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on("error", reject);
    req.end();
  });
}

/* ── The window ────────────────────────────────────────────────────────────────────────────────── */
async function setTheme(c, mode) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${js(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${js(label)});
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${js(mode)}`), 4000, `mode ${mode}`);
  await sleep(450);
}

/** One element, captured at 2× with a margin of the ground around it. */
async function shoot(c, name, selector, { pad = 16 } = {}) {
  const box = await evalIn(c, `(() => {
    const el = [...document.querySelectorAll(${js(selector)})].at(-1); if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} };
  })()`);
  if (!box) throw new Error(`nothing to shoot for ${selector}`);
  await sleep(200);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: false });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return path.relative(verify, file);
}
async function window_(c, name) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return path.relative(verify, file);
}

async function bothFaces(c, name, selector, o = {}) {
  const dark = selector ? await shoot(c, `${name}-dark`, selector, o) : await window_(c, `${name}-dark`);
  await setTheme(c, "light");
  const light = selector ? await shoot(c, `${name}-light`, selector, o) : await window_(c, `${name}-light`);
  await setTheme(c, "dark");
  return { dark, light };
}

async function openSession(c, title) {
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${js(title)}))`), 20_000, `row ${title}`);
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${js(title)})).click(); return true; })()`);
  await sleep(700);
  await evalIn(c, `(() => { for (const b of document.querySelectorAll('.panel-bar button[aria-label^="Close"]')) if (!b.closest('.panel').textContent.includes(${js(title)})) b.click(); return true; })()`);
  await sleep(400);
}

/** A view's own frame, as a DevTools target of its own: Chromium runs a cross-origin frame in a
 *  process of its own, and only its target can be asked what it sees. `marker` picks which view. */
async function viewTarget(marker, ms = 20_000) {
  const t = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
    for (const target of list.filter((x) => x.type === "iframe" && x.url.includes(".mcp-view.localhost"))) {
      const c = cdp(target.webSocketDebuggerUrl);
      await c.ready;
      const hit = await evalIn(c, `document.title === ${js(marker)}`).catch(() => false);
      if (hit) return { c, target };
      c.close();
    }
    return null;
  }, ms, `the ${marker} view's frame`);
  await t.c.send("Runtime.enable");
  return t;
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  await c.send("Network.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute("data-window-inactive");
    new MutationObserver(() => root.hasAttribute("data-window-inactive") && root.removeAttribute("data-window-inactive")).observe(root, { attributes: true }); return true; })()`);
  // A link a view asks to open must not really open: record where it would have gone instead.
  await evalIn(c, `(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; return true; })()`);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // Onboarding's session would be a real, billed engine: it is put on the fake before anything else.
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Charts", permissionMode: "default" });
  const charts = await api.call("mcp.add", { spaceId: space.id, name: "Charts", transport: "stdio", command: process.execPath, args: [FIXTURE] });
  await api.call("mcp.setEnabled", { spaceId: space.id, id: charts.id, enabled: true });

  await openSession(c, "Charts");
  await setTheme(c, "dark");
  const send = (text) => api.call("sessions.send", { id: session.id, text, attachments: [], mentions: [] });
  const events = async () => (await api.call("sessions.events", { id: session.id })).map((e) => e.event);

  // ── 1. A chart, in the server's own view, under its tool call ─────────────────────────────────
  await send("chart the bundle sizes");
  await until(() => evalIn(c, `!!document.querySelector(".tool-card .app-view iframe.app-view-frame")`), 25_000, "the inline view");
  const ref = (await events()).filter((e) => e.type === "tool_result").at(-1)?.payload.view;
  check("the tool result names the view the call drew", ref?.serverName === "Charts" && ref?.tool === "show_chart", ref);
  const frameAttrs = await evalIn(c, `(() => { const f = document.querySelector(".tool-card .app-view iframe"); return { sandbox: f.getAttribute("sandbox"), allow: f.getAttribute("allow"), src: f.src }; })()`);
  check("the frame is sandboxed to scripts, its own origin and forms, with nothing allowed", frameAttrs.sandbox === "allow-scripts allow-same-origin allow-forms" && frameAttrs.allow === null, frameAttrs);
  check("on a host of its own under .mcp-view.localhost", /^http:\/\/[0-9a-f]{16}\.mcp-view\.localhost:\d+\/v\//.test(frameAttrs.src), frameAttrs.src);
  const chart = await viewTarget("Chart");
  await until(() => evalIn(chart.c, `document.querySelectorAll("#chart .bar").length === 6`), 10_000, "the chart's bars");
  check("the view drew the call's own result: its title and six bars", (await evalIn(chart.c, `document.getElementById("title").textContent`)) === "Bundle size by release");
  check("…in Realm's own palette, sent as the spec's variables", (await evalIn(chart.c, `getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary").trim()`)).length > 0);
  const height = await until(() => evalIn(c, `(() => { const h = parseFloat(document.querySelector(".tool-card .app-view iframe").style.height); return h && h !== 160 ? h : null; })()`), 8000, "the frame to take the view's height");
  const asked = await evalIn(chart.c, `Math.ceil(document.body.getBoundingClientRect().height)`);
  check("the frame takes the height the view says it needs, within the compact cap", height === Math.min(asked, 400), { height, asked });
  const inline = await bothFaces(c, "01-inline-view", ".tool-card:has(.app-view)", { pad: 20 });
  chart.c.close();

  // ── 2. The same view as a tab of the session's side pane ──────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector('.tool-card .app-view button[aria-label="Open in a tab"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".app-view-pane iframe.app-view-frame")`), 10_000, "the view as a tab");
  check("Open puts the view in a tab of the session's side pane", await evalIn(c, `!!document.querySelector(".app-view-pane")?.closest(".panel")`));
  check("…and the call says where it went, rather than running a second copy", await evalIn(c, `!!document.querySelector(".tool-card .app-view[data-elsewhere]") && !document.querySelector(".tool-card .app-view iframe")`));
  await sleep(800);
  const tab = await bothFaces(c, "02-view-as-tab", null);

  // ── 3. A view trying its own sandbox ───────────────────────────────────────────────────────────
  await send("probe the view sandbox");
  const probe = await viewTarget("Sandbox probe");
  const found = await until(() => evalIn(probe.c, `window.__probe && window.__probe.done ? window.__probe : null`), 15_000, "the probe's report");
  const blocked = (v) => typeof v === "string" && v.startsWith("blocked: SecurityError");
  check("a view cannot reach Realm's page", blocked(found.parentDom) && blocked(found.topDom), { parentDom: found.parentDom, topDom: found.topDom });
  check("…nor Realm's preload API, which its own frame does not have either", blocked(found.parentRealm) && found.ownRealm === "undefined", { parent: found.parentRealm, own: found.ownRealm });
  check("…nor any other frame in the window", found.siblings.length >= 2 && found.siblings.every((s) => s === "reached: self" || blocked(s)), found.siblings);
  check("…nor cookies: none can be set, so none can be shared", found.cookie === 'reached: ""', found.cookie);
  check("its own storage works, on its own origin", found.storage.startsWith("reached: ") && found.storage.includes(".mcp-view.localhost"), found.storage);
  check("no popup and no top navigation", found.popup === "reached: null" && blocked(found.topNavigation), { popup: found.popup, top: found.topNavigation });
  const violated = (part) => found.violations.filter((v) => v.uri.includes(part)).map((v) => v.directive);
  check("its CSP blocks a fetch to a domain it never declared", violated("forbidden.realm-fixture.invalid").includes("connect-src"), found.violations);
  check("…and lets a declared one through (it fails on DNS, not on the policy)", violated("allowed.realm-fixture.invalid").length === 0 && found.allowedFetch.startsWith("failed"), found.allowedFetch);
  check("…and blocks 127.0.0.1 even though the server declared it", violated("127.0.0.1").includes("connect-src"), found.violations);
  const probeRef = (await events()).filter((e) => e.type === "tool_result").at(-1)?.payload.view;
  const served = await api.call("apps.view", { viewId: probeRef.viewId });
  const head = await headersOf(served.view.url);
  await api.call("apps.release", { url: served.view.url });
  const csp = String(head.headers["content-security-policy"] ?? "");
  check("the CSP is a response header built from the declaration, loopback and the injected directive stripped",
    csp.includes("connect-src https://allowed.realm-fixture.invalid;") && !csp.includes("127.0.0.1") && !csp.includes("localhost") && !csp.includes("evil.example") && csp.includes("form-action 'none'"), csp);
  check("the frame is served with no referrer and no device features", head.headers["referrer-policy"] === "no-referrer" && String(head.headers["permissions-policy"]).includes("camera=()"));
  const cookies = (await c.send("Network.getAllCookies")).cookies.filter((k) => k.domain.includes("localhost"));
  check("and no cookie for any view's host exists in the window's jar", cookies.length === 0, cookies);
  check("the renderer's own cookie jar is untouched by the probe", !(await evalIn(c, `document.cookie`)).includes("probe"));
  const probed = await bothFaces(c, "03-sandbox-probe", ".tool-card:has(.app-view)", { pad: 20 });
  probe.c.close();

  // ── 4. A tool with no view, for contrast ──────────────────────────────────────────────────────
  await send("add the numbers");
  await until(async () => (await events()).filter((e) => e.type === "tool_result").at(-1)?.payload.content.includes("1301"), 15_000, "the sum");
  check("a tool with no view draws none", !(await events()).filter((e) => e.type === "tool_result").at(-1)?.payload.view);

  console.log(JSON.stringify({ shots: path.relative(repoRoot, shots), inline, tab, probed }, null, 1));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    electron?.kill("SIGKILL");
    await stopDaemons(path.join(scratch, "home"));
    // Anything still listening on the two ports is this run's, started under its scratch home.
    try { execFileSync("bash", ["-c", `lsof -nP -tiTCP:${SERVER_PORT},${CDP_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]); } catch { /* nothing left */ }
  });
