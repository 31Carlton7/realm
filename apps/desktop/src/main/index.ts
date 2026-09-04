import { app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, systemPreferences, type MenuItemConstructorOptions } from "electron";
import { BrowserCredentialInputSchema, DEFAULT_MIME, isImageMime, mimeForPath, newId, type BrowserCredential, type MediaFile } from "@realm/contracts";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServer } from "./server-process";
import { loginShellPath, mergePath } from "./login-shell-path";
import { startScrollPhaseStream } from "./scroll-phase";
import { compressIconIfNeeded, describeFiles, quickLookThumbnail, saveTempAttachment, sweepTempAttachments, tempAttachmentDir, type PickedFile } from "./attachments";
import { createBrowserPane, governBrowserDownloads, type BrowserPane } from "./browser-pane";
import { BlockedDownloads, DownloadGovernor, retryBlockedDownload } from "./downloads";
import type { BrowserPaneHost, ViewRect } from "./browser-host";
import { BrowserAgentHost } from "./browser-agent-host";
import { startBrowserAgentBridge } from "./browser-agent-bridge";
import { TCC_SETTINGS_URLS, isTccPermissionId, probeTcc, type TccRow } from "./tcc";
import { ComputerUseHelper, axHelperPath } from "./computer-use-helper";
import { ComputerUseHost } from "./computer-use-host";
import { computerAccessRows, isComputerAccessId, type ComputerAccessStatus } from "./computer-access";
import {
  MAC_FALLBACK_DIRS, appBundlePath, isMacCapabilityId, macAccessRows, macGrantArgv, macHostName, macSettingsUrl,
  parseMacDoctor, parseMacVersion, resolveMacBin, type MacAccessHost, type MacAccessStatus,
} from "./mac-access";
import { RealmUpdater, UPDATE_FEED_LIVE, updaterDecision } from "./updater";
import { SecretStore, SecretStoreError } from "./secret-store";
import { DesktopNotifier, type DesktopNotificationInput } from "./notify";
import { handleMediaProtocol, mediaPoster, registerMediaScheme, servablePath, statMedia } from "./media";

/* `realm-media://` has to be declared privileged before `app.ready`, which is why this is a
   top-level statement rather than a line in `whenReady` — Electron ignores the registration
   afterwards, and the failure mode is a scheme that silently serves nothing. The handler that
   actually reads files is installed in `whenReady`, once the server has told us where home is. */
registerMediaScheme();

let serverChild: import("node:child_process").ChildProcess | null = null;
/** Realm's data directory, as announced by the server on startup. Pasted attachments live under it. */
let realmHome: string | null = null;
/** The Realm window, for the things that need it OUTSIDE the renderer's own IPC: whether it is
 *  focused (the desktop-notification gate) and where a toast click sends its row id. Null before
 *  the first window and after the last one closes. */
let mainWindow: BrowserWindow | null = null;
/** The window's browser-pane views (Plan 11 W1). Set in createWindow; null before/after. */
let browserHost: BrowserPaneHost | null = null;
/** The full pane surface (W3): CDP access + identity for the agent executor. Same lifetime. */
let browserPane: BrowserPane | null = null;
/** The agent op executor + its server bridge (W3). The bridge lives as long as the app: it serves
 *  whichever window's views exist, and honestly reports "pane not open" between windows. */
let agentHost: BrowserAgentHost | null = null;
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
const computerHost = new ComputerUseHost({
  available: () => computerHelper.available,
  request: (method, params) => computerHelper.request(method, params),
});
/** The encrypted secret store (safeStorage + the OS Keychain). App-scoped, not per-window: the
 *  bridge asks it for the `oauth` key at registration, and Settings enrolls into it. Built lazily
 *  because it needs `realmHome`, which arrives with the server's ready line. */
let secretStore: SecretStore | null = null;
/** The download governor (Plan 23). App-scoped: it owns the partition-wide `will-download` handler,
 *  which is registered once and outlives any window. */
const downloadGovernor = new DownloadGovernor({
  mkdirp: (dir) => { mkdirSync(dir, { recursive: true }); },
  exists: (p) => existsSync(p),
  now: () => Date.now(),
});
/** Plan 23 W4: what the pane's blocked-download bar reads. App-scoped alongside the governor. */
const blockedDownloads = new BlockedDownloads(() => Date.now());

