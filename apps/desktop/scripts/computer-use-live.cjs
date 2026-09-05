/**
 * Live check for the computer-use stack — the REAL `ComputerUseHelper` and `ComputerUseHost` that
 * Electron main builds, over the REAL compiled Swift helper, against the REAL macOS running on this
 * machine:
 *
 *   this Electron process
 *      ComputerUseHost.handleOp ──▶ ComputerUseHelper (spawn + NDJSON) ──▶ native/bin/axhelper
 *         ──▶ Accessibility APIs / CGEvent / NSWorkspace
 *
 * These are the ops the host bridge delivers, so driving them here exercises everything except the
 * bridge's own relay (unit-tested) and the provider's argument handling (unit-tested against a fake
 * bridge). Provider REGISTRATION is covered by the server's `mcp.providers.list` integration test,
 * which boots a real app.
 *
 * Two tiers, because one of them needs a grant this machine may not have:
 *
 *   ALWAYS — the helper spawns and answers; grants are reported honestly; the app list is real and
 *     excludes the forbidden apps that LaunchServices says are actually up, and the app hosting this
 *     check, and is checked against a second inventory so an empty list cannot pass for a filtered
 *     one; a forbidden app is refused by name whether or not it is running; a snapshot without the
 *     grant refuses with actionable words; acting on a snapshot that does not exist is refused; and
 *     the client recovers when the helper dies under it.
 *
 *   ONLY WITH ACCESSIBILITY GRANTED — a real end-to-end drive of Calculator: snapshot it, press a
 *     digit by element index, and read the result back out of the accessibility tree. Calculator is
 *     the target on purpose: it has no documents, so nothing of the user's can be edited or saved.
 *     Skipped loudly, never silently, when the grant is absent.
 *
 * Run:  node apps/desktop/scripts/build-native.mjs && \
 *       apps/desktop/node_modules/.bin/electron apps/desktop/scripts/computer-use-live.cjs
 *
 * Hygiene: scratch userData under mkdtemp (removed at exit); no realm-server, no REALM_HOME, no
 * network; spawns exactly one helper child and stops it; never targets Realm's own window.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../../..");

/** The contract's forbidden list, read out of its source: this script is CommonJS and cannot import
 *  a TypeScript module. `computer-access.test.ts` is what holds this copy to the helper's own. */
