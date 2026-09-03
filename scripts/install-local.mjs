#!/usr/bin/env node
/**
 * Replace the locally installed Realm.app with the newest unpacked electron-builder output.
 *
 * This is deliberately separate from electron-updater: local builds are unsigned and do not have
 * a public update feed, so Squirrel cannot safely install them. `pnpm app:update` builds first, then
 * runs this script to perform a guarded, rollback-capable swap.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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

/**
 * Guarded install orchestration. `ops` is injected so tests prove ordering and rollback without
 * touching /Applications or launching Electron.
 */
export function installLocal({ source, target, pid, ops, log }) {
  if (resolve(source) === resolve(target)) throw new Error("build output and install target are the same app");
  if (basename(source) !== APP_NAME || basename(target) !== APP_NAME) {
    throw new Error(`source and target must both be named ${APP_NAME}`);
  }
  if (!ops.exists(source)) throw new Error(`built app does not exist: ${source}`);
  ops.verifyBundle(source, BUNDLE_ID);

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

  if (oldMoved && ops.exists(backup)) ops.remove(backup);
  ops.launch(target);
  log(`[app:update] installed and relaunched ${target}`);
}

function commandOps() {
  const executable = (target) => join(target, "Contents", "MacOS", "Realm");
  return {
    exists: existsSync,
    verifyBundle(source, expected) {
      const plist = join(source, "Contents", "Info.plist");
      const actual = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" }).trim();
      if (actual !== expected) throw new Error(`unexpected bundle id ${JSON.stringify(actual)} in ${source}`);
    },
    runningPids(target) {
      if (!existsSync(target)) return [];
      const binary = executable(target);
      const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
      return lines.flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return match && (match[2] === binary || match[2].startsWith(`${binary} `)) ? [Number(match[1])] : [];
      });
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
  installLocal({ source, target, pid: process.pid, ops: commandOps(), log: console.log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`[app:update] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
