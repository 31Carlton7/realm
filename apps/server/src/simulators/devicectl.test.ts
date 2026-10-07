import { describe, expect, it } from "vitest";
import { devicectl, parseDeviceApps, parseLockState, parsePhysicalDevices } from "./devicectl";

/**
 * devicectl's JSON, in the shapes devicectl 642.15 writes it (read off this Mac, names and ids made
 * up): each device with the new `properties` dictionary AND the deprecated blocks beside it.
 */

const ok = (result: unknown) => JSON.stringify({ info: { outcome: "success", jsonVersion: 5 }, result });

const phone = (o: { udid?: string; name?: string; state?: string; pairing?: string; developer?: unknown; version?: string; reality?: string; platform?: string } = {}) => ({
  identifier: "96AFD4EF-0000-0000-0000-000000000000",
  properties: {
    connection: { pairingState: o.pairing ?? "paired", state: o.state ?? "connected", transportType: "wired" },
    hardware: { reality: o.reality ?? "physical", platform: o.platform ?? "iOS", udid: o.udid ?? "00008150-0000AAAA1B2C3D4E", marketingName: "iPhone 17 Pro", deviceType: "iPhone" },
    software: { osVersionNumber: { stringValue: o.version ?? "27.2" } },
    state: { name: o.name ?? "Test’s iPhone", bootState: "booted", developerModeStatus: o.developer ?? { enabled: { mode: 1 } } },
  },
  hardwareProperties: { reality: o.reality ?? "physical", platform: o.platform ?? "iOS", udid: o.udid ?? "00008150-0000AAAA1B2C3D4E" },
  deviceProperties: { name: o.name ?? "Test’s iPhone", osVersionNumber: o.version ?? "27.2", developerModeStatus: "enabled" },
  connectionProperties: { pairingState: o.pairing ?? "paired", tunnelState: "connected" },
});

describe("the real devices in devicectl's list", () => {
  it("is the paired iPhones and iPads that can be reached now, as real iOS devices", () => {
    expect(parsePhysicalDevices(ok({ devices: [phone()] }))).toEqual([
      { udid: "00008150-0000AAAA1B2C3D4E", platform: "ios", physical: true, name: "Test’s iPhone", runtime: "iOS 27.2", state: "Connected", serial: null },
    ]);
  });

  it("counts a phone whose tunnel is down as connected — devicectl brings it up on demand", () => {
    expect(parsePhysicalDevices(ok({ devices: [phone({ state: "disconnected" })] }))[0]?.state).toBe("Connected");
  });

  it("leaves out simulators, an unavailable iPad, an unpaired phone, and any platform but iOS", () => {
    const devices = [
      phone({ reality: "simulated", udid: "SIM" }),
      phone({ state: "unavailable", udid: "IPAD", name: "Old iPad" }),
      phone({ pairing: "unpaired", udid: "STRANGER" }),
      phone({ platform: "watchOS", udid: "WATCH" }),
      phone({ udid: "KEEP" }),
    ];
    expect(parsePhysicalDevices(ok({ devices })).map((d) => d.udid)).toEqual(["KEEP"]);
  });

  it("offers a phone with Developer Mode off, saying so — that is the one thing the user can fix", () => {
    expect(parsePhysicalDevices(ok({ devices: [phone({ developer: { disabled: {} } })] }))[0]?.state).toBe("Developer Mode off");
    expect(parsePhysicalDevices(ok({ devices: [phone({ developer: "disabled" })] }))[0]?.state).toBe("Developer Mode off");
  });

  it("reads the deprecated blocks when a devicectl has no `properties` yet", () => {
    const old = phone({ name: "Older" }) as Record<string, unknown>;
    delete old.properties;
    (old.connectionProperties as Record<string, unknown>).state = "connected";
    expect(parsePhysicalDevices(ok({ devices: [old] }))).toEqual([
      { udid: "00008150-0000AAAA1B2C3D4E", platform: "ios", physical: true, name: "Older", runtime: "iOS 27.2", state: "Connected", serial: null },
    ]);
  });

  it("is nothing at all for a failed command or for junk", () => {
    expect(parsePhysicalDevices(JSON.stringify({ info: { outcome: "failed" }, result: { devices: [phone()] } }))).toEqual([]);
    expect(parsePhysicalDevices("not json")).toEqual([]);
  });

  it("sorts by name", () => {
    expect(parsePhysicalDevices(ok({ devices: [phone({ udid: "B", name: "Zed" }), phone({ udid: "A", name: "Amy" })] })).map((d) => d.name)).toEqual(["Amy", "Zed"]);
  });
});

