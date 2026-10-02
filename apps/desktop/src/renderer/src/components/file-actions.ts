import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * The three things a Mac does with a file it is showing you (main/file-actions.ts): Quick Look on
 * Space, drag it out, Share. Each is offered only where the desktop bridge says it exists — in a
 * browser or a test there is no Quick Look panel to open, and a menu row or a drag that cannot do
 * anything is a promise the app would be breaking.
 */
const bridge = () => window.realm?.files;

export const canQuickLook = (): boolean => typeof bridge()?.quickLook === "function";
export const canShare = (): boolean => typeof bridge()?.share === "function";

export function quickLook(path: string): void { void bridge()?.quickLook?.(path); }

/** The Share menu under an element (its bottom-left corner), or at a point. */
export function shareFile(path: string, at: HTMLElement | { x: number; y: number } | null): void {
  const point = at instanceof HTMLElement
    ? (() => { const r = at.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })()
    : at ?? { x: 0, y: 0 };
  void bridge()?.share?.(path, point);
}

/**
 * Space on a focused file shows it in Quick Look, as it does in the Finder. Space would otherwise
 * press the button; Enter still does, which is the Finder's split too — Space looks, Return acts.
 * A modifier, or a key repeat holding the panel open and shut, is left alone.
 */
export function quickLookOnSpace(path: string) {
  return (e: ReactKeyboardEvent): void => {
    if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || !canQuickLook()) return;
    e.preventDefault();
    quickLook(path);
  };
}

/**
 * A file the page shows that can be dragged out to the Finder or into another app. Only main can
 * start an OS drag that carries a real file, so the page's own drag is cancelled and main is asked to
 * begin one instead. Without the bridge the element is not draggable at all, rather than draggable
 * into nothing.
 */
export function fileDragProps(path: string): { draggable?: true; onDragStart?: (e: ReactDragEvent) => void } {
  const start = bridge()?.startDrag;
  if (typeof start !== "function") return {};
  return {
    draggable: true,
    onDragStart: (e) => { e.preventDefault(); start(path); },
  };
}
