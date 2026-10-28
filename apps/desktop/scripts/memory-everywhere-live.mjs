/**
 * Live check that memory is on by default and that Claude's own memory flows in (run with:
 * pnpm build && node apps/desktop/scripts/memory-everywhere-live.mjs)
 *
 * A fresh home's profile has its memory repo before anyone asks for one, and so does a profile made
 * afterwards. Claude memory kept outside Realm — in a stand-in for `~/.claude` (CLAUDE_CONFIG_DIR) —
 * lands in the folder of the space that works in that project, as it was there; a project no space
 * works in is reported and a temporary one passed over; the Claude folder is only read. The profile's
 * Memory page says so — and its select brings a waiting project into the space chosen for it at once,
 * or leaves one out.
 *
 * Nothing is billed: Claude and Codex are the scripted agent's stand-ins (REALM_FAKE_STANDS_IN), and
 * every session is switched to the fake before anything is sent. Ports: LIVE_SERVER_PORT /
 * LIVE_CDP_PORT (8791 / 9231). Scratch under LIVE_SCRATCH (default: the OS temp dir), screenshots under
 * LIVE_SHOTS. Kills only what holds its own two ports, and only if it is this run's.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8791);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9231);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1280, height: 820 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-memory-everywhere-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "memory-everywhere-shots");
const home = path.join(scratch, "home");
/** A stand-in for `~/.claude`: the server reads Claude's memory from `CLAUDE_CONFIG_DIR`, so the real one is never read. */
const fakeClaude = path.join(scratch, "fake-claude");
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
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
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
      CLAUDE_CONFIG_DIR: fakeClaude,
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

/** Claude's name for a project folder: every character but a letter or a digit made a dash. */
const claudeProjectName = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
/** A file Claude kept for a project, outside Realm. */
function claudeKept(project, file, text) {
  const dir = path.join(fakeClaude, "projects", project, "memory");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
/** Every file under a folder, with its size and modification time — what "only read" is checked by. */
function fingerprint(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); } } };
  walk(dir);
  return out.sort().join("\n");
}