describe("apps and the lock", () => {
  it("reads each app's bundle id and home-screen name", () => {
    expect(parseDeviceApps(ok({ apps: [{ bundleIdentifier: "com.apple.Preferences", name: "Settings" }, { bundleIdentifier: "com.acme.app" }, { name: "no id" }] })))
      .toEqual([{ bundleId: "com.acme.app", name: "com.acme.app" }, { bundleId: "com.apple.Preferences", name: "Settings" }]);
  });

  it("reads a passcode standing between Realm and the screen as locked", () => {
    expect(parseLockState(ok({ passcodeRequired: true, unlockedSinceBoot: true }))).toEqual({ locked: true });
    expect(parseLockState(ok({ passcodeRequired: false, unlockedSinceBoot: true }))).toEqual({ locked: false });
    expect(parseLockState(ok({}))).toBeNull();
  });
});

describe("running devicectl", () => {
  const record = (answer: { code?: number; stdout?: string; stderr?: string } = {}) => {
    const calls: string[][] = [];
    const dc = devicectl({}, async (args) => { calls.push(args); return { code: answer.code ?? 0, stdout: answer.stdout ?? ok({}), stderr: answer.stderr ?? "" }; });
    return { dc, calls };
  };

  it("asks for JSON on stdout, ahead of every argument — a launch hands whatever follows the bundle id to the app", async () => {
    const { dc, calls } = record();
    await dc.launch("UDID", "com.apple.Preferences", true);
    await dc.launch("UDID", "com.acme.app", false);
    expect(calls).toEqual([
      ["devicectl", "device", "process", "launch", "--json-output", "-", "--quiet", "--device", "UDID", "--terminate-existing", "com.apple.Preferences"],
      ["devicectl", "device", "process", "launch", "--json-output", "-", "--quiet", "--device", "UDID", "com.acme.app"],
    ]);
  });

  it("looks up one app by bundle id among ALL apps, and lists only the developer's otherwise", async () => {
    const { dc, calls } = record({ stdout: ok({ apps: [{ bundleIdentifier: "com.apple.Preferences", name: "Settings" }] }) });
    expect(await dc.app("UDID", "com.apple.Preferences")).toEqual({ bundleId: "com.apple.Preferences", name: "Settings" });
    await dc.apps("UDID");
    expect(calls[0]).toEqual(["devicectl", "device", "info", "apps", "--json-output", "-", "--quiet", "--device", "UDID", "--include-all-apps", "--bundle-id", "com.apple.Preferences"]);
    expect(calls[1]).toEqual(["devicectl", "device", "info", "apps", "--json-output", "-", "--quiet", "--device", "UDID"]);
  });

  it("says what devicectl said when an act fails — its own description first, else its last lines", async () => {
    const withError = record({ code: 1, stdout: JSON.stringify({ info: { outcome: "failed" }, error: { userInfo: { NSLocalizedDescription: "The app is not installed." } } }) });
    expect(await withError.dc.launch("UDID", "com.nope", false)).toEqual({ ok: false, detail: "The app is not installed." });
    const bare = record({ code: 1, stdout: "", stderr: "noise\nERROR: Device is busy\n" });
    expect(await bare.dc.install("UDID", "/tmp/x.app")).toEqual({ ok: false, detail: "noise ERROR: Device is busy" });
  });

  it("reads nothing into a failed list, lock or lookup", async () => {
    const { dc } = record({ code: 1, stdout: "" });
    expect(await dc.devices()).toEqual([]);
    expect(await dc.lockState("UDID")).toBeNull();
    expect(await dc.app("UDID", "x")).toBeNull();
  });
});
