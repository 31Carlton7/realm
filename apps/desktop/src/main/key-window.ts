import { BrowserWindow, ipcMain } from "electron";

/**
 * Whether a window is KEY — AppKit's word for the window the keyboard goes to — reported to its
 * renderer, which greys its accent when it is not (App.tsx, KeyWindowBridge).
 *
 * This is the window's focus, not the page's. A click into a browser pane moves focus to another
 * webContents and blurs the page while the window, and the person's attention, never left; the page's
 * own `blur` cannot tell that apart from switching apps, and this can.
 */
export function wireKeyWindow(win: BrowserWindow): void {
  const send = () => { if (!win.isDestroyed()) win.webContents.send("window:key", win.isFocused()); };
  win.on("focus", send);
  win.on("blur", send);
}

/** The state at the moment a renderer asks. A push alone leaves a window that opened behind another
 *  app lit until its first focus change, because the renderer subscribes after the event it needed. */
export function registerKeyWindowQuery(): void {
  ipcMain.handle("window:is-key", (e) => BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? true);
}
