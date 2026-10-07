/**
 * The window's page zoom, as a number the stylesheet can do arithmetic with.
 *
 * ⌘+/⌘−/⌘0 are Chromium's own (the View menu's roles, `main/index.ts`), and they scale every CSS
 * pixel in the app. That is usually the whole story — but a length in `px` shrinks in exact
 * proportion, which means a surface sized in px keeps the same share of the window at every zoom.
 * Zooming out to fit more of the work on screen therefore buys nothing back from the prompter: it
 * gets smaller exactly as fast as the transcript it sits under, and the column stays as dominant as
 * it was. `--prompter-w` reads this so it can give up MORE than the zoom already takes.
 *
 * The factor comes from `webFrame` through the preload, because it cannot be derived here:
 * `devicePixelRatio` is the display's scale times the zoom, and the renderer has no way to tell the
 * two apart — a 2× Retina window at 100% and a 1× window at 200% report the same number.
 *
 * Chromium fires no event for a zoom change. It always changes the viewport, though, so `resize` is
 * the signal, and re-reading a synchronous getter there costs nothing.
 */

import { useEffect } from "react";

/** Where the stylesheet reads it. Registered in `styles.css` with an initial value of 1, so every
 *  rule below is already correct before this module runs — and in a renderer with no bridge at all
 *  (a test, a browser) it simply stays 1, which is the behaviour this app had before zoom existed. */
export const ZOOM_VAR = "--zoom";

/**
 * The current factor, or 1 when nothing can say.
 *
 * Guarded rather than trusted: a bridge that answered 0, a negative or a NaN would take every length
 * derived from it to zero, and a prompter of zero width is a pane with no prompter in it.
 */
export function currentZoom(): number {
  const raw = window.realm?.zoomFactor?.();
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Three decimals — a thousandth of a factor is a hundredth of a pixel on the widest thing that
 *  reads it, and rounding is what keeps a resize from rewriting the property with float dust on
 *  every frame. */
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Write the factor onto the root, and answer whether it changed anything. */
export function applyZoom(factor: number, root: HTMLElement = document.documentElement): boolean {
  const next = String(round(factor));
  if (root.style.getPropertyValue(ZOOM_VAR) === next) return false;
  root.style.setProperty(ZOOM_VAR, next);
  return true;
}

/** Keep `--zoom` current for as long as the app is mounted. */
export function useZoom(root: HTMLElement = document.documentElement): void {
  useEffect(() => {
    const sync = () => applyZoom(currentZoom(), root);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [root]);
}
