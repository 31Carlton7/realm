import { describe, expect, it } from "vitest";
import { ElementChipSchema, PICK_TEXT_MAX } from "@realm/contracts";
import { describeDeviceElement, deviceKind, devicePictureName } from "./device-pick";

const portrait = (width: number, height: number) => ({ width, height, orientation: "portrait" as const });
const TREE = { units: "points" as const, screen: { width: 402, height: 874 }, app: "Settings", elements: [] };
const DEVICE = { simulatorId: "01JD2ZQ5Y3W8ZGZ1X6M2R7S9TA", kind: "iPhone", platform: "ios" as const, physical: false };

describe("a pick off a device", () => {
  it("leads its chip with what the device is, from its platform and its screen's shape", () => {
    expect(deviceKind("ios", portrait(1206, 2622))).toBe("iPhone");
    expect(deviceKind("ios", portrait(2064, 2752))).toBe("iPad");
    expect(deviceKind("ios", portrait(396, 484))).toBe("Apple Watch");
    expect(deviceKind("android", portrait(1080, 2400))).toBe("Android");
    // THE MUTANT: guess. A row still on its way is not an iPhone yet.
    expect(deviceKind(null, portrait(1206, 2622))).toBe("Device");
  });

  it("is held to the bounds the wire holds a pick to, so an app's long label never bounces the message", () => {
    const el = { path: "0.4", label: "x".repeat(600), value: "", role: "StaticText", id: null, enabled: true,
      frame: { x: 0, y: 0, width: 10, height: 10 }, depth: 2 };
    const picked = describeDeviceElement(el, TREE, DEVICE, null);
    expect(picked.label).toHaveLength(PICK_TEXT_MAX);
    expect(ElementChipSchema.safeParse({ label: "iPhone · x", element: picked }).success).toBe(true);
  });

  it("names its picture for the device and the element, as main keeps a capture's name", () => {
    expect(devicePictureName("iPhone", { role: "Button", label: "General", value: "", id: null })).toBe("iphone-general-button.png");
    expect(devicePictureName("Apple Watch", { role: "Other", label: "", value: "", id: null })).toBe("apple-watch-other.png");
  });
});
