/**
 * Live check for the page panes' measure (run with: node apps/desktop/scripts/page-measure-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and measures where a page's parts actually land: the
 * head's glyph, the rail, the reading column, and the notifications split, at pane widths from 340
 * to ~1500. Alignment is the one property jsdom cannot hold an opinion about — it has no layout, so
 * `max-width` and `margin-inline: auto` are to it just two declarations that parse.
 *
 * The pane, not the window, is the thing being swept: `.page` is an inline-size container and a page
 * is as likely to be a third of a split as it is to be the whole screen. Widths below are WINDOW
 * widths; every assertion is against the measured `.page` rect.
 *
 * The second half is the scrollbar report: whether a track is painted in either mode. That is a
 * question about composited pixels, so it is answered by sampling the screenshot down the gutter of
 * a scroller that is actually overflowing, not by reading the stylesheet.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9347), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8913);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-page-measure-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Window widths. The sidebar takes 280 of each, so the pane sweeps ~340…~1520 — across the 640px
 *  narrow breakpoint, the notifications page's 760, and both sides of every measure. */
const WIDTHS = [1800, 1400, 1200, 1000, 860, 700, 620];

/** `scrollbar-color`'s second value is the track. Chromium serialises the computed value, so the
 *  authored `transparent` comes back as a zero-alpha colour and never as the keyword. */
const TRACKLESS = /\brgba\(0, 0, 0, 0\)\s*$/;

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

