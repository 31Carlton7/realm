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
 *     excludes Realm itself and System Settings (the refusal that matters most, checked live rather
 *     than assumed); a snapshot without the grant refuses with actionable words; acting on a snapshot
 *     that does not exist is refused; and the client recovers when the helper dies under it.
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

  // The refusals that matter most, observed rather than assumed. Realm is several processes sharing
  // one bundle id, and the helper is a descendant of one of them.
  const bundles = (apps.apps ?? []).map((a) => a.bundleId);
  ok("Realm never lists itself", !bundles.some((b) => b.includes("realm")), bundles.filter((b) => b.includes("realm")).join(", ") || "absent");
  ok("System Settings is never listed", !bundles.includes("com.apple.systempreferences"));
  // Named against the whole list rather than two entries: asserting Terminal.app and iTerm are absent
  // from a machine running neither passes without testing anything, and it did — Ghostty sat in the
  // app list, driveable, while this line was green.
  const leaked = bundles.filter((b) => FORBIDDEN.has(b));
  ok("no forbidden app is ever listed", leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(", ")}` : "none present");

  // The absence above cannot prove itself: `listApps` filters the forbidden set, so deriving "which
  // forbidden apps are running" from its own output is empty by construction whatever the helper
  // does. The refusal is what can be tested directly, and it does not depend on anything being up —
  // ask for one by name and require the refusal rather than an empty answer.
  // A snapshot refusal THROWS, where computerAct returns `{ok:false, refused}` — the two ops do not
  // answer the same way, so a check that only inspected a return value would read a throw as a pass.
  const refusals = [];
  for (const bundleId of ["com.apple.Terminal", "com.mitchellh.ghostty", "com.apple.systempreferences"]) {
    try {
      await host.handleOp("computerSnapshot", { bundleId });
      refusals.push(`${bundleId}=ALLOWED`);
    } catch (e) {
      refusals.push(`${bundleId}=${/never driveable/.test(e.message) ? "refused" : `other(${e.message.slice(0, 40)})`}`);
    }
  }
  ok("a forbidden app is refused BY NAME, whether or not it is running",
    refusals.every((r) => r.endsWith("=refused")), refusals.join(" "));

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

  // Clear first so the assertion does not depend on whatever the user last computed.
  const clear = snap.elements.find((e) => /^(AC|C|All Clear|Clear)$/i.test(e.name));
  if (clear) {
    await host.handleOp("computerAct", { snapshotId: snap.snapshotId, action: { kind: "click", index: clear.index, button: "left", clickCount: 1, modifiers: [] } });
    await sleep(400);
  }
  ok("Calculator exposes a clear button", Boolean(clear), clear ? `[${clear.index}] ${clear.name}` : "not found");

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
    const shows7 = after.elements.some((e) => e.value === "7" || (e.role === "AXStaticText" && e.value.trim() === "7"));
    ok("the click really landed — Calculator's display now reads 7", shows7,
      shows7 ? "" : `display values seen: ${after.elements.filter((e) => e.value).map((e) => e.value).slice(0, 8).join(" | ")}`);
  }

  // A stale index from the FIRST snapshot must now be refused or re-resolved, never acted on blindly.
  const staleIndex = await host.handleOp("computerAct", { snapshotId: snap.snapshotId, action: { kind: "click", index: 9999, button: "left", clickCount: 1, modifiers: [] } });
  ok("an index that never existed is refused", staleIndex.ok === false, staleIndex.error);

  helper.stop();
}
