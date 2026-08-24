import { describe, it, expect } from "vitest";
import { probeAcp } from "./probe";

describe("probeAcp", () => {
  it("reports unavailable with a reason when the binary is missing", async () => {
    const r = await probeAcp("/definitely/not/a/binary");
    expect(r).toMatchObject({ available: false, version: null, loggedIn: null });
    expect(r.reason).toBeTruthy();
  });

  it("reports available with a version and an unknown login state", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('2026.07.25-e42b078')"]);
    expect(r).toMatchObject({ available: true, version: "2026.07.25-e42b078", loggedIn: null });
    expect(r.reason).toBe("unknown until a session starts");
  });

  it("takes only the first line of multi-line --version output", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('2026.07.25-e42b078\\nextra diagnostic line')"]);
    expect(r.version).toBe("2026.07.25-e42b078");
  });

  it("coerces empty --version output to a null version", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('')"]);
    expect(r.available).toBe(true);
    expect(r.version).toBeNull();
  });

  it("never reports loggedIn as anything but null, even when the binary is available", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('v1')"]);
    expect(r.loggedIn).toBeNull();
  });
});
