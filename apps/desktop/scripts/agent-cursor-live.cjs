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
  export { AGENT_CURSOR, AGENT_MOTION } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/agent-cursor.ts"))};
`);
const bundled = path.join(scratch, "marks.cjs");
esbuild().buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: bundled });

const { app, BrowserWindow } = require("electron");
const { createBrowserPane, BrowserAgentHost, AGENT_CURSOR, AGENT_MOTION } = require(bundled);
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
/** The target's box in the view's own coordinates, fixed in the page so nothing has to be measured. */
const TARGET = { left: 20, top: 20, w: 160, h: 44 };
const CENTRE = { x: TARGET.left + TARGET.w / 2, y: TARGET.top + TARGET.h / 2 };

/* A BUTTON, not an anchor. The mark lives in the page's DOM, so a target that navigates would take
   the very thing under test away with it — and the run would pass its "gone" assertion for the
   wrong reason. */
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>marks page</title>
<body style="margin:0;background:#f4f4f5;font:14px sans-serif">
  <button id="target" type="button" style="position:fixed;left:${TARGET.left}px;top:${TARGET.top}px;
    width:${TARGET.w}px;height:${TARGET.h}px;background:#e4e4e7;border:1px solid #a1a1aa;color:#18181b"
    onclick="window.__hits=(window.__hits||0)+1">Sign in</button>
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
    /** Accent pixels inside a DIP box, and their centroid back in DIP. */
    box(x0, y0, x1, y1) {
      let n = 0, sx = 0, sy = 0;
      for (let y = Math.max(0, Math.round(y0 * scale)); y < Math.min(height * scale, Math.round(y1 * scale)); y++) {
        for (let x = Math.max(0, Math.round(x0 * scale)); x < Math.min(dw, Math.round(x1 * scale)); x++) {
          if (at(x, y)) { n++; sx += x; sy += y; }
        }
      }
      return { n, cx: n ? sx / n / scale : NaN, cy: n ? sy / n / scale : NaN };
    },
  };
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

  // The ref every downstream op speaks in. Resolved here rather than through a snapshot so that a
  // change in how snapshots are formatted cannot break a check that is about pixels.
  const binding = pane.attachCdp("b1");
  const { root } = await binding.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await binding.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#target" });
  const { node } = await binding.send("DOM.describeNode", { nodeId });
  const ref = node.backendNodeId;
  ok("resolved the target's ref", ref > 0, `ref=${ref}`);

  // ---- the drive ----
  host.setAccent(ACCENT);
  const result = await host.handleOp("act", { browserId: "b1", action: { kind: "click", ref, button: "left", clickCount: 1, modifiers: [] } });
  ok("the act itself succeeded", result && result.ok === true, JSON.stringify(result));
  ok("…and the click actually reached the page", (await pageWc.executeJavaScript("window.__hits || 0")) === 1);

  // Long enough for the 180ms fade-in and the 120ms press to have finished, and well short of the
  // 900ms ring TTL and the dwell watchdog.
  await sleep(600);
  const during = await accentMask(pageWc);
  log(`capture: ${during.dw}x${during.dh} device px at ${during.scale}x`);

  // A crop of the mark itself, for the eye. design.md's review loop asks for the rendered result,
  // and no pixel count says whether a 14px disc reads as a lit point or as a smudge. Written only
  // when REALM_LIVE_CROP names a path, so an ordinary run leaves nothing behind.
  if (process.env.REALM_LIVE_CROP) {
    const shot = await pageWc.capturePage({ x: 0, y: 0, width: 220, height: 100 });
    fs.writeFileSync(process.env.REALM_LIVE_CROP, shot.resize({ width: 880, quality: "best" }).toPNG());
    log(`crop written to ${process.env.REALM_LIVE_CROP}`);
  }


  /* 1 + 2: the cursor, at the point. A ±8 DIP box around the element's centre, which the ring cannot
     reach — the element is 160x44, so its own edges are 20px and better away from this box. */
  const near = during.box(CENTRE.x - 8, CENTRE.y - 8, CENTRE.x + 8, CENTRE.y + 8);
  ok("the cursor is painted, in the accent the renderer pushed", near.n > 0, `${near.n} accent px at the centre`);
  const off = Math.hypot(near.cx - CENTRE.x, near.cy - CENTRE.y);
  ok("…centred on the element the input went to, within a pixel",
    near.n > 0 && off <= 1.5, `centroid (${near.cx.toFixed(2)}, ${near.cy.toFixed(2)}) vs (${CENTRE.x}, ${CENTRE.y}) — off by ${off.toFixed(2)}px`);

  /* 3: the ring, at the element's edge and NOT at its centre. The split is the feature: one mark
     says "this element", the other says "this point". */
  const edge = during.box(TARGET.left - 5, CENTRE.y - 2, TARGET.left - 1, CENTRE.y + 2);
  ok("the ring is drawn at the element's edge, beside the cursor rather than instead of it",
    edge.n > 0, `${edge.n} accent px just outside the left edge`);

  // 4: the controlled-screen frame, at the view's own edges.
  const top = during.box(200, 0, 600, 3);
  const bottom = during.box(200, VIEW.height - 3, 600, VIEW.height);
  ok("the controlled-screen frame reaches the view's edges", top.n > 0 && bottom.n > 0, `top=${top.n} bottom=${bottom.n}`);

  /* 5: the page's own dwell watchdog. Nothing here tells the page to clean up — that is the point.
     A dead bridge, a crashed host or a lost driving:false must not be able to leave a pointer on
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
