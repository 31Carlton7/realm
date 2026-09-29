/**
 * Live check for the session's file browser laid out as cards
 * (run with: pnpm build && node apps/desktop/scripts/session-files-grid-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME, fills the space's folder with `fs` the way an agent's
 * shell would — real 2880×1800 captures, a phone-shaped picture, a document, an archive, data, a
 * script, a sub-folder — some of it dated yesterday, then opens a session's Files panel and switches
 * it to cards.
 *
 * What only a real window can show, because jsdom lays nothing out:
 *   - how many columns the dock's real width holds, and what a card measures inside it;
 *   - that main mints a picture for an image card at all, and that a card below the fold has not
 *     asked for one until it is scrolled to;
 *   - that the layout survives a reload, which boots the renderer from the settings row again;
 *   - how the card separates from the panel it sits on in BOTH faces — read off the pixels, because
 *     what a fill comes to depends on the ground under it and no reading of the stylesheet says so.
 *
 * Sends no message. The panel lists a folder; a prompt here would be a real engine's turn.
 *
 * Ports: env-overridable. Touches only a scratch dir, and kills only what holds the two ports it chose.
 */
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9398), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8962);
const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-files-grid");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-files-grid-"));
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

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Open the Files panel, pressing again if a press lands mid-settle (see session-files-live.mjs). */
async function openPanel(c) {
  await until(async () => {
    const open = await evalIn(c, `(() => {
      if (document.querySelector('.session-files')) return true;
      document.querySelector('.panel-bar [aria-label^="Files for"]')?.click();
      return !!document.querySelector('.session-files');
    })()`);
    return open || null;
  }, 12000, "the files panel");
}

/** Every box the claims below are about, in CSS pixels, read in one pass. */
const MEASURE = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const panel = document.querySelector('.session-files');
  const scroller = panel.querySelector('.summary-scroll');
  const sv = scroller.getBoundingClientRect();
  const cards = [...panel.querySelectorAll('.library-tile')].map((el) => {
    const art = el.querySelector('.library-tile-art'), name = el.querySelector('.library-tile-name');
    const img = el.querySelector('img.library-tile-thumb'), mark = el.querySelector('.library-tile-mark');
    const box = el.getBoundingClientRect();
    return { name: name.textContent, meta: el.querySelector('.library-tile-meta')?.textContent ?? null,
      box: r(el), art: r(art), mark: mark ? r(mark) : null, type: art.dataset.type,
      thumb: img ? { natural: [img.naturalWidth, img.naturalHeight], complete: img.complete } : null,
      clipped: name.scrollWidth > name.clientWidth,
      onScreen: box.bottom > sv.top && box.top < sv.bottom };
  });
  const toggle = panel.querySelector('[aria-label="Show as a grid"]');
  return {
    panel: r(panel), scroller: r(scroller),
    grids: [...panel.querySelectorAll('.library-grid')].map(r),
    heads: [...panel.querySelectorAll('.summary-head')].map((h) => ({ text: h.textContent, box: r(h), label: r(h.querySelector('span')) })),
    columns: [...new Set(cards.map((c) => c.box.x))].length,
    cards,
    toggle: toggle && { pressed: toggle.getAttribute('aria-pressed'), title: toggle.getAttribute('title'), fill: getComputedStyle(toggle).backgroundColor },
    overflowX: scroller.scrollWidth > scroller.clientWidth,
    nameFont: cards.length ? getComputedStyle(panel.querySelector('.library-tile-name')).fontSize : null,
    metaFont: cards.length ? getComputedStyle(panel.querySelector('.library-tile-meta')).fontSize : null,
    rows: panel.querySelectorAll('.summary-row').length,
    mode: document.documentElement.dataset.mode,
  };
})()`;

/**
 * The mean colour of a few small patches of a screenshot, as relative luminance. Decoded in the page
 * itself — the renderer already has a PNG decoder and a canvas — so this needs nothing installed.
 */
async function luminances(c, b64, patches) {
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${b64}"; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return ${JSON.stringify(patches)}.map(([x, y]) => {
      const d = ctx.getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data;
      let R = 0, G = 0, B = 0; const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      R /= n; G /= n; B /= n;
      return { rgb: [Math.round(R), Math.round(G), Math.round(B)], L: +(0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B)).toFixed(4) };
    });
  })()`);
}
const ratio = (a, b) => +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(3);

