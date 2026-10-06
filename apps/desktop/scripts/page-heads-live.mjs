/**
 * Live check for how a page's column is headed (run with: pnpm build && node apps/desktop/scripts/page-heads-live.mjs)
 *
 * The owner, 10-06, of the Library's column: "Can you make sure we have the title of the page for the
 * library here? And then also increase the top padding … where the title is so it looks more even".
 * The titles stood about 13pt under the column's rim while their first glyph stood about 24pt in from
 * the column's edge. Evenness is a fact about INK, which a stylesheet cannot state — a title's line box
 * carries its own leading above the caps — so this measures pixels: for the head of each column (the
 * Home sidebar's profile, the Library's, Scheduled's and Code review's titles, Settings' Back) the
 * first row of ink under the rim and the first column of ink in from the column's left edge, in both
 * faces, and lays the five columns side by side. Then it shrinks the window to its floor and below and
 * asks of each column whether what stands under its head — New task and the suggestions, Code review's
 * search and lists, the Library's sections, Settings' pages — is still whole or can be scrolled to.
 *
 * Nothing is billed: the onboarding session is switched to the scripted agent before anything could
 * reach it, nothing is typed into a prompter, and the one task is the scripted agent's on a date months
 * off; `gh` is the fixture's (REALM_GH_BIN), so nothing reaches GitHub. Ports: LIVE_SERVER_PORT /
 * LIVE_CDP_PORT (8791 / 9231). Scratch under LIVE_SCRATCH (default: the OS temp dir), screenshots under
 * LIVE_SHOTS (default: the scratch's parent), each name prefixed with LIVE_TAG when it is set. Kills
 * only what holds its own two ports, and only if it is this run's.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { buildFixture } from "../../server/scripts/fixtures/code-review-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8791);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9231);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1280, height: 820 };
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-page-heads-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(path.dirname(scratch), "page-heads-shots");
const TAG = process.env.LIVE_TAG ? `${process.env.LIVE_TAG}-` : "";
const home = path.join(scratch, "home");
let electron = null;
let api = null;
const daemonPids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

/* The fixture's gh, signed in, so Code review draws its column of requests. */
const ghDir = path.join(scratch, "gh");
fs.mkdirSync(ghDir, { recursive: true });
const fixturePath = path.join(ghDir, "fixture.json");
fs.writeFileSync(fixturePath, JSON.stringify({ ...buildFixture(), auth: "ready" }));
const ghBin = path.join(ghDir, "gh");
fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${path.join(ghDir, "calls.jsonl")}' exec '${process.execPath}' '${path.join(repoRoot, "apps/server/scripts/fixtures/fake-gh.mjs")}' "$@"\n`);
fs.chmodSync(ghBin, 0o755);

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

