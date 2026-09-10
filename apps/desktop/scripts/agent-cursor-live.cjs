/**
 * Live check for the marks an agent leaves inside a driven page (Plan 25 W1+W2), against a real
 * Chrome and a real compositor.
 *
 *   BrowserAgentHost.setAccent + handleOp("act") → markAct → Runtime.evaluate → a real WebContentsView
 *
 * Why this cannot be a unit test, and where the evidence has to come from. The unit tests assert what
 * STRING is injected; nothing in them can tell you whether Chrome painted it, where, or whether it
 * ever went away. design.md is explicit that "a CDP screenshot renders the DOM only, so a native
 * view over the surface under test is simply absent from it" — a `Page.captureScreenshot` of the
 * host renderer comes back clean whatever the view is doing.
 *
 * MEASURED HERE, and worth knowing before reaching for it: `BrowserWindow.capturePage` has the same
 * blind spot. It returns the window's OWN web contents and composites no child `WebContentsView` at
 * all — a window whose whole surface is covered by a bright green page captured as pure white, at
 * every pixel. So the evidence is `view.webContents.capturePage()`, the view's own compositor
 * output. That capture IS the view's rect, which is what makes "painted inside the view" a property
 * of the frame rather than an assertion needing its own arithmetic: a mark drawn outside the view
 * would simply not be in this bitmap.
 *
 * What it settles, each load-bearing for a comment in `browser-agent.ts`:
 *
 *   1. The accent the RENDERER pushed is the accent on screen — the W1 defect was a hard-coded
 *      `#4c8dff`, and a hard-coded blue would leave no green pixels here at all.
 *   2. The cursor is painted at the element's own centre, within a pixel, in the view's rect.
 *   3. The ring is still drawn beside it, at the element's edge, and the two do not collapse into
 *      one mark.
 *   4. The controlled-screen frame reaches the view's edges.
 *   5. All three are GONE after the page's own dwell watchdog fires. This is the assertion the whole
 *      watchdog exists for: a stuck pointer on someone's page is the failure mode with no recovery.
 *
 * Run:  apps/desktop/node_modules/.bin/electron apps/desktop/scripts/agent-cursor-live.cjs
 *
 * Hygiene: scratch userData + REALM_HOME under mkdtemp, removed at exit; the page is a `data:` URL
 * this file authors, so no network and no port; no realm-server, no agent CLI, no real ~/Realm.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-agent-cursor-live-"));
process.env.REALM_HOME = path.join(scratch, "home");
const OVERALL_TIMEOUT_MS = 60_000;

let failures = 0;
const results = [];
const ok = (label, cond, detail = "") => {
  results.push(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const log = (line) => console.log(`[live] ${line}`);
const cleanup = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esbuild() {
  const pnpm = path.join(repoRoot, "node_modules/.pnpm");
  for (const d of fs.readdirSync(pnpm)) {
    if (!d.startsWith("esbuild@")) continue;
    try { return require(path.join(pnpm, d, "node_modules/esbuild")); } catch { /* next */ }
  }
  throw new Error("esbuild not found in node_modules/.pnpm");
}
const entry = path.join(scratch, "entry.ts");
fs.writeFileSync(entry, `
  export { createBrowserPane } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/browser-pane.ts"))};
  export { BrowserAgentHost } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/browser-agent-host.ts"))};
  export { AGENT_CURSOR, AGENT_CURSOR_FORMS, AGENT_MOTION } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/agent-cursor.ts"))};
`);
const bundled = path.join(scratch, "marks.cjs");
esbuild().buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: bundled });

const { app, BrowserWindow } = require("electron");
const { createBrowserPane, BrowserAgentHost, AGENT_CURSOR, AGENT_CURSOR_FORMS, AGENT_MOTION } = require(bundled);
app.setPath("userData", path.join(scratch, "userData"));
// Same switch main/index.ts carries: an occluded window's WebContentsView drops synthetic input and
// stops compositing, and this script's window sits behind the terminal that launched it.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

/* A green nobody else on screen is wearing. Realm's own accent is a blue, the page below is greys,
   and Chrome's default focus ring is blue — so a green pixel in the capture came from the accent
   this script pushed and from nothing else. That is what makes assertion 1 a real one rather than a
   restatement of "some mark was drawn". */
