/**
 * Live check for a window outliving its server (run with: pnpm build && node apps/desktop/scripts/daemon-reconnect-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME with the server as a daemon (REALM_DAEMON=1) on a port
 * the OS picks — what a packaged Realm does, and the only way a respawned server lands somewhere new.
 * Everything runs on the scripted agent; nothing is billed.
 *
 *   R1  kill -9 the daemon: the window shows the quiet reconnecting line, never an error wall;
 *   R2  the supervisor starts another on a new port with a new token, and the window reaches it by
 *       itself — no reload: the draft typed before the kill, the open session and a page marker are
 *       all still there;
 *   R3  the window sends on the new server, and the fake agent's reply arrives in it;
 *   R4  main re-registered on the new server: Realm Mobile is not `locked`, and a window is attached;
 *   R5  a crash loop: the supervisor gives up, the banner offers "Restart Realm's server", and the
 *       press brings the server and the window back;
 *   R6  a secrets.json Realm cannot read is kept aside, and Settings ▸ Passwords says so — dark and
 *       light — with Show in Finder (stood in for: nothing opens on the screen) and a Dismiss that holds.
 *
 * Ports: LIVE_CDP_PORT (9262). The server's port is the OS's pick; every server killed or stopped is
 * one whose daemon.json is in this scratch home and whose command line runs this worktree's bundle.
 * Screenshots go to LIVE_OUT.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonState, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9262);
const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-reconnect-live");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-reconnect-live-"));
const HOME = path.join(scratch, "home");
const revealLog = path.join(scratch, "reveals.log");
const DRAFT = "A draft typed before the server died";
const UNREADABLE = "{ \"credentials\": [ cut off by a crash";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seenPids = new Set();
let electron = null;
fs.mkdirSync(OUT_DIR, { recursive: true });

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`);
    await sleep(100);
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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
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

const js = JSON.stringify;
async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const setInput = (c, selector, value) => evalIn(c, `(() => {
  const el = document.querySelector(${js(selector)}); if (!el) throw new Error("no " + ${js(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${js(value)});
  el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const bannerText = (c) => evalIn(c, `document.querySelector(".conn-banner")?.textContent ?? null`);

/** This scratch home's server, and only if its command line runs this worktree's bundle. */
function ourDaemon() {
  const state = daemonState(HOME);
  if (!state) return null;
  let command = "";
  try { command = execFileSync("ps", ["-o", "command=", "-p", String(state.pid)], { encoding: "utf8" }); } catch { return null; }
  if (!command.includes(repoRoot)) throw new Error(`pid ${state.pid} in ${HOME}/daemon.json is not this worktree's server: ${command.trim()}`);
  seenPids.add(state.pid);
  return state;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function shot(c, tag) {
  // The scratch banner sits where the connection banner does; put it at the foot for the picture.
  await evalIn(c, `(() => { const b = document.getElementById('live-scratch-banner'); if (b) b.style.inset = 'auto 0 0 0'; return true; })()`);
  await sleep(350);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUT_DIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function setTheme(c, mode) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  const label = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
  await setInput(c, ".palette input", label);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.querySelector(".palette-label")?.textContent.trim() === ${js(label)});
    if (!hit) return null; hit.click(); return true; })()`), 4000, label);
  await until(() => evalIn(c, `document.documentElement.getAttribute("data-mode") === ${js(mode)}`), 4000, `mode ${mode}`);
}

async function main() {
  if (!(await portFree(CDP_PORT))) throw new Error(`port ${CDP_PORT} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  // R6's file, there before Realm is: what a write cut off by a crash used to leave.
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "secrets.json"), UNREADABLE, { mode: 0o600 });

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app, shell } from "electron";',
    'import fs from "node:fs";',
    // The secret store's keyring: an in-memory keychain, never the login one.
    'app.commandLine.appendSwitch("use-mock-keychain");',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "shell.showItemInFolder = (p) => fs.appendFileSync(process.env.LIVE_REVEAL_LOG, p + '\\n');",
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const env = { ...process.env };
  delete env.REALM_PORT;
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...env, REALM_HOME: HOME, REALM_DEVTOOLS_PORT: String(CDP_PORT), REALM_DAEMON: "1",
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"), REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry, LIVE_REVEAL_LOG: revealLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appLog = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(appLog); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Reconnect");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  const first = await until(async () => ourDaemon(), 20_000, "the first daemon");
  const api1 = rpc(first.port, first.token);
  await api1.ready;
  // Every session here runs on the scripted agent — the onboarding one included.
  for (const s of await api1.call("sessions.listAll", {})) await api1.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const [space] = await api1.call("spaces.list", {});
  const { session } = await api1.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Reconnect check" });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes("Reconnect check"))`), 20_000, "the session's row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Reconnect check")).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer-input')`), 10_000, "its composer");
  await sleep(600);
  await evalIn(c, `(() => { document.querySelector('.composer-input').focus(); return true; })()`);
  await setInput(c, ".composer-input", DRAFT);
  // A reload would lose this; reconnecting must not.
  await evalIn(c, `(() => { window.__beforeTheCrash = ${Date.now()}; window.__banners = []; let last = null;
    setInterval(() => { const t = document.querySelector('.conn-banner')?.textContent ?? null; if (t !== last) { window.__banners.push({ at: Date.now(), text: t }); last = t; } }, 100);
    return true; })()`);
  const lockedBefore = (await api1.call("remote.status", {})).state;
  check("before: Realm Mobile is unlocked (main handed over the key)", lockedBefore !== "locked", { state: lockedBefore });
  await shot(c, "01-before-the-crash");
  api1.close();

  /* ── R1: kill -9 ─────────────────────────────────────────────────────────────────────────── */
  const killedAt = Date.now();
  process.kill(first.pid, "SIGKILL");
  await until(async () => !alive(first.pid), 5000, "the daemon to die");
  const down = await until(() => bannerText(c), 10_000, "the reconnecting line");
  check("R1 the window says it is reconnecting, quietly", /reconnecting|restarting/.test(down), { text: down, tone: await evalIn(c, `document.querySelector('.conn-banner')?.dataset.tone`) });
  await shot(c, "02-reconnecting");
  await until(async () => /restarting/.test((await bannerText(c)) ?? ""), 15_000, "the restarting line").then(() => shot(c, "03-restarting"), () => {});

  /* ── R2: a new server, and the window finds it ───────────────────────────────────────────── */
  const second = await until(async () => { const s = ourDaemon(); return s && s.bootId !== first.bootId ? s : null; }, 40_000, "the respawned daemon");
  check("R2 the respawned server is somewhere new", second.port !== first.port && second.token !== first.token, { before: first.port, after: second.port });
  await until(async () => (await bannerText(c)) === null, 40_000, "the window to reconnect");
  const backAfterMs = Date.now() - killedAt;
  check("R2 the window reconnected by itself", true, { secondsAfterTheKill: Math.round(backAfterMs / 100) / 10 });
  const page = await evalIn(c, `(async () => ({
    marker: window.__beforeTheCrash ?? null,
    draft: document.querySelector('.composer-input')?.value ?? null,
    open: [...document.querySelectorAll('.panel')].some((p) => p.textContent.includes("Reconnect check")),
    endpoint: await window.realm.serverEndpoint(),
    banners: window.__banners.map((b) => ({ s: Math.round((b.at - ${killedAt}) / 100) / 10, text: b.text })),
  }))()`);
  check("R2 no reload: the page is the one from before the crash", page.marker !== null);
  check("R2 the draft survived", page.draft === DRAFT, { draft: page.draft });
  check("R2 the session is still open", page.open);
  check("R2 the window dials the new server", page.endpoint?.port === second.port, page.endpoint && { port: page.endpoint.port });
  console.log(`BANNERS ${js(page.banners)}`);
  await shot(c, "04-reconnected");

  /* ── R3: the window sends on the new server ──────────────────────────────────────────────── */
  const api2 = rpc(second.port, second.token);
  await api2.ready;
  await setInput(c, ".composer-input", "hello after the crash");
  await evalIn(c, `(() => { document.querySelector('.composer-send').click(); return true; })()`);
  const replied = await until(async () => {
    const events = await api2.call("sessions.events", { id: session.id });
    return events.some((e) => e.event.type === "user_message" && e.event.payload.text === "hello after the crash")
      && events.some((e) => e.event.type === "usage") ? events : null;
  }, 30_000, "a turn on the new server");
  check("R3 the window's own send reached the new server and the fake agent answered", !!replied);
  const shown = await until(() => evalIn(c, `[...document.querySelectorAll('.msg-assistant')].length > 0 ? document.querySelectorAll('.msg-assistant').length : null`), 15_000, "the reply in the window");
  check("R3 the reply is in the window", shown > 0, { assistantMessages: shown });
  await shot(c, "05-sent-after-the-crash");

  /* ── R4: main re-registered ──────────────────────────────────────────────────────────────── */
  const remote = await until(async () => { const s = await api2.call("remote.status", {}); return s.state !== "locked" ? s : null; }, 10_000, "Realm Mobile unlocked");
  check("R4 Realm Mobile is not locked on the new server", remote.state !== "locked", { state: remote.state });
  const info = await api2.call("system.info", {});
  check("R4 a host with a window is attached to the new server", info.detachedSince === null && info.bootId === second.bootId);
  api2.close();

  /* ── R5: a server that will not stay up ──────────────────────────────────────────────────── */
  let last = second;
  const kills = [];
  for (;;) {
    process.kill(last.pid, "SIGKILL");
    kills.push(last.pid);
    const outcome = await until(async () => {
      const text = (await bannerText(c)) ?? "";
      if (/keeps failing/.test(text)) return { failed: true };
      const s = ourDaemon();
      return s && s.bootId !== last.bootId && alive(s.pid) ? { next: s } : null;
    }, 60_000, "the next respawn, or the supervisor giving up");
    if (outcome.failed) break;
    last = outcome.next;
  }
  const failedText = await bannerText(c);
  check("R5 after a crash loop the banner stops promising and offers a restart",
    /keeps failing to start/.test(failedText ?? "") && await evalIn(c, `[...document.querySelectorAll('.conn-banner button')].some((b) => b.textContent === "Restart Realm's server")`),
    { text: failedText, kills: kills.length });
  await shot(c, "06-failed-dark");
  await setTheme(c, "light");
  await shot(c, "07-failed-light");
  await setTheme(c, "dark");
  await evalIn(c, `(() => { [...document.querySelectorAll('.conn-banner button')].find((b) => b.textContent === "Restart Realm's server").click(); return true; })()`);
  const restarted = await until(async () => { const s = ourDaemon(); return s && !kills.includes(s.pid) && alive(s.pid) ? s : null; }, 30_000, "the restarted daemon");
  await until(async () => (await bannerText(c)) === null, 40_000, "the window back after Restart");
  check("R5 Restart brought the server and the window back", alive(restarted.pid), { pid: restarted.pid, port: restarted.port });
  await shot(c, "08-after-restart");

  /* ── R6: the passwords file ──────────────────────────────────────────────────────────────── */
  const aside = fs.readdirSync(HOME).filter((n) => /^secrets\.unreadable-.*\.json$/.test(n));
  check("R6 the unreadable file is kept aside, unchanged", aside.length === 1 && fs.readFileSync(path.join(HOME, aside[0]), "utf8") === UNREADABLE, aside);
  const fresh = JSON.parse(fs.readFileSync(path.join(HOME, "secrets.json"), "utf8"));
  check("R6 a new store is in its place, at 0600, recording where the old one went",
    fresh.unreadable?.path === path.join(HOME, aside[0]) && (fs.statSync(path.join(HOME, "secrets.json")).mode & 0o777) === 0o600);
  await evalIn(c, `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5000, "palette");
  await setInput(c, ".palette input", "Open settings");
  await sleep(300);
  await evalIn(c, `[...document.querySelectorAll('.palette-list [role=option]')].find((o) => o.textContent.includes("Open settings"))?.click(), true`);
  const tab = `[...document.querySelectorAll('label.settings-tab')].find((l) => l.textContent.trim() === 'Passwords')`;
  await until(() => evalIn(c, `!!${tab}`), 10_000, "settings rail");
  await evalIn(c, `${tab}.click(), true`);
  const notice = await until(() => evalIn(c, `document.querySelector('.passwords-unreadable')?.textContent ?? null`), 10_000, "the notice");
  check("R6 Settings ▸ Passwords says what happened and where the file is", notice.includes("Realm couldn't read your saved passwords") && notice.includes(aside[0]) && notice.includes("Nothing was deleted."), { notice });
  await shot(c, "09-passwords-notice-dark");
  await setTheme(c, "light");
  await shot(c, "10-passwords-notice-light");
  await setTheme(c, "dark");
  await evalIn(c, `(() => { [...document.querySelectorAll('.passwords-unreadable button')].find((b) => b.textContent.startsWith("Show in")).click(); return true; })()`);
  await until(async () => fs.existsSync(revealLog), 5000, "the reveal");
  check("R6 Show in Finder selects the kept file", fs.readFileSync(revealLog, "utf8").trim() === path.join(HOME, aside[0]));
  await evalIn(c, `(() => { document.querySelector('.passwords-unreadable button[aria-label="Dismiss"]').click(); return true; })()`);
  await until(async () => JSON.parse(fs.readFileSync(path.join(HOME, "secrets.json"), "utf8")).unreadable === null, 5000, "the dismissal on disk");
  check("R6 Dismiss holds: the notice is gone from the page and from the file", (await evalIn(c, `!document.querySelector('.passwords-unreadable')`)) === true);

  const api3 = rpc(restarted.port, restarted.token);
  await api3.ready;
  await api3.call("daemon.stop", {}).catch(() => {});
  api3.close();
  c.close();
}

async function teardown() {
  electron?.kill("SIGKILL");
  await sleep(500);
  // Every server this check started, by pid, each one checked against this worktree as it was seen.
  await stopDaemons(HOME, [...seenPids]);
  if (process.env.LIVE_KEEP) console.error(`[live] keeping ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
