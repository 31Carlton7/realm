/**
 * Live check: Settings' grouped rail and its search, and the Appearance controls (Plan 26 W9)
 * (run with: pnpm build && node apps/desktop/scripts/settings-groups-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and measures, in the real window:
 *
 *   1. The rail: five headings over their pages, the search above them in the same column, and the
 *      whole rail inside the page at the smallest window the app allows.
 *   2. A search: results stand in for the page, each row at least a desktop hit area tall, nothing
 *      wider than the column. A result lands on its row — the page lit, the row in the viewport, its
 *      control focused, an accent edge down the row's inside that is gone two seconds later.
 *   3. A result for the folded face opens its disclosure.
 *   4. Narrow: the search keeps a line of its own and the pages lie down into a strip under it.
 *   5. Both faces, captured and read back.
 *   6. Appearance (W9b): Reduce motion answers through prefers-reduced-motion itself; the sidebar
 *      and panes take their own alphas; UI and code sizes scale their own text and hold the 11px
 *      floor without touching page zoom; prose takes the content face and the chrome does not.
 *   7. General (W9c): the editors this Mac has, offered on a path in a real transcript; the session
 *      terminal docked to the pane's foot with the prompter above it; and the Mac held awake by
 *      main exactly while a turn runs (`pmset -g assertions`).
 *   8. Computer use (W9d): a space's card reads and writes that space's own provider and its
 *      always-allowed apps, read back from the server.
 *
 * Ports: LIVE_SERVER_PORT (8962), LIVE_CDP_PORT (9362). Touches only a scratch dir. Nothing is billed:
 * no message is sent to any session.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9362);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8962);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-settings-groups-live-"));
const home = path.join(scratch, "home");
const OUT = (tag) => path.join(os.tmpdir(), `realm-settings-groups-${tag}.png`);
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

/** Helpers that live in the page, so each check reads as what it measures. */
const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; },
  async openSettings() {
    if (document.querySelector(".settings-page-pane")) return true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette input"); i++) await new Promise((r) => setTimeout(r, 25));
    // Typed, not picked from the opening list: with a session focused that list leads with the
    // session's own commands, and "Open settings" is only certain to be there once asked for.
    const input = document.querySelector(".palette input");
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "settings");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    for (let i = 0; i < 40; i++) {
      const hit = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")].find((b) => /open settings/i.test(b.textContent));
      if (hit) { hit.click(); break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    return !!document.querySelector(".settings-page-pane");
  },
  async page(value) {
    document.querySelector('.settings-page-pane .page-rail input[value="' + value + '"]').click();
    await new Promise((r) => setTimeout(r, 250));
    return true;
  },
  type(q) {
    const f = document.querySelector(".settings-search");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(f, q);
    f.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  rail() {
    const rail = document.querySelector(".settings-page-pane .page-rail");
    const body = document.querySelector(".settings-page-pane .page-body");
    const search = rail.querySelector(".settings-search");
    const heads = [...rail.querySelectorAll(".page-rail-head")];
    const tabs = [...rail.querySelectorAll(".page-rail-tab")];
    return {
      rail: this.box(rail), body: this.box(body), search: this.box(search),
      groups: [...rail.querySelectorAll("fieldset.page-rail-list")].map((f) => [f.querySelector(".page-rail-head").textContent, [...f.querySelectorAll(".page-rail-tab")].map((t) => t.textContent)]),
      headFont: heads.map((h) => parseFloat(getComputedStyle(h).fontSize)),
      tabs: tabs.map((t) => ({ text: t.textContent, ...this.box(t) })),
      selected: tabs.filter((t) => t.hasAttribute("data-selected")).map((t) => t.textContent),
    };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** A capture of the page, optionally clipped, written to the temp dir and named in the log. */
async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  return data;
}

/** Mean RGB of a small square of a capture, decoded in the page. `x`/`y` are CSS px of the page. */
async function sample(c, x, y, size = 2) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x, y, width: size, height: size, scale: 1 } });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data; const n = d.length / 4; const m = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
    return m.map((v) => Math.round(v / n));
  })()`);
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

async function boot() {
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
  return c;
}

async function main() {
  const c = await boot();
  const size = (width, height = 900) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await size(1300);
  await until(() => evalIn(c, `__live.openSettings()`), 20_000, "settings");
  await sleep(500);

  /* ── 1. The rail ─────────────────────────────────────────────────────────────────────────── */
  let r = await evalIn(c, `__live.rail()`);
  check("the rail lists the pages under their five headings", JSON.stringify(r.groups) === JSON.stringify([
    ["You", ["General", "Appearance", "Keys", "Notifications"]], ["Engines", ["Engines", "Usage"]],
    ["Browser", ["Sign-ins"]], ["Computer", ["Permissions", "Computer use"]], ["Data", ["Import"]],
  ]), r.groups);
  check("Settings opens on General", JSON.stringify(r.selected) === '["General"]', r.selected);
  check("the search sits at the top of the rail, the column's own width", r.search.t <= r.tabs[0].t && r.search.l === r.rail.l && r.search.r === r.rail.r, { search: r.search, rail: r.rail });
  check("the tabs share the search's column", r.tabs.every((t) => t.l === r.rail.l && t.r === r.rail.r), r.tabs.slice(0, 2));
  check("no heading is set under the type floor", r.headFont.every((f) => f >= 11), r.headFont);
  for (const height of [900, 600]) {
    await size(1300, height);
    await sleep(300);
    r = await evalIn(c, `__live.rail()`);
    check(`at a ${height}px window the whole rail is inside the page`, r.rail.b <= r.body.b, { rail: r.rail, body: r.body });
    // Shorter than the rail, the lists scroll under the search: the last page has to be reachable.
    const last = await evalIn(c, `(() => {
      const lists = document.querySelector('.settings-rail-lists'); lists.scrollTop = lists.scrollHeight;
      const tabs = [...lists.querySelectorAll('.page-rail-tab')]; const lb = lists.getBoundingClientRect();
      const t = tabs[tabs.length - 1].getBoundingClientRect();
      const out = { lists: { t: Math.round(lb.top), b: Math.round(lb.bottom), scroll: lists.scrollHeight, client: lists.clientHeight }, last: { t: Math.round(t.top), b: Math.round(t.bottom) } };
      lists.scrollTop = 0; return out; })()`);
    check(`at a ${height}px window the last page can be scrolled to under the search`, last.last.b <= last.lists.b + 1 && last.last.t >= last.lists.t, last);
  }
  await size(1300);
  await sleep(300);
  const railClip = { x: r.rail.l - 12, y: r.rail.t - 12, width: r.rail.w + 24, height: r.rail.h + 24 };
  await shoot(c, "rail-dark", railClip);

  /* ── 2. A search, and a jump ─────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.type("font")`);
  await sleep(300);
  const res = await evalIn(c, `(() => {
    const col = document.querySelector('.settings-page-pane .page-content');
    const rows = [...col.querySelectorAll('.settings-result')];
    return {
      rows: rows.map((li) => ({ text: li.querySelector('.settings-row-name').textContent, place: li.querySelector('.settings-result-place').textContent, ...__live.box(li.querySelector('.settings-result-hit')) })),
      col: __live.box(col), scroll: col.scrollWidth, client: col.clientWidth,
      checked: document.querySelectorAll('.settings-page-pane .page-rail input:checked').length,
      general: !!document.querySelector('[aria-label="Ask before deleting"]'),
    };
  })()`);
  note("results for \"font\"", res.rows.map((x) => `${x.text} — ${x.place}`));
  check("results stand in for the page, and no page is lit over them", res.rows.length >= 3 && !res.general && res.checked === 0, { n: res.rows.length, general: res.general, checked: res.checked });
  check("each result is a desktop hit area tall", res.rows.every((x) => x.h >= 40), res.rows.map((x) => x.h));
  check("each result's place sits at the end of its row", res.rows.every((x) => x.place.length > 0), null);
  check("nothing in the results is wider than the column", res.scroll === res.client, { scroll: res.scroll, client: res.client });
  await shoot(c, "results-dark", { x: res.col.l - 8, y: res.col.t - 8, width: res.col.w + 16, height: Math.min(res.col.h, 360) + 16 });

  // Jump to the code font. Measured inside the mark's 1.6s.
  await evalIn(c, `(() => { [...document.querySelectorAll('.settings-result-hit')].find((b) => b.textContent.startsWith('Code font')).click(); return true; })()`);
  await sleep(450);
  const landed = await evalIn(c, `(() => {
    const row = document.querySelector('[data-setting="code-font"]');
    const col = document.querySelector('.settings-page-pane .page-content');
    const sel = row.querySelector('select');
    return { row: __live.box(row), col: __live.box(col), focused: document.activeElement === sel, found: row.hasAttribute('data-found'),
      lit: [...document.querySelectorAll('.settings-page-pane .page-rail-tab[data-selected]')].map((t) => t.textContent),
      edge: getComputedStyle(row).boxShadow, query: document.querySelector('.settings-search').value };
  })()`);
  check("the result opened Appearance and cleared the search", JSON.stringify(landed.lit) === '["Appearance"]' && landed.query === "", { lit: landed.lit, query: landed.query });
  check("the row it named is in the column's viewport", landed.row.t >= landed.col.t && landed.row.b <= landed.col.b, { row: landed.row, col: landed.col });
  check("its control has focus", landed.focused, null);
  check("it wears the accent edge", landed.found && /inset/.test(landed.edge), landed.edge);
  const edgeAt = await sample(c, landed.row.l + 1, landed.row.t + Math.round(landed.row.h / 2) - 1);
  const fillAt = await sample(c, landed.row.l + 40, landed.row.t + Math.round(landed.row.h / 2) - 1);
  note("edge vs fill while marked", { edgeAt, fillAt });
  check("the edge is a different colour from the row's fill while it is marked", edgeAt.some((v, i) => Math.abs(v - fillAt[i]) > 30), { edgeAt, fillAt });
  await shoot(c, "landed-dark", { x: landed.row.l - 12, y: landed.row.t - 12, width: landed.row.w + 24, height: landed.row.h + 24 });
  await sleep(2200);
  const later = await evalIn(c, `(() => { const row = document.querySelector('[data-setting="code-font"]'); return { found: row.hasAttribute('data-found'), edge: getComputedStyle(row).boxShadow }; })()`);
  const edgeAfter = await sample(c, landed.row.l + 1, landed.row.t + Math.round(landed.row.h / 2) - 1);
  check("two seconds later the mark is gone", !later.found && later.edge === "none" && edgeAfter.every((v, i) => Math.abs(v - fillAt[i]) <= 12), { later, edgeAfter, fillAt });

  // The jump left Appearance scrolled down to the code font; General must not open there.
  const appearanceTop = await evalIn(c, `document.querySelector('.settings-page-pane .page-content').scrollTop`);
  await evalIn(c, `__live.page("general")`);
  const generalTop = await evalIn(c, `document.querySelector('.settings-page-pane .page-content').scrollTop`);
  check("a page opened from the rail starts at its top, not where the last one was left", appearanceTop > 100 && generalTop === 0, { appearanceTop, generalTop });
  await evalIn(c, `__live.page("appearance")`);

  /* ── 3. The folded face ──────────────────────────────────────────────────────────────────── */
  const folded = await evalIn(c, `(() => { const live = document.querySelector('.settings-row[data-live]').getAttribute('data-setting'); return live === 'palette-dark' ? 'Light theme' : 'Dark theme'; })()`);
  const foldId = folded === "Light theme" ? "palette-light" : "palette-dark";
  const before = await evalIn(c, `document.querySelector('[data-setting="${foldId}"] details').open`);
  await evalIn(c, `__live.type(${JSON.stringify(folded)})`);
  await sleep(250);
  await evalIn(c, `(() => { document.querySelector('.settings-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(450);
  const after = await evalIn(c, `document.querySelector('[data-setting="${foldId}"] details').open`);
  check(`Enter on "${folded}" opens the folded face it lands on`, before === false && after === true, { before, after });

  /* ── 4. Narrow ───────────────────────────────────────────────────────────────────────────── */
  await size(600);
  await sleep(500);
  await evalIn(c, `__live.page("general")`);
  const narrow = await evalIn(c, `(() => {
    const rail = document.querySelector('.settings-page-pane .page-rail');
    const lists = rail.querySelector('.settings-rail-lists');
    const search = rail.querySelector('.settings-search');
    const col = document.querySelector('.settings-page-pane .page-content');
    return { rail: __live.box(rail), search: __live.box(search), lists: __live.box(lists), col: __live.box(col),
      strip: { scroll: lists.scrollWidth, client: lists.clientWidth }, dir: getComputedStyle(lists).flexDirection };
  })()`);
  check("narrow, the search takes the rail's full line", narrow.search.w === narrow.rail.w && narrow.search.w >= narrow.col.w - 16, { search: narrow.search, rail: narrow.rail, col: narrow.col });
  const overlap = await evalIn(c, `(() => {
    const tabs = [...document.querySelectorAll('.settings-rail-lists .page-rail-tab, .settings-rail-lists .page-rail-head')].map((t) => t.getBoundingClientRect());
    let worst = 0; for (let i = 1; i < tabs.length; i++) worst = Math.max(worst, tabs[i - 1].right - tabs[i].left);
    return worst; })()`);
  check("…with no two items in the strip drawn over each other", overlap <= 0.5, { worstOverlapPx: overlap });
  check("…and the pages lie down into a strip under it", narrow.dir === "row" && narrow.lists.t >= narrow.search.b, { dir: narrow.dir, lists: narrow.lists, search: narrow.search });
  check("…which scrolls rather than squeezing the pages", narrow.strip.scroll > narrow.strip.client, narrow.strip);
  check("…and the content starts under the strip", narrow.col.t >= narrow.lists.b, { col: narrow.col, lists: narrow.lists });
  await shoot(c, "narrow-dark", { x: 0, y: Math.max(0, narrow.rail.t - 60), width: 600, height: 300 });
  await size(1300);
  await sleep(400);

  /* ── 5. The light face ───────────────────────────────────────────────────────────────────── */
  await evalIn(c, `__live.page("appearance")`);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-theme"][value="light"]').click(); return true; })()`);
  await sleep(600);
  await evalIn(c, `__live.page("general")`);
  r = await evalIn(c, `__live.rail()`);
  // The search field's edge is its fill against the ground, so it is measured where the ground is
  // exactly --canvas: under Reduce Transparency, which a DOM capture renders truthfully. The rows on
  // the same ground are the reference step — they read as cards on this face.
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  await sleep(300);
  const lum = ([r8, g8, b8]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r8) + 0.7152 * f(g8) + 0.0722 * f(b8); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 1000) / 1000; };
  const fieldAt = await sample(c, r.search.r - 20, r.search.t + 8, 4);
  const groundAt = await sample(c, r.search.r - 20, r.search.b + 6, 4);
  // A row on screen, sampled in its top padding at the right, where nothing is drawn on it.
  const firstRow = await evalIn(c, `(() => { const col = document.querySelector('.settings-page-pane .page-content').getBoundingClientRect();
    const row = [...document.querySelectorAll('.settings-page-pane .page-content .settings-row')].find((r) => r.getBoundingClientRect().top >= col.top + 4);
    return __live.box(row); })()`);
  const rowAt = await sample(c, firstRow.r - 30, firstRow.t + 3, 4);
  note("light, reduced transparency: field / row / their ground", { fieldAt, rowAt, groundAt, field: ratio(fieldAt, groundAt), row: ratio(rowAt, groundAt) });
  check("light: the search field is a visible step off its ground, no weaker than the rows'", ratio(fieldAt, groundAt) >= ratio(rowAt, groundAt) && ratio(fieldAt, groundAt) > 1.03,
    { field: ratio(fieldAt, groundAt), row: ratio(rowAt, groundAt) });
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await sleep(300);
  await shoot(c, "rail-light", { x: r.rail.l - 12, y: r.rail.t - 12, width: r.rail.w + 24, height: r.rail.h + 24 });
  await evalIn(c, `__live.type("notif")`);
  await sleep(300);
  const col = await evalIn(c, `__live.box(document.querySelector('.settings-page-pane .page-content'))`);
  await shoot(c, "results-light", { x: col.l - 8, y: col.t - 8, width: col.w + 16, height: Math.min(col.h, 420) + 16 });
  await evalIn(c, `(() => { [...document.querySelectorAll('.settings-result-hit')].find((b) => b.textContent.startsWith('Volume')).click(); return true; })()`);
  await sleep(450);
  const light = await evalIn(c, `(() => { const row = document.querySelector('[data-setting="sound-volume"]'); return { row: __live.box(row), found: row.hasAttribute('data-found'), lit: [...document.querySelectorAll('.settings-page-pane .page-rail-tab[data-selected]')].map((t) => t.textContent) }; })()`);
  const lEdge = await sample(c, light.row.l + 1, light.row.t + Math.round(light.row.h / 2) - 1);
  const lFill = await sample(c, light.row.l + 40, light.row.t + Math.round(light.row.h / 2) - 1);
  check("light: a result lands on Notifications with the edge showing", JSON.stringify(light.lit) === '["Notifications"]' && light.found && lEdge.some((v, i) => Math.abs(v - lFill[i]) > 30), { lit: light.lit, lEdge, lFill });
  await shoot(c, "landed-light", { x: light.row.l - 12, y: light.row.t - 12, width: light.row.w + 24, height: light.row.h + 24 });
  await shoot(c, "page-light");

  await appearanceChecks(c, size);
  await generalChecks(c, size);
  await computerUseChecks(c, size);
}

