#!/usr/bin/env node
/**
 * Replace the locally installed Realm.app with the newest unpacked electron-builder output.
 *
 * This is deliberately separate from electron-updater: local builds are unsigned and do not have
 * a public update feed, so Squirrel cannot safely install them. `pnpm app:update` builds first, then
 * runs this script to perform a guarded, rollback-capable swap.
 *
 * What it leaves behind: the build it copied FROM, still sitting in `apps/desktop/release/`, still
 * claiming `co.charmtechnologies.realm`. macOS registers it, and once several bundles claim one
 * identifier a lookup by that identifier can resolve to any of them — which is how notification
 * banners end up wearing an app icon several versions old. Nothing here is wrong to do; it just
 * accumulates. `pnpm app:icons` lists what is registered and can drop everything but the installed
 * app. See scripts/icon-registrations.mjs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_NAME = "Realm.app";
const BUNDLE_ID = "co.charmtechnologies.realm";

/** Find the newest unpacked Realm.app. electron-builder names the parent directory by architecture. */
export function findBuiltApp(releaseDir) {
  if (!existsSync(releaseDir)) throw new Error(`build output does not exist: ${releaseDir}`);
  const candidates = [];
  const add = (path) => {
    if (existsSync(path)) candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
  };
  add(join(releaseDir, APP_NAME));
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (entry.isDirectory()) add(join(releaseDir, entry.name, APP_NAME));
  }
  if (!candidates.length) {
    throw new Error(`no unpacked ${APP_NAME} found under ${releaseDir}; run pnpm dist:dir first`);
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return candidates[0].path;
}

/** Pure paths for the atomic swap. Keeping both siblings means every rename stays on one volume. */
export function installPaths(target, pid) {
  const parent = dirname(target);
  const leaf = basename(target);
  return {
    staging: join(parent, `.${leaf}.install-${pid}`),
    backup: join(parent, `.${leaf}.previous-${pid}`),
  };
}

/** The prefix every kept-behind bundle wears, so the sweep can find them without guessing. */
export const backupPrefix = (target) => `.${basename(target)}.previous-`;

/**
 * Which of the kept bundles may be deleted.
 *
 * A previous bundle is kept, not removed, when the install finishes: a daemon started from it is
 * still running out of it, and deleting the path a live process exec'd from is how a draining
 * daemon's next agent spawn fails. `entry` is what the running daemon says it is running — from its
 * own state file — and the bundle containing it is the one that has to survive.
 *
 * Pure, and over paths only, so the rule is testable without a filesystem or a daemon.
 */
export function sweepable(backups, entry) {
  if (!entry) return backups;
  return backups.filter((path) => !entry.startsWith(`${path}/`));
}

/**
 * Whether installing `built` over `installed` would cost the owner their macOS permissions — and in
 * words, when it would. Null when it would not.
 *
 * macOS keys every grant Realm holds (Accessibility, Screen Recording, Automation, Calendar,
 * Contacts, Reminders) to the app's code signature: for a Developer ID app, to its team. A build
 * signed by no team — or by another — is a different app to TCC, and installing it over the signed
 * one drops them all at once. MEASURED in the owner's words, 09-12: "The permission grants always
 * disappear for the mac apps" — every `pnpm app:update` built unsigned. A signed build keeps them;
 * so does replacing an app that was never signed, which had nothing stable to keep.
 *
 * Teams are what `codesign` reports (`TeamIdentifier=`), null for unsigned or ad-hoc. Pure.
 */
export function permissionReset({ installedTeam, builtTeam, allowReset }) {
  if (!installedTeam || builtTeam === installedTeam || allowReset) return null;
  const built = builtTeam ? `is signed by team ${builtTeam}` : "is unsigned";
  return `the installed Realm is signed by team ${installedTeam} and this build ${built}. Installing it would reset `
    + "every macOS permission Realm holds (Accessibility, Screen Recording, Automation, Calendar, Contacts). "
    + "Build it signed — `pnpm app:update` signs with your Developer ID when ~/.config/realm-signing.env names it — "
    + "or set REALM_ALLOW_PERMISSION_RESET=1 to install it anyway.";
}

/**
 * Guarded install orchestration. `ops` is injected so tests prove ordering and rollback without
 * touching /Applications or launching Electron.
 */
