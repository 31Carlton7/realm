/**
 * Live look at the Activity view's cards (run with: node apps/desktop/scripts/activity-cards-live.mjs [outDir])
 *
 * Boots the BUILT app on a scratch REALM_HOME with the fake agent, makes four spaces (one with an
 * emoji icon) and a session in every state a card draws — running, needs you, unread, failed, a
 * schedule's, a lead with sub-agents waiting, one in a worktree, one on another agent, a pin — spread
 * across days, then screenshots the sidebar light and dark, at the default width and the narrowest,
 * and measures the cards: two-line height, the time and the state never on the same line.
 *
 * The states are written into the scratch realm.db between two boots (sqlite3), because a fake turn
 * cannot be left mid-way for a picture. Nothing is sent to an engine, so nothing is billed.
 *
 * Ports: env-overridable (REALM_DEVTOOLS_PORT, REALM_PORT). Reaps only what holds its own two ports.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.REALM_DEVTOOLS_PORT ?? 9273), SERVER_PORT = Number(process.env.REALM_PORT ?? 8833);
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "activity-cards"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-activity-cards-live-"));
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
  const r = await Promise.race([
    c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(10000).then(() => { throw new Error("evaluate timed out"); }),
  ]);
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function boot() {
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    env: {
      ...process.env, REALM_HOME: HOME, REALM_ENABLE_FAKE_AGENT: "1", REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  seenPids.push(electron.pid);
  return attach();
}

/** The window's page, connected — again after anything that may have replaced the window (a theme
 *  change re-makes it, so a held connection would wait forever on a page that is gone). */
async function attach() {
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 40000, "renderer target");
  log("target", target.id);
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
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

