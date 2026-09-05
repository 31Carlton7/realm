/**
 * Live check for the prompter's squircle corners (run with: node apps/desktop/scripts/squircle-live.mjs)
 *
 * Boots the REAL built app on a scratch REALM_HOME and measures the shape of the corner that
 * actually reaches the screen. Nothing in the vitest suite can do this: jsdom has no layout, no
 * compositor and no CSS Painting API, so to it `background: paint(rl-squircle)` and
 * `border-radius: 20px` are the same declaration.
 *
 * The claim is geometric and falsifiable. Inside the R×R square at a card's corner, the fraction of
 * area the card's own fill covers is fixed by the curve:
 *   - a circular arc, which is all `border-radius` can draw   → π/4 ≈ 0.785
 *   - the superellipse |x/R|⁴ + |y/R|⁴ = 1 the worklet draws  → ≈ 0.874
 * The corner is therefore classified by COUNTING pixels rather than by reading one of them, and the
 * two answers are 11% of the corner square apart.
 *
 * Its mutant is the gate: strip `data-squircle` and the same measurement has to fall back to π/4,
 * because the stylesheet's fallback is a plain `border-radius`. If it does not, this is measuring
 * something other than the corner.
 *
 * It also pins the two regressions the technique invites, since a mask or a filter — the obvious
 * ways to get a superellipse — would have taken the card's box-shadow and its focus ring with it:
 *   - the lift still darkens the ground beside the card (mutated by setting box-shadow: none)
 *   - focus still draws a ring, and draws it ON the curve rather than as a box-shadow around the
 *     now-radius-0 box, which would square the corner off and send the fraction towards 1.0
 *
 * REBUILD FIRST (`pnpm build`): this boots apps/desktop/out, not the sources.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-squircle-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Area of a quadrant of |x|ⁿ + |y|ⁿ = 1 as a fraction of the unit square: n = 2 is the circle a
 *  border-radius draws, n = 4 the squircle the worklet draws. */
const CIRCLE = Math.PI / 4, SQUIRCLE = 0.874;
/** Half the gap between them. Anything nearer one than the other is that curve. */
const TOL = (SQUIRCLE - CIRCLE) / 2;

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

/** Sampling helpers, installed in the page once. They read a screenshot back through a canvas so the
 *  numbers come from what was COMPOSITED, not from what the CSSOM claims. */
