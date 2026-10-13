/**
 * Live check: Settings ▸ Sign-ins ▸ Unlock, in the BUILT app
 * (run with: pnpm build && node apps/desktop/scripts/unlock-policy-settings-live.mjs)
 *
 * Boots the built app on a scratch REALM_HOME and, through the real window, the real preload and the
 * real main-process store:
 *
 *   1. The profile starts on Touch ID.
 *   2. "Without asking" opens the warning instead of applying; Turn on asks macOS (the user's password
 *      stood in for by a helper that answers yes and logs the ask), and the sealed policy lands in
 *      secrets.json with an audit line.
 *   3. "Ask for Touch ID again" turns it off with no prompt, and the audit says so.
 *   4. The rows and the warning, captured dark and light.
 *
 * `--use-mock-keychain`, so no Keychain item is read or written. Ports: 8807 (server), 9247 (CDP).
 * Nothing is billed: no message is sent to any session.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9247);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8807);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-unlock-settings-live-"));
const home = path.join(scratch, "home");
const shots = path.join(os.tmpdir(), "realm-unlock-settings-shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

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
function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return { ws, ready, pending, next: () => ++id };
}
function cdp(url) {
  const s = socket(url);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
  };
}
function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function shoot(c, tag, selector) {
  await sleep(700); // past a sheet's entrance, which a capture would otherwise catch half-faded
  const clip = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left - 10), y: Math.max(0, r.top - 10), width: r.width + 20, height: r.height + 20, scale: 2 }; })()`);
  if (!clip) throw new Error(`nothing to capture at ${selector}`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip });
  const file = path.join(shots, `${tag}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${file}`);
}
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}

const ownerLog = path.join(scratch, "owner-asks.log");
const auditLines = () => {
  const f = path.join(home, "logs/credential-audit.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const ownerAsks = () => (fs.existsSync(ownerLog) ? fs.readFileSync(ownerLog, "utf8").trim().split("\n").filter(Boolean) : []);

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  // The app's path is this scratch dir (the wrapper's), so `device-owner.ts` finds the stand-in below:
  // the person typing their login password, answering yes and leaving a line saying it was asked.
  fs.mkdirSync(path.join(scratch, "native/bin"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "native/bin/deviceowner"), `#!/bin/bash\n[ "$1" = "can" ] && { echo yes; exit 0; }\necho "$2" >> ${JSON.stringify(ownerLog)}\nexit 0\n`, { mode: 0o755 });
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.commandLine.appendSwitch("use-mock-keychain");', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env, REALM_HOME: home, REALM_HTML_MENUS: "1", REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1",
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
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Lab");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const openSettings = `(async () => {
  if (!document.querySelector(".settings-page-pane")) {
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
  }
  return !!document.querySelector(".settings-page-pane");
})()`;
const page = (value) => `(async () => { document.querySelector('.settings-rail input[value="${value}"]').click(); await new Promise((r) => setTimeout(r, 400)); return true; })()`;
const radio = (label) => `(() => { const l = [...document.querySelectorAll('fieldset[aria-label="Unlock sign-ins with"] label')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); l.querySelector('input').click(); return true; })()`;
const checked = `(() => document.querySelector('fieldset[aria-label="Unlock sign-ins with"] input:checked')?.value ?? null)()`;
const theme = (mode) => `(async () => { document.querySelector('input[name="settings-theme"][value="${mode}"]').click(); await new Promise((r) => setTimeout(r, 500)); return true; })()`;

async function main() {
  const c = await boot();
  await until(() => evalIn(c, openSettings), 20_000, "settings");
  await evalIn(c, page("signins"));
  await until(() => evalIn(c, checked), 10_000, "unlock policy loaded");
  check("the profile starts on Touch ID", (await evalIn(c, checked)) === "touch-id", await evalIn(c, checked));
  check("the setting is marked as no place for an agent", await evalIn(c, `!!document.querySelector('[data-setting="unlock-policy"]').closest('[data-no-agent]')`), null);
  await shoot(c, "security-touch-id-dark", ".signins .settings-group");

  await evalIn(c, radio("Without asking"));
  await until(() => evalIn(c, `!!document.querySelector('.unlock-confirm')`), 5_000, "warning sheet");
  check("Without asking opens the warning instead of applying", (await evalIn(c, checked)) === "touch-id" && ownerAsks().length === 0, { asks: ownerAsks() });
  await shoot(c, "warning-dark", ".sheet");
  await evalIn(c, `(() => { [...document.querySelectorAll('.unlock-confirm button')].find((b) => /^Turn on for/.test(b.textContent)).click(); return true; })()`);
  await until(async () => (await evalIn(c, checked)) === "unattended", 10_000, "unattended");
  check("Turn on asked macOS to confirm the user first", ownerAsks().length === 1 && /without asking/.test(ownerAsks()[0]), ownerAsks());
  const sealed = JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8")).unlock ?? {};
  check("the policy is in secrets.json, sealed, under the profile's scope", Object.keys(sealed).length === 1 && /^profile:/.test(Object.keys(sealed)[0]) && !/unattended/.test(JSON.stringify(sealed)), Object.keys(sealed));
  check("the audit has the change", auditLines().some((l) => l.kind === "unlock-policy" && l.to === "unattended" && l.outcome === "set"), auditLines());
  await sleep(300);
  await shoot(c, "security-unattended-dark", ".signins .settings-group");

  await evalIn(c, page("appearance"));
  await evalIn(c, theme("light"));
  await evalIn(c, page("signins"));
  await until(async () => (await evalIn(c, checked)) === "unattended", 5_000, "unattended after theme");
  await shoot(c, "security-unattended-light", ".signins .settings-group");

  await evalIn(c, `(() => { [...document.querySelectorAll('.unlock-unattended-note button')].find((b) => b.textContent.includes('Ask for Touch ID again')).click(); return true; })()`);
  await until(async () => (await evalIn(c, checked)) === "touch-id", 5_000, "revoked");
  check("Ask for Touch ID again turned it off with no prompt", ownerAsks().length === 1, ownerAsks());
  check("the audit has the revocation", auditLines().some((l) => l.kind === "unlock-policy" && l.from === "unattended" && l.to === "touch-id" && l.outcome === "set"), null);
  check("secrets.json no longer holds a policy", Object.keys(JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8")).unlock ?? {}).length === 0, null);
  await shoot(c, "security-touch-id-light", ".signins .settings-group");

  await evalIn(c, radio("Without asking"));
  await until(() => evalIn(c, `!!document.querySelector('.unlock-confirm')`), 5_000, "warning sheet (light)");
  await shoot(c, "warning-light", ".sheet");
  await evalIn(c, `(() => { [...document.querySelectorAll('.unlock-confirm button')].find((b) => b.textContent === 'Cancel').click(); return true; })()`);
  await sleep(300);
  check("Cancel leaves Touch ID in place and asks nothing", (await evalIn(c, checked)) === "touch-id" && ownerAsks().length === 1, null);

  await evalIn(c, radio("Once per session"));
  await until(async () => (await evalIn(c, checked)) === "session", 5_000, "session");
  check("Once per session asks macOS and shows its length", ownerAsks().length === 2 && await evalIn(c, `!!document.querySelector('fieldset[aria-label="Session length"] input[value="8"]:checked')`), ownerAsks());
  await shoot(c, "security-session-light", ".signins .settings-group");
  await evalIn(c, page("appearance"));
  await evalIn(c, theme("dark"));
  await evalIn(c, page("signins"));
  await until(async () => (await evalIn(c, checked)) === "session", 5_000, "session after theme");
  await shoot(c, "security-session-dark", ".signins .settings-group");
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
