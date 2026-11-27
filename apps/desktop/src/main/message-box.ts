import { dialog, type BrowserWindow, type MessageBoxOptions } from "electron";

/**
 * Every message box main shows goes through this file; message-box.test.ts fails on one that doesn't.
 *
 * On macOS, Electron's `dialog.showMessageBox` is a sheet when it is given a window. Given none, it
 * calls `[NSAlert runModal]` (shell/browser/ui/message_box_mac.mm), and main's JavaScript and libuv
 * stop until someone answers. On 2026-11-20 the update-ready prompt did that after a download nobody
 * was watching, and every agent's browser tools answered "host not answering" while it sat there
 * (#562). `showMessageBoxSync` is modal even with a window, so nothing here uses it.
 */

/** The window a sheet can go on: one on screen. A sheet on a hidden or minimised window is shown to
 *  nobody, and its answer never comes. */
export function sheetWindow(win: BrowserWindow | null | undefined): BrowserWindow | null {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
  return win;
}

/** Asks in a sheet on `win`. Answers null, having shown nothing, when `win` is not on screen. */
export async function askInSheet(win: BrowserWindow | null | undefined, options: MessageBoxOptions): Promise<number | null> {
  const parent = sheetWindow(win);
  if (!parent) return null;
  return (await dialog.showMessageBox(parent, options)).response;
}

/**
 * An alert of its own, app-modal: main's JavaScript stops until it is answered. Only for a click the
 * person has just made with no window to put a sheet on — the tray's quit, and the hand-off a launch
 * asks before its first window. Never for anything that happens on its own.
 */
export async function askAppModal(options: MessageBoxOptions): Promise<number> {
  return (await dialog.showMessageBox(options)).response;
}
