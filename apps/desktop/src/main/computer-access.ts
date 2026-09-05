/**
 * The Permissions tab's "Computer control" section: the two macOS grants the `realm-computer` tools
 * need, and — unlike every other row on that page — a button that can actually ask for them.
 *
 * Asking lives here rather than in `tcc.ts` because that module's governing rule is that no probe
 * may ever trigger a prompt, and the tab probes on every visit. The rows still READ their state
 * through those same prompt-free queries; only the request path is new.
 *
 * TCC grants attach to the BUNDLE, which under `pnpm dev` is Electron rather than Realm.app — the
 * trap `mac-access.ts` documents too, and why the host name travels with the rows instead of being
 * assumed.
 */

import type { TccState } from "./tcc";

export type ComputerAccessId = "accessibility" | "screenRecording";

export type ComputerAccessRow = {
  id: ComputerAccessId;
  label: string;
  state: TccState;
  /** What this grant buys, and what still works without it. */
  detail: string;
  /** Realm has a way to raise the real prompt for this row. */
  canPrompt: boolean;
  /** Whether the user will have to finish the job in System Settings. True whenever the grant is
   *  missing, because for both of these it is where the switch actually lives. */
  needsSettings: boolean;
  /** What pressing "Ask macOS" will really do, shown before it is pressed; null when there is
   *  nothing to ask for. Decided here rather than in the renderer because it describes what THIS
   *  process is about to call. */
  askExplanation: string | null;
};

export type ComputerAccessStatus = {
  rows: ComputerAccessRow[];
  /** The name macOS will show in its own lists — `macHostName`, so a dev build says "Electron". */
  hostName: string;
  /** False under `pnpm dev`: grants made now attach to Electron and will not carry into Realm.app. */
  packaged: boolean;
  /** False when this build has no compiled accessibility helper, which makes computer use
   *  unavailable no matter what macOS has granted. */
  helperAvailable: boolean;
};

export type ComputerGrantState = { accessibility: boolean; screenRecording: boolean };

/**
 * Accessibility can always be asked for: Electron can raise that dialog whether or not the Swift
 * helper was compiled. Screen Recording cannot — the only request API for it is in the helper — so
 * without one that row offers System Settings alone rather than a button that would do nothing.
 */
export function computerAccessRows(grants: ComputerGrantState, opts: { helperAvailable: boolean }): ComputerAccessRow[] {
  return [
    {
      id: "accessibility",
      label: "Accessibility",
      state: grants.accessibility ? "granted" : "denied",
      detail: grants.accessibility
        ? "Agents you run can read other apps' windows and control them. Revoke it any time in System Settings."
        : "Required. Without it Realm cannot read or drive any other app, and the computer-control tools refuse every call. macOS cannot tell “refused” from “never asked” here.",
      canPrompt: !grants.accessibility,
      needsSettings: !grants.accessibility,
      askExplanation: grants.accessibility ? null : computerGrantExplanation("accessibility"),
    },
    {
      id: "screenRecording",
      label: "Screen Recording",
      state: grants.screenRecording ? "granted" : "denied",
      detail: grants.screenRecording
        ? "Snapshots can include a picture of the app's windows."
        : "Optional. Without it snapshots carry no image — the accessibility tree, which is what agents actually act on, works either way.",
      canPrompt: !grants.screenRecording && opts.helperAvailable,
      needsSettings: !grants.screenRecording,
      askExplanation: !grants.screenRecording && opts.helperAvailable ? computerGrantExplanation("screenRecording") : null,
    },
  ];
}

/**
 * Both strings promise a trip to System Settings rather than a grant, because that is what happens.
 * A button that said "Grant" and then changed nothing on screen would train the user to distrust the
 * page.
 */
export function computerGrantExplanation(id: ComputerAccessId): string {
  return id === "accessibility"
    ? "macOS will show a dialog whose only button opens System Settings → Privacy & Security → Accessibility. Switch Realm on there; nothing is granted until you do."
    : "macOS will ask once. If it has asked before, it opens System Settings → Privacy & Security → Screen Recording instead.";
}

export function isComputerAccessId(x: unknown): x is ComputerAccessId {
  return x === "accessibility" || x === "screenRecording";
}
