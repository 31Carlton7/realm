/**
 * Live check for the session pane's drop highlight (run with: node apps/desktop/scripts/session-drop-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and answers the two questions jsdom cannot, because
 * both are about compositing: does the glow actually PAINT, and does it stay off the prompter?
 *
 * The second is the one with history. `.transcript-fade`'s blur band once cut a stripe straight
 * across the hero card because an ancestor `transform` trapped the dock's z-index (see
 * prompter-fade-live.mjs). The drop glow is another blurring layer inside the same pane, so it is
 * the same bug waiting to be rewritten — it sits on layer 1, under the dock's 2, and this is what
 * holds it there.
 *
 * How it is proven: the same sharpness measure that check uses. Blur destroys the edges of glyphs,
 * so the mean horizontal gradient energy inside the card is the property the bug is about. Measured
 * three times — with the glow up, with it hidden, and with it forced ABOVE the dock. The third is a
 * mutant that must collapse, or the first two prove nothing.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9346), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8913);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-drop-live-"));
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
  /** A DataTransfer shaped like a Finder drag: its type list carries "Files", which is the
   *  discriminator the pane gates on. */
  fileDrag() {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "dropped.png", { type: "image/png" }));
    return dt;
  },
  /** Hold a file drag OVER an element without letting go of it. */
  dragOver(sel, dt = __live.fileDrag()) {
    const el = document.querySelector(sel);
    for (const type of ["dragenter", "dragover"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return dt;
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

/** Enough lines that the card is tall and full of glyph edges — the sharpness measure needs text to
 *  destroy before it can report that nothing destroyed it. */
const DRAFT = Array.from({ length: 9 }, (_, i) =>
  `Line ${i + 1}: the prompter's text must stay sharp under the drop highlight, with no blur washing across the card.`).join("\n");

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
  globalThis.__c = c;
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

  // A modest pane, so the card takes a real share of it and sits well inside the glow's masked ramp.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await evalIn(c, `(() => { __live.setInput(document.querySelector('.composer-input'), ${JSON.stringify(DRAFT)}); return true; })()`);
  await sleep(500); // the 320ms dock transition, plus a frame to settle

  check("nothing is drawn before a file is dragged in", await evalIn(c, `!document.querySelector('.session-drop')`));

  await evalIn(c, `__live.dragOver('.transcript')`);
  await sleep(300);

  const geo = await evalIn(c, `(() => {
    const g = document.querySelector('.session-drop');
    if (!g) return null;
    const pane = document.querySelector('.session-pane').getBoundingClientRect();
    const b = g.getBoundingClientRect();
    const card = document.querySelector('.composer').getBoundingClientRect();
    const cs = getComputedStyle(g), soft = getComputedStyle(g, '::before');
    return {
      inset: { l: Math.round(b.left - pane.left), t: Math.round(b.top - pane.top),
               r: Math.round(pane.right - b.right), b: Math.round(pane.bottom - b.bottom) },
      size: { w: Math.round(b.width), h: Math.round(b.height) },
      pointer: cs.pointerEvents, zIndex: cs.zIndex,
      ring: cs.boxShadow.includes("inset"), blur: soft.backdropFilter,
      overlapsCard: b.top < card.bottom && b.bottom > card.top && b.left < card.right && b.right > card.left,
      card: { x: Math.round(card.x), y: Math.round(card.y), width: Math.round(card.width), height: Math.round(card.height) },
    };
  })()`);
  check("a file dragged onto the transcript lights the whole pane", geo !== null && geo.size.w > 0 && geo.size.h > 0, geo?.size);
  // Inset on all four sides: flush, a split pane's ring would run straight into its neighbour's.
  check("the glow is inset from the pane edge, not flush to it",
    geo && [geo.inset.l, geo.inset.t, geo.inset.r, geo.inset.b].every((v) => v === 6), geo?.inset);
  check("it is an inset ring with a real backdrop blur behind it",
    geo?.ring === true && String(geo?.blur).startsWith("blur("), { ring: geo?.ring, blur: geo?.blur });
  // It advertises the drop; it must never be the thing that swallows it.
  check("it does not take pointer events", geo?.pointer === "none", { pointerEvents: geo?.pointer });
  // If its box did not reach the card there would be nothing for the measure below to be about.
  check("the glow's box covers the prompter (so the measure below means something)", geo?.overlapsCard === true);

  /* Mean horizontal gradient energy inside the card. Blur destroys the sharp edges of glyphs, so a
     layer painting over the card shows up as collapsed energy. A pixel hash was rejected for this
     in prompter-fade-live: adding a backdrop-filter flips text above it from subpixel to grayscale
     antialiasing, so the bytes differ even when nothing is wrong. Sharpness is the real property. */
  const MEASURE = (shotB64, card) => `(async () => {
    const img = new Image();
    img.src = "data:image/png;base64," + ${JSON.stringify(shotB64)};
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    const card = ${JSON.stringify(card)};
    const x0 = 10, x1 = card.width - 10;
    let total = 0, rows = 0;
    for (let y = 10; y < card.height - 10; y++) {
      let sum = 0;
      for (let x = x0; x < x1 - 1; x++) {
        const i = (y * cv.width + x) * 4, j = i + 4;
        const a = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
        const b = 0.299*px[j] + 0.587*px[j+1] + 0.114*px[j+2];
        sum += Math.abs(a - b);
      }
      total += sum / (x1 - x0); rows++;
    }
    return total / rows;
  })()`;

  const cardClip = geo.card;
  const energy = async () => evalIn(c, MEASURE((await shot(c, cardClip)).data, cardClip));
  const lit = await energy();

  /* The glow is genuinely painting: a corner of the pane, away from the card, must change when it is
     taken away. Without this the sharpness numbers could all be readings of an invisible element. */
  const corner = await evalIn(c, `(() => { const b = document.querySelector('.session-pane').getBoundingClientRect();
    return { x: Math.round(b.x + 12), y: Math.round(b.y + 12), width: 160, height: 90 }; })()`);
  const cornerLit = await shot(c, corner);
  await evalIn(c, `(() => { document.querySelector('.session-drop').style.opacity = '0'; return true; })()`);
  await sleep(250);
  const cornerDark = await shot(c, corner);
  const bare = await energy();
  await evalIn(c, `(() => { document.querySelector('.session-drop').style.opacity = ''; return true; })()`);
  await sleep(250);
  check("the glow actually paints — the pane's corner changes when it is taken away",
    cornerLit.hash !== cornerDark.hash, { lit: cornerLit.hash, dark: cornerDark.hash });

  /* The mutant: raise the glow above the dock, which is exactly the layering the fade band once had.
     If this does NOT collapse the card's sharpness then the ratio below proves nothing. */
  await evalIn(c, `(() => { document.querySelector('.session-drop').style.zIndex = '3'; return true; })()`);
  await sleep(300);
  const over = await energy();
  await evalIn(c, `(() => { document.querySelector('.session-drop').style.zIndex = ''; return true; })()`);
  await sleep(250);

  const litRatio = lit / bare, overRatio = over / bare;
  check("the mutant reproduces the bug (glow above the dock ⇒ the card is washed out)",
    overRatio < 0.9, { overRatio: +overRatio.toFixed(3), over: +over.toFixed(2), bare: +bare.toFixed(2) });
  check("the prompter stays exactly as sharp with the highlight up as without it",
    litRatio > 0.99 && litRatio < 1.01, { litRatio: +litRatio.toFixed(4) });

  const full = await c.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "realm-session-drop-live.png");
  fs.writeFileSync(shotPath, Buffer.from(full.data, "base64"));
  console.log("SCREENSHOT " + shotPath);

  // End to end, through the pane rather than the card: the file really is attached.
  await evalIn(c, `(() => {
    const dt = __live.fileDrag();
    __live.dragOver('.transcript', dt);
    document.querySelector('.transcript').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true; })()`);
  const attached = await until(() => evalIn(c, `document.querySelectorAll('.attach-tile').length`), 15000, "the dropped file");
  check("dropping on the transcript attaches the file to this session", attached === 1, { tiles: attached });
  check("and the highlight goes out with the drop", await evalIn(c, `!document.querySelector('.session-drop')`));

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
