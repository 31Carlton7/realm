/**
 * Live check for the two marks a sidebar session row wears (run with: node apps/desktop/scripts/sidebar-marks-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves three things jsdom cannot, because all three
 * are about paint and layout rather than about markup:
 *
 *   1. The status ring is actually PAINTED. It is a `::after` over the macOS vibrancy material, drawn
 *      with color-mix against a token — a jsdom test can only see that the rule exists.
 *   2. It is still painted under prefers-reduced-motion. The global reduced-motion block uses `*`,
 *      which does not match pseudo-elements, so that carve-out is easy to lose and impossible to
 *      notice anywhere else; a running session that reads as idle is the whole failure.
 *   3. The row's trailing marks stay a pair. The dot and the glyph both used to take
 *      `margin-left: auto`, and two auto margins SHARE the free space — so the dot was pushed to the
 *      middle of whatever the title left over while the glyph went on to the row's end, tearing the
 *      two apart by an amount that depended on the title's length. Only real layout can see that.
 *
 * Each measurement is paired with a mutant that reproduces the bug it pins, so a check that has
 * quietly stopped measuring anything fails instead of passing.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9338), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8904);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-sidebar-marks-"));
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Pixels in a clip that differ from its own corner (the row ground) by more than a hair of
 *  luminance — "how much mark is on screen here", which is what the ring adds and the mutant removes.
 *  Counting ink rather than comparing hashes because a backdrop material dithers: two screenshots of
 *  an unchanged vibrant surface are not bit-identical, and a hash would call that a difference. */
