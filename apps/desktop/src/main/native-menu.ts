import { BrowserWindow, ipcMain, Menu, nativeImage, type NativeImage } from "electron";

/**
 * Menus the renderer describes and the OS draws.
 *
 * Two needs met by one mechanism. Nothing drawn in the DOM can open over a browser pane — its page is
 * a native view that composites over the window (W2.3's no-overlay rule) — so the browser's ⋯ menu
 * (Plan 26 W7a) is the OS's. And a Mac app's menus are the system's, not a page's: the app's `Menu`
 * component hands every menu it would have drawn to this, rows, checkmarks, shortcut hints and icons
 * included (the Mac idiom), and keeps its drawn menu only where there is no bridge (jsdom).
 *
 * One contract for both: a row with an `id` answers that id when it is chosen; a row without one is a
 * line of information — drawn, never chosen ("Nothing downloaded in this pane"). The renderer's own
 * menus give each row its index as its id.
 *
 * Everything here comes from a renderer, so it is checked rather than trusted: labels clipped, a
 * bounded number of rows and levels, accelerators only in a shape Electron accepts (shown, never
 * registered — the binding already lives elsewhere), icons only as PNG data URLs.
 */
export type NativeMenuItem =
  | { type: "separator" }
  | { separator: true }
  | {
      id?: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string;
      /** The row's tooltip — a menu row's `title`. */
      toolTip?: string;
      /** A PNG data URL, drawn as a template image in the menu's own ink. */
      icon?: string;
      submenu?: NativeMenuItem[];
    };

export type NativeMenuAnchor = { x: number; y: number };

export type MenuTemplateItem = {
  type?: "separator" | "checkbox";
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  registerAccelerator?: boolean;
  toolTip?: string;
  icon?: NativeImage;
  submenu?: MenuTemplateItem[];
  click?: () => void;
};

export const MENU_LABEL_MAX = 64;
/** Bounds one request, not a design limit: a model list is the longest menu the app draws. */
export const MENU_ITEMS_MAX = 100;
export const MENU_DEPTH_MAX = 3;
const ID_MAX = 200;
const TOOLTIP_MAX = 300;
const ICON_MAX = 128 * 1024;
const ICON_PREFIX = "data:image/png;base64,";
/** Electron's accelerator vocabulary, and nothing that could be anything else. */
const ACCELERATOR = /^[A-Za-z0-9+\-=[\],./;'`\\]{1,32}$/;

/**
 * How long a closed menu waits before answering "nothing chosen". macOS closes the menu and THEN
 * delivers the action, so a pick has to be able to arrive second and still win.
 */
export const MENU_CLOSE_GRACE_MS = 100;

export function clipMenuLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length > MENU_LABEL_MAX ? `${flat.slice(0, MENU_LABEL_MAX - 1)}…` : flat;
}

const isSeparator = (row: Record<string, unknown>): boolean => row.type === "separator" || row.separator === true;

/** 2x and a template image: 16pt in the menu's own ink, not a 32pt black glyph. */
function templateIcon(dataUrl: string): NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(dataUrl.slice(ICON_PREFIX.length), "base64"), { scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

export function menuTemplate(items: unknown, pick: (id: string) => void, depth = 0): MenuTemplateItem[] {
  if (!Array.isArray(items) || depth >= MENU_DEPTH_MAX) return [];
  const out: MenuTemplateItem[] = [];
  for (const raw of items.slice(0, MENU_ITEMS_MAX)) {
    const row = raw as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    if (isSeparator(row)) {
      if (out.length > 0 && out[out.length - 1]!.type !== "separator") out.push({ type: "separator" });
      continue;
    }
    if (typeof row.label !== "string" || row.label.trim() === "") continue;
    const label = clipMenuLabel(row.label);
    const id = typeof row.id === "string" && row.id !== "" && row.id.length <= ID_MAX ? row.id : null;
    const enabled = row.enabled !== false;
    if (Array.isArray(row.submenu)) {
      const submenu = menuTemplate(row.submenu, pick, depth + 1);
      // An empty submenu is an arrow that opens onto nothing; a disabled row says the same honestly.
      out.push(submenu.length > 0 ? { label, enabled, submenu } : { label, enabled: false });
      continue;
    }
    const item: MenuTemplateItem = { label, enabled: enabled && id !== null };
    if (typeof row.checked === "boolean") { item.type = "checkbox"; item.checked = row.checked; }
    // Shown, never registered: a popup's shortcut is a reminder of the binding that already exists
    // elsewhere, and registering it here would make the menu a second owner of the key.
    if (typeof row.accelerator === "string" && ACCELERATOR.test(row.accelerator)) {
      item.accelerator = row.accelerator;
      item.registerAccelerator = false;
    }
    if (typeof row.toolTip === "string" && row.toolTip.trim() !== "") item.toolTip = row.toolTip.slice(0, TOOLTIP_MAX);
    if (typeof row.icon === "string" && row.icon.startsWith(ICON_PREFIX) && row.icon.length <= ICON_MAX) {
      try { item.icon = templateIcon(row.icon); } catch { /* an icon that will not decode is a row without one */ }
    }
    if (id !== null) item.click = () => pick(id);
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1]!.type === "separator") out.pop();
  return out;
}

/** A window-relative point in CSS pixels, rounded, or null for anything else. */
export function menuAnchor(at: unknown): NativeMenuAnchor | null {
  const p = at as { x?: unknown; y?: unknown } | null;
  if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.max(0, Math.round(p.x)), y: Math.max(0, Math.round(p.y)) };
}

/**
 * Pop the menu and answer with the id chosen, or null once it closed without one. A choice is never
 * read as a dismissal: the close's null waits out the grace, and the first answer is the only one.
 */
export function popupNativeMenu(
  items: unknown,
  at: unknown,
  popup: (template: MenuTemplateItem[], at: NativeMenuAnchor, onClose: () => void) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (id: string | null) => { if (!settled) { settled = true; resolve(id); } };
    const point = menuAnchor(at);
    const template = menuTemplate(items, settle);
    if (!point || template.length === 0) { settle(null); return; }
    popup(template, point, () => { setTimeout(() => settle(null), MENU_CLOSE_GRACE_MS); });
  });
}

/**
 * The two channels: `menu:popup` (rows and a point in CSS pixels → the id chosen, or null) and
 * `menu:close` (take down the menu that is up — its owner went away first). The point is scaled by
 * the page's zoom, because popup wants window coordinates and ⌘± changes how many of them a CSS pixel
 * is.
 */
export function registerNativeMenus(): void {
  let open: { menu: Menu; win: BrowserWindow | undefined } | null = null;
  ipcMain.handle("menu:popup", (e, items: unknown, at: unknown): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const zoom = e.sender.getZoomFactor();
    return popupNativeMenu(items, at, (template, point, onClose) => {
      const menu = Menu.buildFromTemplate(template);
      open = { menu, win };
      menu.popup({
        window: win, x: Math.round(point.x * zoom), y: Math.round(point.y * zoom),
        callback: () => { if (open?.menu === menu) open = null; onClose(); },
      });
    });
  });
  ipcMain.handle("menu:close", () => { if (open) open.menu.closePopup(open.win); });
}
