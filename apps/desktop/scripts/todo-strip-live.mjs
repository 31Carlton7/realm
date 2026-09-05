/**
 * Live check for the to-do strip above the prompter
 * (run with: node apps/desktop/scripts/todo-strip-live.mjs)
 *
 * The claim the strip exists to make is that it and the prompter read as ONE object. That is a
 * statement about composited pixels and about boxes, and jsdom has neither: every rect there is
 * zero, `background: paint(rl-squircle)` and `border-radius: 36px` are the same declaration, and a
 * strip painted straight over by the transcript's blur band measures exactly like one that is not.
 * So the suite pins the wiring (which list, when it collapses, where in the tree it sits) and this
 * pins the four things only a screenshot can answer:
 *
 *   - It is the under-strip's tab, mirrored: the same inset each side, on the card's centre line.
 *     Read off the laid-out boxes, because a margin that computes is not a margin that centres.
 *   - Its top corner is the painter's superellipse at the card's own radius, and its BOTTOM corners
 *     are square — both by counting pixels, exactly as squircle-live.mjs does. The bottom pair only
 *     exists 10px behind the card, so it is lifted clear to be measured and put back.
 *   - Nothing paints over it. `.composer-dock` carries a transform, which makes it a stacking
 *     context; the last time that mattered, `.composer`'s own z-index was trapped inside and the
 *     transcript's fade band blurred a stripe across the prompter (see prompter-fade-live.mjs). The
 *     strip is the new top edge of that dock and is the part the band now reaches first.
 *   - It does not shove the prompter. Items arriving grow the strip UPWARD into the transcript and
 *     stop at its cap; the card's own box must not move by a pixel while that happens.
 *
 * Driven end to end through the real path — the fake agent's `todos` script writes a real TodoWrite,
 * the server persists it, the store folds it, React draws the strip. Nothing here injects the strip.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9351), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8918);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-todo-strip-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Area of a quadrant of |x|ⁿ + |y|ⁿ = 1 as a fraction of the unit square — the same two curves
 *  squircle-live.mjs tells apart: n = 2 is the arc a border-radius draws, n = 4 the worklet's. */
