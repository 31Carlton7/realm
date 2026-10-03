/**
 * Live check for Quick Look, Share and drag-out (run with: node apps/desktop/scripts/file-actions-live.mjs)
 *
 * The page asks main through the real bridge; main gates the path, looks up the file's real Finder
 * icon, and calls the system. The three system calls themselves are recorded instead of made — a
 * Quick Look panel or a Share menu would open over whatever the person running this is doing, and an
 * OS drag needs a mouse button actually held down — so this proves everything up to the edge of
 * macOS, and the edge is three one-line calls.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the processes it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9377), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8944);
const shots = process.env.LIVE_SHOT_DIR ?? "/tmp/realm-file-actions-live";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-file-actions-live-"));
let electron = null;
const replies = [];
const events = [];
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

async function shoot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", clip ? { clip: { ...clip, scale: 2 } } : {});
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${file}`);
  return file;
}

/** A named element's box, or null. Used for both the geometry checks and the screenshot clips. */
const boxOf = (c, sel) => evalIn(c, `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);


/* The wrapper answers questions about main over stdin/stdout: the application menu as built, a click
   on one of its rows by label, the window's bounds, moving it, and quitting. */
const WRAPPER = [
  'import { app, BrowserWindow, Menu, ShareMenu } from "electron";',
  'import readline from "node:readline";',
  'app.setPath("userData", process.env.LIVE_USER_DATA);',
  "BrowserWindow.prototype.previewFile = function (file, name) { console.log('LIVE_EVENT ' + JSON.stringify({ kind: 'quick-look', file, name })); };",
  "ShareMenu.prototype.popup = function (opts) { console.log('LIVE_EVENT ' + JSON.stringify({ kind: 'share', x: opts?.x ?? null, y: opts?.y ?? null })); };",
  "app.on('web-contents-created', (_e, wc) => { wc.startDrag = (item) => { const size = item.icon.getSize(); console.log('LIVE_EVENT ' + JSON.stringify({ kind: 'drag', file: item.file, iconEmpty: item.icon.isEmpty(), size })); }; });",
  "const walk = (items) => items.map((i) => ({ label: i.label, role: i.role ?? null, accelerator: i.accelerator ?? null, type: i.type, submenu: i.submenu ? walk(i.submenu.items) : null }));",
  "const findItem = (items, label) => { for (const i of items) { if (i.label === label) return i; if (i.submenu) { const f = findItem(i.submenu.items, label); if (f) return f; } } return null; };",
  "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');",
  "  const win = BrowserWindow.getAllWindows()[0];",
  "  if (cmd === 'menu') console.log('LIVE_REPLY ' + JSON.stringify(walk(Menu.getApplicationMenu().items)));",
  "  if (cmd === 'click') { const item = findItem(Menu.getApplicationMenu().items, arg); if (item) item.click(); console.log('LIVE_REPLY ' + JSON.stringify(!!item)); }",
  "  if (cmd === 'bounds') console.log('LIVE_REPLY ' + JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() }));",
  "  if (cmd === 'move') { const [x, y, width, height] = arg.split(',').map(Number); win.setBounds({ x, y, width, height }); console.log('LIVE_REPLY true'); }",
  "  if (cmd === 'quit') { console.log('LIVE_REPLY true'); app.quit(); }",
  "});",
  "await import(process.env.LIVE_MAIN);",
].join("\n");

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, WRAPPER);
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env,
      REALM_HOME: path.join(scratch, "home"), REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  electron.stderr.on("data", (d) => process.stderr.write(`    [electron] ${d}`));
  let buf = "";
  electron.stdout.on("data", (d) => {
    process.stderr.write(`    [electron] ${d}`);
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith("LIVE_REPLY ")) replies.push(JSON.parse(line.slice(11)));
      if (line.startsWith("LIVE_EVENT ")) events.push(JSON.parse(line.slice(11)));
    }
  });
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  return c;
}
/** Ask main something and wait for its one-line answer. */
const ask = async (line) => {
  const n = replies.length;
  electron.stdin.write(`${line}\n`);
  await until(() => replies.length > n, 5000, line);
  return replies[replies.length - 1];
};
const flat = (items, out = []) => { for (const i of items) { out.push(i); if (i.submenu) flat(i.submenu, out); } return out; };

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  const c = await launch();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  const file = path.join(scratch, "Quarterly report.pdf");
  fs.writeFileSync(file, "%PDF-1.4\n%live check\n");
  const missing = path.join(scratch, "not-there.pdf");
  const wait = async (kind, n) => { await until(() => events.filter((e) => e.kind === kind).length >= n, 5000, kind).catch(() => {}); return events.filter((e) => e.kind === kind); };

  check("the bridge offers all three in the app", await evalIn(c, `['quickLook','share','startDrag'].every((k) => typeof window.realm.files[k] === 'function')`));

  await evalIn(c, `window.realm.files.quickLook(${JSON.stringify(file)})`);
  const looks = await wait("quick-look", 1);
  check("Quick Look is asked for the gated file, named for the panel", looks[0]?.file === file && looks[0]?.name === "Quarterly report.pdf", looks);

  await evalIn(c, `window.realm.files.share(${JSON.stringify(file)}, { x: 100, y: 40 })`);
  const shares = await wait("share", 1);
  check("the Share menu opens at the asking point, in window coordinates", shares[0]?.x === 100 && shares[0]?.y === 40, shares);

  await evalIn(c, `window.realm.files.startDrag(${JSON.stringify(file)}); true`);
  const drags = await wait("drag", 1);
  check("a drag carries the file and its real Finder icon", drags[0]?.file === file && drags[0]?.iconEmpty === false && drags[0]?.size?.width > 0, drags);

  // The gate: a path the renderer names that is not on disk gets nothing at all.
  const before = events.length;
  await evalIn(c, `window.realm.files.quickLook(${JSON.stringify(missing)})`);
  await evalIn(c, `window.realm.files.share(${JSON.stringify(missing)}, { x: 1, y: 1 })`);
  await evalIn(c, `window.realm.files.startDrag(${JSON.stringify(missing)}); true`);
  await sleep(600);
  check("a path that is not on disk reaches none of the three", events.length === before, events.slice(before));
  c.close();
}

/** Kill whatever this run left on its two ports — the server outlives a killed Electron. */
function reapServer() {
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
    } catch {}
  }
}
/**
 * The server is a SECOND Electron process, spawned by the one we started, and killing the parent
 * leaves it holding REALM_PORT — so the next run refuses to start on a port nothing is using any
 * more. Killed by port rather than by pid so an orphan from an interrupted run is cleared too, and
 * only ever the port this script chose.
 */
function reap() {
  electron?.kill();
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid)); } catch {}
      }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { reap(); process.exit(1); });
