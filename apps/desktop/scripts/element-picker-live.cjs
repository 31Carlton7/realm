/**
 * Live check for the USER's element picker, against a real Chrome.
 *
 *   BrowserAgentHost.pickElement → webContents.debugger CDP (Overlay) → a real WebContentsView
 *
 * Everything asserted here is a claim about Chrome's behaviour that no unit test against fake CDP
 * payloads can settle, and each one is load-bearing for a comment in `browser-agent.ts`:
 *
 *   1. inspect mode CONSUMES the picking click — the page's own handler never runs, so aiming at a
 *      link does not navigate. This is the whole reason Overlay was chosen over an injected listener.
 *   2. `Overlay.inspectNodeRequested` carries a backendNodeId the ordinary describe path resolves,
 *      and the page-side read produces a selector that finds the node again.
 *   3. Chrome does NOT leave inspect mode after emitting the event — a picker that does not disarm
 *      keeps eating the user's clicks. (If this one ever flips, the comment must flip with it.)
 *   4. `disarmElementPick` actually gives the page its clicks back.
 *
 * Run:  apps/desktop/node_modules/.bin/electron apps/desktop/scripts/element-picker-live.cjs
 *
 * Hygiene: scratch userData + REALM_HOME under mkdtemp, removed at exit; the page is a `data:` URL
 * this file authors, so no network and no port; no realm-server, no agent CLI, no real ~/Realm.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-element-picker-live-"));
process.env.REALM_HOME = path.join(scratch, "home");
const OVERALL_TIMEOUT_MS = 60_000;

let failures = 0;
const results = [];
const ok = (label, cond, detail = "") => {
  results.push(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const log = (line) => console.log(`[live] ${line}`);
/** Every exit path removes the scratch dir, including the timeout — a run that hung is exactly the
 *  run nobody comes back to clean up after. */
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
  export { armElementPick, disarmElementPick } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/browser-agent.ts"))};
`);
const bundled = path.join(scratch, "picker.cjs");
esbuild().buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: bundled });

const { app, BrowserWindow } = require("electron");
const { createBrowserPane, BrowserAgentHost, armElementPick, disarmElementPick } = require(bundled);
app.setPath("userData", path.join(scratch, "userData"));
// Same switch main/index.ts carries: an occluded window's WebContentsView drops synthetic input, and
// this script's window sits behind the terminal that launched it.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

/* The page. `#submit` is an anchor, so a click that reaches it BOTH navigates and records itself —
   either tell is enough to fail assertion 1. It is fixed at a known rect so the click needs no
   geometry lookup, which would otherwise require the very ref the picker is supposed to produce. */
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>picker page</title>
<body style="margin:0;font:14px sans-serif">
  <main id="root"><form id="login">
    <a id="submit" href="#navigated" style="position:fixed;left:20px;top:20px;width:160px;height:44px;
       display:grid;place-items:center;background:#eee" role="button"
       onclick="window.__hits=(window.__hits||0)+1">Sign in</a>
  </form></main>
</body>`)}`;
/** Centre of `#submit`, in the view's own coordinates. */
const CLICK = { x: 100, y: 42 };

/* Move THEN press. Chrome's inspect mode inspects the node it is currently hovering, which it learns
   from mouse moves; a bare press with no move before it has nothing highlighted and falls through to
   the page. A human always moves before they click, so this is the script matching reality rather
   than working around it. */
async function clickPage(wc) {
  wc.sendInputEvent({ type: "mouseMove", x: CLICK.x, y: CLICK.y });
  await sleep(200);
  for (const type of ["mouseDown", "mouseUp"]) {
    wc.sendInputEvent({ type, x: CLICK.x, y: CLICK.y, button: "left", clickCount: 1 });
  }
  await sleep(300);
}
const pageHits = (wc) => wc.executeJavaScript("window.__hits || 0");
const pageHash = (wc) => wc.executeJavaScript("location.hash");

async function main() {
  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  await win.loadURL("data:text/html,<title>host</title>");
  const pane = createBrowserPane(win);
  const host = new BrowserAgentHost({
    attach: (id) => pane.attachCdp(id),
    hasView: (id) => pane.hasView(id),
    navigate: (id, url) => pane.host.navigate(id, url),
    pageState: (id) => pane.pageState(id),
  });
  pane.onViewDestroyed((id) => host.release(id));

  // Created blank and navigated directly: `normalizeAddress` prefixes anything that is not http(s)
  // or about:blank, which is right for an address bar and wrong for a `data:` URL this file authors.
  // The picker is indifferent to how the page arrived.
  pane.host.create("b1", "about:blank", null);
  pane.host.setBounds("b1", { x: 0, y: 0, width: 800, height: 600 }, 1, true);
  await sleep(500);
  const view = win.contentView.children.find((c) => c.webContents);
  if (!view) throw new Error("the pane created no WebContentsView");
  const pageWc = view.webContents;
  await pageWc.loadURL(PAGE);
  await sleep(500);
  log(`page: ${await pageWc.getTitle()}`);
  ok("the test page loaded", (await pageWc.getURL()).startsWith("data:text/html"), await pageWc.getTitle());

  // ---- 1 + 2: arm, click, and see what comes back ----
  log("arming the picker");
  const pending = host.pickElement("b1");
  await sleep(400);
  await clickPage(pageWc);
  const picked = await Promise.race([pending, sleep(5000).then(() => "TIMEOUT")]);

  ok("a click in the view resolves the pick", picked && picked !== "TIMEOUT", JSON.stringify(picked));
  if (picked && picked !== "TIMEOUT") {
    ok("the picked element is named by AX, not by tag alone", picked.role === "button" && picked.name === "Sign in",
      `role=${picked.role} name=${JSON.stringify(picked.name)}`);
    ok("the selector found the node the user pointed at", picked.selector === "#submit", picked.selector);
    ok("the markup came back", picked.html.includes("Sign in") && picked.html.startsWith("<a"), picked.html.slice(0, 80));
    ok("the url is the webContents' own, not the page's word for it", picked.url.startsWith("data:text/html"), picked.url.slice(0, 30));
    ok("the rect is real geometry", picked.rect.w > 100 && picked.rect.h > 20, JSON.stringify(picked.rect));
  }
  ok("the picking click never reached the page — no handler ran", (await pageHits(pageWc)) === 0, `hits=${await pageHits(pageWc)}`);
  ok("…and the page did not navigate", (await pageHash(pageWc)) === "", `hash=${JSON.stringify(await pageHash(pageWc))}`);

  // ---- 3: does Chrome clear inspect mode by itself? ----
  log("re-arming by hand, to see whether Chrome self-clears");
  const binding = pane.attachCdp("b1");
  await armElementPick(binding.send);
  await sleep(300);
  let armedEvent = null;
  binding.onEvent((method, params) => { if (method === "Overlay.inspectNodeRequested") armedEvent = params; });
  await clickPage(pageWc);
  await sleep(400);
  const swallowedAfterEvent = (await pageHits(pageWc)) === 0;
  ok("Chrome leaves inspect mode ARMED after emitting inspectNodeRequested (the comment's claim)",
    swallowedAfterEvent && armedEvent !== null,
    swallowedAfterEvent ? "second click also swallowed" : "second click reached the page — Chrome DOES self-clear, fix the comment");

  // ---- 4: disarm gives the page its clicks back ----
  await disarmElementPick(binding.send);
  await sleep(300);
  await clickPage(pageWc);
  ok("after disarming, the page gets its clicks again", (await pageHits(pageWc)) >= 1, `hits=${await pageHits(pageWc)}`);

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
