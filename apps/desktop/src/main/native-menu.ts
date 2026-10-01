import { BrowserWindow, ipcMain, Menu, nativeImage, type MenuItemConstructorOptions } from "electron";

/** One row of a renderer menu, flattened to what an OS menu can draw. Mirrors `NativeMenuItem` in the
 *  renderer's env.d.ts — the two sides of one IPC call. */
export type NativeMenuItem =
  | { separator: true }
  | { separator?: false; label: string; enabled: boolean; checked?: boolean; toolTip?: string;
      /** Display only: the binding itself lives in the renderer's hotkeys. */
      accelerator?: string;
      /** A 2x PNG data URL of the row's glyph, drawn in black so macOS can tint it as a template. */
      icon?: string };

/**
 * How long after the menu closes a pick may still arrive. macOS dismisses the menu and THEN delivers
 * the chosen item's action, so "closed with nothing picked yet" is not yet an answer. A pick is a
 * human click, so nothing real lands anywhere near this late.
 */
export const PICK_GRACE_MS = 100;

export function menuTemplate(items: NativeMenuItem[], pick: (index: number) => void): MenuItemConstructorOptions[] {
  return items.map((it, i): MenuItemConstructorOptions => {
    if (it.separator) return { type: "separator" };
    return {
      label: it.label,
      enabled: it.enabled,
      ...(it.checked !== undefined ? { type: "checkbox" as const, checked: it.checked } : {}),
      ...(it.toolTip ? { toolTip: it.toolTip } : {}),
      ...(it.accelerator ? { accelerator: it.accelerator, registerAccelerator: false } : {}),
      ...(it.icon ? { icon: templateIcon(it.icon) } : {}),
      click: () => pick(i),
    };
  });
}

/** The renderer rasterised the glyph at twice its point size; telling nativeImage so is what keeps it
 *  16pt rather than 32. Template, so the menu draws it in its own ink — white on the highlight. */
function templateIcon(dataUrl: string) {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const image = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

/**
 * The renderer's menus, as OS menus. A Mac menu is not a picture of one: it has the system's
 * material, type-to-select, the real submenu and keyboard behaviour, and it can sit over a browser
 * pane's native view, which no renderer DOM can. `Menu.tsx` sends its rows here and gets back the
 * index that was picked, or null.
 *
 * `at` is in the renderer's CSS pixels; popup takes window coordinates, which differ by the page's
 * zoom (⌘+ / ⌘− scale every CSS pixel).
 */
export function registerNativeMenus(): void {
  let open: { menu: Menu; win: BrowserWindow | undefined } | null = null;
  ipcMain.handle("menu:popup", (e, items: NativeMenuItem[], at: { x: number; y: number }) =>
    new Promise<number | null>((resolve) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const zoom = e.sender.getZoomFactor();
      const menu = Menu.buildFromTemplate(menuTemplate(items, (i) => resolve(i)));
      open = { menu, win };
      menu.popup({
        window: win, x: Math.round(at.x * zoom), y: Math.round(at.y * zoom),
        callback: () => {
          if (open?.menu === menu) open = null;
          setTimeout(() => resolve(null), PICK_GRACE_MS);
        },
      });
    }));
  /** The renderer unmounted the menu's owner while the menu was up — the pane closed under it. */
  ipcMain.handle("menu:close", () => { if (open) open.menu.closePopup(open.win); });
}
