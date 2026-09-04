/**
 * Live check for the hero prompter's stacking order (run with: node apps/desktop/scripts/prompter-fade-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves one thing a jsdom test cannot see, because
 * it needs real compositing: `.transcript-fade`'s blur band must never paint OVER the prompter.
 *
 * The bug it pins: the hero state puts a `transform` on `.composer-dock`, which makes the dock a
 * stacking context — so `.composer`'s own `z-index: 1` is trapped inside it and the whole dock drops
 * to layer 0, under the fade's layer 1. The band then blurred a horizontal stripe straight across
 * the middle of the hero card, square corners and all.
 *
 * How it is proven: force the fade VISIBLE over the hero card, screenshot, then delete the fade and
 * screenshot again. If the fade paints over the card the two differ; if the card outranks it they
 * are pixel-identical. Run against the pre-fix stylesheet and this check fails — that is the point.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9336), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8902);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-fade-live-"));
const results = {};
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

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Long enough that the card grows tall and its middle sits inside the fade band's 68px. */
const DRAFT = Array.from({ length: 9 }, (_, i) =>
  `Line ${i + 1}: the prompter's text must stay sharp all the way down the card, with no blurred band cutting across it.`).join("\n");

async function shot(c, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
  return { data: r.data, hash: crypto.createHash("sha256").update(r.data).digest("hex").slice(0, 16) };
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
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // The narrow, short viewport from the bug report: it trips the hero clamp, which pins the card
  // near the pane top so the fade band crosses its MIDDLE rather than clipping its last few pixels.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  // The hero state is the one that transforms the dock — assert we are actually in it.
  const hero = await evalIn(c, `document.querySelector('.session-pane')?.dataset.composer`);
  check("the empty session shows the hero prompter", hero === "hero", { state: hero });

  await evalIn(c, `(() => { __live.setInput(document.querySelector('.composer-input'), ${JSON.stringify(DRAFT)}); return true; })()`);
  await sleep(500); // the 320ms dock transition, plus a frame to settle

  // Geometry: the fade band really does cross the card, so the comparison below is not vacuous.
  const geo = await evalIn(c, `(() => {
    const card = document.querySelector('.composer').getBoundingClientRect();
    const fade = document.querySelector('.transcript-fade');
    const prev = fade.style.cssText;
    fade.style.display = 'block';        // hero hides it; force it back to test the stacking order
    const f = fade.getBoundingClientRect();
    fade.style.cssText = prev;
    return { card: { top: Math.round(card.top), bottom: Math.round(card.bottom), left: Math.round(card.left), right: Math.round(card.right) },
             fade: { top: Math.round(f.top), bottom: Math.round(f.bottom) } };
  })()`);
  const crosses = geo.fade.top < geo.card.bottom && geo.fade.bottom > geo.card.top;
  check("the fade band overlaps the hero card (so the test below means something)", crosses, geo);

  // The measure: mean horizontal gradient energy per row inside the card. Blur destroys the sharp
  // edges of glyphs, so a band painting over the card shows up as a stripe of collapsed energy.
  // A hash comparison was tried first and rejected: adding a backdrop-filter layer flips the text
  // above it from subpixel to grayscale antialiasing, so the pixels differ even when nothing is
  // wrong. Sharpness is the property the bug is actually about.
  const MEASURE = (shotB64, card, band) => `(async () => {
    const img = new Image();
    img.src = "data:image/png;base64," + ${JSON.stringify(shotB64)};
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    const card = ${JSON.stringify(card)}, band = ${JSON.stringify(band)};
    const x0 = card.left + 10, x1 = card.right - 10;
    const d = document.createElement("canvas").getContext("2d");
    const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    const rowEnergy = (y) => {
      let sum = 0;
      for (let x = x0; x < x1 - 1; x++) {
        const i = (y * cv.width + x) * 4, j = i + 4;
        const a = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
        const b = 0.299*px[j] + 0.587*px[j+1] + 0.114*px[j+2];
        sum += Math.abs(a - b);
      }
      return sum / (x1 - x0);
    };
    const mean = (lo, hi) => { let t = 0, n = 0; for (let y = lo; y < hi; y++) { t += rowEnergy(y); n++; } return n ? t / n : 0; };
    // The band's blur ramps in, so measure its fully-blurred bottom half against an equal slab of
    // the same text just above it.
    const h = Math.round((band.bottom - band.top) / 2);
    return { inBand: mean(band.bottom - h, band.bottom), above: mean(band.top - h, band.top) };
  })()`;

  const shotOf = async () => (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const bandRect = { top: geo.fade.top, bottom: geo.fade.bottom };

  // Force the band visible over the hero card, and measure with the fix in place.
  await evalIn(c, `(() => { document.querySelector('.transcript-fade').style.display = 'block'; return true; })()`);
  await sleep(350);
  const fixedShot = await shotOf();
  const fixed = await evalIn(c, MEASURE(fixedShot, geo.card, bandRect));
  const fixedRatio = fixed.inBand / fixed.above;

  // The mutant: drop the dock back to layer 0, exactly as it was before the fix. If this does NOT
  // collapse the ratio, the measurement above proves nothing.
  await evalIn(c, `(() => { document.querySelector('.composer-dock').style.zIndex = 'auto'; return true; })()`);
  await sleep(350);
  const brokenShot = await shotOf();
  const broken = await evalIn(c, MEASURE(brokenShot, geo.card, bandRect));
  const brokenRatio = broken.inBand / broken.above;

  check("the mutant reproduces the bug (dock back on layer 0 ⇒ the band blurs the card)",
    brokenRatio < 0.6, { brokenRatio: +brokenRatio.toFixed(3), ...broken });
  check("the prompter's text stays as sharp inside the band as above it",
    fixedRatio > 0.85, { fixedRatio: +fixedRatio.toFixed(3), ...fixed });

  for (const [tag, data] of [["fixed", fixedShot], ["broken", brokenShot]]) {
    const out = path.join(os.tmpdir(), `realm-prompter-fade-${tag}.png`);
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${out}`);
  }

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
