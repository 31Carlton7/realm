/**
 * Live check for picking an element INSIDE a streamed device.
 *
 *   BrowserAgentHost.pickElement → the surface `<canvas>`/`<img>` → serve-sim's /ax → a device chip
 *
 * The unit tests own the arithmetic (`device-ax.test.ts`) and the prompt block (`chips.test.ts`).
 * What only a real run can settle is the join: that the point the picker reports is measured against
 * the same box the stream is drawn into, so the element the user aimed at is the element that comes
 * back. Every off-by-a-scale-factor bug lives exactly there and none of it is visible in a fixture.
 *
 * The target is chosen FROM the tree at run time rather than hard-coded, so this proves the mapping
 * whatever the simulator happens to be showing.
 *
 * Requires a booted simulator with `serve-sim` running (default http://127.0.0.1:3200); skips with a
 * clear message when there is none, because that is a missing fixture, not a failure.
 *
 * Run:  apps/desktop/node_modules/.bin/electron apps/desktop/scripts/device-picker-live.cjs
 *
 * Hygiene: scratch userData + REALM_HOME under mkdtemp, removed at exit. Read-only against the
 * simulator — it picks, it never taps.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-device-picker-live-"));
process.env.REALM_HOME = path.join(scratch, "home");
const SIM_URL = process.env.LIVE_SIM_URL ?? "http://127.0.0.1:3200";
const OVERALL_TIMEOUT_MS = 60_000;

let failures = 0;
const log = (m) => console.log(`  ${m}`);
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same resolver `element-picker-live.cjs` uses: pnpm nests esbuild under `.pnpm/<name>@<version>`,
 *  so there is nothing to require at the workspace root. */
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
  export { readAxSnapshot, axElementAt } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/device-ax.ts"))};