const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  async sampler(b64) {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    const dpr = img.width / window.innerWidth;
    /* floor, not round: coordinates arrive as pixel CENTRES (x + 0.5), so rounding lands on the next
       pixel along and slides the whole sampling window one pixel inward on each axis. Over a corner
       square that is worth 2/R of its area — 10% at the prompter's radius, which is most of the gap
       between the two curves this script exists to tell apart. */
    const lum = (x, y) => {
      const i = ((Math.floor(y * dpr) * cv.width) + Math.floor(x * dpr)) * 4;
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    };
    const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
    /* Median, not mean: a reference tone read off a live card lands on a glyph or an icon sooner or
       later, and one stray dark pixel would drag a mean far enough to move the threshold. */
    const tone = (x0, y0, x1, y1) => {
      const xs = [];
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        xs.push(lum(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6));
      }
      return median(xs);
    };
    const band = (x0, y0, x1, y1) => {
      let total = 0, n = 0;
      for (let y = y0; y < y1; y += 0.5) for (let x = x0; x < x1; x += 0.5) { total += lum(x, y); n++; }
      return total / n;
    };
    return { lum, tone, band, dpr };
  },
  /** Fraction of an element's R×R corner square that the element's own fill covers. */
  async cornerFill(b64, sel, corner) {
    const s = await this.sampler(b64);
    const el = document.querySelector(sel);
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    /* Under the gate the radius is the painter's input; on the fallback it is border-radius. */
    const key = corner === "bl" ? "--sq-radius-bottom" : "--sq-radius-top";
    const fallback = corner === "bl" ? cs.borderBottomLeftRadius : cs.borderTopLeftRadius;
    const R = Math.round(parseFloat(cs.getPropertyValue(key)) || parseFloat(fallback) || 0);
    if (R < 8) return { error: "radius too small to measure", R };
    /* Reference tones sampled from THIS screenshot rather than from a token value, so the test holds
       in either mode and survives a repaint of the palette. */
    const inset = R + 8;
    const inside = s.tone(box.left + inset, box.top + inset, box.right - inset, box.bottom - inset);
    /* Diagonally outside the corner under test. For a bottom corner that is BELOW the element — read
       above it and the sample lands on whatever the element is tucked under, which for the
       under-strip is the prompter's own fill. */
    const gy = corner === "bl" ? box.bottom + 8 : box.top - 30;
    const outside = s.tone(box.left - 30, gy, box.left - 8, gy + 22);
    if (Math.abs(inside - outside) < 3) return { error: "fill and ground are indistinguishable", inside, outside };
    /* Midway between the two tones: the antialiased boundary pixels split evenly either side of it,
       which leaves the area estimate unbiased. */
    const mid = (inside + outside) / 2;
    const isFill = (x, y) => (inside > outside ? s.lum(x, y) > mid : s.lum(x, y) < mid);
    /* Anchored to the first device pixel the card actually touches — a laid-out box lands on a
       fractional coordinate often enough that taking box.left/top raw walks the window off by one. */
    const x0 = Math.floor(box.left);
    const y0 = Math.floor(corner === "bl" ? box.bottom - R : box.top);
    let filled = 0;
    for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) {
      if (isFill(x0 + dx + 0.5, y0 + dy + 0.5)) filled++;
    }
    return { fraction: +(filled / (R * R)).toFixed(3), R, inside: Math.round(inside), outside: Math.round(outside) };
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
const near = (v, target) => typeof v === "number" && Math.abs(v - target) < TOL;
const shotOf = async (c) => (await c.send("Page.captureScreenshot", { format: "png" })).data;

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

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
      LIVE_MAIN: mainEntry,
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  console.log("runtime:", await evalIn(c, `JSON.stringify({
    chromium: navigator.userAgent.match(/Chrome\\/[0-9.]+/)?.[0],
    cornerShape: CSS.supports("corner-shape", "squircle"),
  })`));

  check("the painter loaded in the real bundle, so the cards are off their fallback",
    await evalIn(c, `document.documentElement.hasAttribute("data-squircle")`));
  check("the prompter's fill is the worklet's, and its border-radius is out of the way",
    await evalIn(c, `(() => { const cs = getComputedStyle(document.querySelector(".composer"));
      return cs.backgroundImage.includes("paint(rl-squircle)") && parseFloat(cs.borderTopLeftRadius) === 0; })()`));

  // ── the lift the technique could have eaten ─────────────────────────────
  // A mask (the obvious way to get a superellipse) clips box-shadow away entirely. Painting the fill
  // instead leaves it, and the mutant here is the shadow itself: remove it and the same strip of
  // ground beside the card has to get lighter.
  const restShot = await shotOf(c);
  const leftOfCard = (b64) => `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const b = document.querySelector(".composer").getBoundingClientRect();
    return s.band(b.left - 6, b.top + 30, b.left - 1, b.bottom - 30);
  })()`;
  const lift = await evalIn(c, leftOfCard(restShot));
  // The lift is a `filter` on the card's ::before, not a box-shadow on the card — a box-shadow is
  // drawn from the border box and these surfaces have `border-radius: 0`, so it landed square behind
  // a rounded card. Suppressing the filter is therefore what removes the lift; mutating boxShadow
  // here would change nothing and this check would pass without testing anything.
  await evalIn(c, `(() => {
    const st = document.createElement("style");
    st.id = "kill-lift";
    st.textContent = ":root[data-squircle] .composer::before { filter: none !important; }";
    document.head.appendChild(st);
    return true;
  })()`);
  await sleep(250);
  const flat = await evalIn(c, leftOfCard(await shotOf(c)));
  check("the card still casts its lift — the ground beside it is darker than with the drop-shadow removed",
    lift < flat - 0.3, { withShadow: +lift.toFixed(2), withoutShadow: +flat.toFixed(2) });
  await evalIn(c, `(() => { document.querySelector(".composer").style.boxShadow = ""; return true; })()`);
  await sleep(250);

  // ── the focus ring the technique could also have eaten ───────────────────
  const topEdge = (b64) => `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const b = document.querySelector(".composer").getBoundingClientRect();
    return s.band(b.left + 60, b.top - 0.5, b.right - 60, b.top + 1.5);
  })()`;
  const edgeRest = await evalIn(c, topEdge(await shotOf(c)));
  const cornerRest = await evalIn(c, `__live.cornerFill(${JSON.stringify(restShot)}, ".composer", "tl")`);
  await evalIn(c, `(() => { document.querySelector(".composer-input").focus(); return true; })()`);
  await sleep(300);
  const focusShot = await shotOf(c);
  check("focus still brightens the card's edge — the ring survived moving into the painter",
    (await evalIn(c, topEdge(focusShot))) > edgeRest + 0.5,
    { rest: +edgeRest.toFixed(2), focused: +(await evalIn(c, topEdge(focusShot))).toFixed(2) });
  // The regression this catches: leave focus on a box-shadow and it rings the element's BOX, which
  // under the gate has border-radius 0 — the corner squares off and the fraction runs to 1.
  const cornerFocus = await evalIn(c, `__live.cornerFill(${JSON.stringify(focusShot)}, ".composer", "tl")`);
  check("the focus ring is drawn ON the curve — a box-shadow ring would square the corner off",
    cornerFocus.fraction < 0.96 && Math.abs(cornerFocus.fraction - cornerRest.fraction) < 0.03,
    { rest: cornerRest.fraction, focused: cornerFocus.fraction });
  await evalIn(c, `(() => { document.querySelector(".composer-input").blur(); return true; })()`);
  await sleep(300);

  // ── the corner itself ────────────────────────────────────────────────────
  /* The silhouette is the claim, so the edge stroke comes off first: a 0.5px ring lands precisely on
     the boundary pixels the count is deciding and brightens enough of them past the threshold to add
     ~0.04 to either curve. `--card-ring` is the single lever for it — the painter reads it as
     --sq-ring and --shadow-card composes it — so suppressing it drops the stroke from the worklet
     path and the fallback path symmetrically, leaving nothing but shape. */
  await evalIn(c, `(() => { document.documentElement.style.setProperty("--card-ring", "transparent"); return true; })()`);
  await sleep(250);
  const silhouette = await shotOf(c);
  const painted = await evalIn(c, `__live.cornerFill(${JSON.stringify(silhouette)}, ".composer", "tl")`);
  check(`the prompter's corner is a superellipse (${SQUIRCLE}), not a circular arc (${CIRCLE.toFixed(3)})`,
    near(painted.fraction, SQUIRCLE), painted);
  const stripOn = await evalIn(c, `__live.cornerFill(${JSON.stringify(silhouette)}, ".composer-understrip", "bl")`);

  // ── the mutant: without the gate the same measurement must find a circle ──
  await evalIn(c, `(() => { document.documentElement.removeAttribute("data-squircle"); return true; })()`);
  await sleep(300);
  const fallbackShot = await shotOf(c);
  const fallback = await evalIn(c, `__live.cornerFill(${JSON.stringify(fallbackShot)}, ".composer", "tl")`);
  check("the mutant reproduces the old corner (gate off ⇒ the fallback's circular arc)",
    near(fallback.fraction, CIRCLE), fallback);
  /* The under-strip's corner is 12px across a 5-level luminance step, which is too coarse to pin an
     absolute area against. Its gate-on/gate-off difference is not: the strip has to move the same
     way the prompter does, or the worklet is not shaping it. */
  const stripOff = await evalIn(c, `__live.cornerFill(${JSON.stringify(fallbackShot)}, ".composer-understrip", "bl")`);
  check("the under-strip's bottom corners are painted too — they fill more than the fallback's arc",
    stripOn.fraction > stripOff.fraction + 0.03, { gateOn: stripOn.fraction, gateOff: stripOff.fraction, R: stripOn.R });

  await evalIn(c, `(() => {
    document.documentElement.setAttribute("data-squircle", "");
    document.documentElement.style.removeProperty("--card-ring");
    return true; })()`);

  for (const [tag, data] of [["squircle", restShot], ["focused", focusShot], ["fallback", fallbackShot]]) {
    const out = path.join(os.tmpdir(), `realm-squircle-${tag}.png`);
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
