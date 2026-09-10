import type { VmAction } from "@realm/contracts";
import type { DriverFrame, MachineDriver } from "./driver";
import type { BrowserHostBridge } from "../browsers/host-bridge";

/**
 * This Mac's own screen, for an agent (Plan 25 W7) — a thin adapter over `realm-computer`'s
 * executor rather than a second way to drive a Mac.
 *
 * **The whole point is what it inherits.** Every layer of computer use's safety model applies here
 * unchanged, because the acts go through the same executor and the same native helper: the forbidden
 * bundle ids that no mode lifts, the secure-field refusal checked against the LIVE element, the
 * frontmost and occlusion checks before any synthetic event is posted, and the menu-bar indicator
 * that is the only signal visible while Realm's own window is behind something. Writing a second
 * path to `CGEvent` would have meant a second copy of all of it, and a second place for one of them
 * to be missing.
 *
 * The machine's `bundleId` is the same grant key `computer.allowedApps` uses, so the two features
 * cannot disagree about what TextEdit is.
 *
 * **The reduction to be honest about:** an agent driving a `mac` machine through THIS surface acts
 * by COORDINATE, because that is what `vm_act` takes — while `computer_act` acts by element index
 * against a live accessibility tree. So a session that wants the tree should use `realm-computer`
 * directly; this exists so that a Mac shows up in the machine pane beside every other screen, not to
 * replace the better interface to the same machine.
 */
export class BridgeDriver implements MachineDriver {
  constructor(
    private readonly bridge: Pick<BrowserHostBridge, "call">,
    private readonly bundleId: string,
  ) {}

  async screenshot(): Promise<DriverFrame> {
    const shot = (await this.bridge.call("machineCaptureOnce", { bundleId: this.bundleId })) as
      { data?: string; mimeType?: string; width?: number; height?: number };
    if (!shot.data) {
      throw new Error("macOS did not return an image. Screen Recording may not be granted, or that app may have no windows open.");
    }
    return {
      data: Buffer.from(shot.data, "base64"),
      // The helper reports the WINDOW's own size, which is the coordinate space an act is in.
      width: shot.width ?? 0, height: shot.height ?? 0,
      imageWidth: shot.width ?? 0, imageHeight: shot.height ?? 0,
    };
  }

  /**
   * Acts land through `computerAct`, against a snapshot taken for this call.
   *
   * A snapshot per act rather than a cached one, and it is not waste: `computer_act` re-resolves an
   * element at act time and REFUSES a stale snapshot, which is the property that makes it safe. A
   * cached id would be trading that away for a round trip.
   */
  async act(action: VmAction): Promise<string> {
    const snap = (await this.bridge.call("computerSnapshot", { bundleId: this.bundleId, screenshot: false })) as { snapshotId?: string };
    if (!snap.snapshotId) throw new Error("macOS would not describe that app — Accessibility may not be granted.");
    const result = (await this.bridge.call("computerAct", {
      snapshotId: snap.snapshotId,
      action: toComputerAction(action),
      appName: this.bundleId,
    })) as { ok?: boolean; detail?: string; refused?: string; error?: string };
    if (result.ok) return result.detail ?? "done";
    // The refusals are computer use's own, and they are relayed rather than reworded: each names a
    // thing the user has to do, and a second phrasing here would be a second thing to keep true.
    if (result.refused === "secure_field") {
      throw new Error("refused: that is a password field. Realm never types into one, in any mode — tell the user what to enter and let them type it.");
    }
    throw new Error(result.error ?? `refused: ${result.refused ?? "unknown"}`);
  }

  close(): void { /* nothing is held open — every call is a round trip through the bridge */ }
}

/** A `VmAction` in the vocabulary computer use's executor speaks. Coordinates pass straight through:
 *  `computer_act` takes an `x`/`y` for exactly this case, where there is no element index. */
function toComputerAction(action: VmAction): Record<string, unknown> {
  switch (action.kind) {
    case "click": return { kind: "click", x: action.x, y: action.y, button: action.button };
    case "scroll": return { kind: "scroll", dy: action.deltaY };
    case "key": return { kind: "key", key: action.key };
    case "type": return { kind: "type", text: action.text };
  }
}
