/**
 * Live check for the card surfaces (run with: pnpm build && node apps/desktop/scripts/cards-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, as a scratch window that cannot take focus, with the
 * scripted agent standing in for every engine, so nothing reaches an account. One session runs a
 * turn that drafts a plan and really edits its checkout (a git repository made for it), then fans out
 * five of the harness's own background agents and ends its turn while they work — the "5 sub-agents
 * working" the owner screenshotted, which now lives on the row over the prompter and, a click away,
 * as five cards in the session's Agents tab — then asks a permission and a question. A second session
 * orchestrates four delegated children, for the pinned report.
 *
 * Every card family is photographed in both faces: the Agents tab, the report, the plan,
 * the edit card, the permission and question cards, a settings group, the engines, Usage, the theme's
 * Light / Dark / System tiles, the Library, a scheduled task,
 * and — for the families that take a team or a pull request to reach — the same classes laid into the
 * window as a gallery, under the real stylesheet and the real painter. A corner of the first of the
 * five cards is captured at 4× in both faces, beside the same corner under the old rules.
 *
 * Measured, on that card, in the composited pixels:
 *   - its corner is the painter's superellipse, not a circular arc (the fill covers ~0.927 of the
 *     corner square, a circle ~0.785) — and with the gate off, the same measurement finds the circle
 *   - no rim: the pixel just inside its side edge is the fill, not a line brighter (dark) or darker
 *     (light) than the fill beside it, and nothing along its top edge either
 *   - on the dark face, the fill alone stands the card off its ground
 *   - the lift: the ground under the card is darker than the ground beside the window's edge
 *
 * Screenshots go to LIVE_OUT_DIR as `<LIVE_TAG>-<what>-<face>.png`, so a run before a change and one
 * after it sit side by side. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT. Kills only what listens on its
 * own ports, and only a process started from this checkout.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9266);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8826);
const OUT_DIR = process.env.LIVE_OUT_DIR ?? os.tmpdir();
const TAG = process.env.LIVE_TAG ?? "run";
fs.mkdirSync(OUT_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-cards-live-"));
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

/** The areas the two corner shapes cover in their R×R square: Γ(1+1/n)²/Γ(1+2/n) at n = 4, and π/4. */
const SQUIRCLE = 0.927, CIRCLE = Math.PI / 4;
const TOL = (SQUIRCLE - CIRCLE) / 2;

/** The five background agents, and the turns around them. Long-running, so the card stays "working"
 *  for as long as the check needs it. */
