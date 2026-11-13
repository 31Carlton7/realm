/**
 * The one way a live check starts Electron: quietly, and cleaned up after.
 *
 * Every `*-live.mjs` boots the BUILT app on a scratch home. Started through here, that app runs in
 * quiet mode (`REALM_QUIET_WINDOWS=1`, src/main/quiet-windows.ts) on an Electron that is never a Dock
 * app (`quietElectronBinary`): no Dock icon, no focus taken, every
 * window all but transparent, nothing played or notified — while it still paints and lays out, so
 * screenshots and measurements are real. And whatever it leaves listening on its ports when the
 * check ends — the server is a second process that outlives a killed parent — is reaped, on a normal
 * exit, a throw, or Ctrl-C. `scripts/live-app.test.ts` fails a live script that spawns Electron any
 * other way.
 *
 *   spawnLiveElectron(args, options)   drop-in for spawn(electronBin, args, options)
 *   launchLiveApp({ name, … })          the whole boot: scratch home, free ports, CDP to the page
 *   node lib/live-app.mjs x-live.cjs    run a check that is its own Electron main, the same way
 *   quietMain                           the built quiet-windows module, for an entry that is not Realm's
 *                                       main (also handed to the app as REALM_QUIET_MAIN)
 *
 * See scripts/README.md.
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopDaemons } from "./daemon-token.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const desktopRoot = path.join(repoRoot, "apps/desktop");
export const mainEntry = path.join(desktopRoot, "out/main/index.js");
export const quietMain = path.join(desktopRoot, "out/main/quiet-windows.js");
const quietPreload = path.join(desktopRoot, "scripts/lib/quiet-electron.cjs");
export const serverEntry = path.join(repoRoot, "apps/server/dist/main.js");

/** The Electron binary this worktree installed. A fresh worktree's install can leave it unfetched. */
export function electronBinary() {
  try {
    return createRequire(path.join(desktopRoot, "package.json"))("electron");
  } catch (err) {
    throw new Error(`no Electron binary in this worktree — run \`node install.js\` in node_modules/.pnpm/electron@*/node_modules/electron (${err.message})`);
  }
}

/**
 * The same Electron, marked an agent app (`LSUIElement`): the Dock never shows it, not even for the
 * ~100ms between launch and main's `app.dock.hide()` that the stock binary spends as a regular app
 * (measured with `lsappinfo` every 20ms: Foreground at 130–260ms, UIElement by 210–390ms). An APFS
 * clone, so it costs no disk, re-signed ad hoc as the stock one is, and made once per Electron build.
 */
