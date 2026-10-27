import { describe, expect, it } from "vitest";
import { stopServerProcess, strayServers, runsServer, type ProcessOps } from "./daemon-stop";

/** A world of processes the test drives: who is alive, what they run, and what they do with signals. */
function world(procs: Record<number, { command: string; onTerm?: "exit" | "ignore"; group?: number[] }>, holding: Record<string, number[]> = {}) {
  const alive = new Set(Object.keys(procs).map(Number));
  const signals: string[] = [];
  let clock = 0;
  const ops: ProcessOps = {
    kill: (pid, signal) => {
      if (signal !== 0) signals.push(`${signal}:${pid}`);
      const target = Math.abs(pid);
      if (pid < 0) {
        // Only a group leader has a group by its pid.
        const leader = procs[target];
        if (!leader?.group || !alive.has(target)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        if (signal === "SIGKILL") for (const p of [target, ...leader.group]) alive.delete(p);
        return;
      }
      if (!alive.has(target)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === "SIGKILL") alive.delete(target);
      if (signal === "SIGTERM" && procs[target]!.onTerm !== "ignore") alive.delete(target);
    },
    commandOf: (pid) => (alive.has(pid) ? procs[pid]!.command : null),
    holding: (file) => (holding[file] ?? []).filter((p) => alive.has(p)),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    self: 1,
  };
  return { ops, alive, signals };
}

const SERVER = "/Applications/Realm.app/Contents/MacOS/Realm /Applications/Realm.app/Contents/Resources/server/dist/main.js";

describe("stopServerProcess", () => {
  it("is done when the server takes its SIGTERM", async () => {
    const w = world({ 50: { command: SERVER } });
    expect(await stopServerProcess(50, w.ops)).toBe(true);
    expect(w.signals).toEqual(["SIGTERM:50"]);
  });

  it("SIGKILLs a server whose shutdown hangs — and the agents in its group with it", async () => {
    // MUTANT: stop after SIGTERM's grace (what every hand-off did) and the old server lives on, running
    // from a Realm.app that is gone, holding the bundle so a fresh copy cannot be dragged over it.
    const w = world({ 50: { command: SERVER, onTerm: "ignore", group: [51, 52] }, 51: { command: "claude" }, 52: { command: "claude" } });
    expect(await stopServerProcess(50, w.ops, 1_000)).toBe(true);
    expect(w.signals).toEqual(["SIGTERM:50", "SIGKILL:-50"]);
    expect([...w.alive]).toEqual([]);
  });

  it("SIGKILLs the pid alone when it leads no group", async () => {
    const w = world({ 60: { command: SERVER, onTerm: "ignore" } });
    expect(await stopServerProcess(60, w.ops, 1_000)).toBe(true);
    expect(w.signals).toEqual(["SIGTERM:60", "SIGKILL:-60", "SIGKILL:60"]);
  });

  it("calls a pid that is already gone gone", async () => {
    expect(await stopServerProcess(70, world({}).ops)).toBe(true);
  });
});

describe("runsServer", () => {
  it("reads the pid's command line, and never says yes for this process or a gone one", () => {
    const w = world({ 1: { command: SERVER }, 50: { command: SERVER }, 51: { command: "/usr/bin/vim notes.md" } });
    expect(runsServer(50, "/server/dist/main.js", w.ops)).toBe(true);
    expect(runsServer(51, "/server/dist/main.js", w.ops)).toBe(false);
    expect(runsServer(1, "/server/dist/main.js", w.ops)).toBe(false); // ourselves
    expect(runsServer(99, "/server/dist/main.js", w.ops)).toBe(false);
  });
});

describe("strayServers", () => {
  it("finds the realm-servers holding a home's database that are not to be kept", () => {
    const home = "/Users/me/Realm";
    const w = world(
      { 50: { command: SERVER }, 51: { command: SERVER }, 52: { command: "sqlite3 /Users/me/Realm/realm.db" }, 53: { command: SERVER } },
      { "/Users/me/Realm/realm.db": [50, 51, 52], "/Users/me/Realm/realm.db-wal": [51, 53] },
    );
    // 50 is the live one; 52 is somebody's sqlite3 and never a server; 51 holds both files and is
    // counted once. MUTANT: drop the command-line check and a `sqlite3` open on the database is killed.
    expect(strayServers(`${home}/`, [50], w.ops)).toEqual([51, 53]);
    expect(strayServers("/Users/someone-else/Realm", [], w.ops)).toEqual([]);
  });
});
