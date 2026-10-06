/**
 * Live check: first run's sign-ins, end to end (run with: pnpm build && node apps/desktop/scripts/onboarding-signin-live.mjs)
 *
 * Boots the BUILT app on a scratch home with stub `claude` and `codex` binaries in place of the real
 * ones, and drives both cards the way a person would: Sign in with Claude → the card asks for the
 * code the sign-in page shows → the code goes in → Signed in; Sign in with ChatGPT → finish in the
 * browser → the CLI's callback lands → Signed in. No space exists at any point, which is the whole
 * reason `agentSignIn.*` is not `signin.start`.
 *
 * Nothing real is signed in or out: the stubs are reached through REALM_CLAUDE_BIN/REALM_CODEX_BIN,
 * and the last check proves it was the stubs' marker files that changed. Ports: env-overridable.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9383), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8949);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-onboarding-signin-"));
let electron = null;
let said = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(150);
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

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/* Stub CLIs, pointed at through the same REALM_*_BIN overrides the probe and the sign-in honour, so
   nothing here can reach the real `claude` or `codex` — a real login would change the owner's own
   credentials. Each answers the probe's two questions (version, signed in?) from a marker file, and
   its login draws what the real one draws: Claude's a URL and a prompt for the page's code, Codex's
   a URL and a callback that lands a moment later. Neither opens a browser. */
const STUB_DIR = path.join(scratch, "stubs");
fs.mkdirSync(STUB_DIR, { recursive: true });
const CODE = "LIVE-CODE-1234";
const stub = (name, body) => { const p = path.join(STUB_DIR, name); fs.writeFileSync(p, `#!/bin/bash\nM="${STUB_DIR}/${name}-signed-in"\n${body}\n`); fs.chmodSync(p, 0o755); return p; };
const claudeBin = stub("claude", `case "$1 $2" in
  "--version "*) echo "2.1.999 (Claude Code)";;
  "auth status") if [ -f "$M" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; exit 1; fi;;
  "auth login") echo "Opening browser to sign in..."; echo "Browser didn't open? Use the url below to sign in:"; echo ""
    echo "https://claude.ai/oauth/authorize?code=true&client_id=stub-live&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=live"
    echo ""; printf "Paste code here if prompted > "; read -r code
    if [ "$code" = "${CODE}" ]; then touch "$M"; echo "Login successful."; exit 0; else echo "Invalid code: $code"; exit 1; fi;;
  *) echo "stub claude: $*"; exit 0;;
esac`);
const codexBin = stub("codex", `case "$1 $2" in
  "--version "*) echo "codex-cli 0.0.1";;
  "login status") if [ -f "$M" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi;;
  "login ") echo "Starting local login server on http://localhost:1455."; echo "If your browser did not open, navigate to this URL to authenticate:"; echo ""
    echo "https://auth.openai.com/oauth/authorize?response_type=code&client_id=stub-live&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=live"
    sleep 3; touch "$M"; echo "Successfully logged in"; exit 0;;
  *) echo "stub codex: $*"; exit 1;;
esac`);

const cardState = (name) => `(() => { const c = [...document.querySelectorAll('.agent-card')].find((e) => e.querySelector('.agent-card-name')?.textContent === ${JSON.stringify(name)});
  return c ? c.querySelector('.agent-card-foot').textContent.trim() : null; })()`;
/** Why a card says its sign-in failed — the note's title carries the CLI's own last words — and what
 *  the error bar says, if anything: the two places a failure here is ever explained. */
const why = (name) => `(() => { const c = [...document.querySelectorAll('.agent-card')].find((e) => e.querySelector('.agent-card-name')?.textContent === ${JSON.stringify(name)});
  return { note: c?.querySelector('.agent-card-note[data-tone=danger]')?.title ?? null, error: document.querySelector('.error-bar')?.textContent ?? null }; })()`;