const sql = (stmt) => execFileSync("sqlite3", [DB, stmt], { encoding: "utf8" });
const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);

  /* ── Boot one: onboarding, then the spaces and sessions over RPC ── */
  log("boot one");
  let c = await boot();
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Realm'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30000, "composer");
  const r = rpc(await daemonToken(HOME));
  await r.ready;
  const spaces0 = await r.call("spaces.list", {}).catch(() => null);
  const realm = (spaces0 ?? []).find?.((s) => s.name === "Realm") ?? JSON.parse(sql(`SELECT json_object('id', id, 'profileId', profile_id) FROM spaces WHERE name = 'Realm'`).trim());
  const profileId = realm.profileId;
  const mk = (name, icon, color) => r.call("spaces.create", { profileId, name, icon, color });
  const versed = await mk("Versed", "rocket", "#e5484d");
  const plynn = await mk("Plynn", "emoji:🌱", "#30a46c");
  const general = await mk("General", "home", "#0090ff");
  const made = {};
  const plan = [
    ["minecraft", general, "fake", "Minecraft website edits"],
    ["paywall", versed, "fake", "Analyzing paywall conversion"],
    ["realm31", realm, "fake", "Realm 3.1"],
    ["landing", plynn, "fake", "Overhaul plynn landing page"],
    ["creator", versed, "codex", "[MKTG] Creator discovery"],
    ["electron", plynn, "fake", "Set up new Realm Electron shell"],
    ["ios", realm, "fake", "Realm for iOS"],
    ["fixcrash", realm, "fake", "Fix realm update crash"],
    ["check", versed, "fake", "Check Versed 1.2.0 App Store review"],
    ["update", versed, "fake", "Versed update"],
    ["airline", general, "fake", "Airline internship search"],
    ["kid1", realm, "fake", "Sub-agent one"],
    ["kid2", realm, "fake", "Sub-agent two"],
  ];
  for (const [key, sp, agentKind, title] of plan) {
    const { session, itemId } = await r.call("sessions.create", { spaceId: sp.id, agentKind, title });
    made[key] = { id: session.id, itemId, spaceId: sp.id };
  }
  r.close();
  log("made", Object.keys(made).length, "sessions; shutting down");
  await shutdown(c);
  log("down");

  /* ── The states, written while nothing is running ── */
  const now = Date.now(), MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const set = (key, cols) => sql(`UPDATE sessions SET ${Object.entries(cols).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} WHERE id = ${q(made[key].id)}`);
  set("minecraft", { status: "running", activity_at: now - 2 * MIN });
  set("paywall", { status: "waiting_permission", activity_at: now - 14 * MIN });
  set("realm31", { status: "idle", seen_seq: 3, last_event_seq: 9, activity_at: now - 2 * HOUR });
  set("landing", { status: "idle", seen_seq: 2, last_event_seq: 4, activity_at: now - 5 * HOUR });
  set("creator", { status: "error", activity_at: now - 6 * HOUR });
  set("electron", { status: "running", activity_at: now - 40 });
  set("ios", { status: "idle", activity_at: now - 2 * DAY });
  set("fixcrash", { status: "running", activity_at: now - 25 * MIN });
  set("check", { status: "idle", dispatched_by_kind: "run", activity_at: now - 3 * DAY });
  set("update", { status: "idle", activity_at: now - 3 * DAY - 2 * HOUR });
  set("airline", { status: "idle", activity_at: now - 13 * DAY });
  for (const k of ["kid1", "kid2"]) set(k, { status: "waiting_permission", dispatched_by_kind: "agent_run", dispatched_by_session_id: made.fixcrash.id, activity_at: now - 20 * MIN });
  // The worktree: an environment of Realm's, and the crash fix working in it.
  const envCols = sql(`SELECT group_concat(name) FROM pragma_table_info('environments')`).trim().split(",");
  const env = { id: "01JACTIVITYCARDSWORKTREE01", space_id: realm.id, path: path.join(scratch, "wt-fix-update-crash"), branch: "realm/fix-update-crash",
    kind: "worktree", port_block_start: null, created_at: now, updated_at: now };
  sql(`INSERT INTO environments (${envCols.join(", ")}) VALUES (${envCols.map((k) => q(env[k] ?? null)).join(", ")})`);
  set("fixcrash", { environment_id: env.id });
  sql(`UPDATE items SET pinned = 1 WHERE id = ${q(made.realm31.itemId)}`);

  /* ── Then a boot per look: the settings are written while the app is down, as a theme change made
     over RPC re-makes the window under a held connection. ── */
  const setting = (key, value) => sql(`INSERT INTO settings (key, value_json) VALUES (${q(key)}, ${q(JSON.stringify(value))})
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
  setting("ui.sidebarLens", "recent");
  // The window's ground opaque, so the picture is the sidebar and not whatever sat behind the window.
  setting("ui.groundAlpha", 100);
  const shots = [];
  for (const theme of ["dark", "light"]) {
    for (const [label, width] of [["normal", 280], ["narrow", 200]]) {
      setting("ui.theme", theme);
      setting("ui.sidebarWidth", width);
      log("boot", theme, label);
      c = await boot();
      /* A boot settles every session it finds mid-turn, so the live states go in after it, and the
         page is read again to pick them up. */
      await until(() => evalIn(c, `document.querySelectorAll('.sb-recent .sb-card').length >= 9`), 30000, `first cards ${theme} ${label}`);
      for (const k of ["minecraft", "electron", "fixcrash"]) set(k, { status: "running" });
      for (const k of ["paywall", "kid1", "kid2"]) set(k, { status: "waiting_permission" });
      await c.send("Page.reload", {});
      await sleep(1500);
      await c.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1000, deviceScaleFactor: 2, mobile: false });
      await until(() => evalIn(c, `document.querySelectorAll('.sb-recent .sb-card').length >= 9`), 30000, `cards ${theme} ${label}`);
      await evalIn(c, `(() => { document.documentElement.removeAttribute('data-window-inactive');
        new MutationObserver(() => document.documentElement.removeAttribute('data-window-inactive')).observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
      await sleep(1200);
      const box = await evalIn(c, `(() => { const r = document.querySelector('#app-sidebar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
      const file = path.join(OUT, `activity-${theme}-${label}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      shots.push(file);
      const m = await evalIn(c, `(() => {
        const cards = [...document.querySelectorAll('.sb-recent .sb-card')];
        return cards.map((card) => {
          const lines = [...card.querySelectorAll('.item-row > .sb-card-line')];
          const when = card.querySelector('.sb-card-when')?.getBoundingClientRect();
          const dot = lines[1]?.querySelector('.item-trail')?.getBoundingClientRect();
          return { title: card.querySelector('.item-title')?.textContent, h: Math.round(card.getBoundingClientRect().height), lines: lines.length,
            when: card.querySelector('.sb-card-when')?.textContent, state: lines[1]?.querySelector('.status-dot')?.dataset.status ?? null,
            apart: !when || !dot || dot.width === 0 || when.bottom <= dot.top };
        }); })()`);
      if (theme === "dark" && label === "normal") console.log(JSON.stringify(m));
      check(`${theme}/${label}: two-line cards are 52px`, m.filter((x) => x.lines === 2).every((x) => x.h === 52), m.filter((x) => x.lines === 2 && x.h !== 52));
      check(`${theme}/${label}: the worktree card has its third line`, m.some((x) => x.lines === 3 && x.title === "Fix realm update crash"));
      check(`${theme}/${label}: time and state never share a line`, m.every((x) => x.apart));
      if (label === "normal") {
        /* Under the pointer: Archive takes the first line's far end, the time steps left of it, and the
           state stays on the second line. A real :hover, forced on the card, not a class. */
        await c.send("DOM.enable");
        const { root } = await c.send("DOM.getDocument", { depth: 0 });
        await evalIn(c, `(() => { const card = [...document.querySelectorAll('.sb-recent .sb-card')].find((x) => x.querySelector('.item-title')?.textContent === 'Analyzing paywall conversion'); card.id = 'live-hover'; return true; })()`);
        const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#live-hover" });
        await c.send("CSS.enable");
        await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
        await sleep(300);
        const h = await evalIn(c, `(() => {
          const card = document.getElementById('live-hover');
          const r = (el) => el ? el.getBoundingClientRect() : null;
          const act = r(card.querySelector('.item-actions .item-shelf')), when = r(card.querySelector('.sb-card-when')), dot = r(card.querySelector('.item-trail .status-dot'));
          const box = r(card);
          return { box: { x: box.x, y: box.y, w: box.width, h: box.height },
            actOpacity: getComputedStyle(card.querySelector('.item-actions')).opacity,
            actOnLineOne: act && act.top < box.top + 26, whenLeftOfAct: when && act && when.right <= act.left, dotShown: !!dot && dot.width > 0 };
        })()`);
        check(`${theme}: under the pointer Archive is on line one, the time left of it, the state kept`, h.actOpacity === "1" && h.actOnLineOne && h.whenLeftOfAct && h.dotShown, h);
        const pad = 8;
        const hs = await c.send("Page.captureScreenshot", { format: "png", clip: { x: h.box.x - pad, y: h.box.y - pad, width: h.box.w + 2 * pad, height: h.box.h + 2 * pad, scale: 2 } });
        const hf = path.join(OUT, `activity-${theme}-hover.png`);
        fs.writeFileSync(hf, Buffer.from(hs.data, "base64"));
        shots.push(hf);
        await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        // The foot of the list too: a schedule's clock, last week's card.
        await evalIn(c, `(() => { const b = document.querySelector('.space-body'); b.scrollTop = b.scrollHeight; return true; })()`);
        await sleep(2000);
        const end = await c.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
        const ef = path.join(OUT, `activity-${theme}-normal-end.png`);
        fs.writeFileSync(ef, Buffer.from(end.data, "base64"));
        shots.push(ef);
      }
      await shutdown(c);
    }
  }
  console.log(shots.join("\n"));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await shutdown(null).catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await shutdown(null).catch(() => {}); process.exit(1); });
