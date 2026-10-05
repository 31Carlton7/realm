import { clipboard, app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, Tray, type MenuItemConstructorOptions, type WebContents } from "electron";
import { BrowserCredentialInputSchema, newId, type BrowserAction, type BrowserAnnotateResult, type BrowserCredential, type BrowserMenuState, type BrowserScreenshotSaved, type BrowserSignInShare, type MediaFile, type Passkey } from "@realm/contracts";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { serverEntry, spawnDaemon, startServer } from "./server-process";
import { daemonStatePath, readDaemonState, readStateForPort, realmHomePath } from "./daemon-state";
import { callDaemon, daemonModeEnabled, ensureDaemon, probeDaemon, type HandoffResult } from "./daemon";
import { ProfileDirectory, isBrowserPartition, type ProfileFacts } from "./profile-directory";
import { decideHandoff, handoffCopy, type DaemonWork } from "./handoff-policy";
import { bundleIdOf, DAEMON_HANDOFF_MODE_DEFAULT, DAEMON_HANDOFF_MODE_KEY, resolveHandoffMode, type DaemonState } from "@realm/contracts";
import { closeDaemonLog, daemonLogPath, openDaemonLog } from "./daemon-log";
import { DaemonSupervisor, type DaemonUiState } from "./daemon-supervisor";
import { SessionTray, type TraySession } from "./session-tray";
import { confirmQuitCopy, decideQuit } from "./quit-policy";
import { NOTIFICATIONS_DESKTOP_KEY, POWER_PREVENT_SLEEP_KEY } from "@realm/contracts";
import type { BridgeClient } from "./browser-agent-bridge";
import { loginShellPath, mergePath } from "./login-shell-path";
import { startScrollPhaseStream } from "./scroll-phase";
import { compressIconIfNeeded, describeFiles, existingPath, fileThumbnail, openablePath, saveTempAttachment, statFile, sweepTempAttachments, tempAttachmentDir, type PickedFile } from "./attachments";
import { clearBrowserPartition, createBrowserPane, governBrowserDownloads, shareSiteCookies, type BrowserPane, type DownloadPolicy } from "./browser-pane";
import { refuseCapture } from "./capture-guard";
import { BlockedDownloads, DownloadGovernor, SavedDownloads, retryBlockedDownload } from "./downloads";
import { nextZoomFactor, searchUrl, type ViewRect } from "./browser-host";
import { clearBrowsingData, saveBrowserScreenshot } from "./browser-controls";
import { BrowserAgentHost } from "./browser-agent-host";
import { AppDriveHost } from "./app-drive";
import { registerAppPick } from "./app-pick";
import { startBrowserAgentBridge } from "./browser-agent-bridge";
import { TCC_SETTINGS_URLS, isTccPermissionId, probeTcc, type TccRow } from "./tcc";
import { ComputerUseHelper, axHelperPath } from "./computer-use-helper";
import { ComputerUseHost } from "./computer-use-host";
import { ComputerDrivingIndicator } from "./computer-driving";
import { computerAccessRows, isComputerAccessId, type ComputerAccessStatus } from "./computer-access";
import {
  MAC_CAPABILITIES, MAC_FALLBACK_DIRS, appBundlePath, isMacCapabilityId, macAccessRows, macGrantArgv, macHostName, macSettingsUrl,
  parseMacDoctor, parseMacVersion, resolveMacBin, type MacAccessHost, type MacAccessStatus,
} from "./mac-access";
import { RealmUpdater, UPDATE_FEED_LIVE, updaterDecision } from "./updater";
import { SecretStore, SecretStoreError } from "./secret-store";
import { PasskeyBroker } from "./passkeys";
import { DesktopNotifier, type DesktopNotificationInput } from "./notify";
import { applyReducedMotion } from "./reduced-motion";
import { SleepGuard } from "./sleep-guard";
import { installedEditors, openInEditor } from "./editors";
import { InstalledApps, applicationDirs } from "./installed-apps";
import { registerKeyWindowQuery, wireKeyWindow } from "./key-window";
import { registerNativeMenus } from "./native-menu";
import { attachTextContextMenu } from "./text-context-menu";
import { appMenuTemplate, pageChords, shouldPageOwn } from "./app-menu";
import { readWindowState, restoredBounds, trackWindowState, windowStateFileName } from "./window-state";
import { WindowRegistry, cascadeFrom } from "./window-registry";
import { registerFileActions } from "./file-actions";
import { AppIconStore, registerAppIcon } from "./app-icon";
import { registerAppearance, savedAppearance } from "./appearance";
import { DEFAULT_KEYBINDINGS, KeybindingSchema, type Keybinding } from "@realm/contracts";
import { browseFolder, type BrowseResult } from "./browse";
import { handleMediaProtocol, mediaPoster, registerMediaScheme, servablePath, statMedia } from "./media";

/* `realm-media://` has to be declared privileged before `app.ready`, which is why this is a
   top-level statement rather than a line in `whenReady` — Electron ignores the registration
   afterwards, and the failure mode is a scheme that silently serves nothing. The handler that
   actually reads files is installed in `whenReady`, once the server has told us where home is. */
registerMediaScheme();

/** The server child, in the non-daemon shape: a process this one owns and SIGTERMs on quit. */
let serverChild: import("node:child_process").ChildProcess | null = null;
/** The daemon, when we are the launch that started it. Deliberately NOT the liveness signal — the
 *  whole point of a daemon is that the next launch adopts one it has no handle for, so supervision
 *  goes through the bridge and the recorded pid instead. Held only so a `Quit Realm & stop agents`
 *  in the same session as the spawn does not have to go back to the file for a pid. */
let daemonChild: import("node:child_process").ChildProcess | null = null;
/** Watches the daemon through the bridge, and brings it back when it dies. Null in the non-daemon
 *  shape, where the server child's own `exit` would be the signal and there is nothing to restart. */
let daemonSupervisor: DaemonSupervisor | null = null;
/** Set when the launcher adopted a daemon this build did not ship, because the user chose to keep it
 *  working. The renderer refuses to start new sessions while it is set. */
let staleDaemon: "bundle" | "protocol" | null = null;
/** The last thing said about the server's health, replayed to every window that opens — a banner
 *  that only appears if you happened to have a window open when the event fired is a banner that
 *  lies by omission. */
let lastDaemonState: DaemonUiState | null = null;
function publishDaemonState(state: DaemonUiState) {
  lastDaemonState = state;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("daemon:state", state);
}
/** The three facts about the server, kept so a window recreated from the tray or the dock can be
 *  built without going back through the launcher. */
let serverInfo: { port: number; home: string; token: string } | null = null;
/** RPC over the bridge's socket, for the questions main asks on its own behalf: the tray's counts,
 *  and the window flag the server refuses browser ops by. Null while the bridge is down. */
let bridgeClient: BridgeClient | null = null;

/** Ask realm-server something: on the bridge when it is up, and on a socket of its own before then —
 *  the window's first browser panes ask whose they are before the bridge has connected. */
async function askServer(method: string, params: unknown): Promise<unknown> {
  if (bridgeClient) return bridgeClient.call(method, params);
  if (!serverInfo) throw new Error("Realm is still starting up");
  return callDaemon({ port: serverInfo.port, token: serverInfo.token }, method, params, 5_000);
}

/**
 * Profiles as main needs them (profile-directory.ts): each one's browser partition and name, and which
 * one kept the jar every pane used to share. Asked at launch, again on `profiles.changed`, and on a
 * miss. A profile that disappears was deleted, and what main holds for it goes with it.
 */
const profileDirectory = new ProfileDirectory({
  fetch: () => askServer("profiles.list", {}),
  onRemoved: (profile) => forgetProfile(profile),
});

/** A profile id as the renderer names one. Not a lookup — the store answers an unknown profile with
 *  nothing — only a guard against a value that is not an id at all. */
const profileArg = (v: unknown): string => (typeof v === "string" && /^[0-9A-Za-z]{1,64}$/.test(v) ? v : "");

/** Whose a browser pane is: the profile that owns its view's partition — each profile's is its own,
 *  and the view was made in its space's profile's (`browser:create`). Read off the view itself, so a
 *  view rebuilt in another profile's jar can never be mistaken for its old profile's. What the passkey
 *  broker and the fill op read to find a pane's keys and sign-ins: a pane's secrets are its profile's. */
function profileOfPane(browserId: string): string | null {
  const partition = paneFor(browserId)?.partitionOf(browserId);
  return partition ? profileDirectory.byPartition(partition)?.id ?? null : null;
}

/** Whose browser this is, asked of the server (`browsers.profile`). Null for a pane, space or profile
 *  that is gone — such a pane gets no view rather than a guess at whose cookies to give it. */
async function browserOwner(browserId: string): Promise<{ profileId: string; partition: string } | null> {
  try {
    const r = (await askServer("browsers.profile", { browserId })) as { profileId?: unknown; partition?: unknown } | null;
    return typeof r?.profileId === "string" && isBrowserPartition(r.partition) ? { profileId: r.profileId, partition: r.partition } : null;
  } catch { return null; }
}

/** Every window titled by the profile it shows, as the names stand now — a rename re-titles it. */
function retitleWindows(): void {
  for (const win of windows.all()) {
    const id = windows.showing(win);
    const name = id ? profileDirectory.get(id)?.name : null;
    if (name) win.setTitle(name);
  }
}

/** A deleted profile: its panes close, its partition's cookies, site data and cache are cleared — a
 *  jar nobody can open again must not keep anybody signed in — and its saved sign-ins and passkeys go.
 *  Copies it shared stay with the profiles they were shared into. */
function forgetProfile(profile: ProfileFacts): void {
  // A window opened FOR the profile has nothing left to show; it closes, unless it is the last window.
  // The first window, which was opened for no profile, stays and moves to another profile's space.
  for (const win of windows.all()) if (windows.boundTo(win) === profile.id && windows.size > 1) win.close();
  for (const { pane } of windowPanes.values()) pane.host.destroyPartition(profile.browserPartition);
  void clearBrowserPartition(profile.browserPartition).catch(() => {});
  secrets()?.forgetProfile(profile.id);
}

/**
 * The menu-bar item, up whenever the window is not.
 *
 * It is the only visible thing left after ⌘Q, which is why it exists at all: a person is entitled to
 * know that something is still running and to be able to stop it, and with the window gone there is
 * nowhere else to say either.
 */
const sessionTray = new SessionTray({
  createTray: () => {
    const tray = new Tray(nativeImage.createEmpty());
    return {
      setTitle: (t) => tray.setTitle(t),
      setToolTip: (t) => tray.setToolTip(t),
      setContextMenu: (template) => tray.setContextMenu(Menu.buildFromTemplate(template)),
      destroy: () => tray.destroy(),
    };
  },
  actions: {
    reattach: (target) => { void reattach(target); },
    stopAllAgents: () => { void bridgeClient?.call("daemon.stopAgents", {}).catch(() => {}); },
    quitAndStop: () => { void quitAndStopAll(); },
  },
});

/** The counts the tray shows, asked of the daemon. Null when the bridge is down, which the callers
 *  read as "we do not know" rather than as zero — claiming nothing is running is the one wrong answer
 *  here, because it is the answer that makes a quit look safe. */
async function daemonCounts(): Promise<{ working: number; needsYou: number } | null> {
  try {
    const info = await bridgeClient?.call("daemon.info", {});
    const r = info as { working?: unknown; needsYou?: unknown } | undefined;
    if (typeof r?.working !== "number" || typeof r.needsYou !== "number") return null;
    return { working: r.working, needsYou: r.needsYou };
  } catch { return null; }
}

/**
 * Show a toast for a surfaced row while there is no window.
 *
 * The renderer owns this whenever it exists; this is only the resident's half. The user's
 * `notifications.desktop` switch is read from the server rather than assumed, because a person who
 * turned toasts off did not mean "except when the window is closed".
 */
async function residentToast(payload: unknown) {
  const p = payload as { notification?: { id?: unknown; title?: unknown; body?: unknown } | null; unread?: unknown } | undefined;
  if (typeof p?.unread === "number") desktopNotifier.badge(p.unread);
  const n = p?.notification;
  if (!n || typeof n.id !== "string" || typeof n.title !== "string") return;
  try {
    const enabled = await bridgeClient?.call("settings.get", { key: NOTIFICATIONS_DESKTOP_KEY });
    if ((enabled as { value?: unknown } | null)?.value === false) return;
  } catch { return; }
  desktopNotifier.show({ id: n.id, title: n.title, body: typeof n.body === "string" ? n.body : null }, "main");
}

/** Refresh the tray from the daemon. Called on every `session.status` and on each reconnect, both of
 *  which are the only ways these numbers change. */
async function refreshTray() {
  if (!sessionTray.showing) return;
  const counts = await daemonCounts();
  if (!counts) return;
  const sessions = await trayCandidates();
  sessionTray.update(counts, sessions);
}

/** Settings ▸ General ▸ Power's "keep the Mac awake" — held here, in main, because agents keep
 *  working with no window open, and only main is there for all of it. */
