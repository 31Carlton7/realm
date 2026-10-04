/**
 * Live check: the surfaces redrawn in Codex's grammar — Settings' cards and type, Sign-ins, the
 * Library's files, and Memory (run with: pnpm build && node apps/desktop/scripts/codex-surfaces-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME, seeds the Library with real files on disk (pictures,
 * a PDF, code, data) and the space with a memory document, then captures each surface in both faces
 * and measures what the redesign claims.
 *
 * Ports: LIVE_SERVER_PORT (8975), LIVE_CDP_PORT (9375). Touches only a scratch dir. Nothing is billed:
 * the onboarding session is switched to the fake agent before anything else, and no message is sent.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9375);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8975);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-codex-surfaces-live-"));
const home = path.join(scratch, "home");
const OUTDIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-codex-surfaces");
fs.mkdirSync(OUTDIR, { recursive: true });
const OUT = (tag) => path.join(OUTDIR, `${tag}.png`);
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

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; },
  async page(value) {
    const input = document.querySelector('.settings-rail input[value="' + value + '"]');
    if (!input) throw new Error('no settings page ' + value);
    input.click();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  },
  async library(value) {
    const input = [...document.querySelectorAll('input[name^="library-tab-"]')].find((i) => i.value === value);
    if (!input) throw new Error('no library section ' + value);
    input.click();
    await new Promise((r) => setTimeout(r, 400));
    return true;
  },
  rail(label) {
    const b = [...document.querySelectorAll('.app-rail .rail-btn')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith(label));
    if (!b) throw new Error('no destination: ' + label);
    b.click();
    return true;
  },
  /** Every element under root whose own text is set below the floor, by computed size. */
  small(root, floor) {
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('svg, code, pre, kbd, .visually-hidden')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const size = parseFloat(cs.fontSize);
      if (size < floor) out.push({ cls: el.className?.baseVal ?? el.className, tag: el.tagName, size, text: el.textContent.trim().slice(0, 40) });
    }
    return out;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** Mean relative luminance of device-pixel rectangles of one capture, decoded in the page. */
async function lums(c, rects) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png" });
  return evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(data)}; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return ${JSON.stringify(rects)}.map(([x, y, w, h]) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
      let R = 0, G = 0, B = 0; const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      R /= n; G /= n; B /= n;
      return { rgb: [Math.round(R), Math.round(G), Math.round(B)], L: +(0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B)).toFixed(4) };
    });
  })()`);
}

async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  fs.writeFileSync(OUT(tag), Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${OUT(tag)}`);
  return data;
}

/** Short synchronous steps driven from here: a long in-page wait on the palette's first opening in a
 *  fresh window can be collected mid-wait ("Promise was collected"). */
