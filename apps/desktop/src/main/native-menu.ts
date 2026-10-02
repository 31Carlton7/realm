/**
 * A menu the RENDERER describes and the OS draws (Plan 26 W7a).
 *
 * A `WebContentsView` composites over every piece of renderer DOM inside its rectangle, which is why the
 * browser pane may never open a DOM dropdown (W2.3). An OS menu is not renderer DOM — it is a window
 * above the app — so it lands over the page the way Safari's and Chrome's own menus do. The back/forward
 * menu (`browser:history-menu`) was the first of these and built its rows in main; this is the same
 * mechanism with the rows supplied by the renderer, because the renderer is where most of a menu's state
 * lives (which session a screenshot would go to, whether the find strip is open). Main draws it and
 * answers with the id of the row that was chosen, or null — nothing else crosses back.
 *
 * Electron-free: the rows are translated into plain objects shaped like Electron's
 * `MenuItemConstructorOptions`, and the popup itself is a seam, so the whole round trip runs in a test.
 */

/** One row, as the renderer sends it. A row with no `id` is a line of information, never a choice. */
export type NativeMenuItem =
  | { type: "separator" }
  | { id?: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string; submenu?: NativeMenuItem[] };

export type NativeMenuAnchor = { x: number; y: number };

/** The subset of Electron's `MenuItemConstructorOptions` this builds — assignable to it as written. */
export type MenuTemplateItem = {
  type?: "separator" | "checkbox";
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  registerAccelerator?: boolean;
  submenu?: MenuTemplateItem[];
  click?: () => void;
};

/**
 * Bounds on what one request may describe. The renderer is Realm's own, but the LABELS are often a
 * page's — a history row is a `<title>` — and a title is routinely a sentence and occasionally a
 * paragraph. A menu is a list of places, so each row is cut to something scannable rather than allowed
 * to set the menu's width from the worst page in it.
 */
export const MENU_LABEL_MAX = 64;
export const MENU_ITEMS_MAX = 40;
export const MENU_DEPTH_MAX = 3;
const ID_MAX = 200;
/** Electron throws on an accelerator it cannot parse, and a throw here would take the menu with it. */
const ACCELERATOR = /^[A-Za-z0-9+\-=[\]]{1,32}$/;

/**
 * How long after the menu closes a dismissal is believed.
 *
 * Electron posts the close callback as a task so that the chosen row's click runs first (menu_mac.mm
 * says so), but that is an ordering promised by a comment in another codebase. A choice must never be
 * read as a dismissal, and a dismissal that resolves a beat late costs nothing — so the close waits.
 */
export const MENU_CLOSE_GRACE_MS = 100;

export function clipMenuLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length > MENU_LABEL_MAX ? `${flat.slice(0, MENU_LABEL_MAX - 1)}…` : flat;
}

/**
 * The renderer's rows → Electron's template, each choosable row wired to `pick(id)`.
 *
 * Lenient about shape and strict about bounds: a row that is not a row is dropped rather than failing
 * the whole menu, and separators are tidied so a section that came out empty leaves no double rule.
 */
export function menuTemplate(items: unknown, pick: (id: string) => void, depth = 0): MenuTemplateItem[] {
  if (!Array.isArray(items) || depth >= MENU_DEPTH_MAX) return [];
  const out: MenuTemplateItem[] = [];
  for (const raw of items.slice(0, MENU_ITEMS_MAX)) {
    const row = raw as Record<string, unknown> | null;
    if (!row || typeof row !== "object") continue;
    if (row.type === "separator") {
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
    if (id !== null) item.click = () => pick(id);
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1]!.type === "separator") out.pop();
  return out;
}

/** Window-relative, which is what `Menu.popup` takes. Null for anything that is not a point. */
export function menuAnchor(at: unknown): NativeMenuAnchor | null {
  const p = at as { x?: unknown; y?: unknown } | null;
  if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.max(0, Math.round(p.x)), y: Math.max(0, Math.round(p.y)) };
}

/**
 * Pop the menu and resolve with the chosen row's id, or null when it was dismissed (or there was
 * nothing to show). `popup` is `Menu.buildFromTemplate(t).popup({ …, callback: onClose })` in the app.
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
