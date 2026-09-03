/**
 * The `mac` CLI's macOS access, made GRANTABLE from Settings → Permissions — the other half of
 * tcc.ts. Where tcc.ts reports what macOS lets *Realm* do and can only ever point at System
 * Settings, this module is about what the agents Realm runs can do through `mac`, and it can
 * actually move the needle: for most capabilities the grant is a prompt, and the only way to raise
 * that prompt is to run a real command. So Realm runs one.
 *
 * Three facts from `mac`'s own permission model shape every decision here, and each one is a test:
 *
 *  1. **The grant belongs to the app that owns the process tree, not to `mac`.** Realm's server is
 *     a direct child of the Electron main process and agent shells are its grandchildren, so a
 *     `mac` call from any session is attributed to Realm — which is why granting once from this
 *     page covers every future session. It is also why the page must SAY which app macOS will
 *     name: under `pnpm dev` that app is Electron, not Realm, and the grants do not transfer.
 *  2. **A denial is sticky and silent.** Once denied, re-running never re-prompts. A "Grant" button
 *     on a denied row would be a button that cannot work, so denied rows offer System Settings
 *     instead — `canPrompt` is false there, and `grantPlan` skips them.
 *  3. **`mac doctor` never prompts and always exits 0.** It is the only honest status source, and
 *     its per-capability `fix` string is quoted verbatim rather than paraphrased.
 *
 * No Electron import: every decision is pure and unit-testable, and the child-process/shell legs
 * live behind `index.ts` exactly as tcc.ts's probe legs do.
 */

/** `mac doctor`'s capability ids, verbatim — this table IS the closed set the IPC gate validates. */
export type MacCapabilityId =
  | "calendar" | "reminders" | "contacts"
  | "automation:Mail" | "automation:Messages" | "automation:Notes" | "automation:Music"
  | "automation:TV" | "automation:Shortcuts" | "automation:Finder"
  | "automation:Keynote" | "automation:Pages" | "automation:Numbers"
  | "fullDiskAccess";

/** `mac doctor`'s five states, kept apart rather than collapsed into granted/denied. `writeOnly` is
 *  the lesson: macOS 14's add-only Calendar grant lets writes through and fails reads, so folding it
 *  into "granted" would render a green check over a half-broken capability. */
export type MacAccessState = "granted" | "denied" | "notRequested" | "writeOnly" | "unknown";

export type MacAccessGroup = "data" | "automation" | "disk" | "other";

/** The System Settings panes that hold these toggles. The renderer names a CAPABILITY, never a URL. */
export const MAC_SETTINGS_URLS = {
  calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  reminders: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
  contacts: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  privacy: "x-apple.systempreferences:com.apple.preference.security?Privacy",
} as const;
export type MacSettingsPane = keyof typeof MAC_SETTINGS_URLS;

type MacCapabilitySpec = {
  label: string;
  group: MacAccessGroup;
  pane: MacSettingsPane;
  /**
   * The read-only `mac` command whose first run raises this capability's prompt — doctor's own
   * "run any `mac <group>` command" fix, made concrete. Every one of these LISTS something and
   * mutates nothing, because the user did not ask to send mail to find out whether Realm may.
   * `null` where no prompt exists at all (Full Disk Access is grant-in-Settings-only).
   */
  argv: readonly string[] | null;
  /** True when raising the prompt necessarily launches the target app (AppleScript's `tell`). */
  launchesApp: boolean;
};

/**
 * Every capability `mac doctor` audits, in the order the page lists them: the three EventKit/Contacts
 * grants first (the ones with real prompts and no app to launch), then the AppleScript targets, then
 * Full Disk Access last because it is the only one that cannot be granted from here at all.
 */