async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const picked = await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => (o.querySelector(".palette-label")?.textContent.trim() ?? o.textContent.trim()) === ${JSON.stringify(label)} || o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`).catch(() => false);
  if (picked) return true;
  await evalIn(c, `(() => { document.querySelector(".palette input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  throw new Error(`no palette row: ${label}`);
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
      REALM_HTML_MENUS: "1",
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
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Homework");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

/** Real files, so a picture has pixels to be minted from and a PDF opens. */
function seedFiles() {
  const dir = path.join(scratch, "files");
  fs.mkdirSync(dir, { recursive: true });
  const ref = path.join(repoRoot, "..", ".verify", "ref");
  const pictures = ["codex-settings-cards.png", "codex-library-half.png", "codex-prs-half.png"].map((f) => path.join(ref, f)).filter((f) => fs.existsSync(f));
  const files = [];
  const put = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); files.push(p); };
  pictures.forEach((p, i) => { const to = path.join(dir, ["dashboard-dark.png", "library-mockup.png", "review-screen.png"][i]); fs.copyFileSync(p, to); files.push(to); });
  put("NextGen_Fellows_2026_application.pdf", "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  put("release-notes.md", "# Release notes\n\n- The window is chrome round a sheet.\n");
  put("Pasted text.txt", "Pasted from a message.\n");
  put("sidebar-spaces.tsx", "export const x = 1;\n");
  put("usage-by-day.csv", "day,turns\n2026-10-01,12\n");
  put("theme.json", "{\"accent\":\"blue\"}\n");
  put("capture-bundle.zip", "PK");
  return files;
}

function seedArtifacts(sessionId, files) {
  const db = path.join(home, "realm.db");
  const now = Date.now();
  const day = 86_400_000;
  const when = [0, 0.02, 0.05, 0.3, 1.1, 1.2, 2.5, 3.4, 9, 40, 41].map((d) => Math.round(now - d * day));
  const rows = files.map((p, i) => {
    const name = path.basename(p);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const kind = i % 3 === 1 ? "upload" : "output";
    const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
    return `INSERT INTO artifacts (id, session_id, seq, kind, path, name, ext, ts) VALUES (${q(`${sessionId}:${i + 1}:${p}`)}, ${q(sessionId)}, ${i + 1}, ${q(kind)}, ${q(p)}, ${q(name)}, ${q(ext)}, ${when[i % when.length]});`;
  });
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", db, rows.join("\n")]);
}

const MEMORY_DOC = `# How we work in Homework

Every session here is working on the fellowship application and its site.

- Use pnpm, never npm.
- Run the suite as \`SHELL=/bin/bash pnpm vitest run\` — one test flakes under zsh.
- Commit by path; never \`git add -A\` in a shared worktree.
- Drafts go in \`drafts/\`, finished pages in \`site/\`.

Links: the [brief](https://example.com/brief) and the [style guide](https://example.com/style).
`;

async function main() {
  const c = await boot();
  const size = (width, height = 900) => c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await size(1440, 900);

  const sessions = await api.call("sessions.listAll", {});
  const session = sessions[0];
  // Before anything else: the onboarding session runs a REAL engine.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  seedArtifacts(session.id, seedFiles());
  await api.call("memory.set", { spaceId: session.spaceId, doc: MEMORY_DOC });
  note("seeded", { session: session.id, space: session.spaceId });

  for (const face of ["dark", "light"]) {
    if (face === "light") { await paletteRow(c, "Theme: Light"); await sleep(500); }

    await paletteRow(c, "Open settings");
    await until(() => evalIn(c, `!!document.querySelector('.settings-page-pane')`), 15_000, "settings");
    await sleep(600);
    /* Every page but Import, whose panel scans the agent CLIs' own stores in the real home on mount —
       read-only, but slow, and nothing this check is about. */
    for (const page of ["general", "appearance", "keys", "notifications", "engines", "usage", "signins", "permissions", "computer-use", "archived"]) {
      await evalIn(c, `__live.page(${JSON.stringify(page)})`);
      await sleep(400);
      await shoot(c, `settings-${page}-${face}`);
      const head = await evalIn(c, `(() => ({ h1: document.querySelector('.settings-page-pane .page-head h1')?.textContent,
        picked: document.querySelector('.settings-rail input:checked')?.closest('label')?.textContent?.trim() }))()`);
      check(`Settings › ${head.picked} (${face}): the head names the page it shows`, head.h1 === head.picked, head);
      if (face === "dark") {
        const small = await evalIn(c, `__live.small(document.querySelector('.settings-page-pane .page-content') ?? document.body, 12.5)`);
        // The credits at the foot of General are the one exception, and they are a signature, not a setting.
        const unexplained = small.filter((x) => !String(x.cls).includes("settings-attribution") && !(x.tag === "A" && /Aikins|Pixel Agents|MetroCity/.test(x.text)));
        if (page !== "usage") check(`Settings › ${head.picked}: nothing a person must read is set under 12.5px`, unexplained.length === 0, unexplained.slice(0, 8));
        else note(`settings ${page}: text under 12.5px`, unexplained.slice(0, 16));
        const type = await evalIn(c, `(() => { const px = (sel) => { const el = document.querySelector('.settings-page-pane ' + sel); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
          return { name: px('.settings-row-name'), desc: px('.settings-row-desc, .settings-row-detail'), head: px('.settings-head'), h1: px('.page-head h1') }; })()`);
        // A report page (Usage, Archived) may carry no rows at all; what it does carry is held.
        check(`Settings › ${head.picked}: labels 14, their lines 13, heads 15, the title 24`,
          (type.name === null || type.name === 14) && (type.desc === null || type.desc === 13) && (type.head === null || type.head === 15) && type.h1 === 24, type);
      }
      if (page === "signins") {
        /* The card: a step above the ground, under a rim lighter than both sides (dark), measured off
           the pixels — the rim is one device pixel, so it is read as a 1px strip along the card's top. */
        const card = await evalIn(c, `__live.box(document.querySelector('.settings-page-pane .creds-list .settings-row'))`);
        const [ground, fill, rim] = await lums(c, [
          [2 * (card.l - 12), 2 * (card.t + card.h / 2) - 4, 8, 8],
          [2 * (card.l + card.w - 60), 2 * (card.t + card.h / 2) - 4, 40, 8],
          [2 * (card.l + 60), 2 * card.t, 120, 1],
        ]);
        if (face === "dark") {
          check("Sign-ins (dark): the card stands a step above the ground, not a well below it", fill.L > ground.L * 1.08, { ground, fill });
          check("Sign-ins (dark): its rim is the rung lighter than both sides", rim.L > fill.L && rim.L > ground.L, { ground, fill, rim });
        } else {
          check("Sign-ins (light): the card is the white over the grey ground", fill.L > ground.L * 1.05, { ground, fill });
          check("Sign-ins (light): its rim is a line you can see on the white", Math.abs(rim.L - fill.L) > 0.02, { fill, rim });
        }
      }
    }
    await evalIn(c, `(() => { document.querySelector('.sb-page-back')?.click(); return true; })()`);
    await sleep(400);

    await evalIn(c, `__live.rail("Library")`);
    await until(() => evalIn(c, `!!document.querySelector('.library-page-pane')`), 15_000, "library");
    await sleep(1200);
    await shoot(c, `library-files-${face}`);
    const lib = await evalIn(c, `(() => {
      const bar = document.querySelector('.library-files .library-toolbar'), col = document.querySelector('.library-files .page-content');
      const tiles = [...document.querySelectorAll('.library-tile')].map((t) => __live.box(t));
      return { h1: document.querySelector('.library-page-pane .page-head h1').textContent, outside: !!bar && !col.contains(bar),
        tiles: tiles.length, square: tiles.every((b) => Math.abs(b.w - b.h) <= 1), widths: [...new Set(tiles.map((b) => b.w))],
        tabs: [...document.querySelectorAll('.library-types .filter-chip')].map((b) => b.textContent),
        barLeft: bar ? __live.box(bar).l : null, firstTile: tiles[0]?.l ?? null };
    })()`);
    check(`Library (${face}): the head names the section, and the toolbar stands outside the scroller`, lib.h1 === "Files" && lib.outside, lib);
    check(`Library (${face}): every file is one square, all one width`, lib.tiles >= 8 && lib.square && lib.widths.length === 1, lib);
    check(`Library (${face}): the kinds are the tabs, and the toolbar starts on the grid's edge`,
      JSON.stringify(lib.tabs) === '["All","Images","Documents","Code","Data"]' && Math.abs(lib.barLeft - lib.firstTile) <= 1, lib);
    // A picture tile under the pointer: its name comes up over the scrim, and is not there at rest.
    const tile = await evalIn(c, `(() => { const t = document.querySelector('.library-tile[data-thumb]'); return t ? __live.box(t) : null; })()`);
    check(`Library (${face}): a picture is a tile of its own picture`, tile !== null, tile);
    if (tile) {
      const rest = await evalIn(c, `getComputedStyle(document.querySelector('.library-tile[data-thumb] .library-tile-caption')).opacity`);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tile.l + tile.w / 2, y: tile.t + tile.h / 2 });
      await sleep(300);
      const over = await evalIn(c, `getComputedStyle(document.querySelector('.library-tile[data-thumb] .library-tile-caption')).opacity`);
      check(`Library (${face}): the picture's name is clear of it at rest and comes up under the pointer`, rest === "0" && over === "1", { rest, over });
      await shoot(c, `library-files-hover-${face}`, { x: tile.l - 20, y: tile.t - 20, width: tile.w * 3 + 80, height: tile.h + 40 });
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 450 });
    }
    await evalIn(c, `(() => { document.querySelector('input[name="library-view"][value="list"]')?.click(); return true; })()`);
    await sleep(800);
    await shoot(c, `library-files-list-${face}`);
    const rows = await evalIn(c, `document.querySelectorAll('.library-row').length`);
    const stored = await api.call("settings.get", { key: "ui.libraryView" }).catch((e) => `error: ${e.message}`);
    check(`Library (${face}): Rows lays the same files out a line each, and the choice is a setting`, rows === lib.tiles && JSON.stringify(stored).includes("list"), { rows, stored });
    await evalIn(c, `(() => { document.querySelector('input[name="library-view"][value="grid"]')?.click(); return true; })()`);
    await sleep(400);
    await evalIn(c, `__live.library("memory")`);
    await sleep(800);
    await shoot(c, `library-memory-${face}`);
    // Typed into: the head says what the page has done with it.
    await evalIn(c, `(() => { const t = document.querySelector('textarea.memory-doc'); t.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, t.value + String.fromCharCode(10) + "- Ask before deleting anything in drafts/.");
      t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await sleep(150);
    const edited = await evalIn(c, `document.querySelector('.memory-doc-status').textContent`);
    await shoot(c, `library-memory-edited-${face}`, await evalIn(c, `(() => { const b = __live.box(document.querySelector('.memory-doc-card').closest('.settings-row')); return { x: b.l - 16, y: b.t - 16, width: b.w + 32, height: Math.min(b.h + 32, 700) }; })()`));
    await sleep(1500);
    const saved = await evalIn(c, `document.querySelector('.memory-doc-status').textContent`);
    const onServer = await api.call("memory.get", { spaceId: session.spaceId });
    check(`Memory (${face}): typing says Edited, a pause writes it, and the head says Saved`,
      edited === "Edited" && saved === "Saved" && onServer.doc.includes("Ask before deleting anything in drafts/."), { edited, saved, tail: onServer.doc.slice(-60) });
    await shoot(c, `library-memory-saved-${face}`, await evalIn(c, `(() => { const b = __live.box(document.querySelector('.memory-doc-card').closest('.settings-row')); return { x: b.l - 16, y: b.t - 16, width: b.w + 32, height: 120 }; })()`));
    await evalIn(c, `(() => { document.querySelector('.memory-doc-view input[value="preview"]').click(); return true; })()`);
    await sleep(500);
    await shoot(c, `library-memory-preview-${face}`);
    const preview = await evalIn(c, `document.querySelector('.memory-preview h1')?.textContent ?? null`);
    check(`Memory (${face}): Preview renders the markdown the agents are handed`, preview === "How we work in Homework", { preview });
    await evalIn(c, `(() => { document.querySelector('.memory-doc-view input[value="write"]').click(); const s = document.querySelector('.library-page-pane .page-content'); s.scrollTop = s.scrollHeight; return true; })()`);
    await sleep(500);
    await shoot(c, `library-memory-bottom-${face}`);
    await evalIn(c, `__live.library("skills")`);
    await sleep(500);
    await shoot(c, `library-skills-${face}`);
    await evalIn(c, `(() => { document.querySelector('.sb-page-back')?.click(); return true; })()`);
    await sleep(400);
  }
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  await stopDaemons(home).catch(() => {});
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
