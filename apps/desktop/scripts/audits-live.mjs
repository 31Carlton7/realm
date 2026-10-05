/**
 * Live check for the app-wide audits (run with: pnpm build && node apps/desktop/scripts/audits-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and walks the surfaces the four audits are about, in
 * both faces, measuring what no stylesheet read can see:
 *
 *   1. Every scroller that has something past an end dissolves there. On each surface, every element
 *      that scrolls AND overflows is listed with whether it carries the dissolve, so a scroller that
 *      was missed is named rather than looking fine in a capture that happened not to scroll it.
 *   2. No page's head stays put. Each page's column is scrolled and its title measured before and
 *      after: a head that has not moved is a sticky one, however it is built.
 *   3. The hand over what takes a click, the arrow where a click does nothing, the I-beam in a field —
 *      read off the computed cursor of one of each kind of control.
 *   4. The loose ends: one line between two settings rows on every Settings page; the session
 *      summary inside the window; a scheduled run's first message with the scheduler's note out of
 *      the bubble; and a blank tab's Recently visited without the address that failed to load.
 *
 * LIVE_TAG names the run's pictures (before / after), and LIVE_MAIN / LIVE_SERVER_ENTRY point it at
 * a build kept from before the change, so the same walk can be captured on both.
 *
 * Ports: LIVE_SERVER_PORT (8812), LIVE_CDP_PORT (9252), and two fixtures on 127.0.0.1 — LIVE_SITE_PORT
 * (8813, a page that loads) and LIVE_CLOSED_PORT (8814, nothing listening). Scratch and pictures under
 * LIVE_DIR. Nothing is billed: every session is moved to the fake agent before anything is sent, the
 * schedule runs on it, and nothing is ever typed into a composer. Kills only what listens on its ports.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9252), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8812);
const SITE_PORT = Number(process.env.LIVE_SITE_PORT ?? 8813), CLOSED_PORT = Number(process.env.LIVE_CLOSED_PORT ?? 8814);
const TAG = process.env.LIVE_TAG ?? "after";
const LIVE_DIR = process.env.LIVE_DIR ?? path.join(repoRoot, "../.verify/audits-live");
const shots = path.join(LIVE_DIR, "shots", TAG);
fs.mkdirSync(LIVE_DIR, { recursive: true });
const scratch = fs.mkdtempSync(path.join(LIVE_DIR, `run-${TAG}-`));
const home = path.join(scratch, "home");
const WINDOW = { width: 1400, height: 900 };
const REFUSED = `http://127.0.0.1:${CLOSED_PORT}/`;
const FIXTURE = `http://127.0.0.1:${SITE_PORT}/`;
let electron = null, site = null, api = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { tag: TAG, scrollers: {}, heads: {}, cursors: {}, dividers: {}, summary: null, scheduled: null, recent: null };

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

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
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

/** Helpers the page carries for the length of the run: a short name for an element, and the three
 *  audits' readings, so each station asks one question in one line. */
