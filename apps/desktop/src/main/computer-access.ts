/**
 * The Permissions tab's "Computer control" section: the two macOS grants the `realm-computer` tools
 * need, and — unlike every other row on that page — a button that can actually ask for them.
 *
 * **Why this is not in `tcc.ts`.** That module's governing rule is that no probe may ever trigger a
 * TCC prompt, and it is relied on: `tcc:probe` runs on every visit to the tab, and a settings page
 * that raised system dialogs by being looked at would be a bug. Asking is a different act from
 * checking, so it lives in a different file rather than as a flag that weakens the invariant. The
 * rows here still READ their state through the same prompt-free queries `tcc.ts` uses; only the
 * request path is new.
 *
 * **What "ask" actually does, which the UI has to say out loud.** macOS has no API that grants
 * Accessibility. `AXIsProcessTrustedWithOptions` with the prompt option shows a dialog whose only
 * button opens System Settings — the grant lands when the user flips the switch there, and not
 * before. So the button is honest about being a shortcut to the right pane rather than a request
 * that can succeed, and the state does not change on return. Screen Recording behaves the same way
 * in practice: `CGRequestScreenCaptureAccess` prompts once per app and is a no-op afterwards, so a
 * user who has already refused has to go to Settings too.
 *
 * **Which app is being granted.** TCC grants attach to the bundle, which under `pnpm dev` is
 * Electron rather than Realm.app — the same trap `mac-access.ts` documents, and the reason the host
 * name is reported alongside the rows instead of being assumed.
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
 * Build the two rows from the current grant state.
 *
 * Accessibility can always be asked for — Electron's trust query is available whether or not the
 * Swift helper was compiled. Screen Recording cannot: the only request API for it lives in the
 * helper, so without one the row reports the state honestly and offers System Settings alone.
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
    },
  ];
}

/**
 * What the "Ask macOS" button will really do, stated before it is pressed.
 *
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