/**
 * Shoot the panel, keep the PNG, and read the grounds either side of each edge a card has.
 *
 * Every patch sits clear of a corner and of text. The first version read the card 4px inside its
 * rounded corner, and the patch caught the curve's anti-aliasing — panel pixels — which pulled the
 * card toward the panel and under-reported the step in both faces (1.119 dark where the fills come
 * to 1.14). A contrast claim is only as good as the pixels it averaged.
 */
async function shootAndRead(c, name, m) {
  const clip = { x: m.panel.x, y: m.panel.y, width: m.panel.w, height: m.panel.h, scale: 1 };
  const shot = await c.send("Page.captureScreenshot", { format: "png", clip });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT ${file}`);
  // Device pixels: the window runs at 2x, and the clip's origin is the panel's.
  const px = (x, y) => [(x - m.panel.x) * 2, (y - m.panel.y) * 2];
  // A layout that has gone wrong may have no glyph card in view; the grounds are still worth reading.
  const glyph = m.cards.find((k) => k.onScreen && !k.thumb && k.mark);
  const [first, second] = m.cards;
  // The caption's bottom padding, mid-card: no text, no corner. The first card is a picture's, so
  // its field is the picture and only the caption shows the card's own fill.
  const cardAt = px(first.box.x + first.box.w / 2, first.box.y + first.box.h - 5);
  const [ground, card, field = null, well = null] = await luminances(c, shot.data, [
    // The panel's own ground, in the gap between the first two cards — the ground each card's edge
    // is actually read against.
    px((first.box.x + first.box.w + second.box.x) / 2, first.box.y + first.box.h / 2),
    cardAt,
    ...(glyph ? [
      // A glyph card's preview field, left of the well at mid-height.
      px(glyph.art.x + 10, glyph.art.y + glyph.art.h / 2),
      // The well itself, left of the glyph it centres.
      px(glyph.mark.x + 8, glyph.mark.y + glyph.mark.h / 2),
    ] : []),
  ]);
  // …and the same card under the pointer, which is a state the fill has to keep answering.
  const { root } = await c.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".session-files .library-tile" });
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
  await sleep(400);
  const hoverShot = await c.send("Page.captureScreenshot", { format: "png", clip });
  const [hovered] = await luminances(c, hoverShot.data, [cardAt]);
  await c.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  await sleep(400);
  return { file, ground, card, field, well, hovered, cardOnGround: ratio(card.L, ground.L),
    fieldOnCard: field && ratio(field.L, card.L), wellOnField: well && field && ratio(well.L, field.L),
    hoverOnRest: ratio(hovered.L, card.L) };
}

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
  electron = spawn(electronBin, [wrapper], {
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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("DOM.enable");
  await c.send("CSS.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await evalIn(c, `(() => { document.querySelector('button[aria-label="New session"]')?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel-bar [aria-label^="Files for"]')`), 20000, "the Files button");
  await sleep(1200);
  await openPanel(c);

  // Which folder the panel reads, asked of the panel rather than guessed (session-files-live.mjs).
  const crumb = await until(() => evalIn(c, `document.querySelector('.session-files .files-crumb')?.textContent ?? null`), 10000, "the root crumb");
  const findFolder = (from, name, depth = 3) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const abs = path.join(from, e.name);
      if (e.name === name) return abs;
      if (depth > 1) { const hit = findFolder(abs, name, depth - 1); if (hit) return hit; }
    }
    return null;
  };
  const folder = findFolder(home, crumb);
  if (!folder) throw new Error(`no folder named ${crumb} under the scratch home`);

  /* The folder. Newest first is the panel's order, so the mtimes are what place each file: most of it
     lands today, the rest yesterday — two day headings — and yesterday's two captures are the OLDEST
     files, so they sit at the bottom of the listing, below the fold, where the pictures that have
     not been asked for yet are. */
  const now = Date.now(), HOUR = 3_600_000;
  const put = (name, from, ageHours) => {
    const to = path.join(folder, name);
    // `{ copy }` is a file from the repo; anything else is the bytes themselves.
    if (typeof from.copy === "string") fs.copyFileSync(path.join(repoRoot, from.copy), to); else fs.writeFileSync(to, from);
    const t = new Date(now - ageHours * HOUR);
    fs.utimesSync(to, t, t);
  };
  put("workspace.png", { copy: "docs/images/workspace.png" }, 0.1);
  put("connections.png", { copy: "docs/images/connections.png" }, 0.2);
  put("models.png", { copy: "docs/images/models.png" }, 0.3);
  put("sandbox.png", { copy: "docs/images/sandbox.png" }, 0.4);
  put("phone-mockup.png", { copy: "apps/desktop/src/renderer/src/assets/devices/iphone.png" }, 0.5);
  put("launch-notes.md", "# Launch\n\nNotes for the launch.\n", 0.6);
  put("handwriting-starter.zip", Buffer.alloc(48 * 1024), 0.7);
  fs.mkdirSync(path.join(folder, "renders"), { recursive: true });
  put("renders/library.png", { copy: "site/public/product/library.png" }, 1);
  fs.utimesSync(path.join(folder, "renders"), new Date(now - 0.8 * HOUR), new Date(now - 0.8 * HOUR));
  put("results.csv", "id,value\n1,2\n", 26);
  put("build-site.sh", "#!/bin/sh\npnpm build\n", 27);
  put("blank-handwriting-sheet.pdf", "%PDF-1.4\n", 28);
  put("session.png", { copy: "site/public/product/session.png" }, 29);
  put("editor.png", { copy: "site/public/product/editor.png" }, 30);
  const imageNames = new Set(["workspace.png", "connections.png", "models.png", "sandbox.png", "phone-mockup.png", "session.png", "editor.png"]);

  await evalIn(c, `(() => { document.querySelector('.session-files [aria-label="Refresh this folder"]').click(); return true; })()`);
  await until(async () => (await evalIn(c, `document.querySelectorAll('.session-files .summary-row').length`)) >= 13 || null, 8000, "the folder's rows");

  // ── Rows → cards ──
  const before = await evalIn(c, MEASURE);
  check("the panel opens as rows, with the switch unlit", before.rows >= 13 && before.cards.length === 0 && before.toggle?.pressed === "false", { rows: before.rows, toggle: before.toggle });
  await evalIn(c, `(() => { document.querySelector('.session-files [aria-label="Show as a grid"]').click(); return true; })()`);
  await until(async () => (await evalIn(c, `document.querySelectorAll('.session-files .library-tile').length`)) >= 13 || null, 8000, "the cards");
  // Pictures come from main, a decode per card on screen. Wait for the ones that are in view.
  await until(async () => {
    const m = await evalIn(c, MEASURE);
    const due = m.cards.filter((k) => k.onScreen && imageNames.has(k.name));
    return due.length > 0 && due.every((k) => k.thumb?.complete) ? m : null;
  }, 15000, "pictures for the cards in view");
  await sleep(400);
  const dark = await evalIn(c, MEASURE);

  check("the switch lights when the panel is cards, and keeps its name", dark.toggle?.pressed === "true" && dark.toggle.title === "Grid view", dark.toggle);
  check("the rows are gone, the day headings stay", dark.rows === 0 && dark.heads.length === 2, dark.heads.map((h) => h.text));
  check("two cards across the dock", dark.columns === 2, { columns: dark.columns, panel: dark.panel.w, grids: dark.grids.map((g) => g.w) });
  const widths = [...new Set(dark.cards.map((k) => k.box.w))];
  check("every card is one width, and nothing scrolls sideways", widths.length === 1 && !dark.overflowX, { widths, overflowX: dark.overflowX });
  const art = dark.cards.map((k) => +(k.art.w / k.art.h).toFixed(3));
  check("every preview field is the Library's 4:3", art.every((a) => Math.abs(a - 4 / 3) < 0.02), [...new Set(art)]);
  const row0 = dark.cards.filter((k) => k.box.y === dark.cards[0].box.y);
  const gap = row0.length === 2 ? +(row0[1].box.x - (row0[0].box.x + row0[0].box.w)).toFixed(1) : null;
  const inset = +(dark.cards[0].box.x - dark.heads[0].label.x).toFixed(1);
  check("the cards share the day label's left edge", Math.abs(inset) <= 0.5, { gap, inset, head: dark.heads[0].label.x, card: dark.cards[0].box.x });
  const pictured = dark.cards.filter((k) => k.thumb);
  check("only images carry a picture", pictured.every((k) => imageNames.has(k.name)) && pictured.length > 0, pictured.map((k) => [k.name, k.thumb.natural]));
  const glyphs = dark.cards.filter((k) => !imageNames.has(k.name));
  check("everything else wears its glyph in the well", glyphs.every((k) => !k.thumb && k.mark), glyphs.map((k) => [k.name, k.type]));
  check("a folder says so, a file says its size", dark.cards.find((k) => k.name === "renders")?.meta === "Folder"
    && dark.cards.find((k) => k.name === "handwriting-starter.zip")?.meta === "48 KB", dark.cards.map((k) => [k.name, k.meta]));
  const below = dark.cards.filter((k) => !k.onScreen && imageNames.has(k.name));
  check("a picture below the fold has not been asked for yet", below.length > 0 && below.every((k) => !k.thumb), below.map((k) => k.name));
  check("the caption holds the type floor", parseFloat(dark.nameFont) >= 11 && parseFloat(dark.metaFont) >= 11, { name: dark.nameFont, meta: dark.metaFont });
  console.log("MEASURE dark", JSON.stringify({ panel: dark.panel, grid: dark.grids[0], card: dark.cards[0].box, art: dark.cards[0].art,
    mark: glyphs[0]?.mark, gap, inset, clippedNames: dark.cards.filter((k) => k.clipped).map((k) => k.name) }));
  const darkRead = await shootAndRead(c, "grid-dark", dark);
  console.log("PIXELS dark", JSON.stringify(darkRead));
  // The panel in its place, beside the session it belongs to.
  const win = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "grid-dark-window.png"), Buffer.from(win.data, "base64"));
  console.log(`SCREENSHOT ${path.join(OUT, "grid-dark-window.png")}`);

  // ── The fold: scroll, and the pictures below it arrive ──
  await evalIn(c, `(() => { const s = document.querySelector('.session-files .summary-scroll'); s.scrollTop = s.scrollHeight; return true; })()`);
  const scrolled = await until(async () => {
    const m = await evalIn(c, MEASURE);
    const due = m.cards.filter((k) => below.some((b) => b.name === k.name));
    return due.every((k) => k.thumb?.complete) ? m : null;
  }, 15000, "pictures after scrolling");
  check("…and arrives once the card is scrolled to", true, scrolled.cards.filter((k) => below.some((b) => b.name === k.name)).map((k) => k.name));
  await evalIn(c, `(() => { document.querySelector('.session-files .summary-scroll').scrollTop = 0; return true; })()`);

  // ── The doors: a picture opens full window over the panel; a folder card descends ──
  await evalIn(c, `(() => { [...document.querySelectorAll('.session-files .library-tile')].find((t) => t.textContent.includes('workspace.png')).click(); return true; })()`);
  const lightbox = await until(() => evalIn(c, `!!document.querySelector('.media-lightbox') || null`), 8000, "the lightbox").catch(() => false);
  const panelBehind = await evalIn(c, `!!document.querySelector('.session-files')`);
  check("a picture's card opens it full window, over the panel", lightbox === true && panelBehind, { lightbox, panelBehind });
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector('.media-lightbox') || null`), 5000, "the lightbox closing");
  check("Escape puts the picture away and leaves the panel", await evalIn(c, `!!document.querySelector('.session-files')`));
  await evalIn(c, `(() => { [...document.querySelectorAll('.session-files .library-tile')].find((t) => t.textContent.includes('renders')).click(); return true; })()`);
  const inner = await until(async () => {
    const names = await evalIn(c, `[...document.querySelectorAll('.session-files .library-tile-name')].map((n) => n.textContent)`);
    return names.includes("library.png") ? names : null;
  }, 8000, "the sub-folder as cards");
  check("a folder's card descends, and the listing inside is cards too", inner.length === 1, inner);
  await evalIn(c, `(() => { document.querySelector('.session-files button.files-crumb').click(); return true; })()`);
  await until(async () => (await evalIn(c, `document.querySelectorAll('.session-files .library-tile').length`)) >= 13 || null, 8000, "back at the root");

  // ── A reload, in the light face: the layout comes back from the settings row ──
  const api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const stored = await api.call("settings.get", { key: "ui.filesView" }).catch((e) => `error: ${e.message}`);
  check("the choice is a settings row", JSON.stringify(stored).includes("grid"), stored);
  await api.call("settings.set", { key: "ui.theme", value: "light" });
  api.close();
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.panel-bar [aria-label^="Files for"]')`), 30000, "the session after reload");
  await sleep(1200);
  await openPanel(c);
  await until(async () => (await evalIn(c, `document.querySelectorAll('.session-files .library-tile').length`)) >= 13 || null, 8000, "cards after reload");
  await until(async () => {
    const m = await evalIn(c, MEASURE);
    const due = m.cards.filter((k) => k.onScreen && imageNames.has(k.name));
    return m.mode === "light" && due.every((k) => k.thumb?.complete) ? m : null;
  }, 15000, "the light face, pictured");
  await sleep(400);
  const light = await evalIn(c, MEASURE);
  check("after a reload the panel opens straight into cards, switch lit", light.cards.length >= 13 && light.rows === 0 && light.toggle?.pressed === "true", { cards: light.cards.length, toggle: light.toggle });
  const lightRead = await shootAndRead(c, "grid-light", light);
  console.log("PIXELS light", JSON.stringify(lightRead));
  console.log("CONTRAST", JSON.stringify({
    cardOnPanel: { dark: darkRead.cardOnGround, light: lightRead.cardOnGround },
    fieldOnCard: { dark: darkRead.fieldOnCard, light: lightRead.fieldOnCard },
    wellOnField: { dark: darkRead.wellOnField, light: lightRead.wellOnField },
    hoverOnRest: { dark: darkRead.hoverOnRest, light: lightRead.hoverOnRest } }));
  /* The card has to exist on the dock's raised surface in BOTH faces, and the light one is not
     allowed to be the weaker: one ladder step off a raised ground measured 1.04:1 there, which is a
     card with no edge (design.md). 1.12 is the floor the dark face already cleared. */
  check("the card is a real step off the panel in both faces, light no weaker than dark",
    darkRead.cardOnGround >= 1.12 && lightRead.cardOnGround >= 1.12 && lightRead.cardOnGround >= darkRead.cardOnGround * 0.995,
    { dark: darkRead.cardOnGround, light: lightRead.cardOnGround });
  check("the glyph's well still reads inside the card", darkRead.wellOnField >= 1.05 && lightRead.wellOnField >= 1.05,
    { dark: darkRead.wellOnField, light: lightRead.wellOnField });
  check("and the card still answers the pointer", darkRead.hoverOnRest >= 1.05 && lightRead.hoverOnRest >= 1.05,
    { dark: darkRead.hoverOnRest, light: lightRead.hoverOnRest });

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

/**
 * The server is a SECOND Electron process, spawned by the one we started, and killing the parent
 * leaves it holding REALM_PORT (sidebar-and-splits-live.mjs). Killed by the ports this script chose,
 * then by the pids the scratch home recorded, and the scratch goes last.
 */
let reaped = false;
async function reap() {
  if (reaped) return;
  reaped = true;
  electron?.kill("SIGKILL");
  for (const port of [SERVER_PORT, CDP_PORT]) {
    try {
      const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim();
      for (const pid of out.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    } catch {}
  }
  await stopDaemons(home).catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(async () => { await reap(); process.exit(process.exitCode ?? 0); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void reap().finally(() => process.exit(1)); });