/* ══ W9d: Computer use ═════════════════════════════════════════════════════════════════════════
   The page gathers; the space decides. So every reading here is taken from the server for the
   space, not from the page: the switch moves the space's own provider, and an app removed on the
   page is gone from that space's list. */
async function computerUseChecks(c, size) {
  await size(1300);
  const [space] = await api.call("spaces.list", {});
  const computerProvider = async () => (await api.call("mcp.providers.list", { spaceId: space.id })).providers.find((p) => p.name === "realm-computer");
  await api.call("computer.allowedApps.set", { spaceId: space.id, apps: ["com.apple.Notes", "com.apple.TextEdit"] });
  const before = await computerProvider();
  note("the space's realm-computer provider before", before);
  await until(() => evalIn(c, `__live.openSettings()`), 15_000, "settings for computer use");
  // The light face first: the General pass leaves the window on dark.
  await evalIn(c, `__live.page("appearance")`);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-theme"][value="light"]').click(); return true; })()`);
  await sleep(400);
  await evalIn(c, `__live.page("computer-use")`);
  await until(() => evalIn(c, `!![...document.querySelectorAll('.settings-page-pane .computer-app-id')].length`), 10_000, "allowed apps");
  const page = await evalIn(c, `(() => {
    const card = document.querySelector('.settings-page-pane [aria-label="Computer control in ${space.name}"]');
    const sw = card.querySelector('input[role="switch"]');
    const rows = [...card.querySelectorAll('.settings-row')].map((r) => __live.box(r));
    return { grants: !!document.querySelector('.settings-page-pane .computer-access-field'),
      switch: sw ? { checked: sw.checked, label: sw.getAttribute('aria-label') } : null,
      state: card.querySelector('.mcp-provider-state')?.textContent ?? null,
      apps: [...card.querySelectorAll('.computer-app-id')].map((a) => a.textContent),
      rows, card: __live.box(card), mono: getComputedStyle(card.querySelector('.computer-app-id')).fontFamily };
  })()`);
  note("the space's card", page);
  check("Computer use holds the macOS grants and the space's card", page.grants && page.card.h > 0, { grants: page.grants });
  check("the card lists the apps the space lets agents drive, as identifiers", JSON.stringify(page.apps) === '["com.apple.Notes","com.apple.TextEdit"]' && /Mono|monospace/.test(page.mono), { apps: page.apps, mono: page.mono });
  check("every row of the card is a desktop hit area tall", page.rows.every((r) => r.h >= 40), page.rows.map((r) => r.h));
  if (page.switch) {
    check("the switch reads the space's own provider", page.switch.checked === before.enabled, { page: page.switch, server: before });
    await evalIn(c, `(() => { document.querySelector('.settings-page-pane input[aria-label="Let agents in ${space.name} control this Mac"]').click(); return true; })()`);
    const moved = await until(async () => { const p = await computerProvider(); return p.enabled !== before.enabled ? p : null; }, 5000, "provider written").catch(() => null);
    check("flipping it writes the space's provider on the server", !!moved, moved);
    await evalIn(c, `(() => { document.querySelector('.settings-page-pane input[aria-label="Let agents in ${space.name} control this Mac"]').click(); return true; })()`);
    const back = await until(async () => { const p = await computerProvider(); return p.enabled === before.enabled ? p : null; }, 5000, "provider back").catch(() => null);
    check("…and flipping it back restores it", !!back, back);
  } else {
    check("where this Mac cannot honour the switch, the card says why instead", typeof page.state === "string" && page.state.length > 0, page.state);
  }
  const clip = { x: page.card.l - 12, y: Math.max(0, page.card.t - 12), width: page.card.w + 24, height: page.card.h + 24 };
  await shoot(c, "computer-use-light", clip);
  await evalIn(c, `(() => { document.querySelector('.settings-page-pane button[aria-label="Remove com.apple.Notes from ${space.name}"]').click(); return true; })()`);
  const left = await until(async () => { const { apps } = await api.call("computer.allowedApps.list", { spaceId: space.id }); return apps.length === 1 ? apps : null; }, 5000, "app removed").catch(() => null);
  check("Remove takes the app out of that space's list on the server", JSON.stringify(left) === '["com.apple.TextEdit"]', left);
  await evalIn(c, `__live.page("appearance")`);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-theme"][value="dark"]').click(); return true; })()`);
  await sleep(400);
  await evalIn(c, `__live.page("computer-use")`);
  await sleep(500);
  const dark = await evalIn(c, `__live.box(document.querySelector('.settings-page-pane [aria-label="Computer control in ${space.name}"]'))`);
  await shoot(c, "computer-use-dark", { x: dark.l - 12, y: Math.max(0, dark.t - 12), width: dark.w + 24, height: dark.h + 24 });
}

