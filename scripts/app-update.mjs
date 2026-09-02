#!/usr/bin/env node
/**
 * `pnpm app:update` — rebuild the desktop app and replace the copy in /Applications with it.
 * Local convenience only: `pnpm dist:dir` (unpacked Realm.app, no dmg), quit any running Realm,
 * swap /Applications/Realm.app for the fresh build, print the installed version.
 *
 *   --no-build   skip `pnpm dist:dir` and install whatever release/ already holds
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "apps", "desktop", "release");
const target = "/Applications/Realm.app";

if (process.platform !== "darwin") {
  console.error("[app:update] only knows how to install into /Applications on macOS");
  process.exit(1);
}

const noBuild = process.argv.includes("--no-build");
if (!noBuild) {
  console.log("[app:update] pnpm dist:dir…");
  execFileSync("pnpm", ["dist:dir"], { cwd: root, stdio: "inherit" });
}

// electron-builder names the unpacked dir by arch: mac-arm64 on Apple Silicon, plain mac on x64.
const candidates = [join(release, `mac-${process.arch}`, "Realm.app"), join(release, "mac", "Realm.app")];
const built = candidates.find((p) => existsSync(p));
if (!built) {
  console.error(`[app:update] no unpacked Realm.app under ${release} — run without --no-build`);
  process.exit(1);
}

const version = (app) => {
  const r = spawnSync("defaults", ["read", join(app, "Contents", "Info.plist"), "CFBundleShortVersionString"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
};
const before = existsSync(target) ? version(target) : "none";

// Ask nicely first (lets the app tear its server child down), then make sure it is gone.
if (spawnSync("pgrep", ["-x", "Realm"]).status === 0) {
  console.log("[app:update] quitting running Realm…");
  spawnSync("osascript", ["-e", 'tell application "Realm" to quit'], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (spawnSync("pgrep", ["-x", "Realm"]).status === 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  spawnSync("pkill", ["-x", "Realm"]);
}

// ditto, not cp: the bundle's frameworks are symlink-heavy and ditto preserves them and the
// extended attributes a .app relies on.
rmSync(target, { recursive: true, force: true });
execFileSync("ditto", [built, target], { stdio: "inherit" });

console.log(`[app:update] ${target}: ${before} → ${version(target)}`);
