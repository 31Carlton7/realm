/**
 * Live check for the next update's leftovers (run with: pnpm build && node apps/desktop/scripts/next-update-leftovers-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, as a window that cannot take focus, with the scripted
 * agent standing in for Claude and Codex, so nothing reaches an account. Then, in one boot:
 *
 *   1. Reports and briefs: a lead hands one sub-agent a brief in parts and another a survey that comes
 *      back long. Each is looked at in the Agents tab's viewer and opened as a session: the brief is
 *      drawn in its parts in both, and each report folds — a long one starting closed — with the
 *      choice following the sub-agent from the viewer to its session.
 *   2. Pictures being made: Codex's image tool in flight, mapped by the adapter itself, beside an MCP
 *      server's, and the icon picker generating (its request held in the page, so no model is asked).
 *   3. A new session with the sidebar on Activity, scrolled far down: the header's button, ⌘N, the
 *      palette's "New Claude session" and "New session in a worktree". Each must land selected, in view,
 *      with its prompter holding the keyboard, in the space of the session that was in front.
 *   4. `corner-shape: squircle` in this Chromium, measured: the area a corner's fill covers.
 *
 * Ports: REALM_PORT (8795) / REALM_DEVTOOLS_PORT (9235). Home: LIVE_HOME. Screenshots go to LIVE_OUT_DIR
 * as `<LIVE_TAG>-<what>-<face>.png`. Kills only what listens on its own ports, and only a process
 * started from this checkout.
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
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9235);
const SERVER_PORT = Number(process.env.REALM_PORT ?? 8795);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const TAG = process.env.LIVE_TAG ?? "leftovers";
const PHASES = new Set((process.env.LIVE_PHASES ?? "reports,media,activity,squircle").split(","));
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = process.env.LIVE_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), "realm-next-update-live-"));
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const home = path.join(scratch, "home");
const VIEWPORT = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
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
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(200);
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

/** Reads a capture back through a canvas, so a measurement comes from what was composited. */
const HELPERS = `
window.__live = window.__live ?? {
  async pixels(b64) {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    return { w: cv.width, h: cv.height, lum: (x, y) => { const i = (y * cv.width + x) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; } };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
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

/** Kill what listens on `port`, but only a process this checkout started. */
function killPort(port) {
  let pids = [];
  try {
    pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { return; }
  for (const pid of pids) {
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { continue; }
    if (!command.includes(repoRoot)) { note("left alone", { port, pid, command: command.slice(0, 120) }); continue; }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function setFace(c, face) {
  await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
  await sleep(350);
}

const box = (c, selector) => evalIn(c, `(() => { const el = ${selector.startsWith("(") ? selector : `document.querySelector(${JSON.stringify(selector)})`}; if (!el) return null;
  const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);

/** A capture of a box and a margin round it, over a ground standing in for the window's material
 *  (which is not in the DOM, so a capture of the translucent grounds comes out see-through). */
async function shoot(c, b, what, face, pad = 8) {
  if (!b) { note(`nothing to capture for ${what}`, face); return; }
  await evalIn(c, `(() => { const r = document.documentElement; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = 'none';
    r.style.background = r.dataset.mode === "light" ? "#e9e9ec" : "#17181b"; getSelection().removeAllRanges(); return true; })()`);
  const vp = await evalIn(c, `({ w: innerWidth, h: innerHeight })`);
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const clip = { x, y, width: Math.min(vp.w - x, b.w + pad * 2), height: Math.min(vp.h - y, b.h + pad * 2), scale: 1 };
  const file = path.join(OUT_DIR, `${TAG}-${what}-${face}.png`);
  try {
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${what}-${face} ${file}`);
  } catch (e) { note("screenshot failed", String(e)); }
  await evalIn(c, `(() => { document.documentElement.style.background = ""; const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = ''; return true; })()`);
}

async function bothFaces(c, what, boxOf, pad) {
  for (const face of ["dark", "light"]) { await setFace(c, face); await shoot(c, await boxOf(), what, face, pad); }
  await setFace(c, "dark");
}

const key = async (c, k, { code = k, mods = 0, vk = 0, text } = {}) => {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, modifiers: mods, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  if (text) await c.send("Input.dispatchKeyEvent", { type: "char", key: k, code, modifiers: mods, text });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers: mods, windowsVirtualKeyCode: vk });
};

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronDir = fs.readdirSync(path.join(repoRoot, "node_modules/.pnpm")).find((d) => d.startsWith("electron@"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm", electronDir, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
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
  await c.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  c.awake = () => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);
  await c.awake();

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.awake();

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  // The onboarding session runs on whatever this Mac can run; it is never typed into, and is put on
  // the scripted agent all the same.
  for (const s of await api.call("sessions.listAll", {})) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("agents.probe", { force: false });
  return c;
}

/** Open a session by its sidebar row, and leave it alone on screen. */
async function openAlone(c, title) {
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-row')].some((b) => b.textContent.includes(${JSON.stringify(title)}))`), 20_000, `row ${title}`);
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-row')].find((b) => b.textContent.includes(${JSON.stringify(title)})).click(); return true; })()`);
  await sleep(900);
}

