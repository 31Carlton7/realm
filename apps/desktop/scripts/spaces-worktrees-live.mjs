/**
 * Live check for a space's menu, the prompter's space chip and the worktree surfaces
 * (run with: node apps/desktop/scripts/spaces-worktrees-live.mjs [out-dir])
 *
 * Boots the BUILT app on a scratch REALM_HOME, as a scratch harness (unfocusable, fake agent only),
 * with a space whose folder is a real git repository: a second branch, and a worktree made over RPC
 * holding a commit of its own and an uncommitted file. Then, in the dark face and the light one:
 *
 *   1. a right-click on the space's head opens the menu its ⋯ opens, at the pointer, and Escape
 *      puts it away
 *   2. the prompter's workspace chip wears the space's own icon (an emoji here), not a folder
 *   3. the space page's Worktrees tab names each checkout's branch as git reports it, its changes
 *      and its last activity
 *   4. New worktree… starts from the branch the folder has checked out and says the branch it makes
 *   5. Remove… keeps the branch with the unpushed commit by default and names the session in it
 *
 * Every step is screenshotted; the pictures are the evidence for the layout claims.
 * Touches only a scratch dir; kills only what it started, and reaps its ports.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9232), SERVER_PORT = Number(process.env.REALM_PORT ?? 8792);
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "spaces-worktrees-live"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-spaces-worktrees-live-"));
const HOME = path.join(scratch, "home");
const DB = path.join(HOME, "realm.db");
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
const seenPids = [];

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
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return { ws, ready, next: () => String(++id), pending };
}
function cdp(url) {
  const s = socket(url);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: Number(i), method, params }));
    }),
    close: () => s.ws.close(),
  };
}
function rpc(token) {
  const s = socket(`ws://127.0.0.1:${SERVER_PORT}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params = {}) => new Promise((res, rej) => {
      const i = s.next();
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
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const sql = (stmt) => execFileSync("sqlite3", [DB, stmt], { encoding: "utf8" });
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

async function boot() {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env, REALM_HOME: HOME, REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  seenPids.push(electron.pid);
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  return c;
}
async function shutdown(c) {
  try { c?.close(); } catch { /* gone */ }
  electron?.kill("SIGKILL");
  await stopDaemons(HOME, seenPids);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  await sleep(800);
}
async function shot(c, name) {
  await sleep(350);
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  log("shot", file);
}
const click = (c, sel, text) => evalIn(c, `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${text ? `e.textContent.trim() === ${JSON.stringify(text)}` : "true"});
  if (!el) return false; el.click(); return true; })()`);