export const MAC_CAPABILITIES: Record<MacCapabilityId, MacCapabilitySpec> = {
  calendar: { label: "Calendar", group: "data", pane: "calendars", argv: ["calendar", "calendars", "--json"], launchesApp: false },
  reminders: { label: "Reminders", group: "data", pane: "reminders", argv: ["reminders", "lists", "--json"], launchesApp: false },
  // `find` needs a query; a string no contact can match keeps the probe read-only AND empty.
  contacts: { label: "Contacts", group: "data", pane: "contacts", argv: ["contacts", "find", "realm-permission-check", "--json"], launchesApp: false },
  "automation:Mail": { label: "Mail", group: "automation", pane: "automation", argv: ["mail", "accounts", "--json"], launchesApp: true },
  "automation:Messages": { label: "Messages", group: "automation", pane: "automation", argv: ["messages", "chats", "--json"], launchesApp: true },
  "automation:Notes": { label: "Notes", group: "automation", pane: "automation", argv: ["notes", "folders", "--json"], launchesApp: true },
  "automation:Music": { label: "Music", group: "automation", pane: "automation", argv: ["music", "now", "--json"], launchesApp: true },
  "automation:TV": { label: "TV", group: "automation", pane: "automation", argv: ["tv", "now", "--json"], launchesApp: true },
  "automation:Shortcuts": { label: "Shortcuts", group: "automation", pane: "automation", argv: ["shortcuts", "list", "--json"], launchesApp: true },
  "automation:Finder": { label: "Finder", group: "automation", pane: "automation", argv: ["finder", "disks", "--json"], launchesApp: true },
  "automation:Keynote": { label: "Keynote", group: "automation", pane: "automation", argv: ["keynote", "docs", "--json"], launchesApp: true },
  "automation:Pages": { label: "Pages", group: "automation", pane: "automation", argv: ["pages", "docs", "--json"], launchesApp: true },
  "automation:Numbers": { label: "Numbers", group: "automation", pane: "automation", argv: ["numbers", "docs", "--json"], launchesApp: true },
  fullDiskAccess: { label: "Full Disk Access", group: "disk", pane: "fullDisk", argv: null, launchesApp: false },
};

export function isMacCapabilityId(x: unknown): x is MacCapabilityId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(MAC_CAPABILITIES, x);
}

/** The argv for a capability's prompt-raising command, or null where no prompt exists. The IPC
 *  handler calls this instead of trusting a payload: the renderer can name a row, never a command. */
export function macGrantArgv(id: MacCapabilityId): readonly string[] | null {
  return MAC_CAPABILITIES[id].argv;
}

export function macSettingsUrl(id: string): string {
  return MAC_SETTINGS_URLS[isMacCapabilityId(id) ? MAC_CAPABILITIES[id].pane : "privacy"];
}

export type MacAccessRow = {
  /** `mac doctor`'s capability id. Not narrowed to MacCapabilityId: a future `mac` may audit
   *  something this build has never heard of, and hiding it would be the silence to avoid. */
  id: string;
  label: string;
  group: MacAccessGroup;
  state: MacAccessState;
  /** `mac doctor`'s own `fix` line where it gave one — quoted, never paraphrased. */
  detail: string;
  /** The command Realm would run, shown to the user before they click. Null = no prompt exists. */
  grantCommand: string | null;
  /** Realm has a command that can still raise this prompt. False on granted (nothing to ask), on
   *  denied (fact 2: re-running is guaranteed to fail), and wherever no command exists. */
  canPrompt: boolean;
  /** A trip to System Settings is the reliable fix — the only route on denied and Full Disk Access,
   *  and the honest second option on `writeOnly`, where a re-prompt may or may not come. */
  needsSettings: boolean;
  /** True when raising the prompt will open the target app. Said out loud, never discovered. */
  launchesApp: boolean;
};

export type MacDoctorEntry = { capability: string; status: string; fix: string | null };

const STATES: readonly MacAccessState[] = ["granted", "denied", "notRequested", "writeOnly", "unknown"];

/**
 * Parse `mac doctor --json`. Returns null — not an empty list — when the output is not the array of
 * capability records this expects, so a broken/renamed CLI reads as "couldn't check" rather than as
 * "no capabilities need anything".
 */
