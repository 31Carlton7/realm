/**
 * Live check for sign-in popups in the browser pane (run with: pnpm build && node apps/desktop/scripts/sso-popup-live.mjs)
 *
 * The bug: "When using SSO (like google) into a website, it freezes on a blank screen after selecting
 * which user we want." A pane answered every `window.open` by navigating ITSELF, so the provider's page
 * replaced the page waiting for it and had no opener to post back to. Boots the BUILT app on a scratch
 * REALM_HOME with a scripted ACP agent (nothing billed), and two local origins standing in for a site
 * (A) and its sign-in provider (B), and checks, in the real windows:
 *
 *   S1  A's "Sign in with B" opens B in a real popup window — a child of the Realm window, at the
 *       500×600 viewport it asked for, in the pane's own cookie jar, with Realm's user agent on the wire
 *       and in the page, and the host in its title bar — with `window.opener` set, and the pane still
 *       on A; a popup opened with `noopener`, which Electron makes itself, is in the pane's jar too;
 *   S2  an agent's snapshot of the pane says a popup is open over it, and on which origin;
 *   S3  picking the account in B posts the token to A and closes B: A shows it, the window is gone,
 *       and the snapshot stops mentioning a popup;
 *   S4  a target=_blank link still navigates the pane in place and opens no window;
 *   S5  a same-tab redirect sign-in (A → B → A/callback) still finishes in the pane;
 *   S6  a page that opens an empty window and then sends it somewhere gets a window, and the pane is
 *       not blanked;
 *   S7  Google's real sign-in page loads in the popup, as Realm's user agent, as far as its first
 *       step — nothing is typed;
 *   S8  closing the pane closes every popup it has open.
 *
 * Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8802 / 9242), LIVE_SITE_A_PORT / LIVE_SITE_B_PORT
 * (18802 / 18803) and LIVE_MAIN_INSPECT_PORT (19242), refused if taken; only processes on them whose
 * command line is this checkout's or this run's are killed. Screenshots go to LIVE_OUT.
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
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9242);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8802);
const SITE_A_PORT = Number(process.env.LIVE_SITE_A_PORT ?? 18802);
const SITE_B_PORT = Number(process.env.LIVE_SITE_B_PORT ?? 18803);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 19242);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-sso-popup-live");
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sso-popup-live-"));
const home = path.join(scratch, "home");
const A = `http://127.0.0.1:${SITE_A_PORT}`;
const B = `http://127.0.0.1:${SITE_B_PORT}`;
/** A real Google OAuth request — the OAuth Playground's public client — that stops at the account step. */
const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=407408718192.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fdevelopers.google.com%2Foauthplayground&response_type=code&scope=email&prompt=select_account";
const TOKEN = "tok-4f2a";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null, api = null, siteA = null, siteB = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
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
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
/** An expression in main, with `require` — the Electron objects themselves, not what a page says. */
async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
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
/** Whatever this run started on a port: a process whose command line is this checkout's or this run's. */
function killPort(port) {
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { return; } // nothing listening
  for (const pid of pids) {
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { continue; }
    if (!command.includes(repoRoot) && !command.includes(scratch)) { note(`left alone on port ${port}, not this run's`, { pid, command: command.slice(0, 120) }); continue; }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
const text = (r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/* ── the two origins ─────────────────────────────────────────────────────────────────────────── */

const requests = [];
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px -apple-system,system-ui;margin:0;padding:40px;color:#1f2328}button,a.btn{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer;margin:0 8px 8px 0;display:inline-block;color:inherit;text-decoration:none}#status{font-weight:600;margin:16px 0 24px}</style>
</head><body>${body}</body></html>`;

const SITE_A_HOME = page("Site A", `<h1>Site A</h1><p id="status">Signed out</p>
<button id="signin" onclick="window.open('${B}/auth', 'auth', 'width=500,height=600')">Sign in with B</button>
<button id="blank" onclick="const w = window.open(''); w.location = '${B}/auth?blank=1';">Sign in with B (opens a blank window first)</button>
<button id="noopener" onclick="window.open('${B}/auth?noopener=1', 'nb', 'noopener,width=500,height=600')">Sign in with B (noopener)</button>
<button id="google" onclick="window.open('${GOOGLE}', 'google', 'width=500,height=600')">Sign in with Google</button>
<a id="docs" class="btn" href="${B}/docs" target="_blank">B's docs (target=_blank)</a>
<a id="redirect" class="btn" href="/login">Sign in with B, same tab</a>
<script>
  document.cookie = "jar=pane-a; path=/";
  window.addEventListener("message", (e) => {
    if (e.origin !== "${B}") return;
    document.querySelector("#status").textContent = "Signed in as " + e.data.name + " (token " + e.data.token + ")";
  });
</script>`);

const SITE_B_PICKER = page("Choose an account", `<div style="max-width:380px;margin:0 auto;text-align:center">
<h2 style="font-weight:500">Choose an account</h2><p style="color:#57606a">to continue to Site A</p>
<button id="ada" style="display:block;width:100%;text-align:left;padding:14px;background:#fff">
  <b>Ada Lovelace</b><br><span style="color:#57606a">ada@example.com</span></button>
</div>
<script>
  window.facts = { opener: window.opener !== null, ua: navigator.userAgent, cookie: document.cookie, w: innerWidth, h: innerHeight };
  document.querySelector("#ada").onclick = () => {
    window.opener.postMessage({ name: "Ada", token: "${TOKEN}" }, "${A}");
    window.close();
  };
</script>`);

function startSite(port, origin, routes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", origin);
      requests.push({ origin, path: url.pathname, ua: req.headers["user-agent"] ?? "", cookie: req.headers.cookie ?? null });
      const route = routes[url.pathname];
      if (typeof route === "function") return route(url, res);
      res.writeHead(route ? 200 : 404, { "content-type": "text/html" });
      res.end(route ?? page("Not found", "<h1>Not found</h1>"));
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/* ── the windows, as main has them ───────────────────────────────────────────────────────────── */

const windows = (m) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView } = require("electron");
  return BrowserWindow.getAllWindows().map((w) => ({
    id: w.id, url: w.webContents.getURL(), title: w.getTitle(), parent: w.getParentWindow()?.id ?? null,
    content: w.getContentSize(), bounds: w.getBounds(), visible: w.isVisible(), focusable: w.isFocusable(),
    views: w.contentView.children.filter((v) => v instanceof WebContentsView).map((v) => v.webContents.getURL()),
  }));
})()`);
const popupsOn = async (m, origin) => (await windows(m)).filter((w) => w.parent !== null && w.url.startsWith(origin));

/** The popup's jar and its opener, read off the webContents: is it the pane's session, and not the app's? */
const popupSession = (m, origin) => inMain(m, `(() => {
  const { BrowserWindow, WebContentsView, session } = require("electron");
  const all = BrowserWindow.getAllWindows();
  const popup = all.find((w) => w.getParentWindow() && w.webContents.getURL().startsWith(${JSON.stringify(origin)}));
  const pane = all.flatMap((w) => w.contentView.children).find((v) => v instanceof WebContentsView && v.webContents.getURL().startsWith(${JSON.stringify(A)}));
  if (!popup || !pane) return null;
  return {
    sameAsPane: popup.webContents.session === pane.webContents.session,
    isDefault: popup.webContents.session === session.defaultSession,
    paneJar: pane.webContents.session === session.fromPartition("persist:browser"),
    openerIsPane: popup.webContents.opener?.processId === pane.webContents.mainFrame.processId && popup.webContents.opener?.routingId === pane.webContents.mainFrame.routingId,
    sandboxed: popup.webContents.getLastWebPreferences().sandbox === true && popup.webContents.getLastWebPreferences().nodeIntegration === false,
  };
})()`);

/** The pane's or popup's own page, as its own CDP target. */
const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
async function attachTo(prefix, tag) {
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith(prefix)), 20_000, tag);
  const c = cdp(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}
async function clickIn(c, selector) {
  const at = await evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
}
async function pageShot(c, tag) {
  await sleep(500);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
/** Realm's own user agent (browser-host.ts `browserUserAgent`): no Electron token, a reduced Chrome version. */
const realmAgent = (ua) => !!ua && !/Electron\//.test(ua) && /Chrome\/\d+\.0\.0\.0 /.test(ua);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_A_PORT, SITE_B_PORT, MAIN_INSPECT_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  siteA = await startSite(SITE_A_PORT, A, {
    "/": SITE_A_HOME,
    "/login": (_url, res) => { res.writeHead(302, { location: `${B}/authorize?redirect_uri=${encodeURIComponent(`${A}/callback`)}` }); res.end(); },
    "/callback": (url, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page("Site A — signed in", `<h1>Site A</h1><p id="status">Signed in with code ${url.searchParams.get("code")}</p>`)); },
  });
  siteB = await startSite(SITE_B_PORT, B, {
    "/auth": SITE_B_PICKER,
    "/docs": page("B docs", "<h1>B docs</h1>"),
    "/authorize": (url, res) => { res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=redirect-7c1` }); res.end(); },
  });

  const agent = path.join(scratch, "fake-acp");
  fs.writeFileSync(agent, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-acp 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${path.join(repoRoot, "packages/adapters/src/acp/fixtures/fake-acp-agent.mjs")}" "$@"\n`);
  fs.chmodSync(agent, 0o755);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_GEMINI_BIN: agent,
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  // An unkeyed window reads as inactive and quiets itself; this one is never keyed, by design.
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute("data-window-inactive");
    new MutationObserver(() => { if (root.hasAttribute("data-window-inactive")) root.removeAttribute("data-window-inactive"); }).observe(root, { attributes: true, attributeFilter: ["data-window-inactive"] });
    return true; })()`);
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "SSO");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  // Every permission card the agent raises is answered as the person would: allow.
  let sessionId = null;
  api = rpc(SERVER_PORT, await daemonToken(home), (event, payload) => {
    if (event !== "session.event" || payload.sessionId !== sessionId || payload.event?.type !== "permission_request") return;
    void api.call("sessions.respondPermission", { id: sessionId, requestId: payload.event.payload.requestId, decision: "allow" }).catch(() => {});
  });
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // The onboarding session runs a real engine; it goes to the fake agent before anything else.
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini", title: "SSO live check", permissionMode: "default" });
  sessionId = session.id;
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes("SSO live check"))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("SSO live check")).click(); return true; })()`);
  await sleep(800);
  await api.call("sessions.send", { id: sessionId, text: "REVEAL", attachments: [], mentions: [] });
  const journal = await until(async () => {
    const evs = await api.call("sessions.events", { id: sessionId, afterSeq: 0, limit: 2000 });
    const said = evs.find((e) => e.event.type === "assistant_text" && e.event.payload.text.includes("newParams"));
    return said ? JSON.parse(said.event.payload.text) : null;
  }, 30_000, "the scripted agent's journal");
  const gw = journal.newParams.mcpServers.find((s) => s.name === "realm");
  const sdk = (rel) => import(pathToFileURL(path.join(repoRoot, "apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm", rel)).href);
  const { Client } = await sdk("client/index.js");
  const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");
  const client = new Client({ name: "sso-popup-live", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(gw.url), { requestInit: { headers: Object.fromEntries(gw.headers.map((h) => [h.name, h.value])) } }));
  const call = (name, args = {}) => client.callTool({ name: `realm-browser__${name}`, arguments: args }, undefined, { timeout: 120_000 });

  const opened = await call("browser_open", { url: `${A}/` });
  const browserId = /pane (\S+) at/.exec(text(opened))?.[1];
  check("an agent opens a pane on site A", !!browserId, text(opened));
  let pane = await attachTo(`${A}/`, "pane target");
  await until(() => evalIn(pane, `document.readyState === "complete" && !!document.querySelector("#signin")`), 15_000, "site A");
  const realm = (await windows(m)).find((w) => w.parent === null);
  note("the Realm window", realm);

  /* ── S1: the popup ──────────────────────────────────────────────────────────────────────────── */
  await pageShot(pane, "s1-pane-before");
  await clickIn(pane, "#signin");
  const popup = await attachTo(`${B}/auth`, "popup target");
  await until(() => evalIn(popup, `document.readyState === "complete" && !!window.facts`), 15_000, "the picker");
  const facts = await evalIn(popup, `window.facts`);
  const [win] = await until(async () => { const p = await popupsOn(m, `${B}/auth`); return p.length ? p : null; }, 10_000, "the popup window");
  const jar = await popupSession(m, `${B}/auth`);
  check("S1 the click opened B in a real window, a child of the Realm window", !!win && win.parent === realm.id && win.visible, win);
  check("S1 …at the 500×600 viewport the page asked for", win.content.join("x") === "500x600" && facts.w === 500 && facts.h === 600, { content: win.content, page: [facts.w, facts.h] });
  check("S1 …centred over the Realm window", Math.abs(win.bounds.x + win.bounds.width / 2 - (realm.bounds.x + realm.bounds.width / 2)) <= 2, { popup: win.bounds, realm: realm.bounds });
  check("S1 B's page has its opener — the thing the in-place navigation took away", facts.opener === true && jar?.openerIsPane === true, { opener: facts.opener, openerIsPane: jar?.openerIsPane });
  check("S1 …in the pane's own cookie jar, not the app's", jar?.sameAsPane === true && jar.paneJar === true && jar.isDefault === false && facts.cookie.includes("jar=pane-a"), { ...jar, cookie: facts.cookie });
  check("S1 …sandboxed like the pane", jar?.sandboxed === true, jar);
  const authAsk = requests.find((r) => r.origin === B && r.path === "/auth");
  check("S1 …presenting Realm's user agent from its first request, on the wire and to the page", realmAgent(facts.ua) && realmAgent(authAsk?.ua), { page: facts.ua, wire: authAsk?.ua });
  check("S1 …with the host first in its title bar", win.title === `127.0.0.1:${SITE_B_PORT} — Choose an account`, win.title);
  check("S1 …and no more able to take the keyboard than the scratch window it belongs to", win.focusable === false && realm.focusable === false, { popup: win.focusable, realm: realm.focusable });
  check("S1 the pane stayed on A, waiting", (await evalIn(pane, `location.href`)) === `${A}/` && (await evalIn(pane, `document.querySelector("#status").textContent`)) === "Signed out", null);
  await pageShot(popup, "s1-popup-picker");

  /* ── S2: what an agent is told ──────────────────────────────────────────────────────────────── */
  const snapOpen = text(await call("browser_snapshot", { browserId }));
  check("S2 the pane's snapshot says a popup is open over it, on B's origin", snapOpen.includes(`popup window open over it, on ${B}`), snapOpen.split("\n").slice(-2));

  /* ── S3: pick the account ───────────────────────────────────────────────────────────────────── */
  await clickIn(popup, "#ada");
  popup.close();
  const status = await until(async () => { const s = await evalIn(pane, `document.querySelector("#status").textContent`); return s.startsWith("Signed in") ? s : null; }, 10_000, "A's answer").catch(() => null);
  check("S3 picking the account posted the token to A, which shows it", status === `Signed in as Ada (token ${TOKEN})`, status);
  await until(async () => (await popupsOn(m, B)).length === 0, 10_000, "the popup gone").catch(() => {});
  const after = await windows(m);
  check("S3 …and the popup closed itself: no window, no page target", after.every((w) => w.parent === null) && !(await targets()).some((t) => t.url.startsWith(B)), after.map((w) => ({ id: w.id, url: w.url, parent: w.parent })));
  await pageShot(pane, "s3-pane-signed-in");
  const snapClosed = text(await call("browser_snapshot", { browserId }));
  check("S3 …and the snapshot stopped mentioning one", !snapClosed.includes("popup"), snapClosed.split("\n").slice(-2));

  /* ── S4: a target=_blank link stays in place ────────────────────────────────────────────────── */
  const before = (await windows(m)).length;
  await clickIn(pane, "#docs");
  const docsUrl = await until(async () => (await targets()).find((t) => t.url === `${B}/docs`)?.url ?? null, 10_000, "B docs").catch(() => null);
  await sleep(500);
  check("S4 a target=_blank link navigated the pane in place and opened no window", docsUrl === `${B}/docs` && (await windows(m)).length === before && (await windows(m)).some((w) => w.views.includes(`${B}/docs`)), await windows(m));

  /* ── S5: a same-tab redirect sign-in ────────────────────────────────────────────────────────── */
  await call("browser_navigate", { browserId, url: `${A}/login` });
  pane.close();
  pane = await attachTo(`${A}/callback`, "the callback");
  const code = await until(() => evalIn(pane, `document.querySelector("#status")?.textContent ?? ""`), 10_000, "the callback page").catch(() => null);
  check("S5 a same-tab redirect sign-in went A → B → A/callback and finished in the pane", code === "Signed in with code redirect-7c1" && requests.some((r) => r.origin === B && r.path === "/authorize"), code);

  /* ── S6: an empty window, sent somewhere after ─────────────────────────────────────────────── */
  await call("browser_navigate", { browserId, url: `${A}/` });
  pane.close();
  pane = await attachTo(`${A}/`, "site A again");
  await until(() => evalIn(pane, `document.readyState === "complete" && !!document.querySelector("#blank")`), 15_000, "site A again");
  await clickIn(pane, "#blank");
  const blank = await attachTo(`${B}/auth?blank=1`, "the blank window, sent to B").catch(() => null);
  const blankFacts = blank ? await until(() => evalIn(blank, `window.facts ?? null`), 10_000, "its facts").catch(() => null) : null;
  check("S6 an empty window.open() got a real window, which the page then sent to B, opener intact", !!blankFacts && blankFacts.opener === true && (await popupsOn(m, `${B}/auth?blank=1`)).length === 1, blankFacts);
  check("S6 …and the pane was not blanked", (await evalIn(pane, `location.href`)) === `${A}/`, await evalIn(pane, `location.href`));
  if (blank) { await clickIn(blank, "#ada"); blank.close(); }
  await until(async () => (await popupsOn(m, B)).length === 0, 10_000, "the second popup gone").catch(() => {});

  /* ── S1 again, with no opener: a window Electron makes itself, from the pane's webPreferences ── */
  await clickIn(pane, "#noopener");
  const lone = await attachTo(`${B}/auth?noopener=1`, "the noopener popup").catch(() => null);
  const loneFacts = lone ? await until(() => evalIn(lone, `window.facts ?? null`), 10_000, "its facts").catch(() => null) : null;
  const loneAsk = requests.find((r) => r.origin === B && r.path === "/auth" && r !== authAsk);
  const [loneWin] = await popupsOn(m, `${B}/auth?noopener=1`);
  check("S1 a noopener popup is a child window too, in the pane's jar (not the app's) and as Realm's user agent",
    !!loneWin && loneWin.parent === realm.id && loneFacts?.opener === false && loneFacts.cookie.includes("jar=pane-a") && realmAgent(loneFacts.ua) && realmAgent(loneAsk?.ua),
    { win: loneWin, facts: loneFacts, wire: loneAsk?.ua });
  // Closed on a timer: a `window.close()` inside the evaluate takes the target down before it can answer.
  if (lone) { await evalIn(lone, `(() => { setTimeout(() => window.close(), 50); return true; })()`).catch(() => {}); lone.close(); }
  await until(async () => (await popupsOn(m, B)).length === 0, 10_000, "the noopener popup gone").catch(() => {});

  // Not a check: whether Electron opens a popup with no click behind it. It has no popup blocker of its
  // own, which is what POPUP_LIMIT bounds.
  await evalIn(pane, `(() => { window.__probe = window.open("${B}/docs?probe=1", "probe", "width=300,height=300"); return true; })()`);
  await sleep(1000);
  note("a window.open with no click behind it opened a window", (await popupsOn(m, `${B}/docs?probe=1`)).length === 1);
  await evalIn(pane, `(() => { window.__probe?.close(); return true; })()`);
  await until(async () => (await popupsOn(m, B)).length === 0, 5_000, "the probe gone").catch(() => {});

  /* ── S7: Google's own sign-in, as far as the first step ───────────────────────────────────── */
  await clickIn(pane, "#google");
  const google = await attachTo("https://accounts.google.com/", "Google's popup").catch(() => null);
  if (!google) check("S7 Google's sign-in opened in a popup", false, await windows(m));
  else {
    const seen = await until(async () => {
      const t = await evalIn(google, `document.readyState === "complete" ? (document.body?.innerText ?? "") : ""`).catch(() => "");
      return t.length > 40 ? t : null;
    }, 30_000, "Google's page").catch(() => "");
    const gwin = (await windows(m)).find((w) => w.parent !== null && w.url.startsWith("https://accounts.google.com/"));
    note("Google's popup", { url: gwin?.url?.slice(0, 120), title: gwin?.title, text: seen.slice(0, 300) });
    const googleAgent = await evalIn(google, `navigator.userAgent`);
    check("S7 Google's sign-in loaded in a child window of Realm, with its opener, and no 'browser may not be secure' refusal",
      !!gwin && gwin.parent === realm.id && /Sign in|Choose an account/i.test(seen) && !/not be secure|Couldn.t sign you in/i.test(seen) && (await evalIn(google, `window.opener !== null`)), { id: gwin?.id, parent: gwin?.parent, title: gwin?.title });
    check("S7 …and Google's page sees Realm's user agent", realmAgent(googleAgent), googleAgent);
    await pageShot(google, "s7-google-popup");
    google.close(); // the CDP link only: the popup stays open for S8 to close with the pane
  }

  /* ── S8: closing the pane closes its popups ─────────────────────────────────────────────────── */
  await clickIn(pane, "#signin");
  await until(async () => (await popupsOn(m, `${B}/auth`)).length === 1, 10_000, "a popup to close");
  const open = (await windows(m)).filter((w) => w.parent !== null);
  note("open before the pane closes", open.map((w) => w.url.slice(0, 60)));
  pane.close();
  // What every close of a browser calls (store.ts `closeFromLayout` → `destroyBrowserView`): the
  // panel bar's ×, ⌘W, the sidebar row, archive and delete.
  await evalIn(c, `(async () => { await window.realm.browser.destroy(${JSON.stringify(browserId)}); return true; })()`);
  await until(async () => (await windows(m)).every((w) => w.parent === null), 10_000, "the popups gone").catch(() => {});
  const closed = await windows(m);
  check("S8 closing the pane closed every popup it had open — Google's and B's", open.length === 2 && closed.every((w) => w.parent === null) && closed.every((w) => w.views.every((u) => !u.startsWith(A))),
    closed.map((w) => ({ url: w.url.slice(0, 60), parent: w.parent, views: w.views })));
  c.close(); m.close();
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(p);
  await new Promise((r) => (siteA ? siteA.close(() => r()) : r()));
  await new Promise((r) => (siteB ? siteB.close(() => r()) : r()));
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