function rpc(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

const HELPERS = `
window.__live = window.__live ?? {
  /** Click a sidebar destination by its label, and wait for its page to be the one on screen. */
  async destination(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('.page')) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('destination did not open: ' + label);
  },
  /** Run a command palette entry by its visible label. Profile and space pages have no sidebar row —
   *  the palette is how a user reaches them. */
  async palette(label) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector('.palette input'); i++) await new Promise((r) => setTimeout(r, 25));
    const input = document.querySelector('.palette input');
    if (!input) throw new Error('the palette did not open');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, label);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 80; i++) {
      const hit = [...document.querySelectorAll('.palette-list [role=option]')]
        .find((o) => o.querySelector('.palette-label')?.textContent.trim() === label);
      if (hit) { hit.click(); return true; }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no palette entry: ' + label);
  },
  async menu(label) {
    document.querySelector('[aria-label="Space menu"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[role="menu"]'); i++) await new Promise((r) => setTimeout(r, 25));
    const hit = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === label);
    if (!hit) { document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); throw new Error('no menu item: ' + label); }
    hit.click();
    return true;
  },
  box(e) { if (!e) return null; const r = e.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; },
  /** Open a Settings rail tab by its visible label. */
  async settingsTab(label) {
    const hit = [...document.querySelectorAll('.page-rail .settings-tab')].find((l) => l.textContent.trim() === label);
    if (!hit) throw new Error('no settings tab: ' + label);
    hit.querySelector('input').click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (document.querySelector('.page-content')) return true;
    }
    throw new Error('tab did not open: ' + label);
  },
  /** The App tab's two card grids, against the column the shared shell gives them. The grids are the
   *  widest things on any Settings tab, so they are where a measure that does not hold shows first. */
  appearance() {
    const content = document.querySelector('.page-content');
    const grids = ['.mode-grid', '.theme-grid'].map((sel) => {
      const g = document.querySelector(sel);
      if (!g) return { sel, box: null };
      const cards = [...g.children].map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0);
      return { sel, box: this.box(g), overflowX: g.scrollWidth - g.clientWidth,
        cards: cards.length ? { n: cards.length,
          min: Math.round(Math.min(...cards.map((r) => r.width))), max: Math.round(Math.max(...cards.map((r) => r.width))),
          l: Math.round(Math.min(...cards.map((r) => r.left))), r: Math.round(Math.max(...cards.map((r) => r.right))) } : null };
    });
    return { content: this.box(content), grids, overflowX: content.scrollWidth - content.clientWidth };
  },
  /** The horizontal extent of a band's visible children — what the eye reads as the column's edges.
   *  The band ELEMENT is full-bleed today and would report itself centred either way. */
  span(el) {
    if (!el) return null;
    const rs = [...el.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
    if (!rs.length) return null;
    return { l: Math.round(Math.min(...rs.map((r) => r.left))), r: Math.round(Math.max(...rs.map((r) => r.right))) };
  },
  page() {
    const page = document.querySelector('.page');
    if (!page) return null;
    const q = (s) => this.box(page.querySelector(s));
    const head = page.querySelector('.page-head'), body = page.querySelector('.page-body');
    const headSpan = this.span(head), bodySpan = this.span(body);
    const p = this.box(page);
    const band = bodySpan && headSpan
      ? { l: Math.min(headSpan.l, bodySpan.l), r: Math.max(headSpan.r, bodySpan.r) } : null;
    return {
      page: p, head: this.box(head), body: this.box(body), headSpan, bodySpan,
      rail: q('.page-rail'), content: q('.page-content'), split: q('.notif-split'), chips: this.span(page.querySelector('.profile-spaces')),
      list: q('.notif-list'), detail: q('.notif-detail'), lens: q('.task-lens'), lensDetail: q('.task-detail'),
      gaps: band ? { left: band.l - p.l, right: p.r - band.r } : null,
    };
  },
  /** Any CSS colour as the sRGB triple the compositor will paint, via the compositor itself. */
  srgb(color) {
    const g = (this._cv ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true }));
    g.clearRect(0, 0, 1, 1); g.fillStyle = color; g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',');
  },
  /** A scroller that is actually overflowing, with the gutter its bar reserves. A gutter of 0 means
   *  the platform is drawing overlay bars, which paint no track at all. */
  scroller(sel) {
    const e = document.querySelector(sel);
    if (!e) return null;
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { sel, gutter: e.offsetWidth - e.clientWidth, overflow: e.scrollHeight - e.clientHeight,
      scrollTop: e.scrollTop, width: cs.scrollbarWidth, color: cs.scrollbarColor,
      box: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) } };
  },
  /** Pixels down the gutter of a scroller, each PAIRED with the page's own ground at the same y.
   *
   *  The page ground is not one colour: the decorative wash paints a field across it that is
   *  strongest at the top of the page and fades out below, and it drifts horizontally too (the blue
   *  channel moves about 7 across the width of a page at the top). So a single reference colour
   *  cannot say whether a gutter pixel is the page showing through or a track painted over it —
   *  most of the page legitimately differs from any one sample of it.
   *
   *  The reference is therefore read at the SAME y, at the nearest x outside the scroller that the
   *  page shows through: seeThrough walks up from the hit element and takes the point only if
   *  nothing between it and .page paints a background of its own. .page-body and .notif-detail are
   *  both transparent, so a usable reference is usually a few pixels away and the wash's own drift
   *  between the two columns stays inside a unit. */
  async gutterPixels(b64, box, gutter) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    const g = cv.getContext('2d');
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
    const page = document.querySelector('.page');
    const pb = page.getBoundingClientRect();
    const seeThrough = (x, y) => {
      let el = document.elementFromPoint(x, y);
      if (!el || !page.contains(el)) return false;
      for (; el && el !== page; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (!/^rgba\(\d+, \d+, \d+, 0\)$/.test(cs.backgroundColor)) return false;
        if (cs.backgroundImage !== 'none') return false;
      }
      return el === page;
    };
    /** The nearest column either side of the gutter that the page shows through, never one inside
     *  the scroller — a pixel in there lands on a row, not on the ground. */
    const refX = (y) => {
      for (let d = 3; d < 700; d += 3) {
        for (const x of [Math.round(box.r) + d, Math.round(box.l) - d]) {
          if (x <= pb.left + 1 || x >= pb.right - 1) continue;
          if (x >= box.l && x <= box.r) continue;
          if (seeThrough(x, y)) return x;
        }
      }
      return null;
    };
    const x = Math.round(box.r - gutter / 2);
    const out = [];
    for (let i = 1; i < 40; i++) {
      const y = Math.round(box.t + ((box.b - box.t) * i) / 40);
      const rx = refX(y);
      out.push({ y, gutter: px(x, y), ref: rx === null ? null : px(rx, y), rx });
    }
    return out;
  },
};
`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: `${HELPERS};\n${expr}`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shot(c, tag) {
  const s = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(os.tmpdir(), `realm-page-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(s.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return s.data;
}

/** The composited proof that no track is drawn: down the scroller's gutter the page shows through
 *  everywhere the thumb is not, and the thumb is one unbroken run.
 *
 *  A track is a band filling the WHOLE gutter, so it shows up two ways at once and both are asserted:
 *  no row still reads as the page, and the run of rows that differ stops being just the thumb. The
 *  wash means a row can only be judged against the page at its OWN y — see `gutterPixels`.
 *
 *  A gutter of 0 means the platform is drawing overlay bars, which have no track to draw. */
const TRACK_TOL = 4;

async function gutter(c, mode, s, b64) {
  const tag = mode.toLowerCase();
  if (!s || s.gutter <= 0) {
    console.log(`  NOTE ${tag} ${s?.sel}: overlay scrollbars (gutter 0) — there is no track to paint.`);
    return;
  }
  const rows = await evalIn(c, `__live.gutterPixels(${JSON.stringify(b64)}, ${JSON.stringify(s.box)}, ${s.gutter})`);
  const usable = rows.filter((r) => r.ref !== null);
  /* Per-channel distance from the page at the same y. The wash's drift between the gutter and the
     nearest see-through column is under a unit; the thumb — the thing that is SUPPOSED to differ —
     is 18 away, so TRACK_TOL separates them with room at both ends. */
  const off = (r) => Math.max(...r.gutter.map((v, i) => Math.abs(v - r.ref[i])));
  const onGround = usable.filter((r) => off(r) <= TRACK_TOL);
  const differing = usable.map((r, i) => [i, off(r)]).filter(([, d]) => d > TRACK_TOL).map(([i]) => i);
  const oneRun = differing.length > 0 && differing[differing.length - 1] - differing[0] === differing.length - 1;
  /* A thumb is REQUIRED, not merely tolerated. Without that clause an empty gutter passes, and an
     empty gutter is what a bar painted in a colour it cannot be seen against looks like — which is
     the same regression, arrived at from the other side. */
  check(`${tag}: down ${s.sel}'s gutter the thumb is the only thing that differs from the page`,
    usable.length >= 20 && onGround.length > 0 && oneRun,
    { usable: usable.length, of: rows.length, onGround: onGround.length,
      worstOnGround: onGround.length ? Math.max(...onGround.map(off)) : null,
      thumbRun: differing.length ? [differing[0], differing[differing.length - 1]] : null,
      thumbOff: differing.length ? Math.max(...differing.map((i) => off(usable[i]))) : null });
}

/** Sweep one page across the widths, report the measured rects, and leave a shot of the widest —
 *  the width the complaint was about, and the one a number cannot settle. */
async function sweep(c, label, tag) {
  const rows = [];
  for (const width of WIDTHS) {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    rows.push({ width, ...(await evalIn(c, `__live.page()`)) });
  }
  console.log(`\n── ${label} ───────────────────────────────────────────────`);
  for (const r of rows) {
    console.log(`  pane ${String(r.page.w).padStart(4)}  gaps L${String(r.gaps?.left ?? "-").padStart(4)} R${String(r.gaps?.right ?? "-").padStart(4)}` +
      `  head[${r.headSpan?.l},${r.headSpan?.r}] body[${r.bodySpan?.l},${r.bodySpan?.r}]` +
      (r.rail ? `  rail w${r.rail.w}@${r.rail.l}` : "") +
      (r.content ? `  content w${r.content.w}@${r.content.l}` : "") +
      (r.list ? `  list w${r.list.w}@${r.list.l} detail w${r.detail?.w}@${r.detail?.l}` : ""));
  }
  if (tag) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: WIDTHS[0], height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    await shot(c, tag);
  }
  return rows;
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
      REALM_HOME: path.join(scratch, "home"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group. Main spawns the server as a GRANDCHILD, so killing the Electron pid
    // alone orphans a listener on SERVER_PORT and the next run refuses to start on a busy port.
    detached: true,
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  /* A feed with rows in it. `session_done` is the notification a finished turn raises, and the fake
     agent finishes one immediately — the page's empty state would measure a single paragraph and
     say nothing about the split. */
  const api = rpc(SERVER_PORT);
  await api.ready;
  const first = (await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session"))[0];
  const spaceId = first.spaceId;
  const TITLES = ["Rename the pane group", "Port the importer", "Trim the transcript", "Fix the diff gutter",
    "Teach the rail to wrap", "Drop the dead migration", "Seed the scratch repo", "Re-probe the engines",
    "Widen the commit field", "Collapse the sidebar"];
  for (const title of TITLES) {
    const made = await api.call("sessions.create", { spaceId, agentKind: "fake", title });
    await api.call("sessions.send", { id: made.session.id, text: "hello", attachments: [], mentions: [] });
  }
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  await api.call("sessions.send", { id: first.id, text: "hello", attachments: [], mentions: [] });
  await until(() => evalIn(c, `(window.__realmUnread ?? 0) >= 0 && !!document.querySelector('.sb-destinations')`), 10000, "the sidebar");
  await sleep(2500);

  /* ── Settings: rail + reading column ─────────────────────────────────────────────────────── */
  await evalIn(c, `__live.destination('Settings')`);
  await sleep(500);
  const settings = await sweep(c, "Settings", "wide-settings");

  const wide = settings.filter((r) => r.page.w >= 1000);
  check("settings: the column is centred in the pane — equal air on both sides",
    wide.every((r) => Math.abs(r.gaps.left - r.gaps.right) <= 1),
    wide.map((r) => ({ pane: r.page.w, l: r.gaps.left, r: r.gaps.right })));
  check("settings: the head sits over the column it introduces, not off at the pane's left edge",
    wide.every((r) => Math.abs(r.headSpan.l - r.bodySpan.l) <= 1),
    wide.map((r) => ({ pane: r.page.w, head: r.headSpan.l, body: r.bodySpan.l })));
  check("settings: the reading column keeps its 720px measure at every width",
    settings.every((r) => r.content.w <= 720), settings.map((r) => ({ pane: r.page.w, content: r.content.w })));
  check("settings: the rail stays beside the column at the body's own 20px gap",
    settings.filter((r) => r.page.w > 640).every((r) => r.content.l - r.rail.r === 20),
    settings.map((r) => ({ pane: r.page.w, gap: r.content.l - r.rail.r })));
  const narrow = settings.filter((r) => r.page.w <= 640);
  check("settings: a narrow pane is spent on content, not on margins — the column stays full-bleed",
    narrow.length > 0 && narrow.every((r) => r.gaps.left <= 16),
    narrow.map((r) => ({ pane: r.page.w, l: r.gaps.left })));

  /* ── Notifications: a two-column split, not a form ───────────────────────────────────────── */
  await evalIn(c, `__live.destination('Notifications')`);
  await sleep(500);
  const notifs = await sweep(c, "Notifications", "wide-notifications");
  check("notifications: the feed has rows to lay out", notifs.every((r) => r.list && r.detail),
    notifs.map((r) => ({ pane: r.page.w, list: !!r.list })));
  const nWide = notifs.filter((r) => r.page.w >= 1200);
  check("notifications: the split is centred as one unit",
    nWide.length > 0 && nWide.every((r) => Math.abs(r.gaps.left - r.gaps.right) <= 1),
    nWide.map((r) => ({ pane: r.page.w, l: r.gaps.left, r: r.gaps.right })));
  check("notifications: both columns stay readable — the detail never falls under the list's width",
    notifs.filter((r) => r.page.w > 760).every((r) => r.detail.w >= 300),
    notifs.map((r) => ({ pane: r.page.w, list: r.list?.w, detail: r.detail?.w })));
  const nStack = notifs.filter((r) => r.page.w <= 760);
  check("notifications: under 760 of pane the columns stack and the page is full-bleed again",
    nStack.length > 0 && nStack.every((r) => r.detail.t > r.list.t && r.gaps.left <= 24),
    nStack.map((r) => ({ pane: r.page.w, listTop: r.list?.t, detailTop: r.detail?.t, l: r.gaps.left })));

  /* ── The other three shapes on the same shell ────────────────────────────────────────────── */
  await evalIn(c, `__live.destination('Connections')`);
  await sleep(500);
  const conns = await sweep(c, "Connections (no rail)", "wide-connections");
  check("connections: a page with no rail centres the column it does have",
    conns.filter((r) => r.page.w >= 1000).every((r) => Math.abs(r.gaps.left - r.gaps.right) <= 1),
    conns.map((r) => ({ pane: r.page.w, l: r.gaps.left, r: r.gaps.right })));

  await evalIn(c, `__live.palette('Open profile')`);
  await until(() => evalIn(c, `!!document.querySelector('.profile-page-pane')`), 10000, "the profile page");
  await sleep(500);
  const profile = await sweep(c, "Profile", "wide-profile");
  check("profile: the space chips share the column, rather than starting at the pane's edge",
    profile.every((r) => Math.abs(r.chips.l - r.bodySpan.l) <= 1),
    profile.map((r) => ({ pane: r.page.w, chips: r.chips?.l, body: r.bodySpan?.l })));

  await evalIn(c, `__live.palette('Open space')`);
  await until(() => evalIn(c, `!!document.querySelector('.space-page-pane')`), 10000, "the space page");
  await sleep(500);
  const general = await sweep(c, "Space · General", "wide-space-general");
  await evalIn(c, `(() => { [...document.querySelectorAll('.page-rail .settings-tab')].find((l) => l.textContent.trim() === 'Tasks').querySelector('input').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.task-lens')`), 10000, "the tasks lens");
  await sleep(500);
  const tasks = await sweep(c, "Space · Tasks lens", "wide-tasks");
  check("space: switching to the Tasks tab widens the page — the head and rail move with it",
    general[0].gaps.left > tasks[0].gaps.left,
    { general: general[0].gaps.left, tasks: tasks[0].gaps.left });
  check("tasks: the lens still opts out of the reading measure — it is wider than 720 where there is room",
    tasks.filter((r) => r.page.w >= 1400).every((r) => r.content.w > 720),
    tasks.map((r) => ({ pane: r.page.w, content: r.content?.w, lens: r.lens?.w })));
  check("tasks: the lens keeps room for a list AND a 340px panel beside it, which 720 would not leave",
    tasks.filter((r) => r.page.w >= 1400).every((r) => r.lens.w >= 1000),
    tasks.map((r) => ({ pane: r.page.w, lens: r.lens?.w })));

  await evalIn(c, `__live.destination('Settings')`);
  await sleep(500);
  /* ── Settings → App: the Appearance controls, against the other tabs ─────────────────────────
     "Fix the padding here" reads most naturally as Appearance disagreeing with the tabs above it,
     so the gutters are measured on every tab rather than on the one that was complained about — a
     number from Appearance alone cannot tell an inconsistency from a taste. The App tab is also the
     only one whose content is a GRID of cards, which is the thing that escapes a measure first. */
  const SETTINGS_TABS = ["Engines", "Usage", "App", "Sign-ins", "Import", "Permissions"];
  const perTab = [];
  for (const width of WIDTHS) {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    for (const label of SETTINGS_TABS) {
      await evalIn(c, `__live.settingsTab(${JSON.stringify(label)})`);
      await sleep(140);
      const p = await evalIn(c, `__live.page()`);
      perTab.push({ width, label, content: p.content, body: p.body });
    }
  }
  console.log("\n── Settings tabs, one column each ───────────────────────────────");
  for (const width of WIDTHS) {
    const at = perTab.filter((r) => r.width === width);
    console.log(`  window ${String(width).padStart(4)}  ` +
      at.map((r) => `${r.label} w${r.content.w}@${r.content.l}`).join("  "));
  }
  check("settings: every tab is set in the same column — Appearance has no gutters of its own",
    WIDTHS.every((w) => {
      const at = perTab.filter((r) => r.width === w);
      return at.every((r) => r.content.l === at[0].content.l && r.content.w === at[0].content.w);
    }),
    WIDTHS.map((w) => {
      const at = perTab.filter((r) => r.width === w);
      return { width: w, distinct: [...new Set(at.map((r) => `${r.content.w}@${r.content.l}`))] };
    }));

  const appearance = [];
  for (const width of WIDTHS) {
    await c.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    await evalIn(c, `__live.settingsTab("App")`);
    await sleep(200);
    appearance.push({ width, ...(await evalIn(c, `__live.appearance()`)) });
  }
  console.log("\n── Settings → App: the theme grids ──────────────────────────────");
  for (const a of appearance) {
    console.log(`  window ${String(a.width).padStart(4)}  column w${a.content.w}@${a.content.l}  ` +
      a.grids.map((g) => `${g.sel} ${g.cards.n}×${g.cards.min}–${g.cards.max}@[${g.cards.l},${g.cards.r}]`).join("  "));
  }
  check("appearance: the cards stay inside the reading column — no grid escapes the measure",
    appearance.every((a) => a.grids.every((g) => g.cards.l >= a.content.l - 1 && g.cards.r <= a.content.r + 1)),
    appearance.map((a) => ({ width: a.width, col: [a.content.l, a.content.r],
      grids: a.grids.map((g) => [g.cards.l, g.cards.r]) })));
  check("appearance: nothing in the App tab scrolls sideways at any width",
    appearance.every((a) => a.overflowX <= 0 && a.grids.every((g) => g.overflowX <= 0)),
    appearance.map((a) => ({ width: a.width, content: a.overflowX, grids: a.grids.map((g) => g.overflowX) })));

  // Back to the widest and to the tab the page opens on, the way `sweep` leaves it. The App tab is
  // not a neutral thing to leave behind: it re-renders every palette card on a theme change, which
  // is exactly what the scrollbar pass below does next.
  await evalIn(c, `__live.settingsTab("Engines")`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: WIDTHS[0], height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  /* ── Scrollbars, in both modes, on a scroller that is actually overflowing ───────────────── */
  await evalIn(c, `__live.destination('Settings')`);
  await sleep(400);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  for (const mode of ["Dark", "Light"]) {
    await evalIn(c, `__live.menu(${JSON.stringify(`Theme: ${mode}`)})`);
    await sleep(500);
    const s = await evalIn(c, `__live.scroller('.page-content')`);
    check(`${mode.toLowerCase()}: the settings column is genuinely overflowing, so there is a bar to judge`,
      s && s.overflow > 40, s);
    check(`${mode.toLowerCase()}: the track is transparent — the thumb is the only thing the bar paints`,
      TRACKLESS.test(s.color) && s.width === "thin", { color: s.color, width: s.width, gutter: s.gutter });
    await gutter(c, mode, s, await shot(c, `settings-${mode.toLowerCase()}`));

    await evalIn(c, `__live.destination('Notifications')`);
    await sleep(400);
    const n = await evalIn(c, `__live.scroller('.notif-list')`);
    check(`${mode.toLowerCase()}: the notifications list is overflowing too, and its bar is the same thin one`,
      n && n.overflow > 40 && TRACKLESS.test(n.color) && n.width === "thin", n);
    await gutter(c, mode, n, await shot(c, `notifications-${mode.toLowerCase()}`));
    await evalIn(c, `__live.destination('Settings')`);
    await sleep(300);
  }

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    const killGroup = (sig) => { try { if (electron?.pid) process.kill(-electron.pid, sig); } catch { /* already gone */ } };
    killGroup("SIGTERM");
    setTimeout(() => {
      killGroup("SIGKILL");
      fs.rmSync(scratch, { recursive: true, force: true });
      process.exit(process.exitCode ?? 0);
    }, 1200);
  });
