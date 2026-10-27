import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tempDir } from "@realm/test-utils";
import { acquireLock, clearState, lockFile, newToken, readState, releaseLock, stateFile, writeState, type DaemonState } from "./state";

const state = (over: Partial<DaemonState> = {}): DaemonState => ({
  version: 1, pid: 4242, bootId: randomUUID(), port: 8790, token: newToken(), home: "/tmp/realm",
  protocol: 1, bundleId: "abc123", entry: "/Applications/Realm.app/Contents/Resources/server/dist/main.js",
  startedAt: 1_757_000_000_000, state: "running", ...over,
});

describe("daemon state file", () => {
  it("round-trips", () => {
    const home = tempDir("realm-daemon-");
    const written = state();
    writeState(home, written);
    expect(readState(home)).toEqual(written);
  });

  it("is written 0600 — it carries the RPC token", () => {
    const home = tempDir("realm-daemon-");
    writeState(home, state());
    expect(statSync(stateFile(home)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    const home = tempDir("realm-daemon-");
    const s = state();
    writeState(home, s);
    expect(() => readFileSync(`${stateFile(home)}.${s.pid}.tmp`, "utf8")).toThrow();
  });

  it("reads as absent rather than throwing, for every kind of broken file", () => {
    const home = tempDir("realm-daemon-");
    expect(readState(home)).toBeNull();
    writeFileSync(stateFile(home), "{not json");
    expect(readState(home)).toBeNull();
    writeFileSync(stateFile(home), JSON.stringify({ version: 1, pid: 1 }));
    expect(readState(home)).toBeNull();
    writeFileSync(stateFile(home), JSON.stringify({ ...state(), port: 0 }));
    expect(readState(home)).toBeNull();
  });

  it("clears its own file", () => {
    const home = tempDir("realm-daemon-");
    writeState(home, state());
    clearState(home, { pid: 4242 });
    expect(readState(home)).toBeNull();
    clearState(home, { pid: 4242 }); // absent is not an error
    // Nor is one nobody can read: it names no server, so it is nobody's to keep.
    writeFileSync(stateFile(home), "{not json");
    clearState(home, { pid: 4242 });
    expect(() => readFileSync(stateFile(home), "utf8")).toThrow();
  });

  it("leaves the file a newer server wrote", () => {
    // A server stopped while busy runs its shutdown late — after the launcher gave up waiting and the
    // replacement wrote its own file. MUTANT: clear unconditionally, and the app attached to the new
    // server has no file to find it by the next time its socket drops.
    const home = tempDir("realm-daemon-");
    const replacement = state({ pid: 5151 });
    writeState(home, replacement);
    clearState(home, { pid: 4242 });
    expect(readState(home)).toEqual(replacement);
  });
});

describe("daemon lock", () => {
  const live = () => {};
  const dead = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };

  it("is taken once", () => {
    const home = tempDir("realm-lock-");
    expect(acquireLock(home, { pid: 1, bootId: "a" }, { kill: live })).toEqual({ kind: "acquired" });
    expect(acquireLock(home, { pid: 2, bootId: "b" }, { kill: live })).toEqual({ kind: "held", pid: 1 });
  });

  it("breaks a lock whose owner is gone", () => {
    const home = tempDir("realm-lock-");
    acquireLock(home, { pid: 1, bootId: "a" }, { kill: live });
    expect(acquireLock(home, { pid: 2, bootId: "b" }, { kill: dead })).toEqual({ kind: "acquired" });
  });

  it("treats EPERM as alive — the owner exists and is somebody else's", () => {
    const home = tempDir("realm-lock-");
    acquireLock(home, { pid: 1, bootId: "a" }, { kill: live });
    const eperm = () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
    expect(acquireLock(home, { pid: 2, bootId: "b" }, { kill: eperm })).toEqual({ kind: "held", pid: 1 });
  });

  it("breaks an unreadable lock — one nobody can identify cannot be honoured", () => {
    const home = tempDir("realm-lock-");
    writeFileSync(lockFile(home), "{half-writ");
    expect(acquireLock(home, { pid: 2, bootId: "b" }, { kill: live })).toEqual({ kind: "acquired" });
  });

  it("releases only its own lock", () => {
    const home = tempDir("realm-lock-");
    acquireLock(home, { pid: 1, bootId: "a" }, { kill: live });
    releaseLock(home, { pid: 2 });
    expect(acquireLock(home, { pid: 3, bootId: "c" }, { kill: live })).toEqual({ kind: "held", pid: 1 });
    releaseLock(home, { pid: 1 });
    expect(acquireLock(home, { pid: 3, bootId: "c" }, { kill: live })).toEqual({ kind: "acquired" });
  });
});
