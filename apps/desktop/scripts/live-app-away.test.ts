import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { AWAY_SECONDS, awayGate, hidIdleSeconds, spawnLiveElectron } from "./lib/live-app.mjs";

/**
 * A check that is seen on screen (`visible:`, `frontApp:`) puts a window or an app in front of the
 * person at the Mac, so it runs only once nobody has touched the Mac for a while, or when told why it
 * may run anyway. The idle time is handed in, so no test reads the Mac it runs on.
 */
const IOREG = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000a3d, registered, matched, active, busy 0 (0 ms), retain 21>
    {
      "HIDIdleTime" = 12500000000
      "IOClass" = "IOHIDSystem"
    }
`;
const idle = (seconds: number | null) => () => seconds;

describe("how long the Mac has been idle", () => {
  it("reads HIDIdleTime from ioreg, which counts nanoseconds", () => {
    expect(hidIdleSeconds(() => IOREG)).toBe(12.5);
  });

  it("is unknown when ioreg has no HIDIdleTime or cannot run", () => {
    expect(hidIdleSeconds(() => "+-o IOHIDSystem\n")).toBeNull();
    expect(hidIdleSeconds(() => { throw new Error("spawn ioreg ENOENT"); })).toBeNull();
  });
});

describe("a seen check waits until the person is away", () => {
  it("is away after 5 minutes", () => {
    expect(AWAY_SECONDS).toBe(300);
  });

  it("refuses while the Mac is in use, and says what lets it run", () => {
    let error: (Error & { code?: string }) | undefined;
    try { awayGate("native material", { env: {}, idleSeconds: idle(12) }); } catch (e) { error = e as Error; }
    expect(error?.code).toBe("LIVE_NOT_AWAY");
    expect(error?.message).toContain("native material");
    expect(error?.message).toContain("12 s ago");
    expect(error?.message).toContain("REALM_LIVE_SEEN_OK");
  });

  it("runs once the Mac has been idle for the whole threshold, and not a second sooner", () => {
    expect(() => awayGate("x", { env: {}, idleSeconds: idle(AWAY_SECONDS - 1) })).toThrow(/REALM_LIVE_SEEN_OK/);
    expect(() => awayGate("x", { env: {}, idleSeconds: idle(AWAY_SECONDS) })).not.toThrow();
    expect(() => awayGate("x", { env: {}, idleSeconds: idle(3600) })).not.toThrow();
  });

  it("refuses when it cannot tell how long the Mac has been idle", () => {
    expect(() => awayGate("x", { env: {}, idleSeconds: idle(null) })).toThrow(/REALM_LIVE_SEEN_OK/);
  });

  it("runs now when REALM_LIVE_SEEN_OK gives a reason", () => {
    expect(() => awayGate("x", { env: { REALM_LIVE_SEEN_OK: "he asked for it" }, idleSeconds: idle(0) })).not.toThrow();
  });

  it("a bare REALM_LIVE_SEEN_OK=1 is not a reason", () => {
    for (const bare of ["1", "true", " "]) {
      expect(() => awayGate("x", { env: { REALM_LIVE_SEEN_OK: bare }, idleSeconds: idle(0) })).toThrow(/REALM_LIVE_SEEN_OK="/);
    }
  });
});

describe("spawnLiveElectron holds a seen check behind the gate", () => {
  /** Electron as plain Node: if the gate lets it through it exits at once, with no window. */
  const asNode = { ELECTRON_RUN_AS_NODE: "1" };
  const args = ["-e", "process.exit(0)"];

  it("a visible check started while the Mac is in use never starts", () => {
    expect(() => spawnLiveElectron(args, { visible: "native material", env: asNode, idleSeconds: idle(1) })).toThrow(/native material/);
  });

  it("so does a check that takes the front app", () => {
    expect(() => spawnLiveElectron(args, { frontApp: "the page has to be key", env: asNode, idleSeconds: idle(1) })).toThrow(/the page has to be key/);
  });

  it("the gate reads the idle time it is handed", () => {
    expect(() => spawnLiveElectron(args, { visible: "x", env: asNode, idleSeconds: idle(AWAY_SECONDS - 1) })).toThrow(/REALM_LIVE_SEEN_OK/);
  });

  it("a visible check runs when the person is away", async () => {
    const child = spawnLiveElectron(args, { visible: "x", env: asNode, stdio: "ignore", idleSeconds: idle(AWAY_SECONDS) });
    expect((await once(child, "exit"))[0]).toBe(0);
  });

  it("and when the check's environment says why it may run now", async () => {
    const child = spawnLiveElectron(args, { visible: "x", env: { ...asNode, REALM_LIVE_SEEN_OK: "proof run" }, stdio: "ignore", idleSeconds: idle(0) });
    expect((await once(child, "exit"))[0]).toBe(0);
  });
});
