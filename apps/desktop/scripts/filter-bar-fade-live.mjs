/**
 * Live check for the filter bar under a page's top edge fade
 * (run with: node apps/desktop/scripts/filter-bar-fade-live.mjs)
 *
 * The bug this pins: scroll the Library and the search field and filter chips — the controls that
 * decide WHAT the grid is showing — slid under the page's top fade and went to a smudge. That fade
 * was a backdrop-filter, and a backdrop-filter takes everything painted beneath it, so a band added
 * to dissolve CONTENT was blurring CHROME. The z-index that used to exempt the bar is gone with the
 * band: the dissolve is a mask on the scroller now, and a mask applies to everything the element
 * paints, so nothing inside a scroller can be lifted out of it.
 *
 * What holds instead is the property that made the mask the right answer. A mask takes ALPHA, not
 * detail: the bar scrolling into the dissolve keeps every edge it had and simply becomes less there,
 * which is what a thing leaving looks like — where a blur destroys the detail and reads as a broken
 * render. That is measurable, so it is measured: a clip of the bar parked inside the dissolve is
 * scored for sharpness (mean absolute difference between neighbouring pixels, normalised for the
 * fade's own loss of contrast), and the mutant is a backdrop blur put back over the same strip at
 * the same offset. The score has to collapse under the mutant, or the check is measuring nothing.
 * Both Library tabs that carry a bar are run, since they are two different elements.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9371), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8937);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-filter-bar-fade-"));
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
globalThis.__live = {
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
  tab(label) {
    const t = [...document.querySelectorAll('.page-rail-tab')].find((x) => x.textContent.trim() === label);
    if (!t) throw new Error('no tab: ' + label);
    t.querySelector('input').click();
    return true;
  },
  /* Parks the bar six pixels into the band: enough scroll for ScrollFades to arm the band at all
     (it wants more than two), and shallow enough that the field's own ink is still inside it. */
  park(sel, into) {
    const sc = document.querySelector('.page-scroll .page-content');
    const bar = sc.querySelector(sel);
    if (!bar) throw new Error('no bar: ' + sel);
    const want = (bar.getBoundingClientRect().top - sc.getBoundingClientRect().top) + into;
    sc.scrollTop = Math.round(sc.scrollTop + want);
    return Math.round(sc.scrollTop);
  },
  /* The clip: the band's own depth, across the bar, starting at the scroller's top edge. Read from
     --fade-top-h rather than written down here, so a change to the band's depth moves the clip with
     it instead of quietly measuring the wrong strip. */
  clip(sel) {
    const wrap = document.querySelector('.page-scroll');
    const sc = wrap.querySelector('.page-content');
    const bar = sc.querySelector(sel);
    const depth = parseFloat(getComputedStyle(wrap).getPropertyValue('--fade-top-h'));
    const s = sc.getBoundingClientRect(), b = bar.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(s.top), width: Math.round(b.width),
             height: Math.round(Math.min(depth, b.bottom - s.top)),
             armed: (sc.dataset.dissolve ?? '').includes('start'),
             barZ: getComputedStyle(bar).zIndex, scrollTop: Math.round(sc.scrollTop),
             overflow: Math.round(sc.scrollHeight - sc.clientHeight) };
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

/** Mean absolute luminance step between horizontally adjacent pixels. Text against a fill is all
 *  steps; a blur is the operation that spreads them out. It is a relative number — only the ratio
 *  between the fixed reading and the mutant's means anything. */
const SHARPNESS = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  let sum = 0, n = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 1; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      sum += Math.abs(lum(i) - lum(i - 4)); n++;
    }
  }
  return +(sum / n).toFixed(4);
})()`;

async function shot(c, clip, tag) {
  const r = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  const out = path.join(os.tmpdir(), `realm-filter-bar-fade-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return r.data;
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
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // Short on purpose: the band only has a job once the column scrolls, and a short window is what
  // makes an ordinary page overflow without seeding two hundred files to do it.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 460, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* The Files tab is the surface the bug was reported on, and it is empty on a fresh home — so it is
     given something to scroll. Attachments on a user message are what the index calls an upload
     (`artifactsFromEvent`), which is the real write path rather than a row poked into the table. */
  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const session = (await api.call("sessions.listAll", {}))[0];
  const files = Array.from({ length: 12 }, (_, i) => path.join(scratch, `seed-${i}.md`));
  for (const f of files) fs.writeFileSync(f, "# seed\n");
  await api.call("sessions.send", { id: session.id, text: "here are some files",
    attachments: files.map((f) => ({ path: f, mime: "text/markdown" })) });

  await evalIn(c, `__live.dest("Library")`);
  await until(() => evalIn(c, `document.querySelectorAll('.library-grid li').length >= 12`), 20000, "seeded files");
  await sleep(500);

  /* How far into the bar to park, per tab. The Library's is two rows and the chips are the second, so
     50px puts the strip on the CHIPS — which is the row that was reported smudged. The Skills bar is
     one row, so it is read at its own top. */
  for (const [tab, sel, ready, into] of [["Files", ".page-filters", ".library-files", 50], ["Skills", ".skills-filter-row", ".settings-panel", 6]]) {
    await evalIn(c, `__live.tab(${JSON.stringify(tab)})`);
    await until(() => evalIn(c, `!!document.querySelector('${ready} ${sel}')`), 15000, `${tab} bar`);
    await sleep(400);

    await evalIn(c, `__live.park(${JSON.stringify(sel)}, ${into})`);
    await sleep(350);
    const clip = await evalIn(c, `__live.clip(${JSON.stringify(sel)})`);
    check(`${tab}: the column scrolls and the top end is dissolving over the bar`,
      clip.overflow > 12 && clip.armed && clip.height > 8, clip);

    const dissolved = await evalIn(c, SHARPNESS(await shot(c, clip, `${tab.toLowerCase()}-dissolved`)));

    /* The mutant: a backdrop blur over the same strip — the band this replaced, in one line. Nothing
       else moves, so the only difference between the two readings is what the effect does to detail. */
    await evalIn(c, `(() => {
      const st = document.createElement('style'); st.id = 'mutant-blur';
      st.textContent = '.page-scroll::after { content: ""; position: absolute; inset: 0 0 auto 0;'
        + ' height: var(--fade-top-h); z-index: 3; pointer-events: none;'
        + ' backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }';
      document.head.appendChild(st); return true; })()`);
    await sleep(350);
    const parked = await evalIn(c, `__live.clip(${JSON.stringify(sel)})`);
    check(`${tab}: the mutant reads the same strip (same scroll, same box)`,
      parked.scrollTop === clip.scrollTop && parked.y === clip.y && parked.height === clip.height, parked);
    const mutant = await evalIn(c, SHARPNESS(await shot(c, parked, `${tab.toLowerCase()}-mutant`)));

    check(`${tab}: the bar keeps its detail as it dissolves, where a blur would take it`,
      dissolved > mutant * 1.5, { dissolved, mutant, ratio: +(dissolved / mutant).toFixed(2) });

    await evalIn(c, `(() => { document.getElementById('mutant-blur').remove(); return true; })()`);
    await sleep(250);
  }
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} process.exit(process.exitCode ?? 0); }, 800);
  });
