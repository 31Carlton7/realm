/**
 * Live check for Plan 27's sidebar and rail (run with: node apps/desktop/scripts/sidebar-rail-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME (run `pnpm build` first), seeds two profiles of spaces
 * with fake sessions held in every state over the RPC socket, and measures what jsdom cannot see:
 *
 *   1. The rail is the window's left edge: the traffic lights' band at its top, the destinations under
 *      it, Home wearing no count of its own — and it stays on screen when the sidebar collapses, the
 *      panes taking the column's room and nothing else.
 *   2. The sidebar lists no strip, no Open section, no Other spaces and no "N need you" pill.
 *   3. Needs you appears only once something waits, lists every space and profile's waiting sessions
 *      longest first, and answers a permission in place: the row goes.
 *   4. Each space is a section: its head in the space's colour with its tally at the far end, its
 *      sessions on the head's name, five then Show more, a fan-out folded into one row, a schedule's
 *      session wearing a clock. A section folds, and a reload finds it folded.
 *   5. Recent lists the profile's sessions by when they last moved, and a reload keeps the lens.
 *   6. A session's pane bar reads Homework › title, the space's icon in the section's colour.
 *
 * Layout measurements are paired with a mutant that reproduces the failure they pin. Screenshots of
 * both faces, sidebar open and collapsed, are written to LIVE_SHOTS (default: the OS temp dir).
 *
 * Sessions are the fake agent's, created over RPC; the onboarding session is switched to the fake
 * before anything could reach it, and nothing types into a composer. Ports are this script's own
 * (server 8975, renderer CDP 9375, main inspector 9475). Touches only a scratch dir; stops only the
 * processes it started; and checks that no agent wrote a transcript under ~/.claude/projects.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8975);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9375);
const MAIN_INSPECT_PORT = Number(process.env.LIVE_MAIN_INSPECT_PORT ?? 9475);
/** Chromium's switches for a window that is covered: lay it out and run its timers anyway. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const WINDOW = { width: 1280, height: 820 };
const SHOTS = process.env.LIVE_SHOTS ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-rail-"));
const home = path.join(scratch, "home");
const marker = path.join(scratch, "started");
let electron = null;
let api = null;
const daemonPids = [];
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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      events.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
    }
  });
  return { ws, ready, pending, events, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready, events: s.events,
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
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s — is the server still up?`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

/** Page-side helpers: every read is one round trip that returns boxes, not a string to re-parse. */
const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  shown(el) { return !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0; },
  rail() {
    const rail = document.querySelector('.app-rail');
    if (!rail) return null;
    const buttons = [...rail.querySelectorAll('button')].map((b) => ({ name: b.getAttribute('aria-label'), box: __live.box(b), badge: b.querySelector('.sb-badge')?.textContent ?? null, disabled: b.disabled }));
    return { box: __live.box(rail), buttons, shown: __live.shown(rail) };
  },
  sidebar() {
    const s = document.querySelector('.sidebar');
    return { box: __live.box(s), collapsed: s.hasAttribute('data-collapsed'), inert: s.hasAttribute('inert'), opacity: getComputedStyle(s).opacity };
  },
  header() {
    const h = document.querySelector('.sb-header');
    return { box: __live.box(h), profile: h.querySelector('.sb-profile')?.getAttribute('aria-label') ?? null,
      buttons: [...h.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) };
  },
  needs() {
    const n = document.querySelector('.sb-needs');
    if (!n) return null;
    return [...n.querySelectorAll(':scope > .item-list > .item')].map((item) => ({
      label: item.querySelector('.item-row').getAttribute('aria-label'),
      where: item.querySelector('.item-where')?.textContent ?? null,
      mark: item.querySelector('.status-dot')?.getAttribute('data-status') ?? null,
      actions: item.getAttribute('data-actions'),
      row: __live.box(item), title: __live.box(item.querySelector('.item-title')), whereBox: __live.box(item.querySelector('.item-where')),
      titleCut: (() => { const t = item.querySelector('.item-title'); return t.scrollWidth > t.clientWidth + 0.5; })(),
      whereCut: (() => { const w = item.querySelector('.item-where'); return w ? w.scrollWidth > w.clientWidth + 0.5 : null; })(),
    }));
  },
  sectionEl(name) { return [...document.querySelectorAll('.sb-section')].find((s) => s.getAttribute('aria-label') === name) ?? null; },
  sections() {
    return [...document.querySelectorAll('.sb-section')].map((s) => {
      const head = s.querySelector('.sb-section-head');
      const btn = head.querySelector('.item-row');
      const icon = head.querySelector('.sb-space-icon');
      const clip = s.querySelector('.sb-section-clip');
      const rows = clip && !clip.hasAttribute('aria-hidden') ? [...clip.querySelectorAll(':scope > .item-list > .item, :scope > .item-list > .sb-fanout-rows > .item')].map((item) => ({
        label: item.querySelector('.item-row')?.getAttribute('aria-label') ?? null,
        title: item.querySelector('.item-title')?.textContent ?? null,
        titleBox: __live.box(item.querySelector('.item-title')),
        gutter: item.querySelector('.sb-gutter svg') ? 'glyph' : null,
        mark: item.querySelector('.item-trail .status-dot')?.getAttribute('data-status') ?? null,
        dot: __live.box(item.querySelector('.item-trail .status-dot')),
      })) : [];
      return { name: s.getAttribute('aria-label'), label: btn.getAttribute('aria-label'), expanded: btn.getAttribute('aria-expanded'),
        iconColor: getComputedStyle(icon).color, nameBox: __live.box(head.querySelector('.item-title')), iconBox: __live.box(icon),
        head: __live.box(head), tally: [...head.querySelectorAll('.item-tally')].map((t) => ({ count: t.querySelector('.item-count').textContent, mark: t.querySelector('.status-dot').getAttribute('data-status'), dot: __live.box(t.querySelector('.status-dot')) })),
        rows, more: s.querySelector('.sb-more')?.textContent ?? null };
    });
  },
  section(name) { return __live.sections().find((s) => s.name === name) ?? null; },
  recent() {
    const r = document.querySelector('.sb-recent');
    if (!r) return null;
    return [...r.querySelectorAll('.sb-day')].map((d) => ({ day: d.querySelector('.group-label').textContent,
      rows: [...d.querySelectorAll(':scope > .item-list > .item')].map((item) => ({ label: item.querySelector('.item-row').getAttribute('aria-label'),
        title: item.querySelector('.item-title').textContent, where: item.querySelector('.item-where')?.textContent ?? null,
        mark: item.querySelector('.item-trail .status-dot')?.getAttribute('data-status') ?? null })) }));
  },
  click(sel) { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; },
  clickName(name, within) { const root = within ? document.querySelector(within) : document; const b = [...root.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === name || x.textContent.trim() === name); if (!b) return false; b.click(); return true; },
  crumb() {
    const c = document.querySelector('.panel[data-focused] .panel-crumb') ?? document.querySelector('.panel-crumb');
    if (!c) return null;
    const bar = c.closest('.panel-bar');
    return { name: c.getAttribute('aria-label'), text: bar.querySelector('.panel-crumb-name').textContent + bar.querySelector('.panel-crumb-sep').textContent + bar.querySelector('.panel-title').textContent,
      iconColor: getComputedStyle(c.querySelector('.panel-crumb-icon')).color, box: __live.box(c), title: __live.box(bar.querySelector('.panel-title')) };
  },
  addStyle(id, text) { const st = document.createElement('style'); st.id = id; st.textContent = text; document.head.appendChild(st); return true; },
  dropStyle(id) { document.getElementById(id)?.remove(); return true; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function inMain(m, expr) {
  const r = await m.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error(`main exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** A real pointer: move there (which is what :hover answers to), press, release. */
async function clickAt(c, { x, y }) {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(80);
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
const centre = (b) => ({ x: Math.round((b.l + b.r) / 2), y: Math.round((b.t + b.b) / 2) });
const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 });

/** The window as painted, sampled: the luminance at each [x, y] (CSS px) of a fresh capture, decoded
 *  in the page. A capture has no macOS material behind the translucent grounds, so it can say which
 *  surfaces are the SAME and which are a step apart — never what the step looks like on the desktop. */
async function lumAt(c, points) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
    const k = img.width / window.innerWidth;
    return ${JSON.stringify(points)}.map(([x, y]) => { const p = g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
      return Math.round(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]); });
  })()`);
}

async function shot(c, tag, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, `realm-sidebar-rail-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const LEFT = { x: 0, y: 0, width: 420, height: WINDOW.height };

/** Hold the window key for the run: an unkeyed window greys its accent (App.tsx's KeyWindowBridge),
 *  and the live window opens behind whatever the person is working in. */
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT, MAIN_INSPECT_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [`--inspect=${MAIN_INSPECT_PORT}`, wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
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
  await c.send("DOM.enable");
  await c.send("CSS.enable");
  const mainTarget = await until(async () => (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`).then((r) => r.json()).catch(() => []))[0], 20_000, "main inspector");
  const m = cdp(mainTarget.webSocketDebuggerUrl);
  await m.ready;
  await inMain(m, `(() => { const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) w.setContentSize(${WINDOW.width}, ${WINDOW.height}); return true; })()`);
  await until(() => evalIn(c, `window.innerWidth === ${WINDOW.width}`), 10_000, "window size");
  return { c, m };
}