async function main() {
  const c = await launch();
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
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

  // 1. On by default: the first profile's repo was made at boot, before anything asked for it.
  const [profile] = await api.call("profiles.list", {});
  const [repo] = (await api.call("memory.repo.get", { profileId: profile.id })).repos;
  check("a fresh home's profile has its memory repo", repo?.valid === true && repo.path === path.join(home, "memory", "repos", `profile-${profile.id}`), repo?.path);
  check("…made as one commit at boot", git(repo.path, "log", "--format=%s").trim() === "Create memory repo");
  console.log(`EVIDENCE memory.repo.get ${profile.name} → ${JSON.stringify({ path: repo.path, valid: repo.valid, clean: repo.clean, lastCommitSubject: repo.lastCommitSubject })}`);
  const work = await api.call("profiles.create", { name: "Work" });
  const [workRepo] = (await api.call("memory.repo.get", { profileId: work.id })).repos;
  check("a profile made afterwards has one as soon as it exists", workRepo?.valid === true, workRepo?.path);
  console.log(`EVIDENCE memory.repo.get Work → ${JSON.stringify({ path: workRepo?.path, valid: workRepo?.valid })}`);

  // 2. Claude memory kept outside Realm: one project per outcome.
  const space = (await api.call("spaces.list", {})).find((sp) => sp.profileId === profile.id && sp.name === "Realm");
  const fact = "---\nname: deploy-steps\ndescription: How a release ships\nmetadata:\n  type: project\n---\n\nTag on main, then notarize the dmg.\n";
  claudeKept(claudeProjectName(fs.realpathSync(space.folderPath)), "deploy-steps.md", fact);
  claudeKept(claudeProjectName(fs.realpathSync(space.folderPath)), "MEMORY.md", "- [deploy-steps](deploy-steps.md) — how a release ships\n");
  claudeKept("-Users-nobody-code-elsewhere", "stray.md", "A project no space works in.\n");
  claudeKept("-private-var-folders-zz-T-realm-live-abc123-home", "scratch.md", "A test run's.\n");
  const claudeBefore = fingerprint(fakeClaude);
  const r = await api.call("memory.repo.claudeBackfill", { profileId: profile.id, run: true });
  console.log(`EVIDENCE memory.repo.claudeBackfill → ${JSON.stringify(r)}`);
  const folder = path.join(repo.path, "spaces", "realm");
  check("the project's file lands in its space's folder, as it was", fs.readFileSync(path.join(folder, "deploy-steps.md"), "utf8") === fact);
  check("…with its index line", fs.readFileSync(path.join(folder, "MEMORY.md"), "utf8") === "- [deploy-steps](deploy-steps.md) — how a release ships\n");
  check("…and the folder linked from the root index", fs.readFileSync(path.join(repo.path, "MEMORY.md"), "utf8").includes("- [[spaces/realm/MEMORY]]"));
  check("…as one commit, tree clean", git(repo.path, "log", "-1", "--format=%s").trim() === "Bring in memory Claude kept outside Realm" && git(repo.path, "status", "--porcelain") === "");
  check("the result counts it", r.imported === 1 && r.total === 1 && r.error === null, r);
  check("a project no space works in is reported, not guessed", r.unmatched.some((u) => u.project === "-Users-nobody-code-elsewhere"), r.unmatched);
  check("a temporary one is passed over", r.skipped.some((s) => s.file.endsWith("-private-var-folders-zz-T-realm-live-abc123-home")), r.skipped);
  check("Claude's folder is only read", fingerprint(fakeClaude) === claudeBefore);
  console.log(`EVIDENCE ${folder}: ${JSON.stringify(fs.readdirSync(folder))}`);
  console.log(`EVIDENCE git log:\n${git(repo.path, "log", "--format=%h %s", "--name-only")}`);
  const again = await api.call("memory.repo.claudeBackfill", { profileId: profile.id, run: true });
  check("a second run brings in nothing", again.imported === 0 && again.updated === 0 && git(repo.path, "rev-list", "--count", "HEAD").trim() === "2", again);

  // 3. The profile's Memory page says what came in and what stayed out.
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    await openProfileMemory(c);
    await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Claude memory')`), 10_000, "the Claude memory row");
    await evalIn(c, `(() => { for (const d of document.querySelectorAll('.memory-repo details')) d.open = true; return true; })()`);
    await sleep(400);
    const row = await evalIn(c, textOf(".memory-repo"));
    check(`the row says what is in (${mode})`, row.includes("1 file of Claude's own memory is in this repo, in the folder"), row);
    check(`…and what stayed out (${mode})`, row.includes("-Users-nobody-code-elsewhere") && row.includes("no space works in that folder"), row);
    await shot(c, `memory-everywhere-${mode}`, ".memory-page > .settings-head:last-of-type, .memory-repo");
  }

  // 4. A project no space works in waits for a choice, the biggest first: its select brings it into the
  //    space chosen for it at once, and "Leave out" leaves another where it is.
  const stora = await api.call("spaces.create", { profileId: profile.id, name: "Stora" });
  const ravens = "-Users-nobody-code-stora-ravens";
  const ravensFiles = {
    "ravens-roster.md": "---\nname: ravens-roster\ndescription: Who is on the roster\nmetadata:\n  type: project\n---\n\nTwelve players; the captain rotates weekly.\n",
    "ravens-deploy.md": "---\nname: ravens-deploy\ndescription: How the Ravens site ships\nmetadata:\n  type: project\n---\n\nPreview on every push; production from main.\n",
    "ravens-api.md": "---\nname: ravens-api\ndescription: Where the Ravens API lives\nmetadata:\n  type: reference\n---\n\nThe API is the stora-platform service, under /ravens.\n",
  };
  for (const [f, t] of Object.entries(ravensFiles)) claudeKept(ravens, f, t);
  claudeKept(ravens, "MEMORY.md", Object.keys(ravensFiles).map((f) => `- [${f.slice(0, -3)}](${f}) — the Ravens\n`).join(""));
  const selectFor = (project) => `document.querySelector('select[aria-label="Where the memory of ${project} goes"]')`;
  const choose = (project, value) => evalIn(c, `(() => { const s = ${selectFor(project)};
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)});
    s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const openFolds = () => evalIn(c, `(() => { for (const d of document.querySelectorAll('.memory-repo details')) d.open = true; return true; })()`);
  await setFace(c, "dark");
  await openProfileMemory(c);
  await evalIn(c, clickText(".memory-repo button", "Check now"));
  await until(() => evalIn(c, `!!${selectFor(ravens)}`), 15_000, "the waiting project's select");
  await openFolds();
  await sleep(400);
  const listed = () => evalIn(c, `[...document.querySelectorAll('.memory-claude-project')].map((li) => [li.querySelector('.memory-repo-log-subject').textContent, li.querySelector('.memory-claude-project-files').textContent, li.querySelector('select').value])`);
  const waiting = await listed();
  check("the waiting projects are listed biggest first, each with its size and a select on the question", JSON.stringify(waiting) === JSON.stringify([[ravens, "3 files", ""], ["-Users-nobody-code-elsewhere", "1 file", ""]]), waiting);
  const options = await evalIn(c, `[...${selectFor(ravens)}.options].map((o) => o.textContent)`);
  check("…offering this profile's spaces, then Leave out", JSON.stringify(options) === JSON.stringify(["Choose a space…", "Realm", "Stora", "Leave out"]), options);
  await shot(c, "memory-claude-projects-waiting-dark", ".memory-repo");
  const before = git(repo.path, "rev-list", "--count", "HEAD").trim();
  await choose(ravens, stora.id);
  await until(() => fs.existsSync(path.join(repo.path, "spaces", "stora", "ravens-roster.md")), 15_000, "the chosen project's files in Stora's folder");
  check("choosing Stora brings the project's files into Stora's folder, as they were",
    Object.entries(ravensFiles).every(([f, t]) => fs.readFileSync(path.join(repo.path, "spaces", "stora", f), "utf8") === t));
  check("…with its index, linked from the root, as one commit, tree clean",
    fs.readFileSync(path.join(repo.path, "MEMORY.md"), "utf8").includes("- [[spaces/stora/MEMORY]]")
      && git(repo.path, "rev-list", "--count", "HEAD").trim() === String(Number(before) + 1) && git(repo.path, "status", "--porcelain") === "");
  await until(async () => (await evalIn(c, textOf(".memory-repo"))).includes("The last check brought in 3 new files"), 10_000, "the row says what came in");
  await choose("-Users-nobody-code-elsewhere", "skip");
  await until(async () => (await api.call("memory.repo.claudeBackfill", { profileId: profile.id })).chosen.some((x) => x.project === "-Users-nobody-code-elsewhere" && x.spaceId === null), 15_000, "left out");
  check("Leave out brings nothing in", git(repo.path, "ls-files").split("\n").every((f) => !f.endsWith("stray.md")));
  const placed = await api.call("memory.repo.claudeBackfill", { profileId: profile.id });
  console.log(`EVIDENCE memory.repo.claudeBackfill after the two choices → ${JSON.stringify({ imported: placed.imported, total: placed.total, unmatched: placed.unmatched, chosen: placed.chosen })}`);
  console.log(`EVIDENCE settings → ${execFileSync("sqlite3", ["-readonly", path.join(home, "realm.db"), "select key || ' = ' || value_json from settings where key like 'memory.claudeProjectSpace:%' order by key"], { encoding: "utf8" }).trim()}`);
  console.log(`EVIDENCE ${path.join(repo.path, "spaces", "stora")}: ${JSON.stringify(fs.readdirSync(path.join(repo.path, "spaces", "stora")))}`);
  console.log(`EVIDENCE git log -1:\n${git(repo.path, "log", "-1", "--format=%h %s", "--name-only")}`);
  check("the placed project keeps its select, on Stora; the left-out one on Leave out", JSON.stringify(await listed()) === JSON.stringify([[ravens, "3 files", stora.id], ["-Users-nobody-code-elsewhere", "1 file", "skip"]]), await listed());
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    await openProfileMemory(c);
    await until(() => evalIn(c, `!!${selectFor(ravens)}`), 10_000, "the placed project's select");
    await openFolds();
    await sleep(400);
    await shot(c, `memory-claude-projects-placed-${mode}`, ".memory-repo");
  }
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