const HELPERS = `
globalThis.__live = {
  q: (sel) => document.querySelector(sel),
  name(el) {
    const cls = [...el.classList].filter((c) => !/^(hljs|cm-|xterm-)/.test(c) || el.classList.length === 1).slice(0, 3);
    return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "") + (el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : "");
  },
  box(el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; },
  type(input, value) {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
  /* Every element on screen that scrolls and has something to scroll to, and what it does about it. */
  scrollers(root = document) {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const y = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
      const x = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
      if (!x && !y) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden") continue;
      out.push({ el: this.name(el), axis: (y ? "y" : "") + (x ? "x" : ""),
        dissolve: el.dataset.dissolve ?? null, dissolveX: el.dataset.dissolveX ?? null,
        masked: cs.maskImage !== "none" && cs.maskImage !== "" });
    }
    return out;
  },
  /* The biggest scroller inside a page: its column. */
  column(root) {
    let best = null, area = 0;
    for (const el of root.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = el; }
    }
    return best;
  },
  /* Scroll a page's column and say where its title went: a head that has not moved is pinned. */
  async head(pageSel, by = 360) {
    const page = document.querySelector(pageSel);
    if (!page) return { error: "no page " + pageSel };
    const title = page.querySelector("h1");
    const col = this.column(page);
    if (!title || !col) return { error: "no " + (title ? "column" : "title"), title: !!title };
    const before = title.getBoundingClientRect().top;
    col.scrollTop = 0; await new Promise((r) => setTimeout(r, 80));
    const rest = title.getBoundingClientRect().top;
    col.scrollTop = by; col.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 250));
    const after = title.getBoundingClientRect().top;
    return { title: title.textContent.trim(), column: this.name(col), rest: Math.round(rest), scrolled: Math.round(after),
      moved: Math.round(rest - after), pinned: Math.abs(rest - after) < 2, scrollTop: Math.round(col.scrollTop), before: Math.round(before) };
  },
  cursor(sel, filter) {
    const els = [...document.querySelectorAll(sel)].filter((e) => !filter || filter(e));
    const el = els[0];
    return el ? { el: this.name(el), cursor: getComputedStyle(el).cursor } : null;
  },
  /* Two lines where there should be one: a row's own bottom border with the inset divider of the row
     under it, or a row's top border beside it. */
  dividers(root) {
    const out = { pairs: 0, doubled: [] };
    for (const row of root.querySelectorAll(".settings-row + .settings-row, .engine-card + .engine-card")) {
      const upper = row.previousElementSibling;
      const before = getComputedStyle(row, "::before");
      const inset = before.content !== "none" && before.position === "absolute" && parseFloat(before.height) <= 1.5;
      const upperB = parseFloat(getComputedStyle(upper).borderBottomWidth) || 0;
      const lowerT = parseFloat(getComputedStyle(row).borderTopWidth) || 0;
      out.pairs++;
      const lines = (inset ? 1 : 0) + (upperB > 0 && getComputedStyle(upper).borderBottomColor !== "rgba(0, 0, 0, 0)" ? 1 : 0) + (lowerT > 0 ? 1 : 0);
      if (lines > 1) out.doubled.push({ upper: this.name(upper), lower: this.name(row), inset, upperB, lowerT });
    }
    return out;
  },
  async rail(label) {
    const b = [...document.querySelectorAll(".app-rail .rail-btn")].find((x) => (x.getAttribute("aria-label") ?? "").startsWith(label));
    if (!b) throw new Error("no rail button " + label);
    if (b.getAttribute("aria-pressed") !== "true") b.click();
    return true;
  },
  tab(label) {
    const t = [...document.querySelectorAll(".settings-tab")].find((l) => l.textContent.trim() === label);
    if (!t) return false;
    (t.querySelector("input") ?? t).click();
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const note = (name, detail) => console.log(`NOTE ${name} ${JSON.stringify(detail)}`);

async function shot(c, name, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const file = path.join(shots, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SHOT ${file}`);
}
const clipOf = (c, sel, pad = 0) => evalIn(c, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}),
  width: Math.min(innerWidth, r.width + ${2 * pad}), height: Math.min(innerHeight, r.height + ${2 * pad}) }; })()`);

async function press(c, { key, code, keyCode, meta = false, shift = false }) {
  const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: keyCode });
}
const escape = (c) => press(c, { key: "Escape", code: "Escape", keyCode: 27 });

/** Note every scroller on screen under `station`, merged across faces. */
async function audit(c, station, root = "document") {
  const found = await evalIn(c, `__live.scrollers(${root})`);
  report.scrollers[station] = found;
  const bare = found.filter((s) => s.dissolve === null && s.dissolveX === null);
  note(`scrollers · ${station}`, { total: found.length, without: bare.map((s) => `${s.el} (${s.axis})`) });
}

async function closePage(c) {
  await evalIn(c, `(() => { const b = [...document.querySelectorAll(".app-rail .rail-btn[aria-pressed=true]")][0]; b?.click(); return true; })()`);
  await sleep(400);
  // Settings is not a rail page: it closes from its own bar, or on Escape.
  if (await evalIn(c, `!!document.querySelector(".settings-page-pane")`)) { await escape(c); await sleep(400); }
}

async function openSettings(c) {
  if (await evalIn(c, `!!document.querySelector(".settings-page-pane")`)) return;
  await press(c, { key: ",", code: "Comma", keyCode: 188, meta: true });
  const opened = await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 4000, "settings").catch(() => false);
  if (opened) return;
  // The palette's "Open settings", for a build whose ⌘, lives in the menu bar alone.
  await press(c, { key: "k", code: "KeyK", keyCode: 75, meta: true });
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "palette");
  await evalIn(c, `__live.type(document.querySelector(".palette input"), "settings"); true`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((b) => /open settings/i.test(b.textContent)); if (!hit) return false; hit.click(); return true; })()`), 5000, "Open settings");
  await until(() => evalIn(c, `!!document.querySelector(".settings-page-pane")`), 8000, "settings page");
}

