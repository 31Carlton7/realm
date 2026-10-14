/**
 * Live check for signing in to an MCP server that issues no client on the fly
 * (run: node apps/desktop/scripts/github-mcp-signin-live.mjs, after `pnpm build`).
 *
 * GitHub's MCP server has no registration endpoint, so Connect used to end in a toast asking for a
 * client id and secret. This boots the built app on a scratch home with a fake `gh` (`REALM_GH`) and
 * a local MCP server that takes only one bearer token and offers no registration, then:
 *
 *   - Connect on that server opens the sheet of other ways in (a token, an app of your own);
 *   - a wrong token connects, then the server's 401 flags the row; Reconnect with the right one and
 *     its tools list through the hub, the server having seen exactly that bearer;
 *   - Connect on the GitHub card with gh signed out opens GitHub's sheet — the CLI says what to run,
 *     there is no device-flow button (no client id) — without a single request to GitHub;
 *   - gh signed in, Check again, Sign in with the GitHub CLI: the card reads Connected.
 *
 * Every session is the fake agent and the window is the unfocusable scratch window. Nothing here
 * reaches github.com or api.githubcopilot.com: the GitHub row is switched off in the space before it
 * is given a token, so no session's gateway ever dials it. Ports are env-overridable.
 */
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9234), SERVER_PORT = Number(process.env.REALM_PORT ?? 8794);
const verify = process.env.LIVE_OUT ?? path.resolve(repoRoot, "../.verify/github-mcp-signin-live");
const scratch = path.join(verify, `run-${Date.now()}`);
const shots = path.join(verify, "shots");
const GOOD = "live-good-token-0123456789";
let electron = null;
let fake = null;
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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return { ws, ready, pending, next: () => ++id };
}
function cdp(wsUrl) {
  const s = socket(wsUrl);
  return { ready: s.ready, close: () => s.ws.close(),
    send: (method, params) => new Promise((res, rej) => { const i = s.next(); s.pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); s.ws.send(js({ id: i, method, params })); }) };
}
function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return { ready: s.ready, close: () => s.ws.close(),
    call: (method, params) => new Promise((res, rej) => { const i = String(s.next()); s.pending.set(i, (m) => (m.ok ? res(m.result) : rej(new Error(`${method}: ${m.error?.message}`)))); s.ws.send(js({ id: i, method, params })); }) };
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
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + js(detail) : ""}`);
};

/**
 * The MCP server under test: protected-resource and authorization-server metadata with NO
 * registration endpoint (GitHub's shape), and a streamable-HTTP endpoint that answers 401 to any
 * bearer but `GOOD`. JSON responses only — the SDK client takes those as readily as a stream.
 */
function fakeServer() {
  const seen = [];
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(body === undefined ? "" : js(body)); };
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url.startsWith("/.well-known/oauth-authorization-server")) {
      return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    }
    if (req.url.startsWith("/mcp") && req.method === "POST") {
      const auth = req.headers.authorization ?? "";
      seen.push(auth === `Bearer ${GOOD}` ? "good" : auth ? "wrong" : "none");
      if (auth !== `Bearer ${GOOD}`) return send(401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return send(202);
        if (msg.method === "initialize") return send(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "bearer-only", version: "1.0.0" } } });
        if (msg.method === "tools/list") return send(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "whoami", description: "Who the bearer is.", inputSchema: { type: "object" } }] } });
        return send(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
      });
      return;
    }
    if (req.url.startsWith("/mcp") && req.method === "DELETE") return send(200);
    send(404, { error: "not_found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

/** Theme by the palette, as the other live scripts do. */
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
async function shoot(c, name, selector, pad = 16) {
  const box = await evalIn(c, `(() => { const el = [...document.querySelectorAll(${js(selector)})].at(-1); if (!el) return null;
    el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}), width: r.width + ${pad * 2}, height: r.height + ${pad * 2} }; })()`);
  if (!box) throw new Error(`nothing to shoot for ${selector}`);
  await sleep(250);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}
async function bothFaces(c, name, selector) {
  const dark = await shoot(c, `${name}-dark`, selector);
  await setTheme(c, "light");
  const light = await shoot(c, `${name}-light`, selector);
  await setTheme(c, "dark");
  return { dark, light };
}

const SHEET = `.sheet[role=dialog]`;
const sheetText = (c) => evalIn(c, `document.querySelector(${js(SHEET)})?.textContent ?? null`);
const click = (c, scope, label) => evalIn(c, `(() => { const b = [...document.querySelectorAll(${js(`${scope} button`)})].find((x) => x.textContent.trim() === ${js(label)});
  if (!b) throw new Error("no button " + ${js(label)}); b.click(); return true; })()`);
const type = (c, selector, value) => evalIn(c, `(() => { const input = document.querySelector(${js(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${js(value)});
  input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(path.join(scratch, "bin"), { recursive: true });
  fake = await fakeServer();

  // The fake gh: signed out until the state file holds a token, which it prints the way gh does.
  const ghState = path.join(scratch, "gh-token");
  fs.writeFileSync(path.join(scratch, "bin/gh"), `#!/bin/sh\nif [ -s ${js(ghState)} ]; then cat ${js(ghState)}; exit 0; fi\necho "no oauth token found for github.com" >&2\nexit 1\n`, { mode: 0o755 });

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env,
      // Named outright: main puts the login shell's PATH first, which would find the real gh.
      REALM_GH: path.join(scratch, "bin/gh"),
      REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 180_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 120_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 90_000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await evalIn(c, `(() => { const root = document.documentElement; root.removeAttribute("data-window-inactive");
    new MutationObserver(() => root.hasAttribute("data-window-inactive") && root.removeAttribute("data-window-inactive")).observe(root, { attributes: true });
    document.getElementById("live-scratch-banner")?.remove(); return true; })()`);
  // A sign-in page must not really open: record where it would have gone.
  await evalIn(c, `(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; return true; })()`);

  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  // Onboarding's session would be a real, billed engine: it goes on the fake before anything else.
  for (const s of await api.call("sessions.list", { spaceId: space.id })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const bearer = await api.call("mcp.add", { spaceId: space.id, name: "bearer-only", transport: "http", url: fake.url });
  const servers = async () => (await api.call("mcp.list", { spaceId: space.id })).servers;

  await evalIn(c, `(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Connections" || b.title?.startsWith("Connections")).click(); return true; })()`);
  await until(() => evalIn(c, `[...document.querySelectorAll(".mcp-row")].some((r) => r.textContent.includes("bearer-only"))`), 15_000, "the bearer-only row");
  await setTheme(c, "dark");
  const ROW = `.mcp-row:has(.env-name)`;
  const openEditor = () => evalIn(c, `(() => { const r = [...document.querySelectorAll(${js(ROW)})].find((x) => x.querySelector(".env-name").textContent === "bearer-only");
    [...r.querySelectorAll("button")].find((b) => b.textContent === "Edit").click(); return true; })()`);

  // ── 1. Connect on a server with no registration opens the ways in, not a toast ────────────────
  await openEditor();
  await until(() => evalIn(c, `[...document.querySelectorAll(".mcp-form button")].some((b) => b.textContent === "Connect via OAuth instead")`), 5000, "the OAuth offer");
  await click(c, ".mcp-form", "Connect via OAuth instead");
  await until(() => sheetText(c), 10_000, "the sign-in sheet");
  const generic = await sheetText(c);
  check("Connect opens the sheet, saying the server issues no client", generic.includes("bearer-only issues no client to apps it has not met"), generic.slice(0, 160));
  check("…offering a token and an app of your own, and no CLI for a server Realm does not know", generic.includes("Connect with this token") && generic.includes("Use an OAuth app of your own") && !generic.includes("GitHub CLI"));
  check("…and no error toast", (await evalIn(c, `document.querySelectorAll(".toast").length`)) === 0);
  const genericShots = await bothFaces(c, "01-sheet-generic", SHEET);

  // ── 2. A wrong token connects, then the 401 flags it; the right one lists tools ──────────────
  await type(c, `${SHEET} input[aria-label="Token"]`, "live-wrong-token-999");
  await click(c, SHEET, "Connect with this token");
  await until(async () => (await servers()).find((s) => s.id === bearer.id)?.oauthVia === "token" || null, 8000, "the token stored");
  const listed = await servers();
  check("the listed server carries no token value", !js(listed).includes("live-wrong-token-999"));
  const wrong = await api.call("mcp.tools.list", { id: bearer.id }).catch((e) => ({ error: e.message }));
  check("the server's 401 to a wrong token comes back as an error", !!wrong.error || (Array.isArray(wrong.tools) && wrong.tools.length === 0), wrong);
  check("…and the token stays out of the error", !js(wrong).includes("live-wrong-token-999"));
  await until(async () => (await servers()).find((s) => s.id === bearer.id)?.oauthStatus === "reconnect_needed" || null, 8000, "reconnect_needed");
  check("a pasted token the server refuses flags the row for reauth", true);
  await until(() => evalIn(c, `[...document.querySelectorAll(".mcp-reauth-badge")].length > 0 || null`), 8000, "the reauth badge");
  await evalIn(c, `(() => { const b = [...document.querySelectorAll(".mcp-form button")].find((x) => x.textContent === "Reconnect"); if (!b) return null; b.click(); return true; })()`)
    .then(async (r) => { if (!r) { await openEditor(); await until(() => evalIn(c, `[...document.querySelectorAll(".mcp-form button")].some((b) => b.textContent === "Reconnect") || null`), 5000, "Reconnect"); await click(c, ".mcp-form", "Reconnect"); } });
  await until(() => sheetText(c), 10_000, "the sheet again");
  await type(c, `${SHEET} input[aria-label="Token"]`, GOOD);
  await click(c, SHEET, "Connect with this token");
  await until(async () => (await servers()).find((s) => s.id === bearer.id)?.oauthStatus === "connected" || null, 8000, "connected");
  const tools = await api.call("mcp.tools.list", { id: bearer.id });
  check("with the right token the hub lists the server's tools", tools.tools?.some((t) => t.name === "whoami"), tools);
  check("…and the server saw exactly that bearer", fake.seen.at(-1) === "good", fake.seen);
  await until(() => evalIn(c, `[...document.querySelectorAll(".mcp-form .muted")].some((p) => p.textContent === "Connected with a pasted token.") || null`), 8000, "the connected line");
  const connectedRow = await bothFaces(c, "02-row-connected-with-token", `.mcp-row:has(.mcp-form)`);

  // ── 3. The GitHub card, gh signed out: GitHub's sheet, and no request to GitHub ──────────────
  await evalIn(c, `(() => { const b = [...document.querySelectorAll(".mcp-form button")].find((x) => x.textContent === "Cancel"); b?.click(); return true; })()`);
  const card = `[...document.querySelectorAll(".market-card")].find((x) => x.querySelector(".market-name").textContent === "GitHub")`;
  await evalIn(c, `(() => { [...${card}.querySelectorAll("button")].find((b) => b.textContent === "Connect").click(); return true; })()`);
  await until(async () => ((await sheetText(c)) ?? "").includes("GitHub CLI") || null, 15_000, "GitHub's sheet");
  const gh = await sheetText(c);
  check("GitHub's sheet is titled for GitHub and says the CLI is signed out", (await evalIn(c, `document.querySelector(${js(SHEET)}).getAttribute("aria-label")`)) === "Connect GitHub" && gh.includes("gh auth login"), gh.slice(0, 200));
  check("…with no device-flow button while Realm has no client id", !gh.includes("Sign in with GitHub"));
  check("…and a link to create a token with the scopes the server wants", await evalIn(c, `[...document.querySelectorAll(${js(`${SHEET} a`)})].some((a) => a.href.startsWith("https://github.com/settings/tokens/new") && a.textContent === "Create one on GitHub")`));
  check("…and no browser was opened", (await evalIn(c, `window.__opened.length`)) === 0);
  const githubRow = (await servers()).find((s) => s.name === "realm-github");
  // The row is now this space's; switch it off before it holds a token, so nothing dials GitHub.
  await api.call("mcp.setEnabled", { spaceId: space.id, id: githubRow.id, enabled: false });
  const githubShots = await bothFaces(c, "03-sheet-github-signed-out", SHEET);

  // ── 4. gh signs in; Check again; Sign in with the GitHub CLI ─────────────────────────────────
  fs.writeFileSync(ghState, "gho_live_fake_token_abcdef\n");
  await click(c, SHEET, "Check again");
  await until(() => evalIn(c, `[...document.querySelectorAll(${js(`${SHEET} button`)})].some((b) => b.textContent === "Sign in with the GitHub CLI" && b.classList.contains("primary")) || null`), 10_000, "the CLI button");
  check("signed in, the CLI is the primary way in", true);
  const readyShots = await bothFaces(c, "04-sheet-github-cli-ready", SHEET);
  await click(c, SHEET, "Sign in with the GitHub CLI");
  await until(() => evalIn(c, `!document.querySelector(${js(SHEET)}) || null`), 10_000, "the sheet to close");
  await until(async () => (await servers()).find((s) => s.name === "realm-github")?.oauthVia === "cli" || null, 8000, "connected via the CLI");
  await until(() => evalIn(c, `(${card}).dataset.state === "connected" || null`), 8000, "the card to read Connected");
  check("the GitHub card reads Connected, through the CLI's sign-in", true);
  const cardShots = await bothFaces(c, "05-card-github-connected", `.market-grid`);

  console.log(js({ shots, genericShots, connectedRow, githubShots, readyShots, cardShots }, null, 1));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  api.close();
  c.close();
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => {
    electron?.kill("SIGKILL");
    fake?.server.close();
    await stopDaemons(path.join(scratch, "home"));
    try { execFileSync("bash", ["-c", `lsof -nP -tiTCP:${SERVER_PORT},${CDP_PORT} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]); } catch { /* nothing left */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