const HELPERS = `
globalThis.__heads = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; },
  railBtn(name) { return document.querySelector('.app-rail .rail-btn[aria-label^="' + name + '"]'); },
  menuRow(text) { return [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim().startsWith(text)) ?? null; },
  /* The column's head, whatever heads it: the profile at Home, a Back, or a page's title — the
     Library's own (drawn by the column) or the one Scheduled's and Code review's columns bring. Before
     the Library had a title, its first section stood there. */
  head() {
    const col = document.getElementById('app-sidebar');
    const profile = col.querySelector('.sb-list:not([hidden]) .sb-profile');
    if (profile) return { kind: 'profile', el: profile, row: profile };
    const back = col.querySelector('.sb-page-back');
    if (back) return { kind: 'back', el: back, row: back };
    const title = col.querySelector('.sb-page-title, .sb-page-nav .sched-col-title, .sb-page-nav .cr-col:not([aria-hidden]) .cr-col-title');
    if (title) return { kind: 'title', el: title, row: title.parentElement, text: title.textContent };
    const first = col.querySelector('.sb-page-nav .page-rail .settings-tab');
    return first ? { kind: 'row', el: first, row: first } : null;
  },
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
const note = (name, detail) => console.log(`NOTE ${name} ${JSON.stringify(detail)}`);

const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 });
/** Hold the window key: an unkeyed window greys its accent, and the live window opens behind. */
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);
const size = (c, height) => c.send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height, deviceScaleFactor: 2, mobile: false });

/**
 * Where the column's head puts its ink, in CSS px: the first row of ink under the rim (`top`) and the
 * first column of ink in from the column's left edge (`side`), read off one capture at the window's
 * device pixels. Ink is a pixel nearer the darkest-or-lightest mark in the head's box than the
 * ground — half-coverage, which is where an anti-aliased edge reads — so a row's fill, a few levels
 * off its ground, is not ink, and the glyphs and the text are.
 */
const HEAD_INK = `(async () => {
  const h = __heads.head();
  if (!h) return null;
  const col = document.getElementById('app-sidebar');
  const rim = col.querySelector('.sb-header').getBoundingClientRect().bottom;
  const edge = col.getBoundingClientRect().left;
  const box = h.row.getBoundingClientRect();
  // A title's own box, which stops short of its row's trailing control: a search or a ⋯ is ink too.
  const right = h.kind === 'title' ? h.el.getBoundingClientRect().right : box.right;
  // …and its first glyph's: a capital in every title here, so its ink's top is the caps' — the
  // ascenders of a "b" or a "d" stand half a pixel above them.
  const glyph = (() => { if (h.kind !== 'title') return null; const t = [...h.el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 1); return r.getBoundingClientRect().right; })();
  return { kind: h.kind, text: h.text ?? h.el.textContent.trim(), rim, edge, row: __heads.box(h.row), el: __heads.box(h.el),
    clip: { x: Math.floor(edge) + 1, y: Math.floor(rim) + 1, width: Math.ceil(right - edge), height: Math.ceil(box.bottom - rim) + 2 },
    glyphRight: glyph,
    font: h.kind === 'title' ? (() => { const cs = getComputedStyle(h.el); return cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontWeight; })() : null,
    // The first thing under the head: New task, Code review's search, a first section, Settings' search.
    next: __heads.box(col.querySelector('.sb-page-nav :is(.sched-new, .cr-col:not([aria-hidden]) .cr-col-search .search-field, .page-rail .settings-tab, .settings-search .search-field)')
      ?? col.querySelector('.sb-list:not([hidden]) .space-body > *')) };
})()`;

/** The ink box of a capture, in device px from its corner, and its scale. */
const INK = (data, width, glyphWidth) => `(async () => {
  const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(data)}; await img.decode();
  const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, cv.width, cv.height).data;
  const L = (x, y) => { const i = (y * cv.width + x) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
  const k = img.width / ${width};
  // The ground is what most of the box is; the mark is whatever is furthest from it.
  const all = []; for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) all.push(L(x, y));
  const ground = [...all].sort((a, b) => a - b)[Math.floor(all.length / 2)];
  const far = Math.max(...all.map((v) => Math.abs(v - ground)));
  const box = (xEnd) => { let top = null, left = null, bottom = null;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < xEnd; x++) {
      if (Math.abs(L(x, y) - ground) < far / 2) continue;
      if (top === null) top = y; bottom = y; left = left === null ? x : Math.min(left, x);
    }
    return { top, left, bottom }; };
  return { k, all: box(cv.width), glyph: ${glyphWidth === null ? "null" : `box(Math.ceil(${glyphWidth} * k))`} };
})()`;

async function inkOf(c) {
  const head = await evalIn(c, HEAD_INK);
  if (!head) return null;
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...head.clip, scale: 1 } });
  const ink = await evalIn(c, INK(data, head.clip.width, head.glyphRight === null ? null : head.glyphRight - head.clip.x));
  const k = ink.k;
  // Back to CSS px from the rim and from the column's edge (the clip starts a pixel past each, clear
  // of the rim's own hairline). A title is read off its first glyph — its caps' top and its own left —
  // and anything else off all of its ink.
  const at = ink.glyph ?? ink.all;
  const top = +((head.clip.y + at.top / k) - head.rim).toFixed(2);
  const side = +((head.clip.x + at.left / k) - head.edge).toFixed(2);
  return { kind: head.kind, text: head.text, top, side, uneven: +(top - side).toFixed(2),
    inkTop: +((head.clip.y + ink.all.top / k) - head.rim).toFixed(2), capHeight: +((at.bottom - at.top + 1) / k).toFixed(2),
    row: head.row, rowTop: +(head.row.t - head.rim).toFixed(2), next: head.next, nextTop: head.next ? +(head.next.t - head.rim).toFixed(2) : null, font: head.font };
}

/** The token, overridden in the page: what each inset would put where, read off the same ink. */
async function sweep(c, values) {
  const out = {};
  for (const v of values) {
    await evalIn(c, `(() => { document.getElementById('heads-sweep')?.remove(); const st = document.createElement('style'); st.id = 'heads-sweep';
      st.textContent = ':root { --col-head-top: ${v}px !important; }'; document.head.appendChild(st); return true; })()`);
    await evalIn(c, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    const m = await inkOf(c);
    out[v] = { top: m.top, side: m.side, inkTop: m.inkTop };
  }
  await evalIn(c, `(() => { document.getElementById('heads-sweep')?.remove(); return true; })()`);
  await evalIn(c, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  return out;
}

/** A capture as a person would see it: laid over the face's page colour first, since a capture holds
 *  the DOM's alpha and none of the window's material (design.md). */
async function shot(c, tag, clip, scale = 1) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale } } : {}) });
  const data = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(r.data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${TAG}${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${TAG}${tag} ${out}`);
  return data;
}

