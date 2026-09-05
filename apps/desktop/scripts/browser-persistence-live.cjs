/**
 * Live check for browser-pane persistence across a space switch
 * (run with: apps/desktop/node_modules/.bin/electron apps/desktop/scripts/browser-persistence-live.cjs)
 *
 * jsdom can prove which methods the pane calls; only the real Electron binary can prove what those
 * methods do to a renderer process. Against the REAL BrowserPaneHost/electronViewFactory (compiled
 * from src/main at startup) and a `data:` page this file authors:
 *   1. retain does not destroy — the WebContentsView and its webContents are still alive after the
 *      pane that was showing it goes away
 *   2. the retained view is HIDDEN — persisting is about the process, not about pixels leaking over
 *      whatever space the user actually switched to
 *   3. the retained page keeps WORKING — a 50ms interval keeps ticking at full rate, which is only
 *      true because electronViewFactory turns background throttling off (default: ~1Hz)
 *   4. the retained view is still DRIVABLE — CDP Input.dispatchMouseEvent, the same call the agent
 *      executor makes, still lands a click on a view nobody can see
 *   5. coming back RE-ADOPTS rather than reloads — a runtime-only global, a typed-in form value and
 *      a scroll position all survive, which a reload would reset
 *   6. the off-screen budget is real — past RETAINED_VIEW_LIMIT the least-recently-used retained
 *      view is destroyed for real, not just forgotten
 *
 * Opens a small clearly-titled window for ~15s, uses only a scratch userData dir, touches no ports
 * and no network: the page is a data: URL below.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-persist-live-"));

// Compile the real main-process sources (TS) to CJS with the workspace's own esbuild.
function esbuild() {
  const pnpm = path.join(repoRoot, "node_modules/.pnpm");
  for (const d of fs.readdirSync(pnpm)) {
    if (!d.startsWith("esbuild@")) continue;
    try { return require(path.join(pnpm, d, "node_modules/esbuild")); } catch { /* next */ }
  }
  throw new Error("esbuild not found in node_modules/.pnpm");
}
const outfile = path.join(scratch, "browser-pane.cjs");
esbuild().buildSync({
  entryPoints: [path.join(repoRoot, "apps/desktop/src/main/browser-pane.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile,
});
const hostOut = path.join(scratch, "browser-host.cjs");
esbuild().buildSync({
  entryPoints: [path.join(repoRoot, "apps/desktop/src/main/browser-host.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: hostOut,
});

const { app, BrowserWindow } = require("electron");
const { createBrowserPane } = require(outfile);
const { RETAINED_VIEW_LIMIT } = require(hostOut);

app.setPath("userData", path.join(scratch, "userData")); // persist:browser lands here, not in any real profile
// Cases destroy their windows as they go; without this the app quits on the first one and the rest
// of the checks silently never run.
app.on("window-all-closed", () => {});

/** The page under test. Tall enough to scroll, with a click counter and a free-running interval. */
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<div id="hit" style="width:360px;height:120px;background:#c0392b;color:#fff">click target</div>
<input id="typed" value="">
<div style="height:4000px">scroll me</div>
<script>
  window.__clicks = 0; window.__ticks = 0;
  document.getElementById('hit').addEventListener('click', () => { window.__clicks++; });
  setInterval(() => { window.__ticks++; }, 50);
</script></body></html>`)}`;

const out = { electron: process.versions.electron, retainedLimit: RETAINED_VIEW_LIMIT, checks: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    // The REAL window recipe (vibrancy + transparent paint on macOS) at a small size.
    const win = new BrowserWindow({
      width: 700, height: 560, x: 60, y: 60, title: "Realm browser-persistence live check (auto-closes)",
      ...(process.platform === "darwin" ? { vibrancy: "sidebar", backgroundColor: "#00000000" } : { backgroundColor: "#17181a" }),
    });
    // A DOM decoy under the view's rect, so check 2 can tell "hidden" from "still painting".
    await win.webContents.loadURL(`data:text/html,${encodeURIComponent(
      `<body style="margin:0;background:#111"><div style="position:absolute;left:0;top:0;width:360px;height:240px;background:#1e8e3e"></div></body>`)}`);

    const pane = createBrowserPane(win);
    const host = pane.host;
    const destroyed = [];
    pane.onViewDestroyed((id) => destroyed.push(id));

    // --- the pane mounts: create + a bounds sync carrying the renderer's visibility verdict -------
    host.create("b1", "about:blank", null);
    host.setBounds("b1", { x: 0, y: 0, width: 360, height: 240 }, 2, true);
    const cdp = pane.attachCdp("b1"); // exactly what BrowserAgentHost attaches through
    const evalIn = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
      return r && r.result ? r.result.value : undefined;
    };
    const click = async (x, y) => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", {
          type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
        });
      }
    };
    // normalizeAddress would https-prefix a data: URL, so the page arrives the way a page always
    // does once a view exists — as a navigation of the live view, not as create's initial load.
    await cdp.send("Page.navigate", { url: PAGE });
    await sleep(700);

    // State that only exists at runtime: a reload resets every one of these.
    await evalIn("window.__survived = 'set-before-the-switch'");
    await evalIn("document.getElementById('typed').value = 'half-filled form'");
    // Click BEFORE scrolling: #hit sits at the top of the document, and CDP mouse coordinates are
    // viewport-relative, so a click at (40,40) after scrolling 1200px lands on nothing.
    await click(40, 40);
    await evalIn("window.scrollTo(0, 1200)");
    const before = {
      clicks: await evalIn("window.__clicks"),
      ticks: await evalIn("window.__ticks"),
      scrollY: await evalIn("window.scrollY"),
    };

    // --- the space switch: the pane unmounts, so the renderer releases the view ------------------
    host.retain("b1");
    await sleep(300);

    out.checks.retainSurvives = { alive: pane.hasView("b1"), destroyedSoFar: [...destroyed] };

    // Hidden, not merely un-synced: sample the screen where the view was and expect the DOM decoy's
    // green, never the page's red. (getVisible is asserted too — the cheap half of the same claim.)
    const view = win.contentView.children[win.contentView.children.length - 1];
    let sampled = null;
    try {
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 60, height: 60 });
      const bmp = img.toBitmap(); // BGRA
      sampled = { b: bmp[0], g: bmp[1], r: bmp[2] };
    } catch (e) { sampled = { error: String(e) }; }
    out.checks.retainedIsInvisible = {
      getVisible: typeof view.getVisible === "function" ? view.getVisible() : "unavailable",
      sampled,
      // The decoy is #1e8e3e; the page's target is #c0392b. Green wins = the view is not painting.
      showsDecoyNotPage: !!sampled && sampled.g > sampled.r,
    };

    // --- requirement 4: it works in the background ----------------------------------------------
    await sleep(3000);
    const hiddenTicks = await evalIn("window.__ticks");
    const ticksPerSec = Math.round(((hiddenTicks - before.ticks) / 3) * 10) / 10;
    out.checks.keepsRunningWhileHidden = {
      ticksPerSec, // ~20 unthrottled, ~1 if Chromium is backgrounding it
      unthrottled: ticksPerSec > 10,
      visibilityStateSeenByPage: await evalIn("document.visibilityState"),
    };

    // --- requirement 2: still drivable while off screen ------------------------------------------
    await evalIn("window.scrollTo(0, 0)"); // bring #hit back under the pointer, then put it back
    await click(40, 40);
    await sleep(200);
    await evalIn(`window.scrollTo(0, ${before.scrollY})`);
    const hiddenClicks = await evalIn("window.__clicks");
    await evalIn("document.title = 'driven-while-off-screen'");
    out.checks.drivableWhileHidden = {
      clicksBefore: before.clicks, clicksAfter: hiddenClicks,
      inputLanded: hiddenClicks > before.clicks,
      pageStateReadsBack: pane.pageState("b1"),
    };

    // --- switching back: re-adopt, do not reload --------------------------------------------------
    host.create("b1", "about:blank", null); // the pane remounts and re-adopts
    host.setBounds("b1", { x: 0, y: 0, width: 360, height: 240 }, 2, true);
    await sleep(500);
    out.checks.readoptedWithoutReload = {
      survivedGlobal: await evalIn("window.__survived"),
      formValue: await evalIn("document.getElementById('typed').value"),
      scrollY: await evalIn("window.scrollY"), scrollYBefore: before.scrollY,
      clicks: await evalIn("window.__clicks"),
      visibleAgain: typeof view.getVisible === "function" ? view.getVisible() : "unavailable",
      // All four are runtime-only. A reload would show undefined / "" / 0 / 0.
      noReload: (await evalIn("window.__survived")) === "set-before-the-switch"
        && (await evalIn("document.getElementById('typed').value")) === "half-filled form"
        && (await evalIn("window.scrollY")) === before.scrollY,
    };

    // --- the off-screen budget, against real renderer processes -----------------------------------
    const extra = [];
    for (let i = 0; i < RETAINED_VIEW_LIMIT + 1; i++) {
      const id = `e${i}`;
      extra.push(id);
      host.create(id, "about:blank", null);
    }
    for (const id of extra) host.retain(id); // e0 is now the least recently retained
    await sleep(400);
    out.checks.budgetEvictsLru = {
      limit: RETAINED_VIEW_LIMIT,
      evicted: destroyed.filter((id) => id !== "b1"),
      stillAlive: extra.filter((id) => pane.hasView(id)),
      oldestEvicted: !pane.hasView("e0"),
      newestKept: pane.hasView(`e${RETAINED_VIEW_LIMIT}`),
      // b1 has a pane on it (re-adopted above), so it is not in the budget at all.
      readoptedViewNotEvictable: pane.hasView("b1"),
    };

    win.destroy();
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  console.log(`PERSIST_LIVE ${JSON.stringify(out, null, 2)}`);
  app.exit(out.error ? 1 : 0);
});
