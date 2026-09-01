/**
 * macOS TCC honesty for the Settings page's Permissions tab (Plan 12 W6) — every DECISION lives
 * here, with no Electron import, so the probe logic is unit-testable; the Electron/fs calls live
 * behind `TccProbeDeps`, implemented in index.ts.
 *
 * The governing rule (mac-cli doctor's five-state precedent, and its `writeOnly` lesson about
 * grants that half-work): a row may only claim a state it has a PROBE BASIS for, and no probe may
 * ever trigger a TCC prompt. Where macOS provides no prompt-free query, the honest answer is
 * `unknown` — rendered as "Can't be checked until used" — never a green check nobody earned.
 *
 * What each row can actually reach, and why:
 *  - **Files & Folders** — `unknown` only. macOS has no query API for the per-folder grants; the
 *    only way to learn the answer is to touch a protected folder, which IS the prompt.
 *  - **Automation** — `unknown` only. The one query (`AEDeterminePermissionToAutomateTarget`) is
 *    not exposed through Electron, and per-target grants make a single answer a lie anyway.
 *  - **Screen Recording** — `granted`/`denied`/`unknown`, from Electron's
 *    `systemPreferences.getMediaAccessStatus("screen")`: a pure status read, documented never to
 *    prompt. `not-determined` (never asked) reports as `unknown`, not as a denial that never happened.
 *  - **Accessibility** — `granted`/`denied`, from `isTrustedAccessibilityClient(false)` (the false
 *    IS the no-prompt contract). The API cannot tell "denied" from "never asked", so the row's
 *    detail says so instead of pretending.
 *  - **Full Disk Access** — `granted`/`denied`/`unknown`, by attempting to OPEN a file that always
 *    exists yet is unreadable without the grant (TCC's own database). FDA has no prompt in macOS —
 *    it is grant-in-Settings-only — so the attempt is safe: EPERM/EACCES is an honest "no",
 *    success an honest "yes", and any other failure (the file missing on some future macOS) is
 *    `unknown` rather than a guess.
 */

export type TccPermissionId = "filesAndFolders" | "automation" | "screenRecording" | "accessibility" | "fullDisk";

/** `unknown` = no prompt-free probe exists (or it could not answer): "Can't be checked until used". */
export type TccState = "granted" | "denied" | "unknown";

export type TccRow = {
  id: TccPermissionId;
  label: string;
  state: TccState;
  /** The probe basis (or its absence), stated to the user — the row's honesty in words. */
  detail: string;
};

/** The protected-but-existing path the Full Disk probe opens. TCC's own database: present on every
 *  macOS install, readable exactly when Full Disk Access is granted, and never behind a prompt. */
export const FULL_DISK_PROBE_PATH = "/Library/Application Support/com.apple.TCC/TCC.db";

/**
 * Deep-link targets in System Settings. The renderer names a ROW ID, never a URL — the main
 * process builds the URL from this closed table, so no IPC payload can steer `openExternal`
 * anywhere else.
 */
export const TCC_SETTINGS_URLS: Record<TccPermissionId, string> = {
  filesAndFolders: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

export function isTccPermissionId(x: unknown): x is TccPermissionId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(TCC_SETTINGS_URLS, x);
}

export type TccProbeDeps = {
  /** `systemPreferences.getMediaAccessStatus("screen")` — status values per Electron. */
  screenStatus(): "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  /** `systemPreferences.isTrustedAccessibilityClient(false)` — false = never prompt. */
  accessibilityTrusted(): boolean;
  /** Open-for-read the given path (then close). Throws with `code` EPERM/EACCES when TCC refuses. */
  openForRead(path: string): void;
};

export function probeTcc(deps: TccProbeDeps): TccRow[] {
  return [
    {
      id: "filesAndFolders", label: "Files & Folders",
      state: "unknown",
      detail: "Can't be checked until used — macOS only reveals these grants by asking, and Realm won't trigger that prompt from a settings page.",
    },
    {
      id: "automation", label: "Automation",
      state: "unknown",
      detail: "Can't be checked until used — grants are per-app-pair and macOS offers Realm no way to ask without asking you.",
    },
    screenRecordingRow(deps),
    accessibilityRow(deps),
    fullDiskRow(deps),
  ];
}

function screenRecordingRow(deps: TccProbeDeps): TccRow {
  const id = "screenRecording" as const, label = "Screen Recording";
  let status: string;
  try { status = deps.screenStatus(); } catch (e) {
    return { id, label, state: "unknown", detail: `Can't be checked — the status query failed (${(e as Error).message}).` };
  }
  if (status === "granted") return { id, label, state: "granted", detail: "macOS reports the grant directly (a status read; it never prompts)." };
  if (status === "denied" || status === "restricted") return { id, label, state: "denied", detail: "macOS reports the grant as refused." };
  // "not-determined" (never asked) and anything unrecognised: not a denial that never happened.
  return { id, label, state: "unknown", detail: "Not asked yet — macOS decides when Realm first tries to record the screen." };
}

function accessibilityRow(deps: TccProbeDeps): TccRow {
  const id = "accessibility" as const, label = "Accessibility";
  let trusted: boolean;
  try { trusted = deps.accessibilityTrusted(); } catch (e) {
    return { id, label, state: "unknown", detail: `Can't be checked — the trust query failed (${(e as Error).message}).` };
  }
  return trusted
    ? { id, label, state: "granted", detail: "macOS reports Realm as a trusted accessibility client (queried without prompting)." }
    : { id, label, state: "denied", detail: "Not granted — though macOS can't tell “denied” from “never asked” here." };
}

function fullDiskRow(deps: TccProbeDeps): TccRow {
  const id = "fullDisk" as const, label = "Full Disk Access";
  try {
    deps.openForRead(FULL_DISK_PROBE_PATH);
    return { id, label, state: "granted", detail: "Realm can read a file only Full Disk Access unlocks. (There is no prompt for this grant — the check is silent.)" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return { id, label, state: "denied", detail: "macOS refused Realm a file only Full Disk Access unlocks — the honest “no”." };
    }
    return { id, label, state: "unknown", detail: `Can't be checked — the probe file didn't behave as expected (${code ?? (e as Error).message}).` };
  }
}
