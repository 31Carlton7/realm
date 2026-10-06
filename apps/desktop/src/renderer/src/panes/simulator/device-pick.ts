import {
  deviceElementName, ownerOfTab, PICK_DEVICE_ID_MAX, PICK_NAME_MAX, PICK_TEXT_MAX,
  type DevicePickedElement, type Item, type Layout, type SimulatorAxElement, type SimulatorAxTree, type SimulatorPlatform, type SimulatorScreen,
} from "@realm/contracts";
import { sessionForPick } from "../browser/pick-target";
import { deviceShape } from "./device-frame";

/**
 * A pick off a device's screen: the simulator pane's Elements, the way the web picker sends a part of a
 * page and Select in Realm a part of the app. The pane owns the overlay and the click; this owns what
 * the pick IS — the element as the device described it, the device as the pane knows it — and where
 * it goes.
 */

/** What the device is, in a word: the chip's lead, "iPhone · General button". From the platform the
 *  row carries and the screen's proportions, never a table of products. */
export function deviceKind(platform: SimulatorPlatform | null, screen: SimulatorScreen): string {
  if (platform === null) return "Device";
  if (platform === "android") return "Android";
  const shape = deviceShape(screen);
  return shape === "tablet" ? "iPad" : shape === "square" ? "Apple Watch" : "iPhone";
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The element as the wire takes it: the device's own words, clipped to the bounds the schema holds a
 *  pick to, and the device beside them. `shot` is the path of the picture the pane took, or null. */
export function describeDeviceElement(el: SimulatorAxElement, tree: SimulatorAxTree,
  device: { simulatorId: string; kind: string; platform: SimulatorPlatform; physical: boolean }, shot: string | null): DevicePickedElement {
  return {
    role: clip(el.role, PICK_NAME_MAX),
    label: clip(el.label, PICK_TEXT_MAX),
    value: clip(el.value, PICK_TEXT_MAX),
    id: el.id === null ? null : clip(el.id, PICK_DEVICE_ID_MAX),
    enabled: el.enabled,
    frame: { ...el.frame },
    screen: { ...tree.screen },
    units: tree.units ?? "points",
    simulator: { id: device.simulatorId, kind: device.kind, platform: device.platform, physical: device.physical,
      app: clip(tree.app, PICK_NAME_MAX), shot },
  };
}

/** `iphone-general-button.png`: what the attachment tile and the agent both read the picture as. Held
 *  to the names main keeps a capture under. */
export function devicePictureName(kind: string, el: Pick<SimulatorAxElement, "role" | "label" | "value" | "id">): string {
  const slug = `${kind} ${deviceElementName(el)}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "device-element"}.png`;
}

/**
 * Which session's prompter a device pick lands in: the session the device belongs to. A device opened
 * from a session is that session's tab of the side panel, and its owner is the answer — it is the session
 * the person is working on this device with, whichever pane last had the keyboard. A device the person
 * moved out into a pane of their own belongs to nobody in particular, and asks the web picker's
 * question instead (`sessionForPick`).
 */
export function sessionForDevice(items: readonly Item[], layout: Layout | null, focusedLeafId: string | null, deviceItemId: string): Item | null {
  if (!layout) return null;
  const whose = ownerOfTab(layout, deviceItemId);
  const owner = whose ? items.find((i) => i.id === whose && i.kind === "session") : undefined;
  return owner ?? sessionForPick(items, layout, focusedLeafId);
}
