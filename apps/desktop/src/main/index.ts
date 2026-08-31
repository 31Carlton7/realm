import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { startServer } from "./server-process";
import { startScrollPhaseStream } from "./scroll-phase";
import { describeFiles, saveTempAttachment, sweepTempAttachments, tempAttachmentDir, type PickedFile } from "./attachments";

let serverChild: import("node:child_process").ChildProcess | null = null;
/** Realm's data directory, as announced by the server on startup. Pasted attachments live under it. */
let realmHome: string | null = null;

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

async function createWindow(info: { port: number; home: string }) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 14 },
    // Ara refresh §5: macOS gets sidebar vibrancy behind a fully transparent window paint; the
    // renderer keeps every surface EXCEPT the sidebar opaque, so only the sidebar column shows the
    // material (rgba(18,18,18,.82) over it — "ever so slightly transparent"). Elsewhere vibrancy
    // does not exist, so the window keeps its opaque dark ground and the translucent sidebar
    // composites against it — visually the old --rl-frame, never a half-broken effect.
    ...(process.platform === "darwin"
      ? { vibrancy: "sidebar" as const, backgroundColor: "#00000000" }
      : { backgroundColor: "#131417" }),
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
  win.on("closed", () => phases.stop());
}

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

/** Paste. A pasted image has no path, and every adapter's contract is a path — so one is made here.
 *  Refuses before the server has announced its home; the renderer surfaces the message. */
ipcMain.handle("save-temp-attachment", async (_e, name: string, mime: string, bytes: Uint8Array): Promise<PickedFile> => {
  if (!realmHome) throw new Error("Realm is still starting up; try the paste again in a moment");
  return saveTempAttachment(realmHome, name, mime, bytes);
});

app.whenReady().then(async () => {
  try {
    installMenu();
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
  } catch (e) {
    console.error(e);
    dialog.showErrorBox("Realm failed to start", e instanceof Error ? e.message : String(e));
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { serverChild?.kill("SIGTERM"); });