const ACCENT = "rgb(0, 200, 0)";
const isAccent = (r, g, b) => g > 150 && r < 100 && b < 100;

const VIEW = { x: 0, y: 0, width: 800, height: 600 };

/**
 * One target per pointer, each DECLARING the cursor it wants — which is the whole mechanism under
 * test. Nothing here tells Realm which glyph to draw; the page's own computed `cursor` at the point
 * is what decides, and these four are how that gets exercised end to end.
 *
 * `auto` is the interesting one: it is what almost every real element computes to, and it is the
 * case only the page can resolve. An `<input type=text>` under `auto` must come back as the I-beam.
 */
const TARGETS = [
  { id: "plain", form: "default", css: "cursor:default", tag: "button", top: 20 },
  { id: "clicky", form: "pointer", css: "cursor:pointer", tag: "button", top: 130 },
  { id: "field", form: "text", css: "", tag: "input", top: 240 },
  { id: "off", form: "not-allowed", css: "cursor:not-allowed", tag: "button", top: 350 },
];
/* Deliberately far larger than a real button. The ACTION RING is drawn 3px outside the element's own
   box and is the same accent as the pointer, so a target only a little bigger than the glyph would
   put ring pixels inside the window the glyph is measured in — which is what a first run of this
   check did, reporting a 14x20 arrow as 39x29 of ring. The targets are sized so the largest glyph
   (the hand, 20x24, hanging 23px below its hotspot) clears every edge. */
const BOX = { left: 60, w: 260, h: 90 };

/* Buttons and an input, not anchors. The mark lives in the page's DOM, so a target that navigates
   would take the very thing under test away with it — and the run would pass its "gone" assertion
   for the wrong reason. */
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>marks page</title>
<body style="margin:0;background:#f4f4f5;font:14px sans-serif">
${TARGETS.map((t) => `<${t.tag} id="${t.id}" ${t.tag === "button" ? 'type="button"' : 'type="text" value="Sign in"'}
  style="position:fixed;left:${BOX.left}px;top:${t.top}px;width:${BOX.w}px;height:${BOX.h}px;
  background:#e4e4e7;border:1px solid #a1a1aa;color:#18181b;${t.css}"
  onclick="window.__hits=(window.__hits||0)+1">${t.tag === "button" ? t.id : ""}</${t.tag}>`).join("\n")}
</body>`)}`;

/**
 * One composited capture of the window, as a device-pixel accent mask.
 *
 * `capturePage` hands back the compositor's output at the display's scale factor, so the bitmap is
 * `scale x` the DIP size the view reports. Everything below indexes in device pixels and converts
 * back to DIP at the end — resizing the image to 1x instead would interpolate a 14px mark into a
 * smear and quietly weaken every measurement taken from it.
 */
