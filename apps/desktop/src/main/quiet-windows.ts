import { app, BrowserWindow, dialog, Menu, Notification, shell, systemPreferences, webContents, type WebContents } from "electron";

/**
 * Quiet windows: a live check's app that the person at the Mac never sees or hears.
 *
 * Every `*-live.mjs` boots the built app, and each one used to open a window on top of whatever the
 * owner was doing, take the keyboard, bounce the Dock and vanish. In quiet mode nothing reaches the
 * screen and everything still renders:
 *
 *   - no Dock icon, and the app is never activated: it runs as an accessory app, `app.focus` and
 *     `win.focus` do nothing to AppKit, and every window is non-focusable and ignores the mouse;
 *   - every window is shown inactive at the lowest alpha there is (`QUIET_ALPHA`) with no shadow. It
 *     keeps its real place and size: macOS will not let a titled window leave the screens anyway
 *     (measured: a frame set 4000px past the last display came back with 40px on it), and a check of
 *     where a window was left needs the place to be real;
 *   - Chromium keeps painting and laying it out. An occluded window stops getting frames even with
 *     `--disable-backgrounding-occluded-windows` (measured: browser-do-live's pane never settled
 *     while the person's own window covered it), so a quiet window is never covered: it floats above
 *     everything, on every Space, at an alpha nobody can see and with the mouse passing through;
 *   - the window main last showed or focused is KEY, as AppKit would have it, through `isFocused`,
 *     `getFocusedWindow` and the `focus`/`blur` events; the renderer's page is focus-emulated, so it
 *     draws as it does in use (not dimmed into `data-quiet`);
 *   - the webContents main last focused holds the keyboard, through `isFocused` and
 *     `getFocusedWebContents`. The real `webContents.focus()` makes its window key and activates the
 *     app whatever the window allows (measured: browser-menu-live had Electron in front for 18s);
 *   - secrets are sealed with Chromium's mock Keychain, so macOS never asks for the login password;
 *   - no sound, notification, About panel, system dialog, permission prompt, Finder window or
 *     browser: each is recorded in `quietWindowsLog` instead, where a check can read it over
 *     `--inspect`.
 *
 * Honoured ONLY by an unpackaged app (`REALM_QUIET_WINDOWS=1`). A packaged Realm ignores it whatever
 * its environment says, and drops it from the environment its server inherits.
 */
export const QUIET_WINDOWS_ENV = "REALM_QUIET_WINDOWS";

export function quietWindowsOn(d: { packaged: boolean; env: Record<string, string | undefined> }): boolean {
  return !d.packaged && d.env[QUIET_WINDOWS_ENV] === "1";
}

/** What quiet mode stopped from reaching the person, oldest first. */
export const quietWindowsLog: { what: string; detail?: unknown }[] = [];

/**
 * One step above transparent: what is behind the window moves by at most one level in 255. Not zero,
 * because macOS counts a window at alpha 0 as occluded, and measured in browser-do-live, a pane in
 * one then never settles on screen: its view stays hidden and every element on the page reads
 * offscreen. At 1/255 the same check passes in full.
 */
export const QUIET_ALPHA = 1 / 255;

/** Construction options for a window that must not flash before `browser-window-created` runs. */
export const QUIET_WINDOW_OPTIONS = { show: false, focusable: false, opacity: QUIET_ALPHA, hasShadow: false } as const;

/** Once per process, though the module may be loaded twice: a live check's wrapper loads its own
 *  build of this file before Realm's main, which carries another. */
const INSTALLED = Symbol.for("realm.quietWindows");