const sleepGuard = new SleepGuard(powerSaveBlocker);

/** Re-read whether anything is running, on the same event the tray's counts change on. A bridge
 *  that cannot answer reads as nothing running: with no daemon to ask there are no turns to keep a
 *  Mac awake for, and holding on to a blocker for an answer we cannot get is how one leaks. */
async function refreshSleepGuard() {
  const counts = await daemonCounts();
  sleepGuard.setWorking(counts?.working ?? 0);
}

/** The preference, read from the server when main (re)connects: the renderer pushes changes as they
 *  happen, but a launch with no window, or a daemon restarted under it, has to find out for itself. */
async function readSleepPreference() {
  try {
    const stored = await bridgeClient?.call("settings.get", { key: POWER_PREVENT_SLEEP_KEY });
    sleepGuard.setPreference((stored as { value?: unknown } | null)?.value === true);
  } catch { /* the bridge dropped mid-ask; the next connect asks again */ }
}

/** The sessions worth naming in the menu: the ones waiting on an answer first, then the ones working.
 *  An idle session is not a reason to open the app, so it is not in the list. */
async function trayCandidates(): Promise<TraySession[]> {
  try {
    const [rows, spaces] = await Promise.all([
      bridgeClient!.call("sessions.listAll", {}) as Promise<{ id: string; title: string; status: string; spaceId: string }[]>,
      bridgeClient!.call("spaces.list", {}) as Promise<{ id: string; name: string }[]>,
    ]);
    const nameOf = new Map(spaces.map((sp) => [sp.id, sp.name]));
    const rank = (status: string) => (status === "waiting_permission" ? 0 : status === "running" ? 1 : 2);
    return rows
      .filter((r) => rank(r.status) < 2)
      .sort((a, b) => rank(a.status) - rank(b.status))
      .map((r) => ({ id: r.id, spaceId: r.spaceId, title: r.title, spaceName: nameOf.get(r.spaceId) ?? null }));
  } catch { return []; }
}
/** Realm's data directory, as announced by the server on startup. Pasted attachments live under it. */
let realmHome: string | null = null;
/**
 * Realm's windows (window-registry.ts): one for the first launch, and one more for each profile opened
 * in a window of its own (Plan 27 Phase 2). Main used to hold a single window and assume it; everything
 * that needs "the" window outside a renderer's own IPC — the notification gate, a toast click, the tray,
 * a second launch, Realm driving its own interface — asks the registry for the one used last.
 */
const windows = new WindowRegistry<BrowserWindow>();
/** Each window's browser-pane views (Plan 11 W1), by window id. A view composites into ONE window, so
 *  an IPC acts on its sender's views, and an agent's op finds the window holding the view it names. */
const windowPanes = new Map<number, { win: BrowserWindow; pane: BrowserPane }>();

/** The views of the window an IPC came from. */
function senderPane(sender: WebContents): BrowserPane | null {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? windowPanes.get(win.id)?.pane ?? null : null;
}
/** The window and views holding a live view for this browser — the sender's, if it holds it, so the
 *  window a person is acting in always wins. Null when no window has it. */
function holderOf(browserId: string, sender?: WebContents): { win: BrowserWindow; pane: BrowserPane } | null {
  const own = sender ? BrowserWindow.fromWebContents(sender) : null;
  const first = own ? windowPanes.get(own.id) : undefined;
  if (first?.pane.hasView(browserId)) return first;
  for (const entry of windowPanes.values()) if (entry.pane.hasView(browserId)) return entry;
  return null;
}
const paneFor = (browserId: string, sender?: WebContents): BrowserPane | null => holderOf(browserId, sender)?.pane ?? null;

/* The element picker over Realm's own window (app-pick.ts): a window says when its person is picking,
   and asks for the picture of a pick — always the window's OWN capture, and never inside a browser
   pane's view. Keyed by the window's webContents, which is the only sender it answers. */
const appPicks = registerAppPick({
  on: (channel, fn) => ipcMain.on(channel, fn),
  handle: (channel, fn) => ipcMain.handle(channel, fn),
  windowOf: (sender) => {
    const wc = sender as WebContents;
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed() || win.webContents !== wc) return null;
    return {
      key: wc.id,
      window: {
        size: () => { const [width = 0, height = 0] = win.getContentSize(); return { width, height }; },
        views: () => win.contentView.children.filter((v) => v.getVisible()).map((v) => v.getBounds()),
        zoom: () => wc.getZoomFactor(),
        capture: async (rect) => {
          const image = await wc.capturePage(rect);
          if (image.isEmpty()) return null;
          // At the display's scale: the bitmap is that many times the DIP size `getSize` reports.
          const { width, height } = image.getSize();
          const bitmap = image.toBitmap();
          const scale = Math.max(1, Math.round(Math.sqrt(bitmap.length / 4 / (width * height))));
          return { bgra: new Uint8Array(bitmap), width: width * scale, height: height * scale };
        },
      },
    };
  },
  save: async ({ bgra, width, height }, name) => {
    if (!realmHome) throw new Error("Realm is still starting up");
    const png = nativeImage.createFromBitmap(Buffer.from(bgra), { width, height }).toPNG();
    return saveTempAttachment(realmHome, name, "image/png", png);
  },
});

/* Realm driving its own window. Its CDP target is a window's own webContents — the one the person
   used last — so unlike the browser executor it holds no per-view state and survives as one instance;
   `forget()` clears the snapshot index whenever the window it indexes changes or goes away. It stands
   down while anyone is picking, so an agent's click can never land as the person's pick. */
let appDriveWindow: number | null = null;
const appDriveHost = new AppDriveHost({
  picking: () => appPicks.any(),
  attach: () => {
    const win = BrowserWindow.getFocusedWindow() ?? windows.primary();
    if (!win || win.isDestroyed()) return null;
    if (appDriveWindow !== win.id) { appDriveHost.forget(); appDriveWindow = win.id; }
    const wc = win.webContents;
    try { if (!wc.debugger.isAttached()) wc.debugger.attach("1.3"); } catch { return null; }
    return { send: (method: string, params?: Record<string, unknown>) => wc.debugger.sendCommand(method, params) as Promise<unknown> };
  },
});
let agentBridge: { stop(): void } | null = null;
/**
 * Computer use (the `realm-computer` tools): the native accessibility helper and the executor over
 * it. App-scoped and window-independent — unlike the browser executor there are no views involved,
 * and an op is answered the same whether a Realm window happens to be open.
 *
 * The helper CHILD is not spawned here. `ComputerUseHelper` starts it on the first op and gives it
 * up when it exits, so a process that can read other apps' windows and post synthetic input exists
 * only while an agent is driving something.
 */
const computerHelper = new ComputerUseHelper({ helperPath: axHelperPath, onLog: (line) => console.error(line) });
/**
 * The menu-bar item that says the Mac is being driven — see `computer-driving.ts` for why the signal
 * is there rather than in a Realm window.
 *
 * Built with an empty image and carried by its title: a menu-bar item that only exists while an act
 * is in flight has to say what it is in words, where a glyph would be one more unexplained icon
 * appearing during the exact seconds the user's attention is on another application.
 */
const computerDriving = new ComputerDrivingIndicator({
  createTray: () => {
    const tray = new Tray(nativeImage.createEmpty());
    return { setTitle: (t) => tray.setTitle(t), setToolTip: (t) => tray.setToolTip(t), destroy: () => tray.destroy() };
  },
});
const computerHost = new ComputerUseHost({
  available: () => computerHelper.available,
  request: (method, params) => computerHelper.request(method, params),
  driving: (appName) => { if (appName === null) computerDriving.release(); else computerDriving.acquire(appName); },
});
/** The encrypted secret store (safeStorage + the OS Keychain). App-scoped, not per-window: the
 *  bridge asks it for the `oauth` key at registration, and Settings enrolls into it. Built lazily
 *  because it needs `realmHome`, which arrives with the server's ready line. */
let secretStore: SecretStore | null = null;
/** What each pane has saved, for its ⋯ menu's Downloads (Plan 26 W7b). Beside the governor, which
 *  feeds it: the user's own Save and an approved agent download are both a file this pane put on disk. */
const savedDownloads = new SavedDownloads(() => Date.now());
/** The download governor (Plan 23). App-scoped: it owns the partition-wide `will-download` handler,
 *  which is registered once and outlives any window. */
const downloadGovernor = new DownloadGovernor({
  mkdirp: (dir) => { mkdirSync(dir, { recursive: true }); },
  exists: (p) => existsSync(p),
  now: () => Date.now(),
  onSaved: (browserId, saved) => savedDownloads.note(browserId, saved),
});
/** Plan 23 W4: what the pane's blocked-download bar reads. App-scoped alongside the governor. */
const blockedDownloads = new BlockedDownloads(() => Date.now());

/** The person's keybindings as the renderer last reported them, and the chords they claim. The
 *  shipped table until the renderer has loaded the file — the menu bar exists before any window. */
let menuRules: readonly Keybinding[] = DEFAULT_KEYBINDINGS;
let ownedChords = pageChords(menuRules);

/** The menu bar (app-menu.ts). Its rows are keybinding-catalog commands showing the person's own
 *  shortcuts; a click runs the command in the focused window's renderer. Rebuilt whenever the
 *  keybindings change, so the menu never advertises a chord that no longer does what it says. */
