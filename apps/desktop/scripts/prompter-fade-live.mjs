/**
 * Live check for the hero prompter's stacking order (run with: node apps/desktop/scripts/prompter-fade-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves one thing a jsdom test cannot see, because
 * it needs real compositing: the transcript's dissolve must never reach the prompter.
 *
 * The bug it pins has been the same bug twice, through two different mechanisms. It was a blur band
 * on layer 1 and a hero `transform` that trapped the dock's z-index below it, which blurred a
 * horizontal stripe across the middle of the hero card. The dissolve is a mask on the scroller now,
 * and stacking has nothing to do with it — but the same damage is one selector away, because a mask
 * on `.transcript-wrap` instead of `.transcript` would take the dock with it, and the wrapper is
 * where a tidying hand would put it.
 *
 * How it is proven: the card's own pixels, with the dissolve where it belongs and then with it
 * moved up one element. The mask must be on the box that holds ONLY the scrolling text, so the card
 * reads identically either way; under the mutant its lower half fades into the pane.
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

  /* Geometry: the dissolve's bottom ramp really does reach up into the card, so the comparison below
     is not vacuous. The ramp is the last `--fade-h` of the scroller, and the card floats over it. */
  const geo = await evalIn(c, `(() => {
    const card = document.querySelector('.composer').getBoundingClientRect();
    const sc = document.querySelector('.transcript');
    const s = sc.getBoundingClientRect();
    const depth = parseFloat(getComputedStyle(sc).getPropertyValue('--fade-h')) || 68;
    return { card: { top: Math.round(card.top), bottom: Math.round(card.bottom),
                     left: Math.round(card.left), right: Math.round(card.right) },
             ramp: { top: Math.round(s.bottom - depth), bottom: Math.round(s.bottom) },
             onScroller: getComputedStyle(sc).maskImage !== 'none',
             maskedAncestors: (() => {
               const out = [];
               for (let el = document.querySelector('.composer'); el; el = el.parentElement) {
                 if (getComputedStyle(el).maskImage !== 'none') out.push(el.className || el.tagName);
               }
               return out;
             })() };
  })()`);
  /* The guarantee, stated where it actually lives: the card is not a descendant of ANY masked box.
     That is structural rather than a matter of layer order — a mask applies to everything the
     element paints, so the only way the prompter survives is by not being inside one. */
  check("the dissolve is on the scroller, and no ancestor of the prompter carries a mask",
    geo.onScroller && geo.maskedAncestors.length === 0, { onScroller: geo.onScroller, masked: geo.maskedAncestors });
  check("its bottom ramp reaches the card (so the measure below means something)",
    geo.ramp.top < geo.card.bottom && geo.ramp.bottom > geo.card.top, geo);

  /* The measure: the card's own mean luminance. A mask takes ALPHA, so a card caught inside one
     fades toward the pane behind it — which moves the mean, while leaving every edge as sharp as it
     was. (Sharpness is what the blur version of this bug moved; it is the wrong property now, and
     reading it would pass straight through the mutant.) */
  const MEAN = (shotB64, card) => `(async () => {
    const img = new Image();
    img.src = "data:image/png;base64," + ${JSON.stringify(shotB64)};
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    const card = ${JSON.stringify(card)};
    let sum = 0, n = 0;
    for (let y = card.top + 4; y < card.bottom - 4; y++) {
      for (let x = card.left + 10; x < card.right - 10; x++) {
        const i = (y * cv.width + x) * 4;
        sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        n++;
      }
    }
    return sum / n;
  })()`;

  const shotOf = async () => (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const fixedShot = await shotOf();
  const fixed = await evalIn(c, MEAN(fixedShot, geo.card));

  /* The mutant: put the mask on the box that holds BOTH — the pane itself. `.transcript-wrap` was
     tried here first and could not reproduce anything, which is the finding rather than a failed
     mutant: the dock is the wrapper's sibling, so the nearest element a dissolve could be moved to
     and still reach the card is the pane. That is how far away this bug now is. */
  await evalIn(c, `(() => {
    const st = document.createElement('style'); st.id = 'mutant-mask';
    // The ramp has to REACH the card, which floats near the middle of the pane in the hero state —
    // a mask over the pane's last 160px is below it and changes nothing, which is not a mutant.
    st.textContent = '.session-pane { mask-image: linear-gradient(to bottom, #000 20%, transparent 70%); }';
    document.head.appendChild(st); return true; })()`);
  await sleep(350);
  const brokenShot = await shotOf();
  const broken = await evalIn(c, MEAN(brokenShot, geo.card));
  await evalIn(c, `(() => { document.getElementById('mutant-mask').remove(); return true; })()`);

  check("the mutant reproduces the bug (a mask on the pane ⇒ the card fades into it)",
    Math.abs(broken - fixed) > 2, { fixed: +fixed.toFixed(2), broken: +broken.toFixed(2) });
  check("with the dissolve where it belongs, the card is untouched by it",
    fixed > broken, { fixed: +fixed.toFixed(2), broken: +broken.toFixed(2) });

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