/* ── 1. Reports and briefs ──────────────────────────────────────────────────────────────────────── */

async function reports(c, space) {
  const TITLE = "Viewer work";
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "claude", model: "claude-opus-5-5", title: TITLE, permissionMode: "default" });
  const lead = session.id;
  await openAlone(c, TITLE);
  await api.call("sessions.send", { id: lead, text: "Hand over a written brief.", attachments: [], mentions: [] });
  await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.length >= 1 && k.every((x) => x.outcome && x.report) ? k : null; }, 60_000, "the brief's child reported");
  await until(async () => (await api.call("sessions.get", { id: lead }))?.status !== "running", 30_000, "lead turn over");
  await api.call("sessions.send", { id: lead, text: "Hand over a survey of the report surfaces.", attachments: [], mentions: [] });
  const kids = await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead })).children; return k.length >= 2 && k.every((x) => x.outcome && x.report) ? k : null; }, 60_000, "the survey's child reported").catch(() => null);
  await until(async () => (await api.call("sessions.get", { id: lead }))?.status !== "running", 30_000, "lead turn over");
  const all = kids ?? (await api.call("delegation.children", { sessionId: lead })).children;
  const brief = all.find((k) => /Fold the report card/.test(k.session.title) || /Where you work/.test(k.goal ?? ""));
  const survey = all.find((k) => k !== brief);
  note("children", all.map((k) => ({ title: k.session.title, report: (k.report ?? "").length })));
  // The files the brief names, so its chips have something real to open.
  const cwd = brief.session.cwd;
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "design.md"), "# Design\n\nCalm, quiet surfaces.\n");
  fs.writeFileSync(path.join(cwd, "src/viewer.tsx"), "export function Viewer() { return null; }\n");

  const lines = await until(() => evalIn(c, `document.querySelectorAll('.transcript .delegation-line .tool-row').length`), 15_000, "the lines");
  note("delegation lines", lines);
  await bothFaces(c, "lead-transcript", () => box(c, "(document.querySelector('.panel[data-focused] .transcript-col') ?? document.querySelector('.transcript-col'))"), 4);

  // The viewer, on the brief's child.
  const openLine = (i) => evalIn(c, `(() => { document.querySelectorAll('.transcript .delegation-line .tool-row')[${i}].click(); return true; })()`);
  await openLine(0);
  await until(() => evalIn(c, `!!document.querySelector('.subagent-view .subagent-brief')`), 15_000, "the viewer with its brief");
  await sleep(1200);
  const viewerTop = async () => { await evalIn(c, `(() => { const t = document.querySelector('.subagent-view .transcript'); if (t) t.scrollTop = 0; return true; })()`); await sleep(300); return box(c, ".subagent-view"); };
  await bothFaces(c, "viewer-brief", viewerTop);
  const result = () => evalIn(c, `(() => { const t = document.querySelector('.subagent-view-result-toggle'); return t ? { expanded: t.getAttribute('aria-expanded'), gist: document.querySelector('.subagent-view-result-gist')?.textContent ?? null } : null; })()`);
  note("brief's report", await result());

  // The survey's child: a long report.
  if (survey) {
    await evalIn(c, `(() => { const tabs = [...document.querySelectorAll('.subagent-switch-tab')]; tabs.find((t) => t.textContent.includes(${JSON.stringify(survey.session.title.slice(0, 20))}))?.click(); return true; })()`);
    await sleep(1200);
    const long = await result();
    note("survey's report", long);
    check("a long report starts closed, its first line in its head", long?.expanded === "false" && !!long.gist, long);
    await bothFaces(c, "viewer-long-report", viewerTop);
    // Opened here, then the sub-agent opened as a session: the report there is open too.
    await evalIn(c, `(() => { document.querySelector('.subagent-view-result-toggle').click(); return true; })()`);
    await sleep(500);
    check("its head opens it", (await result())?.expanded === "true");
    await bothFaces(c, "viewer-long-report-open", viewerTop);
  }

  // Open as session, on the brief's child: what a person sees of the brief and the report there.
  await evalIn(c, `(() => { const tabs = [...document.querySelectorAll('.subagent-switch-tab')]; tabs.find((t) => t.textContent.includes(${JSON.stringify(brief.session.title.slice(0, 20))}))?.click(); return true; })()`);
  await sleep(800);
  await evalIn(c, `(() => { document.querySelector('.subagent-view-open').click(); return true; })()`);
  // The child's own pane: the one session pane outside the viewer whose log opens with its brief.
  const childPane = `(() => [...document.querySelectorAll('.session-pane')].find((p) => p.getBoundingClientRect().width > 0 && !p.closest('.subagent-view')
    && (p.querySelector('.msg-brief') || [...p.querySelectorAll('.msg-user-row')].some((r) => r.textContent.includes('You are a delegated agent')))) ?? null)()`;
  await until(() => evalIn(c, `!!${childPane}`), 15_000, "the child as a session").catch(() => note("child pane", "not found"));
  await sleep(1500);
  const asSession = await evalIn(c, `(() => { const p = ${childPane}; if (!p) return null;
    return { brief: !!p.querySelector('.subagent-brief'), heads: [...p.querySelectorAll('.subagent-brief-head')].map((h) => h.textContent),
      bubble: [...p.querySelectorAll('.msg-user-row')].map((r) => r.textContent.slice(0, 60)), report: p.querySelector('.report-fold, .subagent-view-result')?.textContent.slice(0, 60) ?? null }; })()`);
  note("child opened as a session", asSession);
  const top = async () => { await evalIn(c, `(() => { const p = ${childPane}; const t = p?.querySelector('.transcript'); if (t) t.scrollTop = 0; return true; })()`); await sleep(300);
    return box(c, `(${childPane}?.querySelector('.transcript') ?? null)`); };
  await bothFaces(c, "session-brief", top, 2);
  const foot = async () => { await evalIn(c, `(() => { const p = ${childPane}; const t = p?.querySelector('.transcript'); if (t) t.scrollTop = t.scrollHeight; return true; })()`); await sleep(400);
    return box(c, `(${childPane}?.querySelector('.transcript') ?? null)`); };
  await bothFaces(c, "session-report", foot, 2);
  return { lead, asSession };
}