const press = (name, label) => `(() => { const c = [...document.querySelectorAll('.agent-card')].find((e) => e.querySelector('.agent-card-name')?.textContent === ${JSON.stringify(name)});
  const b = c && [...c.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} in use`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  electron = spawn(path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1",
      REALM_CLAUDE_BIN: claudeBin, REALM_CODEX_BIN: codexBin,
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"] });
  // Kept, not printed: the server's stderr is Electron's, and a failed run is unexplained without it.
  for (const stream of [electron.stdout, electron.stderr]) stream.on("data", (b) => { said = (said + b).slice(-512 * 1024); });
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const t = await until(async () => (await targets()).find((x) => x.type === "page" && x.url.startsWith("file://")), 30000, "renderer");
  const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 860, deviceScaleFactor: 2, mobile: false });
  await until(() => evalIn(c, `!!document.querySelector('.onboarding')`), 20000, "onboarding");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const OUT = process.env.LIVE_OUT ?? os.tmpdir();
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (name) => { const png = await c.send("Page.captureScreenshot", { format: "png" }); const f = path.join(OUT, `signin-${name}.png`); fs.writeFileSync(f, Buffer.from(png.data, "base64")); console.log(`SCREENSHOT ${f}`); };

  // Both stubs read as installed and signed out.
  const out = await until(async () => {
    const a = await evalIn(c, cardState("Claude")), b = await evalIn(c, cardState("Codex"));
    return a && b && !a.includes("Checking") && !b.includes("Checking") ? { claude: a, codex: b } : null;
  }, 40000, "probe");
  check("both cards offer their own sign-in when the CLI is signed out", out.claude === "Sign in with Claude" && out.codex === "Sign in with ChatGPT", out);
  await shot("signed-out");

  // Claude: the page's URL, a field for its code, then signed in.
  check("Sign in with Claude starts", await evalIn(c, press("Claude", "Sign in with Claude")));
  const asking = await until(async () => { const s = await evalIn(c, cardState("Claude")); return s?.includes("If the page shows a code") ? s : null; }, 20000, "Claude asks for the code");
  check("Claude: the card sends you to the browser, takes a code if the page shows one, and offers the page again",
    asking.includes("Finish signing in in your browser") && asking.includes("Open the page again"), asking);
  await shot("claude-code");
  await evalIn(c, `(() => { const i = document.querySelector('.agent-code'); i.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(CODE)});
    i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  const claudeDone = await until(async () => { const s = await evalIn(c, cardState("Claude")); return s === "Signed in" ? s : null; }, 20000, "Claude signed in").catch(() => null);
  check("Claude: the code goes in, the CLI finishes, and the card says Signed in", claudeDone === "Signed in", { state: await evalIn(c, cardState("Claude")), why: await evalIn(c, why("Claude")) });
  check("…and Enter in the code field did not start the space", await evalIn(c, `!!document.querySelector('.onboarding')`));

  // Codex: the browser step, then the callback lands on its own.
  check("Sign in with ChatGPT starts", await evalIn(c, press("Codex", "Sign in with ChatGPT")));
  const browser = await until(async () => { const s = await evalIn(c, cardState("Codex")); return s?.includes("browser") ? s : null; }, 20000, "Codex browser step").catch(() => null);
  check("Codex: the card says to finish in the browser", browser !== null, { state: browser, why: await evalIn(c, why("Codex")) });
  await shot("codex-browser");
  const codexDone = await until(async () => { const s = await evalIn(c, cardState("Codex")); return s === "Signed in" ? s : null; }, 30000, "Codex signed in").catch(() => null);
  check("Codex: when the CLI's callback lands, the card says Signed in", codexDone === "Signed in", { state: await evalIn(c, cardState("Codex")) });
  check("the stubs, not the real CLIs, were signed in", fs.existsSync(path.join(STUB_DIR, "claude-signed-in")) && fs.existsSync(path.join(STUB_DIR, "codex-signed-in")));
  await shot("signed-in");
  c.close();
}
/**
 * The server is a SECOND Electron, spawned by the one this started, and killing the parent leaves it
 * holding REALM_PORT — an earlier run's sat on both ports for forty minutes. So teardown clears the
 * two ports by owner rather than by pid, which also catches an orphan of an interrupted run; the run
 * refused to start while either was taken, so nothing else can be on them.
 */
function reap() {
  electron?.kill("SIGKILL");
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
/** A failed run keeps the server's log, which the scratch home is about to take with it. */
function keepLog() {
  const logs = path.join(scratch, "home", "logs"), out = process.env.LIVE_OUT ?? os.tmpdir();
  fs.writeFileSync(path.join(out, "signin-electron.log"), said);
  console.log(`LOG ${path.join(out, "signin-electron.log")}`);
  for (const f of fs.existsSync(logs) ? fs.readdirSync(logs) : []) {
    fs.copyFileSync(path.join(logs, f), path.join(out, `signin-${f}`));
    console.log(`LOG ${path.join(out, `signin-${f}`)}`);
  }
}
main().catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => { if (process.exitCode) keepLog(); reap(); process.exit(process.exitCode ?? 0); });
for (const sig of ["SIGINT", "SIGTERM", "SIGALRM"]) process.on(sig, () => { reap(); process.exit(1); });
