/**
 * Live check for Plan 11 W1 (run with: apps/desktop/node_modules/.bin/electron apps/desktop/scripts/browser-pane-live.cjs)
 *
 * Proves, against the real Electron binary and the REAL BrowserPaneHost/electronViewFactory code
 * (compiled from src/main at startup):
 *   1. create → navigate → state events (url/title/loading/canGoBack) arrive on the state channel
 *   2. bounds: setBounds(rect, dpr) lands the view exactly where the placeholder is
 *   3. window.open is denied as a window and funnels into an in-place navigation
 *   4. the allowlist blocks both host-initiated and page-initiated navigation
 *   5. destroy tears the view down (removed from contentView, webContents destroyed)
 *   6. layering vs vibrancy: the window is created EXACTLY like Realm's (vibrancy sidebar +
 *      transparent background) and a screen capture of the view's rect is sampled — the view must
 *      paint its own opaque pixels over the DOM decoy painted underneath it.
 *
 * Opens a small clearly-titled window for ~8s, uses only a scratch userData dir, touches no ports.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-browser-live-"));

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

const { app, BrowserWindow } = require("electron");
const { createBrowserPaneHost } = require(outfile);

app.setPath("userData", path.join(scratch, "userData")); // persist:browser lands here, not in any real profile

const out = { electron: process.versions.electron, checks: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, tag) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
  throw new Error(`timeout:${tag}`);
};

app.whenReady().then(async () => {
  try {
    // The REAL window recipe (vibrancy + transparent paint on macOS) at a small size.
    const win = new BrowserWindow({
      width: 700, height: 500, x: 60, y: 60, title: "Realm browser-pane live check (auto-closes)",
      ...(process.platform === "darwin" ? { vibrancy: "sidebar", backgroundColor: "#00000000" } : { backgroundColor: "#17181a" }),
    });
    // DOM decoy: a solid red box exactly where the view will sit. If layering worked, a screen
    // sample of that region shows the page's white, not this red (native views composite above DOM).
    await win.loadURL("data:text/html," + encodeURIComponent(
      `<body style="margin:0;background:#17181a;color:#eee;font:13px sans-serif">
         <div style="height:60px;padding:8px">Realm live check — chrome strip (DOM)</div>
         <div id=decoy style="position:fixed;left:60px;top:60px;width:600px;height:400px;background:#e0245e"></div>
       </body>`));

    const states = [];
    // createBrowserPaneHost wires sendState at win.webContents — capture via a tiny shim instead:
    const host = createBrowserPaneHost(win);
    // Shim: also mirror the state channel into this process (the renderer would receive these).
    const origSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (ch, payload) => { if (ch === "realm:browser-state") states.push(payload); origSend(ch, payload); };

    // 1. create + navigate + state channel
    host.create("b1", "https://example.com/", null);
    const rect = { x: 60, y: 60, width: 600, height: 400 };
    const scale = require("electron").screen.getDisplayMatching(win.getBounds()).scaleFactor;
    host.setBounds("b1", rect, scale /* dpr with zoom 1 */, true);
    await until(() => states.some((s) => s.id === "b1" && !s.loading && s.url.startsWith("https://example.com")), 15000, "load");
    const settled = states.findLast((s) => s.id === "b1");
    out.checks.state = { url: settled.url, title: settled.title, canGoBack: settled.canGoBack, events: states.length };

    // 2. bounds landed where the placeholder is
    const view = win.contentView.children[win.contentView.children.length - 1];
    out.checks.bounds = { set: rect, got: view.getBounds(), ok: JSON.stringify(view.getBounds()) === JSON.stringify(rect) };

    // 6. layering: screen-sample the view's center. Degrades honestly without screen-recording TCC.
    try {
      const wb = win.getBounds();
      const png = path.join(scratch, "shot.png");
      execFileSync("screencapture", ["-x", `-R${wb.x + 60},${wb.y + 60 + (wb.height - win.getContentSize()[1])},600,400`, png], { timeout: 5000 });
      const img = require("electron").nativeImage.createFromPath(png);
      const { width, height } = img.getSize();
      const bmp = img.toBitmap(); // BGRA
      const i = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
      const [b, g, r] = [bmp[i], bmp[i + 1], bmp[i + 2]];
      // example.com is white-ish; the decoy is #e0245e. Red decoy showing through = layering broken.
      const overDecoy = r > 180 && g < 100 && b < 130;
      out.checks.layering = { sampledRGB: [r, g, b], viewPaintsAboveDom: !overDecoy, size: { width, height } };
    } catch (e) {
      out.checks.layering = { skipped: String(e.message).slice(0, 120) };
    }
    // The view's own pixels, capturable regardless of TCC:
    const shot = await view.webContents.capturePage();
    out.checks.viewPaints = { size: shot.getSize(), nonEmpty: !shot.isEmpty() };

    // 3. window.open deny → in-place navigation
    const windowsBefore = BrowserWindow.getAllWindows().length;
    await view.webContents.executeJavaScript("window.open('https://example.org/'); true");
    await until(() => states.some((s) => s.id === "b1" && s.url.startsWith("https://example.org")), 15000, "window.open funnel");
    out.checks.windowOpen = { newWindows: BrowserWindow.getAllWindows().length - windowsBefore, navigatedInPlace: true };

    // 4. allowlist: block both paths
    host.setAllowlist("b1", ["https://example.org"]);
    const refused = host.navigate("b1", "https://example.com/blocked");
    await view.webContents.executeJavaScript("location.href = 'https://example.com/page-side'; true").catch(() => {});
    await sleep(1500);
    const urlNow = view.webContents.getURL();
    out.checks.allowlist = { hostPathRefused: refused === null, pageSideBlocked: !urlNow.includes("example.com"), urlNow };

    // 5. destroy
    const wc = view.webContents;
    host.destroy("b1");
    await until(() => wc.isDestroyed(), 5000, "destroy");
    out.checks.destroy = { children: win.contentView.children.length, webContentsDestroyed: wc.isDestroyed() };

    console.log("LIVE_RESULT " + JSON.stringify(out));
  } catch (e) {
    out.fatal = String(e && e.stack || e);
    console.log("LIVE_RESULT " + JSON.stringify(out));
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch */ }
  app.exit(0);
});