async function accentMask(wc) {
  const image = await wc.capturePage();
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const scale = Math.round(Math.sqrt(bitmap.length / 4 / (width * height)));
  const dw = width * scale;
  const at = (x, y) => {
    const i = (y * dw + x) * 4;
    return isAccent(bitmap[i + 2], bitmap[i + 1], bitmap[i]);
  };
  return {
    scale, dw, dh: height * scale,
    /** Accent pixels inside a DIP box: how many, and their extent — all back in DIP. */
    box(x0, y0, x1, y1) {
      let n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let y = Math.max(0, Math.round(y0 * scale)); y < Math.min(height * scale, Math.round(y1 * scale)); y++) {
        for (let x = Math.max(0, Math.round(x0 * scale)); x < Math.min(dw, Math.round(x1 * scale)); x++) {
          if (!at(x, y)) continue;
          n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      const d = (v) => (n ? v / scale : NaN);
      return { n, minX: d(minX), minY: d(minY), maxX: d(maxX), maxY: d(maxY) };
    },
  };
}

/**
 * Where a form's ink should START, relative to the act's point, if the hotspot landed correctly.
 *
 * This is the assertion a circle never needed and a pointer cannot do without. The mark is placed by
 * its hotspot, so the glyph's ink extends away from the point in whatever direction that form's
 * hotspot sits: an arrow's tip is its top-left corner, so its ink runs down and right of the point;
 * an I-beam's hotspot is its middle, so its ink straddles the point in both axes. Measuring the
 * centroid instead — which is what the mark-shaped mark was measured by — would pass for a pointer
 * placed ten pixels off, because the centroid of an arrow is nowhere near its tip.
 */
function expectedInk(formName, point) {
  const { box, hot } = AGENT_CURSOR_FORMS[formName];
  return { left: point.x - hot[0], top: point.y - hot[1], right: point.x - hot[0] + box[0], bottom: point.y - hot[1] + box[1] };
}

async function main() {
  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  await win.loadURL("data:text/html,<title>host</title><body style='margin:0;background:#fff'>");
  const pane = createBrowserPane(win);
  const host = new BrowserAgentHost({
    attach: (id) => pane.attachCdp(id),
    hasView: (id) => pane.hasView(id),
    navigate: (id, url) => pane.host.navigate(id, url),
    pageState: (id) => pane.pageState(id),
    touch: () => {},
  });
  pane.onViewDestroyed((id) => host.release(id));

  pane.host.create("b1", "about:blank", null);
  pane.host.setBounds("b1", VIEW, 1, true);
  await sleep(500);
  const view = win.contentView.children.find((c) => c.webContents);
  if (!view) throw new Error("the pane created no WebContentsView");
  const pageWc = view.webContents;
  await pageWc.loadURL(PAGE);
  await sleep(500);
  ok("the test page loaded", (await pageWc.getURL()).startsWith("data:text/html"), await pageWc.getTitle());

  const binding = pane.attachCdp("b1");
  const { root } = await binding.send("DOM.getDocument", { depth: 1 });
  /** The ref every downstream op speaks in. Resolved through CDP rather than through a snapshot, so
   *  a change in how snapshots are FORMATTED cannot break a check that is about pixels. */
  const refFor = async (id) => {
    const { nodeId } = await binding.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
    const { node } = await binding.send("DOM.describeNode", { nodeId });
    return node.backendNodeId;
  };
  const clickRef = (ref) => host.handleOp("act", { browserId: "b1", action: { kind: "click", ref, button: "left", clickCount: 1, modifiers: [] } });

  host.setAccent(ACCENT);

  /* ---- one pass per form ----
     Each target declares a different `cursor`, and nothing tells Realm which glyph to draw: the
     page's own computed value at the point is what picks it. So a pass that finds the right ink in
     the right place is the whole chain — accent pushed from the renderer, form read from the page,
     glyph built without innerHTML, placed by its own hotspot. */
  const crops = [];
  for (const target of TARGETS) {
    const ref = await refFor(target.id);
    const result = await clickRef(ref);
    ok(`${target.id}: the act succeeded`, result && result.ok === true, JSON.stringify(result));
    /* The point the INPUT actually used, read back out of the executor's own detail rather than
       computed here. Not a nicety: an `<input>`'s content quad excludes its padding and border, so
       the centre of its border box — the obvious thing to assume — is 3px off the point
       `performAct` wheels and clicks at. Comparing the mark against a guess would have measured the
       guess. This compares it against the coordinates the page was actually given. */
    const said = /at \((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/.exec(String(result && result.detail) || "");
    ok(`${target.id}: the executor reported where it clicked`, said !== null, String(result && result.detail));
    if (!said) continue;
    const point = { x: Number(said[1]), y: Number(said[2]) };

    // Long enough for the 180ms fade-in and the 120ms press to have finished, and well short of the
    // 900ms ring TTL and the dwell watchdog.
    await sleep(600);
    const mask = await accentMask(pageWc);
    if (crops.length === 0) log(`capture: ${mask.dw}x${mask.dh} device px at ${mask.scale}x`);

    /* The pointer's own ink, in a window big enough for the largest glyph and clear of the ring —
       the targets are 200x44, so the element's own edges are 20px and better from the point. */
    const want = expectedInk(target.form, point);
    const ink = mask.box(point.x - 14, point.y - 14, point.x + 26, point.y + 30);
    ok(`${target.id}: a pointer is painted, in the accent the renderer pushed`,
      ink.n > 0, `${ink.n} accent px`);

    /* The hotspot, measured. The glyph's ink has to START where its own hotspot says it should —
       within 1.5px, which is the accent outline's own half-width plus antialiasing. This is what
       tells the four forms apart from each other: an arrow whose ink began above and left of the
       point would be an arrow placed by its centre. */
    const dx = ink.minX - want.left;
    const dy = ink.minY - want.top;
    ok(`${target.id}: the ${target.form} pointer's hotspot is on the pixel the input went to`,
      ink.n > 0 && Math.abs(dx) <= 1.5 && Math.abs(dy) <= 1.5,
      `ink starts (${ink.minX}, ${ink.minY}), hotspot placement wants (${want.left}, ${want.top}) — off by (${dx.toFixed(2)}, ${dy.toFixed(2)})`);

    /* …and it is the RIGHT form, told apart by the shape of its own footprint. The four boxes differ
       enough that a mislabelled glyph cannot fit: the I-beam is 8 wide against the hand's 20, and
       the arrow is 20 tall against the hand's 24. A single glyph shipped under four names — the
       obvious way to fake this — fails here for three of the four. */
    const w = ink.maxX - ink.minX, h = ink.maxY - ink.minY;
    const wantBox = AGENT_CURSOR_FORMS[target.form].box;
    ok(`${target.id}: …and it is the ${target.form} glyph, not another one wearing its name`,
      ink.n > 0 && Math.abs(w - wantBox[0]) <= 3 && Math.abs(h - wantBox[1]) <= 3,
      `ink is ${w.toFixed(1)}x${h.toFixed(1)}, ${target.form}'s box is ${wantBox[0]}x${wantBox[1]}`);

    if (process.env.REALM_LIVE_CROP) {
      const shot = await pageWc.capturePage({ x: Math.round(point.x) - 40, y: Math.round(point.y) - 30, width: 130, height: 70 });
      const file = process.env.REALM_LIVE_CROP.replace(/\.png$/, `-${target.form}.png`);
      fs.writeFileSync(file, shot.resize({ width: 650, quality: "best" }).toPNG());
      crops.push(file);
    } else {
      crops.push(null);
    }

    // Let the dwell watchdog take everything down between passes, so each form is measured on a
    // clean page rather than beside its predecessor.
    await sleep(AGENT_CURSOR.idleMs + AGENT_MOTION.fastMs + 400);
  }
  if (crops[0]) log(`crops written: ${crops.join(", ")}`);
  ok("every click actually reached the page", (await pageWc.executeJavaScript("window.__hits || 0")) === TARGETS.length);

  /* ---- the ring and the frame, on one more act ---- */
  const again = await clickRef(await refFor(TARGETS[0].id));
  const point = { y: Number(/at \(-?\d+(?:\.\d+)?,\s*(-?\d+(?:\.\d+)?)\)/.exec(String(again.detail))[1]) };
  await sleep(600);
  const during = await accentMask(pageWc);

  /* The ring, at the element's edge and NOT at its centre. The split is the feature: one mark says
     "this element", the other says "this point". */
  const edge = during.box(BOX.left - 5, point.y - 2, BOX.left - 1, point.y + 2);
  ok("the ring is drawn at the element's edge, beside the cursor rather than instead of it",
    edge.n > 0, `${edge.n} accent px just outside the left edge`);

  // The controlled-screen frame, at the view's own edges.
  const top = during.box(300, 0, 600, 3);
  const bottom = during.box(300, VIEW.height - 3, 600, VIEW.height);
  ok("the controlled-screen frame reaches the view's edges", top.n > 0 && bottom.n > 0, `top=${top.n} bottom=${bottom.n}`);

  /* The page's own dwell watchdog. Nothing here tells the page to clean up — that is the point. A
     dead bridge, a crashed host or a lost driving:false must not be able to leave a pointer on
     somebody's page, so the timeout is owned by the page and this is the run that proves it fires. */
  await sleep(AGENT_CURSOR.idleMs + AGENT_MOTION.fastMs + 700);
  const after = await accentMask(pageWc);
  const anywhere = after.box(0, 0, VIEW.width, VIEW.height);
  ok(`every mark is gone ${AGENT_CURSOR.idleMs}ms after the last act, with nobody asked to remove it`,
    anywhere.n === 0, `${anywhere.n} accent px left in the view`);

  pane.host.destroyAll();
}

app.whenReady().then(async () => {
  const bail = setTimeout(() => { console.error("[live] TIMEOUT"); cleanup(); process.exit(2); }, OVERALL_TIMEOUT_MS);
  try {
    await main();
  } catch (e) {
    failures += 1;
    results.push(`  FAIL  script threw — ${e && e.stack ? e.stack : e}`);
  }
  clearTimeout(bail);
  log("results:");
  for (const r of results) console.log(r);
  log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
});