/** Several captures side by side on one canvas, each under its name and what was measured of it. */
async function sideBySide(c, tag, parts) {
  const data = await evalIn(c, `(async () => {
    const parts = ${JSON.stringify(parts)};
    const imgs = await Promise.all(parts.map(async (p) => { const i = new Image(); i.src = "data:image/png;base64," + p.data; await i.decode(); return i; }));
    const gap = 16, label = 64;
    const w = imgs.reduce((s, i) => s + i.width, 0) + gap * (imgs.length + 1), h = Math.max(...imgs.map((i) => i.height)) + label + gap;
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d");
    g.fillStyle = "#808080"; g.fillRect(0, 0, w, h);
    let x = gap;
    imgs.forEach((img, n) => {
      g.fillStyle = "#000"; g.font = "600 24px Inter, sans-serif"; g.fillText(parts[n].name, x, 26);
      g.font = "500 20px Inter, sans-serif"; g.fillText(parts[n].caption, x, 54);
      g.drawImage(img, x, label); x += img.width + gap;
    });
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${TAG}${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${TAG}${tag} ${out}`);
}

const HOME_READY = `!!document.querySelector('.composer') && !!document.querySelector('.sb-list:not([hidden]) .sb-profile')`;

/** Each column, opened the way a person opens it, and what it must still show under its head. */
const COLUMNS = [
  { name: "Home", open: null, ready: HOME_READY },
  { name: "Library", open: `__heads.railBtn('Library').click()`, ready: `!!document.querySelector('.sb-page-nav .page-rail .settings-tab')`,
    under: `[...document.querySelectorAll('.sb-page-nav .page-rail .settings-tab')]`, scroller: `document.querySelector('.sb-page-nav')` },
  { name: "Scheduled", open: `__heads.railBtn('Scheduled tasks').click()`, ready: `!!document.querySelector('.sb-page-nav .sched-col-head') && !!document.querySelector('.sb-page-nav .sched-suggestion')`,
    under: `[document.querySelector('.sb-page-nav .sched-new'), ...document.querySelectorAll('.sb-page-nav .sched-task-hit, .sb-page-nav .sched-suggestion')]`,
    scroller: `document.querySelector('.sb-page-nav .sched-col-body')` },
  { name: "Code review", open: `__heads.railBtn('Code review').click()`, ready: `!!document.querySelector('.sb-page-nav .cr-col:not([aria-hidden]) .cr-col-head') && !!document.querySelector('.sb-page-nav .cr-row')`,
    under: `[document.querySelector('.sb-page-nav .cr-col-search .search-field'), ...document.querySelectorAll('.sb-page-nav .cr-row, .sb-page-nav .cr-section-toggle')]`,
    scroller: `document.querySelector('.sb-page-nav .cr-col-body')` },
  { name: "Settings", open: `(async () => { document.querySelector('.app-rail .rail-foot button[aria-haspopup="menu"]').click();
      await new Promise((r) => setTimeout(r, 300)); __heads.menuRow('Settings').click(); return true; })()`,
    ready: `!!document.querySelector('.sb-page-nav .settings-rail') && !!document.querySelector('.sb-page-back')`,
    under: `[document.querySelector('.sb-page-nav .settings-search'), ...document.querySelectorAll('.sb-page-nav .settings-rail .settings-tab')]`,
    scroller: `document.querySelector('.sb-page-nav .settings-rail-lists')` },
];

async function goHome(c) {
  await evalIn(c, `__heads.railBtn('Home').click()`);
  await until(() => evalIn(c, `!document.querySelector('.page-overlay') && ${HOME_READY}`), 8_000, "home");
  await park(c);
  await sleep(400);
}

async function openColumn(c, col) {
  if (col.open) await evalIn(c, col.open);
  await until(() => evalIn(c, col.ready), 15_000, col.name);
  await park(c);
  // The page rises in; read it once it has stood still.
  await sleep(800);
}

async function setFace(c, mode) {
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `${HOME_READY} && document.documentElement.dataset.mode === '${mode}'`), 30_000, `the ${mode} face`);
  await holdKey(c);
  await park(c);
  await sleep(900);
}

const CROP = { x: 0, y: 0, width: 340, height: 300 };