function installMenu() {
  const template = appMenuTemplate({
    appName: "Realm",
    rules: menuRules,
    send: (command) => (BrowserWindow.getFocusedWindow() ?? windows.primary())?.webContents.send("app:command", command),
    openExternal: (url) => void shell.openExternal(url),
    developer: !app.isPackaged,
    darwin: process.platform === "darwin",
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Dev affordance: REALM_DEVTOOLS_PORT=9223 exposes the Chrome DevTools protocol for tooling.
if (process.env.REALM_DEVTOOLS_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.REALM_DEVTOOLS_PORT);

// Load-bearing for the browser agent (Plan 11 W3), found empirically and held by the live check:
// when macOS marks the window occluded, Chromium backgrounds its renderers, and a backgrounded
// WebContentsView that goes through a cross-process navigation never produces a compositor frame —
// after which BOTH synthetic input paths (CDP Input.dispatchMouseEvent and wc.sendInputEvent) are
// silently dropped until a fresh frame exists (a reload or a real resize revives it; nothing cheaper
// does). With this switch, occluded windows keep compositing and agent input works no matter what is
// stacked over Realm. Cost: some battery while occluded — a workstation-app tradeoff made knowingly.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

/**
 * Open a Realm window. With no `profileId` it is the first window, which shows whichever profile its
 * saved space is in; with one it is that profile's window (Plan 27 Phase 2), told so on its command
 * line (`window.realm.profileId`) so its first paint is already that profile's.
 */
async function createWindow(info: { port: number; home: string; token: string }, profileId: string | null = null) {
  // Where it was left (window-state.ts) — each profile window its own place. The primary display
  // first: a place that can no longer be reached is replaced by the saved size, centred there. A
  // profile window with no place yet opens just off the window it was opened from.
  const windowStateFile = join(app.getPath("userData"), windowStateFileName(profileId));
  const savedWindow = readWindowState(windowStateFile) ?? (profileId !== null ? cascadeFrom(windows.primary()?.getNormalBounds() ?? null) : null);
  const primary = screen.getPrimaryDisplay();
  const place = restoredBounds(savedWindow,
    [primary.workArea, ...screen.getAllDisplays().filter((d) => d.id !== primary.id).map((d) => d.workArea)],
    { width: 1400, height: 900, minWidth: 900, minHeight: 600 });
  const win = new BrowserWindow({
    ...(place.center ? { width: place.width, height: place.height, center: true }
      : { x: place.x, y: place.y, width: place.width, height: place.height }),
    minWidth: 900, minHeight: 600,
    // y:14 centres the ~14px lights in a 40px strip, and the renderer keeps every strip they can land
    // in at 40px for exactly that reason: .sb-head with the sidebar open, and with it collapsed the
    // first pane's .panel-bar (or the group bar, which is raised to 40px in that one state). One
    // placement serves both, so nothing here has to be moved at runtime when the sidebar collapses —
    // but shortening any of those strips leaves the lights sitting off-centre in that state.
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 },
    // Ara refresh §5: macOS gets sidebar vibrancy behind a fully transparent window paint; the
    // renderer keeps every surface EXCEPT the sidebar opaque, so only the sidebar column shows the
    // material (the BUI --page tone at .82 over it — "ever so slightly transparent"). Elsewhere
    // vibrancy does not exist, so the window keeps its opaque dark ground and the translucent
    // sidebar composites against it — visually the BUI dark --page (#17181a ≈ oklch(.209 .004
    // 264.477)), never a half-broken effect.
    ...(process.platform === "darwin"
      ? { vibrancy: "sidebar" as const, backgroundColor: "#00000000" }
      : { backgroundColor: "#17181a" }),
    // sandbox: false because electron-vite emits an ESM preload (.mjs), which Electron only loads unsandboxed.
    webPreferences: { preload: join(__dirname, "../preload/index.mjs"), contextIsolation: true, sandbox: false,
      additionalArguments: [`--realm-port=${info.port}`, `--realm-home=${info.home}`, `--realm-token=${info.token}`,
        ...(profileId !== null ? [`--realm-profile=${profileId}`] : [])] },
  });
  windows.add(win, profileId);
  win.on("focus", () => windows.focused(win));
  // The title is the profile's name — what the Window menu, Mission Control and the Dock list the
  // window by — and main sets it, so the page's own <title> does not put "Realm" back over it.
  win.on("page-title-updated", (e) => e.preventDefault());
  if (profileId !== null) win.setTitle(profileDirectory.get(profileId)?.name ?? "Realm");
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Keep the top frame inside the app: dev server origin in dev, file:// in production.
  const devOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null;
  win.webContents.on("will-navigate", (e, url) => {
    const inApp = devOrigin ? url === devOrigin || url.startsWith(`${devOrigin}/`) : url.startsWith("file://");
    if (!inApp) e.preventDefault();
  });
  // The views go in before the page loads: a restored browser pane asks for its view as soon as the
  // renderer boots, and a window with no pane surface yet would have nowhere to put it.
  const pane = createBrowserPane(win, (paneId, cdp) => passkeys.install(paneId, cdp)); // destroys its views on win "closed" itself
  windowPanes.set(win.id, { win, pane });
  pane.onViewDestroyed((id) => { agentHost.release(id); passkeys.release(id); });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
  if (savedWindow?.fullScreen) win.setFullScreen(true);
  else if (savedWindow?.maximized) win.maximize();
  trackWindowState(win, windowStateFile);
  wireKeyWindow(win);
  attachTextContextMenu(win.webContents);
  // Replay whatever the server's health last was. A window created after the event — reopened from
  // the tray, or the first one on a launch that adopted a stale daemon — has heard nothing yet.
  if (lastDaemonState) win.webContents.send("daemon:state", lastDaemonState);
  // Native trackpad phases for the rubber band at a scroller's ends (macOS; optional helper).
  const phases = startScrollPhaseStream(win);
  const id = win.id;
  // A reload or a closed window ends a pick its page can no longer finish.
  const pickKey = win.webContents.id;
  win.webContents.on("did-navigate", () => appPicks.set(pickKey, false));
  win.on("closed", () => {
    appPicks.set(pickKey, false);
    phases.stop();
    windows.remove(win);
    windowPanes.delete(id);
    if (appDriveWindow === id) { appDriveHost.forget(); appDriveWindow = null; }
  });
}

/**
 * Passkeys (passkeys.ts). Electron gives a pane Chromium's WebAuthn API and no authenticator behind
 * it, which is what a site reports as partial passkey support; the broker puts one there, holds the
 * private keys in the same Keychain-sealed store the saved sign-ins live in, and puts Touch ID in
 * front of every use. One broker for every window: a pane is named by its browser id, which is
 * unique across windows, and its keys are its PROFILE's.
 *
 * The reach into the store is a bag of bound methods rather than the store itself, for the reason
 * the agent host's `secrets` is: nothing here can call `exportOauthKey`, and there is no key export
 * for passkeys to call in the first place.
 */
const passkeys = new PasskeyBroker({
  pageUrl: (paneId) => paneFor(paneId)?.pageState(paneId)?.url ?? null,
  // A pane's passkeys are its profile's. A pane main has no profile for has none.
  hasPasskeyFor: (paneId, rpId) => {
    const profileId = profileOfPane(paneId);
    return profileId ? secrets()?.hasPasskeyFor(profileId, rpId) ?? false : false;
  },
  withPasskeysFor: async (paneId, rpId, kind, use) => {
    const profileId = profileOfPane(paneId);
    return (profileId ? await secrets()?.withPasskeysFor(profileId, rpId, kind, use) : null) ?? { ok: false, refused: "no_passkey" };
  },
  recordPasskey: (paneId, input) => {
    const profileId = profileOfPane(paneId);
    if (profileId) secrets()?.recordPasskey(profileId, input);
  },
  notePasskeyUse: (paneId, credentialId, signCount) => {
    const profileId = profileOfPane(paneId);
    if (profileId) secrets()?.notePasskeyUse(profileId, credentialId, signCount);
  },
  // Biometrics only, like every other presence check here: `promptTouchID` has no password
  // fallback, so a Mac without a sensor is told so rather than shown a prompt that cannot pass.
  canPromptPresence: () => process.platform === "darwin" && systemPreferences.canPromptTouchID(),
  // To the window holding the pane, which is the one whose bar can say why.
  notify: (notice) => {
    const win = holderOf(notice.browserId)?.win;
    if (win && !win.isDestroyed()) win.webContents.send("realm:browser-passkey", notice);
  },
  audit: (entry) => secrets()?.audit(entry),
  now: () => Date.now(),
});

/**
 * The agent executor (W3): drives the panes' views over in-process CDP for realm-server's
 * realm-browser tools. One for every window — each op names a browser, and the executor finds the
 * window holding its view; buffers and snapshot-diff state die with each view. Between windows it
 * honestly reports "pane not open".
 */
const agentHost = new BrowserAgentHost({
  attach: (id) => paneFor(id)?.attachCdp(id) ?? null,
  hasView: (id) => paneFor(id) !== null,
  touch: (id) => paneFor(id)?.host.touch(id),
  navigate: (id, url) => paneFor(id)?.host.navigate(id, url) ?? null,
  pageState: (id) => paneFor(id)?.pageState(id) ?? null,
  // The fill op's only reach into the store. Passed as an object of bound methods rather than the
  // store itself, so the executor host cannot reach `exportOauthKey` or anything added later.
  secrets: {
    listCredentials: (profileId) => secrets()?.listCredentials(profileId) ?? [],
    getCredential: (profileId, id) => secrets()?.getCredential(profileId, id) ?? null,
    withCredentialValue: async (profileId, id, use) => secrets()?.withCredentialValue(profileId, id, use) ?? { ok: false, refused: "no_credential" },
    // No store means no place to keep a password, which is a different answer from "nothing is
    // enrolled" — and the only safe one, since Realm must not type a secret it cannot save.
    withGeneratedCredentialValue: async (profileId, input, use) =>
      secrets()?.withGeneratedCredentialValue(profileId, input, use) ?? { ok: false, refused: "no_store" },
    audit: (entry) => secrets()?.audit(entry),
  },
  profileOf: (id) => profileOfPane(id),
  downloads: downloadGovernor,
  // The `upload` op's drop route, and nothing else. The path is already resolved, symlink-checked,
  // confined and user-approved by the time it reaches here — realm-server did all of that before
  // it raised the permission card — so this reads exactly what it was handed and decides nothing.
  readFile: async (path) => new Uint8Array(await readFile(path)),
});

/** The browser a download came from, in whichever window holds its view. */
function browserIdOfWebContents(wcId: number): string | null {
  for (const { pane } of windowPanes.values()) {
    const id = pane.browserIdForWebContents(wcId);
    if (id) return id;
  }
  return null;
}
/**
 * Downloads on every profile's partition are DEFAULT-DENY (Plan 11 W3), narrowed by Plan 23 to let
 * through exactly those covered by a live one-shot grant from an approved `browser_download`.
 * Everything else is still cancelled, in every permission mode. One policy, applied to each partition
 * the first time a view is made in it (`governBrowserDownloads`).
 */
const downloadPolicy: DownloadPolicy = {
  browserIdFor: browserIdOfWebContents,
  decide: (browserId, item) => downloadGovernor.handle(browserId, item),
  onBlocked: (wcId, url, reason, filename) => {
    const id = browserIdOfWebContents(wcId);
    if (id) {
      agentHost.noteBlockedDownload(id, url);
      // W4: remember it so the pane can say so and offer to fetch it. A download the user started
      // and that vanished without a word is the papercut this removes. Told to the window holding
      // the pane — the one whose download bar can show it.
      const entry = blockedDownloads.note(id, url, filename);
      const win = holderOf(id)?.win;
      if (entry && win && !win.isDestroyed()) win.webContents.send("realm:browser-download-blocked", { browserId: id, blocked: entry });
    }
    console.error(`[browser-agent] download blocked (${reason})${id ? ` (browser ${id})` : ""}: ${url}`);
  },
};

// Browser pane (Plan 11 W1): the renderer drives the native WebContentsViews over this surface.
// Mutations are invokes; the per-frame bounds sync is a plain send (no reply to wait on).
/* A view is made in its PROFILE's partition — the space's profile, asked of realm-server each time a
   pane mounts — so a space moved to another profile brings its panes to that profile's jar, and the
   renderer has no say in whose cookies a pane gets. */
ipcMain.handle("browser:create", async (e, id: string, url: string, allowlist: string[] | null) => {
  const browserId = String(id);
  const owner = await browserOwner(browserId);
  if (!owner) throw new Error("This browser's space or profile is gone, so it has nowhere to open.");
  const pane = senderPane(e.sender);
  if (!pane) return;
  // Known to main before the view is made, so the pane's profile can be read off its partition from
  // the first request its page makes — a profile made a moment ago may not be in the last answer yet.
  await profileDirectory.resolve(owner.profileId);
  // A view composites into ONE window. The same browser asked for in another window — its profile
  // moved windows — is closed where it was before it opens here.
  for (const other of windowPanes.values()) if (other.pane !== pane) other.pane.host.destroy(browserId);
  governBrowserDownloads(owner.partition, downloadPolicy);
  pane.host.create(browserId, url, allowlist, owner.partition);
});
/* The browser was closed or deleted: no window keeps a view of it. */
ipcMain.handle("browser:destroy", (_e, id: string) => { for (const { pane } of windowPanes.values()) pane.host.destroy(String(id)); });
// The pane went away without the browser being closed — a space or pane-group switch. The view
// keeps running, hidden, until the pane comes back or the off-screen budget evicts it.
ipcMain.handle("browser:retain", (e, id: string) => { senderPane(e.sender)?.host.retain(String(id)); });
ipcMain.handle("browser:navigate", (e, id: string, input: string): string | null => paneFor(String(id), e.sender)?.host.navigate(String(id), input) ?? null);
ipcMain.handle("browser:nav", (e, id: string, action: "back" | "forward" | "reload" | "stop") => { paneFor(String(id), e.sender)?.host.navAction(String(id), action); });
/** The suggestion list's "Search the web" row (Plan 26 W7c): the typed text as a search, even when it
 *  looks like an address — which is the only reason to pick that row over Return. The same allowlist
 *  and normalization as every other navigation, because it goes through the same `navigate`. */
ipcMain.handle("browser:search", (e, id: string, query: unknown): string | null =>
  typeof query === "string" && query.trim() !== "" ? paneFor(String(id), e.sender)?.host.navigate(String(id), searchUrl(query.trim())) ?? null : null);
/** How many rows a back menu offers. Safari shows a dozen or so and then stops; a trail of 300 is a
 *  scroll, not a menu, and nobody navigates by it. */
const HISTORY_MENU_MAX = 12;

/**
 * The back/forward trail, as an OS menu.
 *
 * Native rather than a renderer popover, and that is the whole design. A `WebContentsView` composites
 * over every piece of renderer DOM inside its rectangle, which is why `BrowserPane` bans dropdowns
 * outright — but an OS menu is not renderer DOM, it is a window above the app, so it lands over the
 * page the way Safari's and Chrome's own back menus do. Building it here also keeps the entry list in
 * main: the trail is `webContents` state, and copying it to the renderer every navigation to render a
 * menu nobody has opened would be a broadcast per page load for a list most people never ask for.
 *
 * `x`/`y` come from the renderer because only it knows where the button is. Window-relative, which is
 * what `popup` takes.
 */
registerKeyWindowQuery();
registerNativeMenus();
/* Every chord the person's keybindings claim belongs to the page, in every webContents — the
   window's renderer, where the keybinding layer's `when` clauses decide, and a browser pane's page,
   which keeps ⌘B for its own bold. Decided per keystroke, so copy, paste, undo, quit and the rest
   still go through the menu as AppKit expects. (app-menu.ts says why `registerAccelerator: false`
   cannot do this on macOS.) */
app.on("web-contents-created", (_e, wc) => {
  wc.on("before-input-event", (_ev, input) => wc.setIgnoreMenuShortcuts(shouldPageOwn(input, ownedChords)));
});
/** The renderer's keybindings, whenever they load or change: the menu shows them and the page owns
 *  their chords. Validated, because a malformed list would otherwise decide which keys reach the app. */
ipcMain.on("menu:keybindings", (_e, rules: unknown) => {
  const parsed = KeybindingSchema.array().safeParse(rules);
  if (!parsed.success) return;
  menuRules = parsed.data;
  ownedChords = pageChords(menuRules);
  if (app.isReady()) installMenu();
});
ipcMain.handle("browser:history-menu", (e, id: string, dir: "back" | "forward", at: { x: number; y: number }) => {
  const host = paneFor(String(id), e.sender)?.host;
  const trail = host?.historyTrail(id, dir) ?? [];
  if (trail.length === 0) return;
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const template: MenuItemConstructorOptions[] = trail.slice(0, HISTORY_MENU_MAX).map((row) => ({
    // A title is a whole `<title>`, which is routinely a sentence and occasionally a paragraph. The
    // menu is a list of places, so each row is cut to something scannable rather than allowed to set
    // the menu's width from the worst page in the trail.
    label: row.label.length > 64 ? `${row.label.slice(0, 63)}…` : row.label,
    click: () => host?.goToIndex(id, row.index),
  }));
  Menu.buildFromTemplate(template).popup({ window: win, x: Math.round(at.x), y: Math.round(at.y) });
});
ipcMain.handle("browser:set-allowlist", (e, id: string, allowlist: string[] | null) => { paneFor(String(id), e.sender)?.host.setAllowlist(String(id), allowlist); });
// Bounds are a fact about the SENDER's layout: only its own view is moved, never another window's.
ipcMain.on("browser:set-bounds", (e, id: string, rect: ViewRect, dpr: number, visible: boolean) => { senderPane(e.sender)?.host.setBounds(String(id), rect, dpr, visible); });


/**
 * The browser pane's ⋯ menu (Plan 26 W7b). The renderer builds the menu; these are the facts it is
 * built from — the page's zoom and trail, what the pane blocked and saved — read from main the moment
 * it opens, because they are webContents and download state, and copying them to the renderer on every
 * page load for a menu most people never open would be a broadcast per navigation.
 */
ipcMain.handle("browser:menu-state", (e, id: string): BrowserMenuState => {
  const browserId = String(id);
  const browserHost = paneFor(browserId, e.sender)?.host;
  const zoom = browserHost?.zoom(browserId, null) ?? 1;
  const own = profileOfPane(browserId);
  return {
    zoom,
    canZoomIn: nextZoomFactor(zoom, "in") > zoom,
    canZoomOut: nextZoomFactor(zoom, "out") < zoom,
    back: (browserHost?.historyTrail(browserId, "back") ?? []).slice(0, HISTORY_MENU_MAX),
    forward: (browserHost?.historyTrail(browserId, "forward") ?? []).slice(0, HISTORY_MENU_MAX),
    blocked: blockedDownloads.list(browserId),
    saved: savedDownloads.list(browserId),
    // Every profile but the pane's own; none while main does not know whose pane this is.
    shareTargets: own ? profileDirectory.known().filter((p) => p.id !== own).map((p) => ({ id: p.id, name: p.name })) : [],
  };
});
ipcMain.handle("browser:go-to-index", (e, id: string, index: unknown) => {
  if (Number.isInteger(index)) paneFor(String(id), e.sender)?.host.goToIndex(String(id), index as number);
});
ipcMain.handle("browser:find", (e, id: string, query: unknown, step: unknown) => {
  paneFor(String(id), e.sender)?.host.find(String(id), typeof query === "string" ? query : "", step === "next" || step === "previous" ? step : "start");
});
ipcMain.handle("browser:stop-find", (e, id: string) => { paneFor(String(id), e.sender)?.host.stopFind(String(id)); });
ipcMain.handle("browser:zoom", (e, id: string, step: unknown): number =>
  paneFor(String(id), e.sender)?.host.zoom(String(id), step === "in" || step === "out" || step === "reset" ? step : null) ?? 1);
ipcMain.handle("browser:print", (e, id: string) => { paneFor(String(id), e.sender)?.host.print(String(id)); });
/** Device size (Plan 26 W7e): a preset id, or null to fit the pane. Anything else reads as null. */
ipcMain.handle("browser:set-device", (e, id: string, preset: unknown) => {
  paneFor(String(id), e.sender)?.host.setDevice(String(id), preset === "phone" || preset === "tablet" || preset === "desktop" ? preset : null);
});
/**
 * Take a screenshot: the VIEW's own capture, written into the space's `screenshots/` folder. `dir` is
 * the server's answer (`browsers.screenshotDir`), passed through like the download bar's — the
 * renderer never composes where a file goes.
 */
ipcMain.handle("browser:screenshot", async (e, id: string, dir: unknown): Promise<BrowserScreenshotSaved> => {
  const pane = paneFor(String(id), e.sender);
  if (!pane) return { ok: false, error: "The browser pane is not open." };
  const browserId = String(id);
  return saveBrowserScreenshot({
    capture: () => pane.capture(browserId),
    pageUrl: pane.pageState(browserId)?.url ?? "",
    dir: typeof dir === "string" ? dir : "",
    now: () => new Date(),
    mkdirp: (d) => { mkdirSync(d, { recursive: true }); },
    exists: (p) => existsSync(p),
    writeFile: (p, bytes) => writeFile(p, bytes),
  });
});
/**
 * Clear browsing data for the PANE's profile, behind the OS's own confirm — a sheet on the window, its
 * copy in browser-controls.ts. Cancel is the default button: this signs every one of the profile's
 * panes out, and Return should not. Answers whose it cleared, so the renderer forgets that profile's
 * history and no other.
 */
ipcMain.handle("browser:clear-data", async (e, id: unknown): Promise<{ cleared: boolean; profileId: string | null }> => {
  const browserId = String(id);
  const partition = paneFor(browserId, e.sender)?.partitionOf(browserId) ?? null;
  const profileId = profileOfPane(browserId);
  if (!partition || !profileId) return { cleared: false, profileId: null };
  const profile = await profileDirectory.resolve(profileId);
  const win = BrowserWindow.fromWebContents(e.sender);
  const { cleared } = await clearBrowsingData({
    profileName: profile?.name ?? "this profile",
    confirm: async (copy) => {
      const options = { type: "warning" as const, buttons: [copy.clear, copy.cancel], defaultId: 1, cancelId: 1, message: copy.message, detail: copy.detail };
      return (win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)).response;
    },
    clear: () => clearBrowserPartition(partition),
  });
  return { cleared, profileId };
});

/**
 * The ⋯ menu's "Share this site's sign-in with ▸ <profile>": copy the cookies the pane's page signs in
 * with into that profile's partition (cookie-share.ts). The pane keeps its own. The page is the VIEW's
 * own url, never anything the renderer says it is on.
 */
ipcMain.handle("browser:share-signin", async (e, id: unknown, toProfileId: unknown): Promise<BrowserSignInShare> => {
  const browserId = String(id);
  const pane = paneFor(browserId, e.sender);
  const from = pane?.partitionOf(browserId) ?? null;
  const pageUrl = pane?.pageState(browserId)?.url ?? "";
  const target = await profileDirectory.resolve(profileArg(toProfileId));
  if (!from) return { ok: false, error: "This browser pane is not open." };
  if (!target) return { ok: false, error: "That profile no longer exists." };
  if (target.browserPartition === from) return { ok: false, error: `This pane is already ${target.name}'s.` };
  const shared = await shareSiteCookies(from, target.browserPartition, pageUrl).catch(() => null);
  if (!shared) return { ok: false, error: "This page is not on a site, so it has no sign-in to share." };
  return { ok: true, profileName: target.name, host: shared.host, copied: shared.copied };
});

/**
 * The user's element picker. `browser:pick-element` does not resolve until the user clicks something
 * in the view (or the pick is cancelled), so it is the one browser invoke that is expected to stay
 * pending for as long as a person takes to aim. Kept off the agent bridge on purpose — see
 * `BrowserAgentHost.pickElement`.
 */
ipcMain.handle("browser:pick-element", (_e, id: string, accent?: string) => agentHost.pickElement(String(id), typeof accent === "string" ? accent : undefined));
ipcMain.handle("browser:cancel-pick", (_e, id: string) => { agentHost.cancelPick(String(id)); });

/**
 * Annotate (Plan 26 W7d): the picker kept armed, pending until the user presses Send in the page's
 * own toolbar or ends the session. A send's capture — the page with its pins drawn — is written into
 * the space's screenshots/ folder here, beside the menu's own screenshots, so the pane is handed a
 * file it can attach rather than bytes. `dir` is the server's `browsers.screenshotDir`, passed on.
 */
ipcMain.handle("browser:annotate", async (_e, id: string, accent: unknown, dir: unknown): Promise<BrowserAnnotateResult> => {
  const host = agentHost;
  const browserId = String(id);
  const pageUrl = paneFor(browserId)?.pageState(browserId)?.url ?? "";
  const r = await host.annotate(browserId, typeof accent === "string" ? accent : undefined);
  if (r.outcome !== "sent") return r;
  const png = r.png;
  const shot = png && typeof dir === "string"
    ? await saveBrowserScreenshot({
      capture: async () => png, pageUrl, dir, now: () => new Date(), nameSuffix: "-annotations",
      mkdirp: (d) => { mkdirSync(d, { recursive: true }); }, exists: (p) => existsSync(p), writeFile: (p, bytes) => writeFile(p, bytes),
    })
    : null;
  return { outcome: "sent", elements: r.elements, shot: shot?.ok ? { path: shot.path, name: shot.name, size: shot.size } : null };
});
ipcMain.handle("browser:cancel-annotate", (_e, id: string) => { agentHost.cancelAnnotate(String(id)); });

/** The renderer's theme accent, for the marks main draws INSIDE a driven page (Plan 25 W1). Not per
 *  browser id: it is one value for the app — one theme — and one agent host serves every window. */
ipcMain.on("browser:set-accent", (_e, accent: string) => {
  if (typeof accent !== "string") return;
  agentHost.setAccent(accent);
  // The same accent for Realm's own marks: one theme, one colour for "an agent is doing this",
  // whether the thing being driven is a page or the app around it.
  appDriveHost.setAccent(accent);
});

/** The system clipboard, READ ONLY (Plan 25 W7). A machine pane sends it to a guest, which is a
 *  deliberate two-step rather than automatic sync: RFB's clipboard is not transparent, and pushing
 *  whatever is on somebody's clipboard into a machine that may be running anything is not a thing to
 *  do without being asked. There is no write op, and adding one would need its own reason. */
ipcMain.handle("clipboard:read-text", () => clipboard.readText());

/**
 * The secret store, built on first use. Null only before realm-server has announced its home.
 *
 * Note what this does NOT branch on: `safeStorage.isEncryptionAvailable()`. The store checks that
 * itself and refuses to enroll when the answer is no — there is no code path here or there that
 * writes a credential in the clear because encryption was unavailable.
 */
function secrets(): SecretStore | null {
  if (secretStore) return secretStore;
  if (!realmHome) return null;
  const home = realmHome;
  const file = join(home, "secrets.json");
  const auditFile = join(home, "logs", "credential-audit.log");
  secretStore = new SecretStore({
    safeStorage,
    readFile: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    // 0600: the ciphertext is useless without the Keychain item, but a file only the user can read
    // costs nothing and is what anyone auditing this would expect to find.
    writeFile: (text) => writeFileSync(file, text, { mode: 0o600 }),
    appendAudit: (line) => {
      mkdirSync(join(home, "logs"), { recursive: true });
      appendFileSync(auditFile, line, { mode: 0o600 });
    },
    // Biometrics only — Electron's promptTouchID has no password fallback. Rejection (cancelled, no
    // sensor, too many failed attempts) is `false`, never a throw: the caller treats every one of
    // those as "no presence", which is the same refusal for the same reason.
    promptPresence: (reason) =>
      process.platform === "darwin"
        ? systemPreferences.promptTouchID(reason).then(() => true, () => false)
        : Promise.resolve(false),
    now: () => Date.now(),
    newId,
    // Sign-ins saved before they were a profile's own belong to the profile that kept the shared
    // browser partition — the one their cookies stayed with.
    defaultProfileId: () => profileDirectory.defaultProfileId(),
  });
  return secretStore;
}

/**
 * Settings → Sign-ins (Plan 11). The ONLY way a credential is created, which is the point: there is
 * no RPC method, no MCP tool, no file import and no chat path into `addCredential`, so nothing a
 * model can call is able to enroll a credential for the origin it happens to be standing on.
 *
 * The traffic is one-way by construction. `credentials:add` takes a value; nothing here returns one,
 * and `BrowserCredential` — the shape both list handlers answer with — has no field for one.
 */
/**
 * Plan 23 W4 — the user's own downloads.
 *
 * This is the ONLY channel by which Electron main can learn that a human, specifically, wanted a
 * file: `will-download` cannot tell a real click from `Input.dispatchMouseEvent`, but a page cannot
 * reach the renderer (separate `WebContentsView`, contextIsolation, no preload), so an IPC call from
 * the renderer is consent the page could not have forged.
 *
 * `dir` is resolved by the SERVER (`browsers.downloadDir` → `spaceDownloadDir`) and passed through,
 * so the user's downloads land exactly where the agent's do, by the same rule.
 */
ipcMain.handle("browser:blocked-downloads", (_e, browserId: string) => blockedDownloads.list(String(browserId)));
ipcMain.handle("browser:dismiss-download", (_e, browserId: string, id: string) => { blockedDownloads.dismiss(String(browserId), String(id)); });
ipcMain.handle("browser:save-download", async (e, browserId: string, id: string, dir: string) => {
  const pane = paneFor(String(browserId), e.sender);
  if (!pane) return { ok: false, error: "the browser pane is not open" };
  // Same absolute-path requirement the agent op has: this writes to disk, and a relative path would
  // resolve against whatever cwd Electron happens to have.
  if (!String(dir).startsWith("/")) return { ok: false, error: "this space has no project folder, so there is nowhere to save downloads" };
  return retryBlockedDownload(downloadGovernor, blockedDownloads, {
    browserId: String(browserId), id: String(id), dir: String(dir),
    downloadURL: (url) => pane.downloadURL(String(browserId), url),
    now: () => Date.now(),
  });
});

ipcMain.handle("credentials:list", (_e, profileId: unknown): BrowserCredential[] => {
  const pid = profileArg(profileId);
  return pid ? secrets()?.listCredentials(pid) ?? [] : [];
});
ipcMain.handle("credentials:status", () => ({
  available: secrets()?.available ?? false,
  // Surfaced so Settings can say plainly that this Mac cannot fill, rather than letting the user
  // enroll a password and discover it at a sign-in prompt.
  canPromptTouchID: process.platform === "darwin" && systemPreferences.canPromptTouchID(),
  presenceTtlMs: secrets()?.presenceTtlMs ?? 0,
}));
ipcMain.handle("credentials:add", async (_e, profileId: unknown, input: unknown): Promise<BrowserCredential> => {
  const store = secrets();
  if (!store) throw new Error("Realm is still starting up; try saving the sign-in again in a moment");
  // Saved into a profile that exists, or not at all: a sign-in under an id nobody holds is one no
  // pane will ever be offered.
  const owner = await profileDirectory.resolve(profileArg(profileId));
  if (!owner) throw new Error("That profile no longer exists, so the sign-in was not saved.");
  const parsed = BrowserCredentialInputSchema.safeParse(input);
  // The zod error is NOT forwarded: it echoes the parsed input, and the parsed input is the password.
  if (!parsed.success) throw new Error("That sign-in is missing something — check the address and password fields.");
  try {
    return store.addCredential(owner.id, parsed.data);
  } catch (e) {
    // Same reason. `SecretStoreError` messages are written for a person and carry no input; anything
    // else is replaced wholesale rather than stringified.
    throw new Error(e instanceof SecretStoreError ? e.message : "That sign-in could not be saved.");
  }
});
ipcMain.handle("credentials:remove", (_e, profileId: unknown, id: string): boolean => secrets()?.removeCredential(profileArg(profileId), String(id)) ?? false);
/**
 * Settings ▸ Sign-ins' Share with ▸ <profile>: COPY one of this profile's sign-ins into another. The
 * original stays. Main answers with the profile's name, so the row can say what happened in words the
 * person chose. Nothing here returns a value — the copy is ciphertext moved inside the store.
 */
ipcMain.handle("credentials:share", async (_e, profileId: unknown, id: unknown, toProfileId: unknown) => {
  const target = await profileDirectory.resolve(profileArg(toProfileId));
  if (!target) return { ok: false as const, error: "That profile no longer exists." };
  const copy = secrets()?.shareCredential(profileArg(profileId), String(id), target.id) ?? null;
  return copy ? { ok: true as const, profileName: target.name } : { ok: false as const, error: "That sign-in is no longer saved here." };
});

/**
 * Settings → Sign-ins also lists the passkeys Realm holds, and this is the only way to remove one.
 *
 * Note the asymmetry with credentials, which is deliberate: there is no `passkeys:add`. A passkey is
 * created by a site asking for one in a pane and the user answering Touch ID — there is nothing for a
 * person to type, and nothing an agent could call to mint one.
 */
ipcMain.handle("passkeys:list", (_e, profileId: unknown): Passkey[] => {
  const pid = profileArg(profileId);
  return pid ? secrets()?.listPasskeys(pid) ?? [] : [];
});
ipcMain.handle("passkeys:remove", (_e, profileId: unknown, id: string): boolean => secrets()?.removePasskey(profileArg(profileId), String(id)) ?? false);
/** The passkey half of Share with ▸ <profile>: the key is copied into the other profile's store, and
 *  both copies count signatures together from then on (`SecretStore.notePasskeyUse`). */
ipcMain.handle("passkeys:share", async (_e, profileId: unknown, id: unknown, toProfileId: unknown) => {
  const target = await profileDirectory.resolve(profileArg(toProfileId));
  if (!target) return { ok: false as const, error: "That profile no longer exists." };
  const copy = secrets()?.sharePasskey(profileArg(profileId), String(id), target.id) ?? null;
  return copy ? { ok: true as const, profileName: target.name } : { ok: false as const, error: "That passkey is no longer saved here." };
});
ipcMain.handle("credentials:set-presence-ttl", (_e, ms: number): number => secrets()?.setPresenceTtlMs(Number(ms)) ?? 0);

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

/**
 * Write text the renderer composed to a file the user names — the export path, and the only one.
 *
 * The renderer chooses NOTHING about where it lands: it hands over a suggested filename and the
 * bytes, and the destination is whatever the user picks in the native dialog. A renderer-supplied
 * path would be a write-anywhere primitive reachable from a page, which is not a thing this bridge
 * should own; a dialog the user answered is consent that could not have been forged.
 *
 * The suggestion is reduced to a bare filename here rather than trusted: a `defaultPath` carrying
 * `../` would open the dialog somewhere the caller chose, and the dialog is the whole safeguard.
 */
ipcMain.handle("save-text", async (_e, input: { name: string; text: string }): Promise<string | null> => {
  const name = basename(String(input?.name ?? "")) || "export.md";
  const r = await dialog.showSaveDialog({ defaultPath: join(app.getPath("downloads"), name) });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, String(input?.text ?? ""), "utf8");
  return r.filePath;
});