const FIVE = ["Gateway rule engine", "Realmite runner game", "Settings copy pass", "Theme migration", "Release notes draft"];
const SCRIPT = [
  { on: "Draft the rollout", emit: [
    { kind: "plan", planId: "rollout", text: "Roll the theme switch out in three steps, each one shippable on its own.", steps: [
      { text: "Store the choice in a column of its own", status: "completed" },
      { text: "Add the toggle to Settings ▸ App", status: "in_progress" },
      { text: "Follow the Mac until someone picks", status: "pending" },
    ] },
    { kind: "tool", name: "Write", input: { file_path: "notes/rollout.md", content: "# Rollout\n\n- Store the choice\n- Add the toggle\n- Follow the Mac\n" }, result: "File created successfully at: notes/rollout.md", apply: true },
    { kind: "tool", name: "Edit", input: { file_path: "src/theme.ts", old_string: "\"dark\"", new_string: "\"system\"" }, result: "The file src/theme.ts has been updated.", apply: true },
    { kind: "tool", name: "Bash", input: { command: "pnpm vitest run theme" }, result: "Tests  6 passed (6)" },
    { kind: "text", paceMs: 20, text: "Wrote the rollout down and made the default follow the Mac. The six theme tests pass." },
  ] },
  { on: "Fan out the release work", emit: [
    { kind: "text", paceMs: 20, text: "Five parts that do not touch each other, so five agents in the background." },
    ...FIVE.map((description) => ({ kind: "background", description, prompt: `Work on: ${description}.`, runMs: 900_000 })),
    { kind: "text", paceMs: 20, text: "All five are running. I'll read their reports as they come in." },
  ] },
  { on: "Check before deploying", emit: [
    { kind: "tool", name: "Bash", needsPermission: true, input: { command: "pnpm deploy --dry-run" }, result: "Dry run: 14 files would change." },
    { kind: "tool", name: "AskUserQuestion", needsPermission: true, result: "Answered", input: { questions: [{ question: "Which channel should the release go to first?", header: "Channel",
      multiSelect: false, options: [{ label: "Beta", description: "The people who asked for early builds" }, { label: "Everyone" }] }] } },
    { kind: "text", text: "Going to the beta channel first." },
  ] },
];

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
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  return {
    ready, errors,
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

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=live@example.com", "-c", "user.name=Live", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** Helpers that live in the page. The samplers read a screenshot back through a canvas, so every
 *  number comes from what was COMPOSITED rather than from what the CSSOM claims. */
const HELPERS = `globalThis.__live = {
  async openSettings() {
    if (document.querySelector(".settings-page-pane")) return true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    return !!document.querySelector(".settings-page-pane");
  },
  async sampler(b64) {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    const dpr = img.width / window.innerWidth;
    const lum = (x, y) => { const i = ((Math.floor(y * dpr) * cv.width) + Math.floor(x * dpr)) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
    const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
    const tone = (x0, y0, x1, y1) => { const xs = []; for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) xs.push(lum(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6)); return median(xs); };
    return { lum, tone, dpr };
  },
  /** Fraction of an element's R×R top-left corner square its own fill covers (squircle-live's method:
   *  reference tones from this shot, the square anchored by walking in from the ground). */
  async cornerFill(b64, sel) {
    const s = await this.sampler(b64);
    const el = document.querySelector(sel);
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const R = Math.round(parseFloat(cs.getPropertyValue("--sq-radius-top")) || parseFloat(cs.borderTopLeftRadius) || 0);
    if (R < 8) return { error: "radius too small to measure", R };
    const inside = s.tone(box.left + R + 2, box.top + 1.5, Math.min(box.right - 2, box.left + 3 * R), box.top + 4.5);
    /* The ground BESIDE the card, in the padding of the column it stands in: above a list's first card
       is the list's heading, and further out is another pane. */
    const outside = s.tone(box.left - 12, box.top + R, box.left - 6, box.bottom - R);
    if (Math.abs(inside - outside) < 3) return { error: "fill and ground are indistinguishable", inside, outside };
    const mid = (inside + outside) / 2;
    const isFill = (x, y) => (inside > outside ? s.lum(x, y) > mid : s.lum(x, y) < mid);
    const near = box.top + R - 0.5;
    let x0 = Math.round(box.left);
    for (let v = Math.round(box.left) - 4; v <= box.left + R; v++) { if (isFill(v + 0.5, near)) { x0 = v; break; } }
    let y0 = Math.round(box.top);
    for (let v = Math.round(box.top) - 4; v <= box.top + R; v++) { if (isFill(box.left + R - 0.5, v + 0.5)) { y0 = v; break; } }
    let filled = 0;
    for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) if (isFill(x0 + dx + 0.5, y0 + dy + 0.5)) filled++;
    return { fraction: +(filled / (R * R)).toFixed(3), R, inside: Math.round(inside), outside: Math.round(outside) };
  },
  /** The luminance of each device pixel across the element's LEFT edge, at its middle, from 4px out
   *  to 8px in — where a rim is a pixel or two lighter (dark) or darker (light) than the fill. */
  async edgeProfile(b64, sel) {
    const s = await this.sampler(b64);
    const box = document.querySelector(sel).getBoundingClientRect();
    const ys = [0.35, 0.45, 0.55, 0.65].map((f) => box.top + box.height * f);
    const out = [];
    for (let d = -4; d < 8; d += 1 / s.dpr) out.push(+(ys.reduce((t, y) => t + s.lum(box.left + d + 0.25 / s.dpr, y), 0) / ys.length).toFixed(1));
    return { profile: out, dpr: s.dpr };
  },
}; true`;

/** A sub-agent's card as it was (275ee38a): its rim, at the old token's value per face, and its
 *  circular corner, laid back over the painted card. Also the live mutant for "no rim". */
const OLD_CARD = {
  dark: `.subagents-list .subagent-card { border: var(--hairline-w) solid #ffffff05 !important; border-radius: var(--r-panel) !important;
  background: var(--rl-card) !important; box-shadow: none !important; }`,
  light: `.subagents-list .subagent-card { border-color: #03071208 !important; }`,
};

/** The theme tiles' rules before this change, word for word, for the before shot. */
const OLD_TILES = `.mode-card { border: var(--hairline-w) solid var(--rl-line) !important; border-radius: var(--r-panel) !important;
  background: var(--rl-panel) !important; }
.mode-card[data-selected] { box-shadow: 0 0 0 2px var(--rl-accent) !important; }
.mode-card[data-selected] .mode-card-name { color: inherit !important; }`;

/** The gallery: the families that take a team, a pull request or a dropped folder to reach, laid into
 *  the window with the classes their components render, so the stylesheet and the painter draw them
 *  exactly as they draw the real thing. */
const GALLERY = `
  <div class="tc-card"><span class="tc-card-title">Launch post for Friday</span><span class="tc-card-line">A draft for Instagram, three slides</span></div>
  <div class="tc-card"><span class="tc-card-title">Handed to Writer</span><span class="tc-card-line">“Tighten the caption to one line.”</span></div>
  <figure class="rv-why"><span class="rv-why-who">Why Researcher made this</span><p class="rv-why-text">The retention numbers moved after the onboarding change, so this compares the two cohorts.</p></figure>
  <div class="rv-paper"><div class="rv-paper-name">notes.md</div>Retention held at 41% for the cohort that saw the new first run, against 34% for the one before it.</div>
  <div class="ps-rows"><div><dt>Turns</dt><dd>12, with every tool call</dd></div><div><dt>Files</dt><dd>3 attached, 2 made</dd></div></div>
  <div class="tp-card"><b>Writer</b><span>Drafts posts from what the team made this week.</span></div>
  <div class="cr-note"><p class="cr-note-by">Review with Opus</p><div class="cr-note-body">A token that ends on a chunk boundary is pushed before the next chunk arrives.</div></div>
  <div class="library-offer"><p class="library-offer-text">Add the 14 files in “Screenshots” to the Library?</p></div>
  <div class="stat-tile"><span class="stat-label">Spent this week</span><span class="stat-value">$41.20</span></div>
`;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const script = path.join(scratch, "script.json");
  fs.writeFileSync(script, JSON.stringify(SCRIPT));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1", REALM_FAKE_SCRIPT: script,
      // Claude and Codex are the scripted agent: onboarding's session, the leads and every child.
      REALM_FAKE_STANDS_IN: "claude,codex", REALM_GH_BIN: path.join(scratch, "no-gh"),
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
  const awake = () => evalIn(c, `(() => { const r = document.documentElement; r.removeAttribute("data-window-inactive");
    new MutationObserver(() => r.hasAttribute("data-window-inactive") && r.removeAttribute("data-window-inactive")).observe(r, { attributes: true }); return true; })()`);
  await awake();

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await awake();
  await evalIn(c, HELPERS);
  const runtime = await evalIn(c, `({ chromium: navigator.userAgent.match(/Chrome\\/[0-9.]+/)?.[0], squircle: document.documentElement.hasAttribute('data-squircle'),
    cornerShape: CSS.supports("corner-shape", "squircle") })`);
  note("runtime", runtime);
  check("the painter loaded in the real bundle", runtime.squircle);

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [session] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "a session");
  // Before anything is sent: no turn of this check may reach a real, billed agent.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  check("the session is on the scripted agent before anything is sent", (await api.call("sessions.get", { id: session.id })).agentKind === "fake");
  const cwd = session.cwd;
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/theme.ts"), "export const defaultTheme = \"dark\";\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Realm\n");
  git(cwd, "init", "-q", "-b", "main"); git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "Start");

  const idle = (id) => until(async () => (await api.call("sessions.get", { id }))?.status === "idle", 60_000, "idle");
  await api.call("sessions.send", { id: session.id, text: "Draft the rollout and make the default follow the Mac.", attachments: [], mentions: [] });
  await idle(session.id);
  await api.call("sessions.send", { id: session.id, text: "Fan out the release work.", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.composer-overstrip .active-agent')`), 30_000, "the agents on the row over the prompter");
  await idle(session.id);
  await sleep(1200);

  // ── The five, on the Agents tab: measured, then photographed ─────────────────────────────────────
  /* The card the owner screenshotted — "5 sub-agents working" under the last message — is retired;
     the five now live on the row over the prompter, and each is a card in the session's Agents tab.
     A chip on the row opens the tab on its agent; the first of the tabs along its top goes back to all. */
  await evalIn(c, `document.querySelector('.composer-overstrip .active-agent')?.click(), true`);
  await until(() => evalIn(c, `!!document.querySelector('.subagent-switch-tab')`), 10_000, "the Agents tab");
  await evalIn(c, `[...document.querySelectorAll('.subagent-switch-tab')][0].click(), true`);
  await until(() => evalIn(c, `document.querySelectorAll('.subagents-list .subagent-card').length >= 5`), 10_000, "five cards");
  await sleep(800);
  note("cards", await evalIn(c, `[...document.querySelectorAll('.subagents-list .subagent-card')].map((c) => c.querySelector('.subagent-task')?.textContent)`));
  const CARD = ".subagents-list .subagent-card";
  const shot = async () => (await c.send("Page.captureScreenshot", { format: "png" })).data;
  await groundFor(c, "dark");
  /** Read across the left edge: the ground well outside, the ground just outside (the lift), the
   *  first pixel of the card (where a rim would be) and the fill further in. */
  const edgeOf = (edge) => {
    const at = (css) => edge.profile[Math.round((css + 4) * edge.dpr)];
    const first = edge.profile.findIndex((v, i) => i > 0 && Math.abs(v - at(6)) < Math.abs(v - at(-4)));
    return { far: at(-4), near: (at(-1) + at(-0.5)) / 2, rim: edge.profile[first], fill: at(6) };
  };
  for (const face of ["dark", "light"]) {
    await setFace(c, face);
    const b64 = await shot();
    const corner = await evalIn(c, `__live.cornerFill(${JSON.stringify(b64)}, ${JSON.stringify(CARD)})`);
    note(`${face}: the card's corner`, corner);
    const edge = await evalIn(c, `__live.edgeProfile(${JSON.stringify(b64)}, ${JSON.stringify(CARD)})`);
    note(`${face}: the card's left edge, 4px out to 8px in`, edge.profile.join(" "));
    const e = edgeOf(edge);
    check(`${face}: no rim — the card's first pixel is its fill, not a line ${face === "dark" ? "lighter" : "darker"} than it`,
      Math.abs(e.rim - e.fill) <= 1.5, e);
    check(`${face}: the lift — the ground at the card's edge is darker than the ground away from it`, e.near < e.far - 1, e);
    if (face === "dark") {
      check("dark: the corner is the painter's superellipse, not a circular arc", Math.abs(corner.fraction - SQUIRCLE) < TOL, corner);
      const top = await evalIn(c, `(async () => { const s = await __live.sampler(${JSON.stringify(b64)}); const b = document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect();
        const x = b.left + b.width * 0.6; return { top: s.lum(x, b.top + 0.25), below: s.lum(x, b.top + 3) }; })()`);
      check("dark: nothing along the top edge either — its first pixel is the fill", Math.abs(top.top - top.below) <= 1.5, top);
      check("dark: the card stands off its ground by its fill alone — at least 8 levels", e.fill - e.far >= 8, { fill: e.fill, ground: e.far });
      // The live mutant: the old rim put back. The same reading has to see it.
      await evalIn(c, `(() => { const st = document.createElement('style'); st.id = 'live-rim'; st.textContent = ${JSON.stringify(OLD_CARD.dark)}; document.head.append(st); return true; })()`);
      await sleep(300);
      const rimmed = edgeOf(await evalIn(c, `__live.edgeProfile(${JSON.stringify(await shot())}, ${JSON.stringify(CARD)})`));
      check("the mutant: with the old rim put back, the same reading finds a line lighter than the fill", rimmed.rim > rimmed.fill + 1.5, rimmed);
      await evalIn(c, `document.getElementById('live-rim')?.remove(), true`);
      await sleep(300);
    }
    const style = await evalIn(c, `(() => { const cs = getComputedStyle(document.querySelector(${JSON.stringify(CARD)}));
      return { border: cs.borderLeftWidth + " " + cs.borderLeftStyle, radius: cs.borderTopLeftRadius, image: cs.backgroundImage.slice(0, 40), shadow: cs.boxShadow }; })()`);
    note(`${face}: the card's computed edge`, style);
    await shotOf(c, ".subagents-list", "agents-cards", face, { pad: 16 });
    await zoomCorner(c, CARD, "agents-corner", face);
    // The card as it was (275ee38a), for the before half of the corner sheet: its old rules laid back on.
    await evalIn(c, `(() => { const st = document.createElement('style'); st.id = 'live-old-card'; st.textContent = ${JSON.stringify(OLD_CARD.dark)}.concat(document.documentElement.dataset.mode === "light" ? ${JSON.stringify(OLD_CARD.light)} : ""); document.head.append(st); return true; })()`);
    await sleep(300);
    await zoomCorner(c, CARD, "agents-corner-old", face);
    await evalIn(c, `document.getElementById('live-old-card')?.remove(), true`);
    await sleep(300);
  }
  await setFace(c, "dark");
  // The mutant for the corner measurement: without the gate the fallback's circle has to come back.
  await evalIn(c, `document.documentElement.removeAttribute('data-squircle'), true`);
  await sleep(300);
  const unpainted = await evalIn(c, `__live.cornerFill(${JSON.stringify(await shot())}, ${JSON.stringify(CARD)})`);
  check("the mutant: with the painter's gate off, the same measurement finds the fallback's circle", Math.abs(unpainted.fraction - CIRCLE) < TOL, unpainted);
  if (runtime.squircle) await evalIn(c, `document.documentElement.setAttribute('data-squircle', ''), true`);
  await sleep(300);
  await evalIn(c, `(() => { const t = document.querySelector('.panel .transcript'); t.scrollTop = t.scrollHeight; return true; })()`);
  await sleep(300);

  // ── The turn above it: the plan, the edit card, a tool's panel ───────────────────────────────
  for (const [sel, what] of [[".panel .plan-card", "plan"], [".panel .edit-summary", "edits"]]) {
    const there = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()`);
    if (!there) { note(`no ${what} card`, sel); continue; }
    await sleep(400);
    for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, sel, what, face, { pad: 24 }); }
    await setFace(c, "dark");
  }
  const bash = await evalIn(c, `(() => { const row = [...document.querySelectorAll('.panel .tool-row')].find((r) => r.textContent.includes('vitest')); if (!row) return false; row.click(); return true; })()`);
  if (bash) {
    await sleep(600);
    await evalIn(c, `document.querySelector('.panel .tool-panel')?.scrollIntoView({ block: "center" }), true`);
    for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".panel .tool-panel", "tool-panel", face, { pad: 24 }); }
    await setFace(c, "dark");
  }

  // ── A permission, then a question ─────────────────────────────────────────────────────────────
  await api.call("sessions.send", { id: session.id, text: "Check before deploying.", attachments: [], mentions: [] });
  if (await until(() => evalIn(c, `!!document.querySelector('.panel .permission-card button[data-decision="allow"]')`), 20_000, "permission").catch(() => false)) {
    await evalIn(c, `(() => { const t = document.querySelector('.panel .transcript'); t.scrollTop = t.scrollHeight; return true; })()`);
    await sleep(500);
    for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".panel .permission-card", "permission", face, { pad: 24 }); }
    await setFace(c, "dark");
    await evalIn(c, `document.querySelector('.panel .permission-card button[data-decision="allow"]').click(), true`);
  }
  if (await until(() => evalIn(c, `!!document.querySelector('.panel .question-card .question-option')`), 20_000, "question").catch(() => false)) {
    await sleep(500);
    for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".panel .question-card", "question", face, { pad: 24 }); }
    await setFace(c, "dark");
    await evalIn(c, `[...document.querySelectorAll('.panel .question-card .question-option')].find((x) => x.textContent.includes("Beta")).click(), true`);
  }
  await idle(session.id).catch(() => null);

  // ── A second lead, for the pinned report ──────────────────────────────────────────────────────
  try {
    const [space] = await api.call("spaces.list", {});
    const { session: lead } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Theme work", permissionMode: "default" });
    await api.call("sessions.send", { id: lead.id, text: "Orchestrate the theme work.", attachments: [], mentions: [] });
    const kids = await until(async () => { const k = (await api.call("delegation.children", { sessionId: lead.id })).children; return k.length === 4 ? k : null; }, 30_000, "four children");
    // Answer the two that ask, over the wire: this section is about the report card, not the asking.
    for (const kid of kids) {
      const id = kid.session.id;
      const s = await until(async () => { const g = await api.call("sessions.get", { id }); return g?.status ? g : null; }, 10_000, "child");
      note("child", { goal: kid.goal, status: s.status });
    }
    // The copy pass is done in a second, and its report is the one pinned below.
    await until(async () => (await api.call("delegation.children", { sessionId: lead.id })).children.some((x) => x.outcome && x.goal?.startsWith("Tidy")), 60_000, "the copy pass settled");
    await evalIn(c, `(() => { const row = [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Theme work")); row?.click(); return !!row; })()`);
    await sleep(1200);
    await evalIn(c, `(() => { const line = [...document.querySelectorAll('.transcript .delegation-line .tool-row')].find((b) => (b.getAttribute('aria-label') ?? '').includes('Tidy the Settings')); line?.click(); return !!line; })()`);
    if (await until(() => evalIn(c, `!!document.querySelector('.subagent-view-result')`), 15_000, "pinned report").catch(() => false)) {
      await sleep(600);
      for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".subagent-view", "report", face, { pad: 0 }); }
      await setFace(c, "dark");
    }
  } catch (e) { note("the report section did not run", String(e?.message ?? e)); }

  // ── A settings group ──────────────────────────────────────────────────────────────────────────
  if (await evalIn(c, `__live.openSettings()`).catch(() => false)) {
    await sleep(800);
    for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".settings-page-pane .settings-list, .settings-page-pane .settings-group", "settings", face, { pad: 24 }); }
    await setFace(c, "dark");
    // Two more pages of cards: the engines' run, and Usage's tiles and cards.
    for (const [tab, sel, what] of [["Appearance", '.settings-row[data-setting="theme"]', "mode-tiles"], ["Engines", ".engines-list", "engines"], ["Usage", ".usage-panel", "usage"]]) {
      await evalIn(c, `[...document.querySelectorAll('.settings-tab, .page-rail button, .page-rail label, [role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(tab)})?.click(), true`);
      if (!(await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(sel)})`), 8_000, tab).catch(() => false))) { note(`no ${what} page`, sel); continue; }
      await sleep(900);
      for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, sel, what, face, { pad: 16 }); }
      if (what === "mode-tiles") {
        // The tiles as they were: the old rules (275ee38a) laid back over the new ones, verbatim.
        await evalIn(c, `(() => { const st = document.createElement('style'); st.id = 'live-old-tiles'; st.textContent = ${JSON.stringify(OLD_TILES)}; document.head.append(st); return true; })()`);
        for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, sel, "mode-tiles-old", face, { pad: 16 }); }
        await evalIn(c, `document.getElementById('live-old-tiles')?.remove(), true`);
      }
      await setFace(c, "dark");
    }
    await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await sleep(500);
  } else note("settings did not open", null);

  // ── The Library, with a picture and two files in it ───────────────────────────────────────────
  try {
    const png = path.join(repoRoot, "resources/icon.png");
    const notes = path.join(scratch, "theme-notes.md"); fs.writeFileSync(notes, "# Theme notes\n\nWhich surfaces read the theme.\n");
    const data = path.join(scratch, "cohorts.csv"); fs.writeFileSync(data, "cohort,retained\nbefore,0.34\nafter,0.41\n");
    await api.call("sessions.send", { id: session.id, text: "Here are the notes.", mentions: [], attachments: [
      { path: png, mime: "image/png", name: "icon.png", size: fs.statSync(png).size },
      { path: notes, mime: "text/markdown", name: "theme-notes.md", size: fs.statSync(notes).size },
      { path: data, mime: "text/csv", name: "cohorts.csv", size: fs.statSync(data).size },
    ] });
    await idle(session.id).catch(() => null);
    await evalIn(c, `document.querySelector('.app-rail .rail-btn[aria-label^="Library"]')?.click(), true`);
    if (await until(() => evalIn(c, `document.querySelectorAll('.library-tile').length >= 2`), 15_000, "library tiles").catch(() => false)) {
      await sleep(1500);
      for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".library-grid", "library", face, { pad: 20 }); }
      await setFace(c, "dark");
    }
    await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await sleep(400);
  } catch (e) { note("the Library section did not run", String(e?.message ?? e)); }

  // ── A scheduled task ──────────────────────────────────────────────────────────────────────────
  try {
    const [space] = await api.call("spaces.list", {});
    await api.call("schedules.create", { spaceId: space.id, title: "Release notes", goal: "Draft the week's release notes from the merged pull requests.", cron: "0 9 * * 1", enabled: true,
      constraints: null, newSessionPerRun: true, archiveSucceeded: false });
    await evalIn(c, `[...document.querySelectorAll('.app-rail .rail-btn')].find((b) => b.getAttribute('aria-label') === 'Scheduled tasks')?.click(), true`);
    await until(() => evalIn(c, `!!document.querySelector('.schedules-page')`), 10_000, "schedules page");
    await until(() => evalIn(c, `!!document.querySelector('.sched-task .sched-task-hit')`), 10_000, "task row");
    await evalIn(c, `[...document.querySelectorAll('.sched-task')].find((t) => t.textContent.includes('Release notes'))?.querySelector('.sched-task-hit')?.click(), true`);
    if (await until(() => evalIn(c, `!!document.querySelector('.sched-card')`), 10_000, "task card").catch(() => false)) {
      await sleep(600);
      for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, ".sched-card", "scheduled", face, { pad: 20 }); }
      await setFace(c, "dark");
    }
    await evalIn(c, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await sleep(400);
  } catch (e) { note("the scheduled section did not run", String(e?.message ?? e)); }

  // ── The gallery ───────────────────────────────────────────────────────────────────────────────
  await evalIn(c, `(() => { const g = document.createElement("div"); g.id = "live-gallery";
    g.style.cssText = "position:fixed;left:360px;top:80px;width:460px;display:flex;flex-direction:column;gap:14px;padding:28px;z-index:9999;background:var(--rl-panel)";
    g.innerHTML = ${JSON.stringify(GALLERY)}; document.body.appendChild(g); return true; })()`);
  await sleep(500);
  for (const face of ["dark", "light"]) { await setFace(c, face); await shotOf(c, "#live-gallery", "gallery", face, { pad: 0 }); }
  await setFace(c, "dark");
  await evalIn(c, `document.getElementById("live-gallery")?.remove(), true`);

  // ── What it costs: 120 painted cards, scrolled and then resized, with the painter on and off ────
  await evalIn(c, `(() => { const g = document.createElement("div"); g.id = "live-cost";
    g.style.cssText = "position:fixed;left:360px;top:60px;width:520px;height:760px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:20px;z-index:9999;background:var(--rl-panel)";
    g.innerHTML = Array.from({ length: 120 }, (_, i) => '<div class="tc-card"><span class="tc-card-title">Card ' + i + '</span><span class="tc-card-line">A line about what it is</span></div>').join("");
    document.body.appendChild(g); return true; })()`);
  await sleep(600);
  const frames = (what) => evalIn(c, `new Promise((done) => { const g = document.getElementById("live-cost"); const times = []; let last = performance.now(), i = 0;
    const step = (t) => { times.push(t - last); last = t; i++;
      if (${JSON.stringify(what)} === "scroll") g.scrollTop = (i * 37) % (g.scrollHeight - g.clientHeight); else g.style.width = (420 + (i % 30) * 6) + "px";
      if (i < 90) requestAnimationFrame(step); else { times.sort((a, b) => a - b); done({ median: +times[45].toFixed(1), p95: +times[85].toFixed(1), worst: +times[89].toFixed(1) }); } };
    requestAnimationFrame(step); })`);
  const cost = {};
  for (const gate of ["painted", "unpainted"]) {
    if (gate === "unpainted") await evalIn(c, `document.documentElement.removeAttribute('data-squircle'), true`);
    await sleep(400);
    cost[gate] = { scroll: await frames("scroll"), resize: await frames("resize") };
  }
  if (runtime.squircle) await evalIn(c, `document.documentElement.setAttribute('data-squircle', ''), true`);
  await evalIn(c, `document.getElementById("live-cost")?.remove(), true`);
  note("frame times (ms) with 120 cards, painter on vs off — scrolling, and resizing every frame", cost);

  const errs = c.errors.filter((e) => !/Autofill|favicon/i.test(e));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
}

async function setFace(c, face) {
  await evalIn(c, `(() => { document.documentElement.dataset.mode = ${JSON.stringify(face)}; return true; })()`);
  await groundFor(c, face);
  await sleep(350);
}

/** A ground standing in for the window's material, which is not in the DOM: without it a capture of
 *  the translucent panes comes out see-through. */
async function groundFor(c, face) {
  await evalIn(c, `(() => { const b = document.getElementById('live-scratch-banner'); if (b) b.style.display = 'none';
    document.documentElement.style.background = ${JSON.stringify(face === "light" ? "#e9e9ec" : "#17181b")}; return true; })()`);
}

async function shotOf(c, selector, what, face, { pad = 8, tail = 0 } = {}) {
  const box = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  if (!box) { note(`nothing to capture for ${what}`, selector); return; }
  let { x, y, w, h } = box;
  if (tail && h > tail) { y = y + h - tail; h = tail; }
  const clip = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(VIEWPORT.width, w + pad * 2), height: Math.min(VIEWPORT.height - Math.max(0, y - pad), h + pad * 2), scale: 1 };
  const file = path.join(OUT_DIR, `${TAG}-${what}-${face}.png`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${what}-${face} ${file}`);
}

/** The top-left corner of an element at 4× — 40 CSS pixels square, so the curve and whatever runs
 *  along the edge are each several device pixels wide. */
async function zoomCorner(c, selector, what, face) {
  const box = await evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const clip = { x: box.x - 8, y: box.y - 8, width: 40, height: 40, scale: 4 };
  const file = path.join(OUT_DIR, `${TAG}-${what}-${face}.png`);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${what}-${face} ${file}`);
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
