/**
 * Live check for the sidebar's rows about OTHER rooms (run with: node apps/desktop/scripts/sidebar-spaces-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME (run `pnpm build` first), seeds four spaces with fake
 * sessions held in each state over the RPC socket, and measures what jsdom cannot see:
 *
 *   1. Every other space of the profile is a row after the room's own contents, in the strip's order,
 *      and its far end carries the strip's signal with its count — dot at the far end, count beside it.
 *   2. Under a real hover the row's state gives way to its disclosure in the same slot; a row with no
 *      action keeps its state there.
 *   3. The disclosure unfolds the room's live sessions in order, indented under the room's name, and
 *      a reload finds it unfolded.
 *   4. A turn that finishes in another room arrives in that room's list wearing the unread ring, with
 *      no reload — the window heard the events, nobody re-listed anything.
 *   5. A click on a room's name goes there; a click on one of its sessions opens that session there.
 *
 * Each layout measurement is paired with a mutant that reproduces the failure it pins, so a check that
 * has quietly stopped measuring anything fails instead of passing. Screenshots of both faces are
 * written to LIVE_SHOTS (default: the OS temp dir) for a person to read.
 *
 * Sessions are the fake agent's, created over RPC — the onboarding session is a real, billed engine
 * and is never typed into. Ports: env-overridable. Touches only a scratch dir; stops only the
 * processes it started.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9365), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8965);
/** Chromium's switches for a window that is covered: lay it out and run its timers anyway. A live
 *  check's window opens behind whatever the person is working in, and a covered window stops layout. */
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const SHOTS = process.env.LIVE_SHOTS ?? os.tmpdir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-spaces-"));
const home = path.join(scratch, "home");
let electron = null;
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
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
  };
}

/** Page-side helpers: every read is one round trip that returns boxes, not a string to re-parse. */
const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  page() { return document.querySelector('.space-page:not([inert])'); },
  rooms() {
    const page = __live.page();
    return [...page.querySelectorAll('.space-row')].map((row) => {
      const trail = row.querySelector('.item-trail');
      const actions = row.querySelector('.item-actions');
      return {
        name: row.querySelector('.item-title').textContent,
        label: row.querySelector('.item-row').getAttribute('aria-label'),
        actions: row.getAttribute('data-actions'),
        mark: row.querySelector('.item-trail .status-dot')?.getAttribute('data-status') ?? null,
        count: row.querySelector('.item-count')?.textContent ?? null,
        row: __live.box(row), icon: __live.box(row.querySelector('.item-row > :first-child')),
        title: __live.box(row.querySelector('.item-title')),
        trail: trail && getComputedStyle(trail).display !== 'none' ? __live.box(trail) : null,
        dot: __live.box(row.querySelector('.item-trail .status-dot')),
        countBox: __live.box(row.querySelector('.item-count')),
        disclose: __live.box(row.querySelector('.item-disclose')),
        actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
        expanded: row.querySelector('.item-disclose')?.getAttribute('aria-expanded') ?? null,
      };
    });
  },
  room(name) { return __live.rooms().find((r) => r.name === name) ?? null; },
  rowOf(name) { return [...__live.page().querySelectorAll('.space-row')].find((r) => r.querySelector('.item-title').textContent === name); },
  /** The live sessions unfolded under a room's row, in order. */
  unfolded(name) {
    const row = __live.rowOf(name);
    const wrap = row?.nextElementSibling;
    if (!wrap || !wrap.classList.contains('space-live-wrap') || !wrap.hasAttribute('data-open')) return null;
    return [...wrap.querySelectorAll('.item')].map((item) => ({
      title: item.querySelector('.item-title').textContent,
      label: item.querySelector('.item-row').getAttribute('aria-label'),
      mark: item.querySelector('.status-dot')?.getAttribute('data-status') ?? null,
      icon: __live.box(item.querySelector('.item-row > svg')), titleBox: __live.box(item.querySelector('.item-title')),
      dot: __live.box(item.querySelector('.status-dot')),
      dotShown: (() => { const t = item.querySelector('.item-trail'); return !!t && getComputedStyle(t).display !== 'none'; })(),
    }));
  },
  labels() { return [...__live.page().querySelectorAll('.space-body > .group-label, .space-body > .group-head')].map((l) => l.textContent.trim()); },
  header() { return document.querySelector('.space-header .space-name')?.textContent ?? null; },
  addStyle(id, text) { const st = document.createElement('style'); st.id = id; st.textContent = text; document.head.appendChild(st); return true; },
  dropStyle(id) { document.getElementById(id)?.remove(); return true; },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
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
const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 600 });

