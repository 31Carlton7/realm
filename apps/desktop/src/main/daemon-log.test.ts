import { describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { closeDaemonLog, daemonLogPath, openDaemonLog, rotateDaemonLog } from "./daemon-log";

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