`);
const bundled = path.join(scratch, "device-picker.cjs");
esbuild().buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: bundled });

const { app, BrowserWindow } = require("electron");
const { createBrowserPane, BrowserAgentHost, readAxSnapshot, axElementAt } = require(bundled);
app.setPath("userData", path.join(scratch, "userData"));
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

/** The stream surface's box in the page's own coordinates — the box a normalized point is measured
 *  against. Found by tag, which is what serve-sim draws into; its wrapper carries no stable hook. */
const SURFACE_RECT_JS = `(() => {
  const el = document.querySelector("canvas") || document.querySelector("img[src*='stream'], img");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
})()`;

async function clickAt(wc, x, y) {
  wc.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
  await sleep(200);
  for (const type of ["mouseDown", "mouseUp"]) {
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
  }
  await sleep(300);
}

async function main() {
  const snap = await readAxSnapshot(SIM_URL);
  if (!snap || snap.elements.length === 0) {
    console.log(`SKIP no device tree at ${SIM_URL}/ax — boot a simulator and run \`npx serve-sim@latest --detach <udid>\``);
    return;
  }
  log(`device tree: ${snap.elements.length} elements in a ${snap.screen.width}×${snap.screen.height} point screen`);

  /* The target: the SMALLEST labelled element on screen. Smallest because it is the one a container
     would shadow if the resolver preferred the first containing frame, so aiming here tests the rule
     that matters rather than a comfortable one. */
  const labelled = snap.elements.filter((e) => e.label && e.frame.width > 8 && e.frame.height > 8);
  if (labelled.length === 0) { console.log("SKIP the device tree has no labelled elements"); return; }
  const target = labelled.reduce((a, b) => (a.frame.width * a.frame.height <= b.frame.width * b.frame.height ? a : b));
  log(`target: ${target.role} ${JSON.stringify(target.label)} at ${JSON.stringify(target.frame)}`);

  const win = new BrowserWindow({ width: 900, height: 800, show: true });
  await win.loadURL("data:text/html,<title>host</title>");
  const pane = createBrowserPane(win);
  const host = new BrowserAgentHost({
    attach: (id) => pane.attachCdp(id),
    hasView: (id) => pane.hasView(id),
    navigate: (id, url) => pane.host.navigate(id, url),
    pageState: (id) => pane.pageState(id),
    touch: () => {},
  });
  pane.onViewDestroyed((id) => host.release(id));

  pane.host.create("b1", SIM_URL, null);
  pane.host.setBounds("b1", { x: 0, y: 0, width: 880, height: 760 }, 1, true);
  await sleep(1500);
  const view = win.contentView.children.find((c) => c.webContents);
  if (!view) throw new Error("the pane created no WebContentsView");
  const wc = view.webContents;
  // The stream needs a moment to connect before the surface has its fitted size.
  for (let i = 0; i < 20 && !(await wc.executeJavaScript(SURFACE_RECT_JS)); i++) await sleep(500);
  const rect = await wc.executeJavaScript(SURFACE_RECT_JS);
  ok("the page draws a stream surface", !!rect && rect.w > 50 && rect.h > 50, JSON.stringify(rect));
  if (!rect) return;
  log(`surface: <${rect.tag}> ${JSON.stringify(rect)}`);

  // The target's centre, device points → normalized → the page's own pixels.
  const nx = (target.frame.x + target.frame.width / 2) / snap.screen.width;
  const ny = (target.frame.y + target.frame.height / 2) / snap.screen.height;
  const px = rect.x + nx * rect.w, py = rect.y + ny * rect.h;
  log(`aiming at normalized (${nx.toFixed(4)}, ${ny.toFixed(4)}) → page (${px.toFixed(1)}, ${py.toFixed(1)})`);

  const pending = host.pickElement("b1");
  await sleep(400);
  await clickAt(wc, px, py);
  const picked = await Promise.race([pending, sleep(8000).then(() => "TIMEOUT")]);

  ok("the pick resolved", picked && picked !== "TIMEOUT", typeof picked === "string" ? picked : "");
  if (!picked || picked === "TIMEOUT") return;

  ok("it came back as a DEVICE element, not the canvas", !!picked.device,
    `device=${JSON.stringify(picked.device ?? null)} tag=${picked.tag} role=${picked.role} selector=${JSON.stringify(picked.selector)}`);
  if (picked.device) {
    // The join this whole script exists for: the element the click mapped to is the element aimed at.
    ok("it is the element that was aimed at", picked.device.id === target.id,
      `got ${JSON.stringify(picked.device.id)} want ${JSON.stringify(target.id)}`);
    ok("the chip is named by the device, not by the tag", picked.name === target.label && !!picked.role,
      `role=${picked.role} name=${JSON.stringify(picked.name)}`);
    ok("no selector and no markup are claimed for it", picked.selector === "" && picked.html === "",
      `selector=${JSON.stringify(picked.selector)} html=${JSON.stringify(picked.html)}`);
    ok("the frame travels in device points", picked.device.frame.width === target.frame.width, JSON.stringify(picked.device.frame));
    // rect is the pane's units everywhere else in a picked element; a device chip must not be the
    // one field measured in points.
    ok("the rect is in the pane's own pixels", picked.rect.w > 0 && picked.rect.w <= rect.w + 1 && picked.rect.x >= rect.x - 1,
      `rect=${JSON.stringify(picked.rect)} surface=${JSON.stringify(rect)}`);
  }
  ok("the url is the pane's, so the chip's origin is still a fact", picked.url.startsWith(SIM_URL), picked.url);
}

const bail = setTimeout(() => { console.log("FAIL overall timeout"); process.exit(1); }, OVERALL_TIMEOUT_MS);
app.whenReady()
  .then(main)
  .catch((e) => { console.log(`FAIL ${e && e.stack ? e.stack : e}`); failures++; })
  .finally(() => {
    clearTimeout(bail);
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
    app.exit(failures === 0 ? 0 : 1);
  });