async function shot(c, tag, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const out = path.join(SHOTS, `realm-sidebar-spaces-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const SIDEBAR = { x: 0, y: 0, width: 300, height: 820 };

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
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
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("DOM.enable");
  await c.send("CSS.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 2, mobile: false });

  /* ── Seed: four rooms in one profile, sessions held in every state ─────────────────────────────
     Through the real create/send seam, on the fake agent. `ask me` parks a session on a permission the
     adapter holds open; `keep working` streams a word every two seconds for over a minute; `hello`
     settles at once, and the read mark is then set over RPC to make it read or unread. */
  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const [liveSpace] = await api.call("spaces.list", {});
  const profileId = liveSpace.profileId;
  const room = async (name, icon) => api.call("spaces.create", { profileId, name, icon });
  const homework = await room("Homework", "book");
  const thesis = await room("Thesis", "cap");
  const lectures = await room("Lectures", "folder");
  const make = async (space, title) => (await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title })).session;
  /* `sessions.send` answers before the turn's last events are written — the settle and the usage line
     land after it — so a read mark taken off its answer is one the turn's own tail then overtakes,
     and every "read" session would come out unread. Wait for the log to stop moving first. */
  const settled = (id) => until(async () => {
    const a = await api.call("sessions.get", { id });
    if (a.status !== "idle") return null;
    await sleep(400);
    const b = await api.call("sessions.get", { id });
    return b.status === "idle" && b.lastEventSeq === a.lastEventSeq ? b : null;
  }, 15000, `session ${id} settled`);
  const settle = async (s, text) => { await api.call("sessions.send", { id: s.id, text }); return settled(s.id); };
  const asks = await make(homework, "Wants a yes");
  void api.call("sessions.send", { id: asks.id, text: "ask me" }).catch(() => {});
  const works = await make(homework, "Working away");
  void api.call("sessions.send", { id: works.id, text: "keep working" }).catch(() => {});
  const news = await settle(await make(homework, "Has news"), "hello");
  await api.call("sessions.markSeen", { id: news.id, seq: 1 });
  const read = await settle(await make(homework, "Read already"), "hello");
  await api.call("sessions.markSeen", { id: read.id, seq: read.lastEventSeq });
  const long = await make(thesis, "Long haul");
  void api.call("sessions.send", { id: long.id, text: "keep working" }).catch(() => {});
  const later = await settle(await make(thesis, "Comes back later"), "hello");
  await api.call("sessions.markSeen", { id: later.id, seq: later.lastEventSeq });
  const notes = await settle(await make(lectures, "Notes from Tuesday"), "hello");
  await api.call("sessions.markSeen", { id: notes.id, seq: notes.lastEventSeq });
  await until(async () => {
    const all = await api.call("sessions.listAll", { profileId });
    const st = Object.fromEntries(all.map((s) => [s.id, s.status]));
    return st[asks.id] === "waiting_permission" && st[works.id] === "running" && st[long.id] === "running";
  }, 20000, "the held states");

  // A reload is a relaunch as far as the window is concerned: everything above is read at boot.
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!__live.page()?.querySelector('.space-row')`), 30000, "the rooms after reload");
  await sleep(600);

  /* ── 1. Every other room is a row after the room's own contents, in the strip's order ───────── */
  const labels = await evalIn(c, `__live.labels()`);
  const rooms = await evalIn(c, `__live.rooms()`);
  check("the other rooms are listed after the room's own contents, the room you are in left out",
    labels.indexOf("Other spaces") > labels.indexOf("Sessions") && rooms.map((r) => r.name).join() === "Homework,Thesis,Lectures",
    { labels, rooms: rooms.map((r) => r.name) });
  const strip = await evalIn(c, `[...document.querySelectorAll('.strip-space')].map((b) => b.getAttribute('aria-label').replace('Switch to space ', ''))`);
  check("…in the strip's own order", JSON.stringify(strip.filter((n) => n !== "Live")) === JSON.stringify(rooms.map((r) => r.name)), { strip });
  const hw = rooms.find((r) => r.name === "Homework");
  check("Homework wears the strip's waiting mark with its count, and says the rest in words",
    hw.mark === "waiting_permission" && hw.count === "1" && hw.label === "Homework — 1 waiting on you, 1 running, 1 unread", hw);
  check("Thesis wears the running mark; Lectures, with nothing going on, wears nothing",
    rooms.find((r) => r.name === "Thesis").mark === "running" && rooms.find((r) => r.name === "Lectures").mark === null,
    rooms.map((r) => [r.name, r.mark, r.count]));
  // The far end: the dot at the row's end, the count just before it, the name clear of both.
  check("at rest the dot holds the row's far end, the count sits beside it, and the name is clear of both",
    hw.row.r - hw.dot.r < 12 && hw.dot.l - hw.countBox.r >= 4 && hw.dot.l - hw.countBox.r <= 8 && hw.title.r <= hw.countBox.l,
    { rowR: hw.row.r, dotR: hw.dot.r, gap: +(hw.dot.l - hw.countBox.r).toFixed(1), titleR: hw.title.r, countL: hw.countBox.l });
  check("a room with nothing live has no disclosure", rooms.find((r) => r.name === "Lectures").actions === "0"
    && rooms.find((r) => r.name === "Lectures").disclose === null, rooms.find((r) => r.name === "Lectures"));

  /* ── 2. Under a real hover the state gives way to the disclosure, in the same slot ─────────── */
  const { root } = await c.send("DOM.getDocument", {});
  const nodeOf = async (selector) => (await c.send("DOM.querySelector", { nodeId: root.nodeId, selector })).nodeId;
  const hwRowSel = `.space-page:not([inert]) .space-row:has(.item-disclose[aria-label="Live sessions in Homework"])`;
  const hwNode = await nodeOf(hwRowSel);
  await c.send("CSS.forcePseudoState", { nodeId: hwNode, forcedPseudoClasses: ["hover"] });
  await sleep(250);
  const hwHover = await evalIn(c, `__live.room("Homework")`);
  check("under the pointer the room's state steps aside and the disclosure takes the same far end",
    hwHover.trail === null && hwHover.actionsOpacity === "1" && hwHover.row.r - hwHover.disclose.r < 8 && Math.abs(hwHover.disclose.r - hw.dot.r) < 8,
    { rest: { dotR: hw.dot.r }, hover: { disclose: hwHover.disclose, opacity: hwHover.actionsOpacity } });
  check("…and the name stops short of it", hwHover.title.r <= hwHover.disclose.l, { titleR: hwHover.title.r, discloseL: hwHover.disclose.l });
  await shot(c, "room-hover", { x: hw.row.l - 6, y: hw.row.t - 6, width: hw.row.w + 12, height: hw.row.h + 12 });

  /* ── 3. The disclosure unfolds the room's live sessions, in order, under its name ──────────── */
  await clickAt(c, centre(hwHover.disclose));
  await until(() => evalIn(c, `!!__live.unfolded("Homework")`), 5000, "Homework unfolded");
  await sleep(450); // the grid-rows transition
  await c.send("CSS.forcePseudoState", { nodeId: hwNode, forcedPseudoClasses: [] });
  await park(c);
  await sleep(200);
  const listed = await evalIn(c, `__live.unfolded("Homework")`);
  check("it unfolds onto the live sessions only — waiting, then working, then unread — each wearing its own mark",
    listed.map((l) => l.title).join("|") === "Wants a yes|Working away|Has news" && listed.map((l) => l.mark).join() === "waiting_permission,running,unseen",
    listed.map((l) => [l.title, l.mark]));
  const hwNow = await evalIn(c, `__live.room("Homework")`);
  check("each session's glyph lines up under the room's name",
    listed.every((l) => Math.abs(l.icon.l - hwNow.title.l) <= 1), { name: hwNow.title.l, glyphs: listed.map((l) => l.icon.l) });
  check("…and its mark lines up with the room's own at the far end",
    listed.every((l) => Math.abs(l.dot.r - hwNow.dot.r) <= 1), { room: hwNow.dot.r, sessions: listed.map((l) => l.dot.r) });
  // The mutant: no indent. The session rows would read as more rooms.
  await evalIn(c, `__live.addStyle('mutant-indent', '.space-live .item-row { padding-left: 8px !important; }')`);
  await sleep(120);
  const flat = await evalIn(c, `__live.unfolded("Homework")`);
  check("the mutant reproduces the failure (no indent ⇒ a session's glyph sits where a room's does)",
    flat.every((l) => Math.abs(l.icon.l - hwNow.icon.l) <= 1), { roomIcon: hwNow.icon.l, glyphs: flat.map((l) => l.icon.l) });
  await evalIn(c, `__live.dropStyle('mutant-indent')`);

  // A session row has no actions, so its mark stays put under the pointer.
  const firstChildSel = `.space-page:not([inert]) .space-live .item`;
  const childNode = await nodeOf(firstChildSel);
  await c.send("CSS.forcePseudoState", { nodeId: childNode, forcedPseudoClasses: ["hover"] });
  await sleep(200);
  const childHover = (await evalIn(c, `__live.unfolded("Homework")`))[0];
  check("a session row keeps its mark under the pointer, and its title gives nothing up",
    childHover.dotShown && Math.abs(childHover.titleBox.w - listed[0].titleBox.w) < 0.5, { rest: listed[0].titleBox.w, hover: childHover.titleBox.w, dotShown: childHover.dotShown });
  await evalIn(c, `__live.addStyle('mutant-quiet', '.item[data-actions="0"]:hover .item-trail:not(:empty) { display: none !important; } .item[data-actions="0"]:hover .item-row { padding-right: 34px !important; }')`);
  await sleep(120);
  const childMutant = (await evalIn(c, `__live.unfolded("Homework")`))[0];
  check("the mutant reproduces the failure (W1's rule alone ⇒ the mark vanishes for a slot with nothing in it)",
    !childMutant.dotShown, { dotShown: childMutant.dotShown });
  await evalIn(c, `__live.dropStyle('mutant-quiet')`);
  await c.send("CSS.forcePseudoState", { nodeId: childNode, forcedPseudoClasses: [] });
  await sleep(150);
  await shot(c, "dark", SIDEBAR);

  /* ── 4. A turn that finishes in another room arrives there unread, with no reload ──────────── */
  const thesisBefore = await evalIn(c, `__live.room("Thesis")`);
  await api.call("sessions.send", { id: later.id, text: "hello again" });
  const thesisAfter = await until(async () => {
    const r = await evalIn(c, `__live.room("Thesis")`);
    return r.label.includes("1 unread") ? r : null;
  }, 15000, "Thesis hears the finished turn");
  check("a turn that finished in another room is counted there at once", thesisBefore.label === "Thesis — 1 running" && thesisAfter.label === "Thesis — 1 running, 1 unread",
    { before: thesisBefore.label, after: thesisAfter.label });
  const thNode = await nodeOf(`.space-page:not([inert]) .space-row:has(.item-disclose[aria-label="Live sessions in Thesis"])`);
  await c.send("CSS.forcePseudoState", { nodeId: thNode, forcedPseudoClasses: ["hover"] });
  await sleep(200);
  await clickAt(c, centre((await evalIn(c, `__live.room("Thesis")`)).disclose));
  await c.send("CSS.forcePseudoState", { nodeId: thNode, forcedPseudoClasses: [] });
  await park(c);
  const thesisList = await until(() => evalIn(c, `__live.unfolded("Thesis")`), 5000, "Thesis unfolded");
  check("…and its own list shows it wearing the unread ring, after the one still working",
    thesisList.map((l) => `${l.title}:${l.mark}`).join() === "Long haul:running,Comes back later:unseen", thesisList.map((l) => [l.title, l.mark]));

  /* ── 3b. A reload finds both rooms unfolded ─────────────────────────────────────────────────── */
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!__live.page()?.querySelector('.space-row')`), 30000, "rooms after the second reload");
  await sleep(600);
  const kept = await evalIn(c, `({ hw: __live.unfolded("Homework")?.length ?? 0, th: __live.unfolded("Thesis")?.length ?? 0 })`);
  check("a reload finds both rooms still unfolded", kept.hw === 3 && kept.th === 2, kept);

  /* ── 5. A room's name goes to the room; one of its sessions opens that session there ────────── */
  await clickAt(c, centre((await evalIn(c, `__live.room("Thesis")`)).title));
  await until(async () => (await evalIn(c, `__live.header()`)) === "Thesis", 10000, "Thesis is the room");
  await sleep(400);
  const fromThesis = await until(async () => { const r = await evalIn(c, `__live.rooms()`); return r.length ? r : null; }, 8000, "rooms from Thesis");
  check("switching rooms puts the one you left in the list, and takes the one you are in out of it",
    fromThesis.map((r) => r.name).join() === "Live,Homework,Lectures", fromThesis.map((r) => r.name));
  const pick = (await evalIn(c, `__live.unfolded("Homework")`))[0];
  await clickAt(c, centre(pick.titleBox));
  const landed = await until(async () => {
    const r = await evalIn(c, `({ header: __live.header(),
      focused: document.querySelector('.session-pane[data-focused]')?.closest('.panel')?.querySelector('.panel-bar')?.textContent ?? null,
      card: !!document.querySelector('.session-pane[data-focused] .permission-card') })`);
    return r.header === "Homework" && r.card ? r : null;
  }, 15000, "the session open in Homework");
  check("a click on another room's session opens it in that room, its question on screen", landed.header === "Homework" && landed.card, landed);

  // Opening a session is reading it: the ring goes as soon as its pane has the keyboard, not on the
  // next thing it says.
  const ringOn = () => evalIn(c, `(() => { const r = [...__live.page().querySelectorAll('.item-row')].find((b) => b.querySelector('.item-title')?.textContent === 'Has news');
    return r ? r.querySelector('.status-dot')?.getAttribute('data-status') ?? null : 'missing'; })()`);
  const ringBefore = await ringOn();
  const newsRow = await evalIn(c, `__live.box([...__live.page().querySelectorAll('.item-row')].find((b) => b.querySelector('.item-title')?.textContent === 'Has news'))`);
  await clickAt(c, centre(newsRow));
  const ringAfter = await until(async () => { const r = await ringOn(); return r === null ? "cleared" : null; }, 8000, "the ring cleared").catch(() => "still there");
  check("opening an unread session clears its ring at once", ringBefore === "unseen" && ringAfter === "cleared", { ringBefore, ringAfter });

  /* ── The light face ─────────────────────────────────────────────────────────────────────────── */
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!__live.page()?.querySelector('.space-row') && document.documentElement.dataset.mode === 'light'`), 30000, "the light face");
  await sleep(800);
  await shot(c, "light", SIDEBAR);
  await api.call("settings.set", { key: "ui.theme", value: "dark" });

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  api.close();
  c.close();
}

/** Stop what this run started, and only that: the daemon by its state file, then anything still
 *  listening on this run's own ports whose command line names this run's scratch dir. */
async function teardown() {
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home);
  for (const port of [SERVER_PORT, CDP_PORT]) {
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
      if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@"))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    }
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