/** A reload, and the window held key again on the other side of it. */
async function reload(c, ready, tag) {
  await c.send("Page.reload", {});
  await until(() => evalIn(c, ready), 30_000, tag);
  await holdKey(c);
  await sleep(500);
}

async function main() {
  fs.writeFileSync(marker, "");
  const { c } = await launch();
  await holdKey(c);

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const daemon = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  if (daemon.pid) daemonPids.push(daemon.pid);
  const [liveSpace] = await api.call("spaces.list", {});
  const profileId = liveSpace.profileId;
  // Onboarding's session runs the person's real engine. Nothing here sends to it, and it is switched
  // to the fake before anything could.
  for (const s of await api.call("sessions.listAll", { profileId: null })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });

  /* ── Before anything waits: no Needs you, no pill, no strip ─────────────────────────────────── */
  await reload(c, `!!document.querySelector('.sb-section')`, "sections at rest");
  const rest = await evalIn(c, `({ needs: __live.needs(), pill: !!document.querySelector('.needs-you, .sb-head, .sb-active'), strip: !!document.querySelector('.space-strip, .swiper, .strip-space'),
    open: [...document.querySelectorAll('.sidebar .group-label')].map((l) => l.textContent), otherSpaces: !!document.querySelector('.space-row'),
    destinations: !!document.querySelector('.sb-destinations') })`);
  check("Needs you is not drawn while nothing waits", rest.needs === null, rest.needs);
  check("no strip, no swiper, no pill, no Active, no destination rows in the sidebar",
    !rest.pill && !rest.strip && !rest.otherSpaces && !rest.destinations, rest);
  check("no Open, Sessions, Archived or Other spaces heading", !rest.open.some((l) => /^(Open|Sessions|Archived|Other spaces)$/.test(l)), rest.open);

  /* ── Seed: three more spaces in this profile, one in another, sessions in every state ───────── */
  const room = async (name, icon, color, pid = profileId) => api.call("spaces.create", { profileId: pid, name, icon, color });
  const homework = await room("Homework", "book", "#3ddc97");
  const thesis = await room("Thesis", "cap", "#ffb454");
  const lectures = await room("Lectures", "folder", "#4cc9f0");
  const school = await api.call("profiles.create", { name: "School", icon: "cap", color: "#ff6b8b" });
  const seminar = await room("Seminar", "book", "#c084fc", school.id);
  const make = async (space, title, extra = {}) => (await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title, ...extra })).session;
  const settled = (id) => until(async () => {
    const a = await api.call("sessions.get", { id });
    if (a.status === "running" || a.status === "waiting_permission") return null;
    await sleep(400);
    const b = await api.call("sessions.get", { id });
    return b.status === a.status && b.lastEventSeq === a.lastEventSeq ? b : null;
  }, 20_000, `session ${id} settled`);
  const settle = async (s, text) => { await api.call("sessions.send", { id: s.id, text }); return settled(s.id); };
  const read = async (s) => { const r = await api.call("sessions.get", { id: s.id }); await api.call("sessions.markSeen", { id: s.id, seq: r.lastEventSeq }); };

  // Homework: one waiting, one working, one with news, and enough read ones to need Show more.
  const asks = await make(homework, "Wants a yes");
  void api.call("sessions.send", { id: asks.id, text: "ask me" }).catch(() => {});
  const works = await make(homework, "Working away");
  void api.call("sessions.send", { id: works.id, text: "keep working" }).catch(() => {});
  const news = await settle(await make(homework, "Has news"), "hello");
  await api.call("sessions.markSeen", { id: news.id, seq: 1 });
  for (const t of ["Read the brief", "Outline the essay", "Check the sources"]) await read(await settle(await make(homework, t), "hello"));
  // A schedule's session, run on the fake.
  await api.call("runs.create", { spaceId: homework.id, goal: "hello", title: "Morning digest", constraints: { agentKind: "fake" } });
  // Thesis: a fan-out of three dispatched together, all working, and one more working alone.
  for (let i = 0; i < 3; i++) {
    const f = await make(thesis, "Migrate the API", { userDispatched: true });
    void api.call("sessions.send", { id: f.id, text: "keep working" }).catch(() => {});
  }
  const long = await make(thesis, "Long haul");
  void api.call("sessions.send", { id: long.id, text: "keep working" }).catch(() => {});
  // Lectures: one that failed and has not been read.
  const broke = await make(lectures, "Broke on the limit");
  await api.call("sessions.send", { id: broke.id, text: "hit the limit" }).catch(() => {});
  // School's Seminar: a question waiting in the profile that is not on screen. A long title, to
  // measure what gives way beside the space and profile it names.
  const over = await make(seminar, "Asks over there about the reading list for the next seminar week");
  void api.call("sessions.send", { id: over.id, text: "ask me" }).catch(() => {});
  await until(async () => {
    const all = await api.call("sessions.listAll", { profileId: null });
    const st = Object.fromEntries(all.map((s) => [s.id, s.status]));
    return st[asks.id] === "waiting_permission" && st[over.id] === "waiting_permission" && st[works.id] === "running" && st[long.id] === "running";
  }, 30_000, "the held states");
  const brokeStatus = (await api.call("sessions.get", { id: broke.id })).status;
  console.log(`INFO the scripted limit left its session ${brokeStatus}`);

  await reload(c, `!!__live.section('Homework') && __live.section('Homework').rows.length > 0`, "sections after seeding");
  await park(c);
  await sleep(600);

  /* ── 1. The rail ────────────────────────────────────────────────────────────────────────────── */
  const rail = await evalIn(c, `__live.rail()`);
  const sb = await evalIn(c, `__live.sidebar()`);
  check("the rail is the window's left edge, as wide as the lights need", rail.box.l === 0 && rail.box.w >= 76 && rail.box.t === 0 && rail.box.h === WINDOW.height, rail.box);
  check("the sidebar starts where the rail ends", Math.abs(sb.box.l - rail.box.r) < 0.5, { rail: rail.box.r, sidebar: sb.box.l });
  const firstBtn = rail.buttons[0];
  check("the rail's first control sits below the traffic lights' 40px band", firstBtn.box.t >= 40, firstBtn);
  // One pair in the window: while there is a sidebar, the head row has the window's back and forward.
  check("…and with the sidebar open, the window's back and forward are not in the rail", !rail.buttons.some((b) => /^Go (back|forward)$/.test(b.name)), rail.buttons.slice(0, 2).map((b) => b.name));
  const names = rail.buttons.map((b) => b.name);
  check("Home, Library, Connections, Scheduled tasks and the bell, then the toggle and you at the foot",
    ["Library", "Connections", "Scheduled tasks"].every((n) => names.includes(n)) && names.some((n) => /^Home/.test(n))
      && names.some((n) => /^Notifications/.test(n)) && names.includes("Hide sidebar (⌘B)"), names);
  const homeBtn = rail.buttons.find((b) => /^Home/.test(b.name));
  check("Home wears no count: what waits says so on its own row, in Needs you", homeBtn.name === "Home" && homeBtn.badge === null, homeBtn);
  const foot = rail.buttons.find((b) => b.name === "Hide sidebar (⌘B)");
  check("the toggle and the person sit at the rail's foot", foot.box.b > WINDOW.height - 120, foot.box);

  /* ── 2. The head row ────────────────────────────────────────────────────────────────────────── */
  const head = await evalIn(c, `__live.header()`);
  check("the head row is the 40px band beside the lights: profile, back and forward, search, new session", head.box.t === 0 && head.box.h === 40
    && head.buttons.length === 5 && /^Profile: /.test(head.buttons[0]) && head.buttons[1] === "Go back" && head.buttons[2] === "Go forward"
    && head.buttons[3] === "Search" && head.buttons[4] === "New session", head);
  check("…and no pane's bar carries a pair of its own", await evalIn(c, `!document.querySelector('.panel-bar [aria-label^="Back in "], .panel-bar [aria-label^="Forward in "]')`));

  /* ── 2b. The window's frame: chrome round a sheet ───────────────────────────────────────── */
  const sbBox = (await evalIn(c, `__live.sidebar()`)).box;
  const mainB = await evalIn(c, `__live.box(document.querySelector('.main'))`);
  const sbMid = sbBox.l + sbBox.w / 2, mainMid = mainB.l + 200;
  const frame = async () => {
    const [rail, headSb, headMain, sheetSb, sheetMain, rimTop, rimLeft, notch, inCorner] = await lumAt(c, [
      [rail0.box.l + 38, 300], [sbMid, 20], [mainMid, 8], [sbMid, 600], [mainMid, 600],
      [sbMid, 40], [sbBox.l, 300], [sbBox.l + 1.5, 41.5], [sbBox.l + 10, 50]]);
    return { rail, headSb, headMain, sheetSb, sheetMain, rimTop, rimLeft, notch, inCorner };
  };
  const rail0 = rail;
  const fr = await frame();
  check("the rail and the head row across the window are one chrome", Math.abs(fr.rail - fr.headSb) <= 2 && Math.abs(fr.headSb - fr.headMain) <= 3, fr);
  check("…the sidebar's list and the panes a step off it, as the sheet the chrome is round", Math.abs(fr.rail - fr.sheetSb) >= 8 && Math.abs(fr.headMain - fr.sheetMain) >= 8, fr);
  check("…under a rim along its top and down its left edge, lighter than either side of it",
    fr.rimTop > Math.max(fr.headSb, fr.sheetSb) && fr.rimLeft > Math.max(fr.rail, fr.sheetSb), fr);
  check("…and the corner where they meet is rounded: chrome outside the curve, sheet inside it",
    Math.abs(fr.notch - fr.rail) <= 3 && Math.abs(fr.inCorner - fr.sheetSb) <= 3, fr);
  // THE MUTANT: no tint — the chrome is the sidebar's ground again, and the step was never the frame's.
  await evalIn(c, `(() => { const st = document.createElement('style'); st.id = 'mutant-frame'; st.textContent = ':root, :root[data-mode] { --chrome-tint: transparent !important; }'; document.head.appendChild(st); return true; })()`);
  await sleep(150);
  const untinted = await frame();
  await evalIn(c, `(() => { document.getElementById('mutant-frame').remove(); return true; })()`);
  check("the mutant reproduces the old window (no tint ⇒ the rail and the sidebar's list are one ground)", Math.abs(untinted.rail - untinted.sheetSb) <= 2, untinted);

  /* ── 3. Needs you ───────────────────────────────────────────────────────────────────────────── */
  const needs = await evalIn(c, `__live.needs()`);
  const wantLabels = ["Wants a yes in Homework — waiting on you", "Asks over there about the reading list for the next seminar week in Seminar · School — waiting on you"];
  if (brokeStatus === "error") wantLabels.push("Broke on the limit in Lectures — error");
  check("Needs you lists what waits from every space and profile, longest first, then what failed",
    needs !== null && JSON.stringify(needs.map((n) => n.label)) === JSON.stringify(wantLabels), needs?.map((n) => n.label));
  const long_ = needs.find((n) => n.where === "Seminar · School");
  check("a long title gives way while the space and profile beside it stay whole", long_ && long_.titleCut && long_.whereCut === false
    && long_.whereBox.r <= long_.row.r - 8, long_ && { titleCut: long_.titleCut, whereCut: long_.whereCut, where: long_.whereBox });
  await evalIn(c, `__live.addStyle('mutant-yield', '.sb-needs .item-where { flex: 0 1 auto !important; min-width: 0 !important; } .sb-needs .item-title { flex: 0 1 auto !important; }')`);
  await sleep(120);
  const yielded = (await evalIn(c, `__live.needs()`)).find((n) => n.label.startsWith("Asks over there"));
  check("the mutant reproduces the failure (no stated order ⇒ the space's name is cut too)", yielded.whereCut === true, yielded.whereBox);
  await evalIn(c, `__live.dropStyle('mutant-yield')`);
  await shot(c, "needs-dark", LEFT);

  // Answer in place: unfold Wants a yes's card and allow it, from the sidebar.
  await evalIn(c, `__live.clickName('Answer Wants a yes here')`);
  const card = await until(() => evalIn(c, `(() => { const g = document.querySelector('.sb-need-answer'); return g ? { text: g.textContent, box: __live.box(g) } : null; })()`), 10_000, "the card in place");
  check("a waiting row unfolds the session's own request card in place", /rm -rf build/.test(card.text), card);
  await shot(c, "answer-dark", LEFT);
  // The card's options read "1 Allow", "2 Allow always", "3 Deny": the key, then the word.
  await evalIn(c, `(() => { const b = [...document.querySelectorAll('.sb-need-answer button')].find((x) => /^\\d?Allow/.test(x.textContent.trim()) && !/always/i.test(x.textContent)); b.click(); return true; })()`);
  const answered = await until(async () => {
    const n = await evalIn(c, `__live.needs()`);
    return n && !n.some((r) => r.label.startsWith("Wants a yes")) ? n : null;
  }, 15_000, "the answered row gone");
  check("answering in place takes the row out of Needs you", !answered.some((r) => r.label.startsWith("Wants a yes")), answered.map((r) => r.label));
  const asksAfter = (await api.call("sessions.get", { id: asks.id })).status;
  check("the session itself moved on from the question", asksAfter !== "waiting_permission", asksAfter);

  /* ── 4. The sections ────────────────────────────────────────────────────────────────────────── */
  const secs = await evalIn(c, `__live.sections()`);
  check("one section per space of the profile, and no other profile's", secs.map((s) => s.name).join() === "Live,Homework,Thesis,Lectures", secs.map((s) => s.name));
  const hw = secs.find((s) => s.name === "Homework");
  check("a section's icon wears its space's colour, not the chrome's ink",
    hw.iconColor !== secs.find((s) => s.name === "Live").iconColor && !/^rgb\((\d+), \1, \1\)$/.test(hw.iconColor), { homework: hw.iconColor });
  check("Homework's head sums what is going on in it", /^Homework — /.test(hw.label) && hw.tally.some((t) => t.mark === "running"), { label: hw.label, tally: hw.tally });
  const hwRows = hw.rows;
  check("its sessions sit on the head's name — titles on one column, under the space's name",
    hwRows.length > 0 && hwRows.every((r) => Math.abs(r.titleBox.l - hw.nameBox.l) <= 1), { name: hw.nameBox.l, titles: hwRows.map((r) => r.titleBox.l) });
  await evalIn(c, `__live.addStyle('mutant-indent', '.sb-row[data-nested] > .item-row { padding-left: 8px !important; }')`);
  await sleep(120);
  const flat = (await evalIn(c, `__live.section('Homework')`)).rows;
  check("the mutant reproduces the failure (no indent ⇒ the titles leave the name's column)", flat.every((r) => Math.abs(r.titleBox.l - hw.nameBox.l) > 4), flat.map((r) => r.titleBox.l));
  await evalIn(c, `__live.dropStyle('mutant-indent')`);
  check("five rows, then Show more with the rest counted", hwRows.length === 5 && /^Show more \d+$/.test(hw.more ?? ""), { rows: hwRows.map((r) => r.title), more: hw.more });
  check("what is working and what is new sit above Show more, whatever moved since",
    hwRows[0]?.title === "Working away" && hwRows[0]?.mark === "running" && hwRows[1]?.title === "Has news" && hwRows[1]?.mark === "unseen",
    hwRows.map((r) => [r.title, r.mark]));
  const digest = hwRows.find((r) => r.title === "Morning digest");
  check("a schedule's session wears a clock in the gutter", digest && digest.gutter === "glyph" && /from a schedule/.test(digest.label), digest);
  const marks = hwRows.filter((r) => r.mark !== null);
  const headDot = hw.tally.at(-1)?.dot;
  check("each row's mark lines up with the head's at the far end", headDot && marks.length >= 2 && marks.every((r) => Math.abs(r.dot.r - headDot.r) <= 1), { head: headDot?.r, rows: marks.map((r) => r.dot.r) });

  const th = secs.find((s) => s.name === "Thesis");
  const fanRow = th.rows.find((r) => /^Fan-out: Migrate the API/.test(r.label ?? ""));
  check("a fan-out is one row, its states summed", fanRow && /3 sessions, 3 running/.test(fanRow.label) && th.rows.length === 2, th.rows.map((r) => r.label));
  await evalIn(c, `(() => { const b = [...document.querySelectorAll('.sb-section[aria-label="Thesis"] .item-row')].find((x) => /^Fan-out/.test(x.getAttribute('aria-label'))); b.click(); return true; })()`);
  await sleep(250);
  const unfolded = (await evalIn(c, `__live.section('Thesis')`)).rows;
  check("…that unfolds to its sessions", unfolded.filter((r) => r.title === "Migrate the API").length === 3, unfolded.map((r) => r.title));

  // Fold Thesis, then reload: it comes back folded and Homework open.
  await evalIn(c, `(() => { document.querySelector('.sb-section[aria-label="Thesis"] .sb-section-head .item-row').click(); return true; })()`);
  await sleep(450);
  const folded = await evalIn(c, `__live.section('Thesis')`);
  check("a section folds", folded.expanded === "false" && folded.rows.length === 0, { expanded: folded.expanded, rows: folded.rows.length });
  await shot(c, "dark", LEFT);
  await reload(c, `!!__live.section('Thesis') && !!__live.section('Homework') && __live.section('Homework').rows.length > 0`, "sections after a reload");
  const kept = await evalIn(c, `({ th: __live.section('Thesis').expanded, hw: __live.section('Homework').expanded })`);
  check("a reload finds it folded, and the others open", kept.th === "false" && kept.hw === "true", kept);

  /* ── 5. Recent ──────────────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `(() => { [...document.querySelectorAll('.sb-lens input')].find((i) => i.value === 'recent').click(); return true; })()`);
  const days = await until(() => evalIn(c, `__live.recent()`), 10_000, "Recent");
  const lensNow = await evalIn(c, `[...document.querySelectorAll('.sb-lens .seg-opt')].map((l) => ({ text: l.textContent, selected: l.hasAttribute('data-selected'),
    checked: l.querySelector('input').checked, bg: getComputedStyle(l).backgroundColor, color: getComputedStyle(l).color }))`);
  // Painted, not only marked: the fill has to be on the reading on screen, and off the other one.
  const clear = (bg) => /\/ 0\)$|rgba\(0, 0, 0, 0\)|transparent/.test(bg);
  const lensRecent = lensNow.find((l) => l.text === "Recent"), lensSpaces = lensNow.find((l) => l.text === "Spaces");
  check("the lens lights the reading on screen, at once", lensRecent?.selected === true && lensSpaces?.selected === false
    && !clear(lensRecent.bg) && clear(lensSpaces.bg), lensNow);
  const all = await api.call("sessions.listAll", { profileId });
  const movedAt = new Map(all.map((s) => [s.title, s.updatedAt]));
  const flatRecent = days.flatMap((d) => d.rows);
  const times = flatRecent.map((r) => (r.title.startsWith("Fan-out: ") ? Math.max(...all.filter((s) => s.title === "Migrate the API").map((s) => s.updatedAt)) : movedAt.get(r.title) ?? null));
  // A session still at work is active now: those lead, and the rest follow by when they last moved.
  const live = flatRecent.map((r) => r.mark === "running" || r.mark === "waiting_permission");
  const firstQuiet = live.indexOf(false);
  const quietTimes = times.filter((_, i) => !live[i]);
  check("Recent lists the profile's sessions by when they last moved, what is still working counted as now",
    times.every((t) => t !== null) && live.slice(firstQuiet).every((l) => !l) && quietTimes.every((t, i) => i === 0 || t <= quietTimes[i - 1] + 2500),
    flatRecent.map((r, i) => [r.title.slice(0, 22), r.mark, times[i]]));
  check("…each naming its space, under a day heading", days[0].day === "Today" && flatRecent.every((r) => r.where !== null), { days: days.map((d) => d.day), where: flatRecent.map((r) => r.where) });
  check("…and wearing its state at the far end", flatRecent.some((r) => r.mark === "running"), flatRecent.map((r) => [r.title.slice(0, 16), r.mark]));
  check("…without another profile's sessions", !flatRecent.some((r) => r.where === "Seminar"), flatRecent.map((r) => r.where));
  await shot(c, "recent-dark", LEFT);
  await reload(c, `!!__live.recent()`, "Recent after a reload");
  check("a reload keeps the lens", (await evalIn(c, `!!__live.recent() && !document.querySelector('.sb-sections')`)) === true);
  await evalIn(c, `(() => { [...document.querySelectorAll('.sb-lens input')].find((i) => i.value === 'spaces').click(); return true; })()`);
  await until(() => evalIn(c, `!!__live.section('Homework')`), 10_000, "Spaces again");

  /* ── 6. The breadcrumb ──────────────────────────────────────────────────────────────────────── */
  await evalIn(c, `(() => { [...document.querySelectorAll('.sb-section[aria-label="Homework"] .sb-section-clip .item-row')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Has news')).click(); return true; })()`);
  const crumb = await until(async () => { const k = await evalIn(c, `__live.crumb()`); return k && k.text.endsWith("Has news") ? k : null; }, 15_000, "Homework's session open");
  const hwIcon = (await evalIn(c, `__live.section('Homework')`)).iconColor;
  check("a session's pane bar reads Homework › its title", crumb.text === "Homework›Has news" && crumb.name === "Open Homework", crumb);
  check("…the space's icon in the colour its section wears", crumb.iconColor === hwIcon, { crumb: crumb.iconColor, section: hwIcon });
  await park(c);
  await sleep(300);
  await shot(c, "window-dark");

  /* ── 1b. Collapsing leaves the rail ─────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.clickName('Hide sidebar (⌘B)', '.app-rail')`);
  await until(() => evalIn(c, `__live.sidebar().collapsed`), 5_000, "collapsed");
  await sleep(500);
  const railC = await evalIn(c, `__live.rail()`);
  const mainBox = await evalIn(c, `__live.box(document.querySelector('.main'))`);
  const sbC = await evalIn(c, `__live.sidebar()`);
  check("collapsing leaves the rail on screen, where it was", railC.shown && railC.box.l === 0 && railC.box.w === rail.box.w, railC.box);
  check("…the sidebar out of reach, and the panes taking its room", sbC.inert && sbC.opacity === "0" && Math.abs(mainBox.l - railC.box.r) < 0.5, { sidebar: sbC, main: mainBox.l });
  check("…with Home and the way back still on screen", railC.buttons.some((b) => b.name === "Home") && railC.buttons.some((b) => b.name === "Show sidebar (⌘B)"), railC.buttons.map((b) => b.name));
  check("…and the window's back and forward under the lights, the head row that had them gone with the sidebar",
    railC.buttons[0]?.name === "Go back" && railC.buttons[1]?.name === "Go forward", railC.buttons.slice(0, 2).map((b) => b.name));
  const [cRail, cNotch, cInCorner, cSheet, cRimA, cRimB] = await lumAt(c, [[railC.box.l + 38, 300], [mainBox.l + 1.5, 41.5], [mainBox.l + 10, 50], [mainBox.l + 200, 600], [mainBox.l, 300], [mainBox.l + 0.6, 300]]);
  const cRimLeft = Math.max(cRimA, cRimB);
  check("…and the panes take the sheet's rounded corner where the sidebar had it",
    Math.abs(cNotch - cRail) <= 3 && Math.abs(cInCorner - cSheet) <= 3 && cRimLeft > cSheet, { cRail, cNotch, cInCorner, cSheet, cRimLeft });
  await park(c);
  await shot(c, "collapsed-dark");
  /* Collapsed with a page up, the way back must still take the click. A page drawn over the toggle
     hit-tests to the page, which no screenshot shows, because the button is still painted underneath
     — the bug the old corner toggle once had, carried over to the rail. */
  await evalIn(c, `__live.clickName('Library', '.app-rail')`);
  await until(() => evalIn(c, `!!document.querySelector('.page-overlay')`), 8_000, "a page over the panes");
  await sleep(300);
  const onPage = await evalIn(c, `(() => {
    const t = [...document.querySelectorAll('.app-rail button')].find((b) => b.getAttribute('aria-label') === 'Show sidebar (⌘B)')?.getBoundingClientRect();
    if (!t) return { toggle: null };
    const el = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    return { hitsToggle: el?.closest('button')?.getAttribute('aria-label') === 'Show sidebar (⌘B)', hit: el?.className ?? null,
      pageLeft: __live.box(document.querySelector('.page-overlay')).l };
  })()`);
  check("with a page up, a click at the rail's Show sidebar lands on it, not on the page", onPage.hitsToggle === true, onPage);
  check("…the page standing beside the rail rather than over it", onPage.pageLeft >= railC.box.r - 0.5, { page: onPage.pageLeft, rail: railC.box.r });
  await evalIn(c, `__live.clickName('Show sidebar (⌘B)', '.app-rail')`);
  await until(() => evalIn(c, `!__live.sidebar().collapsed`), 5_000, "open again");
  await evalIn(c, `__live.clickName('Library', '.app-rail')`);
  await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 8_000, "the page closed");

  /* ── The light face ─────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await reload(c, `!!__live.section('Homework') && document.documentElement.dataset.mode === 'light'`, "the light face");
  await park(c);
  await sleep(800);
  await shot(c, "light", LEFT);
  await shot(c, "window-light");
  await evalIn(c, `__live.clickName('Hide sidebar (⌘B)', '.app-rail')`);
  await until(() => evalIn(c, `__live.sidebar().collapsed`), 5_000, "collapsed in light");
  await sleep(500);
  await park(c);
  await shot(c, "collapsed-light");
  await evalIn(c, `__live.clickName('Show sidebar (⌘B)', '.app-rail')`);
  await api.call("settings.set", { key: "ui.theme", value: "dark" });

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
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
  for (const port of [SERVER_PORT, CDP_PORT, MAIN_INSPECT_PORT]) killPort(port);
  // No agent this run started may have written a transcript into the person's own Claude folder.
  const projects = path.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(projects)) {
    const fresh = execSync(`find ${JSON.stringify(projects)} -maxdepth 1 -newer ${JSON.stringify(marker)} || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    // A transcript of this run would be filed under a folder named after the scratch home. Anything
    // else that moved is a session the person (or the agent running this) has open, and is listed.
    if (fresh.length > 0) console.log(`INFO newer under ~/.claude/projects: ${JSON.stringify(fresh)}`);
    check("nothing new under ~/.claude/projects from this run", !fresh.some((d) => d.includes(path.basename(scratch))), fresh.slice(0, 5));
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
