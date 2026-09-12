import { describe, expect, it } from "vitest";
import { parseDevices, runtimeLabel, simctlBin, parseApps } from "./simctl";

/** Transcribed from a real `xcrun simctl list devices available --json` on a Mac with Xcode 27,
 *  trimmed to the fields the parser reads plus one it must ignore. A hand-written shape would be a
 *  test of this file's imagination. */
const DUMP = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "75D1511C-5E00-41A6-9CA2-1650DEAAF571", name: "iPhone 17 Pro", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
      { udid: "7F4B34AC-20B1-4330-B3D2-B8E285096D29", name: "iPhone 17 Pro Max", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max" },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-4": [
      { udid: "AAAA1111-0000-0000-0000-000000000001", name: "iPhone 16", state: "Shutdown", isAvailable: true },
      { udid: "BBBB2222-0000-0000-0000-000000000002", name: "iPhone 16 (unavailable)", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
      { udid: "CCCC3333-0000-0000-0000-000000000003", name: "Apple Watch Series 11 (46mm)", state: "Shutdown", isAvailable: true },
    ],
  },
});

describe("the device list", () => {
  it("reads udid, name, runtime and simctl's own state word", () => {
    const devices = parseDevices(DUMP);
    expect(devices[0]).toEqual({
      udid: "75D1511C-5E00-41A6-9CA2-1650DEAAF571", platform: "ios", name: "iPhone 17 Pro",
      runtime: "iOS 27.0", state: "Booted", serial: null,
    });
  });

  it("drops devices whose runtime is not installed", () => {
    // THE list-everything mutant: a device simctl marks unavailable cannot boot, so offering it is
    // offering a row whose only outcome is an error the user cannot act on.
    const names = parseDevices(DUMP).map((d) => d.name);
    expect(names).not.toContain("iPhone 16 (unavailable)");
    expect(names).toContain("iPhone 16");
  });

  it("leads with the newest iOS, not with whatever sorts highest", () => {
    /* Two mutants, and the second is the one that hurts. THE object-order mutant returns them in
       whatever order Object.entries hands back — insertion order, which put iOS 18 above iOS 27 in
       the real dump above. THE one-line-descending mutant sorts the whole label instead: "watchOS"
       beats "iOS" on the first letter, so a Mac with a watch runtime installed opens its picker on
       an Apple Watch. */
    const runtimes = [...new Set(parseDevices(DUMP).map((d) => d.runtime))];
    expect(runtimes).toEqual(["iOS 27.0", "iOS 18.4", "watchOS 26.0"]);
    // …and within a runtime, by name rather than by whatever CoreSimulator's directory order is.
    const ios27 = parseDevices(DUMP).filter((d) => d.runtime === "iOS 27.0").map((d) => d.name);
    expect(ios27).toEqual(["iPhone 17 Pro", "iPhone 17 Pro Max"]);
  });

  it("turns a runtime identifier into something a person reads", () => {
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-27-0")).toBe("iOS 27.0");
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.watchOS-26-0")).toBe("watchOS 26.0");
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-18-4-1")).toBe("iOS 18.4.1");
    // Anything Apple names differently later passes through whole. A runtime nobody can parse should
    // read oddly in the picker, not vanish from it.
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.visionOS-tomorrow")).toBe("visionOS-tomorrow");
  });

  it("survives junk rather than taking the picker down with it", () => {
    // The list is loaded when a pane opens. A parse error here would be an empty pane with no way
    // back, for a machine whose simctl printed something unexpected once.
    expect(parseDevices("not json")).toEqual([]);
    expect(parseDevices("{}")).toEqual([]);
    expect(parseDevices(JSON.stringify({ devices: { "x.iOS-1-0": [{ name: "no udid" }, { udid: "u", name: "ok" }] } })))
      .toEqual([{ udid: "u", platform: "ios", name: "ok", runtime: "iOS 1.0", state: "Unknown", serial: null }]);
  });

  it("is repointable, so a Mac with Xcode somewhere unusual is reachable", () => {
    expect(simctlBin({})).toBe("xcrun");
    expect(simctlBin({ REALM_XCRUN_BIN: "/opt/xcrun" })).toBe("/opt/xcrun");
    expect(simctlBin({ REALM_XCRUN_BIN: "  " })).toBe("xcrun");
  });
});

describe("parseApps", () => {
  /** A slice of a real `simctl listapps` dump, nested blocks and all — the shape that breaks a
   *  brace-counting parser and the one a first attempt gets wrong. */
  const DUMP = `{
    "com.apple.Bridge" =     {
        ApplicationType = System;
        CFBundleDisplayName = Watch;
        CFBundleIdentifier = "com.apple.Bridge";
        CFBundleName = Watch;
        GroupContainers =         {
            "group.com.apple.bridge" = "file:///somewhere/";
        };
        IsHidden = 0;
        SBAppTags =         (
            "watch-companion"
        );
    };
    "com.acme.Widgets" =     {
        ApplicationType = User;
        CFBundleDisplayName = "Acme Widgets";
        CFBundleIdentifier = "com.acme.Widgets";
        IsHidden = 0;
    };
    "com.apple.springboard" =     {
        ApplicationType = System;
        CFBundleName = SpringBoard;
        IsHidden = 1;
    };
}`;

  it("reads every entry, nested blocks and all", () => {
    const apps = parseApps(DUMP);
    expect(apps.map((a) => a.bundleId)).toEqual(["com.acme.Widgets", "com.apple.Bridge"]);
  });

  it("puts the developer's own app first — on their simulator it is the one they came for", () => {
    expect(parseApps(DUMP)[0]).toEqual({ bundleId: "com.acme.Widgets", name: "Acme Widgets" });
  });

  it("drops a hidden app: no icon, nothing to launch", () => {
    expect(parseApps(DUMP).some((a) => a.bundleId === "com.apple.springboard")).toBe(false);
  });

  it("falls back from the display name to the bundle name, and then to the id itself", () => {
    const apps = parseApps(`{
    "com.apple.Bridge" =     {
        CFBundleName = Watch;
        IsHidden = 0;
    };
    "com.acme.Nameless" =     {
        IsHidden = 0;
    };
}`);
    expect(apps.find((a) => a.bundleId === "com.apple.Bridge")!.name).toBe("Watch");
    expect(apps.find((a) => a.bundleId === "com.acme.Nameless")!.name).toBe("com.acme.Nameless");
  });

  it("is empty rather than wrong for anything that is not a dump", () => {
    expect(parseApps("")).toEqual([]);
    expect(parseApps("xcrun: error: unable to find utility")).toEqual([]);
  });
});