/** With no explicit application menu, Electron installs its default one, whose File → Close Window
 *  binds ⌘W — and menu accelerators fire in the main process before the renderer ever sees the
 *  keydown, so the renderer's close-pane binding (hotkeys.ts) could never win. Install a menu with
 *  no ⌘W item: app/edit/view roles stay (⌘Q, copy/paste, devtools), the Window menu is rebuilt
 *  without the `close` role. */
function installMenu() {
  const darwin = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(darwin ? [{ role: "appMenu" } satisfies MenuItemConstructorOptions] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: "Window", submenu: [
      { role: "minimize" }, { role: "zoom" },
      ...(darwin ? [{ type: "separator" }, { role: "front" }] satisfies MenuItemConstructorOptions[] : []),
    ] },
  ];
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

async function createWindow(info: { port: number; home: string }) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
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
      additionalArguments: [`--realm-port=${info.port}`, `--realm-home=${info.home}`] },
  });
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
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow = win;
  // Native trackpad phases for the space swiper (macOS; optional helper).
  const phases = startScrollPhaseStream(win);
  const pane = createBrowserPane(win); // destroys its views on win "closed" itself
  browserPane = pane;
  browserHost = pane.host;
  // The agent executor (W3): drives the pane's views over in-process CDP for realm-server's
  // realm-browser tools. Buffers and snapshot-diff state die with each view.
  const host = new BrowserAgentHost({
    attach: (id) => pane.attachCdp(id),
    hasView: (id) => pane.hasView(id),
    navigate: (id, url) => pane.host.navigate(id, url),
    pageState: (id) => pane.pageState(id),
    // The fill op's only reach into the store. Passed as an object of bound methods rather than the
    // store itself, so the executor host cannot reach `exportOauthKey` or anything added later.
    secrets: {
      listCredentials: () => secrets()?.listCredentials() ?? [],
      getCredential: (id) => secrets()?.getCredential(id) ?? null,
      withCredentialValue: async (id, use) => secrets()?.withCredentialValue(id, use) ?? { ok: false, refused: "no_credential" },
      audit: (entry) => secrets()?.audit(entry),
    },
    downloads: downloadGovernor,
  });
  pane.onViewDestroyed((id) => host.release(id));
  agentHost = host;
  // Downloads on the browser partition are DEFAULT-DENY (Plan 11 W3), narrowed by Plan 23 to let
  // through exactly those covered by a live one-shot grant from an approved `browser_download`.
  // Everything else is still cancelled, in every permission mode.
  governBrowserDownloads({
    browserIdFor: (wcId) => browserPane?.browserIdForWebContents(wcId) ?? null,
    decide: (browserId, item) => downloadGovernor.handle(browserId, item),
    onBlocked: (wcId, url, reason, filename) => {
      const id = browserPane?.browserIdForWebContents(wcId);
      if (id) {
        agentHost?.noteBlockedDownload(id, url);
        // W4: remember it so the pane can say so and offer to fetch it. A download the user started
        // and that vanished without a word is the papercut this removes.
        const entry = blockedDownloads.note(id, url, filename);
        const win = BrowserWindow.getAllWindows()[0];
        if (entry && win && !win.isDestroyed()) win.webContents.send("realm:browser-download-blocked", { browserId: id, blocked: entry });
      }
      console.error(`[browser-agent] download blocked (${reason})${id ? ` (browser ${id})` : ""}: ${url}`);
    },
  });
  win.on("closed", () => { phases.stop(); mainWindow = null; browserHost = null; browserPane = null; agentHost = null; });
}