const escape = (c) => evalIn(c, `(() => { const t = document.querySelector('[role=menu], .sheet') ?? document.activeElement ?? document.body;
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);

async function seed() {
  const c = await boot();
  const r = rpc(await until(() => daemonToken(HOME), 30000, "daemon token"));
  await r.ready;
  const profiles = await r.call("profiles.list");
  const profileId = profiles[0]?.id ?? (await r.call("profiles.create", { name: "Work" })).id;
  const space = await r.call("spaces.create", { profileId, name: "Versed", icon: "emoji:🧪", color: "#30a46c" });
  await r.call("spaces.create", { profileId, name: "Homework", icon: "book", color: "#0090ff" });
  // The space's folder becomes a repository with a second branch.
  fs.mkdirSync(space.folderPath, { recursive: true });
  git(space.folderPath, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(space.folderPath, "README.md"), "# Versed\n");
  git(space.folderPath, "add", "."); git(space.folderPath, "commit", "-q", "-m", "init");
  git(space.folderPath, "branch", "feat/paywall");
  const primary = await r.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Tidy the README" });
  const wt = await r.call("environments.createWorktree", { spaceId: space.id, title: "Fix the login flow" });
  fs.writeFileSync(path.join(wt.path, "login.ts"), "export const login = 1;\n");
  git(wt.path, "add", "."); git(wt.path, "commit", "-q", "-m", "login");
  fs.writeFileSync(path.join(wt.path, "notes.md"), "wip\n");
  await r.call("sessions.create", { spaceId: space.id, agentKind: "fake", environmentId: wt.id, title: "Login flow" });
  r.close();
  await shutdown(c);
  return { space, primary: primary.session, wt };
}

async function look(theme, seeded) {
  sql(`INSERT INTO settings (key, value_json) VALUES ('ui.theme', ${q(JSON.stringify(theme))}) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
  sql(`INSERT INTO settings (key, value_json) VALUES ('ui.groundAlpha', '100') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
  const c = await boot();
  await until(() => evalIn(c, `!!document.querySelector('.sb-section[aria-label="Versed"] .sb-section-head')`), 30000, "Versed's section");

  // 1. The right-click.
  const head = await evalIn(c, `(() => { const b = document.querySelector('.sb-section[aria-label="Versed"] .sb-section-head').getBoundingClientRect();
    return { x: Math.round(b.x + 60), y: Math.round(b.y + b.height / 2) }; })()`);
  await evalIn(c, `(() => { document.querySelector('.sb-section[aria-label="Versed"] .sb-section-head').dispatchEvent(new MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, clientX: ${head.x}, clientY: ${head.y} })); return true; })()`);
  const menu = await until(() => evalIn(c, `(() => { const m = document.querySelector('[role=menu][aria-label="Versed"]'); if (!m) return null;
    const b = m.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), rows: [...m.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()) }; })()`), 5000, "context menu");
  check(`${theme}: right-click opens the space's menu at the pointer`, Math.abs(menu.left - head.x) <= 2 && Math.abs(menu.top - head.y) <= 2, { head, menu });
  check(`${theme}: it is the ⋯'s menu, worktree rows and all`, menu.rows.includes("New session in a worktree…") && menu.rows.includes("Worktrees") && menu.rows.includes("Space settings"), menu.rows);
  await shot(c, `${theme}-1-right-click-menu`);
  await escape(c);
  await until(() => evalIn(c, `!document.querySelector('[role=menu]')`), 3000, "menu gone on Escape");
  check(`${theme}: Escape puts it away`, true);

  // 2. The prompter's chip, in the space folder's session.
  await click(c, ".sb-section[aria-label='Versed'] .item-title", "Tidy the README");
  const chip = await until(() => evalIn(c, `(() => { const b = document.querySelector('.composer-understrip .ghost-chip[title^="Workspace"]');
    if (!b) return null; const t = b.querySelector('.chip-tint'); return { text: b.textContent, mark: t?.textContent ?? "", svg: !!t?.querySelector('svg'), title: b.title }; })()`), 15000, "workspace chip");
  check(`${theme}: the workspace chip wears the space's emoji, not a folder`, chip.mark.includes("🧪") && !chip.svg, chip);
  // The branch arrives with git's answer, a beat after the chip.
  const title = await until(() => evalIn(c, `document.querySelector('.composer-understrip .ghost-chip[title^="Workspace"]')?.title.includes("on main") ? document.querySelector('.composer-understrip .ghost-chip[title^="Workspace"]').title : null`), 8000, "branch in the tooltip").catch(() => chip.title);
  check(`${theme}: its tooltip says the folder's branch`, title.includes("on main"), title);
  await shot(c, `${theme}-2-prompter-space-chip`);

  // 3. The Worktrees tab, from the ⋯.
  await click(c, ".sb-section[aria-label='Versed'] button[aria-label='More for Versed']");
  await until(() => click(c, "[role=menu] [role=menuitem]", "Worktrees"), 5000, "Worktrees row");
  const cards = await until(() => evalIn(c, `(() => { const rows = [...document.querySelectorAll('.env-row')]; if (rows.length < 2) return null;
    const read = rows.map((r) => ({ name: r.querySelector('.env-name')?.textContent, branch: r.querySelector('.env-branch')?.textContent ?? null,
      dirty: r.querySelector('.env-dirty')?.textContent ?? null, when: r.querySelector('.env-when')?.textContent }));
    return read[0].branch && read[1]?.dirty ? read : null; })()`), 15000, "checkout cards with git's answers");
  check(`${theme}: the space folder says the branch git reports`, cards[0].name === "Versed" && cards[0].branch === "main", cards[0]);
  check(`${theme}: the worktree is named by its branch, and says its change and when it was active`, cards[1].name === "realm/fix-the-login-flow" && cards[1].dirty === "1 changed" && /^Active /.test(cards[1].when), cards[1]);
  await shot(c, `${theme}-3-worktrees-tab`);

  // 4. New worktree…
  await click(c, ".env-field-head .btn");
  await until(() => evalIn(c, `!!document.querySelector('.new-worktree')`), 8000, "new worktree sheet");
  await evalIn(c, `(() => { const i = document.querySelector('.new-worktree input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, 'Paywall copy'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const derived = await evalIn(c, `({ base: document.querySelector('.new-worktree select').value, line: document.querySelector('.wt-derived').textContent,
    options: [...document.querySelectorAll('.new-worktree option')].map((o) => o.value) })`);
  check(`${theme}: it starts from the checked-out branch and derives the new one`, derived.base === "main" && derived.line.includes("realm/paywall-copy") && derived.options.includes("feat/paywall"), derived);
  await shot(c, `${theme}-4-new-worktree-sheet`);
  await click(c, ".new-worktree .btn", "Cancel");
  await until(() => evalIn(c, `!document.querySelector('.new-worktree')`), 5000, "sheet closed");

  // 5. Remove…
  await evalIn(c, `(() => { const card = [...document.querySelectorAll('.env-row')].find((r) => r.querySelector('.env-name')?.textContent === 'realm/fix-the-login-flow');
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'Remove…').click(); return true; })()`);
  const sheet = await until(() => evalIn(c, `(() => { const s = document.querySelector('.wt-hazard'); if (!s) return null;
    return { hazard: s.textContent, branchKept: !document.querySelector('.wt-choice .checkbox').checked, sessions: [...document.querySelectorAll('.wt-session-title')].map((x) => x.textContent),
      remove: document.querySelector('.sheet-actions .btn.destructive').disabled }; })()`), 8000, "remove sheet");
  check(`${theme}: removal keeps the branch with the unpushed commit by default and says what goes`,
    sheet.branchKept && sheet.hazard === "This will destroy 1 uncommitted file. There is no undo.", sheet);
  check(`${theme}: it names the session still in the worktree and waits to be told it goes too`, sheet.sessions.includes("Login flow") && sheet.remove, sheet);
  await shot(c, `${theme}-5-remove-worktree-sheet`);
  await shutdown(c);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  log("seed");
  const seeded = await seed();
  for (const theme of ["dark", "light"]) { log("look", theme); await look(theme, seeded); }
}

main().catch(async (e) => { console.error(e); process.exitCode = 1; await shutdown(null); })
  .finally(() => { fs.rmSync(scratch, { recursive: true, force: true }); log("out", OUT); });