/** The prompter's attach button. Multi-select, and it answers with mime and size alongside the path:
 *  `sessions.send` wants the mime, and the prompter needs the size to enforce MAX_ATTACHMENT_BYTES
 *  itself rather than letting the Claude adapter throw after the user pressed send. */
/** Drag-and-drop's counterpart to `pick-files`: the renderer has the paths already and needs the
 *  facts only a `stat` can supply — chiefly whether the thing is a folder. */
ipcMain.handle("describe-paths", async (_e, paths: unknown): Promise<PickedFile[]> =>
  Array.isArray(paths) ? describeFiles(paths.filter((p): p is string => typeof p === "string")) : []);

ipcMain.handle("pick-files", async (): Promise<PickedFile[]> => {
  const r = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  return r.canceled ? [] : describeFiles(r.filePaths);
});

/** The icon picker's "Uploaded" tab: a single image, filtered at the OS dialog level (`iconAssets.upload`
 *  re-checks mime/size server-side — a dialog filter is a convenience, never the validation boundary).
 *  A raster pick over 10KB is downscaled here before the renderer ever sees its path, so what actually
 *  reaches `iconAssets.upload` — and the SQLite `icon_assets.data_text` column, forever, as base64 — is
 *  the compressed copy. `realmHome` is null only in the sliver before the server announces itself, and
 *  the icon picker isn't reachable that early; compression is best-effort regardless. */
