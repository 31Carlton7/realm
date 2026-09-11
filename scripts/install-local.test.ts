import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { findBuiltApp, installLocal, installPaths, sweepable } from "./install-local.mjs";

describe("findBuiltApp", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("selects the newest unpacked Realm.app and ignores packaged artifacts", () => {
    const release = tempDir("realm-local-build-");
    dirs.push(release);
    const old = join(release, "mac", "Realm.app");
    const current = join(release, "mac-arm64", "Realm.app");
    mkdirSync(old, { recursive: true });
    mkdirSync(current, { recursive: true });
    utimesSync(old, new Date(1_000), new Date(1_000));
    utimesSync(current, new Date(2_000), new Date(2_000));
    expect(findBuiltApp(release)).toBe(current);
  });

  it("fails honestly when no directory build exists", () => {
    const release = tempDir("realm-local-build-");
    dirs.push(release);
    expect(() => findBuiltApp(release)).toThrow(/no unpacked Realm\.app/);
  });
});

describe("installLocal", () => {
  function harness(overrides: Partial<Record<string, unknown>> = {}) {
    const present = new Set(["/build/Realm.app", "/Applications/Realm.app"]);
    const calls: string[] = [];
    const ops = {
      exists: (path: string) => present.has(path),
      verifyBundle: (path: string, id: string) => calls.push(`verify ${path} ${id}`),
      runningPids: () => [41],
      keptBundles: () => [],
      daemonEntry: () => null,
      quit: () => calls.push("quit"),
      waitUntilStopped: () => true,
      copy: (_from: string, to: string) => { calls.push("copy"); present.add(to); },
      move: (from: string, to: string) => { calls.push(`move ${from} ${to}`); present.delete(from); present.add(to); },
      remove: (path: string) => { calls.push(`remove ${path}`); present.delete(path); },
      launch: () => calls.push("launch"),
      ...overrides,
    };
    const run = () => installLocal({ source: "/build/Realm.app", target: "/Applications/Realm.app", pid: 7, ops: ops as never, log: () => {} });
    return { calls, ops, present, run };
  }

  it("quits before copying, atomically swaps, KEEPS the previous bundle, then relaunches", () => {
    const h = harness();
    h.run();
    // MUTANT: remove the backup here and a daemon still executing out of it loses the path every
    // agent it spawns from now on execs from — ENOENT on a machine where nothing looks wrong.
    expect(h.calls).toEqual([
      "verify /build/Realm.app co.charmtechnologies.realm",
      "quit",
      "copy",
      "move /Applications/Realm.app /Applications/.Realm.app.previous-7",
      "move /Applications/.Realm.app.install-7 /Applications/Realm.app",
      "launch",
    ]);
  });

  it("sweeps yesterday's bundles first, and spares the one a daemon is running out of", () => {
    const kept = ["/Applications/.Realm.app.previous-1", "/Applications/.Realm.app.previous-2"];
    const h = harness({
      keptBundles: () => kept,
      daemonEntry: () => "/Applications/.Realm.app.previous-2/Contents/Resources/server/dist/main.js",
    });
    h.run();
    expect(h.calls).toContain("remove /Applications/.Realm.app.previous-1");
    expect(h.calls).not.toContain("remove /Applications/.Realm.app.previous-2");
    // Before the copy, so the disk is reclaimed before it is needed.
    expect(h.calls.indexOf("remove /Applications/.Realm.app.previous-1")).toBeLessThan(h.calls.indexOf("copy"));
  });

  it("does not touch the installed app when it refuses to quit", () => {
    const h = harness({ waitUntilStopped: () => false });
    expect(h.run).toThrow(/did not quit/);
    expect(h.calls).toEqual(["verify /build/Realm.app co.charmtechnologies.realm", "quit"]);
  });

  it("restores the previous app if promoting the staged build fails", () => {
    const paths = installPaths("/Applications/Realm.app", 7);
    const h = harness();
    let moves = 0;
    h.ops.move = ((from: string, to: string) => {
      h.calls.push(`move ${from} ${to}`);
      moves++;
      if (moves === 2) throw new Error("promotion failed");
      h.present.delete(from);
      h.present.add(to);
    }) as never;
    expect(h.run).toThrow(/promotion failed/);
    expect(h.present.has("/Applications/Realm.app")).toBe(true);
    expect(h.present.has(paths.staging)).toBe(false);
    expect(h.calls).toContain(`move ${paths.backup} /Applications/Realm.app`);
    expect(h.calls).not.toContain("launch");
  });
});

describe("sweepable", () => {
  it("keeps only the bundle the running daemon is executing out of", () => {
    const kept = ["/Applications/.Realm.app.previous-1", "/Applications/.Realm.app.previous-2"];
    expect(sweepable(kept, "/Applications/.Realm.app.previous-2/Contents/Resources/server/dist/main.js"))
      .toEqual(["/Applications/.Realm.app.previous-1"]);
  });

  it("sweeps everything when no daemon is running", () => {
    const kept = ["/Applications/.Realm.app.previous-1"];
    expect(sweepable(kept, null)).toEqual(kept);
  });

  it("does not spare a bundle merely because its path is a prefix of another", () => {
    // `.previous-1` is a string prefix of `.previous-12`; only a path SEGMENT boundary counts.
    expect(sweepable(["/Applications/.Realm.app.previous-1"], "/Applications/.Realm.app.previous-12/Contents/x"))
      .toEqual(["/Applications/.Realm.app.previous-1"]);
  });
});
