/**
 * Live checks for the quick chat window: the prompter's edge, and the drop glow
 * (run with: node apps/desktop/scripts/quick-chat-live.mjs)
 *
 * The prompter in the quick chat window spans the window and gives up its corners, so the only edge
 * it may draw is the seam along its top, where the transcript scrolls under it. It was drawing a
 * four-sided box instead — and the reason is invisible to the suite: the ring is painted by the
 * worklet from `--sq-ring`, and `:root[data-squircle] .composer:focus-within` out-weighs the
 * quick chat's own rule from further down the file. jsdom has no CSS Painting API and no layout, so
 * to it the box and its absence are the same stylesheet.
 *
 * The claim is a strip of pixels: the card draws no edge on any side — not down its sides, and not
 * across the top, where a seam used to rule one continuous window into two. Each strip reads as the
 * thing beside it. The mutant is the edge itself; put `--sq-ring-w` back and the side strip has to
 * separate, or this is measuring something other than the edge. Checked at rest and focused,
 * because focus is where it kept coming back.
 *
 * The glow is here for the same reason: whether it PAINTS, where it sits relative to the prompter's
 * dock, and whether its corner is concentric with the window's are all questions about layout and
 * compositing, and the suite has neither.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9351), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8917);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-quick-chat-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Luminance a stroke has to ADD to a strip before it counts as a ring. One-sided deliberately: the
 *  ring is a lightening overlay (`--card-ring`) in both faces, and the card's lift — a drop-shadow on
 *  its ::before, which it keeps here — darkens the same strip by about 3.5 on its own. A two-sided
 *  test would be reading that shadow and calling it a ring. */