// Browser pane (Plan 11 W1): the renderer drives the native WebContentsViews over this surface.
// Mutations are invokes; the per-frame bounds sync is a plain send (no reply to wait on).
ipcMain.handle("browser:create", (_e, id: string, url: string, allowlist: string[] | null) => { browserHost?.create(id, url, allowlist); });
ipcMain.handle("browser:destroy", (_e, id: string) => { browserHost?.destroy(id); });
ipcMain.handle("browser:navigate", (_e, id: string, input: string): string | null => browserHost?.navigate(id, input) ?? null);
ipcMain.handle("browser:nav", (_e, id: string, action: "back" | "forward" | "reload" | "stop") => { browserHost?.navAction(id, action); });
ipcMain.handle("browser:set-allowlist", (_e, id: string, allowlist: string[] | null) => { browserHost?.setAllowlist(id, allowlist); });
ipcMain.on("browser:set-bounds", (_e, id: string, rect: ViewRect, dpr: number, visible: boolean) => { browserHost?.setBounds(id, rect, dpr, visible); });

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
ipcMain.handle("browser:save-download", async (_e, browserId: string, id: string, dir: string) => {
  const pane = browserPane;
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

ipcMain.handle("credentials:list", (): BrowserCredential[] => secrets()?.listCredentials() ?? []);
ipcMain.handle("credentials:status", () => ({
  available: secrets()?.available ?? false,
  // Surfaced so Settings can say plainly that this Mac cannot fill, rather than letting the user
  // enroll a password and discover it at a sign-in prompt.
  canPromptTouchID: process.platform === "darwin" && systemPreferences.canPromptTouchID(),
  presenceTtlMs: secrets()?.presenceTtlMs ?? 0,
}));
ipcMain.handle("credentials:add", (_e, input: unknown): BrowserCredential => {
  const store = secrets();
  if (!store) throw new Error("Realm is still starting up; try saving the sign-in again in a moment");
  const parsed = BrowserCredentialInputSchema.safeParse(input);
  // The zod error is NOT forwarded: it echoes the parsed input, and the parsed input is the password.
  if (!parsed.success) throw new Error("That sign-in is missing something — check the address and password fields.");
  try {
    return store.addCredential(parsed.data);
  } catch (e) {
    // Same reason. `SecretStoreError` messages are written for a person and carry no input; anything
    // else is replaced wholesale rather than stringified.
    throw new Error(e instanceof SecretStoreError ? e.message : "That sign-in could not be saved.");
  }
});
ipcMain.handle("credentials:remove", (_e, id: string): boolean => secrets()?.removeCredential(String(id)) ?? false);
ipcMain.handle("credentials:set-presence-ttl", (_e, ms: number): number => secrets()?.setPresenceTtlMs(Number(ms)) ?? 0);

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

/** The prompter's attach button. Multi-select, and it answers with mime and size alongside the path:
 *  `sessions.send` wants the mime, and the prompter needs the size to enforce MAX_ATTACHMENT_BYTES
 *  itself rather than letting the Claude adapter throw after the user pressed send. */
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
  const picked = (await describeFiles(r.filePaths))[0] ?? null;
  if (!picked || !realmHome) return picked;
  try { return await compressIconIfNeeded(realmHome, picked); } catch { return picked; }
});

// Settings page, Permissions tab (Plan 12 W6). Every decision — which rows exist, what state each
// may claim, the no-prompt rule — lives in tcc.ts; only the Electron/fs legs are bound here.
ipcMain.handle("tcc:probe", (): TccRow[] => probeTcc({
  screenStatus: () => systemPreferences.getMediaAccessStatus("screen"),
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
  // Both prompts are raised by the helper, so macOS attributes them to the same bundle that will
  // later use the grant. Failures are swallowed: the status returned below is the real answer, and a
  // helper that could not start has already reported itself unavailable.
  try { await computerHelper.request("requestTrust", { what: id }); } catch { /* status tells the truth */ }
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
      detail: "Restart now to finish the update, or keep working and install it later from Settings → App.",
      buttons: ["Restart and update", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => { if (response === 0) updater.install(); });
  },
});
ipcMain.handle("updates:status", () => updater.status());
ipcMain.handle("updates:check", () => updater.check());
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
  windowFocused: () => mainWindow?.isFocused() ?? false,
  create: (o) => new Notification(o),
  focusWindow: () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // macOS: activating the app is separate from focusing the window, and a click that raised the
    // window behind whatever the user was in would be worse than not raising it at all.
    if (process.platform === "darwin") app.focus({ steal: true });
  },
  activate: (id) => { mainWindow?.webContents.send("realm:notification-activate", id); },
  setBadge: (count) => { app.setBadgeCount(count); },
});
ipcMain.handle("notify:show", (_e, input: DesktopNotificationInput) => desktopNotifier.show(input));
ipcMain.handle("notify:badge", (_e, count: number) => { desktopNotifier.badge(Number(count)); });

/** Attachment thumbnails. An attached file can only ever be NAMED in the renderer unless the pixels
 *  get there somehow: the renderer has no filesystem access (contextIsolation), and the page's CSP is
 *  `img-src 'self' data:` — so `file://` is refused even in a packaged build. A data: URL minted here
 *  is the one channel that needs neither a protocol handler nor a CSP hole.
 *
 *  Two producers, in cost order. An image is decoded and downscaled in-process, because that is
 *  cheap and synchronous — and downscaled on purpose: a 12-megapixel screenshot would otherwise
 *  cross the bridge whole, as base64, for a 44px tile. Everything else goes to QuickLook, which is
 *  what puts the first page of a PDF (or a Keynote slide, or a movie frame) on the tile instead of
 *  the same generic glyph every non-image used to share.
 *
 *  Either producer answering null is normal, not an error: the caller draws its file glyph, which is
 *  also what makes a deleted or moved path degrade quietly. */
