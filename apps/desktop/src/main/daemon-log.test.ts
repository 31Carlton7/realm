import { describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { mintAppToken } from "./app-token";
import { closeDaemonLog, daemonLogPath, launcherLog, launcherLogPath, LOG_MAX_BYTES, openDaemonLog, rotateDaemonLog } from "./daemon-log";

describe("the daemon's log", () => {
  it("appends at 0600, creating the folder", () => {
    const home = tempDir("realm-log-");
    const fd = openDaemonLog(home);
    closeDaemonLog(fd);
    expect(statSync(daemonLogPath(home)).mode & 0o777).toBe(0o600);
    appendFileSync(daemonLogPath(home), "first\n");
    closeDaemonLog(openDaemonLog(home));
    appendFileSync(daemonLogPath(home), "second\n");
    expect(readFileSync(daemonLogPath(home), "utf8")).toBe("first\nsecond\n");
  });

  it("rotates one generation, and no more", () => {
    const home = tempDir("realm-log-");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(daemonLogPath(home), "oldest");
    rotateDaemonLog(home, 3);
    expect(readFileSync(`${daemonLogPath(home)}.1`, "utf8")).toBe("oldest");
    expect(existsSync(daemonLogPath(home))).toBe(false);

    writeFileSync(daemonLogPath(home), "newer");
    rotateDaemonLog(home, 3);
    expect(readFileSync(`${daemonLogPath(home)}.1`, "utf8")).toBe("newer");
    expect(existsSync(`${daemonLogPath(home)}.2`)).toBe(false);
  });

  it("leaves a log that has not grown alone", () => {
    const home = tempDir("realm-log-");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(daemonLogPath(home), "small");
    rotateDaemonLog(home, 1_000);
    expect(readFileSync(daemonLogPath(home), "utf8")).toBe("small");
    expect(existsSync(`${daemonLogPath(home)}.1`)).toBe(false);
  });

  it("is a nicety, not a gate: no log yet is not an error", () => {
    const home = tempDir("realm-log-");
    expect(() => rotateDaemonLog(home, 1)).not.toThrow();
  });
});

describe("the launcher's log", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("writes each line to <home>/logs/launcher.log with a timestamp, and to the console", () => {
    const home = tempDir("realm-launcher-log-");
    const err = quiet();
    launcherLog(home, "[daemon] starting realm-server (no daemon)");
    launcherLog(home, "[daemon] stopping realm-server:", new Error("boom"));
    expect(err).toHaveBeenCalledWith("[daemon] starting realm-server (no daemon)");
    err.mockRestore();
    const lines = readFileSync(launcherLogPath(home), "utf8").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[daemon\] starting realm-server \(no daemon\)$/);
    expect(lines[1]).toMatch(/^\S+Z \[daemon\] stopping realm-server: Error: boom/);
    expect(statSync(launcherLogPath(home)).mode & 0o777).toBe(0o600);
  });

  it("rotates at the cap the way server.log does: one generation", () => {
    const home = tempDir("realm-launcher-log-");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(launcherLogPath(home), "x".repeat(LOG_MAX_BYTES));
    const err = quiet();
    launcherLog(home, "after the cap");
    err.mockRestore();
    expect(statSync(`${launcherLogPath(home)}.1`).size).toBe(LOG_MAX_BYTES);
    expect(readFileSync(launcherLogPath(home), "utf8")).toMatch(/Z after the cap\n$/);
    expect(existsSync(`${launcherLogPath(home)}.2`)).toBe(false);
  });

  it("never throws when the home cannot hold a logs folder", () => {
    const home = join(tempDir("realm-launcher-log-"), "a-file");
    writeFileSync(home, "not a folder");
    const err = quiet();
    expect(() => launcherLog(home, "[daemon] waiting for realm-server (starting)")).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("writes nothing token-like", () => {
    const home = tempDir("realm-launcher-log-");
    const token = mintAppToken();
    const err = quiet();
    launcherLog(home, `[daemon] drain refused (401 for ${token}); stopping it`);
    launcherLog(home, "[daemon] stopping realm-server:", new Error(`http://127.0.0.1:8788/?token=${token}`));
    err.mockRestore();
    const text = readFileSync(launcherLogPath(home), "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    expect(text).toContain("[daemon] drain refused (401 for [redacted]); stopping it");
  });
});
