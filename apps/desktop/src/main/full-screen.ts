import { BrowserWindow, ipcMain } from "electron";

/**
 * Whether a window is in native full screen, reported to its renderer, which takes every drag region
 * off the window while it is (App.tsx, FullScreenBridge; styles.css).
 *
 * A window in full screen cannot be moved, so there its regions only put Electron's region handling in
 * front of every press on a control inside one — and that handling has a full-screen bug of its own:
 * on any display but the main one, a press on a control inside a drag region is followed by a pointer
 * move offset by that display's origin, so a press on a draggable row or tab starts a drag and the
 * click is lost (electron/electron#55100, reported against 43, with no fix released).
 */
export function wireFullScreen(win: BrowserWindow): void {
  const send = () => { if (!win.isDestroyed()) win.webContents.send("window:full-screen", win.isFullScreen()); };
  win.on("enter-full-screen", send);
  win.on("leave-full-screen", send);
}

/** The state at the moment a renderer asks: a window restored into full screen, or a page reloaded in
 *  one, has no transition left to report by the time its renderer subscribes. */
export function registerFullScreenQuery(): void {
  ipcMain.handle("window:is-full-screen", (e) => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false);
}
