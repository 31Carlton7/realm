import { extname, basename } from "node:path";
import { app, BrowserWindow, ipcMain, ShareMenu, type NativeImage } from "electron";

/**
 * What a Mac does with a file it is showing you, for the files Realm lists: Quick Look on Space, drag
 * it out to the Finder or into another app, and the system Share menu. Without them a file in the
 * Library was a picture behind glass — you could open it or reveal it, and nothing else a Finder
 * window would let you do.
 *
 * Every path is re-gated through `gate` (attachments.ts `existingPath`, the same gate Reveal in
 * Finder uses), because it comes from the renderer. None of the three executes anything: Quick Look
 * renders, a drag hands the Finder a path, Share hands the system a path.
 */
export function registerFileActions({ gate }: { gate: (path: unknown) => Promise<string | null> }): void {
  /** macOS's own Quick Look panel, the one the Finder opens on Space. */
  ipcMain.handle("files:quick-look", async (e, path: unknown): Promise<void> => {
    const found = await gate(path);
    const win = BrowserWindow.fromWebContents(e.sender);
    if (found && win) win.previewFile(found, basename(found));
  });

  /** The system Share menu for one file, under the control that asked. `at` is in CSS pixels;
   *  popup wants window coordinates, which differ by the page's zoom. */
  ipcMain.handle("files:share", async (e, path: unknown, at: unknown): Promise<void> => {
    const found = await gate(path);
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    if (!found) return;
    const point = at && typeof at === "object" ? at as { x?: unknown; y?: unknown } : {};
    const zoom = e.sender.getZoomFactor();
    const x = typeof point.x === "number" ? Math.round(point.x * zoom) : undefined;
    const y = typeof point.y === "number" ? Math.round(point.y * zoom) : undefined;
    new ShareMenu({ filePaths: [found] }).popup({ window: win, ...(x !== undefined && y !== undefined ? { x, y } : {}) });
  });

  /**
   * Drag a file out of the window. The renderer cancels its own `dragstart` and asks for this, because
   * only main can start an OS drag that carries a real file. The drag image is the file's own Finder
   * icon, cached per extension so the second drag of a type starts without waiting on the lookup —
   * the drag has to begin while the mouse is still down.
   */
  const icons = new Map<string, NativeImage>();
  ipcMain.on("files:drag-start", async (e, path: unknown) => {
    const found = await gate(path);
    if (!found) return;
    const key = extname(found).toLowerCase() || basename(found);
    let icon = icons.get(key);
    if (!icon) {
      icon = await app.getFileIcon(found, { size: "normal" });
      if (!icon.isEmpty()) icons.set(key, icon);
    }
    if (!icon.isEmpty() && !e.sender.isDestroyed()) e.sender.startDrag({ file: found, icon });
  });
}
