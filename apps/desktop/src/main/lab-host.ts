import { LAB_ENABLED_KEY, LAB_SETTINGS_PANES, LAB_UPDATE_STATE_KEY, type LabSettingsPane } from "@realm/contracts";

/**
 * Main's half of the lab (teams plan §12): the two things only main can do — Realm's own login item,
 * and the updater — and the System Settings panes the checklist links to.
 *
 * Nothing here changes a setting of the Mac's that needs an administrator. The login item is Realm's
 * own entry, set through Electron and undone the same way, and it is offered only from the installed
 * app: a development build would add Electron's binary to the user's login items.
 */

/** The panes a lab check can open, as macOS 13+ names them. A closed list: the renderer names a pane,
 *  never a URL. */
export const LAB_SETTINGS_URLS: Record<LabSettingsPane, string> = {
  energy: "x-apple.systempreferences:com.apple.Energy-Settings.extension",
  users: "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension",
  privacy: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
  sharing: "x-apple.systempreferences:com.apple.Sharing-Settings.extension",
  "login-items": "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
  displays: "x-apple.systempreferences:com.apple.Displays-Settings.extension",
  network: "x-apple.systempreferences:com.apple.Network-Settings.extension",
};

export function labSettingsUrl(pane: unknown): string | null {
  return typeof pane === "string" && (LAB_SETTINGS_PANES as readonly string[]).includes(pane) ? LAB_SETTINGS_URLS[pane as LabSettingsPane] : null;
}

export type LoginItemDeps = {
  packaged: boolean;
  get: () => { openAtLogin: boolean };
  set: (s: { openAtLogin: boolean }) => void;
};

export type LoginItemStatus = { openAtLogin: boolean | null; canSet: boolean };

export function loginItemStatus(d: LoginItemDeps): LoginItemStatus {
  try { return { openAtLogin: d.get().openAtLogin, canSet: d.packaged }; } catch { return { openAtLogin: null, canSet: d.packaged }; }
}

/** Turn Realm's login item on or off. Refused outside the installed app, and answered with what
 *  macOS then reports rather than what was asked. */
export function setLoginItem(d: LoginItemDeps, on: unknown): LoginItemStatus {
  if (!d.packaged || typeof on !== "boolean") return loginItemStatus(d);
  d.set({ openAtLogin: on });
  return loginItemStatus(d);
}

/* ── the update window, from main's side ── */

export type LabUpdateDeps = {
  version: string;
  /** realm-server, over the bridge. Throws when it is not connected. */
  call: (method: string, params: unknown) => Promise<unknown>;
  /** What the updater holds now, and the install it already knows how to do (#133's relaunch follows). */
  updater: { status(): { state: { kind: string; version?: string } }; install(): void };
  log?: (line: string) => void;
};

async function labEnabled(d: LabUpdateDeps): Promise<boolean> {
  try {
    const v = await d.call("settings.get", { key: LAB_ENABLED_KEY });
    return (v as { value?: unknown } | null)?.value === true;
  } catch { return false; }
}

/**
 * An update finished downloading. On a lab the update window decides when it installs, so the
 * restart dialog is not shown — nobody is there to answer it. True when the window took it.
 */
export async function labTakesUpdate(d: LabUpdateDeps, version: string): Promise<boolean> {
  if (!(await labEnabled(d))) return false;
  try {
    await d.call("lab.updateReady", { version, from: d.version });
    d.log?.(`[lab] v${version} is downloaded; the update window will install it`);
    return true;
  } catch { return false; }
}

/**
 * Main connected to the server: say which version is running, which is how a window that told main to
 * install learns it landed. And an update downloaded before the server was there is reported now.
 */
export async function labOnConnected(d: LabUpdateDeps): Promise<void> {
  try { await d.call("lab.appVersion", { version: d.version }); } catch { /* an older server: no lab */ }
  const st = d.updater.status().state;
  if (st.kind === "downloaded" && st.version) await labTakesUpdate(d, st.version);
}

/** The window drained and says install: do it, if that is the update the updater holds. */
export function labInstall(d: LabUpdateDeps, payload: unknown): boolean {
  const version = (payload as { version?: unknown } | null)?.version;
  const st = d.updater.status().state;
  if (st.kind !== "downloaded" || st.version !== version) return false;
  d.log?.(`[lab] installing v${String(version)}`);
  d.updater.install();
  return true;
}

/**
 * Whether the daemon being replaced is mid-install for the lab's window. The window already drained
 * it, so the new app restarts it without the "Restart the agent server?" dialog — a dialog on a Mac
 * nobody is at would leave the lab stopped until somebody came by.
 */
export async function labPreapprovesRestart(call: (method: string, params: unknown) => Promise<unknown>): Promise<boolean> {
  try {
    const v = await call("settings.get", { key: LAB_UPDATE_STATE_KEY });
    return ((v as { value?: { kind?: unknown } } | null)?.value?.kind) === "installing";
  } catch { return false; }
}