/* ══ W9c: General ══════════════════════════════════════════════════════════════════════════════
   The three settings that reach past the page: an editor this Mac really has, offered on a path in
   a real transcript; the session's terminal docked to the pane's foot; and the Mac kept awake by
   main for exactly as long as a turn runs, read off `pmset -g assertions`. Every message goes to
   the scripted fake agent. Nothing is ever opened in the editor: the click would launch it on this
   Mac, and the unit tests already hold what it would run. */
async function generalChecks(c, size) {
  await size(1300);
  await evalIn(c, `__live.openSettings()`);
  await evalIn(c, `__live.page("general")`);
  await sleep(400);
  const installed = await evalIn(c, `window.realm.editors.list()`);
  note("editors this Mac has", installed);
  const options = await evalIn(c, `(() => { const s = document.querySelector('select[aria-label="Open files in"]'); return s ? { value: s.value, options: [...s.options].map((o) => o.textContent) } : null; })()`);
  check("Open files in lists exactly the editors this Mac has, then Realm, the first chosen",
    installed.length === 0 ? options === null : !!options && JSON.stringify(options.options) === JSON.stringify([...installed.map((e) => e.name), "Realm"]) && options.value === installed[0].id,
    { installed, options });
  await evalIn(c, `(() => { document.querySelector('input[name="settings-terminal-dock"][value="bottom"]').click(); return true; })()`);
  await evalIn(c, `(() => { const s = document.querySelector('input[aria-label="Keep the Mac awake while agents work"]'); if (!s.checked) s.click(); return true; })()`);
  await sleep(400);
  const general = await evalIn(c, `(() => { const r = document.querySelector('.settings-page-pane [data-setting="open-files-in"]'); r.scrollIntoView({ block: 'start', behavior: 'instant' });
    const b = r.getBoundingClientRect(); return { x: b.left - 8, y: Math.max(0, b.top - 40), width: b.width + 16, height: 120 }; })()`);
  await shoot(c, "general-files-light", general);

  // A fake session, opened in the space.
  const [space] = await api.call("spaces.list", {});
  const TITLE = "Settings live check";
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: TITLE });
  await until(() => evalIn(c, `[...document.querySelectorAll('.item-list .item-row')].some((b) => b.textContent.includes(${JSON.stringify(TITLE)}))`), 20_000, "session row");
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(800);

  /* ── The path menu offers the editor ────────────────────────────────────────────────────── */
  const file = path.join(scratch, "notes.md");
  fs.writeFileSync(file, "# Notes\n");
  await api.call("sessions.send", { id: session.id, text: `Look at ${file} please`, attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.msg-assistant .md-path')`), 20_000, "path in the reply");
  await evalIn(c, `(() => { document.querySelector('.msg-assistant .md-path').click(); return true; })()`);
  await sleep(400);
  const menu = await evalIn(c, `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent)`);
  const expect = installed.length ? `Open in ${installed[0].name}` : null;
  check("a path in the transcript offers the chosen editor beside Realm's own open", expect ? menu.includes(expect) && menu[0] === "Open notes.md" : !menu.some((m) => m.startsWith("Open in")), menu);
  const menuBox = await evalIn(c, `__live.box(document.querySelector('[role="menu"]'))`);
  if (menuBox) await shoot(c, "path-menu-light", { x: menuBox.l - 12, y: menuBox.t - 12, width: menuBox.w + 24, height: menuBox.h + 24 });
  await evalIn(c, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(300);

  /* ── The session terminal at the pane's foot ────────────────────────────────────────────── */
  const toggleTerminal = () => evalIn(c, `(() => {
    const b = document.querySelector('[aria-label$="terminal for ${TITLE}"]');
    if (b) { b.click(); return "button"; }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', metaKey: true, bubbles: true })); return "chord"; })()`);
  note("terminal toggled by", await toggleTerminal());
  await until(() => evalIn(c, `!!document.querySelector('.terminal-dock')`), 10_000, "terminal dock");
  await sleep(700);
  const term = await evalIn(c, `(() => {
    const dock = document.querySelector('.terminal-dock'), pane = document.querySelector('.session-pane');
    const composer = pane.querySelector('.composer-dock');
    return { edge: dock.getAttribute('data-edge'), pinned: dock.hasAttribute('data-pinned'),
      dock: __live.box(dock), pane: __live.box(pane), composer: __live.box(composer),
      bottomReserved: pane.hasAttribute('data-dock-bottom'), rightReserved: pane.hasAttribute('data-dock-pinned') };
  })()`);
  check("Bottom: the terminal docks along the pane's foot, the pane's width, at the shell's height",
    term.edge === "bottom" && Math.abs(term.dock.b - term.pane.b) <= 16 && term.dock.l >= term.pane.l && term.dock.r <= term.pane.r && term.dock.w >= term.pane.w - 32 && Math.abs(term.dock.h - 320) <= 2,
    { dock: term.dock, pane: term.pane });
  check("…pinned in a tall pane, which gives up its foot and keeps its right side", term.pinned && term.bottomReserved && !term.rightReserved, term);
  check("…and the prompter sits above the shell rather than under its card", term.composer.b <= term.dock.t, { composer: term.composer, dock: term.dock });
  await shoot(c, "terminal-bottom-light", { x: term.pane.l, y: term.pane.t, width: term.pane.w, height: term.pane.h });
  await toggleTerminal();
  await until(async () => !(await evalIn(c, `!!document.querySelector('.terminal-dock')`)), 5000, "terminal closed");
  // The same dock on the dark face: Settings, Appearance, Dark, then back to the session.
  await until(() => evalIn(c, `__live.openSettings()`), 15_000, "settings again");
  await evalIn(c, `__live.page("appearance")`);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-theme"][value="dark"]').click(); return true; })()`);
  await sleep(400);
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(600);
  await toggleTerminal();
  await until(() => evalIn(c, `!!document.querySelector('.terminal-dock')`), 10_000, "terminal dock, dark");
  await sleep(700);
  const darkPane = await evalIn(c, `__live.box(document.querySelector('.session-pane'))`);
  await shoot(c, "terminal-bottom-dark", { x: darkPane.l, y: darkPane.t, width: darkPane.w, height: darkPane.h });
  /* The grid against the card it is drawn in: xterm sizes its columns off the element it is fitted
     to, and a grid wider than the card loses its last column under the card's clip. Measured in both
     placements, so a clipped column can be told apart as this edge's doing or the dock's own. */
  const grid = () => evalIn(c, `(() => { const d = document.querySelector('.terminal-dock'); const card = d.getBoundingClientRect();
    const scr = d.querySelector('.xterm-screen').getBoundingClientRect(); const host = d.querySelector('.terminal-pane').getBoundingClientRect();
    return { edge: d.getAttribute('data-edge'), card: { l: Math.round(card.left), r: Math.round(card.right) }, host: { l: Math.round(host.left), r: Math.round(host.right) },
      screen: { l: Math.round(scr.left), r: Math.round(scr.right) }, overRight: Math.round(scr.right - card.right) }; })()`);
  const bottomGrid = await grid();
  await toggleTerminal();
  await until(async () => !(await evalIn(c, `!!document.querySelector('.terminal-dock')`)), 5000, "terminal closed, dark");
  await until(() => evalIn(c, `__live.openSettings()`), 15_000, "settings for the right edge");
  await evalIn(c, `__live.page("general")`);
  await evalIn(c, `(() => { document.querySelector('input[name="settings-terminal-dock"][value="right"]').click(); return true; })()`);
  await sleep(300);
  await evalIn(c, `(() => { [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes(${JSON.stringify(TITLE)})).click(); return true; })()`);
  await sleep(600);
  await toggleTerminal();
  await until(() => evalIn(c, `!!document.querySelector('.terminal-dock')`), 10_000, "terminal dock, right");
  await sleep(700);
  const rightGrid = await grid();
  note("the shell's grid against its card, bottom then right", { bottomGrid, rightGrid });
  check("at the bottom the shell's grid is no wider than its card than it is on the right", bottomGrid.overRight <= Math.max(0, rightGrid.overRight), { bottomGrid, rightGrid });
  const rightPane = await evalIn(c, `__live.box(document.querySelector('.session-pane'))`);
  await shoot(c, "terminal-right-dark", { x: rightPane.l, y: rightPane.t, width: rightPane.w, height: rightPane.h });
  await toggleTerminal();
  await until(async () => !(await evalIn(c, `!!document.querySelector('.terminal-dock')`)), 5000, "terminal closed, right");

  /* ── Awake for exactly as long as a turn runs ───────────────────────────────────────────── */
  const held = () => {
    const out = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes(`pid ${electron.pid}(`) && /PreventUserIdleSystemSleep|NoIdleSleep/.test(l));
  };
  check("nothing is held while no turn runs", held().length === 0, held());
  await api.call("sessions.send", { id: session.id, text: "stream slowly", attachments: [], mentions: [] });
  const during = await until(() => { const h = held(); return h.length ? h : null; }, 4000, "assertion during the turn").catch(() => []);
  check("while the fake agent streams, main holds the app-suspension assertion", during.length > 0, during);
  const after = await until(() => (held().length === 0 ? true : null), 15_000, "assertion released").catch(() => false);
  check("and lets go once the turn ends", after === true, held());
}

/* ══ W9b: Appearance ═══════════════════════════════════════════════════════════════════════════
   Measured through the real cascade: what the window reports for prefers-reduced-motion, the two
   grounds' alphas, text sizes as computed, and the face prose is set in. Probes wear the real
   classes, so what is read is what the stylesheet does to an element of that kind. */
async function appearanceChecks(c, size) {
  const rowOf = (id) => `document.querySelector('.settings-page-pane [data-setting="${id}"]')`;
  const radio = (name, value) => `(() => { document.querySelector('input[name="${name}"][value="${value}"]').click(); return true; })()`;
  await evalIn(c, `__live.page("appearance")`);
  await evalIn(c, radio("settings-theme", "dark"));
  await sleep(500);

  /* ── Reduce motion: the system's own media query, answered by Realm ─────────────────────── */
  const motionNow = () => evalIn(c, `({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    duration: getComputedStyle(${rowOf("contrast")}).transitionDuration })`);
  const system = await motionNow();
  note("reduced motion as the Mac reports it", system);
  await evalIn(c, radio("settings-reduce-motion", "on"));
  const on = await until(async () => { const m = await motionNow(); return m.reduce ? m : null; }, 5000, "motion on").catch(() => null);
  check("On: the window reports prefers-reduced-motion: reduce, and the stylesheet's own kill takes the transitions", !!on && on.duration === "0s", on);
  await evalIn(c, radio("settings-reduce-motion", "off"));
  const off = await until(async () => { const m = await motionNow(); return !m.reduce ? m : null; }, 5000, "motion off").catch(() => null);
  check("Off: the window reports no preference, and the transitions are back", !!off && off.duration !== "0s", off);
  await evalIn(c, radio("settings-reduce-motion", "system"));
  await sleep(600);
  const back = await motionNow();
  check("System: the Mac's own answer again", back.reduce === system.reduce && back.duration === system.duration, { system, back });

  /* ── Sidebar and pane translucency, one each ─────────────────────────────────────────────── */
  const grounds = () => evalIn(c, `(() => {
    const alpha = (el) => { const bg = getComputedStyle(el).backgroundColor; const slash = bg.lastIndexOf('/');
      if (slash >= 0) return Number.parseFloat(bg.slice(slash + 1)); const parts = bg.split(','); return parts.length === 4 ? Number.parseFloat(parts[3]) : 1; };
    const root = getComputedStyle(document.documentElement);
    return { ground: root.getPropertyValue('--ground-alpha').trim(), pane: root.getPropertyValue('--pane-alpha').trim(),
      sidebar: alpha(document.querySelector('.sidebar')), main: alpha(document.querySelector('.main')) };
  })()`);
  const setRange = (label, value) => evalIn(c, `(() => {
    const el = document.querySelector('input[aria-label="${label}"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "${value}");
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await setRange("Pane transparency", 90); // 96% opaque
  await sleep(400);
  let g = await grounds();
  check("the pane slider moves the panes and leaves the sidebar where it was", g.pane === "96%" && g.ground === "55%" && Math.abs(g.main - 0.96) < 0.02 && Math.abs(g.sidebar - 0.55) < 0.02, g);
  await evalIn(c, `(() => { document.querySelector('input[aria-label="Sidebar translucency"]').click(); return true; })()`);
  await sleep(400);
  g = await grounds();
  check("the sidebar's switch makes the sidebar opaque and leaves the panes translucent", g.ground === "100%" && g.pane === "96%" && g.sidebar === 1 && g.main < 1, g);
  await evalIn(c, `(() => { document.querySelector('input[aria-label="Sidebar translucency"]').click(); return true; })()`);
  await setRange("Pane transparency", 100); // back to the pane's default, 86%
  await sleep(400);

  /* ── Text sizes ─────────────────────────────────────────────────────────────────────────── */
  const sizes = () => evalIn(c, `(() => {
    const px = (el) => Number.parseFloat(getComputedStyle(el).fontSize);
    return { body: px(document.body), row: px(document.querySelector('.settings-page-pane .settings-row-name')),
      head: px(document.querySelector('.settings-page-pane .page-rail-head')),
      code: px(document.querySelector('.settings-page-pane .code-preview')),
      zoom: window.realm?.zoomFactor?.() ?? null };
  })()`);
  const textClip = async () => evalIn(c, `(() => { const g = ${rowOf("ui-font")}.closest('.settings-group'); g.scrollIntoView({ block: 'start', behavior: 'instant' });
    const r = g.getBoundingClientRect(); return { x: r.left - 8, y: Math.max(0, r.top - 8), width: r.width + 16, height: Math.min(r.height, 560) + 16 }; })()`);
  const base = await sizes();
  note("text sizes at the defaults", base);
  await shoot(c, "text-ui-14-dark", await textClip());
  check("at the defaults every size is the stylesheet's own", base.body === 14 && base.row === 13.5 && base.head === 11.5, base);
  await setRange("UI font size", 18);
  await sleep(400);
  const big = await sizes();
  check("UI font size 18: the UI text scales by 18/14 and the code does not", Math.abs(big.body - 18) < 0.01 && Math.abs(big.row - 13.5 * 18 / 14) < 0.02 && big.code === base.code, big);
  check("…and it is not page zoom: the window's zoom factor is untouched", big.zoom === base.zoom, { zoom: big.zoom });
  await shoot(c, "text-ui-18-dark", await textClip());
  await setRange("UI font size", 12);
  await sleep(400);
  const small = await sizes();
  check("UI font size 12: text shrinks, and an 11.5px label stops at the 11px floor", Math.abs(small.body - 12) < 0.01 && small.head === 11, small);
  await setRange("UI font size", 14);
  await setRange("Code font size", 15);
  await sleep(400);
  const code = await sizes();
  check("Code font size 15: the code scales by 15/12 and the UI does not", Math.abs(code.code - base.code * 1.25) < 0.02 && code.body === 14, code);
  await setRange("Code font size", 12);
  await sleep(300);

  /* ── The content face ───────────────────────────────────────────────────────────────────── */
  const faces = () => evalIn(c, `(() => {
    const probe = (cls) => { const el = document.createElement('div'); el.className = cls; el.textContent = 'probe'; document.body.appendChild(el);
      const f = getComputedStyle(el).fontFamily; el.remove(); return f; };
    return { md: probe('md'), assistant: probe('msg-assistant'), user: probe('msg-user'), doc: probe('documents-rich-surface'),
      title: getComputedStyle(document.querySelector('.page-title h1')).fontFamily };
  })()`);
  const before = await faces();
  check("prose reads in the UI face until a content face is chosen", [before.md, before.assistant, before.user, before.doc].every((f) => f === before.title), before);
  await evalIn(c, `(() => { const s = document.querySelector('select[aria-label="Content font"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "serif");
    s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await sleep(400);
  const serif = await faces();
  check("System serif: messages, markdown and documents take it, and the chrome does not", [serif.md, serif.assistant, serif.user, serif.doc].every((f) => /ui-serif/.test(f)) && serif.title === before.title, serif);
  const group = await evalIn(c, `(() => { const r = document.querySelector('.settings-page-pane .settings-group').getBoundingClientRect(); return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: Math.min(r.height, 640) + 16 }; })()`);
  await shoot(c, "appearance-dark", group);
  await evalIn(c, radio("settings-theme", "light"));
  await sleep(500);
  await shoot(c, "appearance-light", group);
  await evalIn(c, `(() => { const s = document.querySelector('select[aria-label="Content font"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "bundled");
    s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
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