ipcMain.handle("pick-icon-image", async (): Promise<PickedFile | null> => {
  const r = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }] });
  if (r.canceled || r.filePaths.length === 0) return null;
  return (await describeFiles(r.filePaths))[0] ?? null;
});

/** A VS Code colour theme, for `themes.import`. `.jsonc` alongside `.json` because VS Code accepts
 *  comments in these files and plenty of published themes use them; the server's reader strips them. */
ipcMain.handle("pick-theme-file", async (): Promise<string | null> => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "VS Code colour theme", extensions: ["json", "jsonc"] }],
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

/** Compression by PATH, so the store can run it on every icon upload rather than only the ones that
 *  came through the dialog above. A drop onto the picker hands the renderer a `File` whose path never
 *  passed through `pick-icon-image`, which is how a 1.3MB headshot reached `iconAssets.upload` and was
 *  refused by the 512KB cap instead of being downscaled. Best-effort: on any failure the caller uploads
 *  the original and the server's cap is still the boundary. */
ipcMain.handle("compress-icon-image", async (_e, path: unknown): Promise<PickedFile | null> => {
  const picked = typeof path === "string" ? (await describeFiles([path]))[0] ?? null : null;
  if (!picked || !realmHome) return picked;
  try { return await compressIconIfNeeded(realmHome, picked); } catch { return picked; }
});

// Settings page, Permissions tab (Plan 12 W6). Every decision — which rows exist, what state each
// may claim, the no-prompt rule — lives in tcc.ts; only the Electron/fs legs are bound here.
ipcMain.handle("tcc:probe", (): TccRow[] => probeTcc({
  screenStatus: () => systemPreferences.getMediaAccessStatus("screen"),
  cameraStatus: () => systemPreferences.getMediaAccessStatus("camera"),
  // false = never show the prompt; querying trust only.
  accessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
  openForRead: (path) => { closeSync(openSync(path, "r")); },
}));
/** The renderer names a ROW, never a URL: the pane id is validated against tcc.ts's closed table and
 *  the URL built from it here, so no IPC payload can point `openExternal` anywhere else. */
ipcMain.handle("tcc:open-settings", (_e, pane: unknown) => {
  if (!isTccPermissionId(pane)) throw new Error(`unknown permissions pane: ${String(pane)}`);
  void shell.openExternal(TCC_SETTINGS_URLS[pane]);
});

/** A real iPhone's picture, live. macOS reaches a connected iPhone's screen as a camera, so this raises
 *  the camera prompt — on purpose, and only from a click on the pane's Show live. Answers the status
 *  after it: the server's bridge notices a grant by itself within two seconds. */
ipcMain.handle("phone:show-live", async (): Promise<string> => {
  if (systemPreferences.getMediaAccessStatus("camera") === "not-determined") await systemPreferences.askForMediaAccess("camera");
  return systemPreferences.getMediaAccessStatus("camera");
});

// ── Computer control (the `realm-computer` tools' two grants) ───────────────────────────────────
// The one place in the app that may raise a TCC prompt, and only from a click on this row. Reading
// stays prompt-free and uses the same queries `tcc:probe` does; the decisions live in
// computer-access.ts, only the Electron/helper legs are here.

/** Both grants, queried without prompting for either. Screen Recording's status read comes from
 *  Electron rather than the helper so it answers on a build that has no helper at all. */
function computerGrantState() {
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
  };
}

function computerAccessStatus(): ComputerAccessStatus {
  const bundlePath = appBundlePath(app.getPath("exe"));
  return {
    rows: computerAccessRows(computerGrantState(), { helperAvailable: computerHelper.available }),
    hostName: macHostName({ appName: app.getName(), bundlePath, packaged: app.isPackaged }),
    packaged: app.isPackaged,
    helperAvailable: computerHelper.available,
  };
}

ipcMain.handle("computer:status", (): ComputerAccessStatus => computerAccessStatus());

/** Raise the real macOS prompt for one row. The renderer names a ROW, validated against
 *  computer-access.ts's closed set — it can never name an arbitrary method for the helper to run. */
ipcMain.handle("computer:request", async (_e, id: unknown): Promise<ComputerAccessStatus> => {
  if (!isComputerAccessId(id)) throw new Error(`unknown computer access row: ${String(id)}`);
  if (computerHelper.available) {
    // Preferred when it exists, because it is the only route to Screen Recording's prompt and it
    // raises both from one place.
    try { await computerHelper.request("requestTrust", { what: id }); } catch { /* the re-read below is the real answer */ }
  } else if (id === "accessibility") {
    // The `true` is the prompting form, and this branch is the reason `computerAccessRows` lets the
    // Accessibility row offer to ask on a build with no helper: Electron can raise that one dialog
    // by itself. Screen Recording has no such API, so its row offers System Settings instead.
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  return computerAccessStatus();
});

ipcMain.handle("computer:open-settings", (_e, id: unknown) => {
  if (!isComputerAccessId(id)) throw new Error(`unknown computer access row: ${String(id)}`);
  void shell.openExternal(TCC_SETTINGS_URLS[id]);
});

// ── The `mac` CLI's access (Permissions tab, "Apps on this Mac") ────────────────────────────────
// Unlike tcc:probe, this half can actually GRANT: for everything but Full Disk Access the grant is a
// prompt, and the only way to raise a prompt is to run a real command — so `mac:grant` runs one. All
// the decisions (which command, which rows may offer it, why a denied row may not) live in
// mac-access.ts; only the child-process/shell legs are here.

/** Run `mac` with a fixed argv. `spawn` with an argv array, never a shell string: nothing here is
 *  ever concatenated into a command line, so there is no quoting bug to have. */
function runMac(bin: string, argv: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...argv], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const done = (code: number | null) => { clearTimeout(timer); resolve({ code, stdout }); };
    child.once("error", () => done(null));
    child.once("close", done);
  });
}

/** `mac doctor --json` is documented never to prompt and to always exit 0, so this is safe to run on
 *  every visit to the tab. A missing binary, a crash, or unparseable output all land on `null` rows
 *  — which render as "unknown", not as a page full of green checks. */
