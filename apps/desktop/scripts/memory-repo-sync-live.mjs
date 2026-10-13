/**
 * Live check for memory repo sync and the Claude import (run with: pnpm build && node apps/desktop/scripts/memory-repo-sync-live.mjs)
 *
 * The profile's memory repo gets a remote — a bare repository in the scratch folder, never a network
 * one — from the row, and sync is turned on only after the "I confirm this remote is private" box is
 * ticked. A save made through the real gateway is pushed. Offline (the bare repo moved away), an
 * import of Claude memory from the row still commits and its push waits; the row says so. Back online,
 * a second machine pushes first, and the row's retry finds the two sides diverged: saving pauses, the
 * row hands over the Terminal command, nothing is merged or forced. The row is captured in each state,
 * in both faces.
 *
 * Nothing is billed: Claude and Codex are the scripted agent's stand-ins (REALM_FAKE_STANDS_IN). Ports:
 * LIVE_SERVER_PORT / LIVE_CDP_PORT (8803 / 9243). Scratch under LIVE_SCRATCH (default: the OS temp dir),
 * screenshots under LIVE_SHOTS (default: the scratch's parent). Kills only what holds its own two ports,
 * and only if it is this run's.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8803);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9243);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1280, height: 820 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-memory-sync-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "memory-sync-shots");
const home = path.join(scratch, "home");
let electron = null;
let api = null;
const daemonPids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
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

const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1200, y: 780 });
/** Hold the window key: an unkeyed window greys its accent, and the live window opens behind. */
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);
const size = (c, height) => c.send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height, deviceScaleFactor: 2, mobile: false });
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const clickText = (sel, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`;
const textOf = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '')`;

/** Profile ▸ Profile settings… ▸ Memory, the way a person gets there. */
async function openProfileMemory(c) {
  await evalIn(c, `document.querySelector('.sb-profile').click(), true`);
  await until(() => evalIn(c, clickText('[role="menuitem"]', "Profile settings…")), 10_000, "Profile settings…");
  await until(() => evalIn(c, clickText(".page-rail .settings-tab", "Memory")), 10_000, "Memory section");
  await until(() => evalIn(c, `!!document.querySelector('.memory-repo')`), 10_000, "memory repo row");
  await park(c);
  await sleep(700);
}

async function setFace(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer') && document.documentElement.dataset.mode === '${mode}'`), 30_000, `the ${mode} face`);
  await holdKey(c);
}

/** A capture as a person would see it: laid over the face's page colour first, since a capture holds
 *  the DOM's alpha and none of the window's material (design.md). */
async function shot(c, tag, sel) {
  // Bring the first of them to the top of its scroller: a box below the fold is cut by the pane.
  await evalIn(c, `(() => { document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' }); return true; })()`);
  await sleep(500);
  const clip = await evalIn(c, `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; if (!els.length) return null;
    const rs = els.map((e) => e.getBoundingClientRect()); const pad = 16;
    const x = Math.min(...rs.map((r) => r.left)) - pad, y = Math.min(...rs.map((r) => r.top)) - pad;
    return { x, y, width: Math.max(...rs.map((r) => r.right)) - x + pad, height: Math.max(...rs.map((r) => r.bottom)) - y + pad }; })()`);
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const data = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(r.data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  await size(c, VIEW.height);
  return c;
}

const repoState = async (profileId) => (await api.call("memory.repo.get", { profileId })).repos[0];
const typeInto = (sel, value) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const rowText = () => evalIn(currentPage, textOf(".memory-repo"));
let currentPage = null;

/** The row in both faces, the dark one first; leaves the page dark. */
async function bothFaces(c, tag) {
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    await openProfileMemory(c);
    await shot(c, `${tag}-${mode}`, ".memory-repo");
  }
  await setFace(c, "dark");
  await openProfileMemory(c);
}

async function main() {
  const c = await launch();
  currentPage = c;
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Homework');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const daemon = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  if (daemon.pid) daemonPids.push(daemon.pid);
  const sessions = await api.call("sessions.listAll", { profileId: null });
  for (const s of sessions) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  const spaceId = sessions[0].spaceId;
  const [profile] = await api.call("profiles.list", {});
  const made = await api.call("memory.repo.create", { scope: "profile", ownerId: profile.id });
  const repoPath = made.path;
  const bare = path.join(scratch, "remote.git");
  const away = path.join(scratch, "away.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);

  // 1. A remote, added from the row.
  await setFace(c, "dark");
  await openProfileMemory(c);
  check("before a remote: it stays on this Mac", (await rowText()).includes("Nowhere. It stays on this Mac."));
  await evalIn(c, clickText(".memory-repo button", "Add remote…"));
  await until(() => evalIn(c, `!!document.querySelector('.memory-repo input[aria-label="Remote URL"]')`), 5_000, "remote field");
  await evalIn(c, typeInto('.memory-repo input[aria-label="Remote URL"]', bare));
  await evalIn(c, clickText(".memory-repo button", "Save"));
  await until(async () => (await repoState(profile.id)).remote === bare, 10_000, "remote saved");
  check("the remote is the repo's origin", git(repoPath, "remote", "get-url", "origin").trim() === bare);

  // 2. Sync, behind the privacy question: a bare repo on disk is no GitHub remote, so only the box will do.
  await until(() => evalIn(c, clickText(".memory-repo button", "Turn on sync…")), 5_000, "Turn on sync…");
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Not checked')`), 10_000, "the check");
  const disabled = await evalIn(c, `[...document.querySelectorAll('.memory-repo button')].find((b) => b.textContent.trim() === 'Turn on sync')?.disabled`);
  check("Turn on sync waits for the box", disabled === true);
  await park(c); await sleep(300);
  await shot(c, "memory-sync-confirm-dark", ".memory-repo");
  await evalIn(c, `document.querySelector('.memory-sync-confirm input').click(), true`);
  await evalIn(c, clickText(".memory-repo button", "Turn on sync"));
  await until(async () => (await repoState(profile.id)).sync === "synced", 20_000, "synced");
  const branch = git(repoPath, "symbolic-ref", "--short", "HEAD").trim();
  check("the first sync pushed the repo", git(bare, "rev-parse", `refs/heads/${branch}`).trim() === git(repoPath, "rev-parse", "HEAD").trim());

  // 3. A save through the gateway is pushed after it commits.
  const { session } = await api.call("sessions.create", { spaceId, agentKind: "fake" });
  await api.call("sessions.send", { id: session.id, text: "remember I prefer tabs" });
  await until(() => fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8").includes("Prefers tabs over spaces"), 20_000, "the saved fact");
  await until(() => git(bare, "log", "-1", "--format=%s", branch).trim() === "Remember Prefers tabs over spaces", 20_000, "the save pushed");
  check("the save landed on the remote", true);
  await until(async () => (await repoState(profile.id)).sync === "synced", 10_000, "synced again");
  await openProfileMemory(c);
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Up to date')`), 10_000, "row up to date");
  await bothFaces(c, "memory-sync-synced");

  // The user's other machine, cloned while the remote is reachable.
  const other = path.join(scratch, "laptop");
  execFileSync("git", ["clone", "-q", bare, other]);

  // 4. Offline: Claude's memory imported from the row still commits; the push waits.
  const imported = path.join(home, "memory", "imported", spaceId, "Users-me-Projects-versed");
  fs.mkdirSync(imported, { recursive: true });
  fs.writeFileSync(path.join(imported, "MEMORY.md"), "- [Serve sim](serve-sim.md) — run the iOS app through serve-sim\n- [Build gotcha](build-gotcha.md) — clean DerivedData after a scheme change\n");
  fs.writeFileSync(path.join(imported, "serve-sim.md"), "---\nname: serve-sim\nmetadata:\n  modified: 2026-08-02T08:59:07.042Z\n---\n\nUse `npx serve-sim`. Related: [[build-gotcha]]\n");
  fs.writeFileSync(path.join(imported, "build-gotcha.md"), "Clean DerivedData after a scheme change.\n");
  fs.renameSync(bare, away);
  await openProfileMemory(c);
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('2 memories from 1 project you imported from Claude are not in this repo yet.')`), 10_000, "import preview");
  await evalIn(c, clickText(".memory-repo button", "Import…"));
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Add 2 memories and 2 files to this repo as one commit?')`), 5_000, "import confirm");
  check("nothing is written before the user confirms", git(repoPath, "log", "-1", "--format=%s").trim() === "Remember Prefers tabs over spaces");
  await park(c); await sleep(300);
  await shot(c, "memory-import-confirm-dark", ".memory-repo");
  await evalIn(c, clickText(".memory-repo button", "Import 2"));
  await until(() => git(repoPath, "log", "-1", "--format=%s").trim() === "Import 2 memories from Claude", 15_000, "the import commit");
  const topic = fs.readFileSync(path.join(repoPath, "imported", "Users-me-Projects-versed.md"), "utf8");
  check("each entry names the file it came from", topic.includes(`[source: ${path.join(imported, "serve-sim.md")}; added: 2026-08-02]`), topic);
  await until(async () => { const s = await repoState(profile.id); return s.sync === "queued" && s.syncError ? s : null; }, 20_000, "queued");
  const queued = await repoState(profile.id);
  check("offline, the import is queued, not lost", queued.ahead === 1 && queued.clean === true, { ahead: queued.ahead, syncError: queued.syncError });
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('1 save waiting to push')`), 10_000, "row says queued");
  await bothFaces(c, "memory-sync-queued");
  const again = await api.call("memory.repo.importClaude", { scope: "profile", ownerId: profile.id, dryRun: true });
  check("a second import would add nothing", again.entries === 0 && again.files === 0, again);

  // 5. The laptop pushes first; back online, the row's retry finds the sides diverged.
  fs.renameSync(away, bare);
  fs.writeFileSync(path.join(other, "laptop.md"), "- Saved on the laptop\n");
  git(other, "add", "--", "laptop.md");
  git(other, "-c", "user.name=Laptop", "-c", "user.email=l@l", "commit", "-qm", "Laptop: a fact");
  git(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  const remoteHead = git(bare, "rev-parse", `refs/heads/${branch}`).trim();
  const localHead = git(repoPath, "rev-parse", "HEAD").trim();
  await evalIn(c, clickText(".memory-repo button", "Retry now"));
  await until(async () => (await repoState(profile.id)).sync === "diverged", 20_000, "diverged");
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Resolve in Terminal')`), 10_000, "row says diverged");
  check("diverged: nothing merged here", git(repoPath, "rev-parse", "HEAD").trim() === localHead && git(repoPath, "rev-list", "--merges", "--count", "HEAD").trim() === "0");
  check("diverged: nothing forced there", git(bare, "rev-parse", `refs/heads/${branch}`).trim() === remoteHead);
  const st = await repoState(profile.id);
  check("diverged: saving paused with the reason on the row", st.reason?.includes("resolve it in Terminal") && (await rowText()).includes("Saving paused"), st.reason);
  // A save is refused while diverged: the scripted agent's save comes back as a tool error, no commit.
  const before = git(repoPath, "rev-list", "--count", "HEAD").trim();
  fs.writeFileSync(path.join(repoPath, "MEMORY.md"), fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8").replace(/^- Prefers tabs over spaces.*\n\n?/m, ""));
  git(repoPath, "-c", "user.name=Me", "-c", "user.email=m@m", "commit", "-qam", "Forget by hand");
  const s2 = (await api.call("sessions.create", { spaceId, agentKind: "fake" })).session;
  await api.call("sessions.send", { id: s2.id, text: "remember I prefer tabs" });
  await until(async () => (await api.call("sessions.get", { id: s2.id }))?.status === "idle", 15_000, "the turn ends");
  await sleep(800);
  check("diverged: a save does not land", git(repoPath, "rev-list", "--count", "HEAD").trim() === String(Number(before) + 1)
    && !fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8").includes("Prefers tabs"));
  await bothFaces(c, "memory-sync-diverged");

  // 6. The user resolves in Terminal; the row's retry syncs and saving resumes.
  git(repoPath, "-c", "user.name=Me", "-c", "user.email=m@m", "pull", "-q", "--no-rebase", "--no-edit", "origin", branch);
  await evalIn(c, clickText(".memory-repo button", "Retry now"));
  await until(async () => (await repoState(profile.id)).sync === "synced", 20_000, "synced after resolving");
  check("resolved: the remote has both sides", git(bare, "rev-parse", `refs/heads/${branch}`).trim() === git(repoPath, "rev-parse", "HEAD").trim());

  // 7. Search finds what the import brought in, scoped to this profile.
  const hits = (await api.call("search.query", { profileId: profile.id, query: "DerivedData" })).memory;
  check("search finds memory repo files", hits.some((h) => h.file === "imported/Users-me-Projects-versed.md") && hits.some((h) => h.file === "imported/Users-me-Projects-versed/build-gotcha.md"), hits.map((h) => h.title));
  c.close();
}

/** Kill whatever still listens on one of this run's ports, but only if it is this run's. */
function killPort(port) {
  const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
    if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home, daemonPids);
  for (const port of [SERVER_PORT, CDP_PORT]) killPort(port);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.stack ?? e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