export function installLocal({ source, target, pid, ops, log, allowReset = false }) {
  if (resolve(source) === resolve(target)) throw new Error("build output and install target are the same app");
  if (basename(source) !== APP_NAME || basename(target) !== APP_NAME) {
    throw new Error(`source and target must both be named ${APP_NAME}`);
  }
  if (!ops.exists(source)) throw new Error(`built app does not exist: ${source}`);
  ops.verifyBundle(source, BUNDLE_ID);
  // Before anything is quit or copied: a refusal here leaves the running app exactly as it was.
  const reset = permissionReset({ installedTeam: ops.exists(target) ? ops.signingTeam(target) : null, builtTeam: ops.signingTeam(source), allowReset });
  if (reset) throw new Error(reset);

  for (const stale of sweepable(ops.keptBundles(target), ops.daemonEntry())) {
    log(`[app:update] removing a previous bundle nothing is running from: ${stale}`);
    ops.remove(stale);
  }

  const running = ops.runningPids(target);
  if (running.length) {
    log(`[app:update] asking the installed app to quit (${running.join(", ")})…`);
    ops.quit(BUNDLE_ID);
    if (!ops.waitUntilStopped(running, 15_000)) {
      throw new Error("Realm did not quit within 15 seconds; quit it manually and run pnpm app:update again");
    }
  }

  const { staging, backup } = installPaths(target, pid);
  if (ops.exists(staging) || ops.exists(backup)) throw new Error("temporary install path already exists; refusing to overwrite it");

  let oldMoved = false;
  try {
    log(`[app:update] copying ${source}…`);
    ops.copy(source, staging);
    if (ops.exists(target)) {
      ops.move(target, backup);
      oldMoved = true;
    }
    ops.move(staging, target);
  } catch (error) {
    if (ops.exists(staging)) ops.remove(staging);
    if (oldMoved && !ops.exists(target) && ops.exists(backup)) ops.move(backup, target);
    throw error;
  }

  // The previous bundle is KEPT rather than removed. The daemon that outlived the app it was started
  // by is still executing out of it, and every agent it spawns from here on execs a path inside it —
  // deleting it now is how that spawn fails with ENOENT on a machine where nothing looks wrong.
  // Yesterday's bundles are swept at the start of the NEXT install, by which time the daemon holding
  // one has been replaced. Both halves are needed: sweeping only, and a live daemon loses its
  // binary; keeping only, and /Applications fills up.
  ops.launch(target);
  log(`[app:update] installed and relaunched ${target}`);
}

function commandOps() {
  const executable = (target) => join(target, "Contents", "MacOS", "Realm");
  return {
    exists: existsSync,
    /** The team a bundle is signed by, as codesign reports it (on stderr) — null when unsigned or ad-hoc. */
    signingTeam(app) {
      const r = spawnSync("codesign", ["-dv", "--verbose=2", app], { encoding: "utf8" });
      const team = /^TeamIdentifier=(.+)$/m.exec(r.stderr ?? "")?.[1]?.trim();
      return r.status === 0 && team && team !== "not set" ? team : null;
    },
    verifyBundle(source, expected) {
      const plist = join(source, "Contents", "Info.plist");
      const actual = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" }).trim();
      if (actual !== expected) throw new Error(`unexpected bundle id ${JSON.stringify(actual)} in ${source}`);
    },
    /**
     * The APP's processes — deliberately not the daemon's.
     *
     * realm-server runs under the same Electron binary (`ELECTRON_RUN_AS_NODE=1`), so its command
     * line begins with exactly this path and used to match. It must not: the quit below asks the APP
     * to quit, and the app quitting no longer stops the server, so counting the daemon here means
     * waiting fifteen seconds for something that was never asked to leave and then refusing to
     * install. Told apart by the argument, which is the server bundle it was handed.
     */
    runningPids(target) {
      if (!existsSync(target)) return [];
      const binary = executable(target);
      const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
      return lines.flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) return [];
        const command = match[2];
        if (command !== binary && !command.startsWith(`${binary} `)) return [];
        if (command.includes("server/dist/main.js")) return []; // the daemon, not the app
        return [Number(match[1])];
      });
    },
    /** Bundles a previous install kept behind, newest-first order not needed — the sweep is by path. */
    keptBundles(target) {
      const parent = dirname(target);
      const prefix = backupPrefix(target);
      try {
        return readdirSync(parent).filter((name) => name.startsWith(prefix)).map((name) => join(parent, name));
      } catch { return []; }
    },
    /** What the running daemon says it is executing, from its own state file. Null when none is. */
    daemonEntry() {
      try {
        const home = process.env.REALM_HOME ?? join(homedir(), "Realm");
        const state = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
        return typeof state.entry === "string" ? state.entry : null;
      } catch { return null; }
    },
    quit(bundleId) {
      execFileSync("osascript", ["-e", `tell application id "${bundleId}" to quit`], { stdio: "ignore" });
    },
    waitUntilStopped(pids, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const alive = pids.some((pid) => {
          try { process.kill(pid, 0); return true; } catch { return false; }
        });
        if (!alive) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      return false;
    },
    copy(source, destination) {
      execFileSync("ditto", [source, destination], { stdio: "inherit" });
    },
    move: renameSync,
    remove(path) { rmSync(path, { recursive: true, force: true }); },
    launch(target) { execFileSync("open", [target]); },
  };
}

function main() {
  if (process.platform !== "darwin") throw new Error("local app installation is only supported on macOS");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = findBuiltApp(join(root, "apps", "desktop", "release"));
  const target = process.env.REALM_APP_PATH || "/Applications/Realm.app";
  installLocal({ source, target, pid: process.pid, ops: commandOps(), log: console.log, allowReset: process.env.REALM_ALLOW_PERMISSION_RESET === "1" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`[app:update] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