async function measureFace(c, mode) {
  const parts = [];
  const read = {};
  for (const col of COLUMNS) {
    await openColumn(c, col);
    const m = await inkOf(c);
    read[col.name] = m;
    note(`${mode} ${col.name}: the head's ink under the rim (top) and in from the column's edge (side), CSS px`, m);
    // Where each top would put a title's caps — the old 6px among them — off the same ink.
    if (m?.kind === "title") note(`${mode} ${col.name}: --col-head-top → its caps under the rim, its first glyph in`, await sweep(c, [6, 16, 17, 17.5, 18, 19, 20]));
    parts.push({ name: col.name, caption: m ? `${m.kind}: ink ${m.top} under the rim, ${m.side} in` : "no head", data: await shot(c, `${mode}-column-${col.name.toLowerCase().replace(/\s+/g, "-")}`, CROP) });
    await shot(c, `${mode}-page-${col.name.toLowerCase().replace(/\s+/g, "-")}`, { x: 0, y: 0, width: 900, height: 420 });
    if (col.open) await goHome(c);
  }
  await sideBySide(c, `${mode}-columns-side-by-side`, parts);
  return read;
}

/** At a short window: is everything under each column's head whole, or reachable by scrolling it? */
async function shortWindow(c, height) {
  await size(c, height);
  await sleep(400);
  const parts = [];
  for (const col of COLUMNS.filter((x) => x.under)) {
    await openColumn(c, col);
    const fit = await evalIn(c, `(() => {
      const head = __heads.head(); const headBottom = head ? head.row.getBoundingClientRect().bottom : 0;
      const scroller = ${col.scroller};
      const column = document.getElementById('app-sidebar').getBoundingClientRect();
      const items = ${col.under}.filter(Boolean);
      const first = items[0].getBoundingClientRect();
      const before = { firstTop: +first.top.toFixed(2), firstBottom: +first.bottom.toFixed(2), headBottom: +headBottom.toFixed(2), columnBottom: +column.bottom.toFixed(2) };
      // The first thing under the head is whole and below it — a search stands outside the scroller,
      // so it is held to the column — and then the last is reached by scrolling.
      const firstWhole = first.top >= headBottom - 0.5 && first.bottom <= column.bottom + 0.5;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      const last = items[items.length - 1].getBoundingClientRect();
      const sb = (scroller ?? document.getElementById('app-sidebar')).getBoundingClientRect();
      const lastWhole = last.bottom <= sb.bottom + 0.5 && last.top >= sb.top - 0.5;
      const scrolls = scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : false;
      if (scroller) scroller.scrollTop = 0;
      return { ...before, items: items.length, firstWhole, lastWhole, scrolls, lastBottom: +last.bottom.toFixed(2), scrollerBottom: +sb.bottom.toFixed(2) };
    })()`);
    check(`${height}px window, ${col.name}: the first thing under the head is whole, and the last can be scrolled to`, fit.firstWhole && fit.lastWhole, fit);
    parts.push({ name: col.name, caption: `${height}px: ${fit.items} under the head${fit.scrolls ? ", scrolls" : ""}`, data: await shot(c, `short-${height}-column-${col.name.toLowerCase().replace(/\s+/g, "-")}`, { x: 0, y: 0, width: 340, height }) });
    await goHome(c);
  }
  await sideBySide(c, `short-${height}-columns-side-by-side`, parts);
  await size(c, VIEW.height);
  await sleep(400);
}