async function macAccessStatus(): Promise<MacAccessStatus> {
  const bundlePath = appBundlePath(app.getPath("exe"));
  const host: MacAccessHost = {
    name: macHostName({ appName: app.getName(), bundlePath, packaged: app.isPackaged }),
    bundlePath, packaged: app.isPackaged,
  };
  const bin = resolveMacBin({ pathEnv: process.env.PATH, exists: (p) => existsSync(p) });
  if (!bin) return { cli: { present: false, searched: [...MAC_FALLBACK_DIRS] }, rows: macAccessRows(null, { hostName: host.name }), host };
  const [doctor, version] = await Promise.all([
    runMac(bin, ["doctor", "--json"], 15_000),
    runMac(bin, ["--version"], 5_000),
  ]);
  return {
    cli: { present: true, path: bin, version: parseMacVersion(version.stdout) },
    rows: macAccessRows(parseMacDoctor(doctor.stdout), { hostName: host.name }),
    host,
  };
}

ipcMain.handle("mac:status", (): Promise<MacAccessStatus> => macAccessStatus());
/**
 * The real macOS icon for a capability's app, as a data URL.
 *
 * The permissions page names Calendar, Reminders, Mail and the rest; showing the ACTUAL app icon
 * beside each is the difference between a list of words and a list of things the reader already
 * recognises. Realm draws no stand-in: a capability with no app (Full Disk Access) and one whose app
 * is not installed (the iWork bundles are optional) both answer null, and the row shows nothing.
 *
 * The renderer names a capability ID, never a path — `MAC_CAPABILITIES` owns the paths, so no IPC
 * payload can point `getFileIcon` at an arbitrary file.
 */
ipcMain.handle("mac:app-icon", async (_e, id: unknown): Promise<string | null> => {
  if (!isMacCapabilityId(id)) return null;
  const bundle = MAC_CAPABILITIES[id].appPath;
  if (bundle === null || !existsSync(bundle)) return null;
  const cached = APP_ICON_CACHE.get(bundle);
  if (cached !== undefined) return cached;
  const url = await readAppIcon(bundle);
  APP_ICON_CACHE.set(bundle, url);
  return url;
});

/**
 * Finder's own icon, for the one menu item that names it.
 *
 * The path is a CONSTANT, never a parameter: `mac:app-icon` above is guarded by a capability id
 * precisely because a caller-supplied bundle path would let a renderer point the extractor at any
 * file on disk, and this handler exists so that guard does not have to be loosened for a glyph.
 *
 * Read from the user's own system rather than shipped as artwork — the mark belongs to Apple, and
 * the copy on the machine is the one that already matches whatever macOS the user is running. Null
 * on any failure, and the menu falls back to Realm's own folder glyph.
 */
ipcMain.handle("files:finder-icon", async (): Promise<string | null> => {
  const bundle = "/System/Library/CoreServices/Finder.app";
  const cached = APP_ICON_CACHE.get(bundle);
  if (cached !== undefined) return cached;
  const url = existsSync(bundle) ? await readAppIcon(bundle) : null;
  APP_ICON_CACHE.set(bundle, url);
  return url;
});

/** Icons never change while the app runs, and the permissions page asks for all thirteen at once
 *  every time it mounts. One `sips` per bundle per launch. */
const APP_ICON_CACHE = new Map<string, string | null>();

/**
 * An application's REAL icon, as a data URL.
 *
 * Deliberately not `app.getFileIcon`. That returns a generic pale rounded square for every bundle on
 * the sealed system volume — Calendar, Reminders and Mail all came back byte-identical at 1209
 * bytes, which is exactly what the empty squares on the permissions page were. `nativeImage` cannot
 * read `.icns` at all (it answers a 0×0 image), so the conversion goes through `sips`, which is the
 * system's own tool for it and present on every macOS.
 *
 * Every failure returns null and the row draws nothing: a bundle with no `CFBundleIconFile`, an
 * icon `sips` cannot convert, a `sips` that is not there. None of them is worth a placeholder that
 * claims to be an app's icon.
 */
async function readAppIcon(bundle: string): Promise<string | null> {
  try {
    const name = execFileSync("/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIconFile", `${bundle}/Contents/Info.plist`],
      { encoding: "utf8", timeout: 4000 }).trim();
    if (!name) return null;
    // `CFBundleIconFile` may or may not carry the extension; both spellings are real.
    const base = `${bundle}/Contents/Resources/${name}`;
    const icns = existsSync(base) ? base : existsSync(`${base}.icns`) ? `${base}.icns` : null;
    if (icns === null) return null;
    const out = join(tmpdir(), `realm-icon-${createHash("sha1").update(icns).digest("hex").slice(0, 12)}.png`);
    execFileSync("/usr/bin/sips", ["-s", "format", "png", "-Z", "64", icns, "--out", out],
      { stdio: "ignore", timeout: 8000 });
    const png = readFileSync(out);
    rmSync(out, { force: true });
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch { return null; }
}

/** Raise ONE capability's macOS prompt, then re-read the audit so what renders is the answer the
 *  user just gave. The renderer names a capability id; the argv comes from mac-access.ts's closed
 *  table, so no IPC payload can choose what runs. The long timeout is the point — the child blocks
 *  in the macOS consent dialog until the user clicks, and killing it early would abandon the prompt. */
ipcMain.handle("mac:grant", async (_e, id: unknown): Promise<MacAccessStatus> => {
  if (!isMacCapabilityId(id)) throw new Error(`unknown mac capability: ${String(id)}`);
  const argv = macGrantArgv(id);
  const bin = resolveMacBin({ pathEnv: process.env.PATH, exists: (p) => existsSync(p) });
  // No binary, or a capability with no prompt (Full Disk Access): report the state, don't pretend.
  if (bin && argv) await runMac(bin, argv, 180_000);
  return macAccessStatus();
});

ipcMain.handle("mac:open-settings", (_e, id: unknown) => {
  void shell.openExternal(macSettingsUrl(typeof id === "string" ? id : ""));
});

/** Full Disk Access has no prompt — it is a drag-the-app-in list. Reveal the bundle so the drag has
 *  something to start from; `showItemInFolder` selects it in Finder. */
ipcMain.handle("mac:reveal-app", () => { shell.showItemInFolder(appBundlePath(app.getPath("exe"))); });