export function installQuietWindows(): void {
  const g = globalThis as { [INSTALLED]?: true };
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  process.env[QUIET_WINDOWS_ENV] = "1";
  const note = (what: string, detail?: unknown) => {
    quietWindowsLog.push({ what, detail });
    process.stderr.write(`[quiet-windows] ${what}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`);
  };

  for (const s of ["mute-audio", "disable-backgrounding-occluded-windows", "disable-renderer-backgrounding", "disable-background-timer-throttling"]) {
    app.commandLine.appendSwitch(s);
  }
  // macOS asks for the login password before it hands a Keychain item to a binary it has not seen,
  // in a system dialog that takes the screen (seen: "Electron wants to use … Electron Safe Storage"),
  // and the quiet Electron is re-signed. The mock Keychain never asks. A check of the Keychain itself
  // keeps the real one (REALM_QUIET_KEYCHAIN=real) and names an item of its own, which it may read.
  if (process.env.REALM_QUIET_KEYCHAIN !== "real") app.commandLine.appendSwitch("use-mock-keychain");

  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
    app.dock.show = async () => {};
    app.dock.bounce = () => -1;
    app.dock.downloadFinished = () => {};
    void app.whenReady().then(() => app.setActivationPolicy("accessory"));
  }
  app.focus = () => {};
  app.showAboutPanel = () => note("about panel");

  /* ── Windows ─────────────────────────────────────────────────────────────────────────────── */
  const proto = BrowserWindow.prototype;
  const showInactive = proto.showInactive;
  const order: BrowserWindow[] = [];
  let key: BrowserWindow | null = null;
  const live = (w: BrowserWindow | null) => (w && !w.isDestroyed() ? w : null);
  const setKey = (w: BrowserWindow | null) => {
    if (live(key) === w) return;
    const was = live(key);
    key = w;
    was?.emit("blur");
    w?.emit("focus");
  };
  const hush = (w: BrowserWindow) => {
    w.setOpacity(QUIET_ALPHA);
    w.setHasShadow(false);
    w.setFocusable(false);
    w.setIgnoreMouseEvents(true);
    // Above everything, on every Space: a window anything covers is occluded, and an occluded
    // window's page stops getting frames whatever the Chromium switches say.
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  };

  proto.showInactive = function (this: BrowserWindow) {
    hush(this);
    showInactive.call(this);
  };
  proto.show = function (this: BrowserWindow) {
    this.showInactive();
    setKey(this);
  };
  proto.focus = function (this: BrowserWindow) {
    if (this.isVisible()) setKey(this);
  };
  proto.blur = function (this: BrowserWindow) {
    if (live(key) === this) setKey(null);
  };
  proto.isFocused = function (this: BrowserWindow) {
    return live(key) === this;
  };
  // Full screen moves the window to a Space of its own, and the screen slides over to it.
  proto.setFullScreen = function (this: BrowserWindow, flag: boolean) { note("full screen", flag); };
  proto.setSimpleFullScreen = function (this: BrowserWindow, flag: boolean) { note("simple full screen", flag); };
  // On a Mac this bounces the Dock icon.
  proto.flashFrame = function () {};
  BrowserWindow.getFocusedWindow = () => live(key);

  app.on("browser-window-created", (_e, w) => {
    hush(w);
    order.push(w);
    w.once("closed", () => {
      order.splice(order.indexOf(w), 1);
      if (key === w) { key = null; setKey([...order].reverse().find((o) => !o.isDestroyed() && o.isVisible()) ?? null); }
    });
    focusEmulated(w.webContents);
  });
  let keyboard: WebContents | null = null;
  const holder = () => (keyboard && !keyboard.isDestroyed() ? keyboard : null);
  webContents.getFocusedWebContents = () => holder();
  app.on("web-contents-created", (_e, wc) => {
    wc.setAudioMuted(true);
    wc.setBackgroundThrottling(false);
    wc.focus = () => { keyboard = wc; };
    wc.isFocused = () => holder() === wc;
  });

  /* ── Everything else that reaches the person ─────────────────────────────────────────────── */
  Notification.isSupported = () => false;
  Notification.prototype.show = function (this: Notification) { note("notification", this.title); };
  shell.beep = () => note("beep");
  shell.openExternal = async (url: string) => { note("open external", url); };
  shell.openPath = async (p: string) => { note("open path", p); return ""; };
  shell.showItemInFolder = (p: string) => note("show in folder", p);
  systemPreferences.askForMediaAccess = async (type) => { note("media access prompt", type); return false; };
  // Every dialog answers as if the person had pressed Cancel.
  dialog.showMessageBox = (async (...a: unknown[]) => { note("message box", dialogOptions(a)); return { response: messageBoxCancel(a), checkboxChecked: false }; }) as typeof dialog.showMessageBox;
  dialog.showMessageBoxSync = ((...a: unknown[]) => { note("message box", dialogOptions(a)); return messageBoxCancel(a); }) as typeof dialog.showMessageBoxSync;
  dialog.showOpenDialog = (async (...a: unknown[]) => { note("open dialog", dialogOptions(a)); return { canceled: true, filePaths: [] }; }) as typeof dialog.showOpenDialog;
  dialog.showOpenDialogSync = ((...a: unknown[]) => { note("open dialog", dialogOptions(a)); return undefined; }) as typeof dialog.showOpenDialogSync;
  dialog.showSaveDialog = (async (...a: unknown[]) => { note("save dialog", dialogOptions(a)); return { canceled: true, filePath: "" }; }) as typeof dialog.showSaveDialog;
  dialog.showSaveDialogSync = ((...a: unknown[]) => { note("save dialog", dialogOptions(a)); return ""; }) as typeof dialog.showSaveDialogSync;
  dialog.showErrorBox = (title: string, content: string) => note("error box", { title, content });
  // A native context menu opens at the pointer, on whatever screen the person is using.
  Menu.prototype.popup = function () { note("context menu"); };
}

/** A dialog's options: its last argument, after the window it may be a sheet on. */
function dialogOptions(args: unknown[]): { title?: string; message?: string; cancelId?: number; buttons?: string[] } | undefined {
  const o = args.at(-1);
  return o && typeof o === "object" && !(o instanceof BrowserWindow) ? o : undefined;
}

/** A canceled message box answers with its own cancel button: `cancelId`, else the one labelled Cancel. */
function messageBoxCancel(args: unknown[]): number {
  const o = dialogOptions(args);
  if (typeof o?.cancelId === "number") return o.cancelId;
  const i = o?.buttons?.findIndex((b) => /^cancel$/i.test(b)) ?? -1;
  return i === -1 ? 0 : i;
}

/** The page drawn as if its window were key: a renderer that is never focused dims and pauses itself. */
function focusEmulated(wc: WebContents): void {
  const apply = () => {
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      void wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    } catch { /* DevTools has it */ }
  };
  apply();
  wc.on("did-navigate", apply);
  wc.debugger.on("detach", () => { if (!wc.isDestroyed()) setTimeout(apply, 0); });
}