/** With the sidebar folded away the Scheduled and Code review columns stand in the page, heads and all. */
async function folded(c) {
  await evalIn(c, `document.querySelector('button[aria-controls="app-sidebar"]').click()`);
  await until(() => evalIn(c, `document.querySelector('.app').hasAttribute('data-sidebar-folded')`), 5_000, "folded");
  for (const [name, open, title] of [["Scheduled", `__heads.railBtn('Scheduled tasks').click()`, ".page-overlay .sched-col-title"], ["Code review", `__heads.railBtn('Code review').click()`, ".page-overlay .cr-col:not([aria-hidden]) .cr-col-title"]]) {
    await evalIn(c, open);
    await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(title)})`), 15_000, `${name} in the page`);
    await park(c);
    await sleep(800);
    const geo = await evalIn(c, `(() => { const t = document.querySelector(${JSON.stringify(title)}); const col = t.closest('.sched-col, .cr-col');
      const r = document.createRange(); r.setStart(t.firstChild, 0); r.setEnd(t.firstChild, 1);
      return { rim: document.querySelector('.page-overlay-bar').getBoundingClientRect().bottom, edge: col.getBoundingClientRect().left, title: __heads.box(t),
        head: __heads.box(t.parentElement), glyphRight: r.getBoundingClientRect().right }; })()`);
    const clip = { x: Math.floor(geo.edge) + 1, y: Math.floor(geo.rim) + 1, width: Math.ceil(geo.title.r - geo.edge), height: Math.ceil(geo.head.b - geo.rim) + 2 };
    const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
    const ink = await evalIn(c, INK(data, clip.width, geo.glyphRight - clip.x));
    note(`folded, ${name} in the page: its title's caps under the page's top (top) and its first glyph in from the column's edge (side)`,
      { top: +((clip.y + ink.glyph.top / ink.k) - geo.rim).toFixed(2), side: +((clip.x + ink.glyph.left / ink.k) - geo.edge).toFixed(2), head: geo.head });
    await shot(c, `folded-${name.toLowerCase().replace(/\s+/g, "-")}`, { x: 0, y: 0, width: 640, height: 300 });
    await evalIn(c, open);
    await until(() => evalIn(c, `!document.querySelector('.page-overlay')`), 8_000, `${name} put away`);
  }
  await evalIn(c, `document.querySelector('button[aria-controls="app-sidebar"]').click()`);
  await until(() => evalIn(c, `!document.querySelector('.app').hasAttribute('data-sidebar-folded')`), 5_000, "open again");
  await sleep(600);
}

/** Files in the Library, so the page beside its column is the page a person sees. */
function seedLibrary(sessionId) {
  const dir = path.join(scratch, "files");
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [from, to] of [["docs/images/workspace.png", "workspace.png"], ["docs/images/connections.png", "connections.png"], ["site/public/product/session.png", "session.png"]]) {
    const p = path.join(dir, to); fs.copyFileSync(path.join(repoRoot, from), p); files.push(p);
  }
  for (const [name, body] of [["release-notes.md", "# Release notes\n"], ["usage-by-day.csv", "day,turns\n2026-10-01,12\n"]]) {
    const p = path.join(dir, name); fs.writeFileSync(p, body); files.push(p);
  }
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const rows = files.map((p, i) => {
    const name = path.basename(p), ext = name.slice(name.lastIndexOf(".") + 1);
    return `INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES (${q(`${sessionId}:${i + 1}:${p}`)}, ${q(sessionId)}, ${i + 1}, 'output', ${q(p)}, ${q(name)}, ${q(ext)}, ${Date.now() - i * 3_600_000});`;
  });
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), rows.join("\n")]);
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
      REALM_GH_BIN: ghBin,
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
  // Onboarding's session runs the person's real engine; it is switched to the fake before anything
  // could reach it, and the one task below is the fake's too.
  const sessions = await api.call("sessions.listAll", { profileId: null });
  for (const s of sessions) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });
  seedLibrary(sessions[0].id);
  // A task due on New Year's Day, so it never fires while this runs.
  await api.call("schedules.create", { spaceId: sessions[0].spaceId, title: "Release notes", goal: "Draft the week's release notes from the merged pull requests.",
    cron: "0 9 1 1 *", constraints: { agentKind: "fake" } });

  const faces = {};
  for (const mode of ["dark", "light"]) {
    await setFace(c, mode);
    faces[mode] = await measureFace(c, mode);
  }
  /* What evenness asks: a title's ink as far under the rim as it stands in from the column's edge.
     Reported for every column; held for the titles, which are what the owner asked to be even. */
  for (const mode of ["dark", "light"]) {
    for (const [name, m] of Object.entries(faces[mode])) {
      if (m?.kind !== "title") continue;
      check(`${mode} ${name}: its title's caps stand as far under the rim as its first glyph stands in from the column's edge`, Math.abs(m.top - m.side) <= 0.5, { top: m.top, side: m.side });
    }
    const titles = Object.entries(faces[mode]).filter(([, m]) => m?.kind === "title");
    if (titles.length > 1) {
      const tops = titles.map(([, m]) => m.top), sides = titles.map(([, m]) => m.side), nexts = titles.map(([, m]) => m.nextTop);
      check(`${mode}: every column's title is on one line and one inset`, Math.max(...tops) - Math.min(...tops) <= 0.5 && Math.max(...sides) - Math.min(...sides) <= 1.5,
        Object.fromEntries(titles.map(([n, m]) => [n, { top: m.top, side: m.side }])));
      check(`${mode}: …and what follows each starts on one line`, Math.max(...nexts) - Math.min(...nexts) <= 0.5, Object.fromEntries(titles.map(([n, m]) => [n, m.nextTop])));
    }
  }
  await setFace(c, "dark");
  for (const height of [600, 480]) await shortWindow(c, height);
  await folded(c);
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