export function quietElectronBinary() {
  const stock = electronBinary();
  if (process.platform !== "darwin") return stock;
  const bundle = path.resolve(stock, "../../..");
  const plist = path.join(bundle, "Contents/Info.plist");
  const version = execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", plist], { encoding: "utf8" }).trim();
  const quiet = path.join(desktopRoot, "node_modules/.cache/realm-quiet-electron", version, "Electron.app");
  const binary = path.join(quiet, path.relative(bundle, stock));
  if (fs.existsSync(binary)) return binary;
  const staging = `${path.dirname(quiet)}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const copy = path.join(staging, "Electron.app");
  execFileSync("cp", ["-cR", bundle, copy]);
  execFileSync("plutil", ["-replace", "LSUIElement", "-bool", "true", path.join(copy, "Contents/Info.plist")]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", copy], { stdio: "ignore" });
  fs.mkdirSync(path.dirname(quiet), { recursive: true });
  try { fs.renameSync(copy, quiet); } catch { /* another run made it first */ }
  fs.rmSync(staging, { recursive: true, force: true });
  return binary;
}

/** Quiet mode, and the app's RPC token written to `<home>/live-app-token` for the check to dial
 *  with (`lib/daemon-token.mjs`). */
export function quietEnv(env = process.env) {
  return { ...env, REALM_QUIET_WINDOWS: "1", REALM_LIVE_APP_TOKEN: "1" };
}

/* ── Teardown ─────────────────────────────────────────────────────────────────────────────── */

const launched = [];
let hooked = false;

function portsOf(args, env) {
  const ports = [env.REALM_PORT, env.REALM_DEVTOOLS_PORT];
  for (const a of args) {
    const m = /^--(?:inspect(?:-brk)?|remote-debugging-port)=(?:[\d.]+:)?(\d+)$/.exec(String(a));
    if (m) ports.push(m[1]);
  }
  return [...new Set(ports.filter(Boolean).map(Number))];
}

/** Whether a pid is a process this worktree started: its command line runs from this repo. Never by
 *  port alone — the person's own Realm, or a peer's live run, may hold one of the same numbers. */
function ours(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(repoRoot);
  } catch {
    return false;
  }
}

function listeners(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Kill a launch's Electron and whatever of ours still listens on its ports. Synchronous, so it can
 *  run from `process.on("exit")`. */
export function reap(entry) {
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    try { entry.child.kill("SIGKILL"); } catch { /* gone */ }
  }
  const pids = new Set(entry.ports.flatMap(listeners));
  if (entry.home) {
    try {
      const pid = JSON.parse(fs.readFileSync(path.join(entry.home, "daemon.json"), "utf8")).pid;
      if (pid) pids.add(pid);
    } catch { /* never wrote one */ }
  }
  for (const pid of pids) if (pid !== process.pid && ours(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => { for (const e of launched) reap(e); });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(signal, () => process.exit(code));
  }
}

/**
 * `spawn(electron, args, options)`, in quiet mode, reaped when this process ends. The ports to reap
 * are read from `REALM_PORT`, `REALM_DEVTOOLS_PORT` and any `--inspect=`/`--remote-debugging-port=`.
 *
 * `visible: "<why>"` opts out of quiet mode, for the few checks whose evidence is the screen itself
 * (a `screencapture` of native material or a native panel). The reason is printed, so a run that
 * takes the screen says so.
 *
 * Quiet mode is preloaded (`-r`), ahead of the script's own wrapper: a wrapper that stands in for
 * the hand on a menu or a dialog patches Electron before it imports Realm's main, and main installing
 * quiet mode after that would put the quiet stubs back over the wrapper's.
 */
export function spawnLiveElectron(args, { visible, ...options } = {}) {
  if (visible) process.stderr.write(`[live-app] this check is seen on screen: ${visible}\n`);
  const env = { ...quietEnv(options.env ?? process.env), REALM_QUIET_MAIN: quietMain };
  if (visible) delete env.REALM_QUIET_WINDOWS;
  const child = visible
    ? spawn(electronBinary(), args, { ...options, env })
    : spawn(quietElectronBinary(), ["-r", quietPreload, ...args], { ...options, env });
  launched.push({ child, ports: portsOf(args, env), home: env.REALM_HOME });
  hookExit();
  return child;
}

/* ── The whole boot ───────────────────────────────────────────────────────────────────────── */

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(150);
  }
}

/** A CDP connection: `send(method, params)`, `on(event, fn)`, and `eval(expression)` for a value. */
export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p?.resolve(msg.result);
    } else for (const fn of handlers.get(msg.method) ?? []) fn(msg.params);
  });
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject, method });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return {
    send,
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    async eval(expression, extra = {}) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...extra });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

/**
 * Boot the built app on a fresh scratch home with free ports, in quiet mode, and attach to its first
 * window's page over CDP.
 *
 *   const app = await launchLiveApp({ name: "my-check", inspect: true });
 *   try { … app.page.eval(…) … app.main.eval(`require("electron").BrowserWindow.getAllWindows().length`) }
 *   finally { await app.stop(); }
 *
 * `env` is added to the app's environment (the fake agent is on unless `fakeAgent: false`);
 * `inspect` also attaches to main's inspector, where `main.eval` has `require`; `rendererUrl` serves
 * the renderer from a URL (for the paint worklet, which file:// refuses). Its page target is found by
 * whichever of file:// or that URL it loaded.
 */
export async function launchLiveApp({ name = "app", env = {}, args = [], inspect = false, rendererUrl = null, fakeAgent = true, keep = false, timeoutMs = 30_000 } = {}) {
  for (const f of [mainEntry, serverEntry]) if (!fs.existsSync(f)) throw new Error(`${f} is missing — run \`pnpm build\` first (a live check runs the BUILT app)`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `realm-${name}-live-`));
  const home = path.join(scratch, "home");
  const ports = { server: await freePort(), cdp: await freePort(), inspect: inspect ? await freePort() : null };
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    `await import(${JSON.stringify(pathToFileURL(mainEntry).href)});`,
  ].join("\n"));
  const log = fs.openSync(path.join(scratch, "electron.log"), "a");
  const electron = spawnLiveElectron([...(inspect ? [`--inspect=${ports.inspect}`] : []), wrapper, ...args], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(ports.server),
      REALM_DEVTOOLS_PORT: String(ports.cdp),
      REALM_SERVER_ENTRY: serverEntry,
      LIVE_USER_DATA: path.join(scratch, "userData"),
      ...(fakeAgent ? { REALM_ENABLE_FAKE_AGENT: "1" } : {}),
      ...(rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
      ...env,
    },
    stdio: ["ignore", log, log],
  });
  const entry = launched.at(-1);
  const targets = () => fetch(`http://127.0.0.1:${ports.cdp}/json/list`).then((r) => r.json());
  const isPage = (t) => t.type === "page" && (rendererUrl ? t.url.startsWith(rendererUrl) : t.url.startsWith("file://"));
  let page = null, main = null;
  const stop = async () => {
    page?.close(); main?.close();
    await stopDaemons(home);
    reap(entry);
    launched.splice(launched.indexOf(entry), 1);
    if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const target = await until(async () => (await targets()).find(isPage), timeoutMs, `the renderer on CDP port ${ports.cdp} (log: ${path.join(scratch, "electron.log")})`);
    page = await cdp(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    if (inspect) {
      const t = await until(async () => (await fetch(`http://127.0.0.1:${ports.inspect}/json/list`).then((r) => r.json()))[0], timeoutMs, "main's inspector");
      const m = await cdp(t.webSocketDebuggerUrl);
      await m.send("Runtime.enable");
      main = { ...m, eval: (expression) => m.eval(expression, { includeCommandLineAPI: true }) };
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return {
    scratch, home, ports, electron, page, main, targets, stop,
    /** A PNG of the page (DOM only — a native pane over it is absent; capture the view's own
     *  webContents through `main` for those). */
    async screenshot(file, clip) {
      const { data } = await page.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    },
  };
}

/* ── As a command: run a check that is its own Electron main, quietly ─────────────────────── */

// node apps/desktop/scripts/lib/live-app.mjs apps/desktop/scripts/agent-cursor-live.cjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [entry, ...rest] = process.argv.slice(2);
  if (!entry) {
    process.stderr.write("usage: node apps/desktop/scripts/lib/live-app.mjs <check-live.cjs> [args…]\n");
    process.exit(2);
  }
  const child = spawnLiveElectron([path.resolve(entry), ...rest], { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