async function setTheme(c, face) {
  await openSettings(c);
  await evalIn(c, `__live.tab("Appearance")`);
  await until(() => evalIn(c, `!!document.querySelector('fieldset[aria-label="Theme"] input[value="${face}"]')`), 8000, "theme control");
  await evalIn(c, `document.querySelector('fieldset[aria-label="Theme"] input[value="${face}"]').click(); true`);
  await until(() => evalIn(c, `document.documentElement.dataset.mode === "${face}"`), 5000, `the ${face} face`);
  await sleep(400);
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT, SITE_PORT, CLOSED_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Fixture page</title><body style="font:16px system-ui;padding:40px">A page that loads.</body>`);
  });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: { ...process.env, REALM_HOME: home, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: process.env.LIVE_SERVER_ENTRY ?? path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: process.env.LIVE_MAIN ?? path.join(repoRoot, "apps/desktop/out/main/index.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, HELPERS);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.type(input, 'Live'); input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  // The window as the person at the Mac sees a key window: not greyed, not quiet.
  await evalIn(c, `(() => { const root = document.documentElement;
    const clear = () => { root.removeAttribute("data-window-inactive"); root.removeAttribute("data-quiet"); };
    clear(); new MutationObserver(clear).observe(root, { attributes: true, attributeFilter: ["data-window-inactive", "data-quiet"] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  return c;
}

/** Library files, so the Files tab is longer than its column: real files in the space's folder, rows
 *  in `artifacts` against the session the app made — the Library's one query reads nothing else. */
function seedFiles(space, sessionId) {
  const dir = path.join(space.folderPath, "notes");
  fs.mkdirSync(dir, { recursive: true });
  const day = 24 * 3600 * 1000, now = Date.now();
  const rows = [];
  for (let i = 0; i < 48; i++) {
    const ext = ["md", "ts", "json", "csv", "txt", "py"][i % 6];
    const name = `note-${String(i).padStart(2, "0")}.${ext}`;
    fs.writeFileSync(path.join(dir, name), `# ${name}\n`);
    rows.push(`('live-art-${i}', '${sessionId}', ${i + 1}, 'output', '${path.join(dir, name).replace(/'/g, "''")}', '${name}', '${ext}', ${now - Math.floor(i / 8) * day - i * 1000})`);
  }
  execFileSync("sqlite3", [path.join(home, "realm.db"), `INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES ${rows.join(", ")};`]);
}

async function settingsStation(c, face) {
  await openSettings(c);
  await evalIn(c, `__live.tab("General")`);
  await sleep(600);
  await shot(c, `${face}-settings-rest`);
  report.heads[`settings-${face}`] = await evalIn(c, `__live.head(".settings-page-pane")`);
  await sleep(200);
  await shot(c, `${face}-settings-scrolled`);
  if (face === "dark") {
    await audit(c, "settings · General");
    // One line between two rows, on every page of Settings.
    const tabs = await evalIn(c, `[...document.querySelectorAll(".settings-tab")].map((l) => l.textContent.trim()).filter(Boolean)`);
    for (const t of [...new Set(tabs)]) {
      await evalIn(c, `__live.tab(${JSON.stringify(t)})`);
      await sleep(900);
      report.dividers[t] = await evalIn(c, `__live.dividers(document.querySelector(".settings-page-pane"))`);
      await audit(c, `settings · ${t}`);
    }
    const doubled = Object.entries(report.dividers).filter(([, d]) => d.doubled.length > 0);
    note("settings dividers", Object.fromEntries(Object.entries(report.dividers).map(([t, d]) => [t, `${d.pairs} pairs, ${d.doubled.length} doubled`])));
    check("every Settings page draws one line between two rows", doubled.length === 0, doubled);
    // The rail's lists, in the sidebar's column while the page is up.
    await audit(c, "settings · sidebar column", `document.querySelector("#app-sidebar")`);
  }
  await closePage(c);
}

async function pageStation(c, face, label, pageSel, name, prep) {
  await evalIn(c, `__live.rail(${JSON.stringify(label)})`);
  await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(pageSel)})`), 10_000, label);
  if (prep) await prep();
  await sleep(700);
  await shot(c, `${face}-${name}-rest`);
  report.heads[`${name}-${face}`] = await evalIn(c, `__live.head(${JSON.stringify(pageSel)})`);
  await shot(c, `${face}-${name}-scrolled`);
  if (face === "dark") await audit(c, name);
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  const c = await boot();
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [space] = await api.call("spaces.list", {});
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "a session");
  for (const s of sessions) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  const sessionId = sessions[0].id;
  // Something to summarise: a url in the answer is an output (session-summary.ts), and a long reply
  // gives the transcript something to scroll.
  await api.call("sessions.send", { id: sessionId, text: `shipped to https://app.test/live\n\n${Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note the fake agent reads back.`).join("\n")}`, attachments: [] });
  await until(() => evalIn(c, `!!document.querySelector('.panel-actions [aria-label^="Summary of"]')`), 30_000, "summary button");
  seedFiles(space, sessionId);

  // A scheduled task on the scripted agent, run once, so the Scheduled page has a run to read.
  const task = await api.call("schedules.create", { spaceId: space.id, title: "Morning triage", cron: "0 9 * * *",
    goal: "Read the new issues, group them by area, and draft a summary of what changed since yesterday.",
    constraints: { agentKind: "fake" } });
  if (task.constraints?.agentKind !== "fake") throw new Error("the task is not on the scripted agent — refusing to fire it");
  await api.call("schedules.runNow", { id: task.id });
  await until(async () => (await api.call("runs.list", { spaceId: space.id, scheduleId: task.id })).runs.some((r) => r.state === "succeeded"), 40_000, "the run settling");

  for (const face of ["dark", "light"]) {
    await setTheme(c, face);
    await closePage(c);

    /* ── The session: its transcript, the summary popover, and a popover list ─────────────────── */
    await sleep(500);
    await shot(c, `${face}-session`);
    if (face === "dark") await audit(c, "session");
    await evalIn(c, `document.querySelector('.panel-actions [aria-label^="Summary of"]').click(); true`);
    await until(() => evalIn(c, `!!document.querySelector('.session-summary')`), 10_000, "summary panel");
    /* Its FIRST frame, held there: a window that cannot run the entrance (occluded, throttled) shows
       the panel where the animation starts it, which is where new-surfaces-live caught it 4px out. */
    const entering = await evalIn(c, `(() => { const p = document.querySelector('.session-summary');
      const a = p.getAnimations()[0]; if (!a) return null; a.pause(); a.currentTime = 0;
      const b = __live.box(p); a.finish(); return { box: b, overRight: b.r - innerWidth, overBottom: b.b - innerHeight }; })()`);
    if (entering) check(`${face}: …and its entrance starts inside it too`, entering.overRight <= 0 && entering.overBottom <= 0, entering);
    await sleep(500);
    const summary = await evalIn(c, `(() => { const p = document.querySelector('.session-summary'); const b = __live.box(p);
      return { box: b, win: { w: innerWidth, h: innerHeight }, overRight: b.r - innerWidth, overBottom: b.b - innerHeight, overLeft: -b.x, overTop: -b.y }; })()`);
    report.summary = report.summary ?? summary;
    check(`${face}: the session summary lands wholly inside the window`, summary.overRight <= 0 && summary.overBottom <= 0 && summary.overLeft <= 0 && summary.overTop <= 0, summary);
    await shot(c, `${face}-summary`, { x: Math.max(0, summary.box.x - 40), y: Math.max(0, summary.box.y - 40), width: Math.min(WINDOW.width - Math.max(0, summary.box.x - 40), summary.box.w + 80), height: Math.min(WINDOW.height - Math.max(0, summary.box.y - 40), summary.box.h + 80) });
    if (face === "dark") await audit(c, "summary popover", `document.querySelector('.session-summary')`);
    await evalIn(c, `document.querySelector('.panel-actions [aria-label^="Summary of"]').click(); true`);
    await sleep(300);

    // The command palette's list — long enough to scroll with every command in it.
    await press(c, { key: "k", code: "KeyK", keyCode: 75, meta: true });
    await until(() => evalIn(c, `!!document.querySelector('.palette-list')`), 5000, "palette");
    await sleep(400);
    await shot(c, `${face}-palette`, await clipOf(c, ".palette", 24));
    if (face === "dark") await audit(c, "palette", `document.querySelector('.palette')`);
    await escape(c);
    await sleep(300);

    /* ── Settings, Connections, Library ───────────────────────────────────────────────────────── */
    await settingsStation(c, face);
    await pageStation(c, face, "Connections", ".connections-page-pane", "connections");
    await closePage(c);
    await pageStation(c, face, "Library", ".library-page-pane", "library-files", async () => {
      await evalIn(c, `__live.tab("Files")`);
      await until(() => evalIn(c, `document.querySelectorAll('.library-tile, .library-row').length > 20`), 10_000, "library files");
    });
    await evalIn(c, `__live.tab("Skills")`);
    await sleep(800);
    report.heads[`library-skills-${face}`] = await evalIn(c, `__live.head(".library-page-pane")`);
    await shot(c, `${face}-library-skills-scrolled`);
    if (face === "dark") await audit(c, "library skills");
    await closePage(c);

    /* ── A scheduled run, read on the Scheduled page ──────────────────────────────────────────── */
    await evalIn(c, `__live.rail("Scheduled tasks")`);
    await until(() => evalIn(c, `!!document.querySelector('.schedules-page .sched-col')`), 10_000, "schedules page");
    await sleep(500);
    await evalIn(c, `(() => { const row = [...document.querySelectorAll('.sched-task-hit')].find((b) => b.textContent.includes('Morning triage')); row?.click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.sched-view .msg-user, .sched-view .msg-user-row')`), 20_000, "the run's first message");
    await sleep(800);
    const first = await evalIn(c, `(() => { const row = document.querySelector('.sched-view .msg-user-row');
      return { bubble: row?.querySelector('.msg-user')?.innerText ?? null, from: row?.querySelector('.msg-user-from')?.innerText ?? null }; })()`);
    report.scheduled = report.scheduled ?? first;
    check(`${face}: the run's first message is the task as written, with no scheduler's note in the bubble`, !!first.bubble && !/Nobody is watching/.test(first.bubble), first);
    check(`${face}: …and it says it is a scheduled run, above the bubble`, /Scheduled run · Morning triage/.test(first.from ?? ""), first.from);
    await shot(c, `${face}-scheduled-run`, await clipOf(c, ".sched-view", 0));
    if (face === "dark") await audit(c, "scheduled");
    await closePage(c);

    /* ── A blank tab's Recently visited, after a page that loaded and one that did not ─────────── */
    if (face === "dark") {
      await evalIn(c, `(() => { document.querySelector('.composer textarea')?.blur(); return true; })()`);
      const newTab = async () => {
        const before = await evalIn(c, `document.querySelectorAll('.pane-tabs [role=tab]').length`);
        await evalIn(c, `(() => { const p = document.querySelector('.panehost .panel'); p?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.activeElement?.blur(); return true; })()`);
        await sleep(200);
        await press(c, { key: "B", code: "KeyB", keyCode: 66, meta: true, shift: true });
        await until(async () => (await evalIn(c, `document.querySelectorAll('.pane-tabs [role=tab]').length`)) > before, 10_000, "a new tab");
        await sleep(500);
      };
      const go = (address) => evalIn(c, `(() => { const pane = [...document.querySelectorAll('.browser-pane')].find((p) => p.offsetParent !== null);
        const input = pane.querySelector('.browser-address input'); input.focus(); __live.type(input, ${JSON.stringify(address)});
        input.closest('form').requestSubmit(); return true; })()`);
      await newTab();
      await go(FIXTURE);
      await until(() => evalIn(c, `[...document.querySelectorAll('.pane-tabs [role=tab]')].some((t) => t.textContent.includes('Fixture page'))`), 20_000, "the fixture loading");
      await sleep(1500); // the page's save is debounced
      await newTab();
      await go(REFUSED);
      await until(() => evalIn(c, `!!document.querySelector('.browser-error')`), 20_000, "the refused page");
      await sleep(1500);
      await newTab();
      await until(() => evalIn(c, `!!document.querySelector('.new-tab')`), 10_000, "a blank tab");
      await sleep(1200);
      report.recent = await evalIn(c, `(() => { const s = [...document.querySelectorAll('.new-tab-section')].find((x) => x.getAttribute('aria-label') === 'Recently visited');
        return s ? [...s.querySelectorAll('a, button')].map((a) => (a.getAttribute('title') ?? '') + ' ' + a.textContent.trim()) : []; })()`);
      check("a blank tab's Recently visited lists the page that loaded", report.recent.some((r) => r.includes("Fixture page") || r.includes(FIXTURE)), report.recent);
      check("…and not the address that failed to load", !report.recent.some((r) => r.includes(`127.0.0.1:${CLOSED_PORT}`)), report.recent);
      await shot(c, `${face}-browser-recent`, await clipOf(c, ".browser-pane:has(.new-tab)", 0));
      await audit(c, "browser new tab");
    }
  }

  /* ── A page's rail in the page: the sidebar folded away, so Settings keeps its own rail ──────── */
  await setTheme(c, "dark");
  await closePage(c);
  await evalIn(c, `document.querySelector('[aria-controls="app-sidebar"]')?.click(); true`);
  await until(() => evalIn(c, `!!document.querySelector('#app-sidebar[data-collapsed]')`), 5000, "the sidebar folded");
  await openSettings(c);
  await evalIn(c, `__live.tab("General")`);
  await sleep(700);
  const railAt = async (tag) => evalIn(c, `(() => {
    const page = document.querySelector('.settings-page-pane');
    const rail = page.querySelector('.page-body > .page-rail'), title = page.querySelector('.page-head h1'), head = page.querySelector('.page-head');
    const col = page.querySelector('.page-content');
    return { tag: ${JSON.stringify(tag)}, rail: rail ? __live.box(rail) : null, head: __live.box(head), title: __live.box(title), column: __live.box(col),
      narrow: getComputedStyle(page.querySelector('.page-body')).flexDirection === 'column' };
  })()`);
  const wideRail = await railAt("wide");
  check("the rail stays in the page with the sidebar away, its top level with the head's band, and the title over the column",
    !!wideRail.rail && Math.abs(wideRail.rail.y - wideRail.head.y - 24) <= 2 && Math.abs(wideRail.title.x - wideRail.column.x - 4) <= 2, wideRail);
  await shot(c, "dark-settings-rail-in-page");
  report.heads["settings-rail-in-page"] = await evalIn(c, `__live.head(".settings-page-pane")`);
  await shot(c, "dark-settings-rail-in-page-scrolled");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 680, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  await evalIn(c, `document.querySelector('.settings-page-pane .page-content').scrollTop = 0; true`);
  await sleep(300);
  const narrowRail = await railAt("narrow");
  check("narrow, the rail lies down as a strip above the column, and the head is the column's first line",
    narrowRail.narrow && !!narrowRail.rail && narrowRail.rail.b <= narrowRail.head.y + 1, narrowRail);
  await shot(c, "dark-settings-rail-narrow");
  report.heads["settings-rail-narrow"] = await evalIn(c, `__live.head(".settings-page-pane")`);
  await shot(c, "dark-settings-rail-narrow-scrolled");
  await audit(c, "settings · narrow, rail in the page");
  await c.send("Emulation.setDeviceMetricsOverride", { width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: 2, mobile: false });
  await closePage(c);
  await evalIn(c, `document.querySelector('[aria-controls="app-sidebar"]')?.click(); true`);
  await sleep(500);

  /* ── Cursors: one of each kind of thing, read off the window ───────────────────────────────── */
  await setTheme(c, "dark");
  await closePage(c);
  report.cursors = await evalIn(c, `(() => ({
    button: __live.cursor('.btn:not(:disabled)'),
    iconButton: __live.cursor('.icon-btn:not(:disabled)'),
    railButton: __live.cursor('.app-rail .rail-btn'),
    sidebarRow: __live.cursor('.space-body .item-row:not(:disabled)'),
    chip: __live.cursor('.composer .ghost-chip:not([data-static])'),
    tab: __live.cursor('.pane-tabs [role=tab]'),
    textarea: __live.cursor('.composer textarea'),
    disabled: __live.cursor('button:disabled'),
  }))()`);
  await openSettings(c);
  await evalIn(c, `__live.tab("General")`);
  await sleep(600);
  Object.assign(report.cursors, await evalIn(c, `(() => ({
    settingsTab: __live.cursor('.settings-tab'),
    switch: __live.cursor('input.switch:not(:disabled)'),
    select: __live.cursor('select:not(:disabled)'),
    summary: __live.cursor('summary'),
    search: __live.cursor('input[type=search]'),
  }))()`));
  await closePage(c);
  await press(c, { key: "k", code: "KeyK", keyCode: 75, meta: true });
  await until(() => evalIn(c, `!!document.querySelector('.palette-list')`), 5000, "palette");
  report.cursors.paletteOption = await evalIn(c, `__live.cursor('.palette-list [role=option]:not([aria-disabled=true])')`);
  await escape(c);
  note("cursors", report.cursors);
  const pointing = ["button", "iconButton", "railButton", "sidebarRow", "tab", "settingsTab", "switch", "select", "summary", "paletteOption"];
  check("the hand over every control a click acts on", pointing.every((k) => !report.cursors[k] || report.cursors[k].cursor === "pointer"),
    Object.fromEntries(pointing.map((k) => [k, report.cursors[k]?.cursor ?? "—"])));
  check("the arrow over a control that is off, the I-beam in a field",
    (!report.cursors.disabled || report.cursors.disabled.cursor === "default") && report.cursors.textarea?.cursor === "text" && (!report.cursors.search || report.cursors.search.cursor === "text"),
    { disabled: report.cursors.disabled, textarea: report.cursors.textarea, search: report.cursors.search });

  const heads = Object.entries(report.heads).filter(([, h]) => h && !h.error);
  note("heads", Object.fromEntries(Object.entries(report.heads).map(([k, h]) => [k, h?.error ?? `${h.title}: moved ${h.moved}px`])));
  check("no page's head stays put while its column scrolls", heads.length > 0 && heads.every(([, h]) => !h.pinned), heads.filter(([, h]) => h.pinned).map(([k]) => k));
  fs.writeFileSync(path.join(shots, "report.json"), JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.join(shots, "report.json")}`);
  api.close();
  c.close();
}

async function reap() {
  try { api?.close(); } catch {}
  try { site?.close(); } catch {}
  await stopDaemons(home).catch(() => {});
  electron?.kill("SIGKILL");
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(reap);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void reap().finally(() => process.exit(1)); });