const THUMB_PX = 96;
ipcMain.handle("attachment-thumbnail", async (_e, path: string): Promise<string | null> => {
  try {
    if (typeof path !== "string") return null;
    if (isImageMime(mimeForPath(path))) {
      const img = nativeImage.createFromPath(path);
      // An empty decode is not necessarily "not an image" — an HEIC or an SVG lands here too, and
      // QuickLook renders both — so a failed decode falls through rather than giving up.
      if (!img.isEmpty()) return img.resize({ height: THUMB_PX }).toDataURL();
    }
    if (!realmHome) return null; // QuickLook needs a scratch directory, and that lives under home
    // An extension Realm's mime table does not know is one macOS is unlikely to have a generator
    // for either — and `qlmanage` answers "no generator" by hanging until the timeout. Skipping the
    // ask is what keeps attaching a `.bin` from costing three seconds of a stalled child process.
    if (mimeForPath(path) === DEFAULT_MIME) return null;
    return await quickLookThumbnail(realmHome, path, THUMB_PX);
  } catch { return null; }
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

app.whenReady().then(async () => {
  try {
    installMenu();
    // Launched from Finder, the app inherits launchd's minimal PATH — no Homebrew, no agent CLIs, no
    // mac-cli. Adopt the login shell's PATH BEFORE the first spawn: the server child inherits this
    // env, and every probe/terminal/agent it spawns inherits the server's. Failure (exotic shell,
    // timeout) degrades to current PATH + /opt/homebrew/bin:/usr/local/bin — see login-shell-path.ts.
    const login = await loginShellPath();
    process.env.PATH = mergePath(process.env.PATH, login);
    if (!login) console.warn("[env] login-shell PATH resolution failed; using fallback:", process.env.PATH);
    const { child, ready } = startServer();
    serverChild = child;
    // TODO(plan-2): reconnect/restart when server exits after ready
    child.on("exit", () => { serverChild = null; });
    const info = await ready;
    realmHome = info.home;
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
    agentBridge = startBrowserAgentBridge({
      port: info.port,
      handleOp: (op, params) => {
        // Answered here rather than in the executor: it needs no window and no CDP, and realm-server
        // asks for it the instant it registers. `exportOauthKey` is the ONE key that leaves main;
        // there is deliberately no sibling op for the credential key.
        if (op === "oauthKey") return Promise.resolve({ key: secrets()?.exportOauthKey() ?? null });
        // Computer-use ops share this socket but not the browser executor: they need no window and
        // no view, so they are answered before the window check below.
        if (op.startsWith("computer")) return computerHost.handleOp(op, params);
        const host = agentHost;
        if (!host) return Promise.reject(new Error("the Realm window is not open — browser tools need it"));
        return host.handleOp(op, params);
      },
      onLog: (line) => console.error(line),
    });
  } catch (e) {
    console.error(e);
    dialog.showErrorBox("Realm failed to start", e instanceof Error ? e.message : String(e));
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
/** Everything a quit must tear down, in one place: the browser-agent bridge and the realm-server
 *  child (SIGTERM — the server's own handler closes ptys and the DB). Idempotent: quitAndInstall
 *  paths can arrive here twice (`before-quit-for-update`, then the ordinary quit machinery). */
function shutdownForQuit() {
  computerHelper.stop();
  agentBridge?.stop();
  agentBridge = null;
  serverChild?.kill("SIGTERM");
}
app.on("before-quit", shutdownForQuit);
// electron-updater's quitAndInstall() (mac: Squirrel, driven through Electron's native autoUpdater)
// closes every window and quits WITHOUT the ordinary before-quit ordering — the documented hook for
// that path is `autoUpdater`'s before-quit-for-update. Without it an update-restart would strand the
// server child (and its ptys) while Squirrel swaps the bundle under it. Registered unconditionally:
// it costs nothing while the updater gate (updater.ts) keeps quitAndInstall unreachable.
electronAutoUpdater.on("before-quit-for-update", shutdownForQuit);
