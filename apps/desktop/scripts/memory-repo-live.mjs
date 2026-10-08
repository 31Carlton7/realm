/**
 * Live check for the memory repo (run with: pnpm build && node apps/desktop/scripts/memory-repo-live.mjs)
 *
 * The profile's Memory page creates an Agent Memory Repo under the scratch home; a session saves a
 * fact through the `realm-memory` tools on the real gateway; the commit lands staged by path and
 * stamped with the session; the page's row follows it without a reload; a space's switch turns the
 * repo off there and the tools go with it. The row is captured in both faces.
 *
 * Nothing is billed: Claude and Codex are the scripted agent's stand-ins (REALM_FAKE_STANDS_IN), so
 * onboarding's session is scripted too, and every message goes to the fake. Ports: LIVE_SERVER_PORT /
 * LIVE_CDP_PORT (8800 / 9240). Scratch under LIVE_SCRATCH (default: the OS temp dir), screenshots under
 * LIVE_SHOTS (default: the scratch's parent). Kills only what holds its own two ports, and only if it is
 * this run's.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8800);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9240);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1280, height: 820 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-memory-repo-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "memory-repo-shots");
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

async function main() {
  const c = await launch();
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
  // Belt and braces over the stand-ins: every session there is runs the scripted agent.
  const sessions = await api.call("sessions.listAll", { profileId: null });
  for (const s of sessions) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  const spaceId = sessions[0].spaceId;
  const [profile] = await api.call("profiles.list", {});
  const repoPath = path.join(home, "memory", "repos", `profile-${profile.id}`);

  // 1. No repo: the page offers both ways in.
  await setFace(c, "dark");
  await openProfileMemory(c);
  const empty = await evalIn(c, textOf(".memory-repo"));
  check("no repo: the row offers Create and Attach existing…", empty.includes("No memory repo") && empty.includes("Create") && empty.includes("Attach existing…"), empty);
  await shot(c, "memory-repo-none-dark", ".memory-repo");

  // 2. Create, from the page.
  await evalIn(c, clickText(".memory-repo button", "Create"));
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Stored at')`), 15_000, "repo created");
  check("Create makes the spec's repo under Realm's home", fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8") === "# Memory\n\n## Index\n");
  check("…as one commit", git(repoPath, "rev-list", "--count", "HEAD").trim() === "1");
  check("the row names where it is", (await evalIn(c, textOf(".memory-repo"))).includes(repoPath));

  // 3. A session saves through the gateway: the scripted agent calls realm-memory__memory_save.
  const { session } = await api.call("sessions.create", { spaceId, agentKind: "fake" });
  await api.call("sessions.send", { id: session.id, text: "remember I prefer tabs" });
  await until(() => fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8").includes("Prefers tabs over spaces"), 20_000, "the saved fact");
  const index = fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8");
  check("the fact sits above ## Index, stamped with the session that learned it", /^# Memory\n\n- Prefers tabs over spaces \[source: realm:session\/[0-9A-Z]+; added: \d{4}-\d{2}-\d{2}\]\n\n## Index\n$/.test(index) && index.includes(session.id), index);
  check("one commit, by path, tree clean", git(repoPath, "log", "-1", "--format=%s").trim() === "Remember Prefers tabs over spaces"
    && git(repoPath, "show", "--name-only", "--format=").trim() === "MEMORY.md" && git(repoPath, "status", "--porcelain") === "");
  await until(() => evalIn(c, `${textOf(".memory-repo")}.includes('Remember Prefers tabs over spaces')`), 10_000, "the row follows the save");
  check("the page's row follows the save without a reload", (await evalIn(c, textOf(".memory-repo"))).includes("Last saved"));

  // 4. Who receives it: a Claude session carries MEMORY.md; the scripted agent (no channel) does not.
  const claudeRow = (await api.call("sessions.create", { spaceId, agentKind: "claude" })).session;
  check("a Claude session's memory sources say the index travels", (await api.call("memory.sources", { sessionId: claudeRow.id })).repoIndexInjected === true);
  check("an agent with no context channel is not told it does", (await api.call("memory.sources", { sessionId: session.id })).repoIndexInjected === false);

  // 5. The row, folded open, in both faces.
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    await openProfileMemory(c);
    await until(() => evalIn(c, `!!document.querySelector('.memory-repo details')`), 10_000, "recent memories");
    await evalIn(c, `(() => { const d = document.querySelector('.memory-repo details'); d.open = true; return true; })()`);
    await sleep(400);
    await shot(c, `memory-repo-${mode}`, ".memory-page > .settings-head:last-of-type, .memory-repo");
  }

  // 6. A space's switch: off there, the tools go with it and a save cannot land.
  await setFace(c, "dark");
  await evalIn(c, `document.querySelector('[aria-label^="More for Homework"]').click(), true`);
  await until(() => evalIn(c, clickText('[role="menuitem"]', "Memory")), 10_000, "space Memory");
  await until(() => evalIn(c, `!!document.querySelector('input[role="switch"][aria-label$="memory repo in this space"]')`), 10_000, "inherited switch");
  await park(c); await sleep(600);
  await shot(c, "memory-repo-space-dark", ".memory-reach");
  await evalIn(c, `document.querySelector('input[role="switch"][aria-label$="memory repo in this space"]').click(), true`);
  await until(async () => (await api.call("memory.repo.get", { spaceId })).repos[0]?.inheritedHere === false, 10_000, "switched off");
  check("the switch reads off and says what that means", (await evalIn(c, textOf(".memory-reach"))).includes("Off in this space"));
  // The user forgets the fact by hand, so a second save would be a real change if it could land.
  fs.writeFileSync(path.join(repoPath, "MEMORY.md"), "# Memory\n\n## Index\n");
  git(repoPath, "-c", "user.name=live", "-c", "user.email=live@localhost", "commit", "-qam", "Forget by hand");
  const before = git(repoPath, "rev-list", "--count", "HEAD").trim();
  const off = (await api.call("sessions.create", { spaceId, agentKind: "fake" })).session;
  await api.call("sessions.send", { id: off.id, text: "remember I prefer tabs" });
  await until(async () => (await api.call("sessions.get", { id: off.id }))?.status === "idle", 15_000, "the turn ends");
  await sleep(500);
  check("with the repo off in the space, the save does not land", git(repoPath, "rev-list", "--count", "HEAD").trim() === before
    && !fs.readFileSync(path.join(repoPath, "MEMORY.md"), "utf8").includes("Prefers tabs"));
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
