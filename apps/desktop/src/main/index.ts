import { app, autoUpdater as electronAutoUpdater, BrowserWindow, dialog, ipcMain, Menu, shell, systemPreferences, type MenuItemConstructorOptions } from "electron";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server-process";
import { loginShellPath, mergePath } from "./login-shell-path";
import { startScrollPhaseStream } from "./scroll-phase";
import { describeFiles, saveTempAttachment, sweepTempAttachments, tempAttachmentDir, type PickedFile } from "./attachments";
import { blockBrowserDownloads, createBrowserPane, type BrowserPane } from "./browser-pane";
import type { BrowserPaneHost, ViewRect } from "./browser-host";
import { BrowserAgentHost } from "./browser-agent-host";
import { startBrowserAgentBridge } from "./browser-agent-bridge";
import { TCC_SETTINGS_URLS, isTccPermissionId, probeTcc, type TccRow } from "./tcc";
import { RealmUpdater, UPDATE_FEED_LIVE, updaterDecision } from "./updater";

let serverChild: import("node:child_process").ChildProcess | null = null;
/** Realm's data directory, as announced by the server on startup. Pasted attachments live under it. */
let realmHome: string | null = null;
/** The window's browser-pane views (Plan 11 W1). Set in createWindow; null before/after. */
let browserHost: BrowserPaneHost | null = null;
/** The full pane surface (W3): CDP access + identity for the agent executor. Same lifetime. */
let browserPane: BrowserPane | null = null;
/** The agent op executor + its server bridge (W3). The bridge lives as long as the app: it serves
 *  whichever window's views exist, and honestly reports "pane not open" between windows. */
let agentHost: BrowserAgentHost | null = null;
let agentBridge: { stop(): void } | null = null;

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
  });
  pane.onViewDestroyed((id) => host.release(id));
  agentHost = host;
  // Downloads are a hard block on the browser partition — cancelled in every permission mode.
  blockBrowserDownloads((wcId, url) => {
    const id = browserPane?.browserIdForWebContents(wcId);
    if (id) agentHost?.noteBlockedDownload(id, url);
    console.error(`[browser-agent] download blocked${id ? ` (browser ${id})` : ""}: ${url}`);
  });
  win.on("closed", () => { phases.stop(); browserHost = null; browserPane = null; agentHost = null; });
}

// Browser pane (Plan 11 W1): the renderer drives the native WebContentsViews over this surface.
// Mutations are invokes; the per-frame bounds sync is a plain send (no reply to wait on).
ipcMain.handle("browser:create", (_e, id: string, url: string, allowlist: string[] | null) => { browserHost?.create(id, url, allowlist); });
ipcMain.handle("browser:destroy", (_e, id: string) => { browserHost?.destroy(id); });
ipcMain.handle("browser:navigate", (_e, id: string, input: string): string | null => browserHost?.navigate(id, input) ?? null);
ipcMain.handle("browser:nav", (_e, id: string, action: "back" | "forward" | "reload" | "stop") => { browserHost?.navAction(id, action); });
ipcMain.handle("browser:set-allowlist", (_e, id: string, allowlist: string[] | null) => { browserHost?.setAllowlist(id, allowlist); });
ipcMain.on("browser:set-bounds", (_e, id: string, rect: ViewRect, dpr: number, visible: boolean) => { browserHost?.setBounds(id, rect, dpr, visible); });

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

// Settings→App "Updates" row (Plan 15 W1). The gate (dev never; packaged only when signed AND the
// feed is live — see updater.ts's doc comment) lives in main: the renderer can only ever render what
// this instance reports, and a disabled updater never loads electron-updater at all. The dynamic
// import keeps the module out of dev entirely.
const updater = new RealmUpdater({
  version: app.getVersion(),
  decision: updaterDecision({ packaged: app.isPackaged, signed: __REALM_SIGNED_BUILD__, feedLive: UPDATE_FEED_LIVE }),
  load: async () => (await import("electron-updater")).autoUpdater,
});
ipcMain.handle("updates:status", () => updater.status());
ipcMain.handle("updates:check", () => updater.check());
ipcMain.handle("updates:install", () => { updater.install(); });

/** Paste. A pasted image has no path, and every adapter's contract is a path — so one is made here.
 *  Refuses before the server has announced its home; the renderer surfaces the message. */
ipcMain.handle("save-temp-attachment", async (_e, name: string, mime: string, bytes: Uint8Array): Promise<PickedFile> => {
  if (!realmHome) throw new Error("Realm is still starting up; try the paste again in a moment");
  return saveTempAttachment(realmHome, name, mime, bytes);
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
    // Sweep once at launch; saveTempAttachment sweeps again on every paste, so a session that never
    // restarts the app is bounded too.
    void sweepTempAttachments(tempAttachmentDir(info.home)).catch(() => {});
    await createWindow(info);
    // W3: register main as the browser host executor on realm-server's RPC socket. Ops for a view
    // that does not exist fail honestly inside the executor; the bridge just relays.
    agentBridge = startBrowserAgentBridge({
      port: info.port,
      handleOp: (op, params) => {
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