// Settings→App "Updates" row (Plan 15 W1). The gate (dev never; packaged only when signed AND the
// feed is live — see updater.ts's doc comment) lives in main: the renderer can only ever render what
// this instance reports, and a disabled updater never loads electron-updater at all. A signed build
// checks once on launch; download completion gets an explicit restart choice rather than surprising
// the user by terminating active terminals or agent runs.
let updater: RealmUpdater;
updater = new RealmUpdater({
  version: app.getVersion(),
  decision: updaterDecision({ packaged: app.isPackaged, signed: __REALM_SIGNED_BUILD__, feedLive: UPDATE_FEED_LIVE }),
  load: async () => (await import("electron-updater")).autoUpdater,
  onDownloaded: (version) => {
    void dialog.showMessageBox({
      type: "info",
      title: "Realm update ready",
      message: `Realm v${version} is ready to install.`,
      detail: "Restart now to finish the update, or keep working and install it later from Settings → General.",
      buttons: ["Restart and update", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => { if (response === 0) updater.install(); });
  },
  // Pushed, not polled: a download's progress has to reach the rail's button while the window sits
  // at the front, which is exactly when nothing else would make the renderer ask.
  onChange: (status) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send("updates:changed", status); },
});
ipcMain.handle("updates:status", () => updater.status());
ipcMain.handle("updates:check", () => updater.check());
ipcMain.handle("updates:download", () => updater.download());
ipcMain.handle("updates:install", () => { updater.install(); });

/**
 * Desktop notifications (the feed's last hop). The DECISIONS live in notify.ts — this is only the
 * Electron wiring. Two things are worth reading here:
 *
 *   - `windowFocused` is main's own `isFocused()`, not something the renderer claims. The renderer
 *     asks for a toast for every row the server surfaces; whether the user is already looking is a
 *     fact about the window, and main is the one holding it.
 *   - A click hands the ROW ID back to the renderer and nothing else. Main knows nothing about
 *     spaces, panes or read state — `openNotificationTarget` in the store owns all of that, and this
 *     path reuses it rather than growing a second jump implementation in the wrong process.
 *
 * In dev these post as "Electron" (the toast's title is the running app's bundle identity, and an
 * unsigned dev binary has Electron's); a packaged Realm.app posts as Realm.
 */
const desktopNotifier = new DesktopNotifier({
  supported: () => Notification.isSupported(),
  // Any Realm window in front counts: the person is looking at Realm, and its own surfaces say it.
  windowFocused: () => BrowserWindow.getFocusedWindow() !== null,
  hasWindow: () => windows.size > 0,
  create: (o) => new Notification(o),
  // The window used last — which is where the row id goes below, so the window raised is the one
  // that opens the row.
  focusWindow: () => {
    const win = windows.primary();
    // No window at all: this is the resident's own toast, and a click on it is a request to come
    // back. `reattach` recreates the window; the row id below lands once it exists.
    if (!win) { void reattach(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // macOS: activating the app is separate from focusing the window, and a click that raised the
    // window behind whatever the user was in would be worse than not raising it at all.
    if (process.platform === "darwin") app.focus({ steal: true });
  },
  activate: (id) => {
    const win = windows.primary();
    // A click that recreated the window has no renderer listening yet — the send would land nowhere.
    // Waiting for the first paint is the honest fix; `did-finish-load` is when a listener exists.
    if (win && !win.webContents.isLoading()) win.webContents.send("realm:notification-activate", id);
    else win?.webContents.once("did-finish-load", () => win.webContents.send("realm:notification-activate", id));
  },
  setBadge: (count) => { app.setBadgeCount(count); },
});
ipcMain.handle("daemon:quit-and-stop", () => quitAndStopAll());
ipcMain.handle("notify:show", (_e, input: DesktopNotificationInput) => desktopNotifier.show(input));
ipcMain.handle("notify:badge", (_e, count: number) => { desktopNotifier.badge(Number(count)); });
/** Settings ▸ Appearance ▸ Reduce motion, answered on the window that asked — the quick chat is a
 *  window of its own and keeps its own answer in step by asking at its own boot. */
ipcMain.handle("motion:set", (e, pref: unknown) => applyReducedMotion(e.sender, pref));
/** The renderer's half of the sleep preference: the switch's new value, so a change takes effect on
 *  a turn already running rather than at the next status change. */
ipcMain.handle("power:prevent-sleep", (_e, on: unknown) => { sleepGuard.setPreference(on === true); });
/** Settings ▸ General ▸ Open files in, and the transcript's path menu: the editors this Mac has, and
 *  opening a path that exists in one of them. `existingPath` is the gate Reveal in Finder uses, and it
 *  is the right one here for the same reason it is loose there: an editor is handed the path as a
 *  document to show — a folder becomes a workspace — and runs nothing it opens, which is what keeps
 *  this out of `openablePath`'s mime table. The click is the user's, on a path they can read. */
ipcMain.handle("editors:list", () => installedEditors());
// The path as the transcript shows it, resolved the way Reveal resolves it: `~/…` is this account's
// home and a relative path is the session's working directory's (`base`).
ipcMain.handle("editors:open", async (_e, id: unknown, path: unknown, base?: unknown): Promise<boolean> => openInEditor(id, await existingPath(path, base)));

/**
 * The prompter's `@` list, Apps group: what is installed, and each app's own icon (installed-apps.ts).
 *
 * `REALM_APPS_DIRS` points the scan at other folders (colon-separated) and drops the Dock order
 * unless `REALM_DOCK_PLIST` names one: a live check seeds a scratch Applications folder rather than
 * listing — let alone mentioning — the apps of whoever's Mac it runs on.
 */
const installedApps = new InstalledApps({
  dirs: () => process.env.REALM_APPS_DIRS?.split(":").filter(Boolean) ?? applicationDirs(homedir()),
  dockPlist: () => (process.env.REALM_APPS_DIRS ? process.env.REALM_DOCK_PLIST ?? null : join(homedir(), "Library", "Preferences", "com.apple.dock.plist")),
  // A row draws the icon at 16 points, 32 pixels here; past 64 the PNG is scaled down before it
  // crosses, since a 1024-pixel chunk is all some icons have.
  toDataUrl: (png, px) => {
    if (px <= 64) return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    return img.isEmpty() ? null : img.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
  },
  // An app whose icon lives only in its asset catalog: Quick Look renders a bundle as its icon.
  fallbackIcon: async (appPath) => {
    const img = await nativeImage.createThumbnailFromPath(appPath, { width: 64, height: 64 }).catch(() => null);
    return img && !img.isEmpty() ? img.toDataURL() : null;
  },
});
ipcMain.handle("apps:list", () => installedApps.list());
ipcMain.handle("apps:icons", (_e, paths: unknown) =>
  installedApps.icons(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string").slice(0, 64) : []));

/** Attachment thumbnails. An attached file can only ever be NAMED in the renderer unless the pixels
 *  get there somehow: the renderer has no filesystem access (contextIsolation), and the page's CSP is
 *  `img-src 'self' data:` — so `file://` is refused even in a packaged build. A data: URL minted here
 *  is the one channel that needs neither a protocol handler nor a CSP hole.
 *  `fileThumbnail` owns both producers and the choice between them; see attachments.ts. */
const THUMB_PX = 96;
/** The Library's card: a picture that fills a ~200px-wide preview on a 2× display. Named sizes
 *  rather than a pixel count from the renderer, so a page cannot ask for a poster per tile. */
const CARD_PX = 400;
ipcMain.handle("attachment-thumbnail", (_e, path: string, size?: unknown): Promise<string | null> =>
  fileThumbnail(realmHome, path, size === "card" ? CARD_PX : THUMB_PX));

/** Opening an attachment the app cannot draw itself. A PDF, a CSV, a `.ts` — `realm-media://` will
 *  never serve one and no element could render it, so the honest answer is the app the user already
 *  reads that type in. `openablePath` is the gate, and it is why this is not `media:open`: that one
 *  answers about paths an AGENT wrote, and must stay narrow. */
ipcMain.handle("attachment:open", async (_e, path: unknown): Promise<void> => {
  const openable = await openablePath(path);
  if (openable) await shell.openPath(openable);
});

/** Paste. A pasted image has no path, and every adapter's contract is a path — so one is made here.
 *  Refuses before the server has announced its home; the renderer surfaces the message. */
ipcMain.handle("save-temp-attachment", async (_e, name: string, mime: string, bytes: Uint8Array): Promise<PickedFile> => {
  if (!realmHome) throw new Error("Realm is still starting up; try the paste again in a moment");
  return saveTempAttachment(realmHome, name, mime, bytes);
});

/** Local media (Plan: inline playback). `stat` is the gate the transcript asks BEFORE it draws
 *  anything: a path harvested from an agent's prose is a guess, and a guess that does not resolve to
 *  a real media file must cost one stat and no pixels. The bytes themselves never come through IPC —
 *  they are streamed over `realm-media://`, which is what lets a video seek. */
ipcMain.handle("media:stat", (_e, candidates: unknown): Promise<(MediaFile | null)[]> =>
  statMedia(Array.isArray(candidates) ? candidates.filter((c): c is string => typeof c === "string") : []));
ipcMain.handle("media:poster", async (_e, path: unknown): Promise<string | null> => {
  if (typeof path !== "string" || !realmHome) return null;
  // Re-gated rather than trusted: `poster` takes a path from the renderer just as the protocol
  // handler does, and QuickLook will happily render a file this app has no business previewing.
  const servable = await servablePath(path);
  return servable ? mediaPoster(realmHome, servable) : null;
});
/** The two things a reader wants from a file they can see but not touch. Both are `shell` calls on
 *  a path re-gated the same way, so neither can be pointed at something that is not media. */
ipcMain.handle("media:reveal", async (_e, path: unknown): Promise<void> => {
  const servable = typeof path === "string" ? await servablePath(path) : null;
  if (servable) shell.showItemInFolder(servable);
});
ipcMain.handle("media:open", async (_e, path: unknown): Promise<void> => {
  const servable = typeof path === "string" ? await servablePath(path) : null;
  if (servable) await shell.openPath(servable);
});

/**
 * Any file the app LISTS, as opposed to any file an agent merely named.
 *
 * `media:*` deliberately admits only what an `img`/`video`/`audio` element can decode, because it
 * answers about paths harvested from an agent's prose. These four answer about a row the Library or
 * a session summary is already showing — a file this profile's own index records a session writing
 * or a user attaching — so the gate is existence rather than extension. That difference is why
 * "Reveal in Finder" on a `.ts` file used to do nothing at all: it was asking the media gate a
 * question the media gate is right to refuse.
 *
 * None of the four executes anything. `stat` and `preview` read, `reveal` selects an icon in the
 * Finder, and `save-copy` writes only where a native dialog the user answered put it. Handing a file
 * to the app that OPENS it stays behind `attachment:open`'s mime table, where it belongs, because
 * that one really can run an `.app`.
 */
ipcMain.handle("files:stat", (_e, path: unknown) => statFile(path));
/**
 * One folder of a space or a checkout, newest first (`browse.ts`) — what a session's file browser
 * lists.
 *
 * The root comes from the window, and the window only ever passes a `Space.folderPath` or an
 * `Environment.path`: places the app itself created or was pointed at. What is checked HERE is the
 * `dir` under it, because that one is navigation — a `..` in a breadcrumb must not walk out of the
 * folder the panel says it is showing, and `browseFolder` refuses rather than clamping so a bad path
 * is an error rather than a silent listing of somewhere else.
 */
ipcMain.handle("files:browse", async (_e, root: unknown, dir: unknown): Promise<BrowseResult | null> => {
  if (typeof root !== "string" || root.trim() === "") return null;
  try { return await browseFolder(root, typeof dir === "string" ? dir : ""); } catch { return null; }
});
/** Bigger than a tile's, because this one is meant to be read: a PDF's first page, a spreadsheet's
 *  first rows, a page of source. Same two producers as the tile — see `fileThumbnail`. */
const PREVIEW_PX = 512;
ipcMain.handle("files:preview", (_e, path: unknown): Promise<string | null> => fileThumbnail(realmHome, path, PREVIEW_PX));
/** Looser than the other three on purpose: a DIRECTORY is a real thing to reveal, and the transcript's
 *  path menu offers this for one — as does `~/…`, and a path relative to `base`. See `existingPath`.
 *  Answers whether there was anything to reveal, so a menu that asked can say when there was not. */
ipcMain.handle("files:reveal", async (_e, path: unknown, base?: unknown): Promise<boolean> => {
  const found = await existingPath(path, base);
  if (found) shell.showItemInFolder(found);
  return found !== null;
});
/** Quick Look, Share and drag-out (file-actions.ts), behind the same existence gate as Reveal. */
registerFileActions({ gate: existingPath });
/** The Dock icon chosen in Settings ▸ App (app-icon.ts). Only macOS has a Dock to put it on. */
const appIcons = new AppIconStore(app.getPath("userData"));
const dock = process.platform === "darwin" && app.dock
  ? { setIcon: (png: Uint8Array) => app.dock?.setIcon(nativeImage.createFromBuffer(Buffer.from(png))) }
  : null;
registerAppIcon({ handle: (channel, fn) => ipcMain.handle(channel, fn), store: appIcons, dock });
/** The window's native appearance follows Realm's theme setting (appearance.ts) — applied from the
 *  last run before any window exists, then kept current by the renderer. */
nativeTheme.themeSource = savedAppearance(app.getPath("userData"));
registerAppearance({ on: (channel, fn) => ipcMain.on(channel, fn), theme: nativeTheme, dir: app.getPath("userData") });
/**
 * Save a copy of a file somewhere the user names.
 *
 * The destination is the dialog's answer and nothing else — the same rule `save-text` documents, and
 * for the same reason: a renderer-supplied destination would be a write-anywhere primitive. `copyFile`
 * rather than a read-then-write so a file too large to hold in memory is still savable, and so the
 * copy is one syscall the OS can do properly.
 */
ipcMain.handle("files:save-copy", async (_e, path: unknown): Promise<string | null> => {
  const file = await statFile(path);
  if (!file) return null;
  const r = await dialog.showSaveDialog({ defaultPath: join(app.getPath("downloads"), basename(file.path)) });
  if (r.canceled || !r.filePath) return null;
  await copyFile(file.path, r.filePath);
  return r.filePath;
});

/**
 * Get realm-server, in whichever of its two shapes this build uses.
 *
 * Packaged: a daemon that outlives this process, found if one is already up and started if not. Dev
 * and the live checks: the child on a pipe it has always been, with `daemonMode` off so nothing is
 * left behind when the app exits. Both ends hand back the same three facts, so everything downstream
 * of here is written once.
 */
/**
 * Replace, or carry on with, a daemon running code this app did not ship.
 *
 * The user is asked only when something is actually working, because that is the only thing a
 * restart costs: sessions resume from their provider ids on the ordinary boot path, runs are
 * requeued by `recoverOnBoot`, and terminals come back with what they printed. A turn that happens
 * to be mid-flight is the exception, and it is the one the dialog exists for.
 */
async function handOff(running: DaemonState, why: "bundle" | "protocol"): Promise<HandoffResult> {
  const work = await daemonWork(running);
  let decision = decideHandoff({ why, work });
  if (decision.kind === "confirm") {
    const copy = handoffCopy(decision);
    const buttons = decision.keepable ? [copy.restart, copy.keep] : [copy.restart];
    const r = await dialog.showMessageBox({
      type: "question", buttons, defaultId: 0, cancelId: decision.keepable ? 1 : 0,
      message: copy.message, detail: copy.detail,
    });
    decision = r.response === 0 ? { kind: "restart" } : { kind: "keep" };
  }
  if (decision.kind === "keep") return { kind: "adopt", stale: why };
  // Experimental, and off by default: let the old daemon finish what is in flight instead of
  // interrupting it. Best-effort — a daemon that will not take `daemon.drain` (an older build that
  // does not have the method, which is exactly the `protocol` case) gets the SIGTERM below anyway.
  if (await handoffMode(running) === "drain") {
    try {
      await callDaemon(running, "daemon.drain", {});
      console.error("[daemon] draining the previous server; waiting for it to finish");
      if (await waitForExit(running.pid, DRAIN_WAIT_MS)) return { kind: "replaced" };
      console.error("[daemon] drain did not finish in time; stopping it");
    } catch (e) {
      console.error(`[daemon] drain refused (${e instanceof Error ? e.message : String(e)}); stopping it`);
    }
  }
  // Stop it and wait for the pid to actually go: spawning ours while the old one still holds the home
  // lock would just fail, and the launcher's next pass would read a state file that is still current.
  try { process.kill(running.pid, "SIGTERM"); } catch { /* already gone */ }
  await waitForExit(running.pid, STOP_WAIT_MS);
  return { kind: "replaced" };
}

/** How long a drain is given before it is stopped instead. Generous, because the whole point is a
 *  turn finishing; capped, because a session that keeps being handed work never goes quiet. */
const DRAIN_WAIT_MS = 120_000;
/** How long a SIGTERM'd daemon is given to go. Its own shutdown closes ptys and the database. */
const STOP_WAIT_MS = 10_000;

/** Wait for a pid to leave. True if it did. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** The user's handoff preference, read from the daemon we are replacing — it is the one holding the
 *  settings table. Unreadable means the default, which is `restart`. */
async function handoffMode(running: DaemonState): Promise<string> {
  try {
    const v = await callDaemon(running, "settings.get", { key: DAEMON_HANDOFF_MODE_KEY });
    return resolveHandoffMode((v as { value?: unknown } | null)?.value);
  } catch { return DAEMON_HANDOFF_MODE_DEFAULT; }
}

/** What the daemon we are about to replace has running, or null when it will not say. */
async function daemonWork(running: DaemonState): Promise<DaemonWork> {
  try {
    const info = await callDaemon(running, "daemon.info", {});
    const r = info as { working?: unknown; activeRuns?: unknown };
    if (typeof r?.working !== "number" || typeof r.activeRuns !== "number") return null;
    return { working: r.working, activeRuns: r.activeRuns };
  } catch { return null; }
}

/** Start a detached realm-server on `home`. One path, used by the launcher and by the supervisor —
 *  a respawn must be identical to a first spawn or the second one is a different daemon. */
function startDaemonProcess(home: string): void {
  const fd = openDaemonLog(home);
  try { daemonChild = spawnDaemon({ home, logFd: fd }); } finally { closeDaemonLog(fd); }
}

async function startRealmServer(): Promise<{ port: number; home: string; token: string }> {
  const home = realmHomePath();
  if (daemonModeEnabled({ packaged: app.isPackaged, env: process.env.REALM_DAEMON })) {
    const handle = await ensureDaemon({
      home,
      ourBundleId: bundleIdOf(statSync(serverEntry())),
      readState: readDaemonState,
      probe: (port, token) => probeDaemon({ port, token }),
      spawn: startDaemonProcess,
      onHandoff: (running, why) => handOff(running, why),
      log: (line) => console.error(line),
    });
    staleDaemon = handle.stale;
    return { port: handle.port, home, token: handle.token };
  }
  const { child, ready } = startServer({ home });
  serverChild = child;
  child.on("exit", () => { serverChild = null; });
  const started = await ready;
  // The token realm-server minted at boot. It is never on stdout, so the state file is the only place
  // it exists — and without it neither the renderer nor the bridge can get onto the socket at all, so
  // a missing file is a hard failure rather than a degraded start.
  const state = readStateForPort(started.home, started.port);
  if (!state) throw new Error(`realm-server started on port ${started.port} but wrote no matching ${daemonStatePath(started.home)}`);
  return { port: started.port, home: started.home, token: state.token };
}

/**
 * One Realm per machine.
 *
 * Absent until now, which was survivable while each launch owned its own server child on its own
 * ephemeral port. It stops being survivable the moment the server outlives the app: two launches
 * would mean two processes racing one `realm.db`, and the home lock in realm-server would turn the
 * second one into a startup error the user did not ask for. Cheaper and clearer to never get there.
 *
 * The second launch exits immediately; this one raises the window it already has.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = windows.primary();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(async () => {
  try {
    // Nothing Realm draws asks for the camera or microphone, and nothing it shows may: the camera grant
    // is the phone's picture's (capture-guard.ts says why), and the browser partition refuses the same.
    refuseCapture(session.defaultSession);
    installMenu();
    // Before the first window, so the chosen icon is the one the Dock bounces.
    const savedIcon = appIcons.saved();
    if (savedIcon) dock?.setIcon(savedIcon);
    // Launched from Finder, the app inherits launchd's minimal PATH — no Homebrew, no agent CLIs, no
    // mac-cli. Adopt the login shell's PATH BEFORE the first spawn: the server child inherits this
    // env, and every probe/terminal/agent it spawns inherits the server's. Failure (exotic shell,
    // timeout) degrades to current PATH + /opt/homebrew/bin:/usr/local/bin — see login-shell-path.ts.
    const login = await loginShellPath();
    process.env.PATH = mergePath(process.env.PATH, login);
    if (!login) console.warn("[env] login-shell PATH resolution failed; using fallback:", process.env.PATH);
    const info = await startRealmServer();
    serverInfo = info;
    realmHome = info.home;
    // Before the first window, so its first browser panes and the sign-ins page find every profile —
    // and so sign-ins saved before profiles had their own are handed to their profile at launch.
    await profileDirectory.refresh();
    secrets()?.adoptUnownedRows();
    // Media streaming opens only once home is known: `media:poster` writes QuickLook scratch under it.
    handleMediaProtocol();
    // Sweep once at launch; saveTempAttachment sweeps again on every paste, so a session that never
    // restarts the app is bounded too.
    void sweepTempAttachments(tempAttachmentDir(info.home)).catch(() => {});
    await createWindow(info);
    // Disabled builds return their existing state without loading electron-updater. Signed packaged
    // builds check the public feed and download in the background; failures remain visible in
    // Settings without blocking startup.
    void updater.check();
    // W3: register main as the browser host executor on realm-server's RPC socket. Ops for a view
    // that does not exist fail honestly inside the executor; the bridge just relays.
    // The user chose to keep an older server working. Said once, and held, so a window opened later
    // (or reloaded) hears it too rather than silently working against the wrong build.
    if (staleDaemon) publishDaemonState({ kind: "stale", why: staleDaemon });
    if (daemonModeEnabled({ packaged: app.isPackaged, env: process.env.REALM_DAEMON })) {
      daemonSupervisor = new DaemonSupervisor({
        logPath: daemonLogPath(info.home),
        recordedPid: () => readDaemonState(info.home)?.pid ?? null,
        pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
        spawn: () => startDaemonProcess(info.home),
        onState: (state) => {
          console.error(`[daemon] ${state.kind === "failed" ? `giving up; see ${state.logPath}` : state.kind}`);
          publishDaemonState(state);
        },
      });
    }
    agentBridge = startBrowserAgentBridge({
      port: info.port, token: info.token,
      hasWindow: () => windows.size > 0,
      onConnected: (client) => { bridgeClient = client; daemonSupervisor?.onConnected(); void refreshTray(); void readSleepPreference().then(refreshSleepGuard); void profileDirectory.refresh(); },
      // Both on the same event: the bridge redials every two seconds, which is exactly the cadence a
      // supervisor watching for a dead pid wants, so it needs no clock of its own.
      onDisconnected: () => { bridgeClient = null; sleepGuard.setWorking(0); daemonSupervisor?.onDisconnected(); daemonSupervisor?.tick(); },
      onEvent: (event, payload) => {
        // A profile made, renamed or deleted: main's partitions, names and sign-ins follow.
        if (event === "profiles.changed") { void profileDirectory.refresh().then(retitleWindows); return; }
        // The counts the tray shows change on exactly one event.
        if (event === "session.status") { void refreshTray(); void refreshSleepGuard(); return; }
        // And the resident's own toasts, for the case the renderer used to own alone: with no window
        // there is nobody to ask for one, and a toast is the whole of how anything reaches you.
        if (event === "notifications.changed") void residentToast(payload);
      },
      handleOp: (op, params) => {
        // Answered here rather than in the executor: it needs no window and no CDP, and realm-server
        // asks for it the instant it registers. `exportOauthKey` is the ONE key that leaves main;
        // there is deliberately no sibling op for the credential key.
        if (op === "oauthKey") return Promise.resolve({ key: secrets()?.exportOauthKey() ?? null });
        if (op === "machineKey") return Promise.resolve({ key: secrets()?.exportMachineKey() ?? null });
        if (op === "eggsKey") return Promise.resolve({ key: secrets()?.exportEggsKey() ?? null });
        // Computer-use ops share this socket but not the browser executor: they need no window and
        // no view, so they are answered before the window check below.
        if (op.startsWith("computer")) return computerHost.handleOp(op, params);
        // Realm's own window, which is a different target from any browser view — so these are
        // answered before the executor below, whose `host` is about panes and would refuse first
        // with a message about a pane.
        if (op === "appSnapshot") return appDriveHost.snapshot();
        if (op === "appAct") return appDriveHost.act((params as { action: BrowserAction }).action);
        // Level B: Electron is here, the window is not. The refusal names the actual fix, because
        // "Realm is not connected" would be false — it is connected, that is how this message got
        // here — and an agent told the wrong problem retries the wrong thing. Ops are never queued
        // for a window that might open: a CDP click executed four minutes late against a page that
        // moved on is worse than a refusal.
        if (windows.size === 0) return Promise.reject(new Error("Realm's window is closed — open it from the menu bar, then try again"));
        return agentHost.handleOp(op, params);
      },
      onLog: (line) => console.error(line),
    });
  } catch (e) {
    console.error(e);
    dialog.showErrorBox("Realm failed to start", e instanceof Error ? e.message : String(e));
    app.quit();
  }
});
/**
 * Closing the last window no longer quits.
 *
 * It used to, because closing Realm and stopping the work were the same act. They are two acts now,
 * and this gesture only ever meant the first one — see `quit-policy.ts`. The dock icon goes away and
 * the menu-bar item comes up, so there is always exactly one visible sign that something is running.
 */
app.on("window-all-closed", () => { if (!quittingForReal) goResident(); });

/** Reopening from the dock, Spotlight, or the tray's *Open Realm*. */
app.on("activate", () => { void reattach(); });

/**
 * Let go of realm-server without stopping it: the bridge, the computer-use helper, the driving
 * indicator. Everything here belongs to THIS process and means nothing once it is gone; nothing here
 * touches the server.
 */
function detachFromDaemon() {
  daemonSupervisor?.stop();
  daemonSupervisor = null;
  computerDriving.dispose();
  computerHelper.stop();
  agentBridge?.stop();
  agentBridge = null;
}

/**
 * Stop realm-server, and every pty and agent it owns.
 *
 * By pid from the state file rather than through our own child handle, because after this feature
 * most launches have no handle: the daemon they are talking to was started by a previous launch and
 * adopted. SIGTERM is the graceful path — the server's own handler clears its state file, releases
 * the home lock, closes the ptys and closes the database.
 */
function stopDaemon() {
  serverChild?.kill("SIGTERM");
  const pid = daemonChild?.pid ?? readDaemonState(realmHome ?? realmHomePath())?.pid;
  if (pid && pid !== process.pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  daemonChild = null;
}

/**
 * Put the UI away and leave the work running.
 *
 * The tray comes up here and not on the next status event, because the failure this whole design can
 * produce is somebody who thinks they quit and did not — and an empty menu bar for the two seconds
 * until an event happens to arrive is exactly that failure, briefly.
 */
function goResident() {
  sessionTray.show();
  if (process.platform === "darwin") app.dock?.hide();
  // The server stops relaying browser-pane ops to a process with no pane to run them in, and starts
  // saying so in words that name the real problem.
  void bridgeClient?.call("browserHost.register", { hasWindow: false }).catch(() => {});
}

/** Bring a window back, optionally landing on one session — in the window showing that session's
 *  profile when one is open, else the window used last, else a new first window. */
async function reattach(target?: { sessionId: string; spaceId: string | null }) {
  if (process.platform === "darwin") app.dock?.show();
  const profileId = target?.spaceId ? await profileOfSpace(target.spaceId) : null;
  let win = (profileId ? windows.windowFor(profileId) : null) ?? windows.primary();
  if (win && !win.isDestroyed()) {
    bringForward(win);
  } else if (serverInfo) {
    await createWindow(serverInfo);
    win = windows.primary();
  }
  sessionTray.hide();
  void bridgeClient?.call("browserHost.register", { hasWindow: true }).catch(() => {});
  if (target) win?.webContents.send("realm:open-session", target);
}

/** Raise a window in front of everything, the app included. */
function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

/** A space's profile, asked of the server — null when it cannot say. */
async function profileOfSpace(spaceId: string): Promise<string | null> {
  try {
    const spaces = (await askServer("spaces.list", {})) as { id: string; profileId: string }[];
    return spaces.find((sp) => sp.id === spaceId)?.profileId ?? null;
  } catch { return null; }
}

/**
 * A profile in a window of its own (Plan 27 Phase 2) — Chrome's model, so two profiles side by side
 * need no switching. A profile is open in at most one window: asking for one already open brings that
 * window forward instead of opening a second, which would hold the same profile's panes twice.
 */
ipcMain.handle("window:open-profile", async (_e, profileId: unknown): Promise<void> => {
  const profile = await profileDirectory.resolve(profileArg(profileId));
  if (!profile || !serverInfo) return;
  const open = windows.windowFor(profile.id);
  if (open) { bringForward(open); return; }
  await createWindow(serverInfo, profile.id);
});
/** The switcher's question before it switches a window: is this profile open in ANOTHER window? If so
 *  that window comes forward, and the answer is yes — the asking window stays as it is. */
ipcMain.handle("window:focus-profile", (e, profileId: unknown): boolean => {
  const sender = BrowserWindow.fromWebContents(e.sender);
  const open = windows.windowFor(profileArg(profileId), sender ?? undefined);
  if (!open) return false;
  bringForward(open);
  return true;
});
/** A window's renderer says which profile it shows now. The window is titled by it — what the Window
 *  menu and Mission Control list it by. */
ipcMain.on("window:set-profile", (e, profileId: unknown) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const id = profileArg(profileId) || null;
  windows.setShowing(win, id);
  const name = id ? profileDirectory.get(id)?.name : null;
  if (name) win.setTitle(name);
});

/** True once a gesture that really means "stop everything" has been taken. Read by `before-quit` and
 *  `window-all-closed`, both of which otherwise divert into resident mode. */
let quittingForReal = false;

/** The tray's *Quit Realm & stop agents* — the one path that stops the daemon, and the only place in
 *  the app where quitting and stopping the work are the same act. */
async function quitAndStopAll() {
  const working = (await daemonCounts()) ?? { working: 0, needsYou: 0 };
  const decision = decideQuit({ trigger: "quit-all", working: working.working });
  if (decision.kind === "confirm") {
    const copy = confirmQuitCopy(decision.working);
    const r = await dialog.showMessageBox({
      type: "warning", buttons: [copy.confirm, "Cancel"], defaultId: 1, cancelId: 1,
      message: copy.message, detail: copy.detail,
    });
    if (r.response !== 0) return;
  }
  quittingForReal = true;
  app.quit();
}

function shutdownForQuit() {
  detachFromDaemon();
  stopDaemon();
}

/**
 * ⌘Q means "put the UI away", not "stop the agents".
 *
 * Preventing the default here is the whole of it: the app stays alive with no window, the daemon is
 * untouched, and the tray says what is still running. Only `quittingForReal` — set by the tray's own
 * *Quit Realm & stop agents* — lets a quit through to `shutdownForQuit`.
 */
app.on("before-quit", (e) => {
  if (decideQuit({ trigger: "quit", working: 0 }).kind === "go-resident" && !quittingForReal) {
    e.preventDefault();
    for (const w of BrowserWindow.getAllWindows()) w.close();
    goResident();
    return;
  }
  shutdownForQuit();
});
// electron-updater's quitAndInstall() (mac: Squirrel, driven through Electron's native autoUpdater)
// closes every window and quits WITHOUT the ordinary before-quit ordering — the documented hook for
// that path is `autoUpdater`'s before-quit-for-update. Without it an update-restart would strand the
// server child (and its ptys) while Squirrel swaps the bundle under it. Registered unconditionally:
// it costs nothing while the updater gate (updater.ts) keeps quitAndInstall unreachable.
// An update restart deliberately does NOT stop the daemon — the opposite of what this hook used to
// do. Squirrel swaps the bundle and relaunches us, and the launcher's handoff deals with the daemon
// it finds; killing it here would stop every agent for an update the user may not have noticed.
electronAutoUpdater.on("before-quit-for-update", () => { quittingForReal = true; detachFromDaemon(); });
