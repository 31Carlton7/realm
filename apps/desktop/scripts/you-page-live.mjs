/**
 * Live check: the page about you, in the built app
 * (run with: pnpm build && node apps/desktop/scripts/you-page-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, runs one turn on the scripted `fake` agent so today is
 * a day of use, then writes a history into the scratch database the way the server would have —
 * sent messages on the four days before today and on seven days a fortnight back, one turn that
 * spent an hour of its 107 minutes waiting on a permission, a heavy day of tokens, three skill
 * loads. Then, in the real window:
 *
 *   1. The profile chip's menu has an entry named for the user, wearing their initial, and it opens
 *      the page as an overlay headed by their name.
 *   2. The five figures read what the history says: tokens, the peak day, the longest turn with the
 *      wait taken out, a current streak of five that includes today, and a longest streak of seven.
 *   3. The figures sit five across, tabular, inside the column; the calendar opens at today and its
 *      Weekly and Cumulative readings relabel the cells.
 *   4. A picture handed to `avatar.set` (what the button does after the native dialog) is copied
 *      into the home, the page shows the copy through realm-media, and it survives the original
 *      being deleted. Remove takes it back to the initial and deletes the copy.
 *
 * Ports: LIVE_SERVER_PORT (8963), LIVE_CDP_PORT (9363). Touches only a scratch dir. Nothing is billed:
 * the only turn runs on `fake`, and REALM_ENABLE_FAKE_AGENT=1 turns the server's titler off.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9363);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8963);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-you-page-live-"));
const home = path.join(scratch, "home");
const OUT = (tag) => path.join(os.tmpdir(), `realm-you-page-${tag}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

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

/** Whatever is listening on a port this script started. Never a name match. */
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** A real 96×96 PNG — a soft two-tone portrait shape — so the picture reads as a picture. */
function portraitPng() {
  const size = 96;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const head = (x - 48) ** 2 + (y - 38) ** 2 < 18 ** 2;
      const body = (x - 48) ** 2 + ((y - 100) * 0.9) ** 2 < 36 ** 2;
      const [r, g, b] = head || body ? [236, 196, 160] : [64 + y, 110 + Math.round(x / 3), 170];
      raw.set([r, g, b], y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Local noon `k` days ago, plus minutes — the server files events by the LOCAL day. */
const daysAgo = (k, minutes = 12 * 60) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k, 0, minutes).getTime(); };
const keyOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const readable = (ts) => { const d = new Date(ts); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };

async function shot(c, tag, selector) {
  const clip = selector ? await evalIn(c, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16, scale: 2 }; })()`) : undefined;
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home,
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
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
  const resize = (width, height = 900) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await resize(1280);

  // Onboarding makes the space. Its first session runs a REAL engine, so nothing is ever typed there.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Live");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");

  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const info = await api.call("system.info", {});
  const name = info.userName.trim() || "You";
  const [space] = await api.call("spaces.list", {});

  // Today, for real: one turn on the scripted agent, so the streak's last day is one the app wrote.
  const { session: live } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Today's turn" });
  await api.call("sessions.send", { id: live.id, text: "hello", attachments: [], mentions: [] });
  await until(async () => (await api.call("sessions.events", { id: live.id })).some((e) => e.event.type === "usage"), 20_000, "live turn usage");

  // The history, as the server would have written it, on a session of its own.
  const { session: past } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Rewrite the importer" });
  const rows = [];
  const ev = (ts, type, payload) => rows.push(`('${past.id}', ${ts}, '${type}', '${JSON.stringify(payload).replace(/'/g, "''")}')`);
  for (const k of [1, 2, 3, 4]) ev(daysAgo(k), "user_message", { text: "keep going", attachments: [] });            // with today: 5 in a row
  for (let k = 10; k <= 16; k++) ev(daysAgo(k), "user_message", { text: "next step", attachments: [] });               // 7 in a row, then a gap
  ev(daysAgo(12, 9 * 60), "status", { status: "running" });
  ev(daysAgo(12, 9 * 60 + 5), "status", { status: "waiting_permission" });
  ev(daysAgo(12, 10 * 60 + 5), "status", { status: "running" });                                                       // an hour on a prompt
  ev(daysAgo(12, 10 * 60 + 47), "status", { status: "idle" });                                                         // 47 minutes of work
  ev(daysAgo(12, 10 * 60 + 47), "usage", { costUsd: 0.5, inputTokens: 400_000, outputTokens: 50_000, numTurns: 1 });
  for (const skill of ["realm:browsing", "browsing", "realm:browsing", "superpowers:brainstorming"]) {
    ev(daysAgo(12, 9 * 60 + 1), "tool_call", { toolUseId: `t-${skill}-${rows.length}`, name: "Skill", input: { skill }, parentToolUseId: null });
  }
  const sql = `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES ${rows.join(",\n")};
    UPDATE sessions SET effort = 'high' WHERE id = '${past.id}';`;
  execFileSync("sqlite3", [path.join(home, "realm.db")], { input: sql });

  // 1. The menu entry, and the page it opens.
  await evalIn(c, `(() => { document.querySelector('.strip-profile').click(); return true; })()`);
  const entry = await until(() => evalIn(c, `(() => {
    const menu = document.querySelector('[role=menu][aria-label=Profiles]');
    const item = menu && [...menu.querySelectorAll('[role=menuitem]')].find((b) => b.querySelector('.menu-label')?.textContent === ${JSON.stringify(name)});
    if (!item) return null;
    const av = item.querySelector('.avatar');
    return { text: item.querySelector('.menu-label').textContent, avatar: av ? { initial: av.textContent, w: av.offsetWidth } : null };
  })()`), 5000, "menu entry");
  await shot(c, "menu", "[role=menu][aria-label=Profiles]");
  check(`the profile chip's menu has an entry named for the user ("${name}"), wearing their initial`,
    entry.text === name && entry.avatar !== null && entry.avatar.w === 16 && (name === "You" || entry.avatar.initial === name[0].toUpperCase()), entry);
  await evalIn(c, `(() => { [...document.querySelectorAll('[role=menu][aria-label=Profiles] [role=menuitem]')].find((b) => b.querySelector('.menu-label')?.textContent === ${JSON.stringify(name)}).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.page-overlay[aria-label="You"] .you-figures .stat-tile')`), 10_000, "page");
  await sleep(600);
  const head = await evalIn(c, `(() => {
    const h1 = document.querySelector('.you-page .page-title h1'), av = document.querySelector('.you-page .page-head .avatar'), r = av.getBoundingClientRect();
    return { h1: h1.textContent, initial: av.textContent, w: r.width, h: r.height, radius: getComputedStyle(av).borderRadius, bar: document.querySelector('.page-overlay-title').textContent };
  })()`);
  check("it opens as an overlay named You, headed by the user's name and a round 56px initial", head.bar === "You" && head.h1 === name && head.w === 56 && head.h === 56 && head.radius === "50%", head);

  // 2. The figures.
  const tiles = await evalIn(c, `Object.fromEntries([...document.querySelectorAll('.you-figures .stat-tile')].map((t) => [t.querySelector('.stat-label').textContent, { value: t.querySelector('.stat-value').textContent, delta: t.querySelector('.stat-delta').textContent }]))`);
  check("lifetime tokens add the history's turn to today's", tiles["Lifetime tokens"]?.value === "450K", tiles["Lifetime tokens"]);
  check("the peak day is the heavy day, by its local date", tiles["Peak day"]?.value === "450K" && tiles["Peak day"]?.delta === readable(daysAgo(12)), tiles["Peak day"]);
  check("the longest turn is 47 minutes — the hour on the prompt is taken out", tiles["Longest turn"]?.value === "47m 0s" && tiles["Longest turn"]?.delta === "Rewrite the importer", tiles["Longest turn"]);
  check("the current streak counts today's real turn and the four days before it", tiles["Current streak"]?.value === "5 days" && tiles["Current streak"]?.delta === `Since ${readable(daysAgo(4))}`, tiles["Current streak"]);
  check("the longest streak is the seven-day run a fortnight back", tiles["Longest streak"]?.value === "7 days", tiles["Longest streak"]);
  const most = await evalIn(c, `Object.fromEntries([...document.querySelectorAll('section[aria-label="Most used"] .usage-toplist')].map((l) => [l.querySelector('h4').textContent, [...l.querySelectorAll('li')].map((li) => li.textContent)]))`);
  check("most used: the skill counted once across both routes, and the chosen effort", most.Skills?.[0] === "browsing3" && most.Efforts?.[0] === "High11" && most.Tools?.[0] === "Skill4", most);

  // 3. Geometry, in the real window.
  const geo = await evalIn(c, `(() => {
    const tiles = [...document.querySelectorAll('.you-figures .stat-tile')].map((t) => t.getBoundingClientRect());
    const col = document.querySelector('.you-page .page-content'), cr = col.getBoundingClientRect();
    const value = document.querySelector('.you-figures .stat-value');
    const cal = document.querySelector('.you-page .cal-scroll');
    return { n: tiles.length, tops: [...new Set(tiles.map((r) => Math.round(r.top)))], minW: Math.round(Math.min(...tiles.map((r) => r.width))),
      inside: tiles.every((r) => r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5), overflow: col.scrollWidth - col.clientWidth,
      tabular: getComputedStyle(value).fontVariantNumeric, calAtToday: Math.abs(cal.scrollLeft + cal.clientWidth - cal.scrollWidth) <= 1 };
  })()`);
  check("five figures sit five across, inside the column, with nothing overflowing it", geo.n === 5 && geo.tops.length === 1 && geo.inside && geo.overflow === 0, geo);
  check("the figures are set in tabular numerals", geo.tabular.includes("tabular-nums"), geo.tabular);
  const card = await evalIn(c, `(() => {
    const card = document.querySelector('section[aria-label="Most used"]').getBoundingClientRect();
    const lists = [...document.querySelectorAll('section[aria-label="Most used"] .usage-toplist')].map((l) => l.getBoundingClientRect().bottom);
    const head = document.querySelector('.you-page .page-head .you-actions').getBoundingClientRect();
    // The figures row's edge, not the column's: the column bleeds 4px past its content for focus rings.
    const row = document.querySelector('.you-page .you-figures').getBoundingClientRect();
    return { slack: Math.round(card.bottom - Math.max(...lists)), actionsRight: Math.round(head.right), rowRight: Math.round(row.right), actionsAtRight: Math.abs(head.right - row.right) <= 1 };
  })()`);
  check("the Most used card is as tall as its lists, not as the column", card.slack <= 16, card);
  check("the picture's controls sit at the head's far end, on the figures' right edge", card.actionsAtRight, card);
  check("the calendar opens at its present end", geo.calAtToday, geo);
  const floor = await evalIn(c, `[...document.querySelectorAll('.you-page *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent
    && !e.closest('.cal-months, .cal-weekdays, .visually-hidden') && parseFloat(getComputedStyle(e).fontSize) < 11).map((e) => e.className + ':' + getComputedStyle(e).fontSize)`);
  check("nothing visible on the page is set below the 11px floor", floor.length === 0, floor);
  await shot(c, "dark");

  const todayCell = `[...document.querySelectorAll('.you-page .cal-grid .cal-cell')].find((td) => td.dataset.today !== undefined)`;
  const daily = await evalIn(c, `(() => { const t = ${todayCell}; return { level: t.dataset.level, title: t.title }; })()`);
  check("read daily, today's cell carries today's one message", daily.level !== "0" && daily.title.endsWith(": 1 message"), daily);
  await evalIn(c, `(() => { [...document.querySelectorAll('.you-page .seg-opt')].find((l) => l.textContent === 'Weekly').click(); return true; })()`);
  await sleep(300);
  const weekly = await evalIn(c, `(() => { const t = ${todayCell}; return { title: t.title }; })()`);
  check("read weekly, today's cell names its week", weekly.title.startsWith("Week of "), weekly);
  await shot(c, "weekly", ".you-page .usage-card");
  await evalIn(c, `(() => { [...document.querySelectorAll('.you-page .seg-opt')].find((l) => l.textContent === 'Cumulative').click(); return true; })()`);
  await sleep(300);
  const cumulative = await evalIn(c, `(() => { const t = ${todayCell}; return { level: t.dataset.level, title: t.title }; })()`);
  check("read cumulatively, today holds every message in the window, at the top of the scale", cumulative.level === "4" && /: 12 messages since /.test(cumulative.title), cumulative);
  await shot(c, "cumulative", ".you-page .usage-card");

  // 4. The picture.
  const original = path.join(scratch, "Desktop", "portrait.png");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, portraitPng());
  const set = await api.call("avatar.set", { path: original });
  check("the picture is copied under the Realm home, not referenced where it was", set.path.startsWith(path.join(home, "avatar") + path.sep) && fs.existsSync(set.path), set);
  const pic = await until(() => evalIn(c, `(() => { const img = document.querySelector('.you-page .page-head img.avatar'); return img && img.complete && img.naturalWidth > 0 ? { src: decodeURIComponent(img.getAttribute('src')), w: img.getBoundingClientRect().width, natural: img.naturalWidth } : null; })()`), 10_000, "picture");
  check("the page shows the copy through realm-media as soon as it is set, decoded", pic.src.includes(path.join(home, "avatar")) && !pic.src.includes("Desktop") && pic.w === 56 && pic.natural === 96, pic);
  fs.rmSync(original);
  // A fresh fetch of the same copy, past any cache: main still serves it with the original gone.
  const survived = await evalIn(c, `(async () => {
    const src = document.querySelector('.you-page .page-head img.avatar').getAttribute('src');
    const img = new Image(); img.src = src + '?after-delete=' + Date.now();
    try { await img.decode(); return { natural: img.naturalWidth }; } catch (e) { return { error: String(e) }; }
  })()`);
  check("the picture survives the original being deleted", survived.natural === 96 && fs.existsSync(set.path), survived);
  // …and the menu entry wears the same face.
  await evalIn(c, `(() => { document.querySelector('.strip-profile').click(); return true; })()`);
  const menuFace = await until(() => evalIn(c, `(() => { const img = document.querySelector('[role=menu][aria-label=Profiles] img.avatar'); return img && img.complete ? { src: decodeURIComponent(img.getAttribute('src')), w: img.offsetWidth } : null; })()`), 5000, "menu face");
  check("the menu entry wears the same picture, at 16px", menuFace.src === pic.src && menuFace.w === 16, menuFace);
  // Closed by its own toggle, not Escape: the page overlay under it answers Escape too, and closes.
  await evalIn(c, `(() => { document.querySelector('.strip-profile').click(); return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('[role=menu][aria-label=Profiles]')`), 5000, "menu closed");
  await shot(c, "picture", ".you-page .page-head");
  await evalIn(c, `(() => { [...document.querySelectorAll('.you-page button')].find((b) => b.textContent === 'Remove picture').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.you-page .page-head .avatar-initial')`), 5000, "initial back");
  check("Remove picture goes back to the initial and deletes the copy", !fs.existsSync(set.path), { copy: set.path });

  // The light face, set the way the Settings switch sets it and read back after a reload, so the
  // capture is the app's own light theme rather than an attribute flipped under a dark one.
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  await c.send("Page.reload", {});
  // Mid-navigation the page has no context to evaluate in, so a throw here is "not yet".
  await until(() => evalIn(c, `document.documentElement?.dataset.mode === 'light' && !!document.querySelector('.strip-profile')`).catch(() => false), 30_000, "light reload");
  await sleep(800);
  await evalIn(c, `(() => { document.querySelector('.strip-profile').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('[role=menu][aria-label=Profiles] [role=menuitem]')`), 5000, "menu (light)");
  await evalIn(c, `(() => { [...document.querySelectorAll('[role=menu][aria-label=Profiles] [role=menuitem]')].find((b) => b.querySelector('.menu-label')?.textContent === ${JSON.stringify(name)}).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.page-overlay[aria-label="You"] .you-figures .stat-tile')`), 10_000, "page (light)");
  await sleep(800);
  await shot(c, "light");
  await resize(780);
  await sleep(600);
  const narrow = await evalIn(c, `(() => {
    const col = document.querySelector('.you-page .page-content'), cr = col.getBoundingClientRect();
    const tiles = [...document.querySelectorAll('.you-figures .stat-tile')].map((t) => t.getBoundingClientRect());
    const cal = document.querySelector('.you-page .cal-scroll');
    return { overflow: col.scrollWidth - col.clientWidth, inside: tiles.every((r) => r.right <= cr.right + 0.5), rows: new Set(tiles.map((r) => Math.round(r.top))).size,
      calScrolls: cal.scrollWidth > cal.clientWidth, calAtToday: Math.abs(cal.scrollLeft + cal.clientWidth - cal.scrollWidth) <= 1 };
  })()`);
  check("in a narrow window the figures wrap inside the column rather than overflow it", narrow.overflow === 0 && narrow.inside, narrow);
  check("…and the calendar, now wider than its card, stays on this week", narrow.calScrolls && narrow.calAtToday, narrow);
  await shot(c, "narrow");
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