export function parseMacDoctor(stdout: string): MacDoctorEntry[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out: MacDoctorEntry[] = [];
  for (const e of parsed) {
    if (typeof e !== "object" || e === null) return null;
    const r = e as Record<string, unknown>;
    if (typeof r.capability !== "string" || typeof r.status !== "string") return null;
    out.push({ capability: r.capability, status: r.status, fix: typeof r.fix === "string" ? r.fix : null });
  }
  return out;
}

/** `mac --version` prints a bare version; anything unrecognisable is null rather than a guess. */
export function parseMacVersion(stdout: string): string | null {
  const line = stdout.trim().split("\n")[0]?.trim();
  return line && /^[0-9]/.test(line) ? line : null;
}

/**
 * Find the `mac` binary. A packaged app launched from Finder inherits launchd's minimal PATH, and
 * although main merges the login shell's PATH at startup (login-shell-path.ts), that merge can fail
 * — so the Homebrew/local dirs are searched too rather than trusting PATH alone.
 */
export const MAC_FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

export function resolveMacBin(deps: { pathEnv: string | undefined; exists(path: string): boolean }): string | null {
  const dirs = [...(deps.pathEnv ?? "").split(":").filter(Boolean), ...MAC_FALLBACK_DIRS];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const candidate = `${dir.replace(/\/+$/, "")}/mac`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

function normalizeState(status: string | undefined): MacAccessState {
  return STATES.includes(status as MacAccessState) ? (status as MacAccessState) : "unknown";
}

/** The fallback detail for a row `mac doctor` gave no `fix` for — never a fabricated instruction. */
function fallbackDetail(state: MacAccessState, hasEntry: boolean): string {
  if (!hasEntry) return "This build of Realm knows the capability but mac doctor didn't report on it — update the mac CLI, or check the toggle in System Settings.";
  switch (state) {
    case "granted": return "macOS reports the grant.";
    case "denied": return "macOS has this refused. Denials are sticky — re-running never re-asks, so the toggle in System Settings is the only way back.";
    case "writeOnly": return "Add-only access: writes succeed and reads come back empty. Switch it to full access in System Settings.";
    case "notRequested": return "Never asked. The first real command raises a macOS dialog.";
    default: return "mac doctor couldn't determine this one.";
  }
}

/**
 * The one row where Realm knows better than `mac doctor` does. Doctor's fix says to grant Full Disk
 * Access to "your terminal app" — true of the shell it was written for, and wrong here, where the
 * app in the list is Realm. Naming the wrong app on the ONE row the user has to find by hand would
 * send them looking for a Terminal entry that has nothing to do with it, so this row says which app
 * to switch on. Everywhere else doctor's own wording still wins.
 */
function fullDiskDetail(hostName: string | undefined): string {
  const who = hostName ?? "Realm";
  return `macOS has no dialog for this one: switch ${who} on in System Settings → Privacy & Security → Full Disk Access, dragging the app in if it isn't listed. Needed to read iMessage history.`;
}

/**
 * The Permissions tab's `mac` rows: every capability this build knows, in table order, then anything
 * doctor reported that it doesn't (rendered read-only rather than dropped). `entries: null` means
 * doctor could not be run or could not be parsed — every row then reads `unknown`, which is what
 * "we don't know" looks like, instead of a list of green checks nobody earned.
 */
export function macAccessRows(entries: MacDoctorEntry[] | null, opts: { hostName?: string } = {}): MacAccessRow[] {
  const byId = new Map((entries ?? []).map((e) => [e.capability, e]));
  const rows: MacAccessRow[] = [];
  for (const id of Object.keys(MAC_CAPABILITIES) as MacCapabilityId[]) {
    const spec = MAC_CAPABILITIES[id];
    const entry = byId.get(id);
    byId.delete(id);
    const state = entries === null ? "unknown" : normalizeState(entry?.status);
    const detail = id === "fullDiskAccess"
      ? fullDiskDetail(opts.hostName)
      : entry?.fix ?? fallbackDetail(state, entries !== null && entry !== undefined);
    rows.push({
      id, label: spec.label, group: spec.group, state, detail,
      grantCommand: spec.argv ? `mac ${spec.argv.join(" ")}` : null,
      // Fact 2 (denied is sticky) and fact 3 (granted has nothing left to ask) both live here.
      canPrompt: spec.argv !== null && state !== "granted" && state !== "denied",
      needsSettings: state !== "granted" && (spec.argv === null || state === "denied" || state === "writeOnly"),
      launchesApp: spec.launchesApp,
    });
  }
  for (const [id, entry] of byId) {
    const state = normalizeState(entry.status);
    rows.push({
      id, label: id, group: "other", state,
      detail: entry.fix ?? "Reported by mac doctor; this build of Realm has no command for it.",
      grantCommand: null, canPrompt: false, needsSettings: state !== "granted", launchesApp: false,
    });
  }
  return rows;
}

/**
 * The ids "Grant all" actually attempts, in row order — everything with a prompt still worth
 * raising. Granted rows are skipped (nothing to ask), denied rows are skipped (asking cannot work),
 * and Full Disk Access is skipped because no prompt for it exists. The page reports what it skipped
 * rather than letting a short run read as full coverage.
 */
export function grantPlan(rows: MacAccessRow[]): string[] {
  return rows.filter((r) => r.canPrompt).map((r) => r.id);
}

/** Rows the user still has to finish by hand in System Settings, after every prompt has been raised. */
export function settingsOnlyRows(rows: MacAccessRow[]): MacAccessRow[] {
  return rows.filter((r) => r.needsSettings && !r.canPrompt);
}

export function grantedCount(rows: MacAccessRow[]): number {
  return rows.filter((r) => r.state === "granted").length;
}

/** Which app macOS attributes these grants to, and whether that is the app the user thinks it is. */
export type MacAccessHost = {
  /** The name that will appear in System Settings' Automation/Calendars lists. */
  name: string;
  /** The bundle to reveal in Finder for the drag into Full Disk Access. */
  bundlePath: string;
  /** False under `pnpm dev`, where the host is Electron and the grants do not carry into Realm.app. */
  packaged: boolean;
};

export type MacCliStatus =
  | { present: true; path: string; version: string | null }
  | { present: false; searched: string[] };

export type MacAccessStatus = { cli: MacCliStatus; rows: MacAccessRow[]; host: MacAccessHost };

/**
 * The bundle path to reveal in Finder. Electron's `app.getPath("exe")` points at the binary INSIDE
 * `Realm.app/Contents/MacOS/`, which is not what anyone can drag into a Full Disk Access list — the
 * `.app` directory above it is. Falls back to the executable when the path has no `.app` component
 * (a dev run of the raw Electron binary), because revealing something beats revealing nothing.
 */
export function appBundlePath(execPath: string): string {
  const i = execPath.indexOf(".app/");
  return i === -1 ? execPath : execPath.slice(0, i + ".app".length);
}

/**
 * The name macOS will actually print in its consent dialog and in System Settings' lists — which is
 * the bundle's, not the app's idea of itself. Packaged, those agree ("Realm"). Under `pnpm dev` they
 * do NOT: Electron's own bundle is the host, so macOS says "Electron" while `app.getName()` says
 * "@realm/desktop" (the package name). Naming the wrong app in the dev caveat would send the user
 * hunting for a row that will never appear, so the bundle wins wherever it can be read.
 */
export function macHostName(d: { appName: string; bundlePath: string; packaged: boolean }): string {
  if (d.packaged) return d.appName;
  const base = d.bundlePath.split("/").pop() ?? "";
  return base.endsWith(".app") ? base.slice(0, -".app".length) : d.appName;
}