/* ── 2. Pictures being made ─────────────────────────────────────────────────────────────────────── */

/** What the Codex adapter emits for its image tool's `item/started`, read off the adapter itself. */
function codexStartEvents() {
  const tsx = path.join(repoRoot, "packages/adapters/node_modules/.bin/tsx");
  const code = `import { createCodexMapper } from ${JSON.stringify(path.join(repoRoot, "packages/adapters/src/codex/map-codex.ts"))};
    const m = createCodexMapper();
    console.log(JSON.stringify(m.map("item/started", { item: { type: "imageGeneration", id: "ig_live", status: "inProgress", revisedPrompt: null, result: "", savedPath: null } })));`;
  const file = path.join(scratch, "codex-start.mts");
  fs.writeFileSync(file, code);
  return JSON.parse(execFileSync(tsx, [file], { encoding: "utf8", cwd: repoRoot }).trim().split("\n").pop());
}

async function media(c, space) {
  const started = codexStartEvents();
  note("codex item/started emits", started);
  const make = async (title, agentKind) => {
    const made = await api.call("sessions.create", { spaceId: space.id, agentKind, title });
    return made.session.id;
  };
  const codex = await make("Codex cover art", "codex");
  const mcp = await make("MCP cover art", "fake");
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const seed = (id, calls) => {
    let t = Date.now() - 20_000;
    const ev = [
      [t += 1_000, "user_message", { text: "Make the cover art", attachments: [] }],
      [t += 1_000, "status", { status: "running" }],
      [t += 1_000, "assistant_text", { messageId: "m1", text: "Drawing the cover." }],
      ...calls.map((e) => [t += 1_000, e.type, e.payload]),
    ];
    const sql = ev.map(([ts, type, payload]) => `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(id)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))});`);
    sql.push(`UPDATE sessions SET status = 'running' WHERE id = ${q(id)};`);
    execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), sql.join("\n")]);
  };
  seed(codex, started);
  seed(mcp, [{ type: "tool_call", payload: { toolUseId: "img1", name: "mcp__media__generate_image", input: { prompt: "a calm mountain lake at dawn, mist over the water" }, parentToolUseId: null } }]);
  // Read again from the server, so the window holds both sessions as running, as the seeded log says.
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "reloaded");
  await c.awake();
  await sleep(1200);
  for (const [title, what] of [["Codex cover art", "codex-generating"], ["MCP cover art", "mcp-generating"]]) {
    await openAlone(c, title);
    await sleep(800);
    const seen = await evalIn(c, `(() => { const p = document.querySelector('.panel[data-focused] .session-pane') ?? document.querySelector('.session-pane');
      return { canvas: !!p?.querySelector('.gen-canvas'), cards: p ? p.querySelectorAll('.tool-card').length : 0, lead: p?.querySelector('.tool-card .tool-status[data-on]') ? "turning" : p?.querySelector('.tool-card') ? "glyph" : null }; })()`);
    note(`${what}`, seen);
    if (what === "codex-generating") check("Codex's image tool shows the generating canvas while it runs", seen.canvas, seen);
    check(`${what}: the canvas is the one loader, the row keeping its glyph`, seen.lead === "glyph", seen);
    await bothFaces(c, what, () => box(c, "(document.querySelector('.panel[data-focused] .transcript-col') ?? document.querySelector('.transcript-col'))"), 4);
  }

  // The icon picker generating: its request is held in the page, so no model is ever asked.
  await evalIn(c, `(() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) {
    if (typeof d === "string" && d.includes('"iconAssets.generate"')) return; return send.call(this, d); }; return true; })()`);
  await evalIn(c, `(() => { [...document.querySelectorAll('.sb-foot button')].find((b) => /New space/.test(b.textContent))?.click(); return true; })()`);
  const opened = await until(() => evalIn(c, `!!document.querySelector('.space-identity-row button, .ip-tile, [aria-label^="Choose an icon"], [aria-label*="icon"]')`), 10_000, "new space sheet").catch(() => false);
  if (opened) {
    await evalIn(c, `(() => { const b = document.querySelector('.space-identity-row button') ?? [...document.querySelectorAll('button')].find((x) => /icon/i.test(x.getAttribute('aria-label') ?? '')); b?.click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.icon-picker')`), 5_000, "icon picker").catch(() => note("icon picker", "did not open"));
    await evalIn(c, `(() => { [...document.querySelectorAll('.ip-tab')].find((t) => t.textContent === 'Generated')?.click(); return true; })()`);
    await sleep(300);
    await evalIn(c, `(() => { const t = document.querySelector('.ip-generate-prompt'); if (!t) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "a friendly orange fox"); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await sleep(200);
    await evalIn(c, `(() => { [...document.querySelectorAll('.ip-generate .btn.primary')][0]?.click(); return true; })()`);
    await sleep(700);
    note("icon picker generating", await evalIn(c, `(() => { const p = document.querySelector('.icon-picker'); return p ? { orb: !!p.querySelector('.spinner'), ring: !!p.querySelector('.gen-spin'), button: p.querySelector('.ip-generate .btn.primary')?.textContent } : null; })()`));
    await bothFaces(c, "icon-generating", () => box(c, ".icon-picker"), 12);
    await key(c, "Escape", { vk: 27 });
    await sleep(300);
    await key(c, "Escape", { vk: 27 });
    await sleep(500);
  }
}

/* ── 3. A new session in the Activity view ──────────────────────────────────────────────────────── */

async function activity(c, first) {
  const profiles = await api.call("profiles.list", {});
  const other = await api.call("spaces.create", { name: "Orbit", icon: "folder", profileId: profiles[0].id }).catch(async () => (await api.call("spaces.list", {})).find((s) => s.name === "Orbit"));
  const spaces = [first, other];
  // A list long enough to scroll: sessions in both spaces, moved across three weeks.
  const made = [];
  for (let i = 0; i < 26; i++) {
    const space = spaces[i % 2];
    const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: `${space.name} task ${String(i + 1).padStart(2, "0")}` });
    made.push(session);
  }
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const day = 86_400_000;
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"),
    made.map((s, i) => `UPDATE sessions SET activity_at = ${Date.now() - (i + 1) * day * 0.8} WHERE id = ${q(s.id)};`).join("\n")]);
  // A git checkout under Orbit, so "New session in a worktree" makes a real one.
  const orbitFolder = other.folderPath ?? null;
  note("orbit", { id: other.id, folder: orbitFolder });
  if (orbitFolder) {
    fs.mkdirSync(orbitFolder, { recursive: true });
    const git = (...a) => execFileSync("git", ["-C", orbitFolder, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try { git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(orbitFolder, "README.md"), "# Orbit\n"); git("add", "README.md");
      git("-c", "user.name=Live", "-c", "user.email=live@example.com", "commit", "-q", "-m", "Start"); } catch (e) { note("git", String(e).slice(0, 200)); }
  }
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "reloaded");
  await c.awake();
  await sleep(1500);
  const lensOn = await evalIn(c, `document.querySelector('.sb-lens button[aria-label=Activity]')?.getAttribute('aria-pressed')`);
  if (lensOn !== "true") await evalIn(c, `(() => { document.querySelector('.sb-lens button[aria-label=Activity]').click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.sb-recent .sb-card').length >= 20`), 15_000, "the activity list");

  /** Click the oldest card in Orbit and scroll the list to its foot: the case a new card lands far above. */
  const setUp = async () => {
    await evalIn(c, `(() => { const cards = [...document.querySelectorAll('.sb-recent .sb-card')].filter((x) => x.textContent.includes('Orbit task'));
      cards.at(-1).querySelector('.item-row').click(); return true; })()`);
    await sleep(900);
    await evalIn(c, `(() => { const s = document.querySelector('.space-body'); s.scrollTop = s.scrollHeight; return true; })()`);
    await sleep(500);
  };
  const state = (id) => evalIn(c, `(() => {
    const s = document.querySelector('.space-body'), sr = s.getBoundingClientRect();
    const card = document.querySelector('.sb-card[data-session="${id}"]');
    const r = card?.getBoundingClientRect();
    const a = document.activeElement;
    const pane = a?.closest('.panel');
    return { card: !!card, active: card?.hasAttribute('data-active') ?? false, inView: !!r && r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1,
      space: card?.querySelector('.sb-card-head')?.textContent ?? null, scrollTop: Math.round(s.scrollTop),
      focus: a ? (a.tagName + '.' + (a.className || '').toString().slice(0, 40)) : null, focusPane: pane?.getAttribute('data-item') ?? null, inComposer: !!a?.closest('.composer') }; })()`);
  const sessionsNow = async () => new Set((await api.call("sessions.listAll", {})).map((s) => s.id));
  const items = async (spaceId) => api.call("items.list", { spaceId });

  const paths = [
    ["header", async () => evalIn(c, `(() => { document.querySelector('.sb-header button[aria-label="New session"]').click(); return true; })()`)],
    ["cmd-n", async () => { await evalIn(c, `document.activeElement?.blur?.(), true`); await key(c, "n", { code: "KeyN", mods: 4, vk: 78 }); }],
    ["palette-agent", async () => {
      await evalIn(c, `(() => { document.querySelector('.sb-header button[aria-label="Search"]').click(); return true; })()`);
      await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5_000, "palette");
      await evalIn(c, `(() => { const i = document.querySelector('.palette input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "New Claude session"); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await sleep(400);
      await key(c, "Enter", { vk: 13, text: "\r" });
    }],
    ["palette-worktree", async () => {
      await evalIn(c, `(() => { document.querySelector('.sb-header button[aria-label="Search"]').click(); return true; })()`);
      await until(() => evalIn(c, `!!document.querySelector('.palette input')`), 5_000, "palette");
      await evalIn(c, `(() => { const i = document.querySelector('.palette input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "New session in a worktree"); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await sleep(400);
      await key(c, "Enter", { vk: 13, text: "\r" });
    }],
  ];
  for (const [name, act] of paths) {
    await setUp();
    const before = await sessionsNow();
    const was = await evalIn(c, `document.querySelector('.panel[data-focused]')?.getAttribute('data-item') ?? null`);
    await act();
    const id = await until(async () => [...(await sessionsNow())].find((x) => !before.has(x)), 15_000, `${name}: a new session`).catch(() => null);
    if (!id) { check(`${name}: made a session`, false); continue; }
    const made = (await api.call("sessions.listAll", {})).find((s) => s.id === id);
    await sleep(1600);
    const st = await state(id);
    const own = (await items(made.spaceId)).find((i) => i.refId === id);
    note(`${name}`, { ...st, space: made.spaceId === other.id ? "Orbit" : "Realm", env: made.environmentId, was });
    check(`${name}: the new card is there and selected`, st.card && st.active, st);
    check(`${name}: …in view, however far down the list was`, st.inView, st);
    check(`${name}: …its prompter has the keyboard`, st.inComposer && st.focusPane === own?.id, st);
    check(`${name}: …in the space of the session that was in front (Orbit)`, made.spaceId === other.id, { space: made.spaceId });
    await bothFaces(c, `activity-${name}`, () => box(c, ".sidebar"), 0);
  }
}

/* ── 4. corner-shape in this Chromium ───────────────────────────────────────────────────────────── */

async function squircle(c) {
  const chrome = await evalIn(c, `navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] ?? null`);
  note("chromium", chrome);
  await evalIn(c, `(() => {
    const ground = document.createElement('div'); ground.id = 'live-corners';
    ground.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;gap:40px;padding:40px';
    for (const shape of ['round', 'squircle']) { const b = document.createElement('div'); b.dataset.shape = shape;
      b.style.cssText = 'width:240px;height:240px;background:#fff;border-radius:64px;' + (shape === 'squircle' ? 'corner-shape:squircle;' : ''); ground.append(b); }
    document.body.append(ground); return CSS.supports('corner-shape', 'squircle'); })()`).then((s) => note("CSS.supports(corner-shape: squircle)", s));
  await sleep(300);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const fills = await evalIn(c, `(async () => { const p = await __live.pixels(${JSON.stringify(data)}); const dpr = p.w / innerWidth;
    return [...document.querySelectorAll('#live-corners > div')].map((el) => { const r = el.getBoundingClientRect(); const R = 64 * dpr;
      const x0 = Math.round(r.left * dpr), y0 = Math.round(r.top * dpr); let n = 0;
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) if (p.lum(x0 + x, y0 + y) > 127) n++;
      return { shape: el.dataset.shape, fill: +(n / (R * R)).toFixed(3) }; }); })()`);
  note("corner fill (circle π/4 = 0.785, superellipse n=4 = 0.927)", fills);
  check("corner-shape: squircle draws a superellipse natively", fills.find((f) => f.shape === "squircle")?.fill > 0.88, fills);
  await shoot(c, await box(c, "#live-corners"), "corner-shape", "dark", 0);
  await evalIn(c, `(document.getElementById('live-corners').remove(), true)`);
}

async function main() {
  const c = await boot();
  const [space] = await api.call("spaces.list", {});
  if (PHASES.has("squircle")) await squircle(c);
  if (PHASES.has("reports")) await reports(c, space);
  if (PHASES.has("media")) await media(c, space);
  if (PHASES.has("activity")) await activity(c, space);
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  electron?.kill("SIGKILL");
  await sleep(500);
  await stopDaemons(home);
  for (const p of [SERVER_PORT, CDP_PORT]) killPort(p);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