const INK = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const ground = lum(0);
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (Math.abs(lum(i) - ground) > 6) ink++;
  return ink;
})()`;

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

  // A window wide enough that the sidebar is at its full 280px and the panes split cleanly.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  /* ── A real two-pane split, made the way a user makes one ────────────────────────────────────
     "New session" opens into the focused leaf, which pushes the first session out of the OPEN group;
     splitting right then leaves an empty focused leaf, and clicking the first session's SPACE row
     opens it there. The result is a two-way row split with two OPEN rows — the layout the glyph is
     for, reached through the same gestures rather than by writing a layout into the store. */
  await evalIn(c, `(() => { document.querySelector('.new-row').click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.item-list .item').length >= 2`), 15000, "a second session");
  // Split right. The bar collapses its actions into a ⋯ menu below a threshold width and offers them
  // inline above it, so take whichever this pane is showing rather than assuming one.
  await evalIn(c, `(() => {
    const inline = document.querySelector('.panel-bar button[aria-label^="Split"][aria-label$="right"]');
    if (inline) { inline.click(); return true; }
    document.querySelector('.panel-bar button[aria-label^="Pane menu"]').click();
    return true; })()`);
  await evalIn(c, `(() => {
    const it = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.startsWith('Split right'));
    if (it) it.click();
    return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.panehost .panel').length === 2`), 15000, "two panes");
  // Sessions are auto-titled alike, so the first one is found by its ROLE in the sidebar — the only
  // row in the SPACE group, i.e. the one row with no glyph — not by its text.
  await evalIn(c, `(() => {
    const row = [...document.querySelectorAll('.item-list .item-row')].find((r) => !r.querySelector('.item-glyph'));
    row.click(); return true; })()`);
  await until(() => evalIn(c, `document.querySelectorAll('.item-glyph').length === 2`), 15000, "two glyphs");
  await sleep(300);

  /* ── 1. The split glyph draws the split it is describing ─────────────────────────────────── */
  const glyphs = await evalIn(c, `(() => {
    return [...document.querySelectorAll('.item-glyph')].map((g) => {
      const box = g.getBoundingClientRect();
      const bars = [...g.querySelectorAll('span')].map((s) => {
        const r = s.getBoundingClientRect();
        return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), on: s.hasAttribute('data-on') };
      });
      return { dir: g.dataset.dir, w: Math.round(box.width), h: Math.round(box.height), bars };
    });
  })()`);
  check("both open rows draw a two-bar glyph on the split's own axis", glyphs.length === 2
    && glyphs.every((g) => g.dir === "row" && g.bars.length === 2), glyphs.map((g) => ({ dir: g.dir, bars: g.bars.length })));
  check("the two rows light different bars — the mark distinguishes the panes",
    glyphs[0]?.bars.findIndex((b) => b.on) !== glyphs[1]?.bars.findIndex((b) => b.on),
    glyphs.map((g) => g.bars.findIndex((b) => b.on)));
  // Legibility, the reason the mark grew from 10px to 12px and dropped the second axis: a bar under
  // ~4px reads as a speck. Two slots in the old 2x2 were 4.5px cells; these are 5.5px bars.
  const thinnest = Math.min(...glyphs.flatMap((g) => g.bars.map((b) => b.w)));
  check("every bar is at least 5px across", thinnest >= 5, { thinnest, box: glyphs[0]?.w });

  /* ── 2. The trailing marks do not collide ────────────────────────────────────────────────── */
  // A status has to exist for a dot to render, so drive one real turn through the scripted adapter.
  await evalIn(c, `(() => {
    const el = document.querySelector('.composer-input');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(el, 'hello'); el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.composer-send').click(); return true; })()`);
  const dotSel = `.item[data-active] .item-status, .item-status`;
  await until(() => evalIn(c, `!!document.querySelector(${JSON.stringify(dotSel)})`), 20000, "a status dot");

  const marks = await evalIn(c, `(() => {
    const dot = document.querySelector('.item-row:has(.item-status):has(.item-glyph)');
    if (!dot) return null;
    const row = dot.getBoundingClientRect();
    const s = dot.querySelector('.item-status').getBoundingClientRect();
    const g = dot.querySelector('.item-glyph').getBoundingClientRect();
    const t = dot.querySelector('.item-title').getBoundingClientRect();
    return { gap: +(g.left - s.right).toFixed(2), titleToDot: +(s.left - t.right).toFixed(2),
             glyphToRowEnd: +(row.right - g.right).toFixed(2), rowW: Math.round(row.width) };
  })()`);
  check("a row that is both running and open lays its dot and glyph out as a spaced pair at the row's end",
    marks !== null && marks.gap > 6 && marks.gap < 14 && marks.titleToDot > 6 && marks.glyphToRowEnd < 12, marks);
  // The mutant: put `margin-left: auto` back on both marks, exactly as it was. Two auto margins in one
  // flex row SHARE the free space, so the dot is pushed to the middle of whatever the title left over
  // and the glyph carries on to the end — the pair is torn across the row, and where the dot lands is
  // a function of the title's length, so no two rows agree on it.
  await evalIn(c, `(() => {
    const st = document.createElement('style'); st.id = 'mutant-auto';
    st.textContent = '.item-status, .item-glyph { margin-left: auto !important; } .item-title { flex: none !important; }';
    document.head.appendChild(st); return true; })()`);
  await sleep(150);
  const mutantMarks = await evalIn(c, `(() => {
    const dot = document.querySelector('.item-row:has(.item-status):has(.item-glyph)');
    const s = dot.querySelector('.item-status').getBoundingClientRect();
    const g = dot.querySelector('.item-glyph').getBoundingClientRect();
    return { gap: +(g.left - s.right).toFixed(2) };
  })()`);
  check("the mutant reproduces the bug (both marks back on margin-left:auto ⇒ the dot floats off into the row)",
    mutantMarks.gap > 20, { ...mutantMarks, fixed: marks.gap });
  await evalIn(c, `(() => { document.getElementById('mutant-auto').remove(); return true; })()`);

  /* ── 3. The status ring is painted, with and without motion ──────────────────────────────── */
  const dotRect = await evalIn(c, `(() => {
    const d = document.querySelector('.item-row:has(.item-glyph) .item-status');
    d.setAttribute('data-status', 'idle');
    const r = d.getBoundingClientRect();
    // A clip wide enough for the 12px halo and no wider — the title's ellipsis sits 10px to the left.
    return { x: Math.round(r.left) - 5, y: Math.round(r.top) - 5, width: Math.round(r.width) + 10, height: Math.round(r.height) + 10 };
  })()`);
  const inkOf = async (status) => {
    await evalIn(c, `(() => { document.querySelector('.item-row:has(.item-glyph) .item-status').setAttribute('data-status', ${JSON.stringify(status)}); return true; })()`);
    await sleep(250);
    const shot = await c.send("Page.captureScreenshot", { format: "png", clip: { ...dotRect, scale: 1 } });
    return { ink: await evalIn(c, INK(shot.data)), data: shot.data };
  };

  const idle = await inkOf("idle");
  const running = await inkOf("running");
  check("a running dot puts more mark on screen than an idle one — the ring is really painted over the vibrancy",
    running.ink > idle.ink * 1.25, { idle: idle.ink, running: running.ink });

  // The mutant: take the ring away and leave the core. This is the OLD indicator — a plain dot whose
  // only difference from idle was its colour and a brightness throb. If ink does not collapse to
  // idle's, the measurement above was reading something other than the ring.
  await evalIn(c, `(() => {
    const st = document.createElement('style'); st.id = 'mutant-ring';
    st.textContent = '.status-dot::after { display: none !important; }';
    document.head.appendChild(st); return true; })()`);
  const ringless = await inkOf("running");
  check("the mutant reproduces the old indicator (no ring ⇒ a running dot is the same mark as an idle one)",
    ringless.ink < idle.ink * 1.25, { idle: idle.ink, ringless: ringless.ink });
  await evalIn(c, `(() => { document.getElementById('mutant-ring').remove(); return true; })()`);

  /* prefers-reduced-motion: the global block strips animation with `*`, which does not match
     pseudo-elements. The ring must lose its ping and keep its halo — a running session that reads as
     idle for anyone with the preference on is the failure this exists to catch. */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(300);
  const reducedIdle = await inkOf("idle");
  const reducedRunning = await inkOf("running");
  check("with prefers-reduced-motion the ring is still painted — running does not collapse to idle",
    reducedRunning.ink > reducedIdle.ink * 1.25, { idle: reducedIdle.ink, running: reducedRunning.ink });
  // …and nothing is moving: two frames half a second apart have to hold the same amount of ink.
  const again = await c.send("Page.captureScreenshot", { format: "png", clip: { ...dotRect, scale: 1 } });
  const againInk = await evalIn(c, INK(again.data));
  check("and it is genuinely still — no ping survives the preference",
    Math.abs(againInk - reducedRunning.ink) <= 2, { first: reducedRunning.ink, later: againInk });
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  // The artifacts are captured again at 8x rather than reusing the measured frames: the ink counts
  // above are in CSS pixels and the clip is 16 of them square, which is nothing to look at.
  for (const status of ["idle", "running", "waiting_permission"]) {
    await evalIn(c, `(() => { document.querySelector('.item-row:has(.item-glyph) .item-status').setAttribute('data-status', ${JSON.stringify(status)}); return true; })()`);
    await sleep(200);
    const big = await c.send("Page.captureScreenshot", { format: "png", clip: { ...dotRect, scale: 8 } });
    const out = path.join(os.tmpdir(), `realm-sidebar-mark-${status}.png`);
    fs.writeFileSync(out, Buffer.from(big.data, "base64"));
    console.log(`SCREENSHOT ${status} ${out}`);
  }
  const sidebar = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 280, height: 820, scale: 2 } });
  const sidebarOut = path.join(os.tmpdir(), "realm-sidebar-marks.png");
  fs.writeFileSync(sidebarOut, Buffer.from(sidebar.data, "base64"));
  console.log(`SCREENSHOT sidebar ${sidebarOut}`);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
