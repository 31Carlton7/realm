import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MenuItem } from "./Menu";
import { canQuickLook, canShare, quickLook, shareFile } from "./file-actions";

/** The remove row's tooltip: what goes, and what never does. */
export const REMOVE_FROM_LIBRARY_TITLE = "Deletes Realm's own copy. The file you added it from stays where it is.";

/**
 * A file's menu, wherever a list shows one — a Library tile or row, a row of the documents pane's home:
 * what a click does, then what a Mac does with a file it is showing you, and, for a file the person
 * added, the way back out of the Library, at the foot and set apart as a destructive row is. One list,
 * so the same file offers the same things from every list that shows it, and the viewer's own menu
 * ends the same way.
 */
export function fileMenuItems({ path, onOpen, shareFrom, onRemove }: {
  path: string;
  onOpen: () => void;
  /** Where Share's own menu comes up: the control the menu came from, or the point it was opened at. */
  shareFrom: () => HTMLElement | { x: number; y: number } | null;
  /** Takes the file out of the Library. Only a file the person added has one; without it, no row. */
  onRemove?: () => void;
}): MenuItem[] {
  return [
    { label: "Open", onSelect: onOpen },
    ...(canQuickLook() ? [{ label: "Quick Look", kbd: "Space", onSelect: () => quickLook(path) } as MenuItem] : []),
    ...(canShare() ? [{ label: "Share…", onSelect: () => shareFile(path, shareFrom()) } as MenuItem] : []),
    { label: "Reveal in Finder", onSelect: () => { void window.realm?.files?.reveal?.(path); } },
    { label: "Copy path", onSelect: () => { void navigator.clipboard?.writeText?.(path); } },
    ...(onRemove ? [{ kind: "separator" } as MenuItem, removeFromLibraryItem(onRemove)] : []),
  ];
}

export const removeFromLibraryItem = (onSelect: () => void): MenuItem =>
  ({ label: "Remove from Library", kbd: "⌫", danger: true, title: REMOVE_FROM_LIBRARY_TITLE, onSelect });

/**
 * Delete on a file in focus takes it out of the Library, as it takes a message out of Mail: ⌫, the
 * forward Delete, or the Finder's ⌘⌫. No question first — the toast it ends in carries the Undo. A key
 * held down repeats nothing, and a file that is not the person's own is left to the key's other uses.
 */
export function removeOnDelete(onRemove: (() => void) | null) {
  return (e: ReactKeyboardEvent): boolean => {
    if (!onRemove || (e.key !== "Backspace" && e.key !== "Delete") || e.repeat || e.altKey || e.ctrlKey || e.shiftKey) return false;
    e.preventDefault();
    onRemove();
    return true;
  };
}

/** Shift-F10 or the menu key on a file in focus: its menu, as a right-click would open it. */
export const isMenuKey = (e: ReactKeyboardEvent): boolean => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