const RING = 1.2;

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
    const lum = (x, y) => {
      const i = ((Math.floor(y * dpr) * cv.width) + Math.floor(x * dpr)) * 4;
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    };
    const band = (x0, y0, x1, y1) => {
      let total = 0, n = 0;
      for (let y = y0; y < y1; y += 0.5) for (let x = x0; x < x1; x += 0.5) { total += lum(x, y); n++; }
      return total / n;
    };
    return { lum, band, dpr };
  },
  /** A DataTransfer shaped like a Finder drag: its type list carries "Files", which is what the
   *  window gates on. */
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
    return true;
  },
  drop(sel, dt = __live.fileDrag()) {
    document.querySelector(sel).dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
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

/* The window's left edge, beside the prompter and beside the transcript above it.
 *
 * Not the card's edge against the card's own fill: the card spans the window, so its left edge IS
 * the window's, and that strip is dark with the window's own boundary whatever the card does. The
 * two strips are the same x on the same edge — a ring on the prompter lifts the lower one only.
 * Both stop short of the window's rounded bottom corners, where the edge curves away from the x
 * being sampled. */
const edgeBesideVsAbove = (b64) => `(async () => {
  const s = await __live.sampler(${JSON.stringify(b64)});
  const b = document.querySelector(".quick-chat .composer").getBoundingClientRect();
  const chat = document.querySelector(".quick-chat").getBoundingClientRect();
  return {
    beside: s.band(b.left, b.top + 6, b.left + 1, b.bottom - 16),
    above: s.band(chat.left, chat.top + 60, chat.left + 1, b.top - 8),
  };
})()`;
/* The card's top edge against what is either side of it: the window's ground just above, the card's
   own fill just below. Away from both ends, and on an EMPTY chat, so no fade band is in the frame. */
const topEdge = (b64) => `(async () => {
  const s = await __live.sampler(${JSON.stringify(b64)});
  const b = document.querySelector(".quick-chat .composer").getBoundingClientRect();
  const [x0, x1] = [b.left + 40, b.right - 40];
  return {
    above: s.band(x0, b.top - 6, x1, b.top - 2),
    edge: s.band(x0, b.top - 0.5, x1, b.top + 1.5),
    below: s.band(x0, b.top + 4, x1, b.top + 8),
  };
})()`;

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
      REALM_ENABLE_FAKE_AGENT: "1",
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
  await sleep(400);

  await evalIn(c, `(() => { document.querySelector('[aria-label="Quick chat"]').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.quick-chat .composer')`), 20000, "quick chat");
  await sleep(700); // the window's own enter animation

  check("the painter loaded, so this is the path the screenshot was on",
    await evalIn(c, `document.documentElement.hasAttribute("data-squircle")`));
  const ringW = await evalIn(c, `getComputedStyle(document.querySelector(".quick-chat .composer")).getPropertyValue("--sq-ring-w").trim()`);
  // `--sq-ring-w` is registered as a <length> (theme/squircle.ts), so zero computes to "0px".
  check("the quick chat prompter asks the painter for no ring", parseFloat(ringW) === 0, { ringW });

  for (const state of ["rest", "focused"]) {
    if (state === "focused") {
      await evalIn(c, `(() => { document.querySelector(".quick-chat .composer-input").focus(); return true; })()`);
      await sleep(300);
    }
    const shot = await shotOf(c);
    const { beside, above } = await evalIn(c, edgeBesideVsAbove(shot));
    check(`${state}: no line down the prompter's side — the window's edge is no brighter beside it than above it`,
      beside < above + RING, { beside: +beside.toFixed(2), above: +above.toFixed(2) });

    // The mutant. Without it a card whose fill happened to match its ring would pass the check above.
    await evalIn(c, `(() => {
      const st = document.createElement("style");
      st.id = "ring-back";
      st.textContent = ":root[data-squircle] .quick-chat .composer { --sq-ring-w: 1px !important; }";
      document.head.appendChild(st);
      return true; })()`);
    await sleep(250);
    const ringed = await evalIn(c, edgeBesideVsAbove(await shotOf(c)));
    check(`${state}: and the measurement can see one — the ring put back lifts the strip beside it`,
      ringed.beside > ringed.above + RING,
      { beside: +ringed.beside.toFixed(2), above: +ringed.above.toFixed(2) });
    await evalIn(c, `(() => { document.getElementById("ring-back")?.remove(); return true; })()`);
    await sleep(250);

    const top = await evalIn(c, topEdge(await shotOf(c)));
    check(`${state}: no seam above the prompter — its top edge reads as the ground above and the fill below`,
      Math.abs(top.edge - top.above) < RING && Math.abs(top.edge - top.below) < RING,
      { above: +top.above.toFixed(2), edge: +top.edge.toFixed(2), below: +top.below.toFixed(2) });
  }

  // ── the window's own border, and the one line that answers the pointer ───
  /* Sampled just OUTSIDE the window: `box-shadow` with no inset draws there, so the ring is the
     first pixel past the corner-free part of each edge. Read against the app behind it, with the
     pointer parked far away and then over the window. */
  const windowRing = (b64) => `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const q = document.querySelector(".quick-chat").getBoundingClientRect();
    return {
      ring: s.band(q.left - 1, q.top + 40, q.left - 0.5, q.bottom - 40),
      behind: s.band(q.left - 6, q.top + 40, q.left - 4, q.bottom - 40),
    };
  })()`;
  const park = async (x, y) => {
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(300);
  };
  const chatBox = await evalIn(c, `(() => { const q = document.querySelector(".quick-chat").getBoundingClientRect();
    return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), left: Math.round(q.left) }; })()`);
  await park(20, 400);
  const ringRest = await evalIn(c, windowRing(await shotOf(c)));
  check("the window wears a border at rest — its edge is brighter than the app behind it",
    ringRest.ring > ringRest.behind + RING, { ring: +ringRest.ring.toFixed(2), behind: +ringRest.behind.toFixed(2) });
  await park(chatBox.x, chatBox.y);
  const ringHover = await evalIn(c, windowRing(await shotOf(c)));
  check("and it glows under the pointer — the hover step is visible at a glance",
    ringHover.ring > ringRest.ring + RING, { rest: +ringRest.ring.toFixed(2), hover: +ringHover.ring.toFixed(2) });
  await park(20, 400);

  /* The same two claims in the LIGHT face, measured rather than assumed. Black on a near-white
     ground loses more of itself than white on a near-black one, so the pair takes heavier rungs
     there and only a reading can say whether they landed. Compared by distance from the ground,
     because in light the edge is darker than what is behind it rather than brighter. */
  await evalIn(c, `(() => { document.documentElement.setAttribute("data-mode", "light"); return true; })()`);
  await sleep(400);
  const lightRest = await evalIn(c, windowRing(await shotOf(c)));
  check("light face: the border is there too",
    Math.abs(lightRest.ring - lightRest.behind) > RING, { ring: +lightRest.ring.toFixed(2), behind: +lightRest.behind.toFixed(2) });
  await park(chatBox.x, chatBox.y);
  const lightHover = await evalIn(c, windowRing(await shotOf(c)));
  check("light face: and it still moves under the pointer",
    Math.abs(lightHover.ring - lightRest.ring) > RING, { rest: +lightRest.ring.toFixed(2), hover: +lightHover.ring.toFixed(2) });
  await park(20, 400);
  await evalIn(c, `(() => { document.documentElement.setAttribute("data-mode", "dark"); return true; })()`);
  await sleep(400);

  // ── the dissolve, once there is something to scroll under the prompter ───
  /* The wash this used to check is gone with the bands: a dissolve that painted a colour had to be
     told WHICH colour, and on this window the pane's ground landed as a block of off-tone above the
     prompter. A mask paints nothing, so there is no tone to get wrong — what is left to check is
     that the strip above the card reads the same as the window beside it, which is the same symptom
     the old wash produced and the reason the mutant below is a painted band. */
  await evalIn(c, `(() => {
    __live.setInput(document.querySelector(".quick-chat .composer-input"), "say something long enough to scroll");
    document.querySelector(".quick-chat .composer-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".quick-chat .transcript[data-dissolve]")`), 20000, "transcript");
  await sleep(900);
  const fade = await evalIn(c, `(() => {
    const t = document.querySelector(".quick-chat .transcript");
    return { mask: getComputedStyle(t).maskImage !== "none", filter: getComputedStyle(t).backdropFilter,
             depth: getComputedStyle(t).getPropertyValue("--fade-h").trim() };
  })()`);
  check("the text that passes under the prompter runs out rather than being clipped — the scroller is masked",
    fade.mask === true && fade.filter === "none", fade);

  const washed = await evalIn(c, topEdge(await shotOf(c)));
  check("and it leaves no block of off-tone above the prompter",
    Math.abs(washed.above - washed.below) < RING, { above: +washed.above.toFixed(2), below: +washed.below.toFixed(2) });
  /* The mutant: a painted band washing to the PANE's ground — what this window had before, in one
     rule. It has to be visible from here, or the strip above is reading nothing. */
  await evalIn(c, `(() => {
    const st = document.createElement("style"); st.id = "pane-ground";
    st.textContent = ".quick-chat .transcript-wrap::after { content: ''; position: absolute;"
      + " inset: auto 0 0 0; height: 28px; z-index: 3; pointer-events: none;"
      + " background: linear-gradient(to top, var(--rl-panel), transparent); }";
    document.head.appendChild(st); return true; })()`);
  await sleep(300);
  const paneGround = await evalIn(c, topEdge(await shotOf(c)));
  check("and the wrong ground is visible from here, so the check above means something",
    Math.abs(paneGround.above - paneGround.below) > RING,
    { above: +paneGround.above.toFixed(2), below: +paneGround.below.toFixed(2) });
  await evalIn(c, `(() => { document.getElementById("pane-ground")?.remove(); return true; })()`);
  await sleep(300);

  // ── the drop glow ────────────────────────────────────────────────────────
  await evalIn(c, `(() => { document.querySelector(".quick-chat .composer-input").blur(); return true; })()`);
  check("nothing is drawn before a file is dragged in", await evalIn(c, `!document.querySelector(".quick-chat .session-drop")`));

  /* The card's sharpness BEFORE the drag, for the comparison below. Taken here rather than after the
     drop: a dropped file puts an attachment tile on the card, which moves the row being measured —
     that would compare two different pictures and call the difference blur. */
  const cardSharpness = (b64) => `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const b = document.querySelector(".quick-chat .composer-input").getBoundingClientRect();
    /* Inset past the ring. The field's BOX is the window's full width — the padding that holds the
       text off the edge is inside it — so a sweep from its own left edge would run straight through
       the stroke this check exists to be independent of, and read the affordance as blur. */
    let energy = 0;
    const y = b.top + b.height / 2;
    for (let x = b.left + 24; x < b.right - 24; x += 1) energy += Math.abs(s.lum(x + 1, y) - s.lum(x, y));
    return energy;
  })()`;
  /* Caret out of the field first, and for both samples: it is an accent bar on the very row being
     measured, and whether a blink caught it changes the energy by more than a blur would. */
  const blurField = () => evalIn(c, `(() => { document.querySelector(".quick-chat .composer-input").blur(); return true; })()`);
  await blurField();
  await sleep(200);
  const sharpRest = await evalIn(c, cardSharpness(await shotOf(c)));

  await evalIn(c, `__live.dragOver(".quick-chat .transcript")`);
  await sleep(300);
  const glow = await evalIn(c, `(() => {
    const g = document.querySelector(".quick-chat .session-drop");
    if (!g) return null;
    const host = document.querySelector(".quick-chat-body").getBoundingClientRect();
    const win = document.querySelector(".quick-chat").getBoundingClientRect();
    const b = g.getBoundingClientRect(), card = document.querySelector(".quick-chat .composer").getBoundingClientRect();
    const cs = getComputedStyle(g);
    return {
      inset: { l: Math.round(b.left - host.left), t: Math.round(b.top - host.top),
               r: Math.round(host.right - b.right), b: Math.round(host.bottom - b.bottom) },
      windowInset: { l: Math.round(b.left - win.left), t: Math.round(b.top - win.top) },
      clearsCard: b.bottom <= card.top + 1,
      radius: cs.borderTopLeftRadius, windowRadius: getComputedStyle(document.querySelector(".quick-chat")).borderTopLeftRadius,
      pointer: cs.pointerEvents, zIndex: cs.zIndex,
      dockZ: getComputedStyle(document.querySelector(".quick-chat .composer-dock")).zIndex,
      coversCard: b.top < card.top && b.bottom >= card.bottom - 8,
    };
  })()`);
  /* Around the READING area, and stopping above the prompter. A ring drawn around the card says the
     card takes the file, and it does not — the transcript does. */
  check("a file dragged onto the window lights a glow around the reading area, clear of the prompter",
    glow !== null && glow.clearsCard === true, glow && { inset: glow.inset, clearsCard: glow.clearsCard });
  check("inset 6px on all four sides of the body it belongs to",
    glow && [glow.inset.l, glow.inset.t, glow.inset.r, glow.inset.b].every((v) => v === 6), glow?.inset);
  /* Concentric with the window: 6px inside an --r-float corner is --r-float − 6, and the pane's own
     value (--r-float + 4, right on a square pane) would bulge past the corner it sits in. */
  check("its corner is the window's, taken in by the inset",
    glow && parseFloat(glow.radius) === parseFloat(glow.windowRadius) - 6, { glow: glow?.radius, window: glow?.windowRadius });
  /* Above the dock, which the pane's own glow may not be. The difference is the box: this one stops
     at the prompter, so there is no card over any of its four sides for it to wash — and being above
     is what lets the bottom stroke and both bottom corners be drawn by the one layer that draws the
     other three sides, instead of a second layer added to close the rectangle. */
  check("it advertises the drop without swallowing it, and is drawn in one layer above the dock",
    glow?.pointer === "none" && Number(glow?.zIndex) > Number(glow?.dockZ), { pointerEvents: glow?.pointer, z: glow?.zIndex, dock: glow?.dockZ });

  /* The ring closes at the BOTTOM — the side that used to be missing, when the glow spanned the
     window and had to pass under the dock to keep off the card. It is read just inside the body's
     own bottom edge, between the corners so the curve is not in the sample. */
  const bottomStroke = (b64) => `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const q = document.querySelector(".quick-chat-body").getBoundingClientRect();
    return s.band(q.left + 60, q.bottom - 7.5, q.right - 60, q.bottom - 5.5);
  })()`;
  const bottomLit = await evalIn(c, bottomStroke(await shotOf(c)));

  /* And the card under the stroke stays legible: it carries no backdrop-filter, so the prompter's
     own text is as sharp mid-drag as it was before. Gradient energy across the placeholder's row —
     blur is exactly what destroys it, which is the regression `prompter-fade-live.mjs` was written
     for and the reason the wash half is not allowed up here. */
  await blurField();
  await sleep(200);
  const sharpDragging = await evalIn(c, cardSharpness(await shotOf(c)));

  /* And it PAINTS. The ring is accent on a near-black window, so the strip it occupies is far
     brighter than the same strip with the glow gone — which is the mutant, taken by ending the drag
     rather than by hiding the element, so what is measured is the affordance and not a display rule. */
  const ringStrip = (b64) => `(async () => {
    const s = await __live.sampler(${JSON.stringify(b64)});
    const w = document.querySelector(".quick-chat-body").getBoundingClientRect();
    return s.band(w.left + 6, w.top + 40, w.left + 8, w.bottom - 40);
  })()`;
  const lit = await evalIn(c, ringStrip(await shotOf(c)));
  await evalIn(c, `__live.drop(".quick-chat .transcript")`);
  await sleep(400);
  check("the drop takes the file — an attachment lands on the quick chat's own prompter",
    await evalIn(c, `!!document.querySelector(".quick-chat .attach-tile")`));
  check("and the glow goes out with the drag", await evalIn(c, `!document.querySelector(".quick-chat .session-drop")`));
  const dark = await evalIn(c, ringStrip(await shotOf(c)));
  check("the glow was really on screen — its ring is far brighter than the window without it",
    lit > dark + 8, { lit: +lit.toFixed(2), without: +dark.toFixed(2) });
  const bottomDark = await evalIn(c, bottomStroke(await shotOf(c)));
  check("the ring closes along its own bottom edge, above the prompter rather than behind it",
    bottomLit > bottomDark + 8, { dragging: +bottomLit.toFixed(2), after: +bottomDark.toFixed(2) });
  check("and the prompter's own text is untouched by it — the stroke blurs nothing",
    Math.abs(sharpDragging - sharpRest) / Math.max(sharpRest, 1) < 0.1,
    { dragging: Math.round(sharpDragging), beforeTheDrag: Math.round(sharpRest) });

  /* Focus draws nothing. The card is the window's bottom, the caret is its own affordance, and the
     border-brighten it inherits from the pane's prompter is the box this window kept growing back. */
  await evalIn(c, `(() => { document.querySelector(".quick-chat .composer-input").blur(); return true; })()`);
  await sleep(300);
  const edgeRest = await evalIn(c, topEdge(await shotOf(c)));
  await evalIn(c, `(() => { document.querySelector(".quick-chat .composer-input").focus(); return true; })()`);
  await sleep(300);
  const edgeFocus = await evalIn(c, topEdge(await shotOf(c)));
  check("focus draws no edge either — the card's top reads identically with the caret in it",
    Math.abs(edgeFocus.edge - edgeRest.edge) < 0.5, { rest: +edgeRest.edge.toFixed(2), focused: +edgeFocus.edge.toFixed(2) });

  // ── the popovers the prompter opens ──────────────────────────────────────
  /* The window and every anchored popover are portalled to the same body, so they are siblings and
     the z-index decides outright. Asked of `elementFromPoint` rather than of the stylesheet: what is
     wanted is what the compositor put on top at that pixel. */
  await evalIn(c, `(() => { document.querySelector(".quick-chat .model-chip").click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".model-picker")`), 5000, "model picker");
  await sleep(400);
  const onTop = await evalIn(c, `(() => {
    const p = document.querySelector(".model-picker").getBoundingClientRect();
    const hit = document.elementFromPoint(p.left + p.width / 2, p.top + 24);
    return { inPicker: !!hit?.closest(".model-picker"), hitInChat: !!hit?.closest(".quick-chat"),
             overlapsChat: (() => { const q = document.querySelector(".quick-chat").getBoundingClientRect();
               return p.left < q.right && p.right > q.left && p.top < q.bottom && p.bottom > q.top; })() };
  })()`);
  check("the model picker opens IN FRONT of the window that opened it", onTop.inPicker && !onTop.hitInChat, onTop);
  check("and it really is over the window, so the test is not passing on a miss", onTop.overlapsChat === true, onTop);
  await evalIn(c, `(() => { document.querySelector(".model-picker input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  await sleep(300);

  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    // The grace period is not politeness: Electron is still flushing its userData when SIGTERM
    // lands, and removing the directory out from under it fails with ENOTEMPTY.
    electron?.kill("SIGTERM");
    setTimeout(() => {
      electron?.kill("SIGKILL");
      fs.rmSync(scratch, { recursive: true, force: true });
      process.exit(process.exitCode ?? 0);
    }, 1200);
  });