const FORBIDDEN = (() => {
  const src = fs.readFileSync(path.join(repoRoot, "packages/contracts/src/computer-use.ts"), "utf8");
  const start = src.indexOf("COMPUTER_FORBIDDEN_BUNDLE_IDS = [");
  return new Set([...src.slice(start, src.indexOf("\n]", start)).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
})();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-computer-use-live-"));
const OVERALL_TIMEOUT_MS = 120_000;
const CALCULATOR = "com.apple.calculator";

let failures = 0;
let skipped = 0;
const results = [];
const ok = (label, cond, detail = "") => {
  results.push(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const skip = (label, why) => { results.push(`  SKIP  ${label} — ${why}`); skipped += 1; };
const log = (line) => console.log(`[live] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every bundle id LaunchServices currently has an application registered for.
 *
 * A second opinion about what is running, deliberately NOT `NSWorkspace.runningApplications` — that
 * is the enumeration `listApps` itself filters, so using it to check the filter would be asking the
 * same source twice. Returns null rather than an empty set when `lsappinfo` cannot be read, so a
 * missing tool is reported as a skip instead of as "nothing is running".
 */
/**
 * A JPEG's real pixel dimensions, from its SOF marker.
 *
 * Read rather than trusted, because the failure this exists to catch is a capture that succeeds and
 * returns the wrong thing: since macOS 15 the deprecated `CGWindowListCreateImage` answers an
 * ungranted caller with a black or desktop-only image instead of failing, and "some base64 came
 * back" cannot tell that apart from a real window. Comparing against the app's own AX frame can.
 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15 carry the frame header; C4 (Huffman tables), C8 (JPEG extensions) and CC
    // (arithmetic coding conditioning) share the range and are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function runningBundleIds() {
  try {
    const out = execFileSync("/usr/bin/lsappinfo", ["list"], { encoding: "utf8", maxBuffer: 32 << 20 });
    const ids = [...out.matchAll(/bundleID="([^"]+)"/g)].map((m) => m[1]);
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}

/**
 * The bundle id of the application hosting this check — what the helper's ancestry walk should
 * resolve to, read here from the bundle around `execPath` so the two are derived independently.
 * `defaults` rather than a plist parser because Info.plist is usually binary.
 */
const selfBundleId = (() => {
  const bundle = /^(.*?\.app)\//.exec(process.execPath);
  if (!bundle) return null;
  try {
    return execFileSync("/usr/bin/defaults", ["read", path.join(bundle[1], "Contents/Info"), "CFBundleIdentifier"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

// ---- compile the real main-process sources (TS) to CJS with the workspace's own esbuild ----
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
  export { ComputerUseHelper, axHelperPath } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/computer-use-helper.ts"))};
  export { ComputerUseHost } from ${JSON.stringify(path.join(repoRoot, "apps/desktop/src/main/computer-use-host.ts"))};
`);
const bundled = path.join(scratch, "computer-use.cjs");
esbuild().buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: bundled });

const { app } = require("electron");
const { ComputerUseHelper, ComputerUseHost } = require(bundled);
app.setPath("userData", path.join(scratch, "userData"));

const helperBin = path.join(repoRoot, "apps/desktop/native/bin/axhelper");

function cleanup() {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

function finish() {
  console.log(`\n[live] computer-use\n${results.join("\n")}`);
  console.log(`\n[live] ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}${skipped ? ` — ${skipped} skipped` : ""}\n`);
  cleanup();
  app.exit(failures === 0 ? 0 : 1);
}

const bail = setTimeout(() => { ok("overall timeout", false, `exceeded ${OVERALL_TIMEOUT_MS}ms`); finish(); }, OVERALL_TIMEOUT_MS);
bail.unref?.();

app.whenReady().then(async () => {
  try { await run(); } catch (e) { ok("uncaught", false, e && e.stack ? e.stack.split("\n")[0] : String(e)); }
  clearTimeout(bail);
  finish();
});

async function run() {
  if (!fs.existsSync(helperBin)) {
    ok("the native helper is built", false, `${helperBin} is missing — run scripts/build-native.mjs first`);
    return;
  }
  ok("the native helper is built", true);

  const helper = new ComputerUseHelper({ helperPath: () => helperBin, onLog: (l) => log(l) });
  const host = new ComputerUseHost({ available: () => helper.available, request: (m, p) => helper.request(m, p) });

  // ---- tier 1: no grant needed -------------------------------------------------------------
  const apps = await host.handleOp("computerListApps", {});
  const grants = { accessibility: apps.accessibility, screenRecording: apps.screenRecording };
  ok("the helper spawns and reports both grants honestly", typeof grants.accessibility === "boolean" && typeof grants.screenRecording === "boolean",
    `accessibility=${grants.accessibility} screenRecording=${grants.screenRecording}`);
  ok("the app list is real, with no Accessibility grant", Array.isArray(apps.apps) && apps.apps.length > 0,
    `${apps.apps?.length ?? 0} app(s) — NSWorkspace rather than the accessibility API, so an ungranted machine can still discover what is running`);

  // The refusals that matter most, observed against an INDEPENDENT inventory of what is running.
  //
  // `listApps` filters the forbidden set before it returns, so "no forbidden app is in the list"
  // is empty by construction: it reads the same green whether the filter works, whether the filter
  // is missing, and whether the list came back empty. LaunchServices is asked separately so each
  // absence below has a subject that is demonstrably running, and so a machine with no forbidden
  // app up is reported as SKIP rather than as proof.
  const listed = new Set((apps.apps ?? []).map((a) => a.bundleId));
  const running = runningBundleIds();
  if (!running) {
    skip("the app list excludes forbidden apps that are running", "lsappinfo did not answer, so nothing independent to compare against");
  } else {
    // The positive control. Without it every exclusion below would also pass on an empty list.
    const alsoRunning = [...listed].filter((b) => running.has(b));
    ok("the app list agrees with LaunchServices about what is running", alsoRunning.length > 0,
      `${alsoRunning.length} app(s) in both, e.g. ${alsoRunning.slice(0, 3).join(", ")}`);

    const forbiddenUp = [...FORBIDDEN].filter((b) => running.has(b));
    if (forbiddenUp.length === 0) {
      skip("the app list excludes forbidden apps that are running",
        "none of the forbidden bundle ids is running, so their absence proves nothing — the by-name refusal below is what covers this case");
    } else {
      const leaked = forbiddenUp.filter((b) => listed.has(b));
      ok("the app list excludes forbidden apps that are running", leaked.length === 0,
        leaked.length ? `LEAKED: ${leaked.join(", ")}` : `excluded while up: ${forbiddenUp.join(", ")}`);
    }
  }

  // Realm's own exclusion is derived from the helper's PROCESS ANCESTRY, not from the forbidden
  // list, and under a dev run the ancestor is Electron rather than Realm.app — so looking for
  // "realm" in the list tests the static entry and leaves the ancestry walk unexercised. The host
  // of this very check is the subject that exercises it.
  ok("the app hosting this check is excluded by ancestry, not by name",
    !(apps.apps ?? []).some((a) => a.pid === process.pid)
      && (selfBundleId === null || !listed.has(selfBundleId)),
    `host pid ${process.pid}${selfBundleId ? ` (${selfBundleId})` : " (bundle id unreadable)"}`);

  // The exclusions above can only speak for apps that happen to be up. The refusal can be tested
  // directly and unconditionally — ask for one by name and require a refusal rather than an empty
  // answer, so the rule is covered on a machine running none of them.
  // A snapshot refusal THROWS, where computerAct returns `{ok:false, refused}` — the two ops do not
  // answer the same way, so a check that only inspected a return value would read a throw as a pass.
  const byName = ["com.apple.Terminal", "com.mitchellh.ghostty", "com.apple.systempreferences"];
  const refusals = [];
  for (const bundleId of byName) {
    try {
      await host.handleOp("computerSnapshot", { bundleId });
      refusals.push(`${bundleId}=ALLOWED`);
    } catch (e) {
      refusals.push(`${bundleId}=${/never driveable/.test(e.message) ? "refused" : `other(${e.message.slice(0, 40)})`}`);
    }
  }
  // Length as well as content: `every` holds of an empty array, so a loop that stopped running
  // would report the same pass as three refusals.
  ok("a forbidden app is refused BY NAME, whether or not it is running",
    refusals.length === byName.length && refusals.every((r) => r.endsWith("=refused")), refusals.join(" "));

  // Acting on a snapshot the helper has never issued must refuse, not act on whatever matches.
  // Without the grant the trust check answers first, and deliberately so: "grant Accessibility" is
  // the more useful sentence when neither the grant nor the snapshot would have let this through.
  const stale = await host.handleOp("computerAct", { snapshotId: "ax_nonexistent", action: { kind: "click", index: 0, button: "left", clickCount: 1, modifiers: [] } });
  const expected = grants.accessibility ? "stale_snapshot" : "no_accessibility";
  ok("acting on an unknown snapshot is refused", stale.ok === false && stale.refused === expected, stale.error);

  if (!grants.accessibility) {
    // The ungranted path is a real supported state, so assert its words are useful.
    let refusedWell = false;
    try { await host.handleOp("computerSnapshot", { bundleId: CALCULATOR }); }
    catch (e) { refusedWell = /accessibility/i.test(e.message); }
    ok("a snapshot without the grant refuses with actionable words", refusedWell);
  }

  // The client must survive its child dying — the helper is killable by the OS at any time.
  helper.stop();
  const afterRestart = await host.handleOp("computerListApps", {});
  ok("the helper client respawns after the child is stopped", Array.isArray(afterRestart.apps));

  // ---- tier 2: needs the Accessibility grant -----------------------------------------------
  if (!grants.accessibility) {
    skip("end-to-end drive of Calculator", "macOS has not granted this app Accessibility — grant it in Realm's Settings → Permissions and re-run");
    helper.stop();
    return;
  }

  log("Accessibility is granted — driving Calculator end to end");
  // Launching it here rather than requiring it to be open: `open -g` leaves it in the background,
  // and the helper's own activation step is what brings it forward when acting.
  try { execFileSync("/usr/bin/open", ["-g", "-b", CALCULATOR]); } catch { /* asserted below */ }
  await sleep(2000);

  const snap = await host.handleOp("computerSnapshot", { bundleId: CALCULATOR });
  ok("Calculator's accessibility tree comes back indexed", snap.elements.length > 0, `${snap.elements.length} element(s)`);
  ok("the rendered listing is addressable", /^\[\d+\] AX/m.test(snap.text), snap.text.split("\n")[0] ?? "");

  // Clear first, so the digit assertion does not depend on whatever was last computed — including by
  // a previous run of this check. Escape rather than the clear BUTTON: Calculator relabels that
  // button from "All Clear" to "Clear" once a digit is entered, and "Clear" drops only the current
  // entry, so a run that followed another one started with digits still on the display. Escape is
  // always all-clear, and it exercises the `key` action, which no other tier here does.
  await host.handleOp("computerAct", { snapshotId: snap.snapshotId, action: { kind: "key", key: "Escape" } });
  await sleep(400);
  const cleared = await host.handleOp("computerSnapshot", { bundleId: CALCULATOR });
  const display = (elements) => {
    const shown = elements.filter((e) => e.value && /^-?[\d.,]+$/.test(e.value.trim()));
    return shown.length > 0 ? shown[shown.length - 1].value.trim() : "";
  };
  ok("a synthetic key press reaches the app — Escape clears Calculator", display(cleared.elements) === "0",
    `display reads ${display(cleared.elements) || "(nothing numeric)"}`);

  // Re-snapshot: the clear may have changed the tree, and acting on a stale index is exactly what
  // this design refuses to do.
  const fresh = await host.handleOp("computerSnapshot", { bundleId: CALCULATOR });
  const seven = fresh.elements.find((e) => e.name === "7");
  if (!seven) {
    ok("Calculator exposes a digit key", false, "no element named 7");
  } else {
    ok("Calculator exposes a digit key", true, `[${seven.index}]`);
    const click = await host.handleOp("computerAct", { snapshotId: fresh.snapshotId, action: { kind: "click", index: seven.index, button: "left", clickCount: 1, modifiers: [] } });
    ok("a synthetic click on a real app reports success", click.ok === true, click.ok ? click.detail : click.error);
    await sleep(500);
    // The proof: read the result back out of the tree rather than trusting the click's own report.
    const after = await host.handleOp("computerSnapshot", { bundleId: CALCULATOR });
    // Exactly 7, against a display that was just proven to read 0: "contains a 7" would also be true
    // of the 77 a previous run left behind.
    ok("the click really landed — Calculator's display now reads 7", display(after.elements) === "7",
      `display reads ${display(after.elements) || "(nothing numeric)"}`);
  }

  // A stale index from the FIRST snapshot must now be refused or re-resolved, never acted on blindly.
  const staleIndex = await host.handleOp("computerAct", { snapshotId: snap.snapshotId, action: { kind: "click", index: 9999, button: "left", clickCount: 1, modifiers: [] } });
  ok("an index that never existed is refused", staleIndex.ok === false, staleIndex.error);

  // ---- tier 3: ScreenCaptureKit, whose grant is separate from Accessibility ------------------
  //
  // Both outcomes are supported states and both are asserted. Screen Recording is OPTIONAL: without
  // it a snapshot must still return the tree and simply omit the image, because the tree is what
  // acting depends on. Failing the whole op would make an optional grant a required one.
  const shot = await host.handleOp("computerSnapshot", { bundleId: CALCULATOR, screenshot: true });
  ok("a snapshot asking for an image still returns the tree", shot.elements.length > 0, `${shot.elements.length} element(s)`);

  // The AX frame of Calculator's window, to measure the capture against.
  const window = shot.elements.find((e) => e.role === "AXWindow") ?? shot.elements[0];

  if (!grants.screenRecording) {
    ok("without Screen Recording the image is omitted, not failed", shot.screenshot === undefined,
      shot.screenshot === undefined ? "tree returned, screenshot absent" : "an image came back with no grant");
    skip("the capture is of the app's own windows", "macOS has not granted this app Screen Recording — grant it in Realm's Settings → Permissions and re-run");
  } else {
    const jpeg = typeof shot.screenshot === "string" ? Buffer.from(shot.screenshot, "base64") : null;
    ok("with Screen Recording the snapshot carries a real JPEG", jpeg !== null && jpeg.length > 0 && jpeg[0] === 0xff && jpeg[1] === 0xd8,
      jpeg ? `${jpeg.length} bytes` : "no screenshot field");
    const size = jpeg ? jpegSize(jpeg) : null;
    // Measured against the window's own accessibility frame rather than against the display: a
    // full-screen image would mean the filter captured the desktop, which is the exact wrong answer
    // ScreenCaptureKit was chosen over CGWindowListCreateImage to avoid.
    const near = (a, b) => Math.abs(a - b) <= Math.max(24, b * 0.2);
    ok("the capture is of the app's own windows", Boolean(size && window && near(size.width, window.w) && near(size.height, window.h)),
      size && window ? `captured ${size.width}×${size.height}, window is ${window.w}×${window.h}` : "no dimensions readable");
  }

  helper.stop();
}
