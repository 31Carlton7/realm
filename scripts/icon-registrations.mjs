#!/usr/bin/env node
/**
 * Find — and on request drop — the stale LaunchServices registrations of Realm's bundle id.
 *
 * The symptom is a notification banner wearing an OLD app icon while the Dock and Finder show the
 * current one. Nothing in the app decides that: `notify.ts` posts `{title, body}` and no icon, so
 * macOS resolves the picture from the bundle identifier. When several bundles on disk claim the same
 * identifier, it can resolve to one that is not the app you are running — and the icon you get is
 * whatever that build shipped with.
 *
 * Several bundles is the normal state of this repo, not an accident. `pnpm app:update` is
 * `dist:dir && install-local`: the package step writes `apps/desktop/release/mac-arm64/Realm.app`,
 * install-local copies it to /Applications, and the ORIGINAL stays where it was built. Do that in a
 * few worktrees over a few weeks and LaunchServices is holding a dozen registrations of
 * co.charmtechnologies.realm, most of them versions old. Measured on one machine: 14 registrations,
 * five still on disk, three carrying a pre-v0.5 icon — which is exactly the icon that turned up on
 * the banners.
 *
 * Read-only by default: it prints what is registered and says whether anything competes with the
 * installed app. `--fix` unregisters every duplicate and re-registers /Applications/Realm.app.
 *
 * It never DELETES a bundle. Unregistering is reversible — launching a build registers it again —
 * and some of what turns up here is deliberate (a rollback backup under ~/Realm/backups). Removing
 * files is a decision for whoever is reading the list.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
/** The one bundle the identifier is supposed to mean. Everything else registered under it competes. */
export const INSTALLED_APP = "/Applications/Realm.app";

/** The app id, read from the packaging config rather than repeated here — the two must not drift. */
export function bundleIdFrom(builderYml) {
  const m = /^appId:\s*(\S+)/m.exec(builderYml);
  if (!m) throw new Error("no appId in electron-builder.yml");
  return m[1];
}

/**
 * Parse `lsregister -dump` into the registrations of one bundle id.
 *
 * The dump is stanzas separated by rules of dashes, and a stanza's `identifier:` is the bundle id it
 * claims. Sub-bundles (the GPU and renderer helpers) carry their own suffixed ids and are left alone:
 * they are not what an icon lookup resolves, and unregistering them would only make the next launch
 * re-register them.
 */
export function parseRegistrations(dump, bundleId) {
  const out = [];
  for (const block of dump.split("--------------------------------------------------------")) {
    const id = /^identifier:\s+(\S+)/m.exec(block);
    if (!id || id[1] !== bundleId) continue;
    const path = /^path:\s+(.+?)\s*(?:\(0x[0-9a-f]+\))?$/m.exec(block);
    const version = /^version:\s+([^\s(]+)/m.exec(block);
    if (!path) continue;
    out.push({ path: path[1], version: version ? version[1] : "?" });
  }
  // One path can appear in more than one stanza; the path is the thing being registered.
  const seen = new Set();
  return out.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}

/** Which registrations compete with the installed app. A path that no longer exists still competes:
 *  the row is in the database whether or not the bundle is, and that is what resolution reads. */
export function competing(registrations, installed = INSTALLED_APP) {
  return registrations.filter((r) => resolve(r.path) !== resolve(installed));
}

function run(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }) }; }
  catch (e) { return { ok: false, out: String(e?.stderr ?? e?.message ?? e) }; }
}

async function main() {
  if (process.platform !== "darwin") { console.log("macOS only — nothing to do."); return; }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundleId = bundleIdFrom(readFileSync(join(repoRoot, "apps/desktop/electron-builder.yml"), "utf8"));
  const fix = process.argv.includes("--fix");

  const dump = run(LSREGISTER, ["-dump"]);
  if (!dump.ok) { console.error("could not read the LaunchServices database"); process.exitCode = 1; return; }
  const regs = parseRegistrations(dump.out, bundleId);
  const rivals = competing(regs);

  console.log(`${bundleId}: ${regs.length} registration(s)\n`);
  for (const r of regs) {
    const mark = resolve(r.path) === resolve(INSTALLED_APP) ? "installed" : "competing";
    console.log(`  v${r.version.padEnd(7)} ${existsSync(r.path) ? "on disk" : "gone   "}  ${mark.padEnd(9)}  ${r.path}`);
  }

  if (rivals.length === 0) {
    console.log(`\nOnly ${INSTALLED_APP} claims this id — notification icons resolve to it.`);
    return;
  }
  console.log(`\n${rivals.length} bundle(s) compete with ${INSTALLED_APP} for this identifier.`);
  console.log("A notification's icon can resolve to any of them.");
  if (!fix) { console.log("\nRe-run with --fix to unregister them (no files are deleted)."); return; }

  let dropped = 0;
  for (const r of rivals) {
    const res = run(LSREGISTER, ["-u", r.path]);
    console.log(`  ${res.ok ? "unregistered" : "could not unregister"}  ${r.path}`);
    if (res.ok) dropped++;
  }
  if (existsSync(INSTALLED_APP)) {
    console.log(run(LSREGISTER, ["-f", INSTALLED_APP]).ok
      ? `  re-registered  ${INSTALLED_APP}`
      : `  could not re-register  ${INSTALLED_APP}`);
  }
  // The banner agent caches what it resolved; it picks the new answer up on its next launch. Killing
  // it is not destructive — launchd restarts it, and no notification is lost, because the feed lives
  // in Realm's own database and the toast is only ever its last hop.
  run("killall", ["NotificationCenter"]);
  console.log(`\nDropped ${dropped} registration(s) and restarted NotificationCenter.`);
  console.log("The next banner should carry the installed app's icon.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; });
}
