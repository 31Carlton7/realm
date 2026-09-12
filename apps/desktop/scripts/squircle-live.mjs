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
 *   - the superellipse |x/R|⁴ + |y/R|⁴ = 1 the worklet draws  → ≈ 0.927
 * The corner is therefore classified by COUNTING pixels rather than by reading one of them, and the
 * two answers are 14% of the corner square apart.
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
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9338), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8904);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-squircle-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Area of a quadrant of |x|ⁿ + |y|ⁿ = 1 as a fraction of the unit square: ∫₀¹(1-xⁿ)^(1/n)dx, which
 *  is Γ(1+1/n)²/Γ(1+2/n). n = 2 is the circle a border-radius draws, n = 4 the squircle the worklet
 *  draws. The 0.874 that stood here was a MEASUREMENT, and a biased one: the corner square used to be
 *  anchored by flooring the element's rect, which lands a pixel off whenever layout puts the box on a
 *  fractional coordinate and costs about 0.05 of the area. cornerFill walks to the edge now, and both
 *  readings came back onto their geometry — the fallback to π/4 within a thousandth. */
const CIRCLE = Math.PI / 4, SQUIRCLE = 0.927;
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
    /* The fill is read from a band hugging the EDGE being measured, past the corner and inside the
       padding, rather than from the middle of the element. The middle only works on something big
       and empty: a 56px attachment tile is narrower than the R + 8 inset that rect used to take, so
       the sample inverted and tone returned a median of nothing, and a one-line bubble is mostly
       glyphs, so the median came back as ink and the fill/ground comparison ran backwards. */
    const bx0 = box.left + R + 2, bx1 = Math.min(box.right - 2, box.left + 3 * R);
    const by = corner === "bl" ? box.bottom - 4.5 : box.top + 1.5;
    const inside = s.tone(bx0, by, Math.max(bx1, bx0 + 4), by + 3);
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
    /* Anchored to the first device pixel the card actually touches, found by walking IN from the
       ground rather than by rounding box.left. A laid-out box lands on a fractional coordinate often
       enough — and a one-pixel border added anywhere above the element moves it — that flooring the
       rect puts the R×R square one pixel off the shape and takes ~0.05 off the area. That much is
       the whole distance between a superellipse and a circle, so the reading has to come from the
       edge itself. The walks run along the corner square's INNER edges, where every shape is flush
       against the box, and they come from outside so that a strip or a line of text inside the
       element cannot be mistaken for the boundary. */
    const near = corner === "bl" ? box.bottom - R + 0.5 : box.top + R - 0.5;
    let x0 = Math.round(box.left);
    for (let v = Math.round(box.left) - 4; v <= box.left + R; v++) { if (isFill(v + 0.5, near)) { x0 = v; break; } }
    let edgeY = corner === "bl" ? Math.round(box.bottom) : Math.round(box.top);
    if (corner === "bl") {
      for (let v = Math.round(box.bottom) + 4; v >= box.bottom - R; v--) { if (isFill(box.left + R - 0.5, v + 0.5)) { edgeY = v; break; } }
    } else {
      for (let v = Math.round(box.top) - 4; v <= box.top + R; v++) { if (isFill(box.left + R - 0.5, v + 0.5)) { edgeY = v; break; } }
    }
    const y0 = corner === "bl" ? edgeY - R + 1 : edgeY;
    let filled = 0;
    for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) {
      if (isFill(x0 + dx + 0.5, y0 + dy + 0.5)) filled++;
    }
    return { fraction: +(filled / (R * R)).toFixed(3), R, inside: Math.round(inside), outside: Math.round(outside) };
  },
};
void 0`;

/** The server's own RPC socket. The fake agent has to be selected over the wire, and a sent message
 *  is what puts a user bubble on screen to measure. */
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
      REALM_ENABLE_FAKE_AGENT: "1", // the sent message the bubble check measures has to come from somewhere
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
  // Put the lift back. It is the style element that suppressed it, so it is the style element that
  // has to go — clearing an inline boxShadow here restores nothing (see above) and would leave every
  // measurement below reading a card with no lift, including one compared against a shot taken with
  // the lift still on.
  await evalIn(c, `(() => { document.getElementById("kill-lift")?.remove(); return true; })()`);
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

  /* ── the sent message wears the same curve, one rung down ────────────────
     Measured as a DIFFERENCE rather than against an absolute area, like the under-strip above: at
     20px the corner is small enough that a fixed fraction would be pinning antialiasing as much as
     shape, but a bubble that fills more of its corner with the gate on than with it off can only be
     the worklet doing it. */
  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const sessions = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15000, "a session");
  await api.call("sessions.setAgent", { id: sessions[0].id, agentKind: "fake" });
  await api.call("sessions.send", { id: sessions[0].id, text: "a sent message, to measure the corner of", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.msg-user')`), 20000, "a user bubble");
  await sleep(400);
  // Both shots are taken AFTER the bubble exists. The mutant's own `fallbackShot` above predates the
  // send, so measuring the corner in it samples the pane's ground twice and reports no boundary at
  // all — which is a failing check about nothing rather than about the shape.
  const bubbleOffShot = await shotOf(c); // the gate is still off from the mutant above
  const bubbleOff = await evalIn(c, `__live.cornerFill(${JSON.stringify(bubbleOffShot)}, ".msg-user", "tl")`);
  await evalIn(c, `(() => { document.documentElement.setAttribute("data-squircle", ""); return true; })()`);
  await sleep(350);
  const bubbleOnShot = await shotOf(c);
  const bubbleOn = await evalIn(c, `__live.cornerFill(${JSON.stringify(bubbleOnShot)}, ".msg-user", "tl")`);
  check("the sent message's corner is painted too — it fills more than the fallback's arc",
    !bubbleOn.error && !bubbleOff.error && bubbleOn.fraction > bubbleOff.fraction + 0.03,
    { gateOn: bubbleOn.fraction ?? bubbleOn, gateOff: bubbleOff.fraction ?? bubbleOff, R: bubbleOn.R });

  /* ── an uploaded file's tile ─────────────────────────────────────────────
     The well the thumbnail sits in is painted like everything else, and it carries a trap the other
     surfaces do not: under the painter `border-radius` is 0, so the `overflow: hidden` that keeps a
     picture inside the tile would clip it to a SQUARE over a painted curve. The well therefore also
     wears a `clip-path` cut from the same superellipse, and this measures the result rather than the
     mechanism — a `.txt` has no thumbnail, so what is in the corner is the well's own flat fill. */
  const note = path.join(scratch, "attachment.txt");
  fs.writeFileSync(note, "a file to look at the corner of\n");
  await api.call("sessions.send", { id: sessions[0].id, text: "with a file",
    attachments: [{ path: note, mime: "text/plain", name: "attachment.txt", size: 32 }], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector('.msg-user-files .attach-art')`), 20000, "an attachment tile");
  await sleep(500);
  /* The well is `--field` on the pane's ground and the two are about one luminance step apart, which
     is under this measurement's floor — so the fill is forced white for the shot. That changes the
     colour and nothing else: the silhouette still comes from the same painter with the same radius,
     and the gate-off leg gets the same treatment through `background` because an unpainted tile does
     not read `--sq-fill`. */
  /* One property at a time rather than cssText: the clip the component sets is an inline custom
     property too, and wiping the whole attribute takes it with it. The children go as well — a 56px
     well has room for the corner or for the icon and the type badge, not for both plus a reading of
     the flat fill between them. */
  const paintTile = (prop, value) => `(() => { const el = document.querySelector('.msg-user-files .attach-art');
    ${value ? `el.style.setProperty("${prop}", "${value}")` : `el.style.removeProperty("${prop}")`};
    for (const kid of el.children) kid.style.visibility = ${value ? `"hidden"` : `""`};
    return true; })()`;
  await evalIn(c, paintTile("--sq-fill", "#ffffff"));
  await sleep(250);
  const tileOn = await evalIn(c, `__live.cornerFill(${JSON.stringify(await shotOf(c))}, ".msg-user-files .attach-art", "tl")`);
  await evalIn(c, `(() => { document.documentElement.removeAttribute("data-squircle"); return true; })()`);
  await evalIn(c, paintTile("background", "#ffffff"));
  await sleep(300);
  const tileOff = await evalIn(c, `__live.cornerFill(${JSON.stringify(await shotOf(c))}, ".msg-user-files .attach-art", "tl")`);
  await evalIn(c, `(() => { document.documentElement.setAttribute("data-squircle", ""); return true; })()`);
  await evalIn(c, paintTile("--sq-fill"));
  await evalIn(c, paintTile("background"));
  await sleep(250);
  check("an uploaded file's tile is painted too, and its clip follows the same curve",
    !tileOn.error && !tileOff.error && tileOn.fraction > tileOff.fraction + 0.05 && tileOff.fraction < CIRCLE + TOL,
    { gateOn: tileOn.fraction ?? tileOn, gateOff: tileOff.fraction ?? tileOff, R: tileOn.R });
  /* And the clip is the trap: without it `overflow: hidden` cuts the badge and any thumbnail to a
     square over the painted curve, which shows up as the tile's own corner reappearing as a right
     angle in the ink. Read the mechanism here — the pixel above cannot separate the two layers. */
  const tileClip = await evalIn(c, `(() => {
    const cs = getComputedStyle(document.querySelector('.msg-user-files .attach-art'));
    return { clip: cs.clipPath.slice(0, 24), radius: cs.borderTopLeftRadius, overflow: cs.overflow };
  })()`);
  check("and the well clips to that curve rather than to its (now zero) border-radius",
    tileClip.clip.startsWith("path(") && parseFloat(tileClip.radius) === 0, tileClip);
  api.close();

  await evalIn(c, `(() => {
    document.documentElement.setAttribute("data-squircle", "");
    document.documentElement.style.removeProperty("--card-ring");
    return true; })()`);

  /* ── the CONTROL corner: a flatter superellipse than the surfaces wear ───
     `--sq-ratio-ctl` is 0.48 and a radius may not pass half the short side, so a 30px button spends
     96% of the room it has — the squareness "the buttons are still slightly too square" was
     describing is the CURVE's, not the number's, and the lever is the exponent. That claim is
     geometric and this is the only place it can be checked: jsdom sees a custom property, not a path.

     Two probes rather than a button off the pane: the exponent is a property of the painter, and a
     synthetic pair pins it without depending on which controls a given view happens to show. The
     wiring — that a real `.btn` reaches the painter with the control exponent rather than the
     surfaces' 4 — is the line after them. Measured as a DIFFERENCE, the way the under-strip and the
     bubble are: antialiasing biases both counts the same way and cancels. */
  const probeSetup = `(() => {
    const n = getComputedStyle(document.documentElement).getPropertyValue("--sq-n-ctl").trim();
    const make = (id, top, exponent) => {
      document.getElementById(id)?.remove();
      const d = document.createElement("div");
      d.id = id;
      d.style.cssText = "position:fixed;left:120px;top:" + top + "px;width:160px;height:30px;z-index:9999;"
        + "border-radius:0;background:paint(rl-squircle);--sq-radius-top:14.4px;--sq-radius-bottom:14.4px;"
        + "--sq-fill:#ffffff;--sq-n:" + exponent + ";";
      document.body.appendChild(d);
    };
    make("sq-probe-surface", 200, "4");
    make("sq-probe-control", 260, n);
    document.getElementById("sq-probe-btn")?.remove();
    const b = document.createElement("button");
    b.className = "btn"; b.id = "sq-probe-btn"; b.textContent = "probe";
    // Wide, so the fill can be sampled clear of both the corner and the centred label.
    b.style.cssText = "position:fixed;left:120px;top:320px;width:200px;z-index:9999;";
    document.body.appendChild(b);
    return { n, btn: getComputedStyle(b).getPropertyValue("--sq-n").trim() };
  })()`;
  const probes = await evalIn(c, probeSetup);
  await sleep(300);
  const probeShot = await shotOf(c);
  const surfaceCorner = await evalIn(c, `__live.cornerFill(${JSON.stringify(probeShot)}, "#sq-probe-surface", "tl")`);
  const controlCorner = await evalIn(c, `__live.cornerFill(${JSON.stringify(probeShot)}, "#sq-probe-control", "tl")`);
  check("the painter honours --sq-n: the control exponent rounds the corner off more than the surfaces' 4",
    !surfaceCorner.error && !controlCorner.error
      && controlCorner.fraction < surfaceCorner.fraction - 0.02
      && controlCorner.fraction > CIRCLE + 0.02,
    { atFour: surfaceCorner.fraction ?? surfaceCorner, atControl: controlCorner.fraction ?? controlCorner, circle: +CIRCLE.toFixed(3), n: probes.n });
  check("a real .btn reaches the painter with the control exponent, not the surfaces'",
    probes.btn === probes.n, probes);

  /* ── the painted fill ANIMATES ───────────────────────────────────────────
     Under the gate a control's `background` is `paint(rl-squircle)`, which does not interpolate — so
     §6's `background-color` hover transition animated a property that never changed and every
     painted fill snapped while its unpainted neighbours faded. The fix transitions `--sq-fill`,
     which works only because theme/squircle.ts registers it `<color>`; an unregistered custom
     property computes to a token stream, and token streams do not interpolate.

     Stretched to four seconds and sampled in the middle, so the window is a second wide rather than
     a frame. Its mutant is the same button with `--sq-fill` struck from the transition list: the
     sample then has to be AT the destination, because nothing is tweening. */
  const fillProbe = (transitionProps, ms) => `(() => {
    const b = document.getElementById("sq-probe-btn");
    b.style.transitionProperty = "${transitionProps}";
    b.style.transitionDuration = "${ms}ms";
    b.style.transitionTimingFunction = "linear";
    b.style.setProperty("--fill", "#ffffff");
    return true;
  })()`;
  const probeTone = async (b64) => evalIn(c, `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const b = document.getElementById("sq-probe-btn").getBoundingClientRect();
    return s.tone(b.left + 22, b.top + 5, b.left + 52, b.bottom - 5);
  })()`);
  const resetFill = `(() => { const b = document.getElementById("sq-probe-btn");
    b.style.removeProperty("--fill"); b.style.transitionProperty = "none"; return true; })()`;
  await evalIn(c, resetFill);
  await sleep(200);
  const fillRest = await probeTone(await shotOf(c));
  await evalIn(c, fillProbe("--sq-fill", 4000));
  await sleep(2000);
  const fillMid = await probeTone(await shotOf(c));
  await sleep(2600);
  const fillEnd = await probeTone(await shotOf(c));
  check("a painted control's fill FADES — --sq-fill interpolates and the worklet repaints as it does",
    fillMid > fillRest + 8 && fillMid < fillEnd - 8,
    { rest: Math.round(fillRest), mid: Math.round(fillMid), end: Math.round(fillEnd) });
  await evalIn(c, resetFill);
  await sleep(200);
  await evalIn(c, fillProbe("background-color, color, transform", 4000));
  await sleep(2000);
  const snapMid = await probeTone(await shotOf(c));
  check("the mutant snaps: with --sq-fill off the list, `background-color` has nothing to animate",
    Math.abs(snapMid - fillEnd) < 8, { mid: Math.round(snapMid), end: Math.round(fillEnd) });
  await evalIn(c, `(() => { for (const id of ["sq-probe-surface", "sq-probe-control", "sq-probe-btn"]) document.getElementById(id)?.remove(); return true; })()`);

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