const CIRCLE = Math.PI / 4, SQUIRCLE = 0.874;
const TOL = (SQUIRCLE - CIRCLE) / 2;
const near = (v, target) => typeof v === "number" && Math.abs(v - target) < TOL;

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
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  box(el) { const b = el.getBoundingClientRect(); return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; },
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
    /* floor, not round: coordinates arrive as pixel CENTRES, so rounding slides the sampling window
       one pixel inward on each axis — worth most of the gap between the two curves at this radius. */
    const lum = (x, y) => {
      const i = ((Math.floor(y * dpr) * cv.width) + Math.floor(x * dpr)) * 4;
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    };
    const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
    /* Median, not mean: a reference tone read off a live surface lands on a glyph sooner or later,
       and one stray dark pixel drags a mean far enough to move the threshold. */
    const tone = (x0, y0, x1, y1) => {
      const xs = [];
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) xs.push(lum(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6));
      return median(xs);
    };
    return { lum, tone, dpr };
  },
  /** Fraction of an element's R×R corner square that the element's own fill covers. */
  async cornerFill(b64, sel, corner, forceR) {
    const s = await this.sampler(b64);
    const el = document.querySelector(sel);
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const key = corner === "bl" ? "--sq-radius-bottom" : "--sq-radius-top";
    const fallback = corner === "bl" ? cs.borderBottomLeftRadius : cs.borderTopLeftRadius;
    /* A corner asserted to be SQUARE has no radius to read, so the window it is measured over has to
       be handed in — otherwise the one case worth checking is the one that cannot be. */
    const R = forceR ?? Math.round(parseFloat(cs.getPropertyValue(key)) || parseFloat(fallback) || 0);
    if (R < 8) return { error: "radius too small to measure", R };
    const inset = R + 8;
    const inside = s.tone(box.left + inset, box.top + inset, box.right - inset, box.top + inset + 10);
    const gy = corner === "bl" ? box.bottom + 8 : box.top - 30;
    const outside = s.tone(box.left - 30, gy, box.left - 8, gy + 22);
    if (Math.abs(inside - outside) < 3) return { error: "fill and ground are indistinguishable", inside, outside };
    const mid = (inside + outside) / 2;
    const isFill = (x, y) => (inside > outside ? s.lum(x, y) > mid : s.lum(x, y) < mid);
    const x0 = Math.floor(box.left);
    const y0 = Math.floor(corner === "bl" ? box.bottom - R : box.top);
    let filled = 0;
    for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) if (isFill(x0 + dx + 0.5, y0 + dy + 0.5)) filled++;
    return { fraction: +(filled / (R * R)).toFixed(3), R, inside: Math.round(inside), outside: Math.round(outside) };
  },
  /* Every screenshot comparison below is of a surface carrying a live shimmer (the in-flight item's
     label). Frozen, or no two frames of it are ever identical and the stacking check can only fail. */
  /** How much two captures of the SAME clip differ: the share of pixels moving further than tol on
   *  any channel, and the largest single move. This used to be a sha256 of the two shots, which
   *  stopped being able to answer the question when the decorative grain landed — it redraws itself
   *  between frames whether or not anything else changed, and freeze cannot stop it, because it is
   *  not a CSS animation. Two shots of an untouched surface are never identical any more, so an
   *  exact hash reports a z-order inversion and a repaint as the same thing. */
  async diff(a64, b64, tol) {
    const load = async (b) => {
      const im = new Image();
      im.src = "data:image/png;base64," + b;
      await im.decode();
      const cv = document.createElement("canvas");
      cv.width = im.width; cv.height = im.height;
      const g = cv.getContext("2d", { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      return { d: g.getImageData(0, 0, cv.width, cv.height).data, w: im.width, h: im.height };
    };
    const A = await load(a64), B = await load(b64);
    if (A.w !== B.w || A.h !== B.h) return { sizeMismatch: [A.w, A.h, B.w, B.h] };
    let changed = 0, worst = 0;
    for (let i = 0; i < A.d.length; i += 4) {
      const m = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]));
      if (m > worst) worst = m;
      if (m > tol) changed += 1;
    }
    return { fraction: +(changed / (A.d.length / 4)).toFixed(4), worst, pixels: A.d.length / 4 };
  },
  freeze(on) {
    let el = document.getElementById("live-freeze");
    if (!on) { el?.remove(); return true; }
    el = el ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: "live-freeze" }));
    el.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    return true;
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
const shotOf = async (c) => (await c.send("Page.captureScreenshot", { format: "png" })).data;
/** Only the pair's own rectangle, so a change anywhere else in the pane cannot decide the answer. */
const clipOf = async (c) => {
  /* Strictly the pair's INTERIOR: inset past the rounded corner columns at both ends, because the
     ground showing through those curves is ground the fade is entitled to blur. Include it and the
     comparison fails on the band doing its job. */
  const clip = await evalIn(c, `(() => {
    const a = document.querySelector(".composer-todos").getBoundingClientRect();
    const b = document.querySelector(".composer").getBoundingClientRect();
    const R = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--r-squircle"))) || 36;
    return { x: Math.floor(a.left) + R, y: Math.floor(a.top) + 2, width: Math.ceil(b.right - a.left) - 2 * R, height: Math.ceil(b.bottom - a.top) - 4, scale: 1 };
  })()`);
  return (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
};

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
      REALM_ENABLE_FAKE_AGENT: "1",
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  check("the painter loaded in the real bundle, so the surfaces are off their fallback",
    await evalIn(c, `document.documentElement.hasAttribute("data-squircle")`));

  // ── a session with nothing to read draws no strip at all ────────────────
  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session to drive");
  const session = sessions[0];
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  await sleep(400);
  check("an empty session has no strip in the tree — nothing to pin costs no height",
    (await evalIn(c, `!document.querySelector(".composer-todos")`)));

  // ── the real path: the fake agent writes a real TodoWrite ───────────────
  await api.call("sessions.send", { id: session.id, text: "write some todos", attachments: [], mentions: [] });
  await until(() => evalIn(c, `!!document.querySelector(".composer-todos")`), 20000, "the strip");
  await sleep(700);
  const restCard = await evalIn(c, `__live.box(document.querySelector(".composer"))`);
  check("the strip arrived from a persisted TodoWrite, open, with the agent's own words for the live step",
    await evalIn(c, `(() => { const s = document.querySelector(".composer-todos");
      return s.hasAttribute("data-open") && s.querySelector(".todo-active")?.textContent === "Drawing it as a plan"
        && s.querySelectorAll(".todo-list li").length === 3; })()`));

  // ── one object: same width, and no ground anywhere down the shared side ──
  const boxes = await evalIn(c, `({ strip: __live.box(document.querySelector(".composer-todos")),
    card: __live.box(document.querySelector(".composer")), under: __live.box(document.querySelector(".composer-understrip")) })`);
  const insets = { strip: [boxes.strip.l - boxes.card.l, boxes.card.r - boxes.strip.r], under: [boxes.under.l - boxes.card.l, boxes.card.r - boxes.under.r] };
  check("the strip is inset exactly as far as the under-strip below — one card, two matching tabs",
    Math.abs(insets.strip[0] - insets.under[0]) < 0.6 && Math.abs(insets.strip[1] - insets.under[1]) < 0.6, insets);
  check("and it sits on the card's centre line, not merely at the right width",
    Math.abs((boxes.strip.l + boxes.strip.r) / 2 - (boxes.card.l + boxes.card.r) / 2) < 0.6
      && Math.abs(insets.strip[0] - insets.strip[1]) < 0.6, boxes);
  check("the strip's bottom is BEHIND the card, not resting on it — there is no edge to draw a seam on",
    await evalIn(c, `(() => { const a = document.querySelector(".composer-todos").getBoundingClientRect(),
      b = document.querySelector(".composer").getBoundingClientRect(); return a.bottom > b.top + 4; })()`));

  const restShot = await shotOf(c);

  // ── the corner itself, counted rather than read ─────────────────────────
  /* The edge stroke comes off first: a 0.5px ring lands precisely on the boundary pixels the count is
     deciding and is worth ~0.04 to either curve. `--card-ring` is the one lever — the painter reads
     it as --sq-ring — so it drops out of the worklet path and the fallback path symmetrically. */
  await evalIn(c, `(() => { document.documentElement.style.setProperty("--card-ring", "transparent"); return true; })()`);
  await sleep(250);
  const silhouette = await shotOf(c);
  const painted = await evalIn(c, `__live.cornerFill(${JSON.stringify(silhouette)}, ".composer-todos", "tl")`);
  check(`the strip's top corner is a superellipse (${SQUIRCLE}), not a circular arc (${CIRCLE.toFixed(3)})`,
    near(painted.fraction, SQUIRCLE), painted);
  check("and it is drawn at the CARD's radius, not the under-strip's smaller rung",
    painted.R === Math.round(await evalIn(c, `parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--r-squircle"))`)),
    { R: painted.R });
  /* The bottom pair is the half the user asked for and the half that is never on screen — it lives
     10px behind the card. Lifted clear of it, the same count answers over the same window.
     Against the ROUNDED alternative rather than against 1.0: the window's outer row and column land
     on the antialiased edge whatever the shape, so even a perfect right angle counts short of full
     and an absolute threshold would be measuring the sampler. Putting the radius back and counting
     again calibrates that away, and is this check's own mutant. */
  await evalIn(c, `(() => { document.querySelector(".composer-todos").style.marginBottom = "14px"; return true; })()`);
  await sleep(300);
  const squareR = await evalIn(c, `__live.cornerFill(${JSON.stringify(await shotOf(c))}, ".composer-todos", "bl", ${painted.R})`);
  await evalIn(c, `(() => { document.querySelector(".composer-todos").style.setProperty("--sq-radius-bottom", "var(--r-squircle)");
    document.querySelector(".composer-todos").style.borderBottomLeftRadius = "var(--r-squircle)"; return true; })()`);
  await sleep(300);
  const roundedR = await evalIn(c, `__live.cornerFill(${JSON.stringify(await shotOf(c))}, ".composer-todos", "bl", ${painted.R})`);
  check("the strip's bottom corners are SQUARE — they fill more of the corner than the same corner rounded does",
    squareR.fraction > roundedR.fraction + TOL, { square: squareR.fraction, rounded: roundedR.fraction, R: painted.R });
  await evalIn(c, `(() => { const el = document.querySelector(".composer-todos");
    el.style.removeProperty("--sq-radius-bottom"); el.style.borderBottomLeftRadius = ""; el.style.marginBottom = ""; return true; })()`);
  await evalIn(c, `(() => { document.documentElement.style.removeProperty("--card-ring"); return true; })()`);
  await sleep(250);

  // ── nothing paints over it (the .composer-dock stacking trap) ───────────
  /* Forced visible and given real height, because at rest the band may not reach the strip at all —
     which would make an identical pair prove nothing. */
  await evalIn(c, `__live.freeze(true)`);
  await sleep(300);
  /* Moved ONTO the pair, not merely made taller. The band is anchored to the transcript's bottom and
     grows upward, so at any height it stops where the dock begins and never overlaps the strip at
     all — and a comparison of two shots it could not have touched passes whatever the z-order is.
     Its bottom edge is pushed past the card's so the whole pair is underneath it. */
  const covered = await evalIn(c, `(() => {
    const f = document.querySelector(".transcript-fade");
    const s = document.querySelector(".composer-todos").getBoundingClientRect();
    const b = document.querySelector(".composer").getBoundingClientRect();
    const w = document.querySelector(".transcript-wrap").getBoundingClientRect();
    const h = Math.ceil(b.bottom - s.top) + 80;
    f.style.display = "block"; f.style.bottom = "auto"; f.style.height = h + "px";
    f.style.top = Math.floor(s.top - w.top - 40) + "px";
    f.style.setProperty("--fade-h", h + "px");
    const r = f.getBoundingClientRect();
    return { fade: [Math.round(r.top), Math.round(r.bottom)], pair: [Math.round(s.top), Math.round(b.bottom)] }; })()`);
  await sleep(400);
  const withFade = await clipOf(c);
  check("the band was actually moved over the whole pair, so the comparison below can fail",
    covered.fade[0] <= covered.pair[0] && covered.fade[1] >= covered.pair[1], covered);
  await evalIn(c, `(() => { document.querySelector(".transcript-fade").remove(); return true; })()`);
  await sleep(400);
  const withoutFade = await clipOf(c);
  /* TOL absorbs the grain's own redraw; the SHARE is what carries the claim. A band painting over
     the pair rewrites most of the rectangle, not a scattering of it. */
  const bandMoved = await evalIn(c, `__live.diff(${JSON.stringify(withFade)}, ${JSON.stringify(withoutFade)}, 8)`);
  check("the transcript's fade band passes UNDER the strip — the dock still outranks it",
    bandMoved.fraction !== undefined && bandMoved.fraction < 0.02, bandMoved);
  await evalIn(c, `__live.freeze(false)`);

  // ── items arriving grow the strip upward and stop; the card holds still ──
  const grown = await evalIn(c, `(() => {
    const list = document.querySelector(".composer-todos .todo-list");
    const li = list.querySelector("li");
    for (let i = 0; i < 24; i++) list.appendChild(li.cloneNode(true));
    return true; })()`);
  void grown;
  await sleep(400);
  const afterCard = await evalIn(c, `__live.box(document.querySelector(".composer"))`);
  check("a plan of any length does not move the prompter — the strip grows into the transcript instead",
    Math.abs(afterCard.t - restCard.t) < 1 && Math.abs(afterCard.b - restCard.b) < 1, { rest: restCard, grown: afterCard });
  const list = await evalIn(c, `(() => { const l = document.querySelector(".composer-todos .todo-list");
    return { client: l.clientHeight, scroll: l.scrollHeight, cap: Math.round(parseFloat(getComputedStyle(l).maxHeight)) }; })()`);
  check("and it is bounded: the list stops at its cap and scrolls past it",
    list.client <= list.cap + 1 && list.scroll > list.client + 20, list);

  // ── a finished plan shuts itself, and still reports ─────────────────────
  await api.call("sessions.send", { id: session.id, text: "all done", attachments: [], mentions: [] });
  await until(() => evalIn(c, `document.querySelector(".composer-todos .todo-count")?.textContent === "3 of 3"`), 20000, "the finished plan");
  await sleep(700);
  const doneShot = await shotOf(c);
  const shut = await evalIn(c, `(() => { const s = document.querySelector(".composer-todos");
    return { open: s.hasAttribute("data-open"), h: Math.round(s.getBoundingClientRect().height),
      barW: document.querySelector(".composer-todos .todo-fill").getBoundingClientRect().width,
      trackW: document.querySelector(".composer-todos .todo-track").getBoundingClientRect().width,
      card: __live.box(document.querySelector(".composer")) }; })()`);
  check("a finished plan shuts itself rather than holding prompter height open",
    !shut.open && shut.h < 70, { open: shut.open, height: shut.h });
  check("but the filled bar is still on screen — a shut strip still says how the run went",
    Math.abs(shut.barW - shut.trackW) < 1 && shut.trackW > 100, { bar: Math.round(shut.barW), track: Math.round(shut.trackW) });
  check("and the prompter did not move while it shut",
    Math.abs(shut.card.t - restCard.t) < 1 && Math.abs(shut.card.b - restCard.b) < 1, { rest: restCard, done: shut.card });

  for (const [tag, data] of [["open", restShot], ["silhouette", silhouette], ["done", doneShot]]) {
    const out = path.join(os.tmpdir(), `realm-todo-strip-${tag}.png`);
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`SCREENSHOT ${tag} ${out}`);
  }

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
